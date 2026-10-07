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
// Unknown until session_start says otherwise. With no UI, lesson_propose
// refuses before showing anything, so a nudge would only buy a proposal that
// cannot be approved.
let hasUI = false;
let cursor = 0;
let seen: ActivityEvent[] | null = null;
let unsubscribe: (() => void) | null = null;

export function resetLessonNudge(): void {
  nudged = false;
  hasUI = false;
  cursor = 0;
  seen = null;
  unsubscribe?.();
  unsubscribe = null;
}

export function registerLessonNudge(pi: ExtensionAPI): void {
  resetLessonNudge();
  seen = getActivityEvents();
  cursor = seen.length;
  // onActivityChange hands over the WHOLE array each time; appends push onto
  // the same array, while resetActivity() and loadActivityLog() replace it. A
  // replaced array is a baseline, never news: a hydrated log is history, and
  // activity.jsonl sits in the workspace where anything with file access
  // could have planted a "correction" row in it.
  unsubscribe = onActivityChange((events) => {
    if (events !== seen) {
      seen = events;
      cursor = events.length;
      return;
    }
    const fresh = events.slice(cursor);
    cursor = events.length;
    if (nudged || !hasUI || !fresh.some(isCorrectionObservation)) return;
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

  pi.on("session_start", async (_event, ctx) => {
    nudged = false;
    hasUI = ctx?.hasUI === true;
  });
}
