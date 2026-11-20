/**
 * Tell the model when it is resending a call that keeps failing the same way.
 *
 * A small model handed an error it cannot fix tends to resend the call
 * unchanged and grind there for as many turns as the user lets it (#617).
 * Once the same tool, called with exactly the same arguments, has failed with
 * the same first line of error in a few model turns in a row, the result gets
 * a note saying so and telling the model to change approach or ask the user.
 * A model that changes something irrelevant between tries starts a new streak
 * each time and is not caught: loosening the argument match would also flag
 * real work over different inputs that happen to share an error. The call
 * itself still runs: the Galaxy repeat guard is the one that refuses, and only
 * for Galaxy tools.
 *
 * Streaks are counted in model turns, not results. pi runs a turn's tool calls
 * in parallel and hands their results over in completion order, so counting
 * results would let an unrelated call in the same batch break the streak every
 * turn, and would count three copies of one call in a single batch as three
 * tries when the model has not yet seen any of the errors. A turn in which the
 * call didn't fail -- it succeeded, failed differently, or the model did
 * something else -- ends the streak. Another call in the same turn does not,
 * even one that changed what this call reads: a model editing code and
 * rerunning the same test command each turn can get the note while making
 * progress, when the test output starts the same way every time. That is
 * accepted because the note is advice and tells the model to read the error.
 *
 * Any tool that actually ran counts, and a result counts as failed when pi
 * marks it an error or the tool sets `details.error`: Orbit's own tools return
 * their rejections that way, as text the model is meant to read. A call pi
 * answers without running it -- an unknown tool, arguments that fail schema
 * validation, or a `tool_call` hook blocking it -- never reaches `tool_result`,
 * so a loop on one of those gets no note.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { stable } from "../../shared/sra-import.js";
import { resultTextOf, withoutAppendedLessonHints } from "./lessons/pi-event-contract";

export const RETRY_STREAK_LIMIT = 3;

export const RETRY_BREAKER_MARKER = "[orbit repeated failure]";

interface Streak {
  error: string;
  count: number;
  /** The last turn this call failed in with this error. */
  turn: number;
}

function failed(event: ToolResultEvent): boolean {
  if (event.isError) return true;
  const details = (event as { details?: unknown }).details;
  return (
    typeof details === "object" &&
    details !== null &&
    Boolean((details as { error?: unknown }).error)
  );
}

/**
 * What a failure is compared on: the error's first line, trimmed, exactly as
 * written. Masking ids, timestamps and paths to catch more loops grew into a
 * pile of heuristics that kept both missing loops and merging distinct
 * errors, so this doesn't try. The cost is that two errors agreeing on their
 * first line but differing below it -- a rejection listing different problems
 * under the same heading -- count as the same; with identical arguments that
 * is nearly always the same wall anyway.
 */
export function errorFirstLine(text: string): string {
  const s = text.trimStart();
  const end = s.indexOf("\n");
  return (end === -1 ? s : s.slice(0, end)).trim();
}

// Hashed so a huge argument or error line costs one pass and a fixed-size map
// entry, without cutting it short: a prefix would merge errors that differ
// only past it.
function digest(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function formatRetryNote(toolName: string, count: number): string {
  return (
    `${RETRY_BREAKER_MARKER} '${toolName}' has now failed ${count} times in a row with the same ` +
    `arguments and the same error. Sending it unchanged is unlikely to work. Stop retrying it: ` +
    `read the error, change the arguments or take a different approach, or ask the user how to proceed.`
  );
}

export function registerToolRetryBreaker(pi: ExtensionAPI): void {
  const streaks = new Map<string, Streak>();
  let turn = 0;
  const reset = () => streaks.clear();
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

  pi.on("turn_start", () => {
    turn += 1;
    for (const [call, streak] of streaks) {
      if (streak.turn < turn - 1) streaks.delete(call);
    }
  });

  pi.on("tool_result", (event, ctx) => {
    // A call another tool made reports to that tool, not to the model.
    if (event.parentToolCallId !== undefined) return;
    // A user Stop rejects the call with an error, but the call didn't fail.
    if (ctx?.signal?.aborted) return;
    const call = digest(`${event.toolName}\n${stable(event.input ?? {})}`);
    if (!failed(event)) {
      streaks.delete(call);
      return;
    }
    // A lesson hint fires once per lesson per session, so leaving it in would
    // make the first failure of a streak differ from the ones after it.
    const error = digest(errorFirstLine(resultTextOf(withoutAppendedLessonHints(event.content))));
    const streak = streaks.get(call);
    if (streak?.error !== error) streaks.set(call, { error, count: 1, turn });
    else if (streak.turn !== turn) {
      streak.count += 1;
      streak.turn = turn;
    }
    const count = streaks.get(call)!.count;
    if (count < RETRY_STREAK_LIMIT) return;
    return {
      content: [
        ...event.content,
        { type: "text" as const, text: formatRetryNote(event.toolName, count) },
      ],
      // Replacing content drops structured content unless it is handed back.
      ...(event.structuredContent !== undefined
        ? { structuredContent: event.structuredContent }
        : {}),
    };
  });
}
