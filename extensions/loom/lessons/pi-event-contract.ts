/**
 * The one place pi's tool-result shape is named.
 *
 * The lesson matcher needs the CALL ARGUMENTS, not just the result text: a
 * host in a URL, an extension in a path, a Galaxy tool id in `tool_id` are all
 * triggers. Only `tool_result` carries them. `message_end` -- which the
 * existing model-facing hints in `skill-triggers.ts` use -- carries just
 * `{ message }`, so a hint hosted there could never match on arguments. The
 * assertions below make that a compile error rather than a silently dead
 * trigger table if upstream ever moves a field.
 *
 * Handlers chain inside one extension in registration order, and pi feeds each
 * one the previous handler's `content`. So every handler registered after
 * `registerLessonHint` sees the hint, which is why the hint is a block of its
 * own that `withoutLessonHints` (shared/lesson-hint-marker.js) can drop.
 */

import type { MessageEndEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

/** The content array pi hands a `tool_result` handler, and accepts back. */
export type LessonToolResultContent = ToolResultEvent["content"];

/** Everything lesson matching reads off a `tool_result` event. */
export interface LessonToolResultFields {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: LessonToolResultContent;
  /**
   * Carried for completeness, and deliberately NOT a matcher input:
   * `invocation-failure-hint.ts` finds failures inside successful results, so
   * gating a lesson on `isError` would miss the cases that matter.
   */
  isError: boolean;
}

// Compile-time proof that pi's event really carries all of them.
const toolResultFields: (e: ToolResultEvent) => LessonToolResultFields = (e) => ({
  toolName: e.toolName,
  toolCallId: e.toolCallId,
  input: e.input,
  content: e.content,
  isError: e.isError,
});
void toolResultFields;

// ...and that `message_end` carries nothing but the message, which is why the
// hint cannot live there.
type MessageEndExtraKeys = Exclude<keyof MessageEndEvent, "type" | "message">;
const messageEndHasOnlyMessage: [MessageEndExtraKeys] extends [never] ? true : false = true;
void messageEndHasOnlyMessage;

/** Every text block of a result, joined -- the signature-matching haystack. */
export function resultTextOf(content: LessonToolResultContent): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Add the hint as a text block of its own at the end. Not folded into the
 * tool's last block: a later handler reading the result as the tool's output
 * has to be able to tell the two apart, and a failed call with no text of its
 * own would otherwise be described by the hint. By the time this runs the
 * oversized-output recovery has already replaced a huge result with its
 * preview (`index.ts` registers that first), so the end of the content is
 * still the end of what the model reads. Returns a copy.
 */
export function appendHintToContent(
  content: LessonToolResultContent,
  hint: string,
): LessonToolResultContent {
  return [...content, { type: "text", text: hint }];
}
