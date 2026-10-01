/**
 * Build a lesson document from the fields an agent proposed.
 *
 * The model supplies field VALUES; this module supplies the document -- the
 * key set, the key order, the section order, and every field that establishes
 * provenance or standing. So a proposal cannot arrive already marked `stable`,
 * cannot claim a human wrote or verified it, and cannot mark itself graduated
 * (which would hide it on arrival).
 *
 * What this module deliberately does NOT do is sanitise. It normalises CRLF and
 * trims, and otherwise inserts the model's values verbatim -- a two-line title
 * stays two lines, a non-string stays a non-string. A scrubbing pass here would
 * launder a poisoned draft into one the validator accepts. Compose writes the
 * bytes; validateLessonMarkdown judges them.
 */

import { stringify as stringifyYaml } from "yaml";
import { BODY_SECTIONS, TRIGGER_KEYS } from "../../../shared/lesson-rules.js";

export interface LessonProposalTrigger {
  signatures?: string[];
  tools?: string[];
  mcp_tools?: string[];
  formats?: string[];
  hosts?: string[];
  extensions?: string[];
  step_keywords?: string[];
}

export interface LessonProposalSections {
  symptom: string;
  cause?: string;
  check_first: string;
  intervention: string;
  validate: string;
  not_when: string;
}

export interface LessonProposalSource {
  id: string;
  resource?: string;
  title?: string;
}

/** Exactly what a model may supply. Anything else is ignored by compose. */
export interface LessonProposalInput {
  namespace: string;
  slug: string;
  title: string;
  description: string;
  kind: string;
  stage: string[];
  tags?: string[];
  stale_after: string;
  cues: string;
  applies_to: { versions: string; tested: string };
  evidence: { symptom: string; cause: string; outcome: string; method: string };
  trigger?: LessonProposalTrigger;
  sources?: LessonProposalSource[];
  sections: LessonProposalSections;
}

export interface ComposeMeta {
  /** e.g. "agent:loom/0.8.0". Never taken from the input. */
  generatedBy: string;
  /** YYYY-MM-DD. Never taken from the input. */
  generatedAt: string;
}

/**
 * CRLF would make the line-based validator's view differ from what an editor
 * shows. Anything that is not a string is passed through untouched so the
 * validator reports it as the wrong type instead of compose papering over it.
 */
function text(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : value;
}

function list(value: unknown): unknown {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(text) : value;
}

function pick(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function composeLessonMarkdown(input: LessonProposalInput, meta: ComposeMeta): string {
  const trigger: Record<string, unknown> = {};
  for (const key of TRIGGER_KEYS) trigger[key] = list(pick(input?.trigger, key));

  const sources = Array.isArray(input?.sources)
    ? input.sources.map((source) => {
        const entry: Record<string, unknown> = { id: text(pick(source, "id")) };
        for (const key of ["resource", "title"]) {
          const value = pick(source, key);
          if (value !== undefined) entry[key] = text(value);
        }
        return entry;
      })
    : list(input?.sources);

  // Key ORDER is fixed here, not inherited from the input object, so the model
  // does not decide what a reviewer reads first. Same order as the corpus.
  const frontmatter: Record<string, unknown> = {
    type: "Lesson",
    title: text(input?.title),
    description: text(input?.description),
    tags: list(input?.tags),
    // A local lesson is always a draft. Promotion is a human act in the corpus
    // repo, and nothing on this path can perform it.
    status: "draft",
    generated: { by: meta.generatedBy, at: meta.generatedAt },
    stale_after: text(input?.stale_after),
    sources,
    kind: text(input?.kind),
    stage: list(input?.stage),
    trigger,
    cues: text(input?.cues),
    applies_to: {
      versions: text(pick(input?.applies_to, "versions")),
      tested: text(pick(input?.applies_to, "tested")),
    },
    evidence: {
      symptom: text(pick(input?.evidence, "symptom")),
      cause: text(pick(input?.evidence, "cause")),
      outcome: text(pick(input?.evidence, "outcome")),
      method: text(pick(input?.evidence, "method")),
    },
    // Empty on purpose. A non-empty graduated_to means "do not surface this",
    // and upstream/supersedes are curation decisions; none is the model's to
    // make. `verified` is omitted entirely -- only a human reviewer adds one.
    graduated_to: [],
    upstream: [],
    supersedes: [],
  };

  // lineWidth 0: no folding, so a long title stays on its line. blockQuote
  // false: a multi-line value is written as one escaped double-quoted line,
  // never a block scalar, so no value can put a line of its own -- a `---`
  // that would close the frontmatter early -- into the document. The validator
  // still rejects it as multi-line. No aliases either: the strict loader
  // refuses them, and an alias is a way to show one value and mean another.
  const yaml = stringifyYaml(frontmatter, {
    lineWidth: 0,
    blockQuote: false,
    aliasDuplicateObjects: false,
  }).replace(/\n$/, "");

  const body = BODY_SECTIONS.map((section) => {
    const value = text(pick(input?.sections, section.key));
    if (!section.required && (value === undefined || value === "")) return null;
    // A non-string is written as an empty section, which the validator refuses,
    // rather than stringified into prose that would pass.
    return `## ${section.heading}\n\n${typeof value === "string" ? value : ""}`;
  })
    .filter((block): block is string => block !== null)
    .join("\n\n");

  return `---\n${yaml}\n---\n\n${body}\n`;
}

/**
 * Cap for the draft shown to the user. The preview is only rendered AFTER the
 * validator passed, so it already has no URLs, fences or invisible characters
 * and is under the file cap -- this only keeps a notify readable.
 */
const PREVIEW_MAX = 6000;

export function renderProposalPreview(markdown: string): string {
  if (markdown.length <= PREVIEW_MAX) return markdown;
  return (
    markdown.slice(0, PREVIEW_MAX) +
    `\n\n[... truncated for display; ${markdown.length - PREVIEW_MAX} more characters ...]`
  );
}
