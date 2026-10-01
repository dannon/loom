/**
 * Where local lessons and staged drafts live on disk.
 *
 * Two placements carry weight:
 *
 * - Lessons go under getConfigDir(), which is ~/.loom today and ~/.orbit after
 *   the rename (shared/state-dir.js). Nothing here joins homedir() with
 *   ".loom" itself, so the move stays one switch.
 * - Staged drafts go in a SIBLING directory, not inside lessons/. A draft the
 *   user has not approved must not be loadable as a lesson, and a separate
 *   directory guarantees that without the lesson store having to know the
 *   difference. The flat `<namespace>__<slug>.md` name also cannot satisfy
 *   lessonIdFromPath, which requires exactly `<namespace>/<slug>.md`.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getConfigDir } from "../../../shared/loom-config.js";
import {
  LESSON_NAMESPACES,
  MAX_FILE_BYTES,
  isValidLessonNamespace,
  isValidLessonSlug,
  lessonIdFromPath,
} from "../../../shared/lesson-rules.js";

export interface LocalLesson {
  id: string;
  namespace: string;
  slug: string;
  path: string;
}

export function lessonsDir(): string {
  return path.join(getConfigDir(), "lessons");
}

export function draftsDir(): string {
  return path.join(getConfigDir(), "lesson-drafts");
}

/**
 * Throws rather than returning null: every caller has already validated, so a
 * bad value here means a check was skipped, and building a path anyway would
 * be a traversal write.
 */
function assertId(namespace: string, slug: string): void {
  if (!isValidLessonNamespace(namespace)) {
    throw new Error(`not a lesson namespace: ${JSON.stringify(namespace)}`);
  }
  if (!isValidLessonSlug(slug)) {
    throw new Error(`not a lesson slug: ${JSON.stringify(slug)}`);
  }
}

export function lessonFilePath(namespace: string, slug: string): string {
  assertId(namespace, slug);
  return path.join(lessonsDir(), namespace, `${slug}.md`);
}

export function draftFilePath(namespace: string, slug: string): string {
  assertId(namespace, slug);
  return path.join(draftsDir(), `${namespace}__${slug}.md`);
}

/** Split `<namespace>/<slug>` into its parts, or null if it is not a lesson id. */
export function parseLessonId(raw: unknown): { namespace: string; slug: string } | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split("/");
  if (parts.length !== 2) return null;
  const [namespace, slug] = parts;
  if (!isValidLessonNamespace(namespace) || !isValidLessonSlug(slug)) return null;
  return { namespace, slug };
}

export function listLocalLessons(): LocalLesson[] {
  const root = lessonsDir();
  const out: LocalLesson[] = [];
  for (const namespace of LESSON_NAMESPACES) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, namespace), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // isFile() is false for a symlink, so a link planted in the lessons
      // tree can't point the reader at some other file.
      if (!entry.isFile()) continue;
      const id = lessonIdFromPath(`${namespace}/${entry.name}`);
      if (!id) continue;
      out.push({
        id,
        namespace,
        slug: entry.name.slice(0, -3),
        path: path.join(root, namespace, entry.name),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function listDrafts(): LocalLesson[] {
  const root = draftsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LocalLesson[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const parts = entry.name.slice(0, -3).split("__");
    if (parts.length !== 2) continue;
    const [namespace, slug] = parts;
    if (!isValidLessonNamespace(namespace) || !isValidLessonSlug(slug)) continue;
    out.push({ id: `${namespace}/${slug}`, namespace, slug, path: path.join(root, entry.name) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export type ReadResult = { ok: true; text: string } | { ok: false; detail: string };

/**
 * Read a lesson or draft, refusing anything over the schema's byte cap or that
 * is not a regular file. lstat rather than stat so a symlink is refused rather
 * than followed, and the cap is checked before the read so a planted 2 GB file
 * costs a syscall, not the heap.
 */
export function readLessonFile(filePath: string): ReadResult {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) return { ok: false, detail: "not a regular file" };
    if (stat.size > MAX_FILE_BYTES) {
      return { ok: false, detail: `file is too large (cap is ${MAX_FILE_BYTES} bytes)` };
    }
    return { ok: true, text: fs.readFileSync(filePath, "utf-8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, detail: code === "ENOENT" ? "no such file" : (code ?? "unreadable") };
  }
}

export type WriteResult = { ok: true } | { ok: false; reason: "exists" | "error"; detail?: string };

function errorDetail(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.message : "error");
}

/** Write the bytes beside `filePath` under a name nothing else will pick. */
function writeTemp(filePath: string, text: string): string {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(tmp, "wx", 0o644);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

/**
 * Create the lesson or fail -- never replace one. The bytes go to a temp file
 * first and are hard-linked into place, so the lesson appears whole or not at
 * all, and link() refuses an existing target in the same syscall that would
 * otherwise race an exists-check. Nothing on this path rewrites a lesson: an
 * id that is taken is a new slug's problem, not an overwrite.
 */
export function writeNoClobber(filePath: string, text: string): WriteResult {
  let tmp: string;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    tmp = writeTemp(filePath, text);
  } catch (err) {
    return { ok: false, reason: "error", detail: errorDetail(err) };
  }
  try {
    fs.linkSync(tmp, filePath);
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return { ok: false, reason: "exists" };
    return { ok: false, reason: "error", detail: errorDetail(err) };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* a stray dot-file is harmless; the lesson write already reported */
    }
  }
}

/** Drafts are scratch space, so a re-proposal replaces one. Still atomic. */
export function writeOverwrite(
  filePath: string,
  text: string,
): { ok: true } | { ok: false; detail: string } {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = writeTemp(filePath, text);
    try {
      fs.renameSync(tmp, filePath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: errorDetail(err) };
  }
}
