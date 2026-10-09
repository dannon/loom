export const LESSON_HINT_MARKER: "[loom lesson]";
export function isLessonHintBlock(
  block: { type: string; text?: string } | null | undefined,
): boolean;
export function withoutLessonHints<T extends { type: string; text?: string }>(
  content: readonly T[],
): T[];
