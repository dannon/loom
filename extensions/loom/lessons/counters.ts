/**
 * How often each lesson has been surfaced, locally.
 *
 * C5 fixes the shape and the one rule that matters: this is NEVER transmitted.
 * A `{lesson id, helped}` ping would reveal which problem the user hit. What
 * this file is for is the user's own question -- "what keeps firing at me?" --
 * and the /lesson command's suppress list.
 *
 * Deliberately NOT under LOOM_LESSONS_DIR: the lessons directory holds content
 * that can be shared or pointed somewhere else, and this is one install's tally.
 *
 * Read-modify-write on every bump, with no in-memory cache. The file is small,
 * and two concurrent sessions losing a count matters far less than one of them
 * serving a stale suppress flag.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../shared/state-dir.js";

export interface LessonCounter {
  surfaced: number;
  suppressed: boolean;
  /** ISO 8601, or "" when this id has only ever been suppressed. */
  lastSurfaced: string;
}

export type LessonCounters = Record<string, LessonCounter>;

const MAX_BYTES = 1024 * 1024;

export function countersPath(): string {
  return path.join(resolveStateDir(), "lessons", "counters.json");
}

export function readCounters(file: string = countersPath()): LessonCounters {
  // Null prototype: the keys come from a file anyone can edit, and a
  // "__proto__" key must stay a key.
  const out: LessonCounters = Object.create(null);
  try {
    if (fs.statSync(file).size > MAX_BYTES) return out;
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return out;
    for (const [id, value] of Object.entries(data as Record<string, unknown>)) {
      const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      out[id] = {
        surfaced:
          typeof v.surfaced === "number" && Number.isFinite(v.surfaced) && v.surfaced > 0
            ? Math.floor(v.surfaced)
            : 0,
        suppressed: v.suppressed === true,
        lastSurfaced: typeof v.lastSurfaced === "string" ? v.lastSurfaced : "",
      };
    }
    return out;
  } catch {
    return out;
  }
}

/** Atomic, 0600, and silent on failure -- a tally is not worth failing a turn. */
function writeCounters(file: string, counters: LessonCounters): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(counters, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing was written */
    }
  }
}

export function bumpSurfaced(lessonId: string, opts: { file?: string; now?: Date } = {}): void {
  const file = opts.file ?? countersPath();
  const counters = readCounters(file);
  const prev = counters[lessonId];
  counters[lessonId] = {
    surfaced: (prev?.surfaced ?? 0) + 1,
    suppressed: prev?.suppressed ?? false,
    lastSurfaced: (opts.now ?? new Date()).toISOString(),
  };
  writeCounters(file, counters);
}

/**
 * Mirror the config's suppress list into the counters file, so the
 * `suppressed` field C5 specifies is actually live -- a suppressed lesson never
 * surfaces, so a bump would never set it. Nothing reads this flag to decide
 * anything; `lessons.suppress` in the config is the authority. Writes only on
 * a real change.
 */
export function syncSuppressedFlags(suppressed: string[], opts: { file?: string } = {}): void {
  const file = opts.file ?? countersPath();
  const counters = readCounters(file);
  const want = new Set(suppressed);
  let changed = false;

  for (const id of want) {
    const prev = counters[id];
    if (prev?.suppressed === true) continue;
    counters[id] = {
      surfaced: prev?.surfaced ?? 0,
      suppressed: true,
      lastSurfaced: prev?.lastSurfaced ?? "",
    };
    changed = true;
  }
  for (const [id, counter] of Object.entries(counters)) {
    if (counter.suppressed && !want.has(id)) {
      counters[id] = { ...counter, suppressed: false };
      changed = true;
    }
  }
  if (changed) writeCounters(file, counters);
}
