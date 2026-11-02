// Telling the model where an /approve stands (#611). A slash command starts no
// turn, so these records are the only way the model hears about it.
import type { DriftReason } from "./registry-proposal";

export type ApprovalStatus =
  // `standing`: the approval already live for this proposal, which a second
  // /approve leaves in place whatever its dialog says.
  | { id: string; state: "awaiting_confirmation"; standing?: string }
  | { id: string; state: "approved"; attemptId: string; specRevision: string }
  | { id: string; state: "already_approved"; attemptId: string }
  | { id: string; state: "not_approved"; reason: string; standing?: string }
  | { id: string; state: "revoked"; drift?: DriftReason };

const DRIFT_TEXT: Record<DriftReason, string> = {
  edited: "the proposal was edited",
  removed: "the proposal was removed from the notebook",
  duplicated: "the notebook now has more than one block claiming it",
  unreadable: "its block in the notebook can no longer be read",
  step_removed: "the plan step it belongs to was removed",
};

/** customType of the approval-status messages the model reads (#611). */
export const ORBIT_APPROVAL_STATUS_TYPE = "orbit_approval_status";
/** customType of the per-call note that an /approve dialog is open right now. */
export const ORBIT_APPROVAL_WAITING_TYPE = "orbit_approval_waiting";

const STATUS_HEAD = "[Orbit approval status]";
// A resumed session keeps an "approved" record but not the approval, which
// comes back restored, so the record has to say how long it holds.
const SESSION_ONLY =
  " This holds for this session only; after a restart, /pending says where it stands.";

/**
 * A reason can quote notebook text the agent wrote, which mustn't pass for a
 * record of its own: not on a line of its own, and not under the header.
 */
function quotedReason(reason: string): string {
  return reason.split(STATUS_HEAD).join("").replace(/\s+/g, " ").trim();
}

/**
 * What the model is told about an approval. A slash command starts no turn,
 * so without this the model only learns about /approve from whatever the user
 * types next, and answers "is it approved?" from a stale transcript.
 */
export function approvalStatusText(s: ApprovalStatus): string {
  const head = STATUS_HEAD;
  switch (s.state) {
    case "awaiting_confirmation":
      if (s.standing)
        return (
          `${head} ${s.id} is already approved (attempt ${s.standing}). The user ran /approve ${s.id} ` +
          `again and the confirmation dialog is waiting for their answer; declining it leaves that ` +
          `approval in place.`
        );
      return (
        `${head} The user ran /approve ${s.id}. ${s.id} is waiting for the user to answer the ` +
        `confirmation dialog showing what it will freeze; it is not approved yet. If they ask ` +
        `about it, tell them the dialog is waiting for their answer.`
      );
    case "revoked":
      return s.drift
        ? `${head} The approval of ${s.id} was revoked: ${DRIFT_TEXT[s.drift]}. It is not approved; do not submit it.`
        : `${head} The user revoked the approval of ${s.id}. It is not approved; do not submit it.`;
    case "approved":
      return (
        `${head} The user approved ${s.id} (attempt ${s.attemptId}, spec_revision ` +
        `${s.specRevision.slice(0, 12)}). It is no longer awaiting approval.${SESSION_ONLY}`
      );
    case "already_approved":
      return `${head} ${s.id} is already approved (attempt ${s.attemptId}); it is not awaiting approval.${SESSION_ONLY}`;
    case "not_approved":
      if (s.standing)
        return (
          `${head} The user's latest /approve of ${s.id} didn't go through: ` +
          `${quotedReason(s.reason)} Its earlier approval (attempt ${s.standing}) still stands.`
        );
      return (
        `${head} ${s.id} was not approved: ${quotedReason(s.reason)} It is still pending; the user can ` +
        `run /approve ${s.id} again.`
      );
  }
}
