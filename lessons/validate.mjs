#!/usr/bin/env node
/**
 * Schema validator for the `lessons/` corpus.
 *
 *   node lessons/validate.mjs           # validate lessons/
 *   node lessons/validate.mjs <dir>     # validate some other corpus (the tests do)
 *
 * Exit 0 when clean; exit 1 with one `path:line: message` line per violation.
 *
 * The rules themselves live in `shared/lesson-rules.js`, because the brain runs
 * the same ones over an agent-drafted lesson before it is written; this file is
 * the corpus walk and the CLI. Plain Node plus `yaml`, nothing from
 * `extensions/`, so it runs before anything is built.
 */

import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NAMESPACES,
  parseLesson as parseLessonText,
  validateLessonFile,
} from "../shared/lesson-rules.js";

// The rule module's names, re-exported so the build and the corpus tests keep
// one import site.
export {
  EVIDENCE,
  KINDS,
  LIMITS,
  NAMESPACES,
  OPTIONAL_KEYS,
  REQUIRED_KEYS,
  SECTIONS,
  STAGES,
  STATUSES,
  TRIGGER_KEYS,
  UNKNOWN_SIGNATURE,
  identifyingShapes,
  isIsoDate,
  loadFrontmatter,
  normalizeSignature,
  parseSections,
  splitFrontmatter,
  validateLessonFile,
} from "../shared/lesson-rules.js";

export const LESSONS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parse a lesson that has already passed `validateLessonFile`. Throws on
 * anything the parser refuses, so the build can stay simple and never builds
 * from a lesson it could not read.
 */
export function parseLesson(raw) {
  const parsed = parseLessonText(raw);
  if (parsed.errors.length > 0) throw new Error(parsed.errors[0]);
  return parsed;
}

/** Lesson paths under `dir`, as sorted `<namespace>/<slug>.md`. */
export function collectLessonFiles(dir) {
  const out = [];
  for (const ns of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ns.isDirectory() || ns.name.startsWith(".")) continue;
    for (const entry of fs.readdirSync(path.join(dir, ns.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      out.push(`${ns.name}/${entry.name}`);
    }
  }
  return out.sort();
}

/** Validate a whole corpus directory. Returns `path:line: message` lines. */
export function validateLessonsDir(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return [`${dir}:1: no such lessons directory`];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const ns of entries) {
    if (ns.name.startsWith(".")) continue;
    if (ns.isSymbolicLink()) {
      out.push(`${ns.name}:1: no symlinks in the lessons directory`);
      continue;
    }
    if (!ns.isDirectory()) continue; // README, SCHEMA, LICENSE, log, the scripts
    if (!NAMESPACES.includes(ns.name)) {
      out.push(
        `${ns.name}:1: unknown namespace directory; the namespaces are ${NAMESPACES.join(", ")}`,
      );
      continue;
    }
    const inner = fs
      .readdirSync(path.join(dir, ns.name), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of inner) {
      if (entry.isDirectory()) {
        out.push(`${ns.name}/${entry.name}:1: a namespace holds lesson files only, one level deep`);
      } else if (!entry.name.endsWith(".md")) {
        out.push(`${ns.name}/${entry.name}:1: a namespace holds .md lesson files only`);
      } else if (!entry.isFile()) {
        out.push(`${ns.name}/${entry.name}:1: not a regular file`);
      }
    }
  }
  const files = collectLessonFiles(dir);
  if (files.length === 0) out.push(`${path.basename(dir)}:1: no lesson files found`);
  for (const rel of files) {
    out.push(...validateLessonFile(rel, fs.readFileSync(path.join(dir, rel), "utf8")));
  }
  return out;
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    console.error(`usage: validate.mjs [dir] (got ${args.join(" ")})`);
    process.exit(2);
  }
  const dir = args[0] ? path.resolve(args[0]) : LESSONS_DIR;
  const violations = validateLessonsDir(dir);
  if (violations.length > 0) {
    console.error(`lessons/validate: FAILED -- ${violations.length} violation(s)`);
    for (const v of violations) console.error(v);
    process.exit(1);
  }
  console.log(`lessons/validate: OK -- ${collectLessonFiles(dir).length} lesson(s)`);
}
