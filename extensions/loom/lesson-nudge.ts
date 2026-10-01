/**
 * Offer to write a lesson after the user corrects the agent on a scientific
 * matter.
 *
 * That is the best capture moment there is: somebody who knows the subject has
 * just said the agent was wrong. The observation collector records it as an
 * activity row whose payload kind is "user-correction" (the user files it with
 * /observe); this module watches for that row. If the collector is absent,
 * nothing emits it, this never fires, and /lesson is the whole path.
 *
 * Delivery is sendMessage with deliverAs "nextTurn": it is queued and injected
 * with the user's NEXT prompt without starting a turn. sendUserMessage always
 * starts one, and a turn nobody asked for is the background proposal this
 * design rules out.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getActivityEvents, onActivityChange, type ActivityEvent } from "./activity.js";
import { armLessonProposal } from "./lessons/propose.js";

export const NUDGE_CUSTOM_TYPE = "loom-lesson-proposal-nudge";

export const NUDGE_TEXT = [
  "Loom noticed the user just recorded a correction to something you said about the science or",
  "the data. That is the best moment to capture a lesson, because somebody who knows the subject",
  "has just told you the right answer.",
  "",
  "When the current piece of work reaches a natural pause, offer once, in one sentence, to save",
  "it as a lesson. If they say yes, call `lesson_propose` -- they will see the draft and approve",
  "it before anything is written. If they do not answer or say no, drop it.",
  "",
  "Apply the sorting rule before offering. Could a validator, a schema, or a better error message",
  "have caught this? Then it belongs upstream in galaxy-mcp, the Foundry, or a Galaxy issue --",
  "say that instead. A lesson is for what you only catch by knowing the science or the data.",
].join("\n");

/**
 * The collector's correction row. Both row names are accepted: the contract
 * says `observation.captured`, and the collector as built records
 * `observation.built` -- either way the payload kind is what identifies a
 * correction (the trigger is "explicit", because /observe is the only way in).
 */
const OBSERVATION_ROWS = new Set(["observation.captured", "observation.built"]);

export function isCorrectionObservation(event: ActivityEvent): boolean {
  return OBSERVATION_ROWS.has(event?.kind) && event?.payload?.kind === "user-correction";
}

let nudged = false;
let cursor = 0;
let sinceMs = 0;
let unsubscribe: (() => void) | null = null;

export function resetLessonNudge(): void {
  nudged = false;
  cursor = 0;
  sinceMs = 0;
  unsubscribe?.();
  unsubscribe = null;
}

/** A row from before this session started is history, not news. */
function isRecent(event: ActivityEvent): boolean {
  const at = Date.parse(event?.timestamp);
  return Number.isFinite(at) && at >= sinceMs;
}

export function registerLessonNudge(pi: ExtensionAPI): void {
  resetLessonNudge();
  cursor = getActivityEvents().length;
  sinceMs = Date.now();
  // onActivityChange hands over the WHOLE array each time, so new rows are
  // found by cursor. resetActivity() and loadActivityLog() replace the array
  // outright; a cursor past its end means it was swapped, so rewind -- and the
  // timestamp floor keeps a hydrated log's old rows from counting as new.
  unsubscribe = onActivityChange((events) => {
    if (cursor > events.length) cursor = 0;
    const fresh = events.slice(cursor);
    cursor = events.length;
    if (nudged || !fresh.some((e) => isCorrectionObservation(e) && isRecent(e))) return;
    // Once per session. A correction loop -- the user pushing back three times
    // on one thing -- is where nagging is likeliest and least welcome.
    nudged = true;
    // The listener runs synchronously inside appendActivityEvent; sending from
    // here would re-enter pi mid-write.
    queueMicrotask(() => {
      armLessonProposal("user_correction");
      pi.sendMessage(
        { customType: NUDGE_CUSTOM_TYPE, content: NUDGE_TEXT, display: true },
        { deliverAs: "nextTurn" },
      );
    });
  });

  pi.on("session_start", async () => {
    nudged = false;
    sinceMs = Date.now();
  });
}
