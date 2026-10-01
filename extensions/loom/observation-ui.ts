/**
 * Putting an observation in front of a human, and the one bounded model call
 * that can write its description.
 *
 * Two rules shape this file. The confirm shows the EXACT payload, field by
 * field, because "we send structured signals and a generic description" is a
 * claim the user should be able to check rather than take on trust -- the only
 * value held back is the install token, which is local state and is not
 * something to invite anyone to paste into a bug report.
 *
 * And the model that writes the description never sees the raw tool output. It
 * gets the already-normalized signature and the structured fields, so a leak
 * cannot originate in the input to this call, only in the model's invention --
 * which the validator then catches. A description that fails validation is
 * dropped, never trimmed.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
// pi 0.80 moved the global pi-ai API to /compat. The extension loader aliases
// the root at runtime, but the typecheck resolves the published types, so
// import the real path -- same as teams/tool.ts.
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  DESCRIPTION_MAX,
  normalizeSignature,
  validateObservation,
} from "../../shared/observation-contract.js";
import type { Observation } from "../../shared/observation-contract.js";
import type { ObservationFacts } from "./observations.js";
import type { ObservationsMode } from "./observations-config.js";

export const DESCRIPTION_TIMEOUT_MS = 8000;

export const PRIVACY_STATEMENT =
  "Only the fields above are sent, to the Galaxy team's private intake queue, over " +
  "an install-specific random token rather than any account or machine identity. No " +
  "transcript, no data values, no file paths, no history or dataset ids, no URLs. " +
  "Rows expire after 180 days and `/observations retract <id>` deletes one at any time. " +
  "`/observations mode off` stops collection entirely.";

// ─────────────────────────────────────────────────────────────────────────────
// The confirm
// ─────────────────────────────────────────────────────────────────────────────

function orNone(value: string): string {
  return value.length > 0 ? value : "(none)";
}

/** Pure, so the thing the user is shown is pinned by a test. */
export function renderObservationForConfirm(obs: Observation): string {
  const tools = obs.tools.map((t) => (t.version ? `${t.id} ${t.version}` : t.id)).join(", ");
  return [
    `kind: ${obs.kind}`,
    `stage: ${obs.stage}`,
    `trigger: ${obs.trigger}`,
    `signature: ${obs.signature}`,
    `description: ${orNone(obs.description)}`,
    `mcp tool: ${orNone(obs.mcpTool ?? "")}`,
    `galaxy tools: ${orNone(tools)}`,
    `datatypes: ${orNone(obs.datatypes.join(", "))}`,
    `galaxy server: ${obs.galaxy.server}${obs.galaxy.version ? ` (${obs.galaxy.version})` : ""}`,
    `client: ${obs.client.app} ${obs.client.version} ${obs.client.platform}${obs.client.wsl ? " (wsl)" : ""}`,
    `sent at: ${obs.clientTs}`,
    `id: ${obs.id}`,
    "install token: (32 random hex, stored locally, not shown)",
  ].join("\n");
}

export async function confirmObservation(
  obs: Observation,
  ctx: ExtensionContext,
): Promise<boolean> {
  try {
    return await ctx.ui.confirm(
      "Send this observation to the Galaxy team?",
      `${renderObservationForConfirm(obs)}\n\n${PRIVACY_STATEMENT}`,
    );
  } catch {
    // A stale context after a session swap, or a shell with no dialog. Either
    // way the answer is no.
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The description
// ─────────────────────────────────────────────────────────────────────────────

export const DESCRIPTION_SYSTEM_PROMPT = [
  "You write one sentence describing a Galaxy failure pattern for a public",
  "knowledge base. You are given only normalized, already-redacted fields --",
  "you have no access to the researcher's data and must not guess at it.",
  "",
  "Rules, all of them hard:",
  "- One line. At most 500 characters. Plain printable ASCII.",
  "- Describe the SITUATION and what went wrong in general terms, so another",
  "  researcher hitting the same thing would recognise it.",
  "- no URLs, no file paths, no email addresses, no hex ids, no dataset,",
  "  history or hid numbers, no personal or project names, no data values.",
  "- If the fields do not say enough to describe the situation, answer with",
  "  the single word NONE.",
].join("\n");

export function describeFactsPrompt(facts: ObservationFacts): string {
  return [
    `kind: ${facts.kind}`,
    `mcp tool: ${facts.mcpTool ?? "(none)"}`,
    `galaxy tools: ${orNone(facts.toolIds.join(", "))}`,
    `datatypes: ${orNone(facts.datatypes.join(", "))}`,
    `normalized signature: ${normalizeSignature(facts.rawSignature)}`,
  ].join("\n");
}

export type CompleteFn = (
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal,
) => Promise<string>;

/**
 * Accept a candidate description only if the contract would accept it. The
 * probe payload is a minimal legal observation with this description dropped
 * in, so the single source of truth for "is this text safe" stays the
 * validator rather than a second copy of its rules.
 */
function acceptDescription(candidate: string): string {
  const text = String(candidate ?? "")
    .split(/\r?\n/)[0]
    .trim()
    .slice(0, DESCRIPTION_MAX);
  if (!text || text === "NONE") return "";
  const probe = {
    schemaVersion: 1 as const,
    id: "00000000-0000-4000-8000-000000000000",
    clientTs: "2026-01-01T00:00:00.000Z",
    client: { app: "loom-cli" as const, version: "0", platform: "linux" as const },
    installToken: "0".repeat(32),
    kind: "other" as const,
    stage: "unknown" as const,
    trigger: "explicit" as const,
    tools: [],
    datatypes: [],
    signature: "unknown",
    galaxy: { server: "private" },
    description: text,
  };
  return validateObservation(probe).ok ? text : "";
}

export async function describeWithModel(
  facts: ObservationFacts,
  complete: CompleteFn,
  signal: AbortSignal = AbortSignal.timeout(DESCRIPTION_TIMEOUT_MS),
): Promise<string> {
  try {
    return acceptDescription(
      await complete(DESCRIPTION_SYSTEM_PROMPT, describeFactsPrompt(facts), signal),
    );
  } catch {
    return "";
  }
}

/**
 * The real one-shot call. Bounded by the timeout and a small token cap; no
 * tools, no retry. Goes through the session's model registry when there is one,
 * because that is what resolves the credentials the session actually runs on
 * (a CLI --api-key, OAuth, a custom endpoint) -- the bare compat call only sees
 * ambient env keys.
 */
const DESCRIPTION_MAX_TOKENS = 300;

function liveComplete(ctx: ExtensionContext): CompleteFn | null {
  const model = ctx.model;
  if (!model) return null;
  const registry = ctx.modelRegistry;
  return async (systemPrompt, userMessage, signal) => {
    const context = {
      systemPrompt,
      messages: [{ role: "user" as const, content: userMessage, timestamp: Date.now() }],
    };
    const options = { signal, maxTokens: DESCRIPTION_MAX_TOKENS };
    const msg = registry
      ? await registry.complete(model, context, options)
      : await completeSimple(model, context, options);
    return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  };
}

/**
 * In `ask` mode the human writes it, because they are already being shown the
 * payload. One re-prompt on a rejection, then empty -- a third round of "that
 * still has an email address in it" is nagging.
 */
export async function askUserForDescription(
  facts: ObservationFacts,
  ctx: ExtensionContext,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string | undefined;
    try {
      raw = await ctx.ui.input(
        "One line about what went wrong (optional, generic -- no ids, paths or names)",
        describeFactsPrompt(facts).split("\n").pop() ?? "",
      );
    } catch {
      return "";
    }
    if (!raw || !raw.trim()) return "";
    const accepted = acceptDescription(raw);
    if (accepted) return accepted;
    try {
      ctx.ui.notify(
        "That description looked like it carried an id, path, URL or address, so it was left blank. Try again, or press enter to skip.",
        "warning",
      );
    } catch {
      return "";
    }
  }
  return "";
}

export async function describeObservation(
  mode: ObservationsMode,
  facts: ObservationFacts,
  ctx: ExtensionContext,
): Promise<string> {
  if (mode === "off") return "";
  if (mode === "ask") return ctx.hasUI ? askUserForDescription(facts, ctx) : "";
  const complete = liveComplete(ctx);
  return complete ? describeWithModel(facts, complete) : "";
}
