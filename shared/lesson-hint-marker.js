// The inline lesson hint rides a tool result as a content block of its own,
// opening with this marker. Every tool_result handler pi runs after the hint
// sees that block too, so a handler that reads the result as the tool's own
// output -- an error signature, a failure pattern -- has to leave it out, or a
// failed call with no text of its own would be described by Loom's hint.

export const LESSON_HINT_MARKER = "[loom lesson]";

/** @param {{ type: string, text?: string } | null | undefined} block */
export function isLessonHintBlock(block) {
  return (
    !!block &&
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.startsWith(LESSON_HINT_MARKER)
  );
}

/**
 * The content as the tool produced it: every lesson hint block removed.
 * @template {{ type: string, text?: string }} T
 * @param {readonly T[]} content
 * @returns {T[]}
 */
export function withoutLessonHints(content) {
  return content.filter((block) => !isLessonHintBlock(block));
}
