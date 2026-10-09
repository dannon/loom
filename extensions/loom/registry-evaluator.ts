/**
 * The evaluation writer: asks Galaxy about every registry attempt that has a
 * submission, evaluates it (`registry-evaluation.ts`), and writes the result
 * through the store, with one `registry.evaluated` row per evaluation that
 * changed something.
 *
 * It runs from the capture queue (`galaxy-reconcile.ts` `followThrough`), so on
 * session start, after `galaxy_connect`, on every poller tick (which is where
 * terminal transitions and enrichment completions land), every Nth tick's
 * reconcile, `/reconcile`, and after a Page pull or resume. A tick only
 * re-asks about attempts whose evaluation isn't settled yet; everything else
 * re-asks about all of them, which is how an imported attempt comes back
 * through re-verification rather than inheriting what it claimed.
 *
 * Facts come from Galaxy only. The one thing Galaxy won't say -- a job's tool
 * version, which its job details drop -- is taken from the capture record's
 * submission-time seed when one exists, since that was Galaxy's own answer at
 * submission and lives under the `.loom/` floor; failing that, from a toolshed
 * id's version segment; failing that, it is unknown and conformity can't be
 * shown.
 */

import * as path from "path";
import { appendActivityEvent } from "./activity";
import {
  GalaxyApiError,
  INVOCATION_SCHEDULED_OK,
  INVOCATION_SCHEDULING_DONE,
  galaxyGetDataset,
  galaxyGetInvocation,
  galaxyGetJobDetails,
  getGalaxyConfig,
  isGalaxyFetchOverridden,
  type GalaxyJobDetailsResponse,
  type InvocationDetail,
} from "./galaxy-api";
import { parseDatasetRefs, versionFromToolId, walkInvocationJobs } from "./galaxy-enrich";
import { isTerminalJobState } from "./galaxy-job-block";
import { attemptOwns, listAttemptRecords, type AttemptRecord } from "./galaxy-provenance";
import { sessionView } from "./proposal-commands";
import {
  canonicalJson,
  computeHandoffEligible,
  sha256Hex,
  type Attempt,
  type AttemptId,
  type Registry,
} from "./registry";
import {
  evaluateAttempt,
  type RunDataset,
  type RunFacts,
  type RunJob,
} from "./registry-evaluation";
import { getSessionRegistry, type SessionRegistry } from "./registry-runtime";

export type EvaluationTrigger =
  "session_start" | "galaxy_connect" | "tick" | "enrich" | "command" | "page_pull" | "page_resume";

export interface EvaluatorDeps {
  getJob: (jobId: string) => Promise<GalaxyJobDetailsResponse>;
  getInvocation: (invocationId: string) => Promise<InvocationDetail>;
  getDataset: (datasetId: string) => Promise<Record<string, unknown>>;
  /** Capture's records, for submission-time version seeds. */
  records: (analysisDir: string) => Promise<AttemptRecord[]>;
  now: () => number;
  registry: () => SessionRegistry | null;
  /** Whether there is a Galaxy to ask: credentials, or the Tier-1 fixture. */
  connected: () => boolean;
}

const defaultDeps: EvaluatorDeps = {
  getJob: (jobId) => galaxyGetJobDetails(jobId, undefined, { full: true }),
  getInvocation: (id) => galaxyGetInvocation(id),
  getDataset: (id) => galaxyGetDataset(id),
  records: (dir) => listAttemptRecords(dir),
  now: () => Date.now(),
  registry: getSessionRegistry,
  connected: () => !!getGalaxyConfig() || isGalaxyFetchOverridden(),
};

/** Galaxy calls per pass are bounded by this many attempts. */
const MAX_ATTEMPTS_PER_PASS = 25;
const FAILED_JOB_STATES = new Set(["error", "failed", "deleted"]);

function isNotFound(err: unknown): boolean {
  return err instanceof GalaxyApiError && (err.status === 404 || err.status === 400);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The submission-time version capture recorded for a job, when it was Galaxy's word. */
function seededVersion(records: readonly AttemptRecord[], jobId: string): string | undefined {
  for (const r of records) {
    if (r.origin === "notebook" || r.fixture) continue;
    if (!attemptOwns(r, "job", jobId) && !(r.ids.invocation_id && r.jobs[jobId])) continue;
    const v = r.seeds?.[jobId]?.tool_version;
    if (v) return v;
  }
  return undefined;
}

async function datasetsFor(
  deps: EvaluatorDeps,
  ids: readonly string[],
): Promise<Map<string, Record<string, unknown> | null>> {
  const out = new Map<string, Record<string, unknown> | null>();
  for (const id of ids) {
    if (out.has(id)) continue;
    try {
      out.set(id, await deps.getDataset(id));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      out.set(id, null);
    }
  }
  return out;
}

async function jobFacts(
  deps: EvaluatorDeps,
  jobId: string,
  records: readonly AttemptRecord[],
  stepVersion?: string,
): Promise<RunJob> {
  let details: GalaxyJobDetailsResponse;
  try {
    details = await deps.getJob(jobId);
  } catch (err) {
    if (isNotFound(err)) return { job_id: jobId, unavailable: (err as Error).message };
    throw err;
  }
  if (!details || details.id !== jobId) {
    return { job_id: jobId, unavailable: `Galaxy answered for a different job than ${jobId}` };
  }
  const inputs = parseDatasetRefs(details.inputs);
  const outputs = parseDatasetRefs(details.outputs);
  const hdas = (outputs ?? []).filter((r) => (r.src ?? "hda") === "hda").map((r) => r.id);
  const datasets = await datasetsFor(deps, hdas);
  const toolId = str(details.tool_id);
  const toolVersion =
    seededVersion(records, jobId) ??
    stepVersion ??
    (toolId ? versionFromToolId(toolId) : undefined);
  const params =
    details.params && typeof details.params === "object" && !Array.isArray(details.params)
      ? (details.params as Record<string, unknown>)
      : undefined;
  return {
    job_id: jobId,
    ...(toolId ? { tool_id: toolId } : {}),
    ...(toolVersion ? { tool_version: toolVersion } : {}),
    ...(str(details.state) ? { state: str(details.state) } : {}),
    ...(params ? { params } : {}),
    ...(inputs ? { inputs: inputs.map((r) => ({ name: r.name, id: r.id, src: r.src })) } : {}),
    ...(outputs
      ? {
          outputs: outputs.map((r): RunDataset => {
            const d = datasets.get(r.id);
            return {
              name: r.name,
              id: r.id,
              ...(r.src ? { src: r.src } : {}),
              ...(d ? { ext: str(d.extension) ?? str(d.file_ext) } : {}),
              ...(d ? { state: str(d.state) } : {}),
            };
          }),
        }
      : {}),
  };
}

function jobRunState(job: RunJob): RunFacts["state"] {
  if (job.unavailable) return "unknown";
  if (job.state === "ok") return "success";
  if (FAILED_JOB_STATES.has(job.state ?? "")) return "failed";
  return isTerminalJobState(job.state) ? "unknown" : "running";
}

/**
 * Ask Galaxy about one submission. Null when Galaxy couldn't be asked (no
 * credentials, a 500, a dead network): nothing is written, and the next pass
 * asks again.
 */
export async function gatherRunFacts(
  deps: EvaluatorDeps,
  submission: NonNullable<Attempt["submission"]>,
  analysisDir: string,
): Promise<RunFacts | null> {
  const source = isGalaxyFetchOverridden() ? "fixture" : "galaxy";
  const records = await deps.records(analysisDir).catch(() => [] as AttemptRecord[]);
  try {
    if (submission.invocation_id) {
      const id = submission.invocation_id;
      let inv: InvocationDetail;
      try {
        inv = await deps.getInvocation(id);
      } catch (err) {
        if (!isNotFound(err)) throw err;
        return {
          kind: "invocation",
          run_id: id,
          verified: false,
          state: "unknown",
          jobs: [],
          source,
        };
      }
      if (!inv || inv.id !== id) {
        return {
          kind: "invocation",
          run_id: id,
          verified: false,
          state: "unknown",
          jobs: [],
          source,
        };
      }
      const steps = await walkInvocationJobs(inv, deps.getInvocation);
      const jobs: RunJob[] = [];
      for (const s of steps) jobs.push(await jobFacts(deps, s.jobId, records, s.toolVersion));
      const done = INVOCATION_SCHEDULING_DONE.has(inv.state);
      const states = jobs.map(jobRunState);
      let state: RunFacts["state"];
      if (!done || states.includes("running")) state = "running";
      else if (inv.state === "failed" || inv.state === "cancelled" || states.includes("failed"))
        state = "failed";
      else if (
        INVOCATION_SCHEDULED_OK.has(inv.state) &&
        jobs.length > 0 &&
        states.every((s) => s === "success")
      )
        state = "success";
      else state = "unknown";
      const inputs: Record<string, { id: string; src?: string }> = {};
      for (const [k, v] of Object.entries((inv.inputs ?? {}) as Record<string, unknown>)) {
        const r = v as Record<string, unknown> | null;
        if (r && typeof r.id === "string")
          inputs[k] = { id: r.id, ...(str(r.src) ? { src: str(r.src) } : {}) };
      }
      return {
        kind: "invocation",
        run_id: id,
        verified: true,
        state,
        ...(str(inv.history_id) ? { history_id: str(inv.history_id) } : {}),
        jobs,
        workflow_inputs: inputs,
        source,
      };
    }
    const id = submission.job_id;
    if (!id) return null;
    const job = await jobFacts(deps, id, records);
    if (job.unavailable) {
      return { kind: "job", run_id: id, verified: false, state: "unknown", jobs: [], source };
    }
    return {
      kind: "job",
      run_id: id,
      verified: true,
      state: jobRunState(job),
      jobs: [job],
      source,
    };
  } catch {
    return null;
  }
}

/** Whether a tick should ask about this attempt again. */
function unsettled(a: Attempt): boolean {
  const ev = a.evaluation;
  return !ev || ev.authority !== "established" || ev.execution === "unknown";
}

function sameOutcome(a: Attempt, next: ReturnType<typeof evaluateAttempt>): boolean {
  if (!a.evaluation || !a.provenance || !a.submission) return false;
  const { evaluated_at: _a, ...was } = a.evaluation;
  const { evaluated_at: _b, ...now } = next.evaluation;
  return (
    canonicalJson(was) === canonicalJson(now) &&
    canonicalJson(a.provenance) === canonicalJson(next.provenance) &&
    canonicalJson(a.submission.check) === canonicalJson(next.check) &&
    a.submission.server_verified === next.server_verified
  );
}

export interface EvaluationPass {
  evaluated: AttemptId[];
  unchanged: AttemptId[];
  unreachable: AttemptId[];
  skipped?: string;
}

let running: Promise<EvaluationPass> | null = null;

/**
 * Evaluate this session's registry attempts that have a submission. One pass
 * at a time; a second caller gets the pass already running.
 */
export function evaluateRegistryAttempts(
  trigger: EvaluationTrigger,
  deps: Partial<EvaluatorDeps> = {},
): Promise<EvaluationPass> {
  if (running) return running;
  running = runPass(trigger, { ...defaultDeps, ...deps }).finally(() => {
    running = null;
  });
  return running;
}

async function runPass(trigger: EvaluationTrigger, deps: EvaluatorDeps): Promise<EvaluationPass> {
  const out: EvaluationPass = { evaluated: [], unchanged: [], unreachable: [] };
  const session = deps.registry();
  if (!session) return { ...out, skipped: "no registry in this session" };
  if (session.store.mode !== "writer") return { ...out, skipped: "registry is read-only" };
  if (!deps.connected()) return { ...out, skipped: "no Galaxy credentials" };
  const view: Registry = sessionView(session);
  const everything = trigger !== "tick" && trigger !== "enrich";
  const due = Object.values(view.attempts)
    .filter((a) => a.submission && (a.submission.invocation_id || a.submission.job_id))
    .filter((a) => everything || unsettled(a))
    .slice(0, MAX_ATTEMPTS_PER_PASS);

  for (const attempt of due) {
    const facts = await gatherRunFacts(deps, attempt.submission!, session.analysisDir);
    if (!facts) {
      out.unreachable.push(attempt.attempt_id);
      continue;
    }
    // Content-addressed, so the same answer from Galaxy is the same file.
    const factsRef = path.posix.join(
      ".loom",
      "state",
      "templates",
      `${sha256Hex(canonicalJson(facts))}.json`,
    );
    const now = new Date(deps.now()).toISOString();
    const result = evaluateAttempt(attempt, facts, view.exceptions, { now, factsRef });
    if (sameOutcome(attempt, result)) {
      out.unchanged.push(attempt.attempt_id);
      continue;
    }
    try {
      session.store.putTemplate(facts);
    } catch (err) {
      out.unreachable.push(attempt.attempt_id);
      console.error("[registry] facts not stored:", err);
      continue;
    }
    let written: Registry;
    try {
      written = session.store.update((draft) => {
        const a = draft.attempts[attempt.attempt_id];
        if (!a?.submission) return;
        a.evaluation = result.evaluation;
        a.provenance = result.provenance;
        a.submission.check = result.check;
        a.submission.server_verified = result.server_verified;
      });
    } catch (err) {
      out.unreachable.push(attempt.attempt_id);
      console.error("[registry] evaluation not written:", err);
      continue;
    }
    const after = written.attempts[attempt.attempt_id];
    // The flag as this session reads it: a revocation held in memory counts.
    const held = sessionView(session).attempts[attempt.attempt_id] ?? after;
    out.evaluated.push(attempt.attempt_id);
    appendActivityEvent(session.analysisDir, {
      timestamp: now,
      kind: "registry.evaluated",
      source: "harness",
      payload: {
        attempt_id: attempt.attempt_id,
        step_anchor: attempt.binding.step_anchor,
        trigger,
        run: { kind: facts.kind, id: facts.run_id },
        execution: result.evaluation.execution,
        conformity: result.evaluation.conformity,
        check: result.check.outcome,
        predicate_result: result.evaluation.predicate_result,
        integrity: result.evaluation.integrity,
        authority: result.evaluation.authority,
        handoff_eligible: held
          ? computeHandoffEligible(held, sessionView(session).exceptions)
          : false,
        ...(result.check.diff ? { diff: result.check.diff } : {}),
        ...(facts.source === "fixture" ? { fixture: true } : {}),
      },
    });
  }
  return out;
}

/** Test reset. */
export function resetRegistryEvaluator(): void {
  running = null;
}
