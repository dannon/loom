/**
 * Replaying a planted lesson proposal, for the model-free eval.
 *
 * What is worth pinning deterministically is that a hostile draft is REJECTED
 * and recorded as such. Reaching that through a model is unreliable by
 * construction: a model that understood the attack declines to propose at all,
 * which is the better behaviour and leaves no row to assert on. So the eval
 * plants the proposal and drives the real core.
 *
 * The same shape as submission-replay.ts, with its two constraints:
 *
 * - the file must resolve inside the session directory (its resolveReplayPath,
 *   symlinks included), so the env var alone cannot point the replay anywhere
 *   else on the machine;
 * - every replay writes a `lesson.replay` row FIRST, so its outcome is never
 *   indistinguishable from a proposal a user made.
 *
 * It does NOT forge an approval. It arms a proposal and calls proposeLesson
 * with the session's real ctx, so the approval step still runs and still
 * refuses when there is nobody to ask. A seam that could write a lesson
 * without a human would be a hole, not a fixture.
 */

import * as fs from "fs";
import * as path from "path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readEnv } from "../../../shared/orbit-env.js";
import { appendActivityEvent } from "../activity.js";
import { getNotebookPath } from "../state.js";
import { resolveReplayPath } from "../submission-replay.js";
import type { LessonProposalInput } from "./compose.js";
import { armLessonProposal, disarmLessonProposal, proposeLesson } from "./propose.js";

export function isLessonProposalReplayEnabled(): boolean {
  return !!readEnv("LESSON_PROPOSAL_REPLAY")?.trim();
}

export function registerLessonProposalReplay(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const configured = readEnv("LESSON_PROPOSAL_REPLAY")?.trim();
    if (!configured) return;

    const notebookPath = getNotebookPath();
    if (!notebookPath) return;
    const sessionDir = path.dirname(notebookPath);

    const file = resolveReplayPath(sessionDir, configured);
    if (!file || !fs.existsSync(file)) return;

    appendActivityEvent(sessionDir, {
      timestamp: new Date().toISOString(),
      kind: "lesson.replay",
      source: "lesson-propose-replay",
      // Relative to the realpath'd directory, the way resolveReplayPath
      // compared it: against the spelled path a macOS /var -> /private/var hop
      // turns this into a ../-climb through the machine's directory names.
      payload: { file: path.relative(fs.realpathSync(sessionDir), file) },
    });

    let proposal: LessonProposalInput;
    try {
      proposal = JSON.parse(fs.readFileSync(file, "utf-8")) as LessonProposalInput;
    } catch {
      return;
    }

    // Live straight away: there is no agent run here to start it, and the
    // replay stands in for a proposal made inside one.
    const arming = armLessonProposal("explicit", { live: true });
    // Not awaited. pi's RPC mode emits session_start before it starts reading
    // stdin, so holding this handler open on the approval dialog would wait
    // for an answer that can never arrive -- and hang the whole session.
    // Everything up to the dialog (validation, the activity rows) still runs
    // synchronously here.
    void proposeLesson(proposal, {
      hasUI: ctx.hasUI,
      ui: {
        notify: (message, level) => ctx.ui.notify(message, level),
        select: (title, options) => ctx.ui.select(title, options),
        confirm: (title, message) => ctx.ui.confirm(title, message),
      },
    })
      .catch(() => undefined)
      // A rejected draft keeps its retry; the replay's arming must not outlive
      // it -- but a /lesson typed while the dialog was open is not ours to clear.
      .finally(() => disarmLessonProposal(arming));
  });
}
