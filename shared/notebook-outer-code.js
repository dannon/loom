// Which notebook lines are quoted inside outer Markdown code. Kept apart from
// notebook-fences.js because it needs marked, and the registry's trusted core
// reads fence names from there while staying free of npm dependencies.

import { Lexer, getDefaults } from "marked";
import { NOTEBOOK_FENCE_KINDS, closesFence, isNotebookFenceOpen } from "./notebook-fences.js";

/** @param {string} line @returns {boolean} */
function isAnyNotebookFenceOpen(line) {
  return NOTEBOOK_FENCE_KINDS.some((kind) => isNotebookFenceOpen(line, kind));
}

/**
 * Which lines sit inside Markdown code that is not one of our blocks: an outer
 * fence (a ```` or ~~~ example in documentation, a pasted transcript) or an
 * indented code block. A typed opener on such a line is quoted, not live, and
 * every block scanner skips it -- otherwise the poller polls an example's id,
 * the evidence gate binds a step to the example's status, and a write to that
 * id rewrites the documentation instead of the real block.
 *
 * "Code" is whatever marked's lexer makes a code token, since marked is what
 * renders the notebook: a reader sees code there, so we do too. A hand-written
 * CommonMark scanner kept getting list items, lazy lines and headings subtly
 * wrong, and each miss let a quoted example go live and an upsert delete the
 * real record as its duplicate.
 *
 * Three places part from marked on purpose, each to keep a record main always
 * read as live from being hidden, which would turn its next write into a
 * duplicate append:
 *
 * - A fence of ours is a code token too. It masks nothing, wherever it sits.
 * - A fence that never closes masks nothing and is read as if it were not
 *   there. Marked runs it to EOF, but hiding every later record from the
 *   poller is worse than the stray fence. One of ours that swallows another of
 *   our openers before its close is unterminated in the same way: the block
 *   scanners end it at that opener, so the lexing resumes after it.
 * - One of our openers indented by accident, alone in its indented code block
 *   and followed by a flush `key:` body, the way every writer emits a body. A
 *   quoted indented example indents its body too, so it is not mistaken for one.
 *
 * When marked ends one of our blocks before the close the block scanners find
 * (the indented opener above, or a list item that ends under it), marked reads
 * that close as an opener of its own. The lexing resumes after the close
 * instead, so the next record is not hidden behind it.
 *
 * @param {readonly string[]} lines
 * @returns {boolean[]} true for each line inside outer code
 */
export function outerCodeLines(lines) {
  // One upsert asks about the same notebook about ten times. Keyed on content,
  // not the array, since callers build and edit their own line arrays.
  const key = lines.join("\n");
  if (memo.lines !== lines.length || memo.key !== key) {
    memo = { key, lines: lines.length, masked: computeOuterCodeLines(lines) };
  }
  return memo.masked.slice();
}

/** @type {{ key: string | null; lines: number; masked: boolean[] }} */
let memo = { key: null, lines: -1, masked: [] };

/** @param {readonly string[]} lines @returns {boolean[]} */
function computeOuterCodeLines(lines) {
  const masked = new Array(lines.length).fill(false);
  // Marked reads a lone CR as a line break too; blank it so its lines stay ours.
  const clean = lines.map((l) => l.replace(/\r$/, "").replace(/\r/g, " "));
  let last = clean.length - 1;
  while (last >= 0 && clean[last].trim() === "") last--;
  /** @type {number | null} */
  let from = 0;
  while (from !== null && from < clean.length) {
    const tokens = new Lexer(getDefaults()).blockTokens(clean.slice(from).join("\n"));
    from = maskCode(tokens, from, { lines: clean, last, masked });
  }
  return masked;
}

/**
 * Mark the code tokens in `tokens`, which start on line `first`. Returns the
 * line to lex again from when a fence turns out to be unterminated, else null.
 *
 * @param {readonly import("marked").Token[]} tokens
 * @param {number} first
 * @param {{ lines: readonly string[]; last: number; masked: boolean[] }} doc
 * @returns {number | null}
 */
function maskCode(tokens, first, doc) {
  let line = first;
  for (const token of tokens) {
    const start = line;
    line += (token.raw.match(/\n/g) || []).length;
    const children =
      token.type === "list"
        ? token.items
        : token.type === "list_item" || token.type === "blockquote"
          ? token.tokens
          : null;
    if (children) {
      const restart = maskCode(children, start, doc);
      if (restart !== null) return restart;
      continue;
    }
    if (token.type !== "code") continue;
    const raw = token.raw.replace(/\n+$/, "").split("\n");
    const end = start + raw.length - 1;
    // Nested tokens carry their container's text with its markers stripped,
    // so check the mapping landed on the right lines rather than trust it.
    // Masking nothing is what main did everywhere.
    if (!raw.every((r, k) => doc.lines[start + k]?.trimEnd().endsWith(r.trim()))) continue;
    if (token.codeBlockStyle === "indented") {
      if (!isStrayIndentedOpener(raw, doc, end)) {
        doc.masked.fill(true, start, end + 1);
        continue;
      }
      // Marked never saw this opener as a fence, so it reads the block's close
      // as an opener and would hide the next record behind it. Resume after
      // the close the block scanners end it at.
      const close = scannerClose(doc.lines, end + 1);
      if (close !== null) return close + 1;
      continue;
    }
    const fence = /** @type {RegExpMatchArray} */ (raw[0].match(/^ *(`{3,}|~{3,})/));
    const closed =
      raw.length > 1 &&
      closesFence(raw[raw.length - 1], { char: fence[1][0], length: fence[1].length });
    const ours = isAnyNotebookFenceOpen(raw[0]);
    if ((!closed && end >= doc.last) || (ours && raw.slice(1).some(isAnyNotebookFenceOpen))) {
      return start + 1;
    }
    if (!ours) {
      doc.masked.fill(true, start, end + 1);
      continue;
    }
    // A list item can end one of ours before its close; marked then reads that
    // close as an opener and would hide the next record behind it.
    const close = scannerClose(doc.lines, start + 1);
    if (close !== null && close > end) return close + 1;
  }
  return null;
}

/**
 * @param {readonly string[]} raw the indented code token's lines
 * @param {{ lines: readonly string[] }} doc
 * @param {number} end the token's last line
 */
function isStrayIndentedOpener(raw, doc, end) {
  if (raw.length !== 1 || !isAnyNotebookFenceOpen(raw[0])) return false;
  // Blank lines are body too, so the first one decides nothing. A bare close
  // does not count: an empty block is no record.
  let next = end + 1;
  while (next < doc.lines.length && doc.lines[next].trim() === "") next++;
  return next < doc.lines.length && /^[a-z0-9_]+:/.test(doc.lines[next]);
}

/**
 * The line a block scanner closes a block on: its body is blank or `key:`
 * lines, then a bare ```. Mirrors `scanFencedBlocks`.
 *
 * @param {readonly string[]} lines
 * @param {number} from the first body line
 * @returns {number | null}
 */
function scannerClose(lines, from) {
  let i = from;
  while (i < lines.length && (lines[i].trim() === "" || /^[a-z0-9_]+:/.test(lines[i]))) i++;
  return i < lines.length && lines[i].trim() === "```" ? i : null;
}
