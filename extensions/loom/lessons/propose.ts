/**
 * The proposal core: arming, then validate -> record -> show -> approve -> write.
 *
 * The order is the design. A draft is assembled from session content that may
 * include hostile tool output, so:
 *
 *   1. an unarmed proposal is refused -- only /lesson and the user-correction
 *      nudge arm one, which keeps "proposes at a cue, never in the background"
 *      true in code and not just in the prompt;
 *   2. the composed BYTES are validated before anything is shown or stored;
 *   3. activity records structured facts only, never the body: activity.jsonl
 *      sits in the project directory and feeds /feedback;
 *   4. only then is the draft displayed, which is safe because the validator
 *      already ruled out URLs, fences and invisible characters;
 *   5. the user answers. No UI means the approval control is absent, so the
 *      answer is refuse -- pi's no-op UI returns false/undefined, so a headless
 *      run cannot become an implicit yes;
 *   6. the write is create-or-fail. Nothing here ever edits a lesson.
 *
 * ctx.ui.editor is NOT used: Orbit's renderer has no editor branch and pi's
 * RPC editor only settles on a host response, so an editor call there hangs the
 * command forever. The "let me edit it" branch stages a file and hands over
 * the path.
 */

import * as fs from "fs";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendActivityEvent } from "../activity.js";
import { readLoomVersion } from "../feedback.js";
import { getNotebookPath } from "../state.js";
import {
  PROPOSABLE_NAMESPACES,
  TRIGGER_KEYS,
  identifyingProblems,
  isValidLessonSlug,
  parseLesson,
  validateLessonMarkdown,
} from "../../../shared/lesson-rules.js";
import {
  composeLessonMarkdown,
  renderProposalPreview,
  type LessonProposalInput,
} from "./compose.js";
import {
  draftFilePath,
  lessonFilePath,
  parseLessonId,
  readLessonFile,
  writeNoClobber,
  writeOverwrite,
} from "./paths.js";

export const ACTIVITY_SOURCE = "lesson-command";

export const SAVE_OPTION = "Save it";
export const STAGE_OPTION = "Keep it as a draft I can edit";
export const DISCARD_OPTION = "Discard it";

export type ProposalReason = "explicit" | "user_correction";

export type RejectReason =
  "unarmed" | "validator" | "exists" | "no-ui" | "declined" | "staged" | "write-failed";

export type ProposeOutcome =
  | { ok: true; id: string; path: string }
  | { ok: false; reason: RejectReason; message: string; errors?: string[] };

/** The slice of ExtensionContext this module needs, so tests can script it. */
export interface ProposeUiContext {
  hasUI: boolean;
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    // `unknown` rather than `string | undefined`: a host may answer a selector
    // with the chosen index instead of the string; chosenOption handles both.
    select(title: string, options: string[]): Promise<unknown>;
    confirm(title: string, message: string): Promise<boolean>;
  };
}

/**
 * The arming. Three properties, each closing a way a proposal could happen
 * that nobody asked for:
 *
 * - it only counts inside an agent run that STARTED after it was armed. A
 *   /lesson typed while a run is streaming must not hand that run -- which may
 *   be mid-way through hostile tool output -- a licence to propose;
 * - it expires when that run ends (the nudge's after two, so "offer, then the
 *   user says yes" fits), so an unused /lesson does not linger for a later
 *   turn to pick up;
 * - one proposal reaches the user per arming. A validator rejection keeps it
 *   for one corrected retry, since the model is told it may fix and resubmit.
 *
 * Module-scoped and reset on session_start, so nothing carries across a
 * session swap into a conversation the user never saw.
 */
export interface Arming {
  reason: ProposalReason;
  live: boolean;
  runsLeft: number;
  retriesLeft: number;
  armedAt: number;
}

let armed: Arming | null = null;

/**
 * How long a /lesson arming may wait for its run to start. pi swallows a
 * refused sendUserMessage (auth, preflight), so without a deadline the arming
 * would go live in the user's NEXT, unrelated run instead.
 */
export const EXPLICIT_ARMING_START_MS = 30_000;

/** Returns the arming so a caller can later disarm exactly that one. */
export function armLessonProposal(reason: ProposalReason, opts: { live?: boolean } = {}): Arming {
  armed = {
    reason,
    live: opts.live === true,
    runsLeft: reason === "user_correction" ? 2 : 1,
    retriesLeft: 1,
    armedAt: Date.now(),
  };
  return armed;
}

/** Disarm only if `arming` is still the current one -- never someone else's. */
export function disarmLessonProposal(arming: Arming): void {
  if (armed === arming) armed = null;
}

export function peekLessonProposalArming(): ProposalReason | null {
  return armed?.reason ?? null;
}

/** Consume the arming outright. */
export function takeLessonProposalArming(): ProposalReason | null {
  const reason = armed?.reason ?? null;
  armed = null;
  return reason;
}

export function resetLessonProposalArming(): void {
  armed = null;
}

export function lessonArmingRunStarted(): void {
  if (!armed || armed.live) return;
  // The nudge's arming waits for the user's next prompt, however long that
  // takes; an explicit one is for the run /lesson itself starts.
  if (armed.reason === "explicit" && Date.now() - armed.armedAt > EXPLICIT_ARMING_START_MS) {
    armed = null;
    return;
  }
  armed.live = true;
}

export function lessonArmingRunEnded(): void {
  if (!armed || !armed.live) return;
  armed.live = false;
  armed.runsLeft -= 1;
  if (armed.runsLeft <= 0) armed = null;
}

export function registerLessonArmingLifecycle(pi: ExtensionAPI): void {
  pi.on("session_start", async () => resetLessonProposalArming());
  pi.on("agent_start", async () => lessonArmingRunStarted());
  pi.on("agent_end", async () => lessonArmingRunEnded());
}

function sessionDir(): string | null {
  const notebook = getNotebookPath();
  return notebook ? path.dirname(notebook) : null;
}

function record(kind: string, payload: Record<string, unknown>): void {
  const dir = sessionDir();
  if (!dir) return;
  appendActivityEvent(dir, {
    timestamp: new Date().toISOString(),
    kind,
    source: ACTIVITY_SOURCE,
    payload,
  });
}

/**
 * Line numbers only. A validator message can quote the offending value, and
 * echoing that into a log that feeds /feedback would give a rejected injection
 * a second delivery -- the same rule the intake route follows.
 */
function errorLines(errors: string[]): string {
  const lines = new Set<string>();
  for (const error of errors) lines.add(/^(\d+):/.exec(error)?.[1] ?? "?");
  return [...lines].slice(0, 20).join(",");
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function triggerSummary(input: LessonProposalInput): string {
  const trigger = (input?.trigger ?? {}) as Record<string, unknown>;
  return TRIGGER_KEYS.map((key) => `${key}=${count(trigger[key])}`).join(" ");
}

/**
 * Problems with a proposed slug beyond its shape. The slug is model-chosen
 * text that becomes a filename and an activity-row id, so it gets the same
 * identifying-data checks as the lesson body, plus long digit runs (record
 * numbers) -- a name spelled in lowercase words still needs the user's eye.
 */
function slugProblems(slug: unknown): string[] {
  if (!isValidLessonSlug(slug)) {
    return ["0: slug must be lowercase words joined by hyphens, at most 80 characters"];
  }
  const out = identifyingProblems(slug as string, "slug").map((problem) => `0: ${problem}`);
  if (/\d{5,}/.test(slug as string)) out.push("0: slug contains a long number");
  return out;
}

/** An id fit for an activity row, or a fixed placeholder. */
function safeId(namespace: unknown, slug: unknown): string {
  return parseLessonId(`${String(namespace)}/${String(slug)}`) && slugProblems(slug).length === 0
    ? `${namespace}/${slug}`
    : "(invalid)";
}

function reject(
  id: string,
  reason: RejectReason,
  message: string,
  errors?: string[],
): ProposeOutcome {
  record("lesson.rejected", {
    id,
    reason,
    ...(errors ? { errorCount: errors.length, errorLines: errorLines(errors) } : {}),
  });
  return { ok: false, reason, message, ...(errors ? { errors } : {}) };
}

/**
 * Resolve a selector answer. Interactive mode returns the chosen string; some
 * hosts answer with the index instead (same handling as /connect). Anything
 * else is a dismissal.
 */
function chosenOption(answer: unknown, options: string[]): string | undefined {
  if (typeof answer === "number") return options[answer];
  if (typeof answer === "string") return options.find((o) => o === answer.trim());
  return undefined;
}

function generatedBy(): string {
  const version = readLoomVersion();
  return version && /^[A-Za-z0-9.-]{1,40}$/.test(version) ? `agent:loom/${version}` : "agent:loom";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function saveLesson(id: string, namespace: string, slug: string, markdown: string): ProposeOutcome {
  const target = lessonFilePath(namespace, slug);
  const written = writeNoClobber(target, markdown);
  if (!written.ok) {
    if (written.reason === "exists") {
      return reject(
        id,
        "exists",
        `A lesson already exists at ${id}. Nothing was changed -- lessons are never rewritten ` +
          `in place. Propose it under a different slug if it is a different situation.`,
      );
    }
    return reject(id, "write-failed", `Could not write the lesson (${written.detail ?? "error"}).`);
  }
  record("lesson.saved", { id, bytes: Buffer.byteLength(markdown, "utf-8") });
  return { ok: true, id, path: target };
}

function rejectInvalid(id: string, errors: string[], retry: boolean): ProposeOutcome {
  return reject(
    id,
    "validator",
    `That draft does not satisfy the lesson schema, so nothing was shown or written ` +
      `(each line is <line in the composed lesson>: <problem>):\n` +
      errors.map((e) => `  - ${e}`).join("\n") +
      (retry
        ? `\nFix those and call lesson_propose once more, or tell the user it does not fit.`
        : `\nThat was the last attempt for this /lesson. Tell the user it did not fit the schema.`),
    errors,
  );
}

export async function proposeLesson(
  input: LessonProposalInput,
  ctx: ProposeUiContext,
): Promise<ProposeOutcome> {
  const namespace = input?.namespace;
  const slug = input?.slug;
  const id = safeId(namespace, slug);

  const arming = armed;
  if (!arming || !arming.live) {
    // Nothing the model chose reaches the log from an unarmed call: that
    // would hand a background injection a free row.
    return reject(
      "(unarmed)",
      "unarmed",
      "Lessons are only proposed when the user asks for one. Nobody did -- if something here is " +
        "worth keeping, tell the user they can run /lesson, and move on.",
    );
  }

  // A failed draft keeps the arming for one corrected retry; anything that
  // gets as far as the user consumes it.
  const failValidation = (errors: string[]): ProposeOutcome => {
    const retry = arming.retriesLeft > 0;
    if (retry) arming.retriesLeft -= 1;
    else armed = null;
    return rejectInvalid(id, errors, retry);
  };

  // Checked before anything builds a path from them.
  const problems: string[] = [];
  if (typeof namespace !== "string" || !PROPOSABLE_NAMESPACES.includes(namespace as never)) {
    problems.push(`0: namespace must be one of ${PROPOSABLE_NAMESPACES.join(", ")}`);
  }
  problems.push(...slugProblems(slug));
  if (problems.length > 0) return failValidation(problems);

  const markdown = composeLessonMarkdown(input, {
    generatedBy: generatedBy(),
    generatedAt: today(),
  });
  const validation = validateLessonMarkdown(markdown);
  if (!validation.ok) return failValidation(validation.errors);

  armed = null;
  const ns = namespace as string;
  const sl = slug as string;
  record("lesson.proposed", {
    id,
    // Validated by now, so these are enum values, not free text.
    kind: String(input.kind),
    stages: (input.stage as string[]).join(","),
    trigger: triggerSummary(input),
    bytes: Buffer.byteLength(markdown, "utf-8"),
    armedBy: arming.reason,
  });

  if (!ctx.hasUI) {
    return reject(
      id,
      "no-ui",
      "A lesson is only written after the user approves it, and this session has no way to ask. " +
        "Nothing was saved. Tell the user to run /lesson in Orbit or an interactive terminal.",
    );
  }

  const options = [SAVE_OPTION, STAGE_OPTION, DISCARD_OPTION];
  ctx.ui.notify(`Proposed lesson: ${id}\n\n${renderProposalPreview(markdown)}`, "info");
  const choice = chosenOption(await ctx.ui.select(`Save this lesson as ${id}?`, options), options);

  if (choice === SAVE_OPTION) return saveLesson(id, ns, sl, markdown);

  if (choice === STAGE_OPTION) {
    const draft = draftFilePath(ns, sl);
    const staged = writeOverwrite(draft, markdown);
    if (!staged.ok) {
      return reject(id, "write-failed", `Could not write the draft (${staged.detail}).`);
    }
    ctx.ui.notify(
      `Draft kept, not yet a lesson:\n  ${draft}\n\n` +
        `Edit it, then run  /lesson save ${id}  to check it against the schema and keep it.`,
      "info",
    );
    return reject(
      id,
      "staged",
      `The user kept the draft to edit. It is not a lesson yet. Do not propose it again -- they ` +
        `will run /lesson save when they are done.`,
    );
  }

  return reject(
    id,
    "declined",
    "The user declined that lesson. Nothing was written. Do not propose it again unless they ask.",
  );
}

/**
 * Promote a staged draft the user has edited.
 *
 * The bytes are re-validated rather than trusted: a draft is an ordinary file,
 * so between staging and committing anything could have happened to it -- the
 * user's edit, another tool, a model with file access. The validator is the
 * gate every time the bytes change.
 */
export async function commitDraft(rawId: string, ctx: ProposeUiContext): Promise<ProposeOutcome> {
  const parsed = parseLessonId(rawId);
  if (!parsed || !PROPOSABLE_NAMESPACES.includes(parsed.namespace as never)) {
    return reject("(invalid)", "validator", "That is not the id of a draft you can save.", [
      "0: not <namespace>/<slug> in a proposable namespace",
    ]);
  }
  const { namespace, slug } = parsed;
  const id = `${namespace}/${slug}`;

  const draft = draftFilePath(namespace, slug);
  const read = readLessonFile(draft);
  if (!read.ok) {
    return reject(id, "validator", `No draft for ${id} (${read.detail}).`, ["0: draft missing"]);
  }

  const validation = validateLessonMarkdown(read.text);
  if (!validation.ok) {
    return reject(
      id,
      "validator",
      `That draft still does not satisfy the lesson schema, so nothing was saved ` +
        `(each line is <line in the draft>: <problem>):\n` +
        validation.errors.map((e) => `  - ${e}`).join("\n"),
      validation.errors,
    );
  }

  // The schema allows stable and verified because the corpus uses them, but
  // standing is granted by a human reviewer in the corpus repo, never by an
  // edit to a local file -- which a model with file access could make too.
  const fm = (parseLesson(read.text).frontmatter ?? {}) as Record<string, unknown>;
  const generated = fm.generated as { by?: unknown } | undefined;
  const empty = (key: string) => Array.isArray(fm[key]) && (fm[key] as unknown[]).length === 0;
  if (
    fm.status !== "draft" ||
    "verified" in fm ||
    typeof generated?.by !== "string" ||
    !generated.by.startsWith("agent:loom") ||
    !empty("graduated_to") ||
    !empty("upstream") ||
    !empty("supersedes") ||
    slugProblems(slug).length > 0
  ) {
    return reject(
      id,
      "validator",
      "A local lesson keeps the fields Loom set when it was drafted: status: draft, no verified " +
        "entries, generated.by as written, and empty graduated_to, upstream and supersedes. " +
        "Those are decided in review, not by editing the file. Put them back and run /lesson save again.",
      ["0: brain-owned fields were edited"],
    );
  }

  record("lesson.proposed", { id, bytes: Buffer.byteLength(read.text, "utf-8"), armedBy: "draft" });

  if (!ctx.hasUI) return reject(id, "no-ui", "Saving a lesson needs an interactive session.");

  ctx.ui.notify(`Draft ${id}\n\n${renderProposalPreview(read.text)}`, "info");
  const approved = await ctx.ui.confirm(
    `Save ${id} as a lesson?`,
    "It passes the schema. Saved lessons are read back in later sessions and are never rewritten in place.",
  );
  if (approved !== true)
    return reject(id, "declined", `Left the draft in place; nothing was saved.`);

  // Re-read: the confirm can sit open for as long as the user likes, and the
  // bytes that get saved must be the bytes that were checked and shown.
  const again = readLessonFile(draft);
  if (!again.ok || again.text !== read.text) {
    return reject(
      id,
      "declined",
      "The draft changed while you were deciding; nothing was saved. Run /lesson save again.",
    );
  }

  const saved = saveLesson(id, namespace, slug, read.text);
  if (saved.ok) {
    // Cleared so it cannot be committed twice and /lesson drafts stops
    // advertising work that is done.
    try {
      fs.rmSync(draft, { force: true });
    } catch {
      /* the lesson is written; a leftover draft is cosmetic */
    }
  }
  return saved;
}
