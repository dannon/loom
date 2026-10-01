#!/usr/bin/env node
/**
 * Schema validator for the `lessons/` corpus. The rules here ARE the schema.
 *
 *   node lessons/validate.mjs           # validate lessons/
 *   node lessons/validate.mjs <dir>     # validate some other corpus (the tests do)
 *
 * Exit 0 when clean; exit 1 with one `path:line: message` line per violation.
 *
 * Plain Node plus `yaml` (already a root dependency). Nothing from
 * `extensions/`, so this runs before anything is built and can be imported by
 * a plain `.mjs` script.
 *
 * Every bound below is a content control rather than a tidiness preference. A
 * lesson ships inside the package to every install, and the published snapshot
 * goes into a public index, so a lesson must not carry anything to follow (no
 * URLs, no markdown links), anything to run (no fenced code), or anything
 * identifying (no paths, ids or hosts outside the declared trigger lists).
 */

import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const LESSONS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `galaxy-api` holds lessons that graduated upstream and are kept unsurfaced. */
export const NAMESPACES = ["stats", "reproduction", "data", "galaxy-tools", "galaxy-api"];
export const STATUSES = ["draft", "stable", "deprecated"];
export const KINDS = ["pitfall", "expectation", "choice", "source-quirk", "reproduction"];
export const STAGES = [
  "data-acquisition",
  "metadata-reconciliation",
  "tool-parameterization",
  "job-execution",
  "result-interpretation",
];
export const EVIDENCE = {
  symptom: ["verified", "reported"],
  cause: ["verified", "hypothesized", "unknown"],
  outcome: ["validated", "unvalidated"],
};

export const REQUIRED_KEYS = [
  "type",
  "title",
  "description",
  "tags",
  "status",
  "generated",
  "stale_after",
  "sources",
  "kind",
  "stage",
  "trigger",
  "cues",
  "applies_to",
  "evidence",
  "graduated_to",
  "upstream",
  "supersedes",
];
export const OPTIONAL_KEYS = ["verified"];

export const TRIGGER_KEYS = [
  "signatures",
  "tools",
  "mcp_tools",
  "formats",
  "hosts",
  "extensions",
  "step_keywords",
];

/** The body's six sections, in the order they must appear. */
export const SECTIONS = [
  { heading: "## Symptom", key: "symptom", required: true },
  { heading: "## Cause", key: "cause", required: false },
  { heading: "## Check first", key: "check_first", required: true },
  { heading: "## Intervention", key: "intervention", required: true },
  { heading: "## Validate", key: "validate", required: true },
  { heading: "## Does NOT apply when", key: "not_when", required: true },
];

export const LIMITS = {
  slug: 80,
  title: 120,
  description: 200,
  tag: 40,
  cues: 300,
  signature: 200,
  tool: 200,
  mcpTool: 80,
  format: 40,
  host: 100,
  extension: 20,
  stepKeyword: 40,
  appliesTo: 200,
  method: 300,
  sourceId: 100,
  sourceText: 200,
  freeText: 200,
  section: 600,
  listItems: 20,
};

export const UNKNOWN_SIGNATURE = "unknown";

/**
 * The signature normalizer, in the locked order: url, email, path, id, n, then
 * truncate, then the empty fallback. The observation contract in `shared/`
 * holds the same table. It is duplicated rather than imported because this
 * script must run with nothing from the brain, and a lesson's signatures and a
 * tool result's signature have to normalize byte for byte the same or the
 * matcher never fires. Change both together.
 *
 * URL before path matters: the other way round, the path rule eats a URL's
 * `//host/a/b` and leaves an `https:` stub behind.
 */
const NORMALIZERS = Object.freeze([
  [/https?:\/\/\S+/g, "<url>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  // Two separators required, so ordinary prose ("and/or") is not read as a
  // path. A single-segment absolute path like /etc is not identifying.
  [/(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s"'`<>|]*[\\/][^\s"'`<>|]*/g, "<path>"],
  [/[0-9a-fA-F]{16,}/g, "<id>"],
  [/\d{5,}/g, "<n>"],
]);

export function normalizeSignature(text) {
  let s = String(text ?? "")
    .split(/\r?\n/)[0]
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, repl] of NORMALIZERS) s = s.replace(re, repl);
  s = s.slice(0, LIMITS.signature).trim();
  return s || UNKNOWN_SIGNATURE;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A plain `YYYY-MM-DD` that is also a real calendar date. */
export function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * Split `---` frontmatter from the body. Line numbers are 1-based so a
 * violation can be clicked in an editor.
 */
export function splitFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  return {
    fmText: lines.slice(1, end).join("\n"),
    fmLines: lines.slice(1, end),
    fmFirstLine: 2,
    body: lines.slice(end + 1).join("\n"),
    bodyFirstLine: end + 2,
  };
}

/** Line of the first frontmatter entry for `key`, at any nesting depth. */
function lineOfKey(split, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s*:`);
  const i = split.fmLines.findIndex((line) => re.test(line));
  return i === -1 ? split.fmFirstLine : split.fmFirstLine + i;
}

/** Split the body on its headings. Returns what was found, not what is legal. */
export function parseSections(body, bodyFirstLine = 1) {
  const lines = body.split("\n");
  const found = [];
  const unexpected = [];
  lines.forEach((line, i) => {
    if (!line.startsWith("#")) return;
    const spec = SECTIONS.find((s) => s.heading === line.trimEnd());
    if (spec) found.push({ spec, index: i, line: bodyFirstLine + i });
    else unexpected.push({ text: line, line: bodyFirstLine + i });
  });
  const sections = {};
  found.forEach((hit, n) => {
    const start = hit.index + 1;
    const end = n + 1 < found.length ? found[n + 1].index : lines.length;
    if (sections[hit.spec.key] !== undefined) return; // first wins; the dup is reported
    sections[hit.spec.key] = { text: lines.slice(start, end).join("\n").trim(), line: hit.line };
  });
  return { found, unexpected, sections };
}

/**
 * Parse a lesson that has already passed `validateLessonFile`. Throws on
 * anything the validator would have rejected, so the build can stay simple.
 */
export function parseLesson(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const split = splitFrontmatter(text);
  if (!split) throw new Error("missing YAML frontmatter");
  const frontmatter = parseYaml(split.fmText, { uniqueKeys: true });
  const { sections } = parseSections(split.body, split.bodyFirstLine);
  const out = {};
  for (const spec of SECTIONS) {
    if (sections[spec.key] !== undefined) out[spec.key] = sections[spec.key].text;
  }
  return { frontmatter, sections: out };
}

function checkStringList(add, line, label, value, { max, pattern, hint, maxItems }) {
  if (!Array.isArray(value)) {
    add(line, `${label} must be a list`);
    return;
  }
  const cap = maxItems ?? LIMITS.listItems;
  if (value.length > cap) add(line, `${label} has ${value.length} entries, max ${cap}`);
  value.forEach((item, i) => {
    const at = `${label}[${i}]`;
    if (typeof item !== "string") return add(line, `${at} must be a string`);
    if (item.length === 0) return add(line, `${at} is empty`);
    if (item.includes("\n")) return add(line, `${at} must be a single line`);
    if (item.length > max) return add(line, `${at} is ${item.length} chars, max ${max}`);
    if (pattern && !pattern.test(item)) add(line, `${at} ${hint} (got ${JSON.stringify(item)})`);
  });
}

function checkScalarString(add, line, label, value, { max, allowEmpty = false }) {
  if (typeof value !== "string") {
    add(line, `${label} must be a string`);
    return false;
  }
  if (!allowEmpty && value.trim().length === 0) {
    add(line, `${label} is empty`);
    return false;
  }
  if (value.includes("\n")) {
    add(line, `${label} must be a single line`);
    return false;
  }
  if (value.length > max) {
    add(line, `${label} is ${value.length} chars, max ${max}`);
    return false;
  }
  return true;
}

function checkEnum(add, line, label, value, allowed) {
  if (!allowed.includes(value)) {
    add(line, `${label} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
  }
}

function checkExactKeys(add, line, label, value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    add(line, `${label} must be a mapping`);
    return false;
  }
  for (const k of keys) if (!(k in value)) add(line, `${label} is missing "${k}"`);
  for (const k of Object.keys(value)) {
    if (!keys.includes(k)) add(line, `${label} has unknown key "${k}"`);
  }
  return true;
}

/** Validate one lesson. `relPath` is `<namespace>/<slug>.md`. */
export function validateLessonFile(relPath, raw) {
  const rel = relPath.split(path.sep).join("/");
  const out = [];
  const add = (line, message) => out.push(`${rel}:${line}: ${message}`);
  const text = raw.replace(/\r\n/g, "\n");

  const parts = rel.split("/");
  if (parts.length !== 2) {
    add(1, "a lesson lives at lessons/<namespace>/<slug>.md");
  } else {
    const [ns, file] = parts;
    const slug = file.replace(/\.md$/, "");
    if (!NAMESPACES.includes(ns)) {
      add(1, `namespace must be one of ${NAMESPACES.join(", ")} (got ${JSON.stringify(ns)})`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      add(1, `slug must be lowercase words joined by hyphens (got ${JSON.stringify(slug)})`);
    }
    if (slug.length > LIMITS.slug) {
      add(1, `slug is ${slug.length} chars, max ${LIMITS.slug}`);
    }
  }

  // Printable ASCII only, everywhere. A smart quote or a Unicode em-dash in a
  // lesson reaches the model as whatever the consumer's encoding makes of it,
  // and the repo writes em-dashes as `--` anyway.
  const odd = /[^\t\n\x20-\x7e]/.exec(text);
  if (odd) {
    const line = text.slice(0, odd.index).split("\n").length;
    // Reported as a codepoint: an em-dash, an en-dash and a non-breaking hyphen
    // are indistinguishable in a terminal and the fix differs for each.
    const point = odd[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    add(line, `non-ASCII character U+${point}; write em-dashes as --`);
  }

  const split = splitFrontmatter(text);
  if (!split) {
    add(1, "missing YAML frontmatter: the file must open with --- and close it with ---");
    return out;
  }

  let fm;
  try {
    fm = parseYaml(split.fmText, { uniqueKeys: true });
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    add(split.fmFirstLine, `frontmatter is not valid YAML: ${message}`);
    return out;
  }
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) {
    add(split.fmFirstLine, "frontmatter must be a YAML mapping");
    return out;
  }

  const at = (key) => lineOfKey(split, key);
  for (const key of REQUIRED_KEYS) {
    if (!(key in fm)) add(split.fmFirstLine, `missing required frontmatter key "${key}"`);
  }
  for (const key of Object.keys(fm)) {
    if (!REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) {
      add(at(key), `unknown frontmatter key "${key}"`);
    }
  }

  if ("type" in fm && fm.type !== "Lesson") {
    add(at("type"), `type must be exactly "Lesson" (got ${JSON.stringify(fm.type)})`);
  }
  if ("title" in fm) checkScalarString(add, at("title"), "title", fm.title, { max: LIMITS.title });
  if ("description" in fm) {
    checkScalarString(add, at("description"), "description", fm.description, {
      max: LIMITS.description,
    });
  }
  if ("tags" in fm) {
    checkStringList(add, at("tags"), "tags", fm.tags, { max: LIMITS.tag });
  }
  if ("status" in fm) checkEnum(add, at("status"), "status", fm.status, STATUSES);

  if (
    "generated" in fm &&
    checkExactKeys(add, at("generated"), "generated", fm.generated, ["by", "at"])
  ) {
    const line = at("generated");
    if (
      typeof fm.generated.by !== "string" ||
      !/^(?:agent|human):[A-Za-z0-9._/@-]{1,80}$/.test(fm.generated.by)
    ) {
      add(line, 'generated.by must look like "agent:loom/0.8.0" or "human:loom-maintainers"');
    }
    if (!isIsoDate(fm.generated.at)) add(line, "generated.at must be a YYYY-MM-DD date string");
  }

  if ("verified" in fm) {
    const line = at("verified");
    if (!Array.isArray(fm.verified)) add(line, "verified must be a list");
    else {
      fm.verified.forEach((entry, i) => {
        if (!checkExactKeys(add, line, `verified[${i}]`, entry, ["by", "at"])) return;
        // Maintainer pseudonyms only. A contributor id here would publish an
        // identity into the snapshot and the public index.
        if (typeof entry.by !== "string" || !/^human:[A-Za-z0-9._-]{1,60}$/.test(entry.by)) {
          add(line, `verified[${i}].by must look like "human:<pseudonym>"`);
        }
        if (!isIsoDate(entry.at)) add(line, `verified[${i}].at must be a YYYY-MM-DD date string`);
      });
    }
  }

  if ("stale_after" in fm && !isIsoDate(fm.stale_after)) {
    add(at("stale_after"), "stale_after must be a YYYY-MM-DD date string");
  }

  if ("sources" in fm) {
    const line = at("sources");
    if (!Array.isArray(fm.sources)) add(line, "sources must be a list");
    else {
      if (fm.sources.length > LIMITS.listItems) {
        add(line, `sources has ${fm.sources.length} entries, max ${LIMITS.listItems}`);
      }
      fm.sources.forEach((entry, i) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          add(line, `sources[${i}] must be a mapping with an id`);
          return;
        }
        for (const k of Object.keys(entry)) {
          if (!["id", "resource", "title"].includes(k)) {
            add(line, `sources[${i}] has unknown key "${k}"`);
          }
        }
        checkScalarString(add, line, `sources[${i}].id`, entry.id, { max: LIMITS.sourceId });
        for (const k of ["resource", "title"]) {
          if (entry[k] !== undefined) {
            checkScalarString(add, line, `sources[${i}].${k}`, entry[k], {
              max: LIMITS.sourceText,
            });
          }
        }
      });
    }
  }

  if ("kind" in fm) checkEnum(add, at("kind"), "kind", fm.kind, KINDS);

  if ("stage" in fm) {
    const line = at("stage");
    if (!Array.isArray(fm.stage) || fm.stage.length === 0) {
      add(line, "stage must be a non-empty list");
    } else {
      const seen = new Set();
      fm.stage.forEach((s, i) => {
        checkEnum(add, line, `stage[${i}]`, s, STAGES);
        if (seen.has(s)) add(line, `stage lists ${JSON.stringify(s)} twice`);
        seen.add(s);
      });
    }
  }

  if ("trigger" in fm && checkExactKeys(add, at("trigger"), "trigger", fm.trigger, TRIGGER_KEYS)) {
    const t = fm.trigger;
    const rules = {
      // A signature has to be stored the way the matcher will see it, so a
      // signature that normalization would change can never match anything.
      signatures: { max: LIMITS.signature },
      tools: {
        max: LIMITS.tool,
        pattern: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
        hint: "must be a Galaxy tool id or family",
      },
      mcp_tools: {
        max: LIMITS.mcpTool,
        pattern: /^galaxy_[a-z0-9_]+$/,
        hint: "must be a galaxy_* MCP tool name",
      },
      formats: {
        max: LIMITS.format,
        pattern: /^[a-z0-9][a-z0-9._-]*$/,
        hint: "must be a lowercase Galaxy datatype or extension name",
      },
      hosts: {
        max: LIMITS.host,
        pattern: /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/,
        hint: "must be a bare hostname, no scheme and no path",
      },
      extensions: {
        max: LIMITS.extension,
        pattern: /^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/,
        hint: "must be a lowercase dotted extension",
      },
      step_keywords: {
        max: LIMITS.stepKeyword,
        pattern: /^[a-z0-9][a-z0-9 '+./-]*$/,
        hint: "must be lowercase words matched against plan-step text",
      },
    };
    for (const key of TRIGGER_KEYS) {
      checkStringList(add, at(key), `trigger.${key}`, t[key], rules[key]);
    }
    if (Array.isArray(t.signatures)) {
      t.signatures.forEach((sig, i) => {
        if (typeof sig !== "string") return;
        const normalized = normalizeSignature(sig);
        if (normalized !== sig) {
          add(
            at("signatures"),
            `trigger.signatures[${i}] is not normalized; store ${JSON.stringify(normalized)}`,
          );
        }
      });
    }
    const matchable = TRIGGER_KEYS.some((k) => Array.isArray(t[k]) && t[k].length > 0);
    if (!matchable) {
      add(
        at("trigger"),
        "trigger has nothing machine-matchable; a lesson nothing can match is documentation",
      );
    }
  }

  if ("cues" in fm) checkScalarString(add, at("cues"), "cues", fm.cues, { max: LIMITS.cues });

  if (
    "applies_to" in fm &&
    checkExactKeys(add, at("applies_to"), "applies_to", fm.applies_to, ["versions", "tested"])
  ) {
    for (const k of ["versions", "tested"]) {
      checkScalarString(add, at("applies_to"), `applies_to.${k}`, fm.applies_to[k], {
        max: LIMITS.appliesTo,
      });
    }
  }

  if (
    "evidence" in fm &&
    checkExactKeys(add, at("evidence"), "evidence", fm.evidence, [
      "symptom",
      "cause",
      "outcome",
      "method",
    ])
  ) {
    const line = at("evidence");
    for (const k of ["symptom", "cause", "outcome"]) {
      checkEnum(add, line, `evidence.${k}`, fm.evidence[k], EVIDENCE[k]);
    }
    checkScalarString(add, line, "evidence.method", fm.evidence.method, { max: LIMITS.method });
  }

  for (const key of ["graduated_to", "upstream"]) {
    if (key in fm) checkStringList(add, at(key), key, fm[key], { max: LIMITS.freeText });
  }
  if ("supersedes" in fm) {
    checkStringList(add, at("supersedes"), "supersedes", fm.supersedes, {
      max: LIMITS.sourceId,
      pattern: new RegExp(`^(?:${NAMESPACES.join("|")})/[a-z0-9]+(?:-[a-z0-9]+)*$`),
      hint: "must be a lesson id like stats/na-coerced-to-zero-in-filters",
    });
  }

  // The namespace is the contract: galaxy-api is where lessons go once the
  // durable fix ships somewhere else, and `graduated_to` is what stops the
  // matcher surfacing them.
  if (parts[0] === "galaxy-api" && Array.isArray(fm.graduated_to) && fm.graduated_to.length === 0) {
    add(
      at("graduated_to"),
      "a galaxy-api lesson must say where the durable fix lives in graduated_to",
    );
  }

  out.push(...validateBody(rel, split));
  return out;
}

function validateBody(rel, split) {
  const out = [];
  const add = (line, message) => out.push(`${rel}:${line}: ${message}`);
  const { found, unexpected, sections } = parseSections(split.body, split.bodyFirstLine);

  for (const bad of unexpected) {
    add(
      bad.line,
      `unexpected heading ${JSON.stringify(bad.text.trimEnd())}; only the six lesson sections are allowed`,
    );
  }

  const seen = new Set();
  for (const hit of found) {
    if (seen.has(hit.spec.key))
      add(hit.line, `duplicate section ${JSON.stringify(hit.spec.heading)}`);
    seen.add(hit.spec.key);
  }
  for (const spec of SECTIONS) {
    if (spec.required && !seen.has(spec.key)) {
      add(split.bodyFirstLine, `missing required section ${JSON.stringify(spec.heading)}`);
    }
  }

  const order = SECTIONS.map((s) => s.key).filter((k) => seen.has(k));
  const actual = [];
  for (const hit of found) if (!actual.includes(hit.spec.key)) actual.push(hit.spec.key);
  if (actual.join(",") !== order.join(",")) {
    add(
      split.bodyFirstLine,
      `sections are out of order; the order is ${SECTIONS.map((s) => s.heading).join(", ")}`,
    );
  }

  for (const [key, section] of Object.entries(sections)) {
    if (section.text.length === 0) add(section.line, `section ${key} is empty`);
    else if (section.text.length > LIMITS.section) {
      add(section.line, `section ${key} is ${section.text.length} chars, max ${LIMITS.section}`);
    }
  }

  const bodyLines = split.body.split("\n");
  bodyLines.forEach((line, i) => {
    const at = split.bodyFirstLine + i;
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) {
      add(at, "no fenced code blocks in a lesson body; a short inline span is fine");
    }
    if (/https?:\/\//.test(line)) add(at, "no URLs in a lesson body; put provenance in sources");
    if (/\[[^\]\n]*\]\([^)\n]*\)/.test(line)) add(at, "no markdown links in a lesson body");
  });

  return out;
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
