/**
 * Background poller for active Galaxy workflow invocations.
 *
 * Part 2 of #67. Part 1 added the YAML counters + the Activity-tab UI
 * section that draws progress bars from them. This file is the timer
 * that keeps those counters fresh between agent turns: every
 * POLL_INTERVAL_MS, scan the notebook for in-flight blocks; if any
 * exist, run `checkInvocations` to advance status and write updated
 * counters back to notebook.md.
 *
 * Lifecycle:
 *   - session_start → startGalaxyPoller(): unconditionally start the
 *     timer. Each tick is cheap when no blocks are in-flight (one
 *     notebook read + scan, no Galaxy call).
 *   - session_shutdown → stopGalaxyPoller(): clear timer.
 *   - Multiple session_start (brain restart) → start() stops any prior
 *     timer first; idempotent.
 *
 * Why "always running" instead of stopping on idle:
 *   If we stopped at "no in-flight blocks", the next time the agent
 *   recorded a new invocation mid-session we'd never wake up — only
 *   another session_start would. Avoids a circular import between
 *   tools.ts (which records invocations) and this file. The cost is
 *   one notebook read + scan per 15s, which is negligible.
 *
 * Concurrency: ticks are guarded by `inFlight` so a slow Galaxy GET
 * doesn't stack ticks. The check itself uses the existing per-notebook
 * lock in withNotebookLock, so a manual `galaxy_invocation_check_all`
 * call from the agent doesn't race the poller.
 */

import { getNotebookPath } from "./state.js";
import {
  findInvocationBlocks,
  NotebookChangedError,
  readNotebook,
  statNotebook,
  withNotebookLock,
  writeNotebook,
} from "./notebook-writer.js";
import { checkInvocations } from "./tools.js";
import { getGalaxyConfig, galaxyGetJobDetails } from "./galaxy-api.js";
import {
  applyJobPollUpdate,
  findJobBlocks,
  isTerminalJobState,
  jobStatusFromGalaxyState,
} from "./galaxy-job-block.js";

// 15s — ~4 polls/min × a few in-flight invocations stays well under
// usegalaxy.org's per-user rate budget while still feeling live.
const POLL_INTERVAL_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** Surface a toast to the shell when a background invocation finishes. */
type PollerNotify = (text: string, level: "info" | "warning" | "error") => void;
let notify: PollerNotify | null = null;

/** Subset of a checkInvocations result entry the poller needs for notifications. */
interface PollResultEntry {
  invocationId: string;
  notebookAnchor?: string;
  label?: string;
  jobSummary?: { ok?: number; error?: number };
  autoAction?: string;
}

/** How many times a job update re-reads and retries before giving up the tick. */
const MAX_JOB_PERSIST_ATTEMPTS = 3;

/**
 * Persist one job's poll result, returning whether it actually landed.
 *
 * Same discipline as persistInvocationUpdates: stamp *before* the read (a stamp
 * taken after would let a write that landed in between look unchanged), apply
 * only poll-owned fields so a concurrent label edit survives, and hand the stamp
 * to writeNotebook so an out-of-band edit fails the compare-and-swap instead of
 * being silently overwritten (#391). The lock alone can't do this -- it only
 * orders Loom's own writers, and the agent edits notebook.md directly.
 */
async function persistJobUpdate(
  nbPath: string,
  update: Parameters<typeof applyJobPollUpdate>[1],
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_JOB_PERSIST_ATTEMPTS; attempt++) {
    const stamp = await statNotebook(nbPath);
    // Read regardless of the stat so a genuinely missing notebook surfaces its
    // own ENOENT rather than being dressed up as a lost race.
    const fresh = await readNotebook(nbPath);
    if (!stamp) {
      lastError = new NotebookChangedError(nbPath);
      continue;
    }
    const updated = applyJobPollUpdate(fresh, update);
    // Block gone, or already carrying this result: nothing to write, nothing
    // to announce.
    if (updated === fresh) return false;
    try {
      await writeNotebook(nbPath, updated, stamp);
      return true;
    } catch (error) {
      if (!(error instanceof NotebookChangedError)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** The toast for a job that stopped running, matched to why it stopped. */
function jobFinishedToast(
  status: ReturnType<typeof jobStatusFromGalaxyState>,
  label: string,
  state: string | undefined,
): [string, "info" | "warning" | "error"] {
  switch (status) {
    case "completed":
      return [`✅ Galaxy: "${label}" finished — ask me to verify the outputs.`, "info"];
    case "cancelled":
      return [`⏹️ Galaxy: "${label}" was cancelled (${state}) — it produced no outputs.`, "info"];
    case "skipped":
      return [`⏭️ Galaxy: "${label}" was skipped — its step's condition wasn't met.`, "info"];
    default:
      return [`❌ Galaxy: "${label}" failed (${state}) — ask me to investigate.`, "warning"];
  }
}

async function hasInProgressInvocations(): Promise<boolean> {
  const nbPath = getNotebookPath();
  if (!nbPath) return false;
  try {
    const content = await readNotebook(nbPath);
    return findInvocationBlocks(content).some((b) => b.status === "in_progress");
  } catch {
    // Notebook missing or unreadable — no invocations to poll.
    return false;
  }
}

/**
 * Advance in-flight `loom-job` blocks -- single Galaxy tool runs, which have no
 * invocation to poll. One GET per in-flight job, and only for jobs that are
 * still running, so an idle notebook costs nothing beyond the scan the
 * invocation path already does.
 */
async function tickJobs(): Promise<void> {
  const nbPath = getNotebookPath();
  if (!nbPath) return;

  let pending: ReturnType<typeof findJobBlocks>;
  try {
    pending = findJobBlocks(await readNotebook(nbPath)).filter((j) => j.status === "in_progress");
  } catch {
    return; // notebook missing or unreadable -- nothing to advance
  }
  if (pending.length === 0) return;
  if (!getGalaxyConfig()) return;

  for (const job of pending) {
    let state: string | undefined;
    try {
      state = (await galaxyGetJobDetails(job.jobId)).state;
    } catch (err) {
      // One unreachable job must not stop the others, or kill the timer.
      console.error(`[galaxy-poller] job ${job.jobId} poll failed:`, err);
      continue;
    }
    if (!isTerminalJobState(state)) continue;

    const status = jobStatusFromGalaxyState(state);
    let persisted: boolean;
    try {
      persisted = await withNotebookLock(nbPath, () =>
        persistJobUpdate(nbPath, {
          jobId: job.jobId,
          status,
          galaxyState: state,
          lastPolledAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      // Lost the write. Say nothing and let the next tick re-poll: the block is
      // still in_progress on disk, so announcing a transition we failed to
      // record would leave the notebook and the user telling different stories.
      console.error(`[galaxy-poller] job ${job.jobId} update failed:`, err);
      continue;
    }
    // The block was deleted mid-poll, or another writer already advanced it.
    // Either way this tick didn't transition anything, so there's no news.
    if (!persisted) continue;

    const label = job.label || job.toolId || job.jobId;
    if (notify) notify(...jobFinishedToast(status, label, state));
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Tool runs are tracked separately from workflow invocations and are the
    // only thing advancing in a session that never invoked a workflow (#413).
    await tickJobs();

    // Cheap path when nothing's in-flight: read notebook, scan, return.
    if (!(await hasInProgressInvocations())) return;
    if (!getGalaxyConfig()) {
      // Credentials disappeared (user disconnected mid-session). Skip
      // this tick; if creds come back the next tick picks up.
      return;
    }
    const result = await checkInvocations(undefined);
    // Fire a completion toast for any invocation that JUST reached a terminal
    // state this tick. The poller only checks blocks that were in_progress, so
    // an autoAction of completed/failed is a fresh transition that won't recur
    // (the block is terminal next tick and no longer checked) — notify once.
    const results = (result.details as { results?: PollResultEntry[] } | undefined)?.results;
    if (notify && Array.isArray(results)) {
      for (const r of results) {
        const label = r.label || r.notebookAnchor || r.invocationId;
        if (r.autoAction === "completed") {
          notify(
            `✅ Galaxy: "${label}" finished (${r.jobSummary?.ok ?? 0} jobs ok) — ask me to verify the outputs.`,
            "info",
          );
        } else if (r.autoAction === "failed") {
          notify(
            `❌ Galaxy: "${label}" failed (${r.jobSummary?.error ?? 0} job error(s)) — ask me to investigate.`,
            "warning",
          );
        }
      }
    }
  } catch (err) {
    // Don't kill the timer on a single bad poll — Galaxy may be
    // briefly unreachable. Log and try again on the next tick.
    console.error("[galaxy-poller] tick failed:", err);
  } finally {
    inFlight = false;
  }
}

export function startGalaxyPoller(notifyFn?: PollerNotify): void {
  // Capture the shell notifier (from the session_start ctx) so a completed
  // background invocation can toast the user. Refreshed each session_start.
  notify = notifyFn ?? null;
  // Idempotent: a brain restart triggers a new session_start without
  // session_shutdown firing first in some failure modes. Stop any
  // pre-existing timer so we don't double-poll.
  stopGalaxyPoller();
  // Fire one immediate tick so a session resumed with in-flight blocks
  // gets fresh counters within the first second instead of waiting 15s.
  void tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopGalaxyPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
