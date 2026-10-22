/** What the page and the watch share about submitted Galaxy work: what settled, how, and the pace. */
import { describe, expect, it } from "vitest";

import {
  DATASET_TERMINAL_STATES,
  INVOCATION_FINISHED_STATES,
  JOB_SETTLED_STATES,
} from "@galaxyproject/galaxy-ops/browser";

import type { Galaxy } from "./galaxy";
import {
  FOLLOWS_UP,
  isTerminal,
  outcomeOf,
  pollDelay,
  SETTLED,
  stateReader,
  watchedFrom,
  type Watched,
} from "./watch";

describe("watchedFrom", () => {
  it("takes queued job ids out of a run_tool result", () => {
    expect(watchedFrom("run_tool", { jobs: [{ id: "job1", state: "new" }] })).toEqual([
      { kind: "job", id: "job1", label: "run_tool", state: "new" },
    ]);
  });

  it("takes queued job ids out of a run_user_tool result", () => {
    expect(watchedFrom("run_user_tool", { jobs: [{ id: "job2", state: "queued" }] })).toEqual([
      { kind: "job", id: "job2", label: "run_user_tool", state: "queued" },
    ]);
  });

  it("names a tool run's outputs on its jobs, so reading one counts as polling", () => {
    const data = { jobs: [{ id: "j1", state: "new" }], outputs: [{ id: "d1" }, { id: "d2" }] };
    expect(watchedFrom("run_tool", data)[0].outputs).toEqual(["d1", "d2"]);
  });

  it("watches every invocation a batch expanded to", () => {
    const batch = [
      { id: "i1", state: "new" },
      { id: "i2", state: "new" },
    ];
    expect(watchedFrom("invoke_workflow", batch).map((w) => w.id)).toEqual(["i1", "i2"]);
  });

  it("watches every job a single tool run queued", () => {
    const jobs = [
      { id: "a", state: "new" },
      { id: "b", state: "queued" },
    ];
    expect(watchedFrom("run_tool", { jobs }).map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("takes the invocation id out of an invoke_workflow result", () => {
    expect(watchedFrom("invoke_workflow", { id: "inv1", state: "new" })).toEqual([
      { kind: "invocation", id: "inv1", label: "invoke_workflow", state: "new" },
    ]);
  });

  it("watches what an upload created, because the receipt is not an outcome", () => {
    const outputs = [
      { id: "d1", hda_ldda: "hda", state: "queued" },
      { id: "d2", hda_ldda: "hda" },
    ];
    expect(watchedFrom("upload_file_from_url", { outputs })).toEqual([
      { kind: "dataset", id: "d1", label: "upload_file_from_url", state: "queued" },
      { kind: "dataset", id: "d2", label: "upload_file_from_url", state: undefined },
    ]);
  });

  it("ignores work that already finished when it came back", () => {
    expect(watchedFrom("run_tool", { jobs: [{ id: "job1", state: "ok" }] })).toEqual([]);
  });

  it("ignores tools that submit nothing, and shapes it does not know", () => {
    expect(watchedFrom("get_histories", [{ id: "h1" }])).toEqual([]);
    for (const odd of [null, "text", { jobs: "nope" }, { jobs: [null, 7] }]) {
      expect(watchedFrom("run_tool", odd)).toEqual([]);
    }
  });
});

describe("what a settled state amounts to", () => {
  it("settles exactly where Galaxy and galaxy-ops call a state final, and at a paused dataset", () => {
    // Galaxy's Job.is_terminal, plus `failed`, which galaxy-ops settles too.
    expect(Object.keys(SETTLED.job).sort()).toEqual(
      [...new Set([...JOB_SETTLED_STATES, "paused"])].sort(),
    );
    expect(Object.keys(SETTLED.dataset).sort()).toEqual(
      [...DATASET_TERMINAL_STATES, "paused"].sort(),
    );
    expect(Object.keys(SETTLED.invocation).sort()).toEqual([...INVOCATION_FINISHED_STATES].sort());
    expect(isTerminal("invocation", "scheduled")).toBe(false);
    expect(isTerminal("job", "running")).toBe(false);
  });

  it("calls a cancel a cancel and a skip a skip, as loom does, not a failure or a success", () => {
    expect(outcomeOf("job", "deleted")).toBe("cancelled");
    expect(outcomeOf("job", "stopped")).toBe("cancelled");
    expect(outcomeOf("invocation", "cancelled")).toBe("cancelled");
    expect(outcomeOf("job", "skipped")).toBe("skipped");
  });

  it("calls paused work paused, since it waits on a failed input rather than finishing", () => {
    expect(outcomeOf("job", "paused")).toBe("paused");
    expect(outcomeOf("dataset", "paused")).toBe("paused");
  });

  it("calls a failure a failure exactly where Galaxy does", () => {
    for (const state of ["error", "discarded", "failed_metadata"]) {
      expect(outcomeOf("dataset", state), state).toBe("failed");
    }
    for (const state of ["error", "failed"]) {
      expect(outcomeOf("job", state), state).toBe("failed");
    }
    expect(outcomeOf("dataset", "ok")).toBe("completed");
  });

  it("follows up on what the model has to act on, not on what someone chose", () => {
    expect(
      Object.entries(FOLLOWS_UP)
        .filter(([, yes]) => yes)
        .map(([o]) => o)
        .sort(),
    ).toEqual(["completed", "failed", "paused", "unreadable"]);
  });
});

describe("the watch's pace", () => {
  it("waits longer between polls after the first minute, up to two minutes", () => {
    const waits = Array.from({ length: 12 }, (_, i) => pollDelay(i + 1, 10_000) / 1000);
    expect(waits).toEqual([10, 10, 10, 10, 10, 10, 20, 40, 80, 120, 120, 120]);
  });
});

const JOB: Watched = { kind: "job", id: "j1", label: "run_tool", state: "queued" };

const galaxy = (answers: Record<string, unknown>, asked: string[] = []) =>
  ({
    get: async (path: string) => {
      asked.push(path);
      return answers[path];
    },
  }) as unknown as Galaxy;

describe("stateReader", () => {
  it("reports a job's state as Galaxy gives it", async () => {
    const read = stateReader(galaxy({ "api/jobs/j1": { state: "running" } }));
    expect(await read(JOB)).toBe("running");
  });

  it("settles a scheduled invocation whose jobs all finished", async () => {
    const read = stateReader(
      galaxy({
        "api/invocations/i1": { state: "scheduled" },
        "api/invocations/i1/jobs_summary": { states: { ok: 3 } },
      }),
    );
    expect(await read({ kind: "invocation", id: "i1", label: "invoke_workflow" })).toBe(
      "completed",
    );
  });

  it("settles a run failed once only the jobs Galaxy paused behind the failure remain", async () => {
    const read = stateReader(
      galaxy({
        "api/invocations/i1": { state: "scheduled" },
        "api/invocations/i1/jobs_summary": { states: { ok: 2, error: 1, paused: 3 } },
      }),
    );
    expect(await read({ kind: "invocation", id: "i1", label: "invoke_workflow" })).toBe("failed");
  });

  it("gives no state while the jobs summary cannot be read, so the next poll asks again", async () => {
    const read = stateReader(galaxy({ "api/invocations/i1": { state: "completed" } }));
    expect(await read({ kind: "invocation", id: "i1", label: "invoke_workflow" })).toBeUndefined();
  });

  it("keeps a cancelled invocation as cancelled without asking about jobs", async () => {
    const asked: string[] = [];
    const read = stateReader(galaxy({ "api/invocations/i1": { state: "cancelled" } }, asked));
    expect(await read({ kind: "invocation", id: "i1", label: "invoke_workflow" })).toBe(
      "cancelled",
    );
    expect(asked).toEqual(["api/invocations/i1"]);
  });
});
