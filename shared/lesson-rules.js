/**
 * The brain's view of the C3 lesson schema. The rules themselves live in
 * `lessons/validate.mjs`; this module imports them and adds only what the
 * proposal flow needs on top: a parser that never throws, validation of bytes
 * that have no path yet, and the id/namespace helpers.
 *
 * Nothing here re-implements a check. The schema is a security boundary -- a
 * proposal's draft is assembled from session content that may include hostile
 * tool output -- and a second copy of a markup or identifying-data rule is a
 * copy that falls behind the first time the corpus validator is tightened.
 *
 * Dual-file (.js runtime + hand-written .d.ts) like shared/feedback-contract.js.
 * UNLIKE that file this one pulls in `node:fs`, `yaml` and `marked` through
 * the validator, so it is Node/brain side only: never import it from
 * app/src/renderer.
 */

import {
  EVIDENCE,
  KINDS,
  LIMITS,
  NAMESPACES,
  OPTIONAL_KEYS,
  REQUIRED_KEYS,
  SECTIONS,
  STAGES,
  STATUSES,
  loadFrontmatter,
  parseSections,
  splitFrontmatter,
  validateLessonFile,
} from "../lessons/validate.mjs";

export {
  EVIDENCE,
  KINDS,
  LIMITS,
  LINK_HOSTS,
  NAMESPACES,
  OPTIONAL_KEYS,
  REQUIRED_KEYS,
  SECTIONS,
  STAGES,
  STATUSES,
  TRIGGER_KEYS,
  UNKNOWN_SIGNATURE,
  identifyingProblems,
  isIsoDate,
  linkProblems,
  loadFrontmatter,
  markupProblems,
  normalizeSignature,
  parseSections,
  splitFrontmatter,
  validateLessonFile,
} from "../lessons/validate.mjs";

/**
 * Parse a lesson into its frontmatter and body sections. Never throws: a
 * structural failure (no frontmatter, YAML the strict loader refuses, a
 * frontmatter that is not a mapping, a file over the byte cap) comes back as
 * `frontmatter: null` with `"<line>: <message>"` entries in `errors`.
 *
 * This is a parser, not the validator. A lesson that parses can still break
 * every content rule; callers that act on a lesson run validateLessonMarkdown
 * (or validateLessonFile) first.
 */
export function parseLesson(raw) {
  const empty = { frontmatter: null, sections: {}, lines: {}, errors: [] };
  if (typeof raw !== "string") return { ...empty, errors: ["1: lesson is not text"] };
  // Before the YAML parse, so a planted huge file costs one byte count.
  if (Buffer.byteLength(raw, "utf8") > LIMITS.fileBytes) {
    return { ...empty, errors: [`1: file is over ${LIMITS.fileBytes} bytes`] };
  }
  const text = raw.replace(/\r\n/g, "\n");
  const split = splitFrontmatter(text);
  if (!split) return { ...empty, errors: ["1: missing YAML frontmatter"] };
  let loaded;
  try {
    loaded = loadFrontmatter(split.fmText);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return {
      ...empty,
      errors: [`${split.fmFirstLine}: frontmatter is not valid YAML: ${message}`],
    };
  }
  if (loaded.problems.length > 0) {
    return { ...empty, errors: loaded.problems.map((p) => `${split.fmFirstLine}: ${p}`) };
  }
  const frontmatter = loaded.value;
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return { ...empty, errors: [`${split.fmFirstLine}: frontmatter must be a YAML mapping`] };
  }

  const lines = {};
  for (const key of Object.keys(frontmatter)) {
    const i = split.fmLines.findIndex((line) => line.startsWith(`${key}:`));
    lines[key] = i === -1 ? split.fmFirstLine : split.fmFirstLine + i;
  }
  const { sections: found } = parseSections(split.body, split.bodyFirstLine);
  const sections = {};
  for (const spec of SECTIONS) {
    if (found[spec.key] === undefined) continue;
    sections[spec.key] = found[spec.key].text;
    lines[spec.key] = found[spec.key].line;
  }
  return { frontmatter, sections, lines, errors: [] };
}

// A proposal has no path until it is saved, and the corpus validator only
// judges a path-bearing file. The stand-in is a proposable namespace and a
// valid slug, so the path checks pass and every content rule runs unchanged;
// the caller checks the real namespace and slug itself. The galaxy-api
// graduation rule is the one path-dependent content rule, and a proposal can
// never land in galaxy-api.
const STAND_IN_PATH = "stats/proposal.md";

/**
 * Validate a lesson's bytes with no path attached -- a proposal before it has
 * been written anywhere. Errors are `"<line>: <message>"`. Run it on exactly
 * the bytes that will be shown and saved: a check on anything upstream of
 * those (the structured input, a sanitised copy) checks the wrong thing.
 */
export function validateLessonMarkdown(text) {
  if (typeof text !== "string") return { ok: false, errors: ["1: lesson is not text"] };
  const prefix = `${STAND_IN_PATH}:`;
  const errors = validateLessonFile(STAND_IN_PATH, text).map((v) =>
    v.startsWith(prefix) ? v.slice(prefix.length) : v,
  );
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// The names the brain side uses. Aliases of the validator's tables rather
// than second copies, so a bound changes in exactly one place.
export const LESSON_NAMESPACES = NAMESPACES;
/**
 * `galaxy-api` holds lessons that graduated upstream and are kept unsurfaced,
 * so a new proposal can never land there -- it would be hidden on arrival.
 */
export const PROPOSABLE_NAMESPACES = NAMESPACES.filter((ns) => ns !== "galaxy-api");
export const LESSON_KINDS = KINDS;
export const LESSON_STAGES = STAGES;
export const LESSON_STATUSES = STATUSES;
export const EVIDENCE_SYMPTOM = EVIDENCE.symptom;
export const EVIDENCE_CAUSE = EVIDENCE.cause;
export const EVIDENCE_OUTCOME = EVIDENCE.outcome;
/** SECTIONS with the bare heading text, for code that writes a body. */
export const BODY_SECTIONS = SECTIONS.map((s) => ({
  heading: s.heading.replace(/^## /, ""),
  key: s.key,
  required: s.required,
}));
export const FRONTMATTER_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
export const REQUIRED_FRONTMATTER_KEYS = REQUIRED_KEYS;

export const MAX_FILE_BYTES = LIMITS.fileBytes;
export const MAX_TITLE = LIMITS.title;
export const MAX_DESCRIPTION = LIMITS.description;
export const MAX_SECTION = LIMITS.section;
export const MAX_CUES = LIMITS.cues;
export const MAX_METHOD = LIMITS.method;
export const MAX_SIGNATURE = LIMITS.signature;
export const MIN_SIGNATURE = LIMITS.minSignature;
export const MAX_TRIGGER_ITEM = LIMITS.tool;
export const MAX_TRIGGER_ITEMS = LIMITS.listItems;
export const MAX_TAG = LIMITS.tag;
export const MAX_TAGS = LIMITS.listItems;
export const MAX_SOURCES = LIMITS.listItems;
export const MAX_VERIFIED = LIMITS.listItems;
export const MAX_GENERIC_STRING = LIMITS.freeText;
export const MAX_SLUG = LIMITS.slug;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidLessonNamespace(value) {
  return typeof value === "string" && NAMESPACES.includes(value);
}

export function isValidLessonSlug(value) {
  return typeof value === "string" && value.length <= LIMITS.slug && SLUG_RE.test(value);
}

/**
 * `stats/na-coerced-to-zero-in-filters.md` -> `stats/na-coerced-to-zero-in-filters`.
 * Null for anything that is not exactly `<namespace>/<slug>.md`: a deeper path,
 * a `..` segment, an unknown namespace, a non-slug basename. Windows separators
 * are accepted so a win32 `path.relative` resolves the same.
 */
export function lessonIdFromPath(relPath) {
  if (typeof relPath !== "string") return null;
  const parts = relPath.split(/[\\/]/);
  if (parts.length !== 2) return null;
  const [namespace, file] = parts;
  if (!isValidLessonNamespace(namespace) || !file.endsWith(".md")) return null;
  const slug = file.slice(0, -3);
  return isValidLessonSlug(slug) ? `${namespace}/${slug}` : null;
}
