/**
 * The invocation reads end to end, with nothing mocked but the network.
 *
 * checkInvocations and the poller run for real against a real notebook on
 * disk; `fetch` is a small fake Galaxy that answers the way the real one does,
 * including the part that bit us before: a single invocation fetched without
 * `step_details=true` comes back with every step's `jobs` list empty.
 *
 * The expected values below were captured from the hand-rolled reads these
 * replaced, run against the same fake Galaxy, so this suite is what pins "the
 * move to galaxy-ops changed nothing a user sees" -- results, notebook blocks,
 * and error text. One difference is deliberate and says so where it's
 * asserted: the poller's vanished-block check now asks for step details (it
 * didn't before, so a scheduled run with a job still going read as finished).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import {
  findInvocationBlocks,
  renderInvocationYaml,
  type InvocationYaml,
} from "../extensions/loom/notebook-writer";
import { checkInvocations } from "../extensions/loom/tools";
import {
  pollGalaxyNow,
  startGalaxyPoller,
  stopGalaxyPoller,
} from "../extensions/loom/galaxy-poller";

const GALAXY = "https://galaxy.example";
const KEY = "e2e-key";

type Job = { id: string; state: string; tool_id: string };
type Reply =
  | { kind: "invocation"; state: string; steps: Job[][] }
  | { kind: "status"; status: number; body: unknown }
  | { kind: "redirect"; location: string };

interface Seen {
  url: string;
  key: string | null;
}

/** A Galaxy that knows a few invocations and answers like the real one. */
function fakeGalaxy(replies: Record<string, Reply>) {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const signal = init?.signal ?? req?.signal;
    if (signal?.aborted) throw signal.reason;
    const headers = new Headers(req ? req.headers : init?.headers);
    const raw = String(req ? req.url : input);
    seen.push({ url: raw, key: headers.get("x-api-key") });
    const url = new URL(raw);
    if (headers.get("x-api-key") !== KEY) {
      return json(403, { err_msg: "Provided API key is not valid.", err_code: 403001 });
    }
    const m = url.pathname.match(/^\/api\/invocations\/([^/]+)$/);
    const reply = m ? replies[m[1]] : undefined;
    if (!m || !reply) return json(404, { err_msg: "Not found", err_code: 404001 });
    if (reply.kind === "status") return json(reply.status, reply.body);
    if (reply.kind === "redirect") {
      return new Response(null, { status: 302, headers: { location: reply.location } });
    }
    const withJobs = url.searchParams.get("step_details") === "true";
    return json(200, {
      id: m[1],
      state: reply.state,
      workflow_id: "wf-1",
      history_id: "hist-1",
      model_class: "WorkflowInvocation",
      steps: reply.steps.map((jobs, i) => ({
        id: `step-${i}`,
        order_index: i,
        state: null,
        jobs: withJobs ? jobs : [],
      })),
    });
  });
  return seen;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const job = (state: string, id = `j-${state}`): Job => ({ id, state, tool_id: "fastqc" });

function block(id: string, overrides: Partial<InvocationYaml> = {}): InvocationYaml {
  return {
    invocationId: id,
    galaxyServerUrl: GALAXY,
    notebookAnchor: "plan-a-step-1",
    label: `run ${id}`,
    submittedAt: "2026-10-01T00:00:00Z",
    status: "in_progress",
    ...overrides,
  };
}

describe("invocation reads end to end", () => {
  let dir: string;
  let nbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-inv-e2e-"));
    nbPath = join(dir, "notebook.md");
    setNotebookPath(nbPath);
    process.env.GALAXY_URL = GALAXY;
    process.env.GALAXY_API_KEY = KEY;
  });

  afterEach(() => {
    stopGalaxyPoller();
    vi.restoreAllMocks();
    resetState();
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  function notebookWith(...blocks: InvocationYaml[]) {
    writeFileSync(nbPath, blocks.map((b) => renderInvocationYaml(b)).join("\n"), "utf-8");
  }

  function blockState(id: string) {
    const b = findInvocationBlocks(readFileSync(nbPath, "utf-8")).find(
      (x) => x.invocationId === id,
    );
    return { status: b?.status, summary: b?.summary };
  }

  async function check(id?: string) {
    const result = await checkInvocations(id);
    return JSON.parse(result.content[0].text) as {
      success: boolean;
      checked: number;
      results: Array<Record<string, unknown>>;
    };
  }

  describe("checkInvocations", () => {
    it("sends one keyed GET per in-flight block, asking for step details", async () => {
      notebookWith(block("aa01"), block("aa02"), block("aa03", { status: "completed" }));
      const seen = fakeGalaxy({
        aa01: { kind: "invocation", state: "scheduled", steps: [[job("ok")]] },
        aa02: { kind: "invocation", state: "scheduled", steps: [[job("running")]] },
      });
      await check();
      expect(seen.map((s) => s.url).sort()).toEqual([
        `${GALAXY}/api/invocations/aa01?step_details=true`,
        `${GALAXY}/api/invocations/aa02?step_details=true`,
      ]);
      expect(seen.every((s) => s.key === KEY)).toBe(true);
    });

    // Captured from the hand-rolled read this replaced; see the fixture's README.
    const captured = JSON.parse(
      readFileSync(
        join(__dirname, "fixtures", "invocation-reads", "hand-rolled-check-results.json"),
        "utf-8",
      ),
    ) as Array<{
      name: string;
      state: string;
      steps: Job[][];
      block: { status: string; summary: string | null };
      result: Record<string, unknown>;
    }>;

    it("covers every scenario the old read was captured on", () => {
      expect(captured.map((c) => c.name)).toEqual([
        "every job ok",
        "a job that errored",
        "a cancel that finished",
        "a cancel still stopping",
        "a job still running",
        "a job still queued",
        "a run still scheduling",
        "a paused job",
        "a skipped step",
        "Galaxy failing to schedule",
      ]);
    });

    for (const c of captured) {
      it(`lands the same block and result as before for ${c.name}`, async () => {
        notebookWith(block("bb01"));
        fakeGalaxy({ bb01: { kind: "invocation", state: c.state, steps: c.steps } });
        const parsed = await check();
        const { lastPolledAt, ...result } = parsed.results[0];
        expect(typeof lastPolledAt).toBe("string");
        expect(result).toEqual(c.result);
        const after = blockState("bb01");
        expect({ status: after.status, summary: after.summary ?? null }).toEqual(c.block);
      });
    }

    it("keeps a block in flight when Galaxy answers 502, and checks the others", async () => {
      notebookWith(block("cc01"), block("cc02"));
      fakeGalaxy({
        cc01: { kind: "status", status: 502, body: { err_msg: "Bad gateway", err_code: 0 } },
        cc02: { kind: "invocation", state: "scheduled", steps: [[job("ok")]] },
      });
      const parsed = await check();
      const failed = parsed.results.find((r) => r.invocationId === "cc01")!;
      expect(failed.invocationState).toBe("error_checking");
      // The hand-rolled read's exact wording, raw body and all.
      expect(failed.autoAction).toBe(
        'check_error: Galaxy API 502: {"err_msg":"Bad gateway","err_code":0}',
      );
      expect(blockState("cc01").status).toBe("in_progress");
      expect(blockState("cc02").status).toBe("completed");
    });

    for (const status of [404, 403]) {
      it(`keeps a block in flight when Galaxy answers ${status}`, async () => {
        notebookWith(block("dd01"));
        fakeGalaxy({
          dd01: { kind: "status", status, body: { err_msg: "nope", err_code: status * 1000 } },
        });
        const parsed = await check();
        expect(parsed.results[0].invocationState).toBe("error_checking");
        expect(parsed.results[0].autoAction).toBe(
          `check_error: Galaxy API ${status}: {"err_msg":"nope","err_code":${status * 1000}}`,
        );
        expect(blockState("dd01").status).toBe("in_progress");
      });
    }

    it("refuses a cross-origin redirect and keeps the key at home", async () => {
      notebookWith(block("ee01"));
      const seen = fakeGalaxy({
        ee01: { kind: "redirect", location: "https://elsewhere.example/api/invocations/ee01" },
      });
      const parsed = await check();
      expect(parsed.results[0].invocationState).toBe("error_checking");
      expect(parsed.results[0].autoAction).toBe(
        "check_error: Galaxy redirected the request (HTTP 302) to https://elsewhere.example, " +
          "which is a different origin than the configured https://galaxy.example. The request " +
          "was refused and no credentials were sent to it. Check that GALAXY_URL points at the " +
          "server itself rather than a proxy or a sign-in page.",
      );
      expect(seen.some((s) => s.url.startsWith("https://elsewhere.example"))).toBe(false);
      expect(blockState("ee01").status).toBe("in_progress");
    });

    it("does not touch the network for blocks that are already finished", async () => {
      notebookWith(block("ff01", { status: "completed" }), block("ff02", { status: "failed" }));
      const seen = fakeGalaxy({});
      const parsed = await check();
      expect(parsed.results).toEqual([]);
      expect(seen).toEqual([]);
    });
  });

  describe("the poller's check on a block that vanished", () => {
    async function trackThenDelete(id: string, reply: Reply) {
      const notify = vi.fn();
      notebookWith(block(id));
      fakeGalaxy({ [id]: reply });
      startGalaxyPoller(notify);
      stopGalaxyPoller();
      await pollGalaxyNow();
      writeFileSync(nbPath, "", "utf-8");
      await pollGalaxyNow();
      return notify;
    }

    function missingRows() {
      const file = join(dir, "activity.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.kind === "poll.block_missing");
    }

    it("warns when a block for a run still scheduling is deleted", async () => {
      const notify = await trackThenDelete("gg01", {
        kind: "invocation",
        state: "ready",
        steps: [[job("new")]],
      });
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("run gg01"), "warning");
      expect(missingRows()).toHaveLength(1);
    });

    it("says nothing when the deleted block's run had finished", async () => {
      const notify = await trackThenDelete("hh01", {
        kind: "invocation",
        state: "scheduled",
        steps: [[job("ok")]],
      });
      expect(notify).not.toHaveBeenCalledWith(expect.anything(), "warning");
      expect(missingRows()).toHaveLength(0);
    });

    it("warns when a scheduled run still has a job going (deliberate change)", async () => {
      // The old check never sent step_details, so it saw no jobs at all and read
      // this run as finished. With step details it sees the running job.
      const notify = await trackThenDelete("ii01", {
        kind: "invocation",
        state: "scheduled",
        steps: [[job("ok"), job("running")]],
      });
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("run ii01"), "warning");
      expect(missingRows()).toHaveLength(1);
    });
  });
});
