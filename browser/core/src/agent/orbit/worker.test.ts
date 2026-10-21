// @vitest-environment node
/**
 * The Orbit worker through the page protocol (slice 3, commits 13 and 15): the messages the page
 * sends, answered by Orbit's brain on pi-host over a fake model and a fake Galaxy. No browser: the
 * worker's `self` is stubbed and the user lookup fails, so storage and the ledger are in memory.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { text, toolCall } from "../fake-model";

const LLM = "http://llm.test/v1";
const GALAXY = "http://galaxy.test";
const JOB = "aaaa000000000001";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Message = { type: string; [key: string]: unknown };

/** A fake Galaxy holding pages, and a hold the test can put on one page's writes. */
function galaxy() {
  const pages = new Map<
    string,
    { id: string; slug: string; history_id: string; content: string }
  >();
  const puts: string[] = [];
  let created = 0;
  let hold: { page: string; gate: Promise<void> } | undefined;
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/users/current") return json({ err_msg: "no session" }, 500);
    if (path === "/api/pages" && request.method === "GET") {
      const history = url.searchParams.get("history_id");
      return json([...pages.values()].filter((p) => p.history_id === history));
    }
    if (path === "/api/pages" && request.method === "POST") {
      const body = (await request.json()) as { slug: string; history_id: string; content: string };
      const id = `page-${++created}`;
      pages.set(id, { id, slug: body.slug, history_id: body.history_id, content: body.content });
      return json(pages.get(id));
    }
    const page = path.match(/^\/api\/pages\/([^/]+)$/)?.[1];
    if (page && pages.has(page)) {
      if (request.method === "PUT") {
        if (hold?.page === page) await hold.gate;
        const body = (await request.json()) as { content: string };
        puts.push(page);
        pages.get(page)!.content = body.content;
      }
      const stored = pages.get(page)!;
      return json({ ...stored, content_editor: stored.content });
    }
    if (path === "/api/tools" && request.method === "POST") {
      return json({ jobs: [{ id: JOB, tool_id: "cat1", history_id: "h1" }], outputs: [] });
    }
    if (path.startsWith("/api/jobs/")) return json({ id: JOB, state: "running", tool_id: "cat1" });
    return json({});
  };
  return {
    pages,
    puts,
    handle,
    holdWrites(page: string) {
      let release!: () => void;
      hold = { page, gate: new Promise<void>((r) => (release = r)) };
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}

/** The worker, booted from a fresh module graph, and what it has posted to the page. */
async function worker(answers: Array<() => Response>, capabilities = ["llm", "read", "write"]) {
  vi.resetModules();
  const fake = galaxy();
  let asked = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url.startsWith(LLM)) return (answers[asked++] ?? (() => text("done")))();
    return fake.handle(request);
  });
  const posted: Message[] = [];
  const self = {
    postMessage: (message: Message) => void posted.push(message),
    close: () => {},
    location: { href: `${GALAXY}/` },
    onmessage: undefined as undefined | ((event: { data: unknown }) => void),
  };
  vi.stubGlobal("self", self);
  const { startOrbitWorker } = await import("./worker");
  startOrbitWorker({});
  const send = (data: unknown) => self.onmessage!({ data });
  const seen = (type: string) => posted.filter((m) => m.type === type);
  send({
    type: "open",
    request: {
      pyodideURL: "",
      config: {
        galaxy_root: `${GALAXY}/`,
        ai_base_url: LLM,
        ai_model: "m",
        ai_api_key: "k",
        capabilities,
      },
      placement: { historyId: "h1" },
    },
  });
  await vi.waitFor(() => expect(seen("ready").length + seen("failed").length).toBe(1), {
    timeout: 10_000,
  });
  return { fake, posted, send, seen };
}

afterEach(async () => {
  const { setCapabilityProfile } = await import("../../../../../shared/capability-profile.js");
  setCapabilityProfile(null);
  vi.unstubAllGlobals();
});

// Each case boots the brain from scratch, which takes a few seconds under a busy suite.
describe("the Orbit worker", { timeout: 30_000 }, () => {
  it("opens on Orbit's brain and says so", async () => {
    const { seen } = await worker([]);
    expect(seen("failed")).toEqual([]);
    expect(seen("ready")[0]).toMatchObject({ brain: "orbit" });
    // The page shows the conversation from a snapshot on.
    expect(seen("events")[0]).toMatchObject({ events: [{ type: "snapshot" }] });
  });

  it("answers a slash command with a notice and tells the page nothing is running", async () => {
    const { send, seen } = await worker([]);
    send({ type: "submit", text: "/pending" });
    await vi.waitFor(() => expect(seen("quiet")).toHaveLength(1));
    expect(seen("notice").length).toBeGreaterThan(0);
  });

  it("lands a submission whose capture is still writing when the user resets in the first conversation's page", async () => {
    const { fake, send, seen } = await worker([
      () => toolCall("run_tool", { history_id: "h1", tool_id: "cat1", inputs: {} }),
      () => text("submitted"),
    ]);
    // The first write to the conversation's page is capture's job block: hold it.
    let release: (() => void) | undefined;
    const watching = setInterval(() => {
      if (!release && fake.pages.size === 1) release = fake.holdWrites([...fake.pages.keys()][0]);
    }, 1);
    send({ type: "submit", text: "run cat on it" });
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 10_000 });
    clearInterval(watching);
    const [first] = [...fake.pages.keys()];
    const snapshots = () =>
      seen("events").filter((m) => (m.events as Message[])[0]?.type === "snapshot");
    send({ type: "reset" });
    // The switch waits for the capture: settle waits on its end events, and the outgoing
    // session's summary waits on the record lock the capture holds.
    await new Promise((r) => setTimeout(r, 50));
    expect(snapshots()).toHaveLength(1);
    release!();
    await vi.waitFor(() => expect(snapshots()).toHaveLength(2), { timeout: 10_000 });
    const { galaxyMarkdownToLoom } =
      await import("../../../../../extensions/loom/galaxy-markdown-adapter");
    expect(galaxyMarkdownToLoom(fake.pages.get(first)!.content)).toContain(`job_id: ${JOB}`);
    // The new conversation got no page of its own from it.
    expect(fake.pages.size).toBe(1);
    expect(new Set(fake.puts)).toEqual(new Set([first]));
  }, 20_000);
});
