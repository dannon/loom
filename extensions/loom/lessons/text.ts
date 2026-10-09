/**
 * String helpers shared by every agent-facing rendering of a lesson.
 *
 * All three exist to keep an inline hint SHORT: the actionable sentence goes
 * inline and only the depth is a pull, so the hint gets one line of "check
 * first" and one sentence of "then", not a lesson body pasted into a tool
 * result. ASCII only -- this text reaches the model and the activity log.
 */

/** Every run of whitespace, including newlines, becomes one space. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Clip to `max`, preferring a word boundary, always marking the cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.trimEnd()}...`;
}

const DEFAULT_SENTENCE_MAX = 240;

/**
 * The first sentence, or a clip when there is no terminator. Deliberately a
 * one-line rule: an abbreviation list would be a second thing to maintain, and
 * a first step cut short at "Mr." still points at the right section with the
 * full text one `lessons_search` away.
 */
export function firstSentence(text: string, max = DEFAULT_SENTENCE_MAX): string {
  const one = collapse(text);
  const m = /^(.+?[.!?])(\s|$)/.exec(one);
  return clip(m ? m[1] : one, max);
}
