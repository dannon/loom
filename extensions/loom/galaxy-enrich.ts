/**
 * Enrichment: fill in what each recorded run actually was, from Galaxy.
 *
 * A block written at submission has an id, a label and -- for a tool run -- the
 * tool version from Galaxy's answer. What the run used (effective parameters,
 * input datasets) and made (outputs, with extension and dbkey) only exists in
 * the job's own details, which are not there yet when the submission returns
 * and are routinely unavailable when asked for later: the job is not
 * scheduled, the server answers 5xx, the transport drops. So enrichment is a
 * state on the block, not a one-shot: `pending`, then `complete`, or
 * `unavailable` once a 404 or a run of failures says the answer is not coming.
 * Never silently dropped.
 *
 * Per job, never per workflow. An invocation is walked to its step jobs --
 * mapped-over steps contribute one job each, subworkflows are followed -- and
 * every job gets its own record. Fields Galaxy did not give are `unknown`.
 *
 * Two facts about Galaxy's answers that decide where values come from:
 * `GET /api/jobs/{id}?full=true` drops `tool_version` (pydantic ignores the
 * extra key), so a tool run's version comes from the submission response
 * seeded into the block; and its `inputs`/`outputs` are dicts keyed by the
 * tool's slot names, holding only ids, so names, extensions and dbkeys come
 * from one dataset lookup each.
 *
 * The block carries a compact summary; the full record goes to the attempt's
 * provenance file (galaxy-provenance.ts), which refuses a block that does not
 * own the attempt it names.
 *
 * Drift lives here too, because enrichment is the moment an attempt's tool
 * versions are all known: when a completed attempt is already bound to the
 * same step, the versions that moved are written on the new block.
 */

import * as path from "path";
import { appendActivityEvent } from "./activity";
import {
  GalaxyApiError,
  galaxyGetDataset,
  galaxyGetInvocation,
  galaxyGetJobDetails,
  getGalaxyConfig,
  isGalaxyEncodedId,
  sameGalaxyServer,
  type GalaxyJobDetailsResponse,
  type InvocationDetail,
} from "./galaxy-api";
import { findJobBlocks, locateJobBlock, upsertJobBlock, type JobYaml } from "./galaxy-job-block";
import {
  ProvenanceRefusal,
  UNKNOWN,
  ensureAttemptRecord,
  provenanceRelativePath,
  readAttemptRecord,
  writeEnrichment,
  type AttemptRecord,
  type Maybe,
  type ProvenanceDataset,
  type ProvenanceJob,
} from "./galaxy-provenance";
import {
  flattenErrorText,
  type BlockDriftNote,
  type BlockJobSummary,
  type HarnessBlockFields,
} from "./harness-block-fields";
import {
  NotebookChangedError,
  findInvocationBlocks,
  locateInvocationBlock,
  readNotebook,
  statNotebook,
  upsertInvocationBlock,
  withNotebookLock,
  writeNotebook,
  type InvocationYaml,
} from "./notebook-writer";
import { getNotebookPath } from "./state";
import { isUlid } from "./ulid";

/**
 * Attempts before a block goes `unavailable`. With the backoff below that is
 * roughly eight minutes of a job's details refusing to appear after it ended,
 * which is well past a scheduler or metadata lag and short enough that a
 * genuinely broken server stops costing a round trip per tick.
 */
export const MAX_ENRICHMENT_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
/** How deep subworkflows are followed. Galaxy nests rarely past two. */
const MAX_SUBWORKFLOW_DEPTH = 4;
/** Concurrent Galaxy requests while enriching one block. */
const FETCH_CONCURRENCY = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Parsers (pure)
// ─────────────────────────────────────────────────────────────────────────────

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A toolshed tool id carries its version as its last segment
 * (`toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0+galaxy0`). The
 * lineage is the id without it: what stays the same when the version moves,
 * and so what drift compares on. A built-in id (`cat1`) is its own lineage.
 */
const TOOLSHED_GUID = /^(.+\/repos\/[^/]+\/[^/]+\/[^/]+)\/([^/]+)$/;

export function toolLineage(toolId: string): string {
  return TOOLSHED_GUID.exec(toolId)?.[1] ?? toolId;
}

/** The version a toolshed guid names, or undefined for a built-in id. */
export function versionFromToolId(toolId: string): string | undefined {
  return TOOLSHED_GUID.exec(toolId)?.[2];
}

/** A dataset reference out of a job's `inputs`/`outputs` map. */
export interface DatasetRef {
  name: string;
  id: string;
  src: string | undefined;
}

/**
 * Read `inputs`/`outputs` from full job details. Galaxy keys them by slot
 * name as a dict; a list of `{name, id, src}` is tolerated too, since the
 * shape has moved before. Entries whose id is not a Galaxy id are dropped,
 * because every id here becomes a URL path segment.
 */
export function parseDatasetRefs(raw: unknown): DatasetRef[] | null {
  if (!raw || typeof raw !== "object") return null;
  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((e, i) => [str((e as Record<string, unknown>)?.name) ?? String(i), e])
    : Object.entries(raw as Record<string, unknown>);
  const refs: DatasetRef[] = [];
  for (const [name, value] of entries) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (!isGalaxyEncodedId(v.id)) continue;
    refs.push({ name, id: v.id, src: str(v.src) });
  }
  return refs;
}

/** One job an invocation ran, as the step listing names it. */
export interface InvocationStepJob {
  jobId: string;
  toolId?: string;
  toolVersion?: string;
  state?: string;
  orderIndex?: number;
  stepLabel?: string;
  subworkflowInvocationId?: string;
}

/**
 * Every job an invocation ran: `steps[].jobs[]`, one entry per job (a
 * mapped-over step has many), and the jobs of each subworkflow it invoked.
 * Requires the step details view -- without it every `jobs` list is empty.
 */
export async function walkInvocationJobs(
  invocation: InvocationDetail,
  fetchInvocation: (id: string) => Promise<InvocationDetail>,
  depth = 0,
  seen: Set<string> = new Set([invocation.id]),
): Promise<InvocationStepJob[]> {
  const out: InvocationStepJob[] = [];
  for (const step of invocation.steps ?? []) {
    const s = step as unknown as Record<string, unknown>;
    const orderIndex = typeof s.order_index === "number" ? s.order_index : undefined;
    const stepLabel = str(s.workflow_step_label);
    const jobs = Array.isArray(s.jobs) ? s.jobs : [];
    for (const job of jobs) {
      const j = job as Record<string, unknown>;
      if (!isGalaxyEncodedId(j.id)) continue;
      out.push({
        jobId: j.id,
        toolId: str(j.tool_id),
        toolVersion: str(j.tool_version),
        state: str(j.state),
        orderIndex,
        stepLabel,
        ...(depth > 0 ? { subworkflowInvocationId: invocation.id } : {}),
      });
    }
    const sub = s.subworkflow_invocation_id;
    if (isGalaxyEncodedId(sub) && !seen.has(sub) && depth < MAX_SUBWORKFLOW_DEPTH) {
      seen.add(sub);
      const child = await fetchInvocation(sub);
      out.push(...(await walkInvocationJobs(child, fetchInvocation, depth + 1, seen)));
    }
  }
  // A job reached twice (Galaxy repeating it across views) is one job.
  const unique = new Map<string, InvocationStepJob>();
  for (const job of out) if (!unique.has(job.jobId)) unique.set(job.jobId, job);
  return [...unique.values()];
}

function datasetFacts(ref: DatasetRef, dataset: Record<string, unknown> | null): ProvenanceDataset {
  const d = dataset ?? {};
  return {
    name: ref.name,
    id: ref.id,
    src: ref.src ?? UNKNOWN,
    dataset_name: str(d.name) ?? UNKNOWN,
    ext: str(d.extension) ?? str(d.file_ext) ?? UNKNOWN,
    dbkey: str(d.genome_build) ?? str(d.metadata_dbkey) ?? UNKNOWN,
    create_time: str(d.create_time) ?? UNKNOWN,
    state: str(d.state) ?? UNKNOWN,
  };
}

/** Where a job's version came from, given what we were handed. */
export function resolveToolVersion(
  toolId: string | undefined,
  known: string | undefined,
  knownSource: ProvenanceJob["tool_version_source"],
): Pick<ProvenanceJob, "tool_version" | "tool_version_source"> {
  if (known) return { tool_version: known, tool_version_source: knownSource };
  const fromId = toolId ? versionFromToolId(toolId) : undefined;
  if (fromId) return { tool_version: fromId, tool_version_source: "tool_id" };
  return { tool_version: UNKNOWN, tool_version_source: UNKNOWN };
}

/**
 * Build one job's provenance record from its full details and the dataset
 * lookups. Pure, so every field's source is testable: what Galaxy said, or
 * `unknown`, never a guess.
 */
export function buildJobRecord(
  details: GalaxyJobDetailsResponse,
  version: Pick<ProvenanceJob, "tool_version" | "tool_version_source">,
  datasets: ReadonlyMap<string, Record<string, unknown> | null>,
  step?: ProvenanceJob["step"],
): ProvenanceJob {
  const inputs = parseDatasetRefs(details.inputs);
  const outputs = parseDatasetRefs(details.outputs);
  const collections = parseDatasetRefs(details.output_collections);
  return {
    job_id: details.id,
    tool_id: str(details.tool_id) ?? UNKNOWN,
    ...version,
    state: str(details.state) ?? UNKNOWN,
    exit_code:
      typeof details.exit_code === "number" || details.exit_code === null
        ? details.exit_code
        : UNKNOWN,
    create_time: str(details.create_time) ?? UNKNOWN,
    update_time: str(details.update_time) ?? UNKNOWN,
    command_version: str(details.command_version) ?? UNKNOWN,
    params:
      details.params && typeof details.params === "object" && !Array.isArray(details.params)
        ? details.params
        : UNKNOWN,
    inputs: inputs ? inputs.map((r) => datasetFacts(r, datasets.get(r.id) ?? null)) : UNKNOWN,
    outputs: outputs ? outputs.map((r) => datasetFacts(r, datasets.get(r.id) ?? null)) : UNKNOWN,
    output_collections: collections
      ? collections.map((r) => ({ name: r.name, id: r.id, src: r.src ?? UNKNOWN }))
      : UNKNOWN,
    ...(step ? { step } : {}),
  };
}

/** A record for a job whose details Galaxy will not give us. */
export function unavailableJobRecord(
  jobId: string,
  stepJob: InvocationStepJob | undefined,
  reason: string,
): ProvenanceJob {
  return {
    job_id: jobId,
    tool_id: stepJob?.toolId ?? UNKNOWN,
    ...resolveToolVersion(stepJob?.toolId, stepJob?.toolVersion, "invocation_step"),
    state: stepJob?.state ?? UNKNOWN,
    exit_code: UNKNOWN,
    create_time: UNKNOWN,
    update_time: UNKNOWN,
    command_version: UNKNOWN,
    params: UNKNOWN,
    inputs: UNKNOWN,
    outputs: UNKNOWN,
    output_collections: UNKNOWN,
    unavailable: flattenErrorText(reason),
  };
}

function known<T>(value: Maybe<T>): T | undefined {
  return value === UNKNOWN ? undefined : (value as T);
}

/** The compact per-job line the block carries. */
export function summarizeJobs(records: readonly ProvenanceJob[]): BlockJobSummary[] {
  return records.map((r) => {
    const outputs = r.outputs === UNKNOWN ? [] : r.outputs;
    return {
      jobId: r.job_id,
      ...(known(r.tool_id) ? { toolId: r.tool_id } : {}),
      ...(known(r.tool_version) ? { toolVersion: r.tool_version } : {}),
      ...(known(r.state) ? { state: r.state } : {}),
      ...(outputs.length > 0
        ? {
            outputs: outputs.map((o) => ({
              id: o.id,
              ...(known(o.ext) ? { ext: o.ext } : {}),
              ...(known(o.dbkey) && o.dbkey !== "?" ? { dbkey: o.dbkey } : {}),
            })),
          }
        : {}),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Drift (pure)
// ─────────────────────────────────────────────────────────────────────────────

interface AttemptVersions {
  attemptId: string;
  submittedAt: string;
  completed: boolean;
  versions: Map<string, string>;
}

/** Every attempt bound to `anchor`, with the tool versions its blocks name. */
function attemptsOnAnchor(content: string, anchor: string): AttemptVersions[] {
  const byAttempt = new Map<string, AttemptVersions>();
  const blocks: (InvocationYaml | JobYaml)[] = [
    ...findInvocationBlocks(content),
    ...findJobBlocks(content),
  ];
  for (const block of blocks) {
    if (block.notebookAnchor !== anchor || !block.attemptId) continue;
    const entry = byAttempt.get(block.attemptId) ?? {
      attemptId: block.attemptId,
      submittedAt: block.submittedAt,
      completed: false,
      versions: new Map<string, string>(),
    };
    if (block.status === "completed") entry.completed = true;
    if (block.submittedAt < entry.submittedAt) entry.submittedAt = block.submittedAt;
    for (const job of block.jobs ?? []) {
      if (!job.toolId || !job.toolVersion) continue;
      const lineage = toolLineage(job.toolId);
      if (!entry.versions.has(lineage)) entry.versions.set(lineage, job.toolVersion);
    }
    byAttempt.set(block.attemptId, entry);
  }
  return [...byAttempt.values()];
}

/**
 * Versions that moved between the latest earlier completed attempt on this
 * step and this one. Versions only: the parameter diff is the registry's.
 * An unknown version on either side is not drift -- it is a gap, and the
 * evidence gate already warns about it.
 */
export function computeDrift(
  content: string,
  anchor: string,
  attemptId: string,
  jobs: readonly BlockJobSummary[],
): { against: string; drift: BlockDriftNote[] } | null {
  if (!anchor || anchor === "unattributed") return null;
  const attempts = attemptsOnAnchor(content, anchor);
  const self = attempts.find((a) => a.attemptId === attemptId);
  const prior = attempts
    .filter((a) => a.attemptId !== attemptId && a.completed)
    .filter((a) => !self?.submittedAt || !a.submittedAt || a.submittedAt <= self.submittedAt)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
  if (!prior) return null;
  const drift: BlockDriftNote[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    if (!job.toolId || !job.toolVersion) continue;
    const lineage = toolLineage(job.toolId);
    if (seen.has(lineage)) continue;
    seen.add(lineage);
    const from = prior.versions.get(lineage);
    if (from && from !== job.toolVersion)
      drift.push({ toolId: lineage, from, to: job.toolVersion });
  }
  return { against: prior.attemptId, drift };
}

// ─────────────────────────────────────────────────────────────────────────────
// The pass
// ─────────────────────────────────────────────────────────────────────────────

export interface EnrichDeps {
  getJob: (jobId: string) => Promise<GalaxyJobDetailsResponse>;
  getInvocation: (invocationId: string) => Promise<InvocationDetail>;
  getDataset: (datasetId: string) => Promise<Record<string, unknown>>;
  now: () => number;
}

const defaultDeps: EnrichDeps = {
  getJob: (jobId) => galaxyGetJobDetails(jobId, undefined, { full: true }),
  getInvocation: (id) => galaxyGetInvocation(id),
  getDataset: (id) => galaxyGetDataset(id),
  now: () => Date.now(),
};

/** In-memory backoff, keyed `<kind>:<id>`. The attempt count itself is on the block. */
const nextAttemptAt = new Map<string, number>();
/** Drift rows already written this session, so each attempt reports once. */
const driftReported = new Set<string>();

export function resetEnrichmentState(): void {
  nextAttemptAt.clear();
  driftReported.clear();
}

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

type Candidate =
  | { kind: "invocation"; id: string; block: InvocationYaml }
  | { kind: "job"; id: string; block: JobYaml };

function isTerminalBlock(block: InvocationYaml | JobYaml): boolean {
  return block.status !== "in_progress";
}

/** Blocks waiting on enrichment that this server can answer for. */
export function enrichmentCandidates(content: string, serverUrl: string): Candidate[] {
  const out: Candidate[] = [];
  for (const block of findInvocationBlocks(content)) {
    if (block.enrichment !== "pending" || !isTerminalBlock(block)) continue;
    if (!sameGalaxyServer(block.galaxyServerUrl, serverUrl)) continue;
    out.push({ kind: "invocation", id: block.invocationId, block });
  }
  for (const block of findJobBlocks(content)) {
    if (block.enrichment !== "pending" || !isTerminalBlock(block)) continue;
    if (!sameGalaxyServer(block.galaxyServerUrl, serverUrl)) continue;
    out.push({ kind: "job", id: block.jobId, block });
  }
  return out;
}

/** What one attempt at one block came to. */
type Outcome =
  | { state: "complete"; jobs: ProvenanceJob[] }
  | { state: "unavailable"; jobs: ProvenanceJob[]; reason: string; error: string }
  | { state: "retry"; error: string };

function isNotFound(err: unknown): boolean {
  return err instanceof GalaxyApiError && (err.status === 404 || err.status === 400);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function mapLimited<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

class DatasetLookups {
  private readonly cache = new Map<string, Record<string, unknown> | null>();
  constructor(private readonly deps: EnrichDeps) {}

  /** Look up every hda the details name. A 404 is a fact (purged); anything else throws. */
  async load(
    details: GalaxyJobDetailsResponse[],
  ): Promise<Map<string, Record<string, unknown> | null>> {
    const wanted = new Set<string>();
    for (const d of details) {
      for (const ref of [
        ...(parseDatasetRefs(d.inputs) ?? []),
        ...(parseDatasetRefs(d.outputs) ?? []),
      ]) {
        if ((ref.src ?? "hda") === "hda" && !this.cache.has(ref.id)) wanted.add(ref.id);
      }
    }
    await mapLimited([...wanted], async (id) => {
      try {
        this.cache.set(id, await this.deps.getDataset(id));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        this.cache.set(id, null);
      }
    });
    return this.cache;
  }
}

/** Fetch full details and check Galaxy answered for the id we asked about. */
async function fetchDetails(deps: EnrichDeps, jobId: string): Promise<GalaxyJobDetailsResponse> {
  const details = await deps.getJob(jobId);
  if (!details || typeof details !== "object" || details.id !== jobId) {
    throw new GalaxyApiError(404, `Galaxy answered for a different job than ${jobId}`, "");
  }
  return details;
}

async function enrichJob(deps: EnrichDeps, block: JobYaml): Promise<Outcome> {
  let details: GalaxyJobDetailsResponse;
  try {
    details = await fetchDetails(deps, block.jobId);
  } catch (err) {
    if (isNotFound(err)) {
      return {
        state: "unavailable",
        jobs: [unavailableJobRecord(block.jobId, undefined, errorText(err))],
        reason: "not_found",
        error: errorText(err),
      };
    }
    return { state: "retry", error: errorText(err) };
  }
  let datasets: Map<string, Record<string, unknown> | null>;
  try {
    datasets = await new DatasetLookups(deps).load([details]);
  } catch (err) {
    return { state: "retry", error: errorText(err) };
  }
  const seeded = block.jobs?.find((j) => j.jobId === block.jobId)?.toolVersion;
  // A block reconcile found was seeded from Galaxy's job listing, not from a
  // submission the harness watched.
  const seedSource = block.submittedBy === "unknown" ? "job_listing" : "submission";
  const version = resolveToolVersion(details.tool_id || block.toolId, seeded, seedSource);
  return { state: "complete", jobs: [buildJobRecord(details, version, datasets)] };
}

async function enrichInvocation(deps: EnrichDeps, block: InvocationYaml): Promise<Outcome> {
  let stepJobs: InvocationStepJob[];
  try {
    const invocation = await deps.getInvocation(block.invocationId);
    if (invocation.id !== block.invocationId) {
      throw new GalaxyApiError(404, `Galaxy answered for a different invocation`, "");
    }
    stepJobs = await walkInvocationJobs(invocation, deps.getInvocation);
  } catch (err) {
    if (isNotFound(err)) {
      return { state: "unavailable", jobs: [], reason: "not_found", error: errorText(err) };
    }
    return { state: "retry", error: errorText(err) };
  }

  const fetched = new Map<string, GalaxyJobDetailsResponse>();
  const missing = new Map<string, string>();
  try {
    await mapLimited(stepJobs, async (job) => {
      try {
        fetched.set(job.jobId, await fetchDetails(deps, job.jobId));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        missing.set(job.jobId, errorText(err));
      }
    });
  } catch (err) {
    return { state: "retry", error: errorText(err) };
  }
  let datasets: Map<string, Record<string, unknown> | null>;
  try {
    datasets = await new DatasetLookups(deps).load([...fetched.values()]);
  } catch (err) {
    return { state: "retry", error: errorText(err) };
  }

  const records = stepJobs.map((job) => {
    const step = {
      order_index: job.orderIndex ?? UNKNOWN,
      label: job.stepLabel ?? UNKNOWN,
      ...(job.subworkflowInvocationId
        ? { subworkflow_invocation_id: job.subworkflowInvocationId }
        : {}),
    } as ProvenanceJob["step"];
    const details = fetched.get(job.jobId);
    if (!details) {
      const record = unavailableJobRecord(job.jobId, job, missing.get(job.jobId) ?? "not found");
      return { ...record, step };
    }
    const version = resolveToolVersion(
      details.tool_id || job.toolId,
      job.toolVersion,
      "invocation_step",
    );
    return buildJobRecord(details, version, datasets, step);
  });

  if (missing.size > 0) {
    return {
      state: "unavailable",
      jobs: records,
      reason: "not_found",
      error: `${missing.size} of ${stepJobs.length} job(s) not found on Galaxy`,
    };
  }
  return { state: "complete", jobs: records };
}

/**
 * The attempt record this block writes into, created now if the submission
 * predates the record (a block from before this module existed).
 *
 * When creating, a tool run's owned ids are every job block carrying the same
 * attempt id -- a mapped run's siblings belong to one attempt, and creating it
 * from the first block alone would lock the others out.
 */
async function attemptRecordFor(
  analysisDir: string,
  candidate: Candidate,
  content: string,
): Promise<AttemptRecord> {
  const attemptId = candidate.block.attemptId!;
  const existing = await readAttemptRecord(analysisDir, attemptId);
  if (existing) return existing;
  const block = candidate.block;
  return ensureAttemptRecord(analysisDir, {
    attemptId,
    kind: candidate.kind === "invocation" ? "invocation" : "jobs",
    galaxyServerUrl: block.galaxyServerUrl,
    historyId: block.historyId,
    submittedBy: block.submittedBy ?? "unknown",
    ids:
      candidate.kind === "invocation"
        ? { invocation_id: candidate.id }
        : {
            job_ids: findJobBlocks(content)
              .filter((j) => j.attemptId === attemptId)
              .map((j) => j.jobId),
          },
    origin: "notebook",
    createdAt: block.submittedAt || undefined,
  });
}

function record(dir: string, kind: string, payload: Record<string, unknown>): void {
  appendActivityEvent(dir, {
    timestamp: new Date().toISOString(),
    kind,
    source: "galaxy-enrich",
    payload,
  });
}

/**
 * Write the outcome onto the block, in one locked compare-and-swap.
 *
 * Re-reads the block it is about to replace and gives up if that block no
 * longer names the same attempt: an edit that re-pointed it while we were
 * talking to Galaxy has made this result about something else.
 */
async function persistBlock(
  nbPath: string,
  candidate: Candidate,
  fields: HarnessBlockFields,
  withDrift: boolean,
): Promise<{ written: boolean; drift?: { against: string; drift: BlockDriftNote[] } }> {
  return withNotebookLock(nbPath, async () => {
    for (let attempt = 0; ; attempt++) {
      const stamp = await statNotebook(nbPath);
      const content = await readNotebook(nbPath);
      const located =
        candidate.kind === "invocation"
          ? locateInvocationBlock(content, candidate.id)
          : locateJobBlock(content, candidate.id);
      const current = located.record;
      if (!current || current.attemptId !== candidate.block.attemptId) return { written: false };
      const drift =
        withDrift && fields.jobs
          ? computeDrift(content, current.notebookAnchor, current.attemptId!, fields.jobs)
          : null;
      const harness: HarnessBlockFields = {
        ...fields,
        ...(drift && drift.drift.length > 0 ? { drift: drift.drift } : {}),
      };
      const next =
        candidate.kind === "invocation"
          ? upsertInvocationBlock(content, current as InvocationYaml, harness)
          : upsertJobBlock(content, current as JobYaml, harness);
      if (next === content) return { written: false };
      try {
        await writeNotebook(nbPath, next, stamp ?? undefined);
        return { written: true, ...(drift ? { drift } : {}) };
      } catch (err) {
        if (!(err instanceof NotebookChangedError) || attempt >= 2) throw err;
      }
    }
  });
}

export interface EnrichmentPassResult {
  completed: string[];
  retried: string[];
  unavailable: string[];
  skipped: number;
}

let inFlightPass: Promise<EnrichmentPassResult> | null = null;

/**
 * Enrich every pending block that is due. One pass at a time; a second caller
 * gets the pass already running. `force` ignores the backoff, for `/reconcile`
 * -- a person asking now is a reason not to wait out the timer.
 */
export function runEnrichmentPass(
  options: { force?: boolean; deps?: Partial<EnrichDeps> } = {},
): Promise<EnrichmentPassResult> {
  if (inFlightPass) return inFlightPass;
  inFlightPass = enrichOnce(options).finally(() => {
    inFlightPass = null;
  });
  return inFlightPass;
}

async function enrichOnce(options: {
  force?: boolean;
  deps?: Partial<EnrichDeps>;
}): Promise<EnrichmentPassResult> {
  const result: EnrichmentPassResult = { completed: [], retried: [], unavailable: [], skipped: 0 };
  const nbPath = getNotebookPath();
  const server = getGalaxyConfig()?.url;
  if (!nbPath || !server) return result;
  const deps: EnrichDeps = { ...defaultDeps, ...options.deps };
  const dir = path.dirname(nbPath);

  let content: string;
  try {
    content = await readNotebook(nbPath);
  } catch {
    return result;
  }

  for (const candidate of enrichmentCandidates(content, server)) {
    const key = `${candidate.kind}:${candidate.id}`;
    if (!options.force && (nextAttemptAt.get(key) ?? 0) > deps.now()) {
      result.skipped++;
      continue;
    }
    const block = candidate.block;
    const attempts = (block.enrichmentAttempts ?? 0) + 1;
    const rowBase = {
      block_kind: candidate.kind,
      id: candidate.id,
      attempt_id: block.attemptId ?? null,
      step_anchor: block.notebookAnchor || null,
    };

    const giveUp = async (reason: string, error: string, jobs: ProvenanceJob[] = []) => {
      let provenance: string | null = null;
      if (jobs.length > 0 && block.attemptId && isUlid(block.attemptId)) {
        try {
          await writeEnrichment(dir, block.attemptId, {
            blockKind: candidate.kind,
            blockId: candidate.id,
            state: "unavailable",
            attempts,
            error,
            jobs,
          });
          provenance = provenanceRelativePath(block.attemptId);
        } catch {
          // The block still says why; the partial record is a bonus.
        }
      }
      const persisted = await persistBlock(
        nbPath,
        candidate,
        {
          enrichment: "unavailable",
          enrichmentAttempts: attempts,
          enrichmentError: error,
          // The job ids it did learn still go on the block: reconcile reads
          // them to know those jobs belong to this run.
          ...(jobs.length > 0 ? { jobs: summarizeJobs(jobs) } : {}),
        },
        false,
      ).catch(() => ({ written: false }));
      if (!persisted.written) return;
      nextAttemptAt.delete(key);
      result.unavailable.push(key);
      record(dir, "enrichment.unavailable", {
        ...rowBase,
        reason,
        attempts,
        error: flattenErrorText(error),
        ...(provenance ? { provenance } : {}),
      });
    };

    // The attempt id names the provenance file, so a block without a readable
    // one has nowhere to put its record. That is a fact about the block, not a
    // transient, so it is not retried.
    if (!block.attemptId || !isUlid(block.attemptId)) {
      await giveUp("no_attempt_id", "the block carries no readable attempt id");
      continue;
    }
    if (!isGalaxyEncodedId(candidate.id)) {
      await giveUp("not_found", `"${candidate.id}" is not a Galaxy id`);
      continue;
    }

    try {
      await attemptRecordFor(dir, candidate, content);
    } catch (err) {
      if (err instanceof ProvenanceRefusal) {
        await giveUp("attribution", err.message);
        continue;
      }
      // Disk trouble: try again later rather than declare the run unknowable.
      nextAttemptAt.set(key, deps.now() + backoffMs(attempts));
      result.retried.push(key);
      continue;
    }

    const outcome =
      candidate.kind === "invocation"
        ? await enrichInvocation(deps, candidate.block)
        : await enrichJob(deps, candidate.block);

    if (outcome.state === "retry") {
      if (attempts >= MAX_ENRICHMENT_ATTEMPTS) {
        await giveUp("attempts", outcome.error);
        continue;
      }
      const persisted = await persistBlock(
        nbPath,
        candidate,
        { enrichmentAttempts: attempts, enrichmentError: outcome.error },
        false,
      ).catch(() => ({ written: false }));
      if (!persisted.written) continue;
      const wait = backoffMs(attempts);
      nextAttemptAt.set(key, deps.now() + wait);
      result.retried.push(key);
      record(dir, "enrichment.retry", {
        ...rowBase,
        attempt: attempts,
        next_in_ms: wait,
        error: flattenErrorText(outcome.error),
      });
      continue;
    }

    if (outcome.state === "unavailable") {
      await giveUp(outcome.reason, outcome.error, outcome.jobs);
      continue;
    }

    try {
      await writeEnrichment(dir, block.attemptId, {
        blockKind: candidate.kind,
        blockId: candidate.id,
        state: "complete",
        attempts,
        jobs: outcome.jobs,
      });
    } catch (err) {
      if (err instanceof ProvenanceRefusal) {
        await giveUp("attribution", err.message);
        continue;
      }
      nextAttemptAt.set(key, deps.now() + backoffMs(attempts));
      result.retried.push(key);
      continue;
    }

    const jobs = summarizeJobs(outcome.jobs);
    let persisted: Awaited<ReturnType<typeof persistBlock>>;
    try {
      persisted = await persistBlock(
        nbPath,
        candidate,
        { enrichment: "complete", enrichmentAttempts: attempts, enrichmentError: "", jobs },
        true,
      );
    } catch {
      // The provenance file landed; the block catches up on the next pass.
      continue;
    }
    if (!persisted.written) continue;
    nextAttemptAt.delete(key);
    result.completed.push(key);
    record(dir, "enrichment.complete", {
      ...rowBase,
      attempts,
      job_count: outcome.jobs.length,
      tool_versions_unknown: outcome.jobs.filter((j) => j.tool_version === UNKNOWN).length,
      provenance: provenanceRelativePath(block.attemptId),
    });
    const drift = persisted.drift;
    if (drift && drift.drift.length > 0 && !driftReported.has(block.attemptId)) {
      driftReported.add(block.attemptId);
      record(dir, "drift.detected", {
        ...rowBase,
        against_attempt_id: drift.against,
        drift: drift.drift.map((d) => ({ tool_id: d.toolId, from: d.from, to: d.to })),
      });
    }
  }
  return result;
}
