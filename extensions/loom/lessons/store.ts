/**
 * Where lessons come from.
 *
 * Two tiers, merged at read time: the corpus shipped in the package
 * (`lessons/snapshot.json`) and the user's own `~/.loom/lessons/<ns>/<slug>.md`.
 * Retrieval is entirely local by design -- a remote query would leak what the
 * user is working on every turn, whether or not they ever contribute anything.
 *
 * Both tiers are read defensively. The snapshot is reviewed content, but it is
 * still bytes on disk that a packaging regression or a newer release can have
 * changed shape, and a session must not die because a field drifted. The
 * user-local tier is not reviewed at all.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config";
import { LESSON_NAMESPACES } from "../../../shared/lesson-rules.js";
import { isLessonsEnabled } from "./enabled";
import { syncSuppressedFlags } from "./counters";
import { userLessonsDir } from "./user-dir";
import type { Lesson } from "./types";
import { parseUserLesson } from "./user-lesson";

/** The only snapshot schema this release understands (C4). */
export const LESSONS_SCHEMA = 1;

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

const LESSON_ID = new RegExp(
  `^(?:${LESSON_NAMESPACES.join("|")})/(?=.{1,80}$)[a-z0-9]+(?:-[a-z0-9]+)*$`,
);
// The schema caps a lesson file at 16 KB; this only bounds the read.
const MAX_USER_FILE_BYTES = 64 * 1024;
const MAX_USER_FILES = 200;

/**
 * `lessons/snapshot.json` at the package root. Three levels up from this
 * module is the root in the repo, in the npm tarball and in the Orbit bundle,
 * the same resolution `vendor-skills.ts` uses for the vendored skills tree.
 */
export function packageSnapshotPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "lessons", "snapshot.json");
}

/**
 * Uncapped on purpose: a snapshot entry already went through the authoring
 * gate, so capping again here would silently truncate reviewed content.
 */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

/**
 * One snapshot entry -> a `Lesson`, or null when it is not usable. Null for a
 * bad entry (rather than throwing, or coercing) keeps one broken lesson from
 * taking the corpus down with it.
 */
export function snapshotEntryToLesson(raw: unknown): Lesson | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  // The id is rendered into hints and written to the activity log and the
  // counters file, so it has to be exactly <namespace>/<slug>.
  if (typeof o.id !== "string" || !LESSON_ID.test(o.id)) return null;
  if (typeof o.title !== "string" || !o.title.trim()) return null;

  const s = o.sections;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const sec = s as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const required = ["symptom", "check_first", "intervention", "validate", "not_when"] as const;
  if (required.some((k) => !str(sec[k]).trim())) return null;

  const trig = (
    o.trigger && typeof o.trigger === "object" && !Array.isArray(o.trigger) ? o.trigger : {}
  ) as Record<string, unknown>;

  return {
    id: o.id,
    title: o.title.trim(),
    description: typeof o.description === "string" ? o.description : undefined,
    tags: stringList(o.tags),
    status:
      o.status === "draft" || o.status === "stable" || o.status === "deprecated"
        ? o.status
        : undefined,
    stale_after: typeof o.stale_after === "string" ? o.stale_after : undefined,
    kind: typeof o.kind === "string" ? o.kind : undefined,
    stage: stringList(o.stage),
    cues: typeof o.cues === "string" ? o.cues : undefined,
    graduated_to: stringList(o.graduated_to),
    supersedes: stringList(o.supersedes),
    trigger: {
      signatures: stringList(trig.signatures),
      tools: stringList(trig.tools),
      mcp_tools: stringList(trig.mcp_tools),
      formats: stringList(trig.formats),
      hosts: stringList(trig.hosts),
      extensions: stringList(trig.extensions),
      step_keywords: stringList(trig.step_keywords),
    },
    sections: {
      symptom: str(sec.symptom),
      cause: str(sec.cause) || undefined,
      check_first: str(sec.check_first),
      intervention: str(sec.intervention),
      validate: str(sec.validate),
      not_when: str(sec.not_when),
    },
    origin: "package",
  };
}

/**
 * The shipped corpus. A missing file is NOT a warning: a dev checkout before
 * `npm run build:lessons` has none, and the user-local tier works on its own.
 * Warnings name the file by basename only -- they go to stderr, and a full
 * path there is a home directory in a log.
 */
export function loadPackageLessons(file: string = packageSnapshotPath()): {
  lessons: Lesson[];
  warnings: string[];
} {
  const label = path.basename(file);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lessons: [], warnings: [] };
  }
  if (size > MAX_SNAPSHOT_BYTES) {
    return {
      lessons: [],
      warnings: [`${label}: larger than ${MAX_SNAPSHOT_BYTES} bytes -- ignored`],
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { lessons: [], warnings: [`${label}: not valid JSON -- ignored`] };
  }
  const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (o.schema !== LESSONS_SCHEMA) {
    const got = typeof o.schema === "number" ? String(o.schema) : typeof o.schema;
    return {
      lessons: [],
      warnings: [`${label}: schema ${got} is not ${LESSONS_SCHEMA} -- ignored`],
    };
  }
  if (!Array.isArray(o.lessons)) {
    return { lessons: [], warnings: [`${label}: no lessons array -- ignored`] };
  }

  const lessons: Lesson[] = [];
  const warnings: string[] = [];
  for (const raw of o.lessons) {
    const lesson = snapshotEntryToLesson(raw);
    if (lesson) lessons.push(lesson);
    else warnings.push(`${label}: skipped a malformed lesson entry`);
  }
  return { lessons, warnings };
}

/**
 * `<state dir>/lesson-drafts/`, where the /lesson command keeps a draft the
 * user has not accepted, is a sibling of the default `userLessonsDir()`, so the
 * namespace walk below never sees it and an unaccepted draft can never reach
 * the model.
 */
export { userLessonsDir };

// The switch lives in ./enabled so observations-config can read it without
// pulling this loader in; re-exported because every lesson surface reads it here.
export { isLessonsEnabled };

/** `lessons.suppress` from the config -- the only authority on suppression. */
export function suppressedIds(): string[] {
  const cfg = loadConfig() as { lessons?: { suppress?: unknown } };
  const list = cfg.lessons?.suppress;
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
}

/**
 * `<dir>/<namespace>/<slug>.md` for each of C3's five namespaces, in id order.
 * A walk of named directories rather than a glob, which buys three things:
 *
 * - a local id is always `<namespace>/<slug>`, the same id space the snapshot
 *   uses, which is the only reason the curated-wins collision rule means
 *   anything;
 * - `counters.json` at the top of the dir is never a candidate;
 * - a file dropped at the top level is ignored rather than admitted under a
 *   bare id that could never collide with a curated one.
 *
 * Symlinks are not followed, for either a file or a namespace directory: a link
 * dropped in here would otherwise turn any readable file on the machine into
 * agent-facing text.
 */
export function listUserLessonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const namespace of [...LESSON_NAMESPACES].sort()) {
    if (out.length >= MAX_USER_FILES) break;
    const nsDir = path.join(dir, namespace);
    let entries: fs.Dirent[];
    try {
      if (!fs.lstatSync(nsDir).isDirectory()) continue;
      entries = fs.readdirSync(nsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= MAX_USER_FILES) break;
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      out.push(path.join(nsDir, entry.name));
    }
  }
  return out;
}

/** C3's slug rule. The walk only guarantees the namespace half of an id. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 80;

/**
 * The schema's longest legitimate line is a few hundred characters, and some
 * identifying-data checks cost time quadratic in line length. Refusing long
 * lines before validating, plus a budget on the whole tier, keeps a directory
 * of hostile files from stalling the first tool result of every session.
 */
const MAX_USER_LINE_CHARS = 1000;
const MAX_USER_TOTAL_BYTES = 512 * 1024;

/** "28: unexpected heading ..." -> 28. Everything after the line number may quote the file. */
function violationLines(errors: readonly string[]): string {
  const lines = [...new Set(errors.map((e) => /^(\d+):/.exec(e)?.[1]).filter(Boolean))];
  return lines.length > 0 ? ` (lines ${lines.slice(0, 5).join(", ")})` : "";
}

/**
 * The user-local tier. An invalid file is skipped with a warning, never fatal.
 *
 * Warnings go to stderr, so they carry the lesson id, a rule count and line
 * numbers -- never the path (the user's home), never a file name that failed
 * the slug rule (it is attacker-chosen text), and never a rule message, since
 * those quote the offending content back. The lesson validator prints the
 * full messages for anyone fixing the file.
 */
export function loadUserLessons(dir: string): { lessons: Lesson[]; warnings: string[] } {
  const lessons: Lesson[] = [];
  const warnings: string[] = [];
  let budget = MAX_USER_TOTAL_BYTES;
  for (const file of listUserLessonFiles(dir)) {
    const namespace = path.basename(path.dirname(file));
    const slug = path.basename(file).replace(/\.md$/, "");
    if (!SLUG.test(slug) || slug.length > MAX_SLUG) {
      // The id goes into the hint, the activity log and counters.json, so a
      // name that is not a slug never becomes one.
      warnings.push(`${namespace}: skipped a file whose name is not a lesson slug`);
      continue;
    }
    const id = `${namespace}/${slug}`;
    let raw: string;
    try {
      // fstat on the opened descriptor, so the file checked is the file read.
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) {
          warnings.push(`${id}: not a regular file -- skipped`);
          continue;
        }
        if (st.size > MAX_USER_FILE_BYTES) {
          warnings.push(`${id}: larger than ${MAX_USER_FILE_BYTES} bytes -- skipped`);
          continue;
        }
        if (st.size > budget) {
          warnings.push(`${id}: local lessons exceed ${MAX_USER_TOTAL_BYTES} bytes -- stopped`);
          break;
        }
        budget -= st.size;
        raw = fs.readFileSync(fd, "utf-8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      warnings.push(`${id}: unreadable -- skipped`);
      continue;
    }
    if (raw.split("\n").some((line) => line.length > MAX_USER_LINE_CHARS)) {
      warnings.push(`${id}: a line is longer than ${MAX_USER_LINE_CHARS} characters -- skipped`);
      continue;
    }
    const parsed = parseUserLesson(id, raw);
    if (!parsed.ok) {
      const n = parsed.errors.length;
      warnings.push(
        `${id}: skipped -- ${n} schema violation${n === 1 ? "" : "s"}${violationLines(parsed.errors)}`,
      );
      continue;
    }
    // The corpus validator's one path-derived content rule: galaxy-api is
    // where graduated lessons live, and graduated_to is what keeps them quiet.
    if (namespace === "galaxy-api" && !(parsed.lesson.graduated_to ?? []).length) {
      warnings.push(`${id}: skipped -- a galaxy-api lesson must name where it graduated to`);
      continue;
    }
    lessons.push(parsed.lesson);
  }
  return { lessons, warnings };
}

/**
 * Editorial status and freshness, judged as of today (UTC). The snapshot was
 * filtered as of its own build date, so a lesson can have gone stale since. A
 * missing or malformed `stale_after` counts as stale: the schema requires it,
 * and an entry without one is a shape this release does not trust.
 */
export function isFresh(lesson: Lesson, now: Date): boolean {
  if (lesson.status === "deprecated") return false;
  const when = lesson.stale_after ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) return false;
  return when >= now.toISOString().slice(0, 10);
}

export interface LessonStore {
  lessons: Lesson[];
  /** Per-file read/validation problems, for the session log. */
  warnings: string[];
  /** Local files that tried to reuse a curated id. */
  conflicts: string[];
}

/**
 * The merged corpus. Every source is an option, so the merge policy is
 * testable without touching config or $HOME.
 *
 * Curated wins on an id collision. A silent local override would let a file
 * quietly replace reviewed advice under its own id; the escape hatch for "that
 * curated lesson is wrong for me" is `lessons.suppress`, not a shadow file.
 */
export function loadLessonStore(
  opts: { dir?: string; snapshotFile?: string; suppress?: string[]; now?: Date } = {},
): LessonStore {
  const now = opts.now ?? new Date();
  const suppress = new Set(opts.suppress ?? []);

  const pkg = loadPackageLessons(opts.snapshotFile);
  const user = loadUserLessons(opts.dir ?? userLessonsDir());
  const warnings = [...pkg.warnings, ...user.warnings];
  const conflicts: string[] = [];

  const byId = new Map<string, Lesson>();
  for (const lesson of pkg.lessons) byId.set(lesson.id, lesson);
  for (const lesson of user.lessons) {
    if (byId.has(lesson.id)) {
      conflicts.push(
        `${lesson.id}: a local lesson shadows a curated one and was ignored -- ` +
          `rename it, or suppress the curated id in lessons.suppress`,
      );
      continue;
    }
    byId.set(lesson.id, lesson);
  }

  const lessons = [...byId.values()]
    .filter((l) => !suppress.has(l.id))
    .filter((l) => isFresh(l, now))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { lessons, warnings, conflicts };
}

let cached: LessonStore | null = null;
const EMPTY_STORE: LessonStore = Object.freeze({
  lessons: [],
  warnings: [],
  conflicts: [],
}) as LessonStore;

/**
 * The session-level corpus. Loaded once: a lesson edited mid-session takes
 * effect next session, the same deal the skills catalog gives, and every
 * surface in a turn agrees about what the corpus is.
 */
export function getLessonStore(): LessonStore {
  // The switch is read every time, ahead of the cache: a config edit or an
  // env flip to off mid-session must silence every surface at once, not on
  // the next restart.
  if (!isLessonsEnabled()) return EMPTY_STORE;
  if (cached) return cached;
  const suppress = suppressedIds();
  cached = loadLessonStore({ suppress });
  syncSuppressedFlags(suppress);
  for (const line of [...cached.warnings, ...cached.conflicts]) {
    // stderr, so a `--mode json` consumer's stdout stays clean.
    console.error(`[loom lessons] ${line}`);
  }
  return cached;
}

export function resetLessonStore(): void {
  cached = null;
}
