/**
 * `handoff_eligible` (registry design v3 §7) as a pure function of an attempt
 * and the registry's exceptions.
 *
 * The formula is v3's. The checks after it are cross-checks against the facts
 * the evaluation was supposed to be derived from, so an evaluation that claims
 * more than the attempt supports -- a manual predicate "passed" with no user
 * attestation, an `excepted` conformity with no user exception behind it,
 * `integrity: ok` on a run Galaxy never confirmed -- fails closed instead of
 * being believed. None of
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

  // Every way past a check is a user exception for this attempt and, when there
  // is an approval, its revision -- one scope per check, so attesting a result
  // can't also excuse how it was submitted. An ungated attempt has no approval to
  // match, which is why v3 §6 lets only an exception make it eligible.
  const revision = attempt.approval?.spec_revision;
  const userExcepted = (scope: Exception["scope"], assertionId?: string) =>
    exceptions.some(
      (x) =>
        x.attempt_id === attempt.attempt_id &&
        x.by === "user" &&
        x.scope === scope &&
        x.assertion_id === assertionId &&
        (revision === undefined || x.spec_revision === revision),
    );

  if (ev.conformity === "conformant") {
    // Conformant means the harness built the request from a user approval.
    if (attempt.submission.check.outcome !== "conformant_by_construction") return false;
    if (attempt.approval?.by !== "user") return false;
    // A revoked approval no longer vouches for the run, even one it already submitted.
    if (attempt.approval.status !== "live") return false;
  } else if (!userExcepted("submission_check")) {
    return false;
  }

  const spec = attempt.approval?.spec_snapshot;
  if (!spec) {
    // Ungated: there's no frozen predicate to hold the evaluation to, so the
    // result needs the user's attestation too. Excusing how it was submitted
    // doesn't excuse what came out.
    return userExcepted("manual_attestation");
  }
  const predicate = spec.predicate;
  // A manual predicate is the user's judgment, so only their attestation passes it.
  if (predicate.kind === "manual" && !userExcepted("manual_attestation")) return false;
  if (predicate.kind === "assertions_pass") {
    if (predicate.ids.length === 0) return false;
    // An excepted assertion is a failure the user chose to accept; it counts
    // only with their evidence-gate exception naming that assertion.
    const accepted = (id: string) =>
      ev.assertions[id] === "pass" ||
      (ev.assertions[id] === "excepted" && userExcepted("evidence_gate", id));
    if (!predicate.ids.every(accepted)) return false;
  }
  return true;
}
