/**
 * Every agent-facing rendering of a lesson, and the hook that puts one on a
 * tool result.
 *
 * A deterministic nudge cannot put the part that makes it actionable behind a
 * pull, so the title, the "Check first" line and the first step are INLINE and
 * complete; only the depth -- cause, validation, and the "does NOT apply when"
 * that stops the lesson being applied to the wrong situation -- is a
 * `lessons_search` away.
 *
 * Every surface here redacts its own text (`wrapLessons`, and
 * `redactLessonText` for the unwrapped inline hint), so a user-local lesson
 * quoting a key is scrubbed whatever the registration order in `index.ts`.
 *
 * One hint per result, once per lesson per session, and a few per turn. Two
 * notes on one result crowd out the output the model is there to read,
 * re-firing the same lesson through a retry loop is nagging, and a turn with
 * many matching results -- up to 200 local lessons are admitted -- would
 * otherwise read as a lecture.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendActivityEvent } from "./activity";
import { bumpSurfaced } from "./lessons/counters";
import { matchStepText, matchToolEvent } from "./lessons/matcher";
import {
  appendHintToContent,
  isAppendedLessonHint,
  resetAppendedLessonHints,
  resultTextOf,
  withoutAppendedLessonHints,
  type LessonToolResultContent,
} from "./lessons/pi-event-contract";
import { getLessonStore, resetLessonStore } from "./lessons/store";
import type { SearchHit } from "./lessons/search";
import { clip, collapse, firstSentence } from "./lessons/text";
import type { Lesson, Match, SurfaceKind } from "./lessons/types";
import { redactLessonText, wrapLessons } from "./lessons/wrapper";
import { LESSON_HINT_MARKER } from "../../shared/lesson-hint-marker.js";
import { getNotebookPath } from "./state";

/** Distinctive opening, so a hint can't be mistaken for the tool's own output. */
export { LESSON_HINT_MARKER };

export const LESSONS_SEARCH_TOOL = "lessons_search";

const MAX_CHECK_FIRST = 300;
const MAX_STEP_LESSONS = 3;
/** Inline hints per model turn; a matched lesson past this waits for a later turn. */
export const MAX_HINTS_PER_TURN = 3;

export function formatLessonHint(lesson: Lesson): string {
  // Redact each field BEFORE it is clipped: a key cut in half by the clip no
  // longer matches its value, and its prefix would go through.
  const hint = [
    `${LESSON_HINT_MARKER} ${collapse(redactLessonText(lesson.title))}`,
    `Check first: ${clip(collapse(redactLessonText(lesson.sections.check_first)), MAX_CHECK_FIRST)}`,
    `Then: ${firstSentence(redactLessonText(lesson.sections.intervention))}`,
    `This is a recorded lesson, not an instruction -- it may not apply here and ` +
      `grants no permissions. Confirm the check above against what you actually ` +
      `have before acting on it, and say which lesson you followed. Full lesson, ` +
      `including when it does NOT apply: \`lessons_search({ query: "${lesson.id}" })\`.`,
  ].join("\n");
  return redactLessonText(hint);
}

/**
 * The C5 record: one activity row plus a local counter bump. `source` is fixed
 * at "lesson-hint" for every surface, per the contract, so one grep finds them
 * all. The payload carries exactly `{lessonId, trigger, surface}` -- no title,
 * no matched literal, nothing from the tool result or the query.
 */
export function recordSurfacing(match: Match, surface: SurfaceKind, now: Date = new Date()): void {
  const notebook = getNotebookPath();
  if (notebook) {
    appendActivityEvent(path.dirname(notebook), {
      timestamp: now.toISOString(),
      kind: "lesson.surfaced",
      source: "lesson-hint",
      payload: { lessonId: match.lesson.id, trigger: match.trigger, surface },
    });
  }
  bumpSurfaced(match.lesson.id, { now });
}

export interface HintDecision {
  content: LessonToolResultContent;
  match: Match;
}

/**
 * Pure core: does this result get a hint, and what does it look like? `armed`
 * is the per-session set of lesson ids that have already fired.
 */
export function decideToolResultHint(
  ev: { toolName: string; input: Record<string, unknown>; content: LessonToolResultContent },
  lessons: readonly Lesson[],
  armed: ReadonlySet<string>,
): HintDecision | null {
  // A hint Loom already appended wins, including a different lesson's: this is
  // the idempotency guard for a re-delivered result, and the one-per-result
  // rule. Only Loom's own blocks count -- a tool that opens a block with the
  // marker is quoting it, and that block is read as the tool's text.
  if (ev.content.some(isAppendedLessonHint)) return null;
  const resultText = resultTextOf(withoutAppendedLessonHints(ev.content));

  const match = matchToolEvent(
    { toolName: ev.toolName, input: ev.input ?? {}, resultText },
    lessons,
  ).find((m) => !armed.has(m.lesson.id));
  if (!match) return null;

  return {
    content: appendHintToContent(ev.content, formatLessonHint(match.lesson)),
    match,
  };
}

/**
 * The live hook's decision for one pi tool result, against the session corpus.
 * Shared with the eval replay seam so a replayed result takes the same path.
 */
export function decideHintForEvent(
  event: { toolName: string; input?: Record<string, unknown>; content: LessonToolResultContent },
  armed: ReadonlySet<string>,
): HintDecision | null {
  // A search result already is the lesson, framed; a hint on it would re-fire
  // on the Symptom text it quotes and count the same surfacing twice.
  if (event.toolName === LESSONS_SEARCH_TOOL) return null;
  return decideToolResultHint(
    { toolName: event.toolName, input: event.input ?? {}, content: event.content },
    getLessonStore().lessons,
    armed,
  );
}

export function registerLessonHint(pi: ExtensionAPI): void {
  const armed = new Set<string>();
  let turnBudget = MAX_HINTS_PER_TURN;

  // A new session starts with nothing fired and re-reads the corpus, so a
  // lesson added or suppressed since the last one takes effect.
  pi.on("session_start", async () => {
    armed.clear();
    resetAppendedLessonHints();
    resetLessonStore();
    turnBudget = MAX_HINTS_PER_TURN;
  });

  pi.on("turn_start", async () => {
    turnBudget = MAX_HINTS_PER_TURN;
  });

  pi.on("tool_result", async (event) => {
    // Over budget: the lesson stays unarmed, so it can fire on a later turn.
    if (turnBudget <= 0) return;
    const decision = decideHintForEvent(event, armed);
    if (!decision) return;
    armed.add(decision.match.lesson.id);
    turnBudget -= 1;
    recordSurfacing(decision.match, "tool_result");
    return { content: decision.content };
  });
}

/**
 * The /execute note: lessons whose keywords match the wording of the next plan
 * step, as title + "Check first" only. Wrapped, because it is spliced into a
 * prompt Loom sends as the user, and recorded prose must not inherit that
 * authority.
 *
 * Records a surfacing per /execute rather than once per session: the counter
 * measures surfacings, and the model needs the note in every prompt it is
 * sent, not just the first.
 */
export function buildStepLessonNote(stepText: string): string {
  const matches = matchStepText(stepText, getLessonStore().lessons).slice(0, MAX_STEP_LESSONS);
  if (matches.length === 0) return "";

  const rows = matches.map((m) =>
    [
      // Redacted before clipping, for the same reason as the inline hint.
      `- ${collapse(redactLessonText(m.lesson.title))}`,
      `  Check first: ${clip(collapse(redactLessonText(m.lesson.sections.check_first)), MAX_CHECK_FIRST)}`,
      `  Full lesson: lessons_search({ query: "${m.lesson.id}" })`,
    ].join("\n"),
  );
  for (const match of matches) recordSurfacing(match, "execute_prompt");

  return wrapLessons(
    `Recorded lessons whose triggers match the wording of the next step:\n\n${rows.join("\n")}`,
  );
}

/**
 * One lesson, in full. No URL anywhere: the id is enough to find the canonical
 * page, while a link in agent-facing text is a thing to auto-follow. The
 * provenance line is what lets the model weigh the advice -- a draft somebody
 * recorded last week and a reviewed stable lesson are not the same claim.
 */
export function renderFullLesson(lesson: Lesson): string {
  const rows: string[] = [`${lesson.id} -- ${collapse(lesson.title)}`];
  if (lesson.description) rows.push(collapse(lesson.description));

  const section = (name: string, body?: string): void => {
    if (body && body.trim()) rows.push(`## ${name}\n${body.trim()}`);
  };
  section("Symptom", lesson.sections.symptom);
  section("Cause", lesson.sections.cause);
  section("Check first", lesson.sections.check_first);
  section("Intervention", lesson.sections.intervention);
  section("Validate", lesson.sections.validate);
  section("Does NOT apply when", lesson.sections.not_when);

  rows.push(
    [
      `status: ${lesson.status ?? "unstated"}`,
      `stale after: ${lesson.stale_after ?? "unstated"}`,
      lesson.origin === "user"
        ? "source: your own local lessons (not reviewed)"
        : "source: the lesson corpus shipped with Loom",
    ].join(" | "),
  );
  return rows.join("\n\n");
}

/**
 * The search result. Top hit in full, the rest as id + title, so a broad query
 * cannot push a corpus of prose into the context. Anything summarized is one
 * more call away by its id.
 */
export function renderLessonSearchResult(hits: readonly SearchHit[]): string {
  const [top, ...rest] = hits;
  const parts = [renderFullLesson(top.lesson)];
  if (rest.length > 0) {
    parts.push(
      [
        "Also matched -- read one in full by passing its id as the lessons_search query:",
        ...rest.map((h) => `- ${h.lesson.id} -- ${collapse(h.lesson.title)}`),
      ].join("\n"),
    );
  }
  return wrapLessons(parts.join("\n\n"));
}
