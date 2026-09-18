#!/usr/bin/env node
/**
 * Vendor skill content into `extensions/loom/vendor/skills/`.
 *
 * The source is `galaxyproject/agentic-plugins`, which mirrors galaxy-skills
 * and the Foundry casts at pins of its own and is what distributes the same
 * content to every other harness. Loom is a downstream client of it: pin one
 * commit, copy a chosen subset, record hashes, and gate drift in CI. The copy
 * ships inside the package, so the guidance is available offline, at a version
 * that went through review, with no runtime dependency on GitHub.
 *
 * The pin is a commit, not a tag. Tags move; a commit is the only thing that
 * makes "what did we ship" answerable later. `tag` in the manifest is a label.
 *
 *   npm run sync:skills      # fetch at the pinned commit, transform, write
 *   npm run check:skills     # verify the vendored tree matches _manifest.json
 *
 * `LOOM_AGENTIC_PLUGINS_DIR=/path/to/agentic-plugins` reads a local checkout
 * instead of fetching, for iterating on both repos at once. It does not check
 * that the checkout is at the pinned commit, so never commit the result of one.
 *
 * Transforms are declared per plugin and applied to markdown on the way in, so
 * the vendored copy is deliberately not byte-identical to upstream and `--check`
 * compares recorded hashes rather than re-fetching. They are exported as pure
 * functions because the CI gate proves only that nobody hand-edited the tree:
 * a transform that mangles content re-syncs, writes a fresh hash, and passes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "scripts", "skills.manifest.json");
const VENDOR_DIR = path.join(REPO_ROOT, "extensions", "loom", "vendor", "skills");
const VENDOR_MANIFEST_NAME = "_manifest.json";
const VENDOR_MANIFEST = path.join(VENDOR_DIR, VENDOR_MANIFEST_NAME);

// agentic-plugins follows the plugin layout every harness reads: skill content
// for a plugin lives under `plugins/<name>/skills/`. Include and exclude
// patterns in the manifest are relative to that directory.
const PLUGIN_SKILLS_ROOT = "skills";

// Research notes in the Foundry cite source by the author's local checkout
// (`~/projects/repositories/galaxy/...`), in both frontmatter `sources:` and
// body prose. Shipped as-is an agent may try to read a path that doesn't exist
// on the user's machine; Loom's read-jail blocks it, so the turn is wasted or
// the user is pointed somewhere useless. Rewrite to the canonical GitHub
// location, and refuse to ship a repo we have no rewrite for rather than
// leaking a dead local path.
export const REPO_BLOB_BASE = {
  galaxy: "https://github.com/galaxyproject/galaxy/blob/dev/",
  planemo: "https://github.com/galaxyproject/planemo/blob/master/",
};

const LOCAL_CHECKOUT = /~\/projects\/repositories\/([A-Za-z0-9._-]+)\//g;

/** Rewrite `~/projects/repositories/<repo>/` to that repo's GitHub blob base. */
export function rewriteLocalPaths(text, bases = REPO_BLOB_BASE) {
  const out = text.replace(LOCAL_CHECKOUT, (match, repo) => {
    const base = bases[repo];
    if (!base) {
      throw new Error(
        `no GitHub base for "${match}" -- add "${repo}" to REPO_BLOB_BASE, ` +
          `or the vendored copy ships a path that only exists on the author's machine`,
      );
    }
    return base;
  });
  // The rewrite only recognises a trailing slash. A bare `~/projects/repositories/foo`
  // would slip past it, so fail here rather than in a reviewer's eyes.
  if (out.includes("~/projects/repositories")) {
    throw new Error("a `~/projects/repositories` reference survived the rewrite");
  }
  return out;
}

// Obsidian wiki-links resolve inside the Foundry vault and nowhere else. Left
// intact they read as an instruction to go fetch something that isn't vendored.
// Strip to the text a reader wants: the alias after `|` when the link has one,
// otherwise the note name without its `#anchor`.
const WIKI_LINK = /\[\[([^\]]+)\]\]/g;
const FENCE = /^\s*(?:```|~~~)/;

/**
 * `[[...]]` is also how a 2D array literal opens, and galaxy-skills' apply-rules
 * reference is full of them (`data: [[cell values]]`, `[["a", "b", "c"]]`). Both
 * live inside code fences, so fenced lines are left alone; a candidate carrying
 * a quote, comma or bracket is skipped as well, since no note name has one.
 */
export function stripWikiLinks(text) {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(WIKI_LINK, (match, target) =>
        /["',[\]]/.test(target) ? match : wikiLinkText(target),
      );
    })
    .join("\n");
}

function wikiLinkText(target) {
  const pipe = target.lastIndexOf("|");
  if (pipe !== -1) return target.slice(pipe + 1).trim();
  const hash = target.indexOf("#");
  return (hash === -1 ? target : target.slice(0, hash)).trim();
}

/**
 * Transforms are named in the manifest per plugin, not applied globally. The
 * wiki-link strip and the path rewrite are corrections for how the Foundry
 * authors its notes; running them over content that never had the problem is
 * how a sync quietly corrupts something.
 */
export const TRANSFORMS = {
  "rewrite-local-paths": (text) => rewriteLocalPaths(text),
  "strip-wiki-links": (text) => stripWikiLinks(text),
};

export function applyTransforms(text, targetName, names = []) {
  if (!targetName.endsWith(".md")) return text;
  return names.reduce((acc, name) => {
    const fn = TRANSFORMS[name];
    if (!fn) throw new Error(`unknown transform "${name}"`);
    return fn(acc);
  }, text);
}

/**
 * Hash of the content with line endings normalised. Git hands Windows checkouts
 * CRLF, so hashing the bytes on disk would fail the drift gate on that leg only.
 */
export function sha256(text) {
  return crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf-8").digest("hex");
}

// Codepoint order, not `localeCompare`: the manifest has to come out in the
// same order on every machine that runs the sync, and collation is not.
const byTargetName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Glob match over slash-separated paths: `*` stays in one segment, `**` does not. */
export function matchesPattern(pattern, filePath) {
  const source = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`).test(filePath);
}

/**
 * Which files a plugin entry selects, and what each one is called in the vendor
 * tree. `available` is every path under the plugin's skills root. An include
 * that matches nothing is an error: a renamed cast upstream should stop the
 * sync, not quietly shrink what ships.
 *
 * @param {{plugin: string, as?: string, include: (string | {source: string, target: string, why?: string})[], exclude?: string[], why?: string}} entry
 * @param {string[]} available
 * @returns {{source: string, target: string, why?: string}[]}
 */
export function selectFiles(entry, available) {
  const exclude = entry.exclude ?? [];
  const isExcluded = (p) => exclude.some((pattern) => matchesPattern(pattern, p));
  const prefix = (target) => (entry.as ? `${entry.as}/${target}` : target);
  const selected = new Map();

  const add = (file) => {
    const clash = selected.get(file.target);
    if (clash && clash.source !== file.source) {
      throw new Error(
        `plugin "${entry.plugin}": ${clash.source} and ${file.source} both vendor as ${file.target}`,
      );
    }
    selected.set(file.target, file);
  };

  for (const item of entry.include) {
    if (typeof item === "string") {
      const hits = available.filter((p) => matchesPattern(item, p) && !isExcluded(p));
      if (hits.length === 0) {
        throw new Error(`plugin "${entry.plugin}": include "${item}" matched nothing`);
      }
      for (const p of hits) add({ source: p, target: prefix(p), why: entry.why });
      continue;
    }
    if (!available.includes(item.source)) {
      throw new Error(`plugin "${entry.plugin}": include "${item.source}" does not exist upstream`);
    }
    if (isExcluded(item.source)) continue;
    add({ source: item.source, target: prefix(item.target), why: item.why });
  }

  return [...selected.values()].sort((a, b) => byTargetName(a.target, b.target));
}

/**
 * The four ways the vendored tree can be wrong, as pure logic over what the
 * source manifest asks for, what the vendored manifest recorded, and what is
 * actually on disk.
 *
 * @param {object} args
 * @param {{repo: string, commit: string, manifestSha?: string}} args.source what the manifest asks for
 * @param {{repo: string, commit: string, manifestSha?: string}} args.vendored what the vendored copy was built from
 * @param {string[] | null} args.declared targets the manifest names outright, null when it selects by pattern
 * @param {{target: string, sha256: string}[]} args.recorded entries in the vendored manifest
 * @param {string[]} args.present files found under the vendor dir, manifest excluded
 * @param {(target: string) => string | null} args.hashOf actual hash, null when unreadable
 * @returns {{kind: string, message: string}[]}
 */
export function checkVendored({ source, vendored, declared, recorded, present, hashOf }) {
  const failures = [];
  const short = (c) => (typeof c === "string" ? c.slice(0, 7) : String(c));

  if (source.repo !== vendored.repo || source.commit !== vendored.commit) {
    failures.push({
      kind: "moved-pin",
      message:
        `pin moved to ${source.repo}@${short(source.commit)} but files were not ` +
        `re-synced (vendored from ${vendored.repo}@${short(vendored.commit)})`,
    });
  } else if (
    source.manifestSha &&
    vendored.manifestSha &&
    source.manifestSha !== vendored.manifestSha
  ) {
    // Globs cannot be re-evaluated without the source tree, so the only offline
    // way to notice an edited selection is to hash the manifest itself.
    failures.push({
      kind: "moved-pin",
      message: "the manifest changed but files were not re-synced",
    });
  }

  const recordedTargets = new Set(recorded.map((f) => f.target));
  const presentSet = new Set(present);

  for (const target of declared ?? []) {
    if (!recordedTargets.has(target)) {
      failures.push({ kind: "missing", message: `${target}: in the manifest but not vendored` });
    }
  }

  for (const entry of recorded) {
    if (!presentSet.has(entry.target)) {
      failures.push({ kind: "missing", message: `${entry.target}: recorded but not on disk` });
      continue;
    }
    const actual = hashOf(entry.target);
    if (actual !== entry.sha256) {
      failures.push({
        kind: "hash-mismatch",
        message: `${entry.target}: hand-edited or corrupt (sha256 mismatch)`,
      });
    }
  }

  if (declared) {
    for (const target of recordedTargets) {
      if (!declared.includes(target)) {
        failures.push({
          kind: "orphaned",
          message: `${target}: vendored but no longer in the manifest`,
        });
      }
    }
  }

  for (const file of present) {
    if (!recordedTargets.has(file)) {
      failures.push({ kind: "orphaned", message: `${file}: on disk but not in _manifest.json` });
    }
  }

  return failures;
}

/** Every file under `dir`, as slash-separated paths relative to it. */
export function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

function readManifestText() {
  return fs.readFileSync(MANIFEST_PATH, "utf-8");
}

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${(res.stderr ?? "").trim()}`);
  }
  return res.stdout;
}

/**
 * A directory holding the source tree. Fetching the pinned commit directly is
 * one object walk and keeps working when the pin falls behind whatever the
 * default branch has moved to.
 */
function materializeSource(manifest) {
  const local = process.env.LOOM_AGENTIC_PLUGINS_DIR;
  if (local) {
    const dir = path.resolve(local);
    if (!fs.existsSync(path.join(dir, "plugins"))) {
      throw new Error(`LOOM_AGENTIC_PLUGINS_DIR is set but ${dir} has no plugins/ directory`);
    }
    console.log(`Reading ${dir} (LOOM_AGENTIC_PLUGINS_DIR); the pinned commit is not enforced.`);
    return { dir, cleanup: () => {} };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-skills-sync-"));
  git(["init", "-q"], dir);
  git(["remote", "add", "origin", `https://github.com/${manifest.repo}.git`], dir);
  git(["fetch", "-q", "--depth", "1", "origin", manifest.commit], dir);
  git(["checkout", "-q", "FETCH_HEAD"], dir);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function readUpstreamPin(sourceDir, plugin) {
  try {
    const raw = fs.readFileSync(path.join(sourceDir, "plugins", plugin, "UPSTREAM.json"), "utf-8");
    const { repository, ref, commit, path: subPath } = JSON.parse(raw);
    return { repository, ref, commit, path: subPath };
  } catch {
    return null;
  }
}

async function sync() {
  const manifestText = readManifestText();
  const manifest = JSON.parse(manifestText);
  const source = materializeSource(manifest);

  try {
    const entries = [];
    const plugins = [];
    const byTarget = new Map();

    for (const plugin of manifest.plugins) {
      const root = path.join(source.dir, "plugins", plugin.plugin, PLUGIN_SKILLS_ROOT);
      if (!fs.existsSync(root)) {
        throw new Error(`plugin "${plugin.plugin}" has no ${PLUGIN_SKILLS_ROOT}/ directory`);
      }
      const files = selectFiles(plugin, listFiles(root));
      plugins.push({
        plugin: plugin.plugin,
        as: plugin.as ?? "",
        router: plugin.router ?? "never",
        transforms: plugin.transforms ?? [],
        upstream: readUpstreamPin(source.dir, plugin.plugin),
      });

      for (const file of files) {
        const owner = byTarget.get(file.target);
        if (owner) {
          throw new Error(`plugins "${owner}" and "${plugin.plugin}" both vendor ${file.target}`);
        }
        byTarget.set(file.target, plugin.plugin);

        const raw = fs.readFileSync(path.join(root, file.source), "utf-8");
        const out = applyTransforms(raw, file.target, plugin.transforms);
        const abs = path.join(VENDOR_DIR, file.target);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, out, "utf-8");
        entries.push({
          target: file.target,
          plugin: plugin.plugin,
          source: `plugins/${plugin.plugin}/${PLUGIN_SKILLS_ROOT}/${file.source}`,
          bytes: Buffer.byteLength(out, "utf-8"),
          sha256: sha256(out),
          why: file.why,
        });
        console.log(`  ${file.target}  (${Buffer.byteLength(out, "utf-8")} bytes)`);
      }
    }

    entries.sort((a, b) => byTargetName(a.target, b.target));
    fs.writeFileSync(
      VENDOR_MANIFEST,
      JSON.stringify(
        {
          $comment:
            "Generated by scripts/sync-skills.mjs. Do not hand-edit; " +
            "run `npm run sync:skills` instead.",
          repo: manifest.repo,
          commit: manifest.commit,
          commitDate: manifest.commitDate,
          tag: manifest.tag ?? null,
          manifestSha256: sha256(manifestText),
          plugins,
          files: entries,
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    pruneStale(new Set(entries.map((e) => e.target)));
    console.log(
      `Vendored ${entries.length} file(s) from ${manifest.repo}@${manifest.commit.slice(0, 7)}`,
    );
  } finally {
    source.cleanup();
  }
}

/**
 * Drop files a previous sync left behind. Without this a target that moves or
 * leaves the manifest stays on disk and keeps shipping, and `--check` reports it
 * as an orphan on every run until someone deletes it by hand.
 */
function pruneStale(keep) {
  for (const rel of listFiles(VENDOR_DIR)) {
    if (rel === VENDOR_MANIFEST_NAME || keep.has(rel)) continue;
    fs.rmSync(path.join(VENDOR_DIR, rel));
    console.log(`  removed ${rel}`);
  }
  // Directories a pruned file used to live in.
  const dirs = new Set();
  for (const rel of listFiles(VENDOR_DIR)) {
    for (let d = path.dirname(rel); d !== "."; d = path.dirname(d)) dirs.add(d);
  }
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(VENDOR_DIR, sub), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      walk(rel);
      if (!dirs.has(rel)) fs.rmdirSync(path.join(VENDOR_DIR, rel));
    }
  };
  walk("");
}

function check() {
  if (!fs.existsSync(VENDOR_MANIFEST)) {
    console.error("check:skills -- no vendored manifest; run `npm run sync:skills`");
    process.exit(1);
  }
  const vendored = JSON.parse(fs.readFileSync(VENDOR_MANIFEST, "utf-8"));
  const manifestText = readManifestText();
  const manifest = JSON.parse(manifestText);

  const includes = manifest.plugins.flatMap((p) => p.include);
  const declared = includes.every((i) => typeof i === "object")
    ? manifest.plugins.flatMap((p) =>
        p.include.map((i) => (p.as ? `${p.as}/${i.target}` : i.target)),
      )
    : null;

  const failures = checkVendored({
    source: { repo: manifest.repo, commit: manifest.commit, manifestSha: sha256(manifestText) },
    vendored: {
      repo: vendored.repo,
      commit: vendored.commit,
      manifestSha: vendored.manifestSha256,
    },
    declared,
    recorded: vendored.files,
    present: listFiles(VENDOR_DIR).filter((f) => f !== VENDOR_MANIFEST_NAME),
    hashOf: (target) => {
      try {
        return sha256(fs.readFileSync(path.join(VENDOR_DIR, target), "utf-8"));
      } catch {
        return null;
      }
    },
  });

  if (failures.length > 0) {
    console.error("check:skills FAILED");
    for (const f of failures) console.error(`  - ${f.message}`);
    console.error("\nRun `npm run sync:skills` to regenerate.");
    process.exit(1);
  }
  console.log(`check:skills OK -- ${vendored.files.length} file(s) match _manifest.json`);
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
  if (process.argv[2] === "--check") {
    check();
  } else {
    await sync();
  }
}
