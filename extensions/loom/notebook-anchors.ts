/**
 * What a `notebook_anchor` is allowed to point at.
 *
 * `galaxy_invocation_record` / `galaxy_job_record` take a `notebookAnchor` and
 * write it into the block verbatim. Nothing checked it, so a model that typed
 * `plan-1-step-3` where the notebook says `plan-a-step-1` produced a block that
 * binds to no step at all: the Activity panel still shows the run, the poller
 * still advances it, and the evidence gate -- which looks a step's anchor up
 * among the blocks (`findContradictions`) -- silently has nothing to compare.
 * A binding that quietly points nowhere is worse than a rejected call, because
 * every downstream check reads as "no opinion" rather than "broken".
 *
 * Three things count as an anchor, matching what the plan convention
 * (`context.ts`) teaches and what `init-gate.ts` parses:
 *
 *   - an explicit `{#plan-a-step-1}` marker, which is what steps carry;
 *   - a plan step's positional address, `plan-<letter>-step-<n>`, derived for
 *     steps that carry no explicit marker. That is the shape the convention
 *     would have given them, and it is the only address available on the
 *     Llama-4 path, where `buildPlanConventionBlock({omitAnchors: true})`
 *     deliberately tells the model *not* to write `{#...}` because the litellm
 *     proxy in front of it reads a curly brace as a tool-call boundary, and
 *     then tells it to say "Plan A step 2" instead;
 *   - a markdown heading, via its GitHub-style slug, for a notebook whose
 *     sections are the only structure it has.
 *
 * Fenced and indented code is excluded, for the reason `parsePlanSteps`
 * excludes fences: a plan draft pasted inside a ```plan fence is quoted, not
 * asserted, and the `loom-invocation` blocks are themselves fences. Without
 * that, a block's own `notebook_anchor:` line would make every later record
 * call for that anchor validate against a record we wrote ourselves.
 */

/** `{#some-id}` -- same shape `evidence-gate.ts` reads off a step line. */
const ANCHOR = /\{#([^}]+)\}/g;
/** Non-global twin, for the one place that only asks whether there is one. */
const HAS_ANCHOR = /\{#[^}]+\}/;
/** A markdown ATX heading, indentable by up to three spaces like any block. */
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
/** `## Plan A: Title [routing]` -- the same shape init-gate.ts parses. */
const PLAN_HEADING = /^ {0,3}##\s+Plan\s+([^:]+):/i;
const ANY_H2 = /^ {0,3}##\s+/;
/** A plan step checkbox line, with its optional leading ordinal. */
const STEP_LINE = /^\s*-\s+\[[ xX!]\]\s+(.*)$/;
const STEP_ORDINAL = /^(\d+)\.\s*/;

/**
 * A fence opener: up to three spaces of indent, optionally behind a list
 * marker, then three or more backticks or tildes.
 *
 * The list-marker branch is not pedantry. `- ```plan` opens a fence inside a
 * list item, and a scanner that only looks for a fence at the start of a line
 * walks straight past it and collects every anchor in the quoted plan that
 * follows.
 */
const FENCE_OPEN = /^ {0,3}(?:(?:[-*+]|\d{1,9}[.)])\s+)?(`{3,}|~{3,})/;
/** Four spaces (or a tab) of indent is an indented code block, not prose. */
const INDENTED_CODE = /^(?: {4}|\t)/;

/** How many anchors a rejection names before it starts summarizing. */
const MAX_LISTED_ANCHORS = 20;

export interface NotebookAnchors {
  /** Explicit `{#id}` markers, in document order, spelled as written. */
  explicit: string[];
  /** Positional addresses for plan steps that carry no explicit marker. */
  steps: string[];
  /** Slugs derived from headings, in document order, GitHub-style. */
  headings: string[];
}

export type AnchorResolution =
  | { kind: "resolved"; anchor: string }
  | { kind: "unknown" }
  /** Two anchors differ only in case and the input matched neither exactly. */
  | { kind: "ambiguous"; candidates: string[] };

/**
 * Slugify heading text the way GitHub does: drop the inline markup, lowercase,
 * strip punctuation, spaces to hyphens. `## Plan A: chrM Variant Calling
 * [galaxy]` becomes `plan-a-chrm-variant-calling-galaxy`.
 */
export function slugifyHeading(text: string): string {
  return text
    .replace(ANCHOR, "")
    .replace(/[*_`~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Walk the notebook a line at a time, handing back only the lines a reader
 * would see as prose -- no fenced blocks, no indented code.
 *
 * Fence tracking remembers the marker it opened with and closes only on the
 * same character, at least as long, with nothing but whitespace after it. A
 * symmetric "any three backticks or tildes toggles" rule gets this wrong in
 * both directions: `~~~` inside a ``` block ends the quote early and exposes
 * whatever follows, and a stray ``` inside an indented code sample swallows the
 * rest of the file.
 */
function* proseLines(content: string): Generator<string> {
  let fence: { marker: string; length: number } | null = null;
  for (const line of content.split("\n")) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (INDENTED_CODE.test(line)) continue;
    const open = line.match(FENCE_OPEN);
    if (open) {
      fence = { marker: open[1][0], length: open[1].length };
      continue;
    }
    yield line;
  }
}

/** Every anchor the notebook offers, split by how it was written. */
export function collectNotebookAnchors(content: string): NotebookAnchors {
  const explicit: string[] = [];
  const steps: string[] = [];
  const headings: string[] = [];
  // GitHub disambiguates repeated heading slugs with -1, -2, ... Mirroring it
  // means the second `## Results` is addressable as `results-1` rather than
  // being silently unreachable behind the first.
  const headingCounts = new Map<string, number>();
  let planKey: string | null = null;
  let stepIndex = 0;

  for (const line of proseLines(content)) {
    for (const m of line.matchAll(ANCHOR)) {
      const id = m[1].trim();
      if (id) explicit.push(id);
    }

    const heading = line.match(HEADING);
    if (heading) {
      const plan = line.match(PLAN_HEADING);
      if (plan) {
        planKey = slugifyHeading(plan[1]);
        stepIndex = 0;
      } else if (ANY_H2.test(line)) {
        // Any other h2 ends the plan section, same rule init-gate.ts uses.
        planKey = null;
      }
      const slug = slugifyHeading(heading[2]);
      if (slug) {
        const seen = headingCounts.get(slug) ?? 0;
        headingCounts.set(slug, seen + 1);
        headings.push(seen === 0 ? slug : `${slug}-${seen}`);
      }
      continue;
    }

    const step = line.match(STEP_LINE);
    if (!step || !planKey) continue;
    const text = step[1];
    stepIndex++;
    // A step that names itself is addressed by that name; deriving a second
    // address for it would let a block record an anchor the evidence gate can
    // never match against the step it belongs to.
    if (HAS_ANCHOR.test(text)) continue;
    // Prefer the ordinal the step writes over its position, since that is the
    // number the convention's anchor would carry.
    const ordinal = text.match(STEP_ORDINAL)?.[1] ?? String(stepIndex);
    steps.push(`plan-${planKey}-step-${ordinal}`);
  }

  return { explicit, steps, headings };
}

/**
 * The anchors a record call may name, de-duplicated, in the order a rejection
 * should offer them: what the author wrote, then step addresses, then sections.
 *
 * De-duplication is case-sensitive on purpose. Two spellings of one anchor are
 * a real collision the author should see, not noise to fold away.
 */
export function listNotebookAnchors(content: string): string[] {
  const { explicit, steps, headings } = collectNotebookAnchors(content);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const anchor of [...explicit, ...steps, ...headings]) {
    if (seen.has(anchor)) continue;
    seen.add(anchor);
    out.push(anchor);
  }
  return out;
}

/**
 * Strip the spellings a model copies out of the markdown -- `{#step-1}`,
 * `#step-1` -- down to the bare id.
 */
function normalizeAnchorInput(raw: string): string {
  let value = raw.trim();
  const braced = value.match(/^\{(.+)\}$/);
  if (braced) value = braced[1];
  return value.replace(/^#+/, "").trim();
}

/**
 * Resolve `input` against the notebook, returning the anchor **as the notebook
 * spells it**.
 *
 * Canonicalizing rather than echoing the input back matters: the evidence gate
 * matches a block's `notebook_anchor` against a step's anchor verbatim, so
 * storing a case-drifted copy would record a block bound to nothing while
 * looking fine in the file. For the same reason a case-insensitive match that
 * two different anchors both answer to is refused rather than guessed -- the
 * guess would gate the wrong step.
 *
 * `Plan A step 2` is accepted as well as `plan-a-step-2`, because that is the
 * form `anchorGuidance` asks for when explicit anchors are suppressed.
 */
export function resolveNotebookAnchor(content: string, input: string): AnchorResolution {
  const wanted = normalizeAnchorInput(input);
  if (!wanted) return { kind: "unknown" };
  const { explicit, steps, headings } = collectNotebookAnchors(content);
  // The prose form the Llama-4 guidance teaches slugs to the address form.
  const candidates = [wanted, slugifyHeading(wanted)].filter(Boolean);

  for (const candidate of candidates) {
    for (const anchor of explicit) {
      if (anchor === candidate) return { kind: "resolved", anchor };
    }
  }
  for (const candidate of candidates) {
    const lowered = candidate.toLowerCase();
    const hits = [...new Set(explicit.filter((a) => a.toLowerCase() === lowered))];
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
    if (hits.length === 1) return { kind: "resolved", anchor: hits[0] };
  }
  for (const candidate of candidates) {
    const lowered = candidate.toLowerCase();
    for (const anchor of [...steps, ...headings]) {
      if (anchor === lowered) return { kind: "resolved", anchor };
    }
  }
  return { kind: "unknown" };
}

/** The refusal a record tool hands back, naming what the notebook does have. */
export function unknownAnchorMessage(input: string, anchors: string[]): string {
  const wanted = normalizeAnchorInput(input) || input.trim();
  if (anchors.length === 0) {
    return (
      `Unknown notebook anchor "${wanted}": notebook.md has no headings, plan steps or ` +
      `{#anchor} markers to bind to, so this block would point at nothing. Write the step ` +
      `first -- \`- [ ] 1. **Step name** {#${wanted}} -- description\` -- then record against it.`
    );
  }
  const shown = anchors.slice(0, MAX_LISTED_ANCHORS);
  const extra = anchors.length - shown.length;
  const tail = extra > 0 ? `, and ${extra} more` : "";
  return (
    `Unknown notebook anchor "${wanted}": nothing in notebook.md resolves to it, so this ` +
    `block would point at nothing. Anchors that do exist: ${shown.join(", ")}${tail}. ` +
    `Record against one of those, or add {#${wanted}} to the step you mean first.`
  );
}

/** The refusal when the notebook spells one anchor two ways. */
export function ambiguousAnchorMessage(input: string, candidates: string[]): string {
  const wanted = normalizeAnchorInput(input) || input.trim();
  return (
    `Ambiguous notebook anchor "${wanted}": notebook.md carries ${candidates.join(" and ")}, ` +
    `which differ only in case, and binding to the wrong one would attach this run to the ` +
    `wrong step. Record against one of them exactly as it is written, or give the two steps ` +
    `distinct anchors.`
  );
}

/** Thrown by the record tools' write path when the anchor doesn't resolve. */
export class UnknownAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownAnchorError";
  }
}
