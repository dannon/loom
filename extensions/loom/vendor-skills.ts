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
 * This is a read-only source for `skills_fetch`, not a configured skills repo.
 * It never appears in the system-prompt skills router -- nothing here is
 * ambient guidance the model needs to know exists up front. Hints point at it
 * at the moment it becomes relevant (see `invocation-failure-hint.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SKILLS } from "../../shared/loom-config.js";
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

/**
 * A configured repo reads from the package when it is one of the defaults and is
 * still pointed at that default's URL and branch. Anything else -- another
 * branch, another URL, a repo we do not ship -- is live, which is what the
 * skill-author workflow of pointing Loom at a branch depends on.
 *
 * Deliberately not true for the bundled-reference name: that one is resolved
 * before repo lookup, and a user who configures a real repo under the same name
 * must still reach it.
 */
export function isBundledRepo(repo: { name: string; url: string; branch?: string }): boolean {
  const preset = DEFAULT_SKILLS.find((d: { name: string }) => d.name === repo.name);
  if (!preset) return false;
  return sameRepoUrl(repo.url, preset.url) && (repo.branch || "main") === (preset.branch || "main");
}

function sameRepoUrl(a: string, b: string): boolean {
  const norm = (u: string) =>
    String(u ?? "")
      .trim()
      .replace(/\.git$/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  return norm(a) === norm(b) && norm(a) !== "";
}

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
 * Read one file for a bundled repo. Never touches the network, so a miss lists
 * that repo's own skills rather than every file in the package.
 */
export function readBundledRepoFile(repo: { name: string }, rawPath: string): VendorReadResult {
  const res = readVendoredSkill(rawPath);
  if (res.ok) return res;
  const skills = (readBundledCatalog()?.[repo.name] ?? []).map((s) => s.path);
  return { ...res, available: skills.length ? skills : res.available };
}

/** Absolute path to the vendored skills directory (sibling of this module). */
export function vendorSkillsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor", "skills");
}

/**
 * Resolve a vendored file path to an absolute path inside the vendor dir, or
 * null if it escapes. The vendor set is flat, but a caller-supplied path still
 * gets the same containment check the GitHub path takes -- `..`, absolute
 * paths, and backslash separators are all rejected rather than normalized.
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
  const available = (readVendorManifest()?.files ?? [])
    .map((f) => f.target)
    .filter((t) => t !== "_manifest.json");
  if (typeof rawPath !== "string") {
    return { ok: false, error: `Invalid vendored skill path`, available };
  }
  const abs = resolveVendorPath(LEGACY_FLAT_PATHS[rawPath] ?? rawPath);
  if (!abs) return { ok: false, error: `Invalid vendored skill path "${rawPath}"`, available };
  try {
    return { ok: true, text: fs.readFileSync(abs, "utf-8") };
  } catch {
    return { ok: false, error: `No vendored file "${rawPath}"`, available };
  }
}
