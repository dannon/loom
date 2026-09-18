/**
 * Bundled skill content.
 *
 * Files under `vendor/skills/` are vendored from `galaxyproject/agentic-plugins`
 * at a pinned commit by `scripts/sync-skills.mjs` and ship inside the package --
 * both the npm CLI (`files: ["extensions/", ...]`) and the Orbit installers
 * (forge's `LOOM_BUNDLE_FILES` includes `extensions`) pick them up with no
 * packaging change. That is deliberate: the guidance has to be available
 * offline, at a version we reviewed, with no runtime dependency on GitHub.
 *
 * Two kinds of content live here. The galaxy-skills mirror backs the configured
 * repo of the same name: its generated `_catalog.json` is what the system-prompt
 * router renders, and `skills_fetch` reads it from disk. The Foundry casts back
 * nothing configured and never enter the router -- nothing in them is ambient
 * guidance the model needs to know exists up front, so a hint names the exact
 * file at the moment it becomes relevant (see `invocation-failure-hint.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBundledSkillRepo } from "../../shared/loom-config.js";
import type { SkillEntry } from "./skills-discovery";

/** Reserved repo name for `skills_fetch({ repo: "foundry" })`. */
export const VENDOR_REPO_NAME = "foundry";

export interface VendorManifestEntry {
  target: string;
  plugin: string;
  source: string;
  bytes: number;
  sha256: string;
  why?: string;
}

export interface VendorManifestPlugin {
  plugin: string;
  as: string;
  repo?: string;
  /** "catalog" puts this plugin's skills in the prompt router; "never" keeps them out. */
  router: string;
}

export interface VendorManifest {
  repo: string;
  /** Commit, not tag: tags move, and "what did we ship" has to stay answerable. */
  commit: string;
  /** A label for the commit, null while the pin is ahead of the newest tag. */
  tag?: string | null;
  commitDate?: string;
  plugins?: VendorManifestPlugin[];
  files: VendorManifestEntry[];
}

/** Re-exported so brain-side callers do not reach across into shared/ directly. */
export { isBundledSkillRepo as isBundledRepo };

/** The generated router catalog, keyed by configured repo name. */
export function readBundledCatalog(): Record<string, SkillEntry[]> | null {
  try {
    const raw = fs.readFileSync(path.join(vendorSkillsDir(), "_catalog.json"), "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    const out: Record<string, SkillEntry[]> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("$")) continue;
      if (Array.isArray(value)) out[key] = value as SkillEntry[];
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Where in the vendor tree a configured repo's content lives. Reading is scoped
 * to it so a bundled repo answers for its own files and nothing else: the casts
 * are reachable only through their own repo name, and the same path has to mean
 * the same thing whether the repo is bundled or fetched.
 */
function bundledPrefix(repoName: string): string | null {
  const plugin = readVendorManifest()?.plugins?.find((p) => p.repo === repoName);
  if (!plugin) return null;
  return plugin.as ? `${plugin.as}/` : "";
}

/**
 * Read one file for a bundled repo. Never touches the network, so a miss lists
 * that repo's own skills rather than every file in the package.
 */
export function readBundledRepoFile(repo: { name: string }, rawPath: string): VendorReadResult {
  const skills = (readBundledCatalog()?.[repo.name] ?? []).map((s) => s.path);
  const prefix = bundledPrefix(repo.name);
  const clean = rawPath.replace(/^\/+/, "").replace(/\\/g, "/");
  if (prefix === null || !clean.startsWith(prefix)) {
    return { ok: false, error: `No file "${rawPath}"`, available: skills };
  }
  const res = readVendoredSkill(clean);
  if (res.ok) return res;
  return { ...res, available: skills.length ? skills : res.available };
}

/** True when the package actually holds this bundled repo's content. */
export function hasBundledContent(repoName: string): boolean {
  return (readBundledCatalog()?.[repoName]?.length ?? 0) > 0;
}

/** Absolute path to the vendored skills directory (sibling of this module). */
export function vendorSkillsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor", "skills");
}

/**
 * Resolve a vendored file path to an absolute path inside the vendor dir, or
 * null if it escapes. A leading slash is stripped and a backslash is read as a
 * separator, the way the GitHub path does it; a literal `..` anywhere is
 * rejected outright rather than resolved, so percent-encoded traversal never
 * gets a chance to become one.
 */
export function resolveVendorPath(rawPath: string): string | null {
  const clean = rawPath.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!clean || clean.includes("..")) return null;
  const dir = vendorSkillsDir();
  const abs = path.resolve(dir, clean);
  // path.resolve collapses traversal; confirm the result is still contained.
  // The trailing separator stops `/vendor/skillsX` from passing as `/vendor/skills`.
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  return abs;
}

export function readVendorManifest(): VendorManifest | null {
  try {
    const raw = fs.readFileSync(path.join(vendorSkillsDir(), "_manifest.json"), "utf-8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.files)) return null;
    return data as VendorManifest;
  } catch {
    return null;
  }
}

/**
 * Bare names the vendor tree used before targets mirrored their upstream path.
 * A session resumed across that change still carries them in its transcript --
 * two were named in a failure hint, and the third was listed to the model every
 * time a fetch missed. They keep resolving for one release; delete them once
 * 0.8.0 has shipped.
 *
 * Null prototype on purpose. `path` reaches here straight from the model, and a
 * plain object answers "constructor" with a function, which is not a path.
 */
const LEGACY_FLAT_PATHS: Record<string, string> = Object.assign(Object.create(null), {
  "galaxy-collection-semantics.yml":
    "debug-galaxy-workflow-output/references/notes/galaxy-collection-semantics.yml",
  "galaxy-tool-job-failure-reference.md":
    "debug-galaxy-workflow-output/references/notes/galaxy-tool-job-failure-reference.md",
  "galaxy-workflow-invocation-failure-reference.md":
    "debug-galaxy-workflow-output/references/notes/galaxy-workflow-invocation-failure-reference.md",
});

export type VendorReadResult =
  { ok: true; text: string } | { ok: false; error: string; available: string[] };

/** Read one vendored file. Never touches the network. */
export function readVendoredSkill(rawPath: string): VendorReadResult {
  // Only built on the failure paths: the manifest is ~50 KB of JSON and every
  // successful read would otherwise parse it just to throw the result away.
  const available = () =>
    (readVendorManifest()?.files ?? []).map((f) => f.target).filter((t) => t !== "_manifest.json");
  if (typeof rawPath !== "string") {
    return { ok: false, error: `Invalid vendored skill path`, available: available() };
  }
  const abs = resolveVendorPath(LEGACY_FLAT_PATHS[rawPath] ?? rawPath);
  if (!abs) {
    return { ok: false, error: `Invalid vendored skill path "${rawPath}"`, available: available() };
  }
  try {
    return { ok: true, text: fs.readFileSync(abs, "utf-8") };
  } catch {
    return { ok: false, error: `No vendored file "${rawPath}"`, available: available() };
  }
}
