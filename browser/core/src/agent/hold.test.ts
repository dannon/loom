import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  Harness,
  InboxDoc,
  LiveDoc,
  watchEvents,
  type Conversation,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BRAND, followUpMark } from "./brand";
import { FollowUps, MAX_AUTO_FOLLOW_UPS } from "./documents";
import { hanging, json, text, toolCall } from "./fake-model";
import type { Galaxy } from "./galaxy";
import { context, Runtime } from "./runtime";
import type { Python } from "./tool";
import { galaxyWatch, type Watched } from "./watch";

const ROOT = "http://galaxy.test/";
const LLM = "http://llm.test/v1";

const python = (code: string) => toolCall("run_python", { code });

/** A model answering each request in turn, and a Galaxy that says nothing in particular. */
function model(...answers: Array<(request: Request) => Response | Promise<Response>>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(LLM)) {
      return json(request.url.endsWith("api/version") ? { version_major: "26.1" } : {});
    }
    asked.push(request.url);
    return (answers[asked.length - 1] ?? (() => text("done")))(request);
  });
  return asked;
}

/** Python whose runs end only when aborted, saying whether they were. */
function stuckPython() {
  const runs: Array<{ aborted: boolean }> = [];
  const py: Python = {
    run: (_code, signal) =>
      new Promise<string>((_, reject) => {
        const run = { aborted: false };
        runs.push(run);
        signal?.addEventListener("abort", () => {
          run.aborted = true;
          reject(new Error("aborted"));
        });
      }),
    write: async () => {},
    read: async () => undefined,
  };
  return { py, runs };
}

const opened: Runtime[] = [];

async function machine(
  storage = undefined as Parameters<typeof Runtime.open>[0]["storage"] | undefined,
  py?: Python,
) {
  const runtime = await Runtime.open({
    storage: storage ?? (await openNodeSqliteStorage(":memory:")),
    config: { galaxy_root: ROOT, ai_base_url: LLM, ai_model: "m", ai_api_key: "k" },
    python: py ?? stuckPython().py,
    pollMs: 5,
  });
  opened.push(runtime);
  return runtime;
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(done()).toBe(true);
};

afterEach(async () => {
  for (const runtime of opened.splice(0)) await runtime.close().catch(() => {});
  vi.unstubAllGlobals();
});

describe("holding a conversation", () => {
  it("returns while a tool is still running, and the tool is then aborted", async () => {
    model(() => python("while True: pass"));
    const { py, runs } = stuckPython();
    const runtime = await machine(undefined, py);
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "loop forever");
    await until(() => runs.length === 1);

    await runtime.hold([conversation]);
    expect(runs[0].aborted).toBe(false);
    await until(() => runs[0].aborted);
    await conversation.waitForIdle(context);
    expect((await runtime.harness.snapshot(FollowUps, conversation.id, context))?.paused).toBe(
      true,
    );
  });

  it("ends the record reads a request makes before the model, with the run", async () => {
    const reads: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.url.includes("/contents")) {
        reads.push(request);
        return hanging(request);
      }
      return json(request.url.endsWith("api/version") ? { version_major: "26.1" } : {});
    });
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "what is in my history?");
    await until(() => reads.length === 1);

    await runtime.hold([conversation]);
    const idle = await Promise.race([
      conversation.waitForIdle(context).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
    ]);
    expect(idle).toBe(true);
    expect(reads[0].signal.aborted).toBe(true);
  });

  it("ends a tool's request to another host with the run", async () => {
    const asked: Request[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.url.startsWith("https://www.ebi.ac.uk/")) {
        asked.push(request);
        return hanging(request);
      }
      if (request.url.startsWith(LLM)) {
        calls++;
        return calls === 1 ? toolCall("ena_runs", { accession: "SRR390728" }) : text("done");
      }
      return json(request.url.endsWith("api/version") ? { version_major: "26.1" } : {});
    });
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "which runs does SRR390728 have?");
    await until(() => asked.length === 1);

    await runtime.hold([conversation]);
    const idle = await Promise.race([
      conversation.waitForIdle(context).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
    ]);
    expect(idle).toBe(true);
    expect(asked[0].signal.aborted).toBe(true);
  });

  it("does not resume a run the store held when it is opened again", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "olit-hold-")), "olit.sqlite3");
    const asked = model(hanging, () => text("The answer, once asked again."));
    const before = await machine(await openNodeSqliteStorage(file));
    const started = await before.create({ historyId: "h1" });
    await before.submit(started, "answer slowly");
    await until(() => asked.length === 1);
    await before.close();
    opened.splice(opened.indexOf(before), 1);

    const after = await machine(await openNodeSqliteStorage(file));
    const reopened = (await after.kept({ historyId: "h1" }))!;
    await reopened.waitForIdle(context);
    expect(asked).toHaveLength(1);
    expect((await after.harness.snapshot(LiveDoc, reopened.id, context))?.run).toBeUndefined();
    expect((await after.harness.snapshot(FollowUps, reopened.id, context))?.paused).toBe(true);

    await (await after.submit(reopened, "continue")).wait(context);
    expect(asked).toHaveLength(2);
    expect(JSON.stringify((await reopened.context(context)).messages)).toContain(
      "The answer, once asked again.",
    );
  });
});

const MARK = followUpMark(DEFAULT_BRAND);
const JOB: Watched = { kind: "job", id: "j1", label: "run_tool", state: "queued" };

/**
 * A model answering each request in turn, keeping the user messages each request carried, and a
 * Galaxy whose job j1 is in `job.state`.
 */
function world(
  job: { state: string },
  ...answers: Array<(request: Request) => Response | Promise<Response>>
) {
  const asked: string[][] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(LLM)) {
      if (request.url.endsWith("api/jobs/j1")) return json({ state: job.state });
      return json(request.url.endsWith("api/version") ? { version_major: "26.1" } : {});
    }
    const body = JSON.parse(await request.clone().text()) as {
      messages: Array<{ role: string; content: string | Array<{ text?: string }> }>;
    };
    asked.push(
      body.messages
        .filter((m) => m.role === "user")
        .map((m) =>
          typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""),
        ),
    );
    return (answers[asked.length - 1] ?? (() => text("done")))(request);
  });
  return asked;
}

/** Watch job j1 for the conversation, as a run_tool result would. */
async function watchJob(conversation: Conversation) {
  const watch = galaxyWatch({ galaxy: {} as Galaxy, editRecord: async () => undefined });
  return conversation.commit(
    (tx) =>
      tx.createTask(watch, JOB, {
        ownership: { kind: "conversation" },
        conversationId: conversation.id,
        background: true,
      }),
    context,
  );
}

const policyOf = (runtime: Runtime, conversation: Conversation) =>
  runtime.harness.snapshot(FollowUps, conversation.id, context);

/** The user entries of the conversation's context, as text. */
const userEntries = async (conversation: Conversation) =>
  (await conversation.context(context)).entries.flatMap((e) => {
    const message = e.model?.[0] as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "user") return [];
    const content = message.content;
    return [typeof content === "string" ? content : JSON.stringify(content)];
  });

describe("follow-ups held for the user", () => {
  it("keeps a follow-up that settles while held, and starts nothing", async () => {
    const job = { state: "ok" };
    const asked = world(job);
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.hold([conversation]);
    await runtime.harness.waitForTask(await watchJob(conversation), context);
    await conversation.waitForIdle(context);

    expect(asked).toHaveLength(0);
    expect(
      (await runtime.harness.snapshot(LiveDoc, conversation.id, context))?.run,
    ).toBeUndefined();
    expect(
      (await runtime.harness.snapshot(InboxDoc, conversation.id, context))?.items ?? [],
    ).toEqual([]);
    expect((await policyOf(runtime, conversation))?.pending.map((p) => p.id)).toEqual([
      "watch:job:j1",
    ]);
    expect(await userEntries(conversation)).toEqual([]);
  });

  it.each(["a write", "a compaction", "a reset"])(
    "starts no run when a held conversation gets %s",
    async (what) => {
      const job = { state: "queued" };
      const asked = world(
        job,
        () => text("Hello."),
        () => text("A summary."),
      );
      const runtime = await machine();
      const conversation = await runtime.create({ historyId: "h1" });
      await (await runtime.submit(conversation, "hi")).wait(context);
      const watching = await watchJob(conversation);
      await runtime.hold([conversation]);
      await conversation.waitForIdle(context);
      job.state = "ok";
      await runtime.harness.waitForTask(watching, context);
      expect(asked).toHaveLength(1);

      if (what === "a write") {
        const note = { role: "user" as const, content: "a note", timestamp: Date.now() };
        const entry = { kind: "test.note", model: [note] };
        await (await conversation.submit({ type: "write", entry }, context)).wait(context);
      } else if (what === "a compaction") {
        const compaction = await conversation.compact(undefined, context);
        await runtime.harness.waitForTask(compaction, context);
      } else {
        await conversation.reset(undefined, context);
      }
      await conversation.waitForIdle(context);

      // A compaction asks for its summary; nothing carried the follow-up to the model.
      expect(asked.flat().some((m) => m.startsWith(MARK))).toBe(false);
      expect(
        (await runtime.harness.snapshot(LiveDoc, conversation.id, context))?.run,
      ).toBeUndefined();
      expect((await userEntries(conversation)).some((m) => m.startsWith(MARK))).toBe(false);
      expect((await policyOf(runtime, conversation))?.pending).toHaveLength(1);

      await (await runtime.submit(conversation, "continue")).wait(context);
      const last = asked.at(-1)!;
      expect(last.slice(-2).map((m) => m.startsWith(MARK) || m)).toEqual([true, "continue"]);
      expect(asked.filter((a) => a.some((m) => m.startsWith(MARK)))).toHaveLength(1);
      expect((await policyOf(runtime, conversation))?.pending).toEqual([]);
    },
  );

  it("runs the held follow-ups with the user's message, in one request, once", async () => {
    const job = { state: "ok" };
    const asked = world(job, () => text("Both."));
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.hold([conversation]);
    await runtime.harness.waitForTask(await watchJob(conversation), context);

    // What the page draws: the follow-up lands as an entry the transcript reads as one.
    const stream = await watchEvents(runtime.harness, conversation.id, context);
    const drawn: string[] = [];
    stream.start(async (events) => {
      for (const e of events) {
        const message = e.type === "message_end" ? e.entry.model?.[0] : undefined;
        if (message?.role === "user") drawn.push(String(message.content));
      }
    });
    await (await runtime.submit(conversation, "continue")).wait(context);
    await stream.stop();
    expect(drawn.map((m) => m.startsWith(MARK) || m)).toEqual([true, "continue"]);
    expect(asked).toHaveLength(1);
    expect(asked[0].map((m) => m.startsWith(MARK) || m)).toEqual([true, "continue"]);
    const policy = await policyOf(runtime, conversation);
    expect(policy).toMatchObject({ paused: false, automatic: 0, pending: [] });

    await (await runtime.submit(conversation, "and then?")).wait(context);
    expect((await userEntries(conversation)).filter((m) => m.startsWith(MARK))).toHaveLength(1);
  });

  it("keeps a follow-up past the cap for the user, who lifts the cap by writing", async () => {
    const asked = world({ state: "ok" }, () => text("Checked."));
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await conversation.commit(async (tx) => {
      (await tx.doc(FollowUps, conversation.id)).automatic = MAX_AUTO_FOLLOW_UPS;
    }, context);
    await runtime.harness.waitForTask(await watchJob(conversation), context);
    await conversation.waitForIdle(context);
    expect(asked).toHaveLength(0);
    expect((await policyOf(runtime, conversation))?.pending).toHaveLength(1);

    await (await runtime.submit(conversation, "go on")).wait(context);
    expect(asked[0].map((m) => m.startsWith(MARK) || m)).toEqual([true, "go on"]);
    expect(await policyOf(runtime, conversation)).toMatchObject({ automatic: 0, pending: [] });
  });

  it("moves input queued during a run into the pending list at a Stop, and runs it next", async () => {
    const asked = world({ state: "queued" }, hanging, () => text("All three."));
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "first");
    await until(() => asked.length === 1);
    const queued = await conversation.submit({ type: "input", content: "second" }, context);
    expect((await queued.status(context)).status).toBe("queued");

    await runtime.hold([conversation]);
    expect((await runtime.harness.snapshot(InboxDoc, conversation.id, context))?.items).toEqual([]);
    expect(await queued.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect((await policyOf(runtime, conversation))?.pending).toEqual([
      { id: `inbox:${queued.id}`, content: "second" },
    ]);
    await conversation.waitForIdle(context);
    expect(asked).toHaveLength(1);

    await (await runtime.submit(conversation, "continue")).wait(context);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual(["first", "second", "continue"]);
  });

  it("keeps queued writes in pi-durable's inbox at a Stop", async () => {
    const asked = world({ state: "queued" }, hanging);
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "first");
    await until(() => asked.length === 1);
    const note = { role: "user" as const, content: "a note", timestamp: Date.now() };
    const write = await conversation.submit(
      { type: "write", entry: { kind: "test.note", model: [note] } },
      context,
    );
    await runtime.hold([conversation]);
    expect((await policyOf(runtime, conversation))?.pending).toEqual([]);
    await conversation.waitForIdle(context);
    expect((await write.status(context)).status).not.toBe("unanswered");
  });

  it("holding twice moves nothing twice", async () => {
    const asked = world({ state: "queued" }, hanging);
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "first");
    await until(() => asked.length === 1);
    await conversation.submit({ type: "input", content: "second" }, context);
    await runtime.hold([conversation]);
    await runtime.hold([conversation]);
    expect((await policyOf(runtime, conversation))?.pending).toHaveLength(1);
  });

  it("starts a fork with nothing held", async () => {
    const job = { state: "ok" };
    world(job, () => text("Hello."));
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await (await runtime.submit(conversation, "hi")).wait(context);
    await runtime.hold([conversation]);
    await runtime.harness.waitForTask(await watchJob(conversation), context);
    const at = (await conversation.context(context)).entries.at(-1)!.id;
    const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, context);
    // `fork: "initial"`: the fork has no policy of its own until something writes one.
    const forked = await policyOf(runtime, fork);
    expect(forked?.paused ?? false).toBe(false);
    expect(forked?.pending ?? []).toEqual([]);
    expect((await policyOf(runtime, conversation))?.pending).toHaveLength(1);
  });
});

describe("held follow-ups across a restart", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "olit-hold-")), "olit.sqlite3");
  const reopen = async (runtime: Runtime, path: string) => {
    await runtime.close();
    opened.splice(opened.indexOf(runtime), 1);
    return machine(await openNodeSqliteStorage(path));
  };

  it("keeps a held follow-up when the page closes, and delivers it once", async () => {
    const path = file();
    const asked = world({ state: "ok" }, () => text("Both."));
    const before = await machine(await openNodeSqliteStorage(path));
    const conversation = await before.create({ historyId: "h1" });
    await before.hold([conversation]);
    await before.harness.waitForTask(await watchJob(conversation), context);

    const after = await reopen(before, path);
    const reopened = (await after.kept({ historyId: "h1" }))!;
    expect((await policyOf(after, reopened))?.pending).toHaveLength(1);
    await reopened.waitForIdle(context);
    expect(asked).toHaveLength(0);
    await (await after.submit(reopened, "continue")).wait(context);
    expect(asked).toHaveLength(1);
    expect(asked[0].map((m) => m.startsWith(MARK) || m)).toEqual([true, "continue"]);
  });

  it("delivers a follow-up once when the page closed while delivering it", async () => {
    const path = file();
    const asked = world({ state: "ok" }, () => text("Both."));
    const before = await machine(await openNodeSqliteStorage(path));
    const conversation = await before.create({ historyId: "h1" });
    await before.hold([conversation]);
    await before.harness.waitForTask(await watchJob(conversation), context);
    // What submit() writes before the commit that empties the list, and no further.
    const [pending] = (await policyOf(before, conversation))!.pending;
    const message = { role: "user" as const, content: pending.content as string, timestamp: 1 };
    await conversation.submit(
      {
        type: "write",
        requestId: `held:${pending.id}`,
        entry: { kind: "pi.user", model: [message] },
      },
      context,
    );

    const after = await reopen(before, path);
    const reopened = (await after.kept({ historyId: "h1" }))!;
    await (await after.submit(reopened, "continue")).wait(context);
    expect(asked).toHaveLength(1);
    expect(asked[0].map((m) => m.startsWith(MARK) || m)).toEqual([true, "continue"]);
    expect((await policyOf(after, reopened))?.pending).toEqual([]);
  });

  it("moves input the store had queued behind a run when it opens again", async () => {
    const path = file();
    const asked = world({ state: "queued" }, hanging, () => text("All three."));
    const before = await machine(await openNodeSqliteStorage(path));
    const conversation = await before.create({ historyId: "h1" });
    await before.submit(conversation, "first");
    await until(() => asked.length === 1);
    const queued = await conversation.submit({ type: "input", content: "second" }, context);

    const after = await reopen(before, path);
    const reopened = (await after.kept({ historyId: "h1" }))!;
    await reopened.waitForIdle(context);
    expect(asked).toHaveLength(1);
    expect((await policyOf(after, reopened))?.pending).toEqual([
      { id: `inbox:${queued.id}`, content: "second" },
    ]);
    expect(
      (await (await after.harness.submission(queued.id, context))!.status(context)).status,
    ).toBe("unanswered");
    await (await after.submit(reopened, "continue")).wait(context);
    expect(asked[1]).toEqual(["first", "second", "continue"]);
  });

  it("keeps watching across a restart and keeps the follow-up for the user", async () => {
    const path = file();
    const job = { state: "running" };
    const asked = world(job, () => text("Done."));
    const before = await machine(await openNodeSqliteStorage(path));
    const conversation = await before.create({ historyId: "h1" });
    const watching = await watchJob(conversation);
    await before.hold([conversation]);

    const after = await reopen(before, path);
    job.state = "ok";
    await after.harness.waitForTask(watching, context);
    const reopened = (await after.kept({ historyId: "h1" }))!;
    expect(asked).toHaveLength(0);
    expect((await policyOf(after, reopened))?.pending).toHaveLength(1);
  });
});

describe("the follow-up policy document", () => {
  it("reads a policy stored before follow-ups were kept in it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "olit-hold-")), "olit.sqlite3");
    const before = defineDoc<{ automatic: number; paused: boolean }>({
      kind: FollowUps.definition.kind,
      version: 2,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ automatic: 0, paused: false }),
    });
    const options = { models: {} as Models, registry: createRegistry() };
    const first = await Harness.open(await openNodeSqliteStorage(file), options, context);
    const conversation = await first.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    await conversation.commit(async (tx) => {
      Object.assign(await tx.doc(before, conversation.id), { automatic: 2, paused: true });
    }, context);
    await first.close(context);

    const second = await Harness.open(await openNodeSqliteStorage(file), options, context);
    expect(await second.snapshot(FollowUps, conversation.id, context)).toEqual({
      automatic: 2,
      paused: true,
      pending: [],
    });
    await second.close(context);
  });
});
