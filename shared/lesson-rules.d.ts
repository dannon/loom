export type LessonNamespace = "stats" | "reproduction" | "data" | "galaxy-tools" | "galaxy-api";
export type LessonSectionKey =
  "symptom" | "cause" | "check_first" | "intervention" | "validate" | "not_when";

export declare const LESSON_NAMESPACES: readonly LessonNamespace[];
export declare const BODY_SECTIONS: readonly {
  heading: string;
  key: LessonSectionKey;
  required: boolean;
}[];

export type LessonSections = Partial<Record<LessonSectionKey, string>>;

export interface ParsedLesson {
  frontmatter: Record<string, unknown> | null;
  sections: LessonSections;
  /** 1-based source line for each frontmatter key and each section key. */
  lines: Record<string, number>;
  /** Structural failures that stopped the parse; empty when it parsed. */
  errors: string[];
}

export declare function parseLesson(text: string): ParsedLesson;

export type LessonValidation = { ok: true } | { ok: false; errors: string[] };
export declare function validateLessonMarkdown(text: string): LessonValidation;
