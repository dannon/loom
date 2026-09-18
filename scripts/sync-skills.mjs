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
 * functions because of what the CI gate cannot see. It catches an accidental
 * edit, a stale sync and a moved pin -- not a transform that mangles content,
 * which re-syncs, writes a fresh hash and passes, and not a deliberate edit
 * that updates `_manifest.json` in the same diff.
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

// The notes write the checkout root three ways: `~/`, and the expanded
// `/Users/<someone>/` or `/home/<someone>/`. The expanded forms also carry the
// author's account name, which we would otherwise publish to npm and into every
// installer, so all three have to be caught.
const CHECKOUT_ROOT = String.raw`(?:~|/(?:Users|home)/[A-Za-z0-9._-]+)`;
const LOCAL_CHECKOUT = new RegExp(`${CHECKOUT_ROOT}/projects/repositories/([A-Za-z0-9._-]+)/`, "g");
const LOCAL_CHECKOUT_RESIDUE = new RegExp(`${CHECKOUT_ROOT}/projects/repositories`);

/** Rewrite a local checkout of `<repo>` to that repo's GitHub blob base. */
export function rewriteLocalPaths(text, bases = REPO_BLOB_BASE) {
  const out = text.replace(LOCAL_CHECKOUT, (match, repo) => {
    // Own-property only: `bases["constructor"]` is truthy and would splice a
    // native-code stringification into shipped guidance.
    if (!Object.hasOwn(bases, repo)) {
      throw new Error(
        `no GitHub base for "${match}" -- add "${repo}" to REPO_BLOB_BASE, ` +
          `or the vendored copy ships a path that only exists on the author's machine`,
      );
    }
    return bases[repo];
  });
  // The rewrite only recognises a trailing slash. A bare `.../repositories/foo`
  // would slip past it, so fail here rather than in a reviewer's eyes.
  if (LOCAL_CHECKOUT_RESIDUE.test(out)) {
    throw new Error("a local-checkout reference survived the rewrite");
  }
  return out;
}

// Obsidian wiki-links resolve inside the Foundry vault and nowhere else. Left
// intact they read as an instruction to go fetch something that isn't vendored.
// Strip to the text a reader wants: the alias after `|` when the link has one,
// otherwise the note name without its `#anchor`.
const WIKI_LINK = /\[\[([^\]]+)\]\]/g;
// Up to three spaces of indent, three or more backticks or tildes. A fence is
// closed only by the same character at least as long, per CommonMark, so a
// `~~~` line in the middle of a ``` block does not end it.
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/;

/**
 * `[[...]]` is also how a 2D array literal opens, and galaxy-skills' apply-rules
 * reference is full of them (`data: [[cell values]]`, `[["a", "b", "c"]]`).
 *
 * Two rules keep those intact. Fenced lines are never rewritten, which is where
 * every one of them lives. And a candidate is only treated as a link when it
 * looks like a note name: no whitespace, quote, comma or bracket. Every one of
 * the 150 links in the vendored casts is a kebab-case file stem, so the second
 * rule costs nothing and covers an array literal that is not in a fence.
 *
 * Known limits, neither of which occurs in what is vendored today: an indented
 * (four-space) code block is not tracked, and neither are inline code spans.
 */
export function stripWikiLinks(text) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line);
      if (marker) {
        const [, ticks, rest] = marker;
        if (fence === null) {
          fence = ticks;
          return line;
        }
        // A closing fence is the same character, no shorter, and nothing else.
        if (ticks[0] === fence[0] && ticks.length >= fence.length && rest.trim() === "") {
          fence = null;
        }
        return line;
      }
      if (fence !== null) return line;
      return line.replace(WIKI_LINK, (match, target) =>
        /[\s"',[\]]/.test(target) ? match : wikiLinkText(target),
      );
    })
    .join("\n");
}

function wikiLinkText(target) {
  const pipe = target.lastIndexOf("|");
  const alias = pipe === -1 ? "" : target.slice(pipe + 1).trim();
  if (alias) return alias;
  const head = (pipe === -1 ? target : target.slice(0, pipe)).trim();
  const hash = head.indexOf("#");
  // A same-note link is all anchor. Dropping it would delete the sentence's
  // subject, so keep what is there rather than leaving a hole.
  return head.slice(0, hash === -1 ? undefined : hash).trim() || head;
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
  if (!targetName.toLowerCase().endsWith(".md")) return text;
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
    if (file.target.startsWith("/") || file.target.split("/").includes("..")) {
      throw new Error(`plugin "${entry.plugin}": target "${file.target}" leaves the vendor tree`);
    }
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
      for (const p of hits) add({ source: p, target: prefix(p) });
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
 * The targets the manifest names outright, or null when any plugin selects by
 * pattern -- a glob cannot be re-evaluated without the source tree, so offline
 * there is nothing to compare against. An explicit include that an exclude also
 * matches is not vendored, so it is not declared either; counting it would make
 * `sync` and `check` disagree on a manifest that is perfectly consistent.
 */
export function declaredTargets(manifest) {
  const plugins = manifest.plugins ?? [];
  if (!plugins.flatMap((p) => p.include).every((i) => typeof i === "object")) return null;
  return plugins.flatMap((p) =>
    p.include
      .filter((i) => !(p.exclude ?? []).some((pattern) => matchesPattern(pattern, i.source)))
      .map((i) => (p.as ? `${p.as}/${i.target}` : i.target)),
  );
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
    // Record what the checkout actually is, not what the manifest asked for.
    // Otherwise a sync from a side branch writes a provenance record naming a
    // commit whose content it does not contain, and the gate certifies it.
    const commit = localCheckoutCommit(dir);
    console.log(`Reading ${dir} (LOOM_AGENTIC_PLUGINS_DIR) at ${commit}.`);
    if (commit !== manifest.commit) {
      console.log("That is not the pinned commit, so `check:skills` will reject the result.");
    }
    return { dir, commit, cleanup: () => {} };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-skills-sync-"));
  git(["init", "-q"], dir);
  git(["remote", "add", "origin", `https://github.com/${manifest.repo}.git`], dir);
  git(["fetch", "-q", "--depth", "1", "origin", manifest.commit], dir);
  git(["checkout", "-q", "FETCH_HEAD"], dir);
  return {
    dir,
    commit: git(["rev-parse", "HEAD"], dir).trim(),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function localCheckoutCommit(dir) {
  try {
    const head = git(["rev-parse", "HEAD"], dir).trim();
    return git(["status", "--porcelain"], dir).trim() ? `${head}+dirty` : head;
  } catch {
    return "local-checkout-not-a-git-repo";
  }
}

function readUpstreamPin(sourceDir, plugin) {
  try {
    const raw = fs.readFileSync(path.join(sourceDir, "plugins", plugin, "UPSTREAM.json"), "utf-8");
    const { repository, ref, commit, path: subPath } = JSON.parse(raw);
    return { repository, ref, commit, path: subPath };
  } catch {
    console.warn(`  (no readable UPSTREAM.json for ${plugin}; provenance chain not recorded)`);
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

    // Read and transform everything before writing anything. A transform that
    // refuses a file is the normal way this fails, and half a tree on disk with
    // a stale manifest beside it reports as four hash mismatches rather than as
    // "the last sync did not finish".
    for (const plugin of manifest.plugins) {
      const root = path.join(source.dir, "plugins", plugin.plugin, PLUGIN_SKILLS_ROOT);
      if (!fs.existsSync(root)) {
        throw new Error(`plugin "${plugin.plugin}" has no ${PLUGIN_SKILLS_ROOT}/ directory`);
      }
      plugins.push({
        plugin: plugin.plugin,
        as: plugin.as ?? "",
        router: plugin.router ?? "never",
        transforms: plugin.transforms ?? [],
        why: plugin.why,
        upstream: readUpstreamPin(source.dir, plugin.plugin),
      });

      for (const file of selectFiles(plugin, listFiles(root))) {
        const owner = byTarget.get(file.target);
        if (owner) {
          throw new Error(`plugins "${owner}" and "${plugin.plugin}" both vendor ${file.target}`);
        }
        byTarget.set(file.target, plugin.plugin);

        const from = `plugins/${plugin.plugin}/${PLUGIN_SKILLS_ROOT}/${file.source}`;
        const raw = fs.readFileSync(path.join(root, file.source), "utf-8");
        let text;
        try {
          text = applyTransforms(raw, file.target, plugin.transforms);
        } catch (err) {
          throw new Error(`${from}: ${err.message}`, { cause: err });
        }
        entries.push({
          target: file.target,
          plugin: plugin.plugin,
          source: from,
          // Byte count of what the hash covers, so a CRLF checkout upstream
          // does not make the generated manifest differ by platform.
          bytes: Buffer.byteLength(text.replace(/\r\n/g, "\n"), "utf-8"),
          sha256: sha256(text),
          why: file.why,
          text,
        });
      }
    }

    entries.sort((a, b) => byTargetName(a.target, b.target));
    for (const entry of entries) {
      const abs = path.join(VENDOR_DIR, entry.target);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, entry.text, "utf-8");
      console.log(`  ${entry.target}  (${entry.bytes} bytes)`);
      delete entry.text;
    }

    fs.writeFileSync(
      VENDOR_MANIFEST,
      JSON.stringify(
        {
          $comment:
            "Generated by scripts/sync-skills.mjs. Do not hand-edit; " +
            "run `npm run sync:skills` instead.",
          repo: manifest.repo,
          commit: source.commit,
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
      `Vendored ${entries.length} file(s) from ${manifest.repo}@${source.commit.slice(0, 7)}`,
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
  if (!fs.existsSync(VENDOR_DIR)) return;
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

  const failures = checkVendored({
    source: { repo: manifest.repo, commit: manifest.commit, manifestSha: sha256(manifestText) },
    vendored: {
      repo: vendored.repo,
      commit: vendored.commit,
      manifestSha: vendored.manifestSha256,
    },
    declared: declaredTargets(manifest),
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
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error(`usage: sync-skills.mjs [--check] (got ${args.join(" ")})`);
    process.exit(2);
  }
  if (args[0] === "--check") {
    check();
  } else {
    await sync();
  }
}
