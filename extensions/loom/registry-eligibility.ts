/**
 * `handoff_eligible` (registry design v3 §7) as a pure function of an attempt
 * and the registry's exceptions.
 *
 * The formula is v3's. The checks after it are cross-checks against the facts
 * the evaluation was supposed to be derived from, so an evaluation that claims
 * more than the attempt supports -- a manual predicate that "passed", an
 * `excepted` conformity with no user exception behind it, `integrity: ok` on a
 * run Galaxy never confirmed -- fails closed instead of being believed. None of
 * them can make an attempt eligible that the formula alone would not.
 */

import type { Attempt, Exception } from "./registry-schema";

export function computeHandoffEligible(
  attempt: Attempt,
  exceptions: readonly Exception[] = [],
): boolean {
  const ev = attempt.evaluation;
  const pv = attempt.provenance;
  if (!ev || !pv) return false;

  const formula =
    ev.execution === "success" &&
    (ev.conformity === "conformant" || ev.conformity === "excepted") &&
    ev.predicate_result === "pass" &&
    ev.integrity === "ok" &&
    ev.authority === "established" &&
    pv.authority === "established";
  if (!formula) return false;

  // Integrity is `unverified_identity` while Galaxy hasn't confirmed the run.
  if (!attempt.submission?.server_verified) return false;

  const spec = attempt.approval?.spec_snapshot;
  if (ev.conformity === "conformant") {
    // Conformant means the harness built the request from a user approval.
    if (attempt.submission.check.outcome !== "conformant_by_construction") return false;
    if (attempt.approval?.by !== "user") return false;
  } else {
    // Excepted needs a user-recorded exception for this attempt and, when there
    // is an approval, for its revision. An ungated attempt has no approval to
    // match, which is why v3 §6 lets only an exception make it eligible.
    const revision = attempt.approval?.spec_revision;
    const excepted = exceptions.some(
      (x) =>
        x.attempt_id === attempt.attempt_id &&
        x.by === "user" &&
        (x.scope === "submission_check" || x.scope === "manual_attestation") &&
        (revision === undefined || x.spec_revision === revision),
    );
    if (!excepted) return false;
  }

  if (spec) {
    const predicate = spec.predicate;
    // v3 §7: manual is unevaluable, or excepted via attestation; never `pass`.
    if (predicate.kind === "manual") return false;
    if (predicate.kind === "assertions_pass") {
      if (predicate.ids.length === 0) return false;
      if (!predicate.ids.every((id) => ev.assertions[id] === "pass")) return false;
    }
  }
  return true;
}
