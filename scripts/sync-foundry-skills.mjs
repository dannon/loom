#!/usr/bin/env node
/**
 * Vendor Foundry reference material into `extensions/loom/vendor/skills/`.
 *
 * Mirrors the Foundry's own `make sync-planemo` pattern: pin an upstream ref,
 * copy a named set of files, record hashes, and gate drift in CI. Loom ships
 * the result so the guidance is available offline, at a reviewed version, with
 * no runtime dependency on GitHub -- which is also what the Foundry intends
 * ("casting is the integration boundary").
 *
 * Two transforms are applied to markdown on the way in. The vendored copy is
 * therefore *not* byte-identical to upstream by design, so `--check` compares
 * against recorded hashes of the transformed output rather than re-fetching.
 *
 *   npm run sync:foundry-skills          # fetch at the pinned ref and rewrite
 *   npm run check:foundry-skills         # verify vendored files match _manifest.json
 *
 * `LOOM_FOUNDRY_DIR=/path/to/foundry` syncs from a local checkout instead of
 * the network -- useful when iterating on both repos at once.
 *
 * The transforms and the `--check` comparison are exported as pure functions so
 * they can be tested without a network or a vendor tree. The CI gate only
 * proves the vendored bytes match the hashes beside them; it says nothing about
 * whether the transform that produced those bytes is correct, and a transform
 * that silently mangles content would sail straight through it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "scripts", "foundry-skills.manifest.json");
const VENDOR_DIR = path.join(REPO_ROOT, "extensions", "loom", "vendor", "skills");
const VENDOR_MANIFEST_NAME = "_manifest.json";
const VENDOR_MANIFEST = path.join(VENDOR_DIR, VENDOR_MANIFEST_NAME);

// The Foundry's research notes cite source by the author's local checkout
// (`~/projects/repositories/galaxy/...`), in both frontmatter `sources:` and
// body prose. Shipped as-is an agent may try to read a path that doesn't exist
// on the user's machine; Loom's read-jail blocks it, so the turn is wasted or
// the user is pointed somewhere useless. Rewrite to the canonical GitHub
// location, and refuse to ship a repo we have no rewrite for rather than
// leaking a dead local path.
export const REPO_BLOB_BASE = {
  galaxy: "https://github.com/galaxyproject/galaxy/blob/dev/",
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

export function transform(text, targetName) {
  if (!targetName.endsWith(".md")) return text;
  return stripWikiLinks(rewriteLocalPaths(text));
}

/**
 * Hash of the content with line endings normalised. Git hands Windows checkouts
 * CRLF, so hashing the bytes on disk would fail the drift gate on that leg only.
 */
export function sha256(text) {
  return crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf-8").digest("hex");
}

/**
 * The four ways the vendored tree can be wrong, as pure logic over what the
 * source manifest asks for, what the vendored manifest recorded, and what is
 * actually on disk.
 *
 * @param {object} args
 * @param {{repo: string, commit: string}} args.source pin the source manifest asks for
 * @param {{repo: string, commit: string}} args.vendored pin the vendored copy was built from
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

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
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

async function readSource(manifest, sourcePath) {
  const localDir = process.env.LOOM_FOUNDRY_DIR;
  if (localDir) {
    const abs = path.join(localDir, sourcePath);
    if (!fs.existsSync(abs)) {
      throw new Error(`LOOM_FOUNDRY_DIR is set but ${abs} does not exist`);
    }
    return fs.readFileSync(abs, "utf-8");
  }
  const url =
    `https://raw.githubusercontent.com/${manifest.repo}/${manifest.ref}/` +
    sourcePath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  return res.text();
}

async function sync() {
  const manifest = readManifest();
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  const entries = [];
  for (const file of manifest.files) {
    const raw = await readSource(manifest, file.source);
    const out = transform(raw, file.target);
    fs.writeFileSync(path.join(VENDOR_DIR, file.target), out, "utf-8");
    entries.push({
      target: file.target,
      source: file.source,
      bytes: Buffer.byteLength(out, "utf-8"),
      sha256: sha256(out),
      why: file.why,
    });
    console.log(`  ${file.target}  (${Buffer.byteLength(out, "utf-8")} bytes)`);
  }

  fs.writeFileSync(
    VENDOR_MANIFEST,
    JSON.stringify(
      {
        $comment:
          "Generated by scripts/sync-foundry-skills.mjs. Do not hand-edit; " +
          "run `npm run sync:foundry-skills` instead.",
        repo: manifest.repo,
        ref: manifest.ref,
        refDate: manifest.refDate,
        transforms: [
          "galaxy local-checkout paths -> github.com/galaxyproject/galaxy blob URLs",
          "obsidian [[wiki-links]] stripped to bare names",
        ],
        files: entries,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(
    `Vendored ${entries.length} file(s) from ${manifest.repo}@${manifest.ref.slice(0, 7)}`,
  );
}

function check() {
  if (!fs.existsSync(VENDOR_MANIFEST)) {
    console.error(
      "check:foundry-skills -- no vendored manifest; run `npm run sync:foundry-skills`",
    );
    process.exit(1);
  }
  const vendored = JSON.parse(fs.readFileSync(VENDOR_MANIFEST, "utf-8"));
  const source = readManifest();

  const failures = checkVendored({
    source: { repo: source.repo, commit: source.ref },
    vendored: { repo: vendored.repo, commit: vendored.ref },
    declared: source.files.map((f) => f.target),
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
    console.error("check:foundry-skills FAILED");
    for (const f of failures) console.error(`  - ${f.message}`);
    console.error("\nRun `npm run sync:foundry-skills` to regenerate.");
    process.exit(1);
  }
  console.log(`check:foundry-skills OK -- ${vendored.files.length} file(s) match _manifest.json`);
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
