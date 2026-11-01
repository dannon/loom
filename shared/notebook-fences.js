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
const FENCE_OPEN = /^( {0,3}(?:[-*+]|\d{1,9}[.)])\s+| {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_LINE = /^ {0,3}(`{3,}|~{3,})\s*$/;
/** Four spaces (or a tab) of indent is an indented code block. */
const INDENTED_CODE = /^(?: {4}|\t)/;

/**
 * The marker a line opens a fence with, or null. A backtick fence's info string
 * cannot hold a backtick, so "```x``` is code" is a paragraph, not a fence.
 *
 * `itemIndent` is the content indent of the list item a fence opens in, or 0.
 *
 * @param {string} line
 * @returns {{ char: string; length: number; itemIndent: number } | null}
 */
export function matchFenceOpen(line) {
  // `.` stops at a CR, so a CRLF notebook would otherwise open no fences at all.
  const m = line.replace(/\r$/, "").match(FENCE_OPEN);
  if (!m) return null;
  if (m[2][0] === "`" && m[3].includes("`")) return null;
  const itemIndent = /[-*+.)]/.test(m[1]) ? m[1].length : 0;
  return { char: m[2][0], length: m[2].length, itemIndent };
}

/** A non-blank line indented less than `indent`, which ends a list item. */
function isOutdented(line, indent) {
  return line.trim() !== "" && line.length - line.trimStart().length < indent;
}

const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(?=\S)/;

/**
 * A flush line that only continues the paragraph above it. CommonMark keeps
 * it in the list item, so a fence on the item's next line is still the item's.
 */
function isLazyLine(lines, i) {
  const prev = lines[i - 1];
  if (prev === undefined || prev.trim() === "" || isIndentedCodeLine(prev)) return false;
  return ![prev, lines[i]].some((l) => matchFenceOpen(l) || isAnyNotebookFenceOpen(l));
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
 * One of our openers indented by accident while its body stays flush, the way
 * every writer emits a body. CommonMark calls the opener line code, but every
 * scanner read it as a record before fences were tracked, and masking it now
 * would hide that record and turn its next write into a duplicate. A quoted
 * indented example indents its body too, so it is not mistaken for one.
 *
 * @param {readonly string[]} lines
 * @param {number} i
 * @returns {boolean}
 */
function isStrayIndentedOpener(lines, i) {
  if (!isAnyNotebookFenceOpen(lines[i])) return false;
  // Blank lines are body too, so the first one decides nothing. A bare close
  // does not count: an empty block is no record, and taking that ``` as its
  // close would turn the user's next ``` into an opener.
  let next = i + 1;
  while (next < lines.length && lines[next].trim() === "") next++;
  return next < lines.length && /^[a-z0-9_]+:/.test(lines[next]);
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
 * real block after it. And an outer fence that never closes masks nothing:
 * hiding to EOF would take every later record out of reach of the poller and
 * turn each write into a duplicate append.
 *
 * A plain ``` fence with one of our openers inside it is still outer code. It
 * ends at the first bare ```, so the opener and its fields sit inside it, and
 * that is how Markdown renders it -- whether it is a three-backtick example or
 * a stray fence before a real record, the reader sees code, so we do too.
 *
 * @param {readonly string[]} lines
 * @returns {boolean[]} true for each line inside outer code
 */
export function outerCodeLines(lines) {
  const masked = new Array(lines.length).fill(false);
  // Content indent of the list item the walk is in, or 0 at the top level.
  let listIndent = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const item = line.match(LIST_ITEM);
    if (item) listIndent = item[0].length;
    else if (isOutdented(line, listIndent) && !isLazyLine(lines, i)) listIndent = 0;
    if (isIndentedCodeLine(line) && !isStrayIndentedOpener(lines, i)) {
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
    // A fence on an item's continuation line is in the item too; one merely
    // indented 1-3 spaces at the top level is not, and runs to its close.
    const itemIndent = fence.itemIndent || listIndent;
    let end = i + 1;
    let itemEnded = false;
    while (end < lines.length && !closesFence(lines[end], fence)) {
      // A fence opened in a list item ends with the item, at the first line
      // not indented to its content; what follows is back at the top level.
      if (itemIndent && isOutdented(lines[end], itemIndent)) {
        itemEnded = true;
        break;
      }
      end++;
    }
    if (itemEnded) {
      for (let li = i; li < end; li++) masked[li] = true;
      i = end;
      continue;
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
