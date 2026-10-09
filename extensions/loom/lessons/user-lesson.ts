/**
 * One user-local lesson file -> one `Lesson`.
 *
 * Holds no rules. `shared/lesson-rules.js` is the single implementation of C3,
 * so a file the authoring gate would reject can never be a file the reader
 * accepts. This module validates, parses, and maps -- adding the `id` the
 * store derived from the file's path and `origin: "user"`, neither of which is
 * in the file.
 *
 * Any violation refuses the whole file. Trimming an over-long section or
 * dropping an unknown trigger field would hand the model a lesson its author
 * never wrote, which is worse than one lesson missing.
 */

import { parseLesson, validateLessonMarkdown } from "../../../shared/lesson-rules.js";
import type { Lesson, LessonTrigger } from "./types";

export type ParseResult = { ok: true; lesson: Lesson } | { ok: false; errors: string[] };

const TRIGGER_FIELDS: readonly (keyof LessonTrigger)[] = [
  "signatures",
  "tools",
  "mcp_tools",
  "formats",
  "hosts",
  "extensions",
  "step_keywords",
];

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

function readTrigger(value: unknown): LessonTrigger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: LessonTrigger = {};
  for (const field of TRIGGER_FIELDS) {
    const list = stringList(raw[field]);
    if (list) out[field] = list;
  }
  return out;
}

export function parseUserLesson(id: string, raw: string): ParseResult {
  const verdict = validateLessonMarkdown(raw);
  if (!verdict.ok) return { ok: false, errors: verdict.errors };

  const parsed = parseLesson(raw);
  // Unreachable after a passing validation, but a silent null here would be a
  // crash later rather than a skipped file now.
  if (!parsed.frontmatter || parsed.errors.length > 0) {
    return { ok: false, errors: parsed.errors.length > 0 ? parsed.errors : ["unparseable"] };
  }

  const fm = parsed.frontmatter;
  const s = parsed.sections;
  const status = fm.status;
  return {
    ok: true,
    lesson: {
      id,
      title: String(fm.title).trim(),
      description: typeof fm.description === "string" ? fm.description.trim() : undefined,
      tags: stringList(fm.tags),
      status:
        status === "draft" || status === "stable" || status === "deprecated" ? status : undefined,
      stale_after: typeof fm.stale_after === "string" ? fm.stale_after : undefined,
      kind: typeof fm.kind === "string" ? fm.kind : undefined,
      stage: stringList(fm.stage),
      cues: typeof fm.cues === "string" ? fm.cues : undefined,
      graduated_to: stringList(fm.graduated_to),
      supersedes: stringList(fm.supersedes),
      trigger: readTrigger(fm.trigger),
      sections: {
        symptom: s.symptom ?? "",
        cause: s.cause || undefined,
        check_first: s.check_first ?? "",
        intervention: s.intervention ?? "",
        validate: s.validate ?? "",
        not_when: s.not_when ?? "",
      },
      origin: "user",
    },
  };
}
