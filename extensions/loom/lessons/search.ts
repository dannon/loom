/**
 * Relevance search over the merged corpus. Pure, in-memory BM25.
 *
 * Not the session index's SQLite FTS5: `better-sqlite3` only loads today
 * behind the session-index experiment flag, while `lessons_search` is
 * default-on. The corpus is tens of documents under 16 KB each, so an on-disk
 * index buys nothing and costs a native module load, a DB file and an
 * invalidation path. What the search needs is what FTS ordered by recency
 * never gave: ranking, a relevance floor so it can ABSTAIN, and determinism on
 * a tie. Revisit if the corpus ever reaches a few thousand entries.
 */

import { isMatchable } from "./matcher";
import type { Lesson } from "./types";

const K1 = 1.5;
const B = 0.75;

const DEFAULT_MAX = 5;
const MAX_QUERY_CHARS = 2_000;

/**
 * A single distinctive term in a small corpus scores roughly 1-2; a term in
 * most documents scores well under 0.5. The absolute floor is what makes
 * "nothing recorded covers this" a real answer rather than the least-bad
 * guess, and the relative floor trims a long tail behind a strong hit.
 */
const DEFAULT_FLOOR = 0.35;
const DEFAULT_RELATIVE = 0.25;

const STOPWORDS = new Set(
  (
    "a an the and or of to in is it for on with as by that this be are was were not no " +
    "do does did when if at from but than then you your my me we us its so up out about " +
    "into over after before any all can will would"
  ).split(" "),
);

export interface SearchHit {
  lesson: Lesson;
  score: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Everything a query can hit. The id joins in as words so "reference index"
 * finds `galaxy-tools/reference-index-not-on-server`, and the trigger literals
 * join in so pasting an error message finds the lesson that fires on it.
 */
export function lessonText(lesson: Lesson): string {
  const t = lesson.trigger ?? {};
  return [
    lesson.id.replace(/[/\-_]+/g, " "),
    lesson.title,
    lesson.description ?? "",
    lesson.sections.symptom,
    lesson.sections.cause ?? "",
    lesson.sections.check_first,
    lesson.sections.intervention,
    lesson.sections.validate,
    lesson.sections.not_when,
    ...(lesson.tags ?? []),
    ...(lesson.kind ? [lesson.kind] : []),
    ...(lesson.stage ?? []),
    ...(t.signatures ?? []),
    ...(t.tools ?? []),
    ...(t.mcp_tools ?? []),
    ...(t.formats ?? []),
    ...(t.extensions ?? []),
    ...(t.step_keywords ?? []),
  ].join(" ");
}

export function searchLessons(
  query: string,
  lessons: readonly Lesson[],
  opts: { max?: number; floor?: number; relative?: number } = {},
): SearchHit[] {
  const max = opts.max ?? DEFAULT_MAX;
  const floor = opts.floor ?? DEFAULT_FLOOR;
  const relative = opts.relative ?? DEFAULT_RELATIVE;

  // A graduated lesson is off every local surface, search included: its advice
  // already ships somewhere the model has been told about.
  const pool = lessons.filter(isMatchable);
  if (pool.length === 0) return [];

  // A hint and a summary line both hand the model an exact id, so that has to
  // resolve to one lesson rather than compete on term overlap.
  const q = query.slice(0, MAX_QUERY_CHARS);
  const exact = pool.find((l) => l.id === q.trim());
  if (exact) return [{ lesson: exact, score: Number.POSITIVE_INFINITY }];

  const terms = new Set(tokenize(q));
  if (terms.size === 0) return [];

  const docs = pool.map((l) => tokenize(lessonText(l)));
  const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const n = docs.length;
  const scored: SearchHit[] = [];
  for (let i = 0; i < docs.length; i++) {
    const tf = new Map<string, number>();
    for (const term of docs[i]) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const seen = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - seen + 0.5) / (seen + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * docs[i].length) / avgdl)));
    }
    if (score > 0) scored.push({ lesson: pool[i], score });
  }
  if (scored.length === 0) return [];

  const best = Math.max(...scored.map((h) => h.score));
  const cut = Math.max(floor, best * relative);
  return scored
    .filter((h) => h.score >= cut)
    .sort(
      (a, b) =>
        b.score - a.score || (a.lesson.id < b.lesson.id ? -1 : a.lesson.id > b.lesson.id ? 1 : 0),
    )
    .slice(0, max);
}
