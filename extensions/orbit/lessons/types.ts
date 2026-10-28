/**
 * The lesson shape the matcher reads.
 *
 * A subset mirror of C4's `Lesson`, not a re-declaration of all of C3: the
 * snapshot round-trips every authoring field, and this module names only the
 * ones the matcher, the renderers and the search index actually touch.
 * Everything optional is optional because a snapshot built by a newer Loom may
 * add or drop fields this one has never heard of.
 */

/** Machine-matchable trigger fields. `cues` is prose and is never matched. */
export interface LessonTrigger {
  /** Literal, normalized error/outcome signatures. */
  signatures?: string[];
  /** Galaxy tool ids or families. */
  tools?: string[];
  /** `galaxy_*` MCP tool names, matched against the normalized tool name. */
  mcp_tools?: string[];
  /** Galaxy datatype names / extensions. */
  formats?: string[];
  /** Hostnames seen in URLs in the call's arguments. */
  hosts?: string[];
  /** File extensions seen in the call's arguments, e.g. ".gtf". */
  extensions?: string[];
  /** Lowercase words matched whole against plan-step text. */
  step_keywords?: string[];
}

export interface LessonSections {
  symptom: string;
  cause?: string;
  check_first: string;
  intervention: string;
  validate: string;
  not_when: string;
}

export interface Lesson {
  /** Path under `lessons/` minus `.md`, e.g. "stats/na-coerced-to-zero-in-filters". */
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  status?: "draft" | "stable" | "deprecated";
  stale_after?: string;
  kind?: string;
  stage?: string[];
  cues?: string;
  /** Non-empty means the advice ships somewhere else: never surfaced locally. */
  graduated_to?: string[];
  supersedes?: string[];
  trigger?: LessonTrigger;
  sections: LessonSections;
  /** Set by the store, not by the corpus. Drives the ranking tiebreak. */
  origin?: "package" | "user";
}

/** C5's `trigger` values, verbatim. */
export type MatchTrigger = "signature" | "tool" | "host" | "extension" | "step_keyword" | "search";

/** C5's `surface` values, verbatim. */
export type SurfaceKind = "tool_result" | "execute_prompt" | "context";

export interface Match {
  lesson: Lesson;
  trigger: MatchTrigger;
  /** The literal that matched. For tests and debugging; never in the C5 payload. */
  matched: string;
}
