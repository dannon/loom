export type LessonNamespace = "stats" | "reproduction" | "data" | "galaxy-tools" | "galaxy-api";
export type ProposableNamespace = "stats" | "reproduction" | "data" | "galaxy-tools";
export type LessonKind = "pitfall" | "expectation" | "choice" | "source-quirk" | "reproduction";
export type LessonStage =
  | "data-acquisition"
  | "metadata-reconciliation"
  | "tool-parameterization"
  | "job-execution"
  | "result-interpretation";
export type LessonStatus = "draft" | "stable" | "deprecated";
export type LessonSectionKey =
  "symptom" | "cause" | "check_first" | "intervention" | "validate" | "not_when";

export declare const NAMESPACES: readonly LessonNamespace[];
export declare const STATUSES: readonly LessonStatus[];
export declare const KINDS: readonly LessonKind[];
export declare const STAGES: readonly LessonStage[];
export declare const EVIDENCE: {
  readonly symptom: readonly string[];
  readonly cause: readonly string[];
  readonly outcome: readonly string[];
};
export declare const REQUIRED_KEYS: readonly string[];
export declare const OPTIONAL_KEYS: readonly string[];
export declare const TRIGGER_KEYS: readonly string[];
/** Body sections in order; `heading` includes the leading `## `. */
export declare const SECTIONS: readonly {
  heading: string;
  key: LessonSectionKey;
  required: boolean;
}[];
export declare const LIMITS: {
  readonly slug: number;
  readonly title: number;
  readonly description: number;
  readonly tag: number;
  readonly cues: number;
  readonly signature: number;
  readonly tool: number;
  readonly mcpTool: number;
  readonly format: number;
  readonly host: number;
  readonly extension: number;
  readonly stepKeyword: number;
  readonly appliesTo: number;
  readonly method: number;
  readonly sourceId: number;
  readonly sourceText: number;
  readonly freeText: number;
  readonly section: number;
  readonly listItems: number;
  readonly minSignature: number;
  readonly fileBytes: number;
};
export declare const UNKNOWN_SIGNATURE: string;

export declare const LESSON_NAMESPACES: readonly LessonNamespace[];
export declare const PROPOSABLE_NAMESPACES: readonly ProposableNamespace[];
export declare const LESSON_KINDS: readonly LessonKind[];
export declare const LESSON_STAGES: readonly LessonStage[];
export declare const LESSON_STATUSES: readonly LessonStatus[];
export declare const EVIDENCE_SYMPTOM: readonly string[];
export declare const EVIDENCE_CAUSE: readonly string[];
export declare const EVIDENCE_OUTCOME: readonly string[];
/** Body sections in order; `heading` is the bare text, e.g. "Check first". */
export declare const BODY_SECTIONS: readonly {
  heading: string;
  key: LessonSectionKey;
  required: boolean;
}[];
export declare const FRONTMATTER_KEYS: readonly string[];
export declare const REQUIRED_FRONTMATTER_KEYS: readonly string[];

export declare const MAX_FILE_BYTES: number;
export declare const MAX_TITLE: number;
export declare const MAX_DESCRIPTION: number;
export declare const MAX_SECTION: number;
export declare const MAX_CUES: number;
export declare const MAX_METHOD: number;
export declare const MAX_SIGNATURE: number;
export declare const MIN_SIGNATURE: number;
export declare const MAX_TRIGGER_ITEM: number;
export declare const MAX_TRIGGER_ITEMS: number;
export declare const MAX_TAG: number;
export declare const MAX_TAGS: number;
export declare const MAX_SOURCES: number;
export declare const MAX_VERIFIED: number;
export declare const MAX_GENERIC_STRING: number;
export declare const MAX_SLUG: number;

export type LessonSections = Partial<Record<LessonSectionKey, string>>;

export interface ParsedLesson {
  frontmatter: Record<string, unknown> | null;
  sections: LessonSections;
  /** 1-based source line for each top-level frontmatter key and each section key. */
  lines: Record<string, number>;
  /** Structural failures that stopped the parse; empty when it parsed. */
  errors: string[];
}

export declare function parseLesson(text: string): ParsedLesson;
export declare function isValidLessonNamespace(value: unknown): boolean;
export declare function isValidLessonSlug(value: unknown): boolean;
export declare function lessonIdFromPath(relPath: string): string | null;

export type LessonValidation = { ok: true } | { ok: false; errors: string[] };
/** Errors are `"<line>: <message>"`. */
export declare function validateLessonMarkdown(text: string): LessonValidation;
/** Corpus form: `relPath` is `<namespace>/<slug>.md`; lines are `path:line: message`. */
export declare function validateLessonFile(relPath: string, raw: string): string[];

export declare function normalizeSignature(text: unknown): string;
/**
 * The corpus validator's own checks, imported from lessons/validate.mjs. Each
 * returns `"<where> contains <what>"` messages (or `"<where> is too long to
 * check"`); an empty list means the text passed.
 */
export declare function markupProblems(text: string, where: string): string[];
export declare function identifyingProblems(text: string, where: string): string[];
/** For a field that may hold a link: one canonical https URL to a LINK_HOSTS host. */
export declare function linkProblems(link: string, where: string): string[];
export declare const LINK_HOSTS: readonly string[];
export declare function loadFrontmatter(fmText: string): {
  value: unknown;
  problems: string[];
};
export declare function isIsoDate(value: unknown): boolean;
export declare function splitFrontmatter(text: string): {
  fmText: string;
  fmLines: string[];
  fmFirstLine: number;
  body: string;
  bodyFirstLine: number;
} | null;
export declare function parseSections(
  body: string,
  bodyFirstLine?: number,
): {
  found: {
    spec: { heading: string; key: LessonSectionKey; required: boolean };
    index: number;
    line: number;
  }[];
  unexpected: { text: string; line: number }[];
  sections: Partial<Record<LessonSectionKey, { text: string; line: number }>>;
};
