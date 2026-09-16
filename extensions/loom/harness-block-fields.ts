/**
 * Harness-only fields shared by the `loom-invocation` and `loom-job` blocks.
 *
 * Everything here is written by the harness from what Galaxy returned, never
 * by the agent. That distinction is the point: a block that says
 * `submitted_by: harness` is a claim that the harness watched the submission
 * happen and read the id out of Galaxy's own response. If the agent could set
 * that, the claim would be worth nothing -- so `stripHarnessFields` runs on
 * every agent-facing write and the values are carried over from the block
 * already on disk instead.
 *
 * `server_verified` is deliberately *not* here. It is the record tools' own
 * tri-state field (galaxy-job-block.ts and notebook-writer.ts own it): a
 * record call writes `false` when it asked Galaxy and got no answer, and the
 * poller upgrades it on the first round trip that does. Stripping it would
 * make both of those writes no-ops. The capture hook simply sets it `true` on
 * the block it writes, which it has earned the same way -- by reading the id
 * out of Galaxy's response.
 *
 * On-disk shape stays line-oriented and grep-friendly like the rest of the
 * block, one `key: value` per line. The two collection fields (`jobs`,
 * `drift`) are single-line compact JSON rather than nested YAML: every block
 * parser in the codebase reads a block line-by-line and splits on the first
 * colon, so a nested list would parse as garbage in some readers and be
 * silently dropped in others. JSON on one line round-trips exactly and still
 * greps.
 *
 * Every field here is either a bare token or a JSON array, so none of them
 * need the two block parsers' differing quote handling (`notebook-writer`
 * strips paired quotes, `galaxy-job-block` runs `JSON.parse`). A free-text
 * field -- `enrichment_error`, when the enrichment lifecycle lands -- has to
 * reconcile those two first.
 */

export type SubmittedBy = "harness" | "agent" | "unknown";
export type EnrichmentState = "pending" | "complete" | "unavailable";

const SUBMITTED_BY: readonly SubmittedBy[] = ["harness", "agent", "unknown"];
const ENRICHMENT_STATES: readonly EnrichmentState[] = ["pending", "complete", "unavailable"];

/** One output dataset on an enriched job summary. */
export interface BlockJobOutput {
  id: string;
  ext?: string;
  dbkey?: string;
}

/**
 * Compact per-job summary. The full per-attempt record lives in
 * `.loom/provenance/<attempt_id>.json`; this is what the notebook carries so
 * a reader can see the versions without opening another file.
 */
export interface BlockJobSummary {
  jobId: string;
  toolId?: string;
  toolVersion?: string;
  state?: string;
  outputs?: BlockJobOutput[];
}

/** A tool version that moved between two attempts bound to the same step. */
export interface BlockDriftNote {
  toolId: string;
  from: string;
  to: string;
}

export interface HarnessBlockFields {
  /** ULID minted at submission dispatch; the join key for the provenance file. */
  attemptId?: string;
  historyId?: string;
  submittedBy?: SubmittedBy;
  enrichment?: EnrichmentState;
  enrichmentAttempts?: number;
  jobs?: BlockJobSummary[];
  drift?: BlockDriftNote[];
}

/**
 * Every harness-owned property name, as it appears on the TS object. Used by
 * `stripHarnessFields`; keep in sync with `HarnessBlockFields`.
 */
export const HARNESS_FIELD_KEYS = [
  "attemptId",
  "historyId",
  "submittedBy",
  "enrichment",
  "enrichmentAttempts",
  "jobs",
  "drift",
] as const;

/**
 * Drop every harness-owned field from a caller-supplied record.
 *
 * Applied at the agent-facing block writers (`upsertInvocationBlock`,
 * `upsertJobBlock`) so a record-tool call can never assert provenance it
 * didn't earn -- including via a spread of raw tool arguments, which is the
 * shape this is actually defending against. Returns a shallow copy; the input
 * is untouched.
 */
export function stripHarnessFields<T extends object>(input: T): T {
  const out = { ...input } as Record<string, unknown>;
  for (const key of HARNESS_FIELD_KEYS) delete out[key];
  return out as T;
}

/** Keep only the harness-owned fields. The complement of `stripHarnessFields`. */
export function pickHarnessFields(input: HarnessBlockFields): HarnessBlockFields {
  const out: Record<string, unknown> = {};
  for (const key of HARNESS_FIELD_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as HarnessBlockFields;
}

/**
 * Merge harness fields for an upsert: `incoming` wins per field, `existing`
 * fills the gaps. `undefined` on the incoming side means "don't change",
 * which is what lets a later enrichment pass set `jobs` without having to
 * restate the attempt id.
 */
export function mergeHarnessFields(
  existing: HarnessBlockFields,
  incoming: HarnessBlockFields,
): HarnessBlockFields {
  return pickHarnessFields({ ...existing, ...pickHarnessFields(incoming) });
}

/**
 * True when a scalar can be written as a bare `key: value` line and read back
 * unchanged.
 *
 * The bare scalars here (`attempt_id`, `history_id`) are written unescaped, so
 * a value carrying a newline would render as a second block line and be read
 * back as a different field entirely -- or, worse, shadow a real one. Callers
 * are expected to have validated already (see `idToken` in
 * galaxy-submission.ts); this is the last line of defence before the bytes
 * land, because these fields will also be written by the reconcile and
 * enrichment passes that don't exist yet.
 */
function isBareScalar(value: string): boolean {
  return value.length > 0 && !/[\s\u0000-\u001f\u007f-\u009f]/.test(value);
}

/**
 * Thrown when a block field's value cannot be written as one `key: value`
 * line. Carries the field name so the caller can say which argument to fix.
 */
export class UnrenderableBlockValue extends Error {
  constructor(readonly field: string) {
    super(
      `${field} cannot contain a line break or a control character -- ` +
        `a block field is one line, and a value that spans two writes a second field.`,
    );
    this.name = "UnrenderableBlockValue";
  }
}

/**
 * One line, no control characters. Deliberately looser than `isBareScalar`:
 * an interior space is fine here, because `notebook_anchor` is matched against
 * the notebook's own spelling and headings have spaces in them. What is not
 * fine is anything that ends the line.
 */
function isOneLine(value: string): boolean {
  return !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/**
 * Render one unquoted `key: value` block line, refusing a value that would
 * not survive the round trip.
 *
 * Both block parsers read a block line by line and take the last value for a
 * key, so a value carrying a newline does not come back mangled -- it comes
 * back as *additional fields*. That is a forgery primitive wherever the value
 * is agent-supplied: `tool_id` on `galaxy_job_record` is a plain tool
 * argument, and rendering it raw let a call write `submitted_by: harness` and
 * an `attempt_id` of its choosing into a block it was only meant to label.
 *
 * Refusing beats escaping for these fields: every value that legitimately
 * reaches here is machine-generated or already token-checked upstream (see
 * `idToken` in galaxy-submission.ts), so an unrepresentable one is a bug or
 * an attempt, and either way half a block is worse than none. The free-text
 * fields -- `label`, `summary` -- go through the block's own quoting instead,
 * because a colon in a human label is ordinary.
 */
export function blockLine(key: string, value: string, field = key): string {
  if (!isOneLine(value)) throw new UnrenderableBlockValue(field);
  return `${key}: ${value}`;
}

/**
 * Render the harness fields as block lines. Only defined fields are emitted,
 * so a block written before these existed round-trips byte-identical. A scalar
 * that cannot be represented on one line is dropped rather than written: a
 * missing field reads as unknown provenance, while a broken one corrupts the
 * block around it.
 */
export function renderHarnessFieldLines(fields: HarnessBlockFields): string[] {
  const lines: string[] = [];
  if (fields.attemptId && isBareScalar(fields.attemptId)) {
    lines.push(`attempt_id: ${fields.attemptId}`);
  }
  if (fields.historyId && isBareScalar(fields.historyId)) {
    lines.push(`history_id: ${fields.historyId}`);
  }
  if (fields.submittedBy) lines.push(`submitted_by: ${fields.submittedBy}`);
  if (fields.enrichment) lines.push(`enrichment: ${fields.enrichment}`);
  if (fields.enrichmentAttempts !== undefined) {
    lines.push(`enrichment_attempts: ${fields.enrichmentAttempts}`);
  }
  if (fields.jobs && fields.jobs.length > 0) {
    lines.push(`jobs: ${JSON.stringify(fields.jobs.map(jobSummaryToWire))}`);
  }
  if (fields.drift && fields.drift.length > 0) {
    lines.push(`drift: ${JSON.stringify(fields.drift.map(driftToWire))}`);
  }
  return lines;
}

/**
 * Read harness fields back out of a parsed block. `get` is the block parser's
 * own field lookup, so this works for both block types without caring how
 * they split lines.
 *
 * Unrecognised values are dropped rather than coerced: a hand-edited
 * `submitted_by: definitely-the-harness` reads back as absent, which the
 * consumers already treat as "unknown provenance". Coercing it to a legal
 * value would invent a claim.
 */
export function parseHarnessFields(get: (key: string) => string | undefined): HarnessBlockFields {
  const fields: HarnessBlockFields = {};

  const attemptId = get("attempt_id");
  if (attemptId) fields.attemptId = attemptId;

  const historyId = get("history_id");
  if (historyId) fields.historyId = historyId;

  const submittedBy = get("submitted_by");
  if (submittedBy && (SUBMITTED_BY as readonly string[]).includes(submittedBy)) {
    fields.submittedBy = submittedBy as SubmittedBy;
  }

  const enrichment = get("enrichment");
  if (enrichment && (ENRICHMENT_STATES as readonly string[]).includes(enrichment)) {
    fields.enrichment = enrichment as EnrichmentState;
  }

  const attempts = Number(get("enrichment_attempts"));
  if (get("enrichment_attempts") && Number.isFinite(attempts)) fields.enrichmentAttempts = attempts;

  const jobs = parseJsonArray(get("jobs"), jobSummaryFromWire);
  if (jobs) fields.jobs = jobs;

  const drift = parseJsonArray(get("drift"), driftFromWire);
  if (drift) fields.drift = drift;

  return fields;
}

/**
 * Parse a single-line JSON array field. A malformed value yields `undefined`
 * (field absent) rather than throwing -- one bad hand edit must not make the
 * whole block unreadable and take its ids with it.
 */
function parseJsonArray<T>(raw: string | undefined, map: (entry: unknown) => T | null): T[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: T[] = [];
  for (const entry of parsed) {
    const mapped = map(entry);
    if (mapped) out.push(mapped);
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jobSummaryToWire(job: BlockJobSummary): Record<string, unknown> {
  return {
    job_id: job.jobId,
    ...(job.toolId ? { tool_id: job.toolId } : {}),
    ...(job.toolVersion ? { tool_version: job.toolVersion } : {}),
    ...(job.state ? { state: job.state } : {}),
    ...(job.outputs && job.outputs.length > 0
      ? {
          outputs: job.outputs.map((o) => ({
            id: o.id,
            ...(o.ext ? { ext: o.ext } : {}),
            ...(o.dbkey ? { dbkey: o.dbkey } : {}),
          })),
        }
      : {}),
  };
}

function jobSummaryFromWire(entry: unknown): BlockJobSummary | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const jobId = str(e.job_id);
  if (!jobId) return null;
  const outputs = Array.isArray(e.outputs)
    ? e.outputs
        .map((o): BlockJobOutput | null => {
          if (!o || typeof o !== "object") return null;
          const id = str((o as Record<string, unknown>).id);
          if (!id) return null;
          return {
            id,
            ext: str((o as Record<string, unknown>).ext),
            dbkey: str((o as Record<string, unknown>).dbkey),
          };
        })
        .filter((o): o is BlockJobOutput => o !== null)
    : undefined;
  return {
    jobId,
    toolId: str(e.tool_id),
    toolVersion: str(e.tool_version),
    state: str(e.state),
    ...(outputs && outputs.length > 0 ? { outputs } : {}),
  };
}

function driftToWire(note: BlockDriftNote): Record<string, unknown> {
  return { tool_id: note.toolId, from: note.from, to: note.to };
}

function driftFromWire(entry: unknown): BlockDriftNote | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const toolId = str(e.tool_id);
  const from = str(e.from);
  const to = str(e.to);
  if (!toolId || !from || !to) return null;
  return { toolId, from, to };
}
