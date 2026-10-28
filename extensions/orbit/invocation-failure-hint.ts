/**
 * Failed-invocation triage hint.
 *
 * The background poller queues automatic investigation when an invocation
 * fails. A manual check can observe the transition first, so it also needs
 * an agent-facing nudge in the tool result from
 * `galaxy_invocation_check_all` / `_check_one`, which carries `autoAction:
 * "failed"` for anything that just transitioned. The hook is a row in
 * `skill-triggers.ts`; this module holds the hint and the detector.
 *
 * Shape follows the lesson from #210/#249: a deterministic nudge cannot depend
 * on a pull for the part that makes it actionable. So the *imperative* is
 * inline and complete -- report it now, read invocation messages and job detail
 * separately, don't infer the cause from job counts. Only the interpretation
 * *depth* is a pull: the reason-code table and the API-surface map are
 * reference material that can't be inlined into a hint, and they are bundled
 * with Loom rather than fetched, so the pointer resolves offline.
 */

import { VENDOR_REPO_NAME } from "./vendor-skills";

// Bundled paths mirror the cast's own layout upstream, so the string handed to
// the model here is the same string a live fetch of that cast would use.
const CAST_NOTES = "debug-galaxy-workflow-output/references/notes";
export const INVOCATION_FAILURE_REFERENCE = `${CAST_NOTES}/galaxy-workflow-invocation-failure-reference.md`;
export const JOB_FAILURE_REFERENCE = `${CAST_NOTES}/galaxy-tool-job-failure-reference.md`;

// Distinctive opening, so the hint can't be mistaken for Galaxy's own output.
const HINT_MARKER = "[loom] A Galaxy workflow invocation just failed";

export const INVOCATION_FAILED_HINT =
  `${HINT_MARKER} — report it to the user now rather than waiting to be asked, ` +
  "and establish the cause before proposing a fix. Invocation state and job state " +
  "are different questions: the invocation says whether Galaxy could schedule and " +
  "drive the workflow, the jobs say whether the tools succeeded. Job error counts " +
  "alone do not identify the failure — read the invocation's structured messages " +
  "and the failing job's detail. Do not mark the plan step complete, and do not " +
  "guess a repair from the summary above.\n" +
  `For what the invocation message reasons and states mean: ` +
  `\`skills_fetch({ repo: "${VENDOR_REPO_NAME}", path: "${INVOCATION_FAILURE_REFERENCE}" })\`. ` +
  `For job-level evidence (exit codes, job_messages, tool vs job streams): ` +
  `\`skills_fetch({ repo: "${VENDOR_REPO_NAME}", path: "${JOB_FAILURE_REFERENCE}" })\`.`;

/** True when a check-invocations result reports at least one fresh `failed` transition. */
export function hasFailedTransition(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not the JSON summary (an error string, a truncated result) — stay quiet
    // rather than regex-matching "failed" out of arbitrary prose.
    return false;
  }
  const results = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(results)) return false;
  return results.some((r) => (r as { autoAction?: unknown })?.autoAction === "failed");
}
