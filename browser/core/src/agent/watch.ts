/**
 * What the page and the watch share about Galaxy work a conversation submitted: what settled and
 * how, and the pace the watch polls at. Orbit's watch (orbit/watch.ts) is the task itself.
 */
import { HttpError, segment, type Galaxy } from "./galaxy";
import { invocationOutcome } from "@galaxyproject/galaxy-ops/browser";

export type WatchKind = "job" | "invocation" | "dataset";

export interface Watched {
  kind: WatchKind;
  id: string;
  /** What to call it in the UI: the tool that submitted it. */
  label: string;
  state?: string;
  outputs?: string[];
}

/**
 * What a settled Galaxy state amounts to. A run the user cancelled did not fail, and it did not
 * do what was asked either; a skipped job was skipped on purpose; a paused one waits on a failed
 * input and runs only once someone acts; one Galaxy no longer shows is unreadable.
 */
export type Outcome = "completed" | "failed" | "cancelled" | "skipped" | "paused" | "unreadable";

/**
 * Each kind's settled states and what they amount to; a state not listed has not settled. Jobs
 * follow Galaxy's `Job.is_terminal`, datasets its `Dataset.terminal_states` plus `paused`, which
 * nothing changes until the user acts, invocations what galaxy-ops makes of their jobs. A user's
 * cancel ends a job in `deleted`, as loom reads it.
 */
export const SETTLED: { [K in WatchKind]: Readonly<Record<string, Outcome>> } = {
  job: {
    ok: "completed",
    error: "failed",
    failed: "failed",
    deleted: "cancelled",
    stopped: "cancelled",
    skipped: "skipped",
    paused: "paused",
  },
  dataset: {
    ok: "completed",
    empty: "completed",
    deferred: "completed",
    error: "failed",
    discarded: "failed",
    failed_metadata: "failed",
    paused: "paused",
  },
  invocation: { completed: "completed", failed: "failed", cancelled: "cancelled" },
};

/** Whether each outcome is news the model has to act on, rather than what someone chose. */
export const FOLLOWS_UP: Readonly<Record<Outcome, boolean>> = {
  completed: true,
  failed: true,
  paused: true,
  unreadable: true,
  cancelled: false,
  skipped: false,
};

export const isTerminal = (kind: WatchKind, state: string | undefined) =>
  !!state && Object.hasOwn(SETTLED[kind], state);

export const outcomeOf = (kind: WatchKind, state: string): Outcome =>
  SETTLED[kind][state] ?? "completed";

const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((v) => v && typeof v === "object") : [];

/** The tools whose results submit Galaxy work to watch. */
export const WATCHED_TOOLS = new Set([
  "run_tool",
  "run_user_tool",
  "upload_file_from_url",
  "upload_file",
  "invoke_workflow",
]);

/** The unfinished work a tool's Galaxy result names; an unknown shape names none. */
export function watchedFrom(toolName: string, data: unknown): Watched[] {
  if (!WATCHED_TOOLS.has(toolName)) return [];
  const payload = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const out: Watched[] = [];
  const add = (kind: WatchKind, item: Record<string, unknown>, outputs?: string[]) => {
    if (typeof item.id === "string") {
      const state = item.state as string | undefined;
      out.push({
        kind,
        id: item.id,
        label: toolName,
        state,
        ...(outputs?.length ? { outputs } : {}),
      });
    }
  };
  if (toolName === "run_tool" || toolName === "run_user_tool") {
    const outputs = records(payload.outputs)
      .map((o) => o.id)
      .filter((id): id is string => typeof id === "string");
    records(payload.jobs).forEach((job) => add("job", job, outputs));
  } else if (toolName === "upload_file_from_url" || toolName === "upload_file") {
    // The receipt is not an outcome: the datasets it created are what to wait for.
    records(payload.outputs).forEach((output) => add("dataset", output));
  } else if (toolName === "invoke_workflow") {
    (Array.isArray(data) ? records(data) : [payload]).forEach((i) => add("invocation", i));
  }
  return out.filter((w) => !isTerminal(w.kind, w.state));
}

/** Watched work that reached a state it will not leave. */
export interface Settled {
  watched: Watched;
  state: string;
  outcome: Outcome;
  /** Why the record could not be updated for this work, when it could not. */
  record?: string;
}

/** How many of an invocation's jobs are in each state, or undefined when Galaxy gives no summary. */
export async function invocationJobStates(
  galaxy: Galaxy,
  id: string,
): Promise<Record<string, number> | undefined> {
  const states = (await galaxy.get(`api/invocations/${segment(id)}/jobs_summary`))?.states;
  return states && typeof states === "object" ? states : undefined;
}

/** Reads one item's state from Galaxy; an invocation's comes from its jobs as well. */
export function stateReader(galaxy: Galaxy) {
  const stateOf = (body: unknown) => {
    const state = (body as { state?: unknown } | undefined)?.state;
    return typeof state === "string" ? state : undefined;
  };
  return async (w: Watched): Promise<string | undefined> => {
    if (w.kind === "job") return stateOf(await galaxy.get(`api/jobs/${segment(w.id)}`));
    if (w.kind === "dataset") return stateOf(await galaxy.get(`api/datasets/${segment(w.id)}`));
    const state = stateOf(await galaxy.get(`api/invocations/${segment(w.id)}`));
    if (state !== "scheduled" && state !== "completed") return state;
    const states = await invocationJobStates(galaxy, w.id);
    return states && invocationOutcome(state, states);
  };
}

/**
 * The wait after `polls` polls: `pollMs` for the first six, about a minute at Galaxy's pace, then
 * doubling to twelve times it. Work is watched until it settles, however long that takes.
 */
export function pollDelay(polls: number, pollMs: number): number {
  return Math.min(pollMs * 2 ** Math.max(0, polls - 6), pollMs * 12);
}

export const watchKey = (w: { kind: string; id: string }) => `${w.kind}:${w.id}`;

export const WATCH_TASK = "olit.galaxy-watch";
