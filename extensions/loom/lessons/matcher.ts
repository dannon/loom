/**
 * Lesson trigger matching. Pure -- no fs, no config, no pi, no clock. Every
 * input is passed in, which is what lets the table be tested exhaustively and
 * what lets one implementation answer for a live tool result, a plan step and
 * an eval fixture.
 *
 * Three deliberate properties:
 *
 * - **`isError` is not an input.** A lesson fires on what a result SAYS, not on
 *   whether pi called it an error. Galaxy reports a failed invocation inside a
 *   perfectly successful tool result (`invocation-failure-hint.ts` relies on
 *   the same thing), so gating on `isError` would miss the cases that matter.
 * - **A lesson with a non-empty `graduated_to` never matches.** Its advice
 *   already ships somewhere else, and surfacing both is noise. The lesson stays
 *   in the corpus as the record of what happened.
 * - **Signatures are matched after normalizing BOTH sides with C1's own
 *   function.** A stored signature already carries C1's placeholders, so a raw
 *   substring test could never hit, and a second implementation of those rules
 *   would drift from the one that normalized the corpus. Two matching-only
 *   additions on top: it is applied PER LINE (its "first line only" clause
 *   turns one error into one signature; applied to a whole tool result it would
 *   see only line 1), and both sides are lowercased, because a lesson author
 *   will not match the tool's capitalization.
 */

import { normalizeSignature, UNKNOWN_SIGNATURE } from "../../../shared/observation-contract.js";
import { GALAXY_MCP_PREFIX, galaxyMcpToolName } from "../../../shared/galaxy-mcp-tools.js";
import type { Lesson, Match, MatchTrigger } from "./types";

/** Lower is more specific, so a signature hit beats an ambient step-text hit. */
const TRIGGER_RANK: Record<MatchTrigger, number> = {
  signature: 0,
  tool: 1,
  host: 2,
  extension: 3,
  step_keyword: 4,
  search: 5,
};

/** Caps so a hostile result or a pathological lesson cannot burn the turn. */
const MAX_RESULT_CHARS = 200_000;
const MAX_ARG_CHARS = 20_000;
const MAX_VALUE_DEPTH = 6;
const MAX_VALUES = 500;
const MAX_STEP_CHARS = 4_000;

/** A short "signature" would match nearly every result (C3 sets the same floor). */
const MIN_SIGNATURE_CHARS = 8;

/** Shorter than this a tool id or keyword cannot discriminate. */
const MIN_TOOL_CHARS = 3;

/**
 * `normalizeSignature` keeps one line and truncates at 200 (C1's cap), so a
 * long single line -- a serialized JSON blob, a stack frame -- is scanned in
 * overlapping windows instead. Each window's normalized text is itself cut at
 * 200, so a window starting at most STRIDE characters before a signature
 * holds it whole when the signature normalizes to at most 200 - STRIDE = 150
 * characters. Longer signatures (C1 allows 200) can be missed on lines over
 * WINDOW characters; the shipped corpus tops out well under 100.
 */
const WINDOW = 256;
const STRIDE = 50;

/** Every line of the result, run through `normalizeSignature` and lowercased. */
export function matchHaystack(resultText: string): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const normalized = normalizeSignature(raw);
    if (normalized !== UNKNOWN_SIGNATURE) out.push(normalized.toLowerCase());
  };

  for (const line of resultText.slice(0, MAX_RESULT_CHARS).split("\n")) {
    if (!line.trim()) continue;
    if (line.length <= WINDOW) {
      push(line);
      continue;
    }
    // Run to the very end: the window that first touches it is also cut at
    // 200 once normalized, so the line's tail needs the shorter ones too.
    for (let i = 0; i < line.length; i += STRIDE) push(line.slice(i, i + WINDOW));
  }
  return out;
}

/**
 * Every string VALUE in a call's arguments, recursively. Values only: matching
 * key names would let a lesson fire on a schema field rather than on data.
 */
export function collectStringValues(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_VALUE_DEPTH || out.length >= MAX_VALUES) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const v of value) collectStringValues(v, depth + 1, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStringValues(v, depth + 1, out);
  }
  return out;
}

const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/([^/?#\s"'`\\]+)/gi;

export function extractHosts(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_HOST)) {
    let host = m[1];
    const at = host.lastIndexOf("@");
    if (at >= 0) host = host.slice(at + 1);
    host = host.replace(/:\d*$/, "").replace(/\.$/, "").toLowerCase();
    if (host) out.add(host);
  }
  return out;
}

/**
 * A lesson host matches the exact host or any subdomain of it, on a dot
 * boundary. Without the boundary `ncbi.nlm.nih.gov` would also match
 * `evilncbi.nlm.nih.gov`.
 */
export function hostMatches(seen: Set<string>, want: string): boolean {
  const w = want.trim().toLowerCase().replace(/^\.+/, "");
  if (!w) return false;
  for (const host of seen) {
    if (host === w || host.endsWith(`.${w}`)) return true;
  }
  return false;
}

/**
 * Letter-led, so a version segment (`tool/2.0.1`) never reads as an extension.
 * A following `.` counts as a boundary because double suffixes are everywhere
 * here -- `.fastq.gz` has to yield both halves.
 */
const EXT_TOKEN = /\.([A-Za-z][A-Za-z0-9]{0,7})(?=[."'\s,;:)\]}\\]|$)/g;

export function extractExtensions(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(EXT_TOKEN)) out.add(m[1].toLowerCase());
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A lesson extension (".gtf", ".tsv.gz") on the end of a file name somewhere
 * in the arguments. Matched as one dotted unit so a two-part extension means
 * what its author wrote, and anchored on a name character before the dot so a
 * bare ".gtf" in prose is not a file.
 */
export function extensionMatches(haystack: string, want: string): boolean {
  const w = want.trim().toLowerCase().replace(/^\.+/, "");
  if (!w) return false;
  const re = new RegExp(`[A-Za-z0-9_-]\\.${escapeRegExp(w)}(?![A-Za-z0-9])`, "i");
  return re.test(haystack);
}

/**
 * `<host>/repos/<owner>/<repo>/<name>[/<version>]` -> `<name>`. Lesson tool
 * triggers are short ids or families (C3 forbids `/` in them), while a Galaxy
 * call carries the full ToolShed GUID, so the GUID's name segment is the part
 * a lesson can name.
 */
const TOOLSHED_GUID =
  /^(?:https?:\/\/)?[^/\s]+\/repos\/[^/\s]+\/[^/\s]+\/([^/\s]+)(?:\/[^/\s]+)?$/i;

/**
 * Every string argument that could be a tool id, as lowercased candidates: the
 * value itself (a bare id like `Filter1`) and, for a ToolShed GUID, its name
 * segment. A lesson's `trigger.tools` entry has to equal one of them.
 */
export function toolCandidates(values: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of values) {
    const v = raw.trim();
    if (!v || v.length > 300) continue;
    out.add(v.toLowerCase());
    const guid = TOOLSHED_GUID.exec(v);
    if (guid) out.add(guid[1].toLowerCase());
  }
  return out;
}

export function toolMatches(candidates: Set<string>, want: string): boolean {
  const w = want.trim().toLowerCase();
  return w.length >= MIN_TOOL_CHARS && candidates.has(w);
}

/**
 * The Galaxy tool behind a name, or undefined when it is not one. A
 * `mcp__galaxy__` name goes through galaxyMcpToolName, so another server that
 * shares the prefix (`mcp__galaxy___x`, `mcp__galaxy__a__x`, a server named
 * "Galaxy") is not galaxy-mcp. The remainder is held to galaxy-mcp's own name
 * shape -- no leading "_", no "__" -- on both sides, so a lesson naming
 * `galaxy__x` cannot line up with such a server either.
 */
function galaxyToolOf(name: string): string | undefined {
  const raw = name.trim();
  const tool = raw.startsWith(GALAXY_MCP_PREFIX)
    ? galaxyMcpToolName(raw)
    : raw.toLowerCase().startsWith("galaxy_")
      ? raw.slice("galaxy_".length)
      : raw;
  if (!tool || tool.startsWith("_") || tool.includes("__")) return undefined;
  return tool.toLowerCase();
}

/**
 * Compared after stripping either prefix from both sides, so a lesson written
 * against `galaxy_run_tool` still fires when the call arrived as
 * `mcp__galaxy__run_tool`.
 */
export function mcpToolMatches(toolName: string, want: string): boolean {
  const a = galaxyToolOf(toolName);
  const b = galaxyToolOf(want);
  return a !== undefined && b !== undefined && a === b;
}

export function isMatchable(lesson: Lesson): boolean {
  return !(lesson.graduated_to ?? []).some((g) => typeof g === "string" && g.trim().length > 0);
}

function firstHit(
  trigger: MatchTrigger,
  values: readonly string[] | undefined,
  test: (value: string) => boolean,
): { trigger: MatchTrigger; matched: string } | null {
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    if (test(value)) return { trigger, matched: value };
  }
  return null;
}

function originRank(lesson: Lesson): number {
  // A lesson you recorded yourself is about your machine and your data, so on
  // an equal trigger it goes ahead of the shipped corpus.
  return lesson.origin === "user" ? 0 : 1;
}

function rank(matches: Match[]): Match[] {
  return matches.sort((a, b) => {
    const byTrigger = TRIGGER_RANK[a.trigger] - TRIGGER_RANK[b.trigger];
    if (byTrigger !== 0) return byTrigger;
    const byOrigin = originRank(a.lesson) - originRank(b.lesson);
    if (byOrigin !== 0) return byOrigin;
    return a.lesson.id < b.lesson.id ? -1 : a.lesson.id > b.lesson.id ? 1 : 0;
  });
}

export interface ToolEventInput {
  /**
   * pi's tool name: galaxy-mcp tools as `mcp__galaxy__<name>`, Loom's own as
   * `galaxy_<name>`. mcpToolMatches strips either prefix, so a lesson can name
   * the tool either way.
   */
  toolName: string;
  /** The call's arguments. */
  input: Record<string, unknown>;
  /** Every text block of the result, joined with newlines. */
  resultText: string;
}

/** One match per lesson, most specific trigger first. */
export function matchToolEvent(ev: ToolEventInput, lessons: readonly Lesson[]): Match[] {
  const lines = matchHaystack(ev.resultText);
  const values = collectStringValues(ev.input);
  const args = values.join("\n").slice(0, MAX_ARG_CHARS);
  const hosts = extractHosts(args);
  const exts = extractExtensions(args);
  const tools = toolCandidates(values);
  const argValues = new Set(values.map((v) => v.trim().toLowerCase()));

  const out: Match[] = [];
  for (const lesson of lessons) {
    if (!isMatchable(lesson)) continue;
    const t = lesson.trigger ?? {};
    const hit =
      firstHit("signature", t.signatures, (s) => {
        // Normalized on this side too: a corpus signature already is, and the
        // function is idempotent.
        const needle = normalizeSignature(s).toLowerCase();
        return (
          needle !== UNKNOWN_SIGNATURE &&
          needle.length >= MIN_SIGNATURE_CHARS &&
          lines.some((l) => l.includes(needle))
        );
      }) ??
      firstHit("tool", t.mcp_tools, (s) => mcpToolMatches(ev.toolName, s)) ??
      firstHit("tool", t.tools, (s) => toolMatches(tools, s)) ??
      firstHit("host", t.hosts, (s) => hostMatches(hosts, s)) ??
      firstHit("extension", t.extensions, (s) => extensionMatches(args, s)) ??
      // C5 has no `format` trigger value, so a datatype hit reports as the
      // nearest one. Matched two ways because C3 uses `formats` for both Galaxy
      // datatype names and extensions: a `file_type: "gtf"` argument, and a
      // `.gtf` on a file name.
      firstHit("extension", t.formats, (s) => {
        const f = s.trim().toLowerCase().replace(/^\.+/, "");
        return f.length > 0 && (exts.has(f) || argValues.has(f));
      });
    if (hit) out.push({ lesson, trigger: hit.trigger, matched: hit.matched });
  }
  return rank(out);
}

/**
 * Fold to lowercase words separated by single spaces, padded with spaces, so
 * a keyword test is a whole-word (or whole-phrase) test -- `gtf` must not
 * match `gtfoobar`, and `sample to condition` has to match
 * "sample-to-condition".
 */
export function wordHaystack(text: string): string {
  const folded = text
    .slice(0, MAX_STEP_CHARS)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ` ${folded} `;
}

/**
 * Plan-step matching. `/execute` already parses the next step's text before
 * building its prompt, so matched lessons can ride along at no extra cost. It
 * only reaches what the step says -- there is no stage state to ask instead,
 * and no regex answers "is this a normalizing step?". That gap is why the
 * reproduction index exists.
 */
export function matchStepText(text: string, lessons: readonly Lesson[]): Match[] {
  const hay = wordHaystack(text);
  if (hay.trim().length === 0) return [];

  const out: Match[] = [];
  for (const lesson of lessons) {
    if (!isMatchable(lesson)) continue;
    const hit = firstHit("step_keyword", lesson.trigger?.step_keywords, (kw) => {
      const needle = wordHaystack(kw);
      return needle.trim().length >= MIN_TOOL_CHARS && hay.includes(needle);
    });
    if (hit) out.push({ lesson, trigger: hit.trigger, matched: hit.matched });
  }
  return rank(out);
}
