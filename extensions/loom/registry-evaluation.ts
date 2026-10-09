/**
 * The evaluation half of the registry (design v3 §7): given an attempt and
 * what Galaxy said about its run in this session, decide the four facts and
 * what the submission check now says.
 *
 * Pure and pi-free, like the rest of the trusted core. The harness gathers the
 * facts (`registry-evaluator.ts`) and writes the result through the store; this
 * module only reads them. Nothing here takes a fact from the notebook.
 *
 * Fails toward "not shown". A fact that can't be read is `unknown` or
 * `unevaluable`, and a comparison that can't be made exactly is `unverified`,
 * never a match. A mismatch is only claimed when both sides were read and
 * differ.
 */

import {
  canonicalJson,
  sha256Hex,
  type Attempt,
  type Diff,
  type Exception,
  type Predicate,
  type Spec,
} from "./registry-schema";

/** One dataset a job read or wrote, as Galaxy reported it. */
export interface RunDataset {
  name: string;
  id: string;
  src?: string;
  ext?: string;
  state?: string;
}

/** One job of the run. Absent fields are ones Galaxy didn't give. */
export interface RunJob {
  job_id: string;
  tool_id?: string;
  tool_version?: string;
  state?: string;
  params?: Record<string, unknown>;
  inputs?: RunDataset[];
  outputs?: RunDataset[];
  /** Set when the job's details couldn't be fetched. */
  unavailable?: string;
}

/**
 * What the harness learned about one attempt's run from Galaxy, this session.
 * Built only from Galaxy's answers; the notebook never contributes.
 */
export interface RunFacts {
  kind: "invocation" | "job";
  run_id: string;
  /** Galaxy answered for exactly this id on this session's server. */
  verified: boolean;
  /**
   * `success`: done, and every job ok. `failed`: done, and something errored,
   * was cancelled, or Galaxy failed it. `running`: Galaxy can still move it.
   * `unknown`: couldn't tell, or done with nothing that succeeded.
   */
  state: "success" | "failed" | "running" | "unknown";
  history_id?: string;
  jobs: RunJob[];
  /** Invocation only: the workflow inputs Galaxy recorded, by step index. */
  workflow_inputs?: Record<string, { id: string; src?: string }>;
  fetched_at: string;
  /** `fixture` when the Tier-1 seam answered instead of a server. */
  source: "galaxy" | "fixture";
}

export type ConformityCheck =
  | { outcome: "match" }
  | { outcome: "mismatch"; diff: Diff[] }
  | { outcome: "unverifiable"; reason: string };

/**
 * Walk a Galaxy flat parameter path (`queries_0|input2`) into a job's
 * effective params. Galaxy hands top-level values back JSON-encoded as often
 * as not, so a string that parses is read as what it encodes. Undefined when
 * any step doesn't resolve.
 */
export function effectiveParam(params: Record<string, unknown>, path: string): unknown {
  const decode = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  let node: unknown = params;
  for (const part of path.split("|")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    const rec = node as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(rec, part)) {
      node = decode(rec[part]);
      continue;
    }
    // A repeat element: `queries_0` is `queries[0]`.
    const m = part.match(/^(.+)_(\d+)$/);
    if (!m || !Object.prototype.hasOwnProperty.call(rec, m[1])) return undefined;
    const list = decode(rec[m[1]]);
    if (!Array.isArray(list)) return undefined;
    node = decode(list[Number(m[2])]);
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Whether an observed value is the approved one. Galaxy stores scalars as
 * strings and dataset parameters as `{src, id}`, so both of those are read
 * through; anything else has to be canonically equal.
 */
export function sameValue(approved: unknown, observed: unknown): boolean | undefined {
  if (observed === undefined) return undefined;
  if (observed && typeof observed === "object" && !Array.isArray(observed)) {
    const o = observed as Record<string, unknown>;
    // `{values: [{src, id}]}` and `{src, id}` are how a data parameter comes back.
    const values = Array.isArray(o.values) ? o.values : [o];
    const ids = values
      .map((v) => (v && typeof v === "object" ? (v as Record<string, unknown>).id : undefined))
      .filter((id): id is string => typeof id === "string");
    if (ids.length > 0 && (typeof approved === "string" || Array.isArray(approved))) {
      const want = Array.isArray(approved) ? approved.map(String) : [approved];
      return canonicalJson([...want].sort()) === canonicalJson([...ids].sort());
    }
  }
  if (approved === null || typeof approved !== "object") {
    if (observed === null || typeof observed !== "object") {
      return String(approved) === String(observed);
    }
    return false;
  }
  try {
    return canonicalJson(approved) === canonicalJson(observed);
  } catch {
    return undefined;
  }
}

/**
 * Re-check the run Galaxy reports against the frozen Spec (the
 * `conformant_by_reconcile` route). Tools and user-defined tools are compared
 * job by job: tool id, version, every approved input and every override.
 * Workflows can't be compared yet -- an invocation doesn't report the stored
 * workflow or its version -- so they come back unverifiable.
 */
export function checkConformity(spec: Spec, facts: RunFacts): ConformityCheck {
  if (!facts.verified) return { outcome: "unverifiable", reason: "run not verified on Galaxy" };
  if (spec.target.kind === "workflow") {
    return {
      outcome: "unverifiable",
      reason: "an invocation doesn't report which workflow version ran",
    };
  }
  if (facts.kind !== "job") {
    return { outcome: "unverifiable", reason: "a tool approval recorded against an invocation" };
  }
  // One job for a plain run, many when it mapped over. A job whose details
  // never came could have run anything.
  const jobs = facts.jobs;
  if (jobs.length === 0) return { outcome: "unverifiable", reason: "no job details" };
  if (jobs.some((j) => j.unavailable)) {
    return { outcome: "unverifiable", reason: "some job details unavailable" };
  }
  const diff: Diff[] = [];
  let unknown: string | null = null;
  const wantTool = spec.target.kind === "udt" ? spec.target.tool_uuid : spec.target.tool_id;

  for (const job of jobs) {
    const at = (p: string) => `jobs.${job.job_id}.${p}`;
    if (job.tool_id === undefined || wantTool === undefined) unknown ??= "tool id not reported";
    else if (spec.target.kind === "tool" && job.tool_id !== wantTool) {
      diff.push({ path: at("tool_id"), approved: wantTool, observed: job.tool_id });
    }
    if (spec.target.kind === "udt") {
      // A user-defined tool's job reports a tool id Galaxy minted, not its
      // uuid, so the target is only checked through the definition digest
      // slice 3 re-checks at dispatch. Say so rather than calling it a match.
      unknown ??= "a user-defined tool's job doesn't name its uuid";
    }
    if (job.tool_version === undefined) unknown ??= "tool version not reported";
    else if (job.tool_version !== spec.target.version) {
      diff.push({
        path: at("tool_version"),
        approved: spec.target.version,
        observed: job.tool_version,
      });
    }
    for (const input of spec.inputs) {
      if (input.src !== "hda") {
        // A collection maps over: each job sees an element, not the collection.
        unknown ??= `input ${input.slot} is a ${input.src}`;
        continue;
      }
      const seen = job.inputs?.find((d) => d.name === input.slot);
      if (!job.inputs) unknown ??= "job inputs not reported";
      else if (!seen) unknown ??= `input ${input.slot} not reported`;
      else if (seen.id !== input.id) {
        diff.push({ path: at(`inputs.${input.slot}`), approved: input.id, observed: seen.id });
      }
    }
    for (const o of spec.overrides) {
      if (!job.params) {
        unknown ??= "job parameters not reported";
        continue;
      }
      const observed = effectiveParam(job.params, o.param);
      const same = sameValue(o.value, observed);
      if (same === undefined) unknown ??= `parameter ${o.param} not reported`;
      else if (!same) diff.push({ path: at(`params.${o.param}`), approved: o.value, observed });
    }
  }
  if (diff.length > 0) return { outcome: "mismatch", diff };
  if (unknown) return { outcome: "unverifiable", reason: unknown };
  return { outcome: "match" };
}

/** This attempt's own outputs: datasets its jobs wrote. Never an older dataset. */
function outputsOf(facts: RunFacts): RunDataset[] {
  const out = new Map<string, RunDataset>();
  for (const job of facts.jobs) for (const d of job.outputs ?? []) out.set(d.id, d);
  return [...out.values()];
}

/**
 * The predicate over this attempt's outputs. `manual` and `assertions_pass`
 * are never evaluated here: a manual one is the user's call (attested through
 * an exception), and assertions don't exist yet (#477).
 */
export function evaluatePredicate(
  predicate: Predicate,
  facts: RunFacts,
): "pass" | "fail" | "unevaluable" {
  if (facts.state !== "success") return "unevaluable";
  if (predicate.kind === "manual" || predicate.kind === "assertions_pass") return "unevaluable";
  const outputs = outputsOf(facts);
  if (facts.jobs.some((j) => !j.outputs)) return "unevaluable";
  const matching = outputs.filter(
    (d) => (predicate.ext === undefined || d.ext === predicate.ext) && d.state === "ok",
  );
  if (outputs.some((d) => d.ext === undefined && predicate.ext !== undefined)) {
    return "unevaluable";
  }
  if (predicate.kind === "exists_with_ext") {
    return matching.length >= (predicate.min_count ?? 1) ? "pass" : "fail";
  }
  return matching.length === predicate.count ? "pass" : "fail";
}

/** The `spec_revision` an exception on an attempt with no approval carries. */
export const NO_APPROVAL_REVISION = "0".repeat(64);

function userException(
  attempt: Attempt,
  exceptions: readonly Exception[],
  scope: Exception["scope"],
): boolean {
  const revision = attempt.approval?.spec_revision ?? NO_APPROVAL_REVISION;
  return exceptions.some(
    (x) =>
      x.attempt_id === attempt.attempt_id &&
      x.by === "user" &&
      x.scope === scope &&
      x.assertion_id === undefined &&
      x.spec_revision === revision,
  );
}

export interface EvaluationResult {
  evaluation: NonNullable<Attempt["evaluation"]>;
  provenance: NonNullable<Attempt["provenance"]>;
  /** The submission's check and identity as this evaluation leaves them. */
  check: NonNullable<Attempt["submission"]>["check"];
  server_verified: boolean;
}

/**
 * Evaluate one attempt that has a submission against facts gathered this
 * session. The caller writes the result; `computeHandoffEligible` then derives
 * the flag and cross-checks every claim here against the attempt.
 *
 * `factsRef` names where the facts are stored; the provenance digest is theirs.
 */
export function evaluateAttempt(
  attempt: Attempt,
  facts: RunFacts,
  exceptions: readonly Exception[],
  opts: { now: string; factsRef: string },
): EvaluationResult {
  const submission = attempt.submission;
  if (!submission) throw new Error(`attempt ${attempt.attempt_id} has no submission`);
  const execution: NonNullable<Attempt["evaluation"]>["execution"] =
    facts.state === "success" ? "success" : facts.state === "failed" ? "failed" : "unknown";

  // Fixture answers are not a server's word: they exercise the path in Tier-1
  // without ever counting as established.
  const established = facts.source === "galaxy" && facts.verified;

  let check = { ...submission.check };
  delete check.diff;
  const spec = attempt.approval?.spec_snapshot;
  if (check.outcome !== "conformant_by_construction" && spec && execution !== "unknown") {
    const c = checkConformity(spec, facts);
    if (c.outcome === "match") check = { outcome: "conformant_by_reconcile", mode: check.mode };
    else if (c.outcome === "mismatch")
      check = { outcome: "mismatch", mode: check.mode, diff: c.diff };
    else check = { outcome: "unverified", mode: check.mode };
  } else if (check.outcome === "conformant_by_construction" && spec && facts.verified) {
    // Built from the Spec, but Galaxy may still have run something else (a
    // version swapped under the request). A definite difference is an
    // effective contradiction; anything less leaves construction standing.
    const c = checkConformity(spec, facts);
    if (c.outcome === "mismatch") {
      check = { outcome: "conformant_by_construction", mode: check.mode, diff: c.diff };
    }
  }
  const effectiveContradiction =
    check.outcome === "conformant_by_construction" && (check.diff?.length ?? 0) > 0;

  const conformity: NonNullable<Attempt["evaluation"]>["conformity"] = userException(
    attempt,
    exceptions,
    "submission_check",
  )
    ? "excepted"
    : effectiveContradiction || check.outcome === "mismatch"
      ? "nonconformant"
      : check.outcome === "conformant_by_construction" ||
          check.outcome === "conformant_by_reconcile"
        ? "conformant"
        : "unverified";

  let predicate_result: NonNullable<Attempt["evaluation"]>["predicate_result"];
  if (!spec || spec.predicate.kind === "manual") {
    predicate_result =
      execution === "success" && userException(attempt, exceptions, "manual_attestation")
        ? "attested"
        : "unevaluable";
  } else {
    predicate_result = evaluatePredicate(spec.predicate, facts);
  }

  const integrity: NonNullable<Attempt["evaluation"]>["integrity"] = !facts.verified
    ? "unverified_identity"
    : effectiveContradiction
      ? "effective_contradiction"
      : "ok";

  return {
    evaluation: {
      execution,
      conformity,
      predicate_result,
      assertions: {},
      integrity,
      authority: established ? "established" : "historical",
      evaluated_at: opts.now,
    },
    provenance: {
      ref: { kind: "file", id: opts.factsRef },
      digest: sha256Hex(canonicalJson(facts)),
      enrichment: facts.jobs.some((j) => j.unavailable) ? "unavailable" : "complete",
      authority: established ? "established" : "historical",
    },
    check,
    server_verified: facts.verified,
  };
}
