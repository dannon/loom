// Fence names for the typed blocks Orbit keeps in notebook.md. Shared so the
// brain and the Orbit renderer agree on what counts as one of our blocks.
//
// The product is being renamed from Loom to Orbit, and notebooks outlive any
// one release: a CLI and a bundled desktop app can be different versions
// pointed at the same notebook. So readers accept every prefix here forever,
// while writers use exactly one. Flipping NOTEBOOK_FENCE_WRITE_PREFIX is the
// whole write-side switch; upserts rewrite a matched block under it, so a
// mixed notebook converges instead of growing duplicates.

export const NOTEBOOK_FENCE_WRITE_PREFIX = "orbit";

export const NOTEBOOK_FENCE_READ_PREFIXES = Object.freeze(["loom", "orbit"]);

/** @typedef {"session" | "invocation" | "job" | "galaxy-page" | "udt" | "proposal"} NotebookFenceKind */

/** @param {NotebookFenceKind} kind @returns {string} */
export function notebookFenceOpen(kind) {
  return "```" + NOTEBOOK_FENCE_WRITE_PREFIX + "-" + kind;
}

/** @type {readonly NotebookFenceKind[]} */
export const NOTEBOOK_FENCE_KINDS = Object.freeze([
  "invocation",
  "job",
  "udt",
  "session",
  "galaxy-page",
  "proposal",
]);

/** @param {string} line @param {NotebookFenceKind} kind @returns {boolean} */
export function isNotebookFenceOpen(line, kind) {
  const trimmed = line.trim();
  return NOTEBOOK_FENCE_READ_PREFIXES.some((p) => trimmed === "```" + p + "-" + kind);
}

/** @param {string} line @returns {boolean} */
function isAnyNotebookFenceOpen(line) {
  return NOTEBOOK_FENCE_KINDS.some((kind) => isNotebookFenceOpen(line, kind));
}

// CommonMark fences: up to three spaces of indent, then a run of three or more
// backticks or tildes. The optional list marker is there because `- ```plan`
// opens a fence inside a list item, and a scanner that only looks at the start
// of the line walks straight past it into the quoted content.
const FENCE_OPEN = /^ {0,3}(?:(?:[-*+]|\d{1,9}[.)])\s+)?(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_LINE = /^ {0,3}(`{3,}|~{3,})\s*$/;
/** Four spaces (or a tab) of indent is an indented code block. */
const INDENTED_CODE = /^(?: {4}|\t)/;

/**
 * The marker a line opens a fence with, or null. A backtick fence's info string
 * cannot hold a backtick, so "```x``` is code" is a paragraph, not a fence.
 *
 * @param {string} line
 * @returns {{ char: string; length: number } | null}
 */
export function matchFenceOpen(line) {
  // `.` stops at a CR, so a CRLF notebook would otherwise open no fences at all.
  const m = line.replace(/\r$/, "").match(FENCE_OPEN);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return { char: m[1][0], length: m[1].length };
}

/**
 * Whether `line` closes a fence opened with `fence`: same character, at least
 * as long, nothing after it. A symmetric "any fence line toggles" rule gets
 * this wrong both ways -- `~~~` inside a ``` block ends it early, and a ```
 * inside a ```` example ends the example and exposes what it quotes.
 *
 * @param {string} line
 * @param {{ char: string; length: number }} fence
 * @returns {boolean}
 */
export function closesFence(line, fence) {
  const m = line.match(FENCE_CLOSE_LINE);
  return !!m && m[1][0] === fence.char && m[1].length >= fence.length;
}

/** @param {string} line @returns {boolean} */
export function isIndentedCodeLine(line) {
  return INDENTED_CODE.test(line);
}

/**
 * Which lines sit inside Markdown code that is not one of our blocks: an outer
 * fence (a ```` or ~~~ example in documentation, a pasted transcript) or an
 * indented code block. A typed opener on such a line is quoted, not live, and
 * every block scanner skips it -- otherwise the poller polls an example's id,
 * the evidence gate binds a step to the example's status, and a write to that
 * id rewrites the documentation instead of the real block.
 *
 * Our own blocks are walked with the block scanners' rules, not CommonMark's,
 * in two places. An opener's extent ends at the next fence close or at the
 * next opener, whichever comes first, so an unterminated block never hides the
 * real block after it. And a stray fence must not take the records after it
 * out of reach of the poller, or every write after it appends a duplicate, so
 * two shapes of outer fence mask nothing: one that never closes, and a plain
 * ``` one with one of our openers inside it. The second cannot be quoting that
 * block -- the block's own closing ``` would end it -- so it is a fence someone
 * forgot to close, or an extra close after a block, followed by a real record.
 *
 * @param {readonly string[]} lines
 * @returns {boolean[]} true for each line inside outer code
 */
export function outerCodeLines(lines) {
  const masked = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isIndentedCodeLine(line)) {
      masked[i] = true;
      i++;
      continue;
    }
    if (isAnyNotebookFenceOpen(line)) {
      let end = i + 1;
      while (end < lines.length && !isAnyNotebookFenceOpen(lines[end])) {
        if (closesFence(lines[end], { char: "`", length: 3 })) break;
        end++;
      }
      i = end < lines.length && !isAnyNotebookFenceOpen(lines[end]) ? end + 1 : i + 1;
      continue;
    }
    const fence = matchFenceOpen(line);
    if (!fence) {
      i++;
      continue;
    }
    const bareBackticks = fence.char === "`" && fence.length === 3;
    let end = i + 1;
    while (end < lines.length && !closesFence(lines[end], fence)) {
      if (bareBackticks && isAnyNotebookFenceOpen(lines[end])) break;
      end++;
    }
    if (end >= lines.length || !closesFence(lines[end], fence)) {
      i++;
      continue;
    }
    for (let li = i; li <= end; li++) masked[li] = true;
    i = end + 1;
  }
  return masked;
}

/**
 * Replace every block in `ranges` with `newBlock`, written where the first one
 * sat. Two blocks sharing a key can only come from a writer that didn't
 * recognise the other prefix, so collapsing them is what keeps the key unique.
 *
 * @param {string} content
 * @param {ReadonlyArray<{ start: number; end: number }>} ranges line ranges, inclusive of both fences
 * @param {string[]} newBlock
 * @returns {string}
 */
export function replaceNotebookBlocks(content, ranges, newBlock) {
  const lines = content.split("\n");
  if (ranges.length === 0) return content;
  const drop = new Set();
  for (const r of ranges) {
    for (let li = r.start; li <= r.end; li++) drop.add(li);
  }
  const insertAt = Math.min(...ranges.map((r) => r.start));
  const rebuilt = [];
  for (let li = 0; li < lines.length; li++) {
    if (li === insertAt) rebuilt.push(...newBlock);
    if (drop.has(li)) continue;
    rebuilt.push(lines[li]);
  }
  return rebuilt.join("\n");
}
