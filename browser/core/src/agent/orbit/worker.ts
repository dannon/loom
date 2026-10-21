/**
 * The agent worker under VITE_ORBIT_BRAIN=orbit: the page protocol worker.ts speaks, answered by
 * Orbit's brain (extensions/loom) on pi-host instead of the browser's own. The runtime (model,
 * compaction, storage, conversations) is the same Runtime; what differs is the brain installed in
 * it and that every conversation change goes through pi's session lifecycle.
 *
 * Its storage and its submission ledger are its own files (`-orbit`), so a flag build never reads
 * or rewrites what the default brain kept.
 */
import {
  InboxDoc,
  LiveDoc,
  MemoryStorage,
  watchEvents,
  type Conversation,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";

import { createPage, listHistoryPages } from "../../../../../extensions/loom/galaxy-pages-api";
import { galaxyBackgroundIdle } from "../../../../../extensions/loom/galaxy-reconcile";
import { captureLateSubmission } from "../../../../../extensions/loom/galaxy-submission-capture";
import { setRecordStore } from "../../../../../extensions/loom/record-store";
import { createPageRecordStore } from "../../../../../extensions/loom/record-store-page";
import { createMemoryLedger } from "../../../../../extensions/loom/submission-ledger";
import { registerArtifactKinds } from "../../artifacts/kinds";
import { DEFAULT_BRAND } from "../brand";
import { Binding, FollowUps, heldBy } from "../documents";
import { connectGalaxy, galaxyFetch } from "../galaxy";
import type { SessionReason } from "../pi-host";
import { browserPython } from "../python";
import { context, Runtime } from "../runtime";
import { holdStorage, openStorage } from "../storage";
import type { AgentFlavor } from "../tools";
import type { OpenRequest, PageMessage, Waiting, WorkerMessage } from "../worker";
import { bootOrbit, type OrbitBoot } from "./boot";
import { setOrbitCwd } from "./env";
import { orbitGrant } from "./grants";
import { openFileLedger, opfsFile } from "./ledger";

/** How long a conversation being left gets to finish its tool calls' end events. */
const SETTLE_MS = 30_000;
/** What a retried Galaxy request may wait in all: the watch's own backoff does the rest. */
const RETRY_BUDGET_MS = 5_000;

const post = (message: WorkerMessage) => self.postMessage(message);

let flavor: AgentFlavor = {};
let runtime: Runtime | undefined;
let orbit: OrbitBoot | undefined;
let conversation: Conversation | undefined;
let detach: (() => Promise<unknown>) | undefined;
let held: Waiting;
let readOnly = false;

const confirms = new Map<
  number,
  { conversation: ConversationId | undefined; resolve: (approved: boolean) => void }
>();
let confirmId = 0;

/** A confirm from Orbit, through the page's dialog; withdrawn when the call it gates stops. */
function ask(title: string, message: string, id: ConversationId | undefined, signal?: AbortSignal) {
  return new Promise<boolean | undefined>((resolve) => {
    const key = confirmId++;
    const settle = (answer: boolean | undefined) => {
      if (!confirms.delete(key)) return;
      resolve(answer);
    };
    confirms.set(key, { conversation: id, resolve: settle });
    signal?.addEventListener(
      "abort",
      () => {
        if (confirms.has(key)) post({ type: "withdrawn", id: key });
        settle(undefined);
      },
      { once: true },
    );
    post({ type: "confirm", id: key, title, message });
  });
}

/** Decline what `id`'s run is waiting on, so that run can end. */
function decline(id: ConversationId) {
  for (const [key, waiting] of confirms) {
    if (waiting.conversation !== id) continue;
    post({ type: "withdrawn", id: key });
    waiting.resolve(false);
  }
}

/** The record page's key for a conversation: under its own pseudo directory. */
const pageKey = (id: ConversationId) => `/orbit/${id}/notebook.md`;

/**
 * Install `id`'s record store before its session starts. Its page is made on the first write
 * that has something in it, attached to the conversation's history and found again by slug, and
 * bound in the conversation's Binding doc before any content goes up.
 */
async function installRecord(id: ConversationId) {
  const harness = runtime!.harness;
  const bound = await harness.snapshot(Binding, id, context);
  const brand = flavor.brand ?? DEFAULT_BRAND;
  const slug = `${brand.id}-orbit-${bound?.sessionId ?? id}`;
  setOrbitCwd(`/orbit/${id}`);
  setRecordStore(
    createPageRecordStore({
      key: pageKey(id),
      pageId: bound?.pageId,
      create: async () => {
        if (readOnly) throw new Error("A read-only launch keeps no record.");
        if (!bound?.historyId)
          throw new Error("This conversation has no Galaxy history to keep its record in.");
        const existing = (await listHistoryPages(bound.historyId)).find(
          (page) => page.slug === slug,
        );
        if (existing) return existing.id;
        return (
          await createPage({
            title: `${brand.name} record`,
            content: "",
            history_id: bound.historyId,
            slug,
          })
        ).id;
      },
      bind: async (pageId) => {
        await harness.commit(async (tx) => {
          (await tx.doc(Binding, id)).pageId = pageId;
        }, context);
      },
    }),
  );
}

/** Follow-ups queued for the user while the conversation is idle, and why. */
async function postHeld() {
  if (!runtime || !conversation) return;
  const id = conversation.id;
  const [policy, inbox, live] = await Promise.all([
    runtime.harness.snapshot(FollowUps, id, context),
    runtime.harness.snapshot(InboxDoc, id, context),
    runtime.harness.snapshot(LiveDoc, id, context),
  ]);
  const queued = !live?.run && (inbox?.items ?? []).some((item) => item.mode !== "write");
  const next: Waiting = queued ? heldBy(policy) : undefined;
  if (next !== held) {
    held = next;
    post({ type: "held", held });
  }
}

/**
 * Leave the conversation shown: decline what it waits on, end its run, stop admitting its tool
 * calls and give the running ones their end events, then end its session. A call still running
 * after that is captured into its own record when it finishes (onLateCompletion), and one the
 * worker doesn't live to see is in the ledger for the next attach.
 */
async function leave(left: Conversation) {
  decline(left.id);
  await runtime!.hold([left]);
  orbit!.host.quiesce(left.id);
  await orbit!.host.settle(left.id, SETTLE_MS);
  await galaxyBackgroundIdle();
  await orbit!.host.shutdown("new");
}

/** Show `next` on the page and start its session in Orbit's brain. */
async function show(next: Conversation, reason: SessionReason) {
  if (conversation && conversation.id !== next.id) await leave(conversation);
  await detach?.();
  conversation = next;
  held = undefined;
  const harness = runtime!.harness;
  const stream = await watchEvents(harness, next.id, context);
  post({ type: "events", events: [stream.snapshot] });
  stream.start(async (events) => {
    post({ type: "events", events });
    if (events.some((e) => e.type === "run_end")) decline(next.id);
    await postHeld();
  });
  detach = () => stream.stop();
  await orbit!.host.attach(harness, next, context);
  await orbit!.host.start(reason);
  await postHeld();
}

async function open(request: OpenRequest) {
  const brand = flavor.brand ?? DEFAULT_BRAND;
  const capabilities = request.config.capabilities ?? ["llm", "local", "read", "write"];
  // Refused before anything is opened: a grant Orbit can't map is not one to guess at.
  readOnly = orbitGrant(capabilities).galaxy === "read";
  const galaxy = connectGalaxy({
    root: request.config.galaxy_root,
    credentials: request.config.credentials,
  });
  let unkept: string | undefined;
  const user = await galaxy.get("api/users/current").then(
    (body) => (typeof body?.id === "string" && body.id ? body.id : "anon"),
    (e) => {
      unkept = `the Galaxy user could not be identified: ${String((e as Error)?.message ?? e)}`;
      return undefined;
    },
  );
  let storage: Storage = new MemoryStorage();
  let ledger = createMemoryLedger();
  if (user !== undefined) {
    await holdStorage(`${brand.id}:storage`, {
      steal: request.steal,
      waiting: () => post({ type: "waiting" }),
      lost: () => {
        post({ type: "lost" });
        self.close();
      },
    });
    ({ storage, unkept } = await openStorage(`${brand.id}-${user}-orbit`, brand.id));
    ledger = await openFileLedger(opfsFile(`${brand.id}-${user}-orbit-ledger.json`));
  }
  const url = new URL(galaxy.root, self.location.href).href.replace(/\/+$/, "");
  orbit = bootOrbit({
    capabilities,
    galaxy: {
      fetch: galaxyFetch({
        root: galaxy.root,
        key: request.config.galaxy_key,
        credentials: request.config.credentials,
        maxRetryWaitMs: RETRY_BUDGET_MS,
      }),
      url,
      ...(request.config.galaxy_key ? { key: request.config.galaxy_key } : {}),
    },
    ledger,
    secrets: () => [runtime?.apiKey].filter((s): s is string => typeof s === "string"),
    ui: {
      ask: async (request, id, signal) =>
        request.kind === "confirm" ? ask(request.title, request.message, id, signal) : undefined,
      notify: (text, level, id) =>
        post({ type: "notice", level, text, ...(id === undefined ? {} : { conversationId: id }) }),
    },
    host: {
      models: { getModel: (provider, id) => runtime?.models?.getModel(provider, id) },
      beforeStart: installRecord,
      onLateCompletion: (_id, call, result) => captureLateSubmission(call.id, call.name, result),
    },
  });
  runtime = await Runtime.open({
    storage,
    config: request.config,
    python: browserPython(request.pyodideURL),
    flavor,
    extensions: orbit.extensions,
  });
  if (request.saved) {
    return begin(await runtime.open(request.saved.document, request.saved.id), "resume", unkept);
  }
  const kept = await runtime.kept(request.placement);
  if (kept) return begin(kept, "resume", unkept);
  return begin(await runtime.create(request.placement), "startup", unkept);
}

async function begin(next: Conversation, reason: SessionReason, unkept?: string) {
  await show(next, reason);
  post({
    type: "ready",
    brain: "orbit",
    unkept,
    galaxy: runtime!.galaxyStatus,
    galaxyProblem: runtime!.galaxyProblem,
  });
}

async function reply(id: number, work: () => Promise<unknown>) {
  try {
    post({ type: "reply", id, value: await work() });
  } catch (err) {
    post({ type: "reply", id, error: String((err as Error)?.message ?? err) });
  }
}

const failed = (err: unknown) =>
  post({ type: "failed", message: String((err as Error)?.message ?? err) });

let queue: Promise<unknown> = Promise.resolve();
function inOrder(work: () => Promise<unknown>) {
  queue = queue.then(work).catch(failed);
}

/** Run this worker as the agent on Orbit's brain, with what `agentFlavor` adds to the shell. */
export function startOrbitWorker(agentFlavor: AgentFlavor): void {
  flavor = agentFlavor;
  registerArtifactKinds(flavor.artifactKinds ?? []);
  self.onmessage = onMessage;
}

function onMessage({ data }: MessageEvent<PageMessage>) {
  if (data.type === "open") {
    open(data.request).catch(failed);
  } else if (data.type === "confirmed") {
    confirms.get(data.id)?.resolve(data.approved === true);
  } else if (data.type === "stop") {
    const stopped = conversation;
    if (!stopped) return;
    decline(stopped.id);
    inOrder(() => runtime!.hold([stopped]));
  } else {
    inOrder(() => handle(data));
  }
}

async function handle(data: PageMessage) {
  if (data.type === "submit") {
    const current = conversation!;
    // The user's own message lets settled work start runs again, as it does for the default brain.
    await current.commit(async (tx) => {
      Object.assign(await tx.doc(FollowUps, current.id), { automatic: 0, paused: false });
    }, context);
    await orbit!.host.submit(data.text, { source: "interactive" });
  } else if (data.type === "reset") {
    const left = conversation!;
    const bound = await runtime!.harness.snapshot(Binding, left.id, context);
    await show(
      await runtime!.create({ historyId: bound?.historyId, datasetId: bound?.datasetId }),
      "new",
    );
  } else if (data.type === "switch") {
    await reply(data.id, () => runtime!.switchModel(conversation!, data.config));
  } else if (data.type === "export") {
    await reply(data.id, () => runtime!.export(conversation!, data.title));
  } else if (data.type === "saved") {
    await reply(data.id, () => runtime!.saved(conversation!, data.savedId, data.document));
  } else if (data.type === "recover") {
    // The Orbit brain's records aren't the browser brain's: nothing to choose among yet.
    post({
      type: "failed",
      message: "Recovering a record isn't available under Orbit's brain yet.",
    });
  }
}
