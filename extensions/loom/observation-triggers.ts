/**
 * The deterministic triggers that raise an observation, and the one path that
 * delivers one.
 *
 * Every trigger ENQUEUES; nothing is built, shown or sent from inside the hook
 * that noticed it. That is not bookkeeping -- in `ask` mode delivery blocks on
 * ctx.ui.confirm, and awaiting a human inside a tool_result handler would stall
 * the agent loop mid-turn. The queue drains on agent_settled, when the turn is
 * over and the user is reading anyway.
 *
 * Three triggers, all deterministic, none of them a model judgement:
 *   - a galaxy_* tool result with isError
 *   - the same tool and the same normalized signature RETRY_LOOP_THRESHOLD times
 *   - the evidence gate blocking a plan-step completion
 * A fourth, the user's own `/observe`, lives in observations-command.ts and
 * delivers immediately because the user is standing right there.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import {
  normalizeSignature,
  scanObservationForLeaks,
  validateObservation,
} from "../../shared/observation-contract.js";
import type {
  Observation,
  ObservationKind,
  ObservationTrigger,
} from "../../shared/observation-contract.js";
import {
  appendSentLog,
  appendToObservationOutbox,
  buildObservation,
  collectObservationEnvelope,
  extractDatatypes,
  extractToolIds,
  recordGalaxyVersionFromConnect,
  resetGalaxyVersion,
  saveRetractToken,
  sentLogEntryFor,
  submitObservation,
} from "./observations.js";
import type { ObservationFacts, SubmitObservationResult } from "./observations.js";
import { getOrCreateInstallToken, resolveObservationsMode } from "./observations-config.js";
import type { ObservationsMode } from "./observations-config.js";
import { onEvidenceDecision } from "./evidence-gate.js";
import { galaxyCall } from "./mcp-recovery.js";
import { appendActivityEvent } from "./activity.js";
import { getNotebookPath } from "./state.js";
import { confirmObservation, describeObservation } from "./observation-ui.js";

export const RETRY_LOOP_THRESHOLD = 3;
/**
 * A local ceiling on top of the Worker's 200-per-24h. One pathological session
 * should not be able to spend a day's budget, and 20 reports from one session
 * is already more signal than triage can use.
 */
export const OBSERVATIONS_SESSION_CAP = 20;

export interface TriggerState {
  /** `${tool}|${signature}` -> how many times it has failed this session. */
  counts: Map<string, number>;
  /** `${kind}|${tool}|${signature}` already reported, so nothing repeats. */
  emitted: Set<string>;
  /** Observations actually sent or queued this session. */
  delivered: number;
}

export function newTriggerState(): TriggerState {
  return { counts: new Map(), emitted: new Set(), delivered: 0 };
}

/**
 * Pure. One failure of one tool with one signature in, at most one report out.
 *
 * A loop therefore yields two observations, not three or ten: the first
 * failure is reported as a tool-error, and the third is reported as a
 * retry-loop (which is the more informative one -- it says the agent could not
 * get past it). Everything in between, and everything after, is silent.
 */
export function decideToolResultObservation(
  state: TriggerState,
  key: { mcpTool: string; signature: string },
): { kind: ObservationKind; trigger: ObservationTrigger } | null {
  if (!key.mcpTool || !key.signature) return null;
  const k = `${key.mcpTool}|${key.signature}`;
  const count = (state.counts.get(k) ?? 0) + 1;
  state.counts.set(k, count);

  const once = (kind: ObservationKind, trigger: ObservationTrigger) => {
    const marker = `${kind}|${k}`;
    if (state.emitted.has(marker)) return null;
    state.emitted.add(marker);
    return { kind, trigger };
  };

  if (count === 1) return once("tool-error", "tool_error");
  if (count === RETRY_LOOP_THRESHOLD) return once("retry-loop", "retry_loop");
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session state
// ─────────────────────────────────────────────────────────────────────────────

let state = newTriggerState();
const pending: ObservationFacts[] = [];

export function resetObservationTriggers(): void {
  state = newTriggerState();
  pending.length = 0;
  resetGalaxyVersion();
}

export function enqueueObservation(facts: ObservationFacts): void {
  pending.push(facts);
}

export function pendingObservationCount(): number {
  return pending.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Facts from a tool result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * galaxyCall normalises both surfaces -- a direct `galaxy_*` call and the
 * `mcp` proxy shape -- so a proxied failure is not silently invisible.
 */
export function factsForToolResult(
  toolName: string,
  input: Record<string, unknown>,
  text: string,
): ObservationFacts | null {
  const call = galaxyCall(toolName, input ?? {});
  if (!call) return null;
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  return {
    kind: "tool-error",
    trigger: "tool_error",
    mcpTool: call.name,
    toolIds: extractToolIds(call.args),
    datatypes: extractDatatypes(call.args),
    rawSignature: raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery
// ─────────────────────────────────────────────────────────────────────────────

export type DeliveryOutcome = "sent" | "queued" | "declined" | "invalid" | "skipped";

/**
 * Everything impure, injected. The privacy-relevant decisions -- does this
 * send, does the user see it first, is it legal to send at all -- are then
 * testable with no pi session, no filesystem and no network.
 */
export interface DeliverDeps {
  mode: ObservationsMode;
  state: TriggerState;
  installToken(): string;
  describe(facts: ObservationFacts, ctx: ExtensionContext): Promise<string>;
  confirm(obs: Observation, ctx: ExtensionContext): Promise<boolean>;
  submit(obs: Observation): Promise<SubmitObservationResult>;
  record(kind: string, payload: Record<string, unknown>): void;
}

export async function deliverObservation(
  facts: ObservationFacts,
  ctx: ExtensionContext,
  deps: DeliverDeps,
): Promise<DeliveryOutcome> {
  if (deps.mode === "off") {
    deps.record("observation.skipped", { reason: "mode-off" });
    return "skipped";
  }
  if (deps.state.delivered >= OBSERVATIONS_SESSION_CAP) {
    deps.record("observation.skipped", { reason: "session-cap" });
    return "skipped";
  }
  // `ask` without a dialog surface is not "send it anyway", it is "don't".
  if (deps.mode === "ask" && !ctx.hasUI) {
    deps.record("observation.skipped", { reason: "no-ui" });
    return "skipped";
  }

  let description: string;
  try {
    description = await deps.describe(facts, ctx);
  } catch {
    // A description is a nice-to-have; the structured observation is the point.
    description = "";
  }

  // The install token is written to config here, before any confirm, because a
  // valid payload needs one and the confirm has to show the real payload. It
  // is local state until the user says send.
  const obs = buildObservation(
    { ...facts, description },
    { ...collectObservationEnvelope(deps.installToken()) },
  );

  const validity = validateObservation(obs);
  const leaks = scanObservationForLeaks(obs);
  deps.record("observation.built", {
    kind: obs.kind,
    trigger: obs.trigger,
    stage: obs.stage,
    signature: obs.signature,
    mcpTool: obs.mcpTool ?? "",
    toolIds: obs.tools.map((t) => t.id).join(","),
    datatypes: obs.datatypes.join(","),
    server: obs.galaxy.server,
    descriptionLength: obs.description.length,
    valid: validity.ok,
    leakScan: leaks.length === 0 ? "clean" : "dirty",
  });

  if (!validity.ok || leaks.length > 0) {
    // Fail closed. Nothing is sent, and only field and pattern names are
    // recorded -- the offending value stays out of the log too.
    deps.record("observation.invalid", {
      kind: obs.kind,
      errors: (validity.ok ? [] : validity.errors).join(","),
      leaks: leaks.join(","),
    });
    return "invalid";
  }

  if (deps.mode === "ask" && !(await deps.confirm(obs, ctx))) {
    deps.record("observation.declined", { kind: obs.kind, signature: obs.signature });
    return "declined";
  }

  const res = await deps.submit(obs);
  if (res.ok) {
    if (res.retractToken) saveRetractToken(obs.id, res.retractToken);
    appendSentLog(sentLogEntryFor(obs, "sent"));
    deps.state.delivered += 1;
    deps.record("observation.sent", { id: obs.id, kind: obs.kind, signature: obs.signature });
    return "sent";
  }
  if (res.queueable) {
    appendToObservationOutbox(obs);
    appendSentLog(sentLogEntryFor(obs, "queued"));
    deps.state.delivered += 1;
    deps.record("observation.queued", {
      id: obs.id,
      kind: obs.kind,
      status: res.status ?? 0,
      reason: res.error ?? "unreachable",
    });
    return "queued";
  }
  deps.record("observation.invalid", {
    kind: obs.kind,
    status: res.status ?? 0,
    errors: (res.errors ?? []).join(","),
    leaks: "",
  });
  return "invalid";
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/** Activity rows land beside the session's notebook, like every other row. */
export function recordObservationActivity(
  kind: string,
  payload: Record<string, unknown>,
  source = "observations",
): void {
  const notebook = getNotebookPath();
  if (!notebook) return;
  appendActivityEvent(path.dirname(notebook), {
    timestamp: new Date().toISOString(),
    kind,
    source,
    payload,
  });
}

/** The production dep set. */
export function liveDeliverDeps(
  ctxMode: ObservationsMode = resolveObservationsMode(),
): DeliverDeps {
  return {
    mode: ctxMode,
    state,
    installToken: getOrCreateInstallToken,
    describe: (facts, ctx) => describeObservation(ctxMode, facts, ctx),
    confirm: confirmObservation,
    submit: submitObservation,
    record: (kind, payload) => recordObservationActivity(kind, payload),
  };
}

function errorTextOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

export function registerObservationTriggers(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    resetObservationTriggers();
  });

  pi.on("tool_result", async (event) => {
    // Registered AFTER secret redaction in index.ts, so `content` here is the
    // already-scrubbed text the model sees. Reading the raw result would put
    // an API key one normalization away from the wire.
    if (
      galaxyCall(event.toolName, event.input ?? {})?.name === "galaxy_connect" &&
      !event.isError
    ) {
      recordGalaxyVersionFromConnect(errorTextOf(event.content));
    }
    if (resolveObservationsMode() === "off") return;

    const failed = event.isError || Boolean((event.details as { error?: unknown })?.error);
    if (!failed) return;
    const facts = factsForToolResult(event.toolName, event.input, errorTextOf(event.content));
    if (!facts) return;

    const decision = decideToolResultObservation(state, {
      mcpTool: facts.mcpTool ?? "",
      signature: normalizeSignature(facts.rawSignature),
    });
    if (!decision) return;
    enqueueObservation({ ...facts, kind: decision.kind, trigger: decision.trigger });
  });

  onEvidenceDecision((info) => {
    if (info.outcome !== "blocked") return;
    if (resolveObservationsMode() === "off") return;
    enqueueObservation({
      kind: "assertion-failed",
      trigger: "assertion",
      stage: "result-interpretation",
      toolIds: [],
      datatypes: [],
      // No step text, no anchor, no invocation id: the signal is the shape of
      // the mistake, and the shape is the whole message.
      rawSignature:
        "the evidence gate refused a plan-step completion claimed over an unfinished Galaxy invocation",
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    while (pending.length > 0) {
      const facts = pending.shift();
      if (!facts) break;
      try {
        await deliverObservation(facts, ctx, liveDeliverDeps());
      } catch (err) {
        // A failed delivery must never take the settle handler down with it.
        console.error("observation delivery failed:", err);
      }
    }
  });
}
