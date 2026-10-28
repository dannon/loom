/**
 * `lesson_propose` -- the agent's only way to put a lesson on disk.
 *
 * A tool rather than a parse of the agent's next message:
 *
 * - pi validates arguments against this schema before execute runs, so a
 *   wrong-shaped proposal never reaches our code and the model gets an error
 *   it can act on. A fence parser would be a hand-written tokenizer attacked by
 *   exactly the content it extracts -- the body rules forbid code fences, so a
 *   hostile draft is the input that contains one.
 * - structured fields are what let the brain build the document and own
 *   type/status/generated/verified by construction. A whole file from the
 *   model could only be allowlisted by re-parsing and re-emitting it, which is
 *   the scrubbing pass the threat model rules out.
 * - the validator's errors come back as a tool result, so a rejection is
 *   correctable in the same turn.
 * - execute gets a real ExtensionContext (ui + hasUI) in TUI, RPC and json mode.
 *
 * This schema is a convenience for the model, NOT the security boundary. Every
 * cap here is re-enforced by validateLessonMarkdown on the composed bytes; a
 * disagreement is a bug in this schema, never a reason to relax the validator.
 *
 * No promptSnippet: nothing about lessons goes in the cached system prompt.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  EVIDENCE_CAUSE,
  EVIDENCE_OUTCOME,
  EVIDENCE_SYMPTOM,
  LESSON_KINDS,
  LESSON_STAGES,
  LIMITS,
  PROPOSABLE_NAMESPACES,
} from "../../../shared/lesson-rules.js";
import type { LessonProposalInput } from "./compose.js";
import { proposeLesson, type ProposeUiContext } from "./propose.js";

export const LESSON_PROPOSE_TOOL_NAME = "lesson_propose";

const literals = (values: readonly string[]) => Type.Union(values.map((v) => Type.Literal(v)));

const stringList = (maxLength: number, description: string) =>
  Type.Optional(
    Type.Array(Type.String({ maxLength }), { maxItems: LIMITS.listItems, description }),
  );

const PARAMETERS = Type.Object({
  namespace: literals(PROPOSABLE_NAMESPACES),
  slug: Type.String({
    maxLength: LIMITS.slug,
    description:
      "Lowercase words joined by hyphens naming the SITUATION, not the fix, e.g. " +
      "'na-coerced-to-zero-in-filters'.",
  }),
  title: Type.String({
    maxLength: LIMITS.title,
    description: "One line describing the situation, not the fix.",
  }),
  description: Type.String({
    maxLength: LIMITS.description,
    description: "One line, one sentence.",
  }),
  kind: literals(LESSON_KINDS),
  stage: Type.Array(literals(LESSON_STAGES), {
    minItems: 1,
    maxItems: LESSON_STAGES.length,
    description: "Which stage(s) of an analysis this bites in.",
  }),
  tags: stringList(LIMITS.tag, "Short keywords."),
  stale_after: Type.String({
    maxLength: 10,
    description:
      "YYYY-MM-DD after which this should be re-checked. Galaxy ships quarterly, so pick 6-12 " +
      "months out, and sooner for anything from a forum answer.",
  }),
  cues: Type.String({
    maxLength: LIMITS.cues,
    description: "When this applies, in a sentence a person reads. One line.",
  }),
  applies_to: Type.Object({
    versions: Type.String({
      maxLength: LIMITS.appliesTo,
      description: "Versions it holds for, or 'any'.",
    }),
    tested: Type.String({
      maxLength: LIMITS.appliesTo,
      description: "What it was actually seen against.",
    }),
  }),
  evidence: Type.Object({
    symptom: literals(EVIDENCE_SYMPTOM),
    cause: literals(EVIDENCE_CAUSE),
    outcome: literals(EVIDENCE_OUTCOME),
    method: Type.String({
      maxLength: LIMITS.method,
      description: "How you know. 'hypothesized' and 'unvalidated' are fine answers.",
    }),
  }),
  trigger: Type.Optional(
    Type.Object({
      signatures: stringList(
        LIMITS.signature,
        "The distinctive first line of the error, at least 8 characters, with URLs, paths, " +
          "emails, long hex ids and 5+ digit numbers already replaced by <url>, <path>, <email>, " +
          "<id>, <n>.",
      ),
      tools: stringList(LIMITS.tool, "Short Galaxy tool ids or families, e.g. 'deseq2'. No '/'."),
      mcp_tools: stringList(LIMITS.mcpTool, "galaxy_* tool names."),
      formats: stringList(LIMITS.format, "Lowercase Galaxy datatypes, e.g. 'tabular'."),
      hosts: stringList(LIMITS.host, "Public hostnames seen in commands, e.g. 'ncbi.nlm.nih.gov'."),
      extensions: stringList(LIMITS.extension, "File extensions seen in arguments, e.g. '.gtf'."),
      step_keywords: stringList(
        LIMITS.stepKeyword,
        "Lowercase words matched against plan-step text.",
      ),
    }),
  ),
  sources: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ maxLength: LIMITS.sourceId }),
        resource: Type.Optional(Type.String({ maxLength: LIMITS.sourceText })),
        title: Type.Optional(Type.String({ maxLength: LIMITS.sourceText })),
      }),
      {
        maxItems: LIMITS.listItems,
        description:
          "Required when this came from GTN or the forum, whose content is attribution-licensed. " +
          "resource, if given, is an https link.",
      },
    ),
  ),
  sections: Type.Object(
    {
      symptom: Type.String({ maxLength: LIMITS.section }),
      cause: Type.Optional(Type.String({ maxLength: LIMITS.section })),
      check_first: Type.String({ maxLength: LIMITS.section }),
      intervention: Type.String({ maxLength: LIMITS.section }),
      validate: Type.String({ maxLength: LIMITS.section }),
      not_when: Type.String({ maxLength: LIMITS.section }),
    },
    {
      description:
        "Prose only: no code fences, URLs, markdown links, headings or HTML. Up to 600 characters " +
        "each. Omit `cause` if you do not actually know it.",
    },
  ),
});

const DESCRIPTION = `Propose ONE lesson drawn from what happened in this session, for the user to
approve. The user always sees the draft and decides; nothing is written without that.

Only call this when the user asked -- they typed /lesson, or Loom told you they corrected you and
they then said yes to writing it down. Never call it on your own initiative: an unasked call is
refused and recorded.

A lesson is for what you only catch by knowing the science or the data: a silently wrong result,
a sanity range that makes a silent failure visible, a choice and when it flips, a data-source
quirk, or what it actually takes to reproduce a published analysis. If a validator, a schema or a
better error message could catch it, it belongs upstream instead -- say so and do not call this.

Nothing identifying goes in a lesson: no paths, URLs, hostnames of private servers, ids, emails or
copied data values. If the draft fails the schema you get the violations back and may fix them
and call once more.`;

function uiOf(ctx: ExtensionContext): ProposeUiContext {
  return {
    hasUI: ctx.hasUI,
    ui: {
      notify: (message, level) => ctx.ui.notify(message, level),
      select: (title, options) => ctx.ui.select(title, options),
      confirm: (title, message) => ctx.ui.confirm(title, message),
    },
  };
}

export function registerLessonProposeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: LESSON_PROPOSE_TOOL_NAME,
    label: "Propose a Lesson",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      // Never throw out of execute: the model always gets an answer it can act
      // on, and a thrown error would carry a stack instead.
      try {
        const outcome = await proposeLesson(params as unknown as LessonProposalInput, uiOf(ctx));
        if (outcome.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `The user approved it. Lesson saved as ${outcome.id}. Tell them it is saved, ` +
                  `as a local draft that stays on this machine.`,
              },
            ],
            details: { id: outcome.id, saved: true },
          };
        }
        return {
          content: [{ type: "text" as const, text: outcome.message }],
          details: { error: true, reason: outcome.reason },
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: "lesson_propose failed; nothing was saved." }],
          details: { error: true, reason: "exception" },
        };
      }
    },
    renderResult: (result) => {
      const details = result.details as
        { saved?: boolean; id?: string; reason?: string } | undefined;
      if (details?.saved) return new Text(`Lesson saved: ${details.id}`);
      return new Text(`Lesson not saved (${details?.reason ?? "rejected"})`);
    },
  });
}
