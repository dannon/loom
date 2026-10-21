/**
 * One conversation's worker: Orbit's brain on pi-host over the conversation's Postgres store, in a
 * worker_thread the host starts with an empty environment (brief H4). Everything the worker needs
 * arrives in workerData or over its port; it reads no files and no environment of its own.
 *
 * The order matters. The environment and the fence go in before Orbit registers, the seams are set
 * before `loom()` reads them, and the guards are registered ahead of Orbit's own tool_call handlers.
 */
import { parentPort, workerData } from "node:worker_threads";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import * as orbit from "orbit-brain";
import * as vendor from "orbit-vendor-skills";
import pg from "pg";

import { agentModels } from "../../../core/src/agent/model";
import { createPiHost, type AskAnswer } from "../../../core/src/agent/pi-host";
import { resolve as resolveTarget } from "../../../core/src/agent/providers";
import { LeaseFence } from "../lease/lease-fence";
import { PostgresStorage } from "../storage/postgres-storage";
import { fencedFetch } from "./fenced-fetch";
import { registerSurfaceGate, registerToolCallCap, WITHHELD_TOOLS } from "./guards";
import type { FromWorker, ToWorker, WorkerData } from "./protocol";
import { installTripwire } from "./tripwire";

const data = workerData as WorkerData;
const port = parentPort!;
const post = (message: FromWorker) => port.postMessage(message);
const ctx = BACKGROUND_CONTEXT;
const reopen = data.conversationId !== undefined;

if (data.traceReaches) installTripwire((api) => post({ type: "reach", api }));

// 1. The environment: the model key for the redactor, and no second greeting on a reopen.
process.env.ORBIT_ACTIVE_LLM_API_KEY = data.model.apiKey;
if (reopen) process.env.ORBIT_FRESH_SESSION = "1";

// 2. Storage and the fence. A lost lease exits the thread with 75 (LeaseFence's default here), and
// from then on nothing leaves the worker: not a commit, not a Galaxy write, not a model call.
const pool = new pg.Pool({ connectionString: data.database, max: 4 });
const fence = new LeaseFence({ storeId: data.storeId, leaseGen: data.leaseGen, db: pool });
const storage = fence.storage(await PostgresStorage.open(pool, data.storeId, { leaseGen: data.leaseGen }));
const network = globalThis.fetch;
globalThis.fetch = fencedFetch(fence, network);

// 3-7. Orbit's seams.
orbit.setCapabilityProfile({
  shell: false,
  files: false,
  notebook: "page",
  network: true,
  mcpServers: false,
  ui: "worker",
});
orbit.setConfigSource({
  load: () => ({
    lessons: { enabled: false },
    observations: { mode: "off" },
    experiments: { autoResume: false, teamDispatch: false },
  }),
  // The redactor reads these as well as the environment.
  secrets: () => [data.model.apiKey],
});
orbit.setInstructionSource({ files: () => [] });
orbit.setVendorSkillsSource({
  catalog: vendor.catalog,
  manifest: vendor.manifest,
  read: (target) => vendor.files[target] ?? null,
});
// The placeholder key is under the redactor's 8-character minimum, so it never masks real text.
// H5 replaces this fetch with one that swaps in the user's token and keeps the redirect guard.
orbit.setGalaxyTransport({
  fetch: fence.fetch((url, init) => network(url, init)),
  credentials: () => ({ url: data.galaxyUrl, apiKey: "hosted" }),
});
// A path-shaped key under no real directory: the page store keeps its side stores in memory.
orbit.setRecordStore(
  orbit.createPageRecordStore({ key: `/conversations/${data.storeId}/notebook.md`, pageId: data.pageId }),
);
const ops = orbit.createGalaxyOpsToolSource({ extras: [] });
orbit.setGalaxyToolSource({ ...ops, tools: () => ops.tools().filter((t) => !WITHHELD_TOOLS.has(t.name)) });
orbit.setGalaxyOutputStore(orbit.createMemoryOutputStore({ entries: 32, bytes: data.limits.outputBytes }));

// 8. The host, the guards, Orbit, and the conversation.
let nextAsk = 0;
const pending = new Map<number, (answer: AskAnswer) => void>();
const host = createPiHost({
  name: "orbit",
  cwd: "/",
  model: () => ({ provider: "custom", id: data.model.id }),
  ui: {
    notify: (text, level) => post({ type: "notify", text, level }),
    ask: (request, _conversationId, signal) => {
      const id = ++nextAsk;
      post({ type: "ask", id, request });
      // Withdrawn on Stop or close (H1): the browser takes the dialog down, and the host settles it.
      signal?.addEventListener("abort", () => post({ type: "ask-withdrawn", id }), { once: true });
      return new Promise<AskAnswer>((resolve) => pending.set(id, resolve));
    },
  },
});
const on = host.api.on as unknown as Parameters<typeof registerSurfaceGate>[0];
registerSurfaceGate(on);
registerToolCallCap(on, data.limits.maxToolCalls);
(host.api.on as unknown as (event: string, handler: (e: { aborted: boolean }) => void) => void)(
  "agent_settled",
  (e) => post({ type: "settled", aborted: e.aborted }),
);
orbit.loom(host.api);
const registry = createRegistry();
registry.install(host.seal());
const { models, model } = await agentModels().connect(
  resolveTarget({ ai_base_url: data.model.baseUrl, ai_model: data.model.id, ai_api_key: data.model.apiKey }),
);
const harness = await Harness.open(
  storage,
  {
    models,
    registry,
    // runtime.ts's LOOP, inlined: importing runtime.ts drags the browser runtime into the bundle.
    settings: {
      toolExecution: "sequential",
      followUpMode: "all",
      promptPlacement: "lead",
      maxTurns: data.limits.maxTurns,
    },
    onReport: (error) => {
      fence.check(error);
      post({ type: "report", message: error instanceof Error ? error.message : String(error) });
    },
  },
  ctx,
);
const conversation = reopen
  ? await harness.conversation(data.conversationId as never, ctx)
  : await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx);
if (!conversation) throw new Error(`No conversation ${data.conversationId} in store ${data.storeId}`);
await host.attach(harness, conversation, ctx);

port.on("message", (message: ToWorker) => {
  switch (message.cmd) {
    case "submit":
      void host.submit(message.text);
      return;
    case "answer": {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve?.(message.value);
      return;
    }
    case "stop":
      void conversation.abort(ctx);
      return;
    case "close":
      // Not awaited here: close joins every invocation, and one parked in a confirm only returns
      // once the host settles its ask.
      harness.close(ctx).then(
        () => post({ type: "closed" }),
        (error: unknown) => post({ type: "closed", error: error instanceof Error ? error.message : String(error) }),
      );
      return;
  }
});

await host.start(reopen ? "resume" : "new");
harness.resume();
post({
  type: "ready",
  conversationId: String(conversation.id),
  tools: host.api.getAllTools().map((t) => t.name),
  env: Object.keys(process.env),
});
