/**
 * The C3 lesson schema (OKF, v1) as code. The rules here ARE the schema.
 *
 * One implementation, two consumers: `lessons/validate.mjs` runs it over the
 * curated corpus in CI, and the brain runs it over an agent-drafted proposal
 * before anything reaches disk. A second copy would drift, and the schema is
 * a security boundary -- a proposal's draft is assembled from session content
 * that may include hostile tool output, so "the validator rejects it" is what
 * stands between that content and a file later sessions read.
 *
 * Every bound below is a content control rather than a tidiness preference. A
 * lesson ships inside the package to every install, and the published snapshot
 * goes into a public index, so a lesson must not carry anything to follow (no
 * URLs, no markdown links), anything to run (no fenced code), or anything
 * identifying (no paths, hex ids, uuids, IPs or email addresses anywhere, and no
 * URLs outside the fields the schema says may hold a link, which take https only).
 * The regexes catch shapes, not meaning: a private hostname written as prose, a
 * person's name or a copied data value still needs a human reviewer.
 *
 * Dual-file (.js runtime + hand-written .d.ts) like shared/feedback-contract.js.
 * UNLIKE that file this one imports `yaml` and `node:path`, so it is Node/brain
 * side only: never import it from app/src/renderer.
 */

import path from "node:path";
import { isAlias, parseDocument, visit } from "yaml";

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
  minSignature: 8,
  fileBytes: 16384,
};

export const UNKNOWN_SIGNATURE = "unknown";

/**
 * The signature normalizer, in the locked order: url, email, path, id, n, then
 * truncate, then the empty fallback. The observation contract holds the same
 * table, and a lesson's signatures and a tool result's signature have to
 * normalize byte for byte the same or the matcher never fires. Change both
 * together, or better, make one import the other.
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

/**
 * Shapes that point at a person, a machine or a dataset. The observation
 * validator's list, minus its hid/dataset/history-followed-by-a-number rule:
 * lessons talk about hids in the abstract and that rule would reject them.
 */
const IDENTIFYING = [
  [
    "a URL",
    // A scheme, a script-ish scheme with no slashes, a protocol-relative
    // //host, or a scheme-less host/path.
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/|\b(?:javascript|data|vbscript|file):|(?:^|[\s(<"'=])\/\/[A-Za-z0-9]|\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\/\S/i,
  ],
  ["a home-directory path", /\/(?:Users|home|root)\/|~[A-Za-z0-9._-]*[\\/]/i],
  ["an absolute path", /(?:^|[\s(<"'=:,])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]/],
  ["a Windows path", /\b[A-Za-z]:[\\/]|\\\\[A-Za-z0-9.-]+\\/],
  ["a hex id of 16+ characters", /[0-9a-fA-F]{16,}/],
  ["a uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  [
    "an IP address",
    /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|\bfe80::/i,
  ],
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];

/** Fields C3 allows to carry a link. Everything else in a lesson may not. */
const LINK_FIELDS = ["graduated_to", "upstream", "sources.resource"];

/**
 * Problems with one link in a field that may hold links. https only, nothing
 * that identifies who fetched it (credentials, query, fragment), and the path
 * still gets the home-directory and email checks.
 */
function linkProblems(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return ["a malformed URL"];
  }
  const out = [];
  if (url.protocol !== "https:") out.push("a non-https URL");
  if (url.username || url.password) out.push("credentials in a URL");
  if (url.search || url.hash) out.push("a query or fragment in a URL");
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    out.push("a malformed URL");
  }
  for (const name of ["a home-directory path", "a Windows path", "an email address"]) {
    const re = IDENTIFYING.find(([n]) => n === name)[1];
    if (re.test(pathname)) out.push(`${name} inside a URL`);
  }
  return out;
}

/**
 * Names of the identifying shapes in `text`. With `allowUrls`, each URL is
 * checked as a link and the rest of the text is checked as usual.
 */
export function identifyingShapes(text, { allowUrls = false } = {}) {
  const out = [];
  let s = text;
  if (allowUrls) {
    s = text.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g, (link) => {
      out.push(...linkProblems(link));
      return " ";
    });
  }
  for (const [name, re] of IDENTIFYING) if (re.test(s)) out.push(name);
  return [...new Set(out)];
}

/**
 * Parse frontmatter YAML strictly. Comments are refused because they ship in
 * the raw file and nothing else checks them; anchors, aliases and explicit tags
 * because a lesson has no use for them and each one is a way to make the
 * parsed value differ from what a reviewer reads.
 */
export function loadFrontmatter(fmText) {
  const doc = parseDocument(fmText, { uniqueKeys: true, prettyErrors: false });
  const problems = [...doc.errors, ...doc.warnings].map(
    (e) => `frontmatter is not valid YAML: ${e.message.split("\n")[0]}`,
  );
  let comments = Boolean(doc.commentBefore || doc.comment);
  let fancy = false;
  visit(doc, {
    Node(_, node) {
      if (node.commentBefore || node.comment) comments = true;
      if (isAlias(node) || node.anchor || node.tag) fancy = true;
    },
  });
  if (comments) problems.push("no YAML comments in frontmatter; they ship unchecked");
  if (fancy) problems.push("no YAML anchors, aliases or explicit tags in frontmatter");
  return { value: problems.length > 0 ? undefined : doc.toJS(), problems };
}

function eachString(value, label, visit) {
  if (typeof value === "string") visit(label, value);
  else if (Array.isArray(value)) value.forEach((v, i) => eachString(v, `${label}[${i}]`, visit));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) eachString(v, label ? `${label}.${k}` : k, visit);
  }
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
 * Parse a lesson into its frontmatter and body sections. Never throws: a
 * structural failure (no frontmatter, YAML the strict loader refuses, a
 * frontmatter that is not a mapping, a file over the byte cap) comes back as
 * `frontmatter: null` with `"<line>: <message>"` entries in `errors`.
 *
 * This is a parser, not the validator. A lesson that parses can still break
 * every content rule; callers that act on a lesson run validateLessonMarkdown
 * (or validateLessonFile) first.
 */
export function parseLesson(raw) {
  const empty = { frontmatter: null, sections: {}, lines: {}, errors: [] };
  if (typeof raw !== "string") return { ...empty, errors: ["1: lesson is not text"] };
  // Before the YAML parse, so a planted huge file costs one byte count.
  if (Buffer.byteLength(raw, "utf8") > LIMITS.fileBytes) {
    return { ...empty, errors: [`1: file is over ${LIMITS.fileBytes} bytes`] };
  }
  const text = raw.replace(/\r\n/g, "\n");
  const split = splitFrontmatter(text);
  if (!split) return { ...empty, errors: ["1: missing YAML frontmatter"] };
  let loaded;
  try {
    loaded = loadFrontmatter(split.fmText);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return {
      ...empty,
      errors: [`${split.fmFirstLine}: frontmatter is not valid YAML: ${message}`],
    };
  }
  if (loaded.problems.length > 0) {
    return { ...empty, errors: loaded.problems.map((p) => `${split.fmFirstLine}: ${p}`) };
  }
  const frontmatter = loaded.value;
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return { ...empty, errors: [`${split.fmFirstLine}: frontmatter must be a YAML mapping`] };
  }

  const lines = {};
  for (const key of Object.keys(frontmatter)) {
    const i = split.fmLines.findIndex((line) => line.startsWith(`${key}:`));
    lines[key] = i === -1 ? split.fmFirstLine : split.fmFirstLine + i;
  }
  const { sections: found } = parseSections(split.body, split.bodyFirstLine);
  const sections = {};
  for (const spec of SECTIONS) {
    if (found[spec.key] === undefined) continue;
    sections[spec.key] = found[spec.key].text;
    lines[spec.key] = found[spec.key].line;
  }
  return { frontmatter, sections, lines, errors: [] };
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

/**
 * Every violation in one lesson, as `{ line, message }`. `rel` is the lesson's
 * `<namespace>/<slug>.md` when it has one; null skips the checks that only a
 * path can answer (namespace, slug, the galaxy-api graduation rule).
 */
function lessonViolations(raw, rel) {
  const out = [];
  const add = (line, message) => out.push({ line, message });
  const text = raw.replace(/\r\n/g, "\n");

  // A proposal has no path yet; its caller checks namespace and slug itself.
  const parts = rel === null ? [] : rel.split("/");
  if (rel !== null && parts.length !== 2) {
    add(1, "a lesson lives at lessons/<namespace>/<slug>.md");
  } else if (rel !== null) {
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
  if (Buffer.byteLength(raw, "utf8") > LIMITS.fileBytes) {
    add(1, `file is ${Buffer.byteLength(raw, "utf8")} bytes, max ${LIMITS.fileBytes}`);
    return out;
  }

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

  // The raw lines too, so a comment or anything else the parser drops is still
  // held to the identifying-data rules. Links are judged as links here because
  // the line-to-field mapping is not known; the parsed check below is strict.
  split.fmLines.forEach((line, i) => {
    for (const shape of identifyingShapes(line, { allowUrls: true })) {
      add(split.fmFirstLine + i, `frontmatter line contains ${shape}; lessons carry none`);
    }
  });

  let fm;
  try {
    const loaded = loadFrontmatter(split.fmText);
    if (loaded.problems.length > 0) {
      for (const p of loaded.problems) add(split.fmFirstLine, p);
      return out;
    }
    fm = loaded.value;
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
      if (fm.verified.length > LIMITS.listItems) {
        add(line, `verified has ${fm.verified.length} entries, max ${LIMITS.listItems}`);
      }
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
        if (sig === UNKNOWN_SIGNATURE || sig.length < LIMITS.minSignature) {
          add(
            at("signatures"),
            `trigger.signatures[${i}] is too generic to match on; quote the distinctive part of the error`,
          );
        }
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

  // Every string, not just the prose fields: a title, a cue or a source id
  // reaches the snapshot and the public index exactly like the body does.
  eachString(fm, "", (label, value) => {
    // The file-level ASCII check reads raw bytes, and a YAML escape like "\u202e"
    // is ASCII on disk. This is the check that sees the decoded value.
    const bad = /[^\x20-\x7e]/.exec(value);
    if (bad) {
      const point = bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
      add(
        at(label.split(/[.[]/)[0]),
        `${label} contains control or non-ASCII character U+${point}`,
      );
    }
    const allowUrls = LINK_FIELDS.includes(label.replace(/\[\d+\]/g, ""));
    for (const shape of identifyingShapes(value, { allowUrls })) {
      add(at(label.split(/[.[]/)[0]), `${label} contains ${shape}; lessons carry none`);
    }
  });

  validateBody(split, add);
  return out;
}

function validateBody(split, add) {
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
  // Everything before the first heading is dropped from the snapshot but still
  // ships in the raw file, so it has to be empty.
  const firstHeading = found.length > 0 ? found[0].index : bodyLines.length;
  const preamble = bodyLines.slice(0, firstHeading).findIndex((l) => l.trim() !== "");
  if (preamble !== -1) {
    add(split.bodyFirstLine + preamble, "no text before the first section heading");
  }

  bodyLines.forEach((line, i) => {
    const at = split.bodyFirstLine + i;
    // Anywhere on the line, so a fence inside a blockquote or a list item counts.
    if (/`{3,}|~{3,}/.test(line)) {
      add(at, "no fenced code blocks in a lesson body; a short inline span is fine");
    }
    if (/^(?: {4,}|\t)\S/.test(line)) add(at, "no indented code blocks in a lesson body");
    if (!line.startsWith("#") && /^[ \t>*+-]*#{1,6}(?:\s|$)/.test(line)) {
      add(at, "unexpected heading; only the six lesson sections are allowed");
    }
    if (/^ {0,3}(?:=+|-+|\*{3,}|_{3,})\s*$/.test(line)) {
      add(at, "no setext headings or horizontal rules in a lesson body");
    }
    if (/<[A-Za-z!/?]/.test(line.replace(/`[^`]*`/g, ""))) {
      add(at, "no HTML in a lesson body");
    }
    for (const shape of identifyingShapes(line)) {
      if (shape === "a URL") add(at, "no URLs in a lesson body; put provenance in sources");
      else add(at, `${shape} in a lesson body; lessons carry none`);
    }
    // `](` and `][` rather than a whole `[text](target)`: link text and
    // target can be split across lines, and reference definitions stand alone.
    if (/\]\(|\]\[|^\s*\[[^\]]+\]:/.test(line)) add(at, "no markdown links in a lesson body");
  });
}

/** Validate one corpus lesson. `relPath` is `<namespace>/<slug>.md`. */
export function validateLessonFile(relPath, raw) {
  const rel = relPath.split(path.sep).join("/");
  return lessonViolations(raw, rel).map((v) => `${rel}:${v.line}: ${v.message}`);
}

/**
 * Validate a lesson's bytes with no path attached -- a proposal before it has
 * been written anywhere. Errors are `"<line>: <message>"`. Run it on exactly
 * the bytes that will be shown and saved: a check on anything upstream of
 * those (the structured input, a sanitised copy) checks the wrong thing.
 */
export function validateLessonMarkdown(text) {
  if (typeof text !== "string") return { ok: false, errors: ["1: lesson is not text"] };
  const errors = lessonViolations(text, null).map((v) => `${v.line}: ${v.message}`);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// The names the brain side uses. Aliases of the tables above rather than
// second copies, so a bound changes in exactly one place.
export const LESSON_NAMESPACES = NAMESPACES;
/**
 * `galaxy-api` holds lessons that graduated upstream and are kept unsurfaced,
 * so a new proposal can never land there -- it would be hidden on arrival.
 */
export const PROPOSABLE_NAMESPACES = NAMESPACES.filter((ns) => ns !== "galaxy-api");
export const LESSON_KINDS = KINDS;
export const LESSON_STAGES = STAGES;
export const LESSON_STATUSES = STATUSES;
export const EVIDENCE_SYMPTOM = EVIDENCE.symptom;
export const EVIDENCE_CAUSE = EVIDENCE.cause;
export const EVIDENCE_OUTCOME = EVIDENCE.outcome;
/** SECTIONS with the bare heading text, for code that writes a body. */
export const BODY_SECTIONS = SECTIONS.map((s) => ({
  heading: s.heading.replace(/^## /, ""),
  key: s.key,
  required: s.required,
}));
export const FRONTMATTER_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
export const REQUIRED_FRONTMATTER_KEYS = REQUIRED_KEYS;

export const MAX_FILE_BYTES = LIMITS.fileBytes;
export const MAX_TITLE = LIMITS.title;
export const MAX_DESCRIPTION = LIMITS.description;
export const MAX_SECTION = LIMITS.section;
export const MAX_CUES = LIMITS.cues;
export const MAX_METHOD = LIMITS.method;
export const MAX_SIGNATURE = LIMITS.signature;
export const MIN_SIGNATURE = LIMITS.minSignature;
export const MAX_TRIGGER_ITEM = LIMITS.tool;
export const MAX_TRIGGER_ITEMS = LIMITS.listItems;
export const MAX_TAG = LIMITS.tag;
export const MAX_TAGS = LIMITS.listItems;
export const MAX_SOURCES = LIMITS.listItems;
export const MAX_VERIFIED = LIMITS.listItems;
export const MAX_GENERIC_STRING = LIMITS.freeText;
export const MAX_SLUG = LIMITS.slug;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidLessonNamespace(value) {
  return typeof value === "string" && NAMESPACES.includes(value);
}

export function isValidLessonSlug(value) {
  return typeof value === "string" && value.length <= LIMITS.slug && SLUG_RE.test(value);
}

/**
 * `stats/na-coerced-to-zero-in-filters.md` -> `stats/na-coerced-to-zero-in-filters`.
 * Null for anything that is not exactly `<namespace>/<slug>.md`: a deeper path,
 * a `..` segment, an unknown namespace, a non-slug basename. Windows separators
 * are accepted so a win32 `path.relative` resolves the same.
 */
export function lessonIdFromPath(relPath) {
  if (typeof relPath !== "string") return null;
  const parts = relPath.split(/[\\/]/);
  if (parts.length !== 2) return null;
  const [namespace, file] = parts;
  if (!isValidLessonNamespace(namespace) || !file.endsWith(".md")) return null;
  const slug = file.slice(0, -3);
  return isValidLessonSlug(slug) ? `${namespace}/${slug}` : null;
}
