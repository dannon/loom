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
import type { Lesson } from "./types";

/** The only snapshot schema this release understands (C4). */
export const LESSONS_SCHEMA = 1;

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

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
  if (typeof o.id !== "string" || !o.id.trim()) return null;
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
    id: o.id.trim(),
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
