/**
 * Don't let an empty completion end a run in silence (#605).
 *
 * A model can finish a tool loop with an immediate end-of-turn and no text --
 * small local models do it often, frontier models occasionally. Pi takes that
 * as a normal stop, so the user sees tool activity and then nothing: no
 * answer, no error. Say so, and ask the model once more for its answer; if the
 * retry comes back empty too, say that and stop.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deliverAutoFollowUp } from "./auto-resume";

export const EMPTY_COMPLETION_NUDGE =
  "[Loom check] Your last response was empty, so the user saw nothing after the work above. " +
  "Reply now with your answer to their latest request, based on what you've already done. " +
  "If something is blocking you, say what it is.";

export const EMPTY_COMPLETION_RETRYING =
  "The model returned an empty response. Asking it once more for an answer.";

export const EMPTY_COMPLETION_ENDED =
  "The model returned an empty response, so this run ended without an answer. " +
  "Try asking again, or switch to a stronger model in Preferences.";

export const EMPTY_COMPLETION_GAVE_UP =
  "The model returned an empty response again, so this run ended without an answer. " +
  "Try asking again, or switch to a stronger model in Preferences.";

type Message = { role: string; content?: unknown; stopReason?: string };

/**
 * Did this run end on a normal stop with nothing to show? Thinking doesn't
 * count -- the user never sees it as an answer. Errors and aborts are left
 * alone: both already surface on their own.
 */
export function endedEmpty(messages: readonly Message[]): boolean {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last || last.stopReason !== "stop") return false;
  if (!Array.isArray(last.content)) return true;
  return !last.content.some(
    (c: { type?: string; text?: unknown }) =>
      c?.type === "toolCall" ||
      (c?.type === "text" && typeof c.text === "string" && c.text.trim().length > 0),
  );
}

export function registerEmptyCompletionCheck(pi: ExtensionAPI): void {
  // Set while our retry is the turn in flight, so a second empty run gives up
  // instead of nudging forever.
  let retried = false;

  pi.on("session_start", async () => {
    retried = false;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!endedEmpty(event.messages as Message[])) {
      retried = false;
      return;
    }
    const notify = (text: string, level: "warning" | "error") => {
      try {
        if (ctx.hasUI) ctx.ui.notify(text, level);
      } catch {
        /* stale/headless context */
      }
    };
    if (retried) {
      retried = false;
      notify(EMPTY_COMPLETION_GAVE_UP, "error");
      return;
    }
    if (!deliverAutoFollowUp(EMPTY_COMPLETION_NUDGE, { dropOnStop: true })) {
      notify(EMPTY_COMPLETION_ENDED, "error");
      return;
    }
    retried = true;
    notify(EMPTY_COMPLETION_RETRYING, "warning");
  });
}
