/**
 * `/override <step-key> <reason>` -- the user-originated exception to the
 * evidence gate.
 *
 * The gate (`evidence-gate.ts`) denies a plan-step completion that contradicts
 * the step's own `loom-invocation` block. It used to let the model's second
 * attempt through, which made the deny advisory. Removing that leaves the gate
 * with no escape hatch at all, and a gate with no escape hatch is one people
 * turn off -- the residual `in_progress` pin (credentials dropping mid-session
 * leaves an invocation that no agent action can advance) is a real way to be
 * stuck behind a correct-looking check.
 *
 * So the exception exists, and it belongs to the person, not the model. It is
 * addressed to one named step, it carries a reason, it is recorded to
 * `activity.jsonl` as `evidence.override` alongside the invocation status at
 * the time, and it is spent by the first write it clears. That is what makes
 * the warn-mode audit readable later: an override is a row someone chose to
 * write, not a retry the model discovered.
 *
 * Bare `/override` prints what the gate is currently holding, because after a
 * deny the step is still `- [ ]` and the user has no other way to learn the key
 * to pass back.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendActivityEvent } from "./activity.js";
import { getNotebookPath } from "./state.js";
import {
  grantEvidenceOverride,
  outstandingContradictions,
  resolveMode,
  resolveStepKey,
} from "./evidence-gate.js";

const USAGE =
  "Usage: /override <step-key> <reason>  (e.g. /override plan-a-step-2 job finished, block is stale)";

export type OverrideResult =
  { ok: true; message: string; event: Record<string, unknown> } | { ok: false; message: string };

/**
 * Decide what `/override` does for one set of arguments against one notebook.
 * Pure: the caller grants the token, writes the activity row, and notifies.
 */
export function planOverride(content: string, args: string): OverrideResult {
  const raw = args.trim();
  if (!raw) return { ok: false, message: renderStatus(content) };

  const split = raw.indexOf(" ");
  if (split === -1) {
    return { ok: false, message: `A reason is required, so the record says why.\n${USAGE}` };
  }
  const keyInput = raw.slice(0, split);
  const reason = raw.slice(split + 1).trim();
  if (!reason) {
    return { ok: false, message: `A reason is required, so the record says why.\n${USAGE}` };
  }

  const step = resolveStepKey(content, keyInput);
  if (!step) {
    return {
      ok: false,
      message: `No plan step matches '${keyInput}'.\n${renderStatus(content)}`,
    };
  }

  // Only a standing contradiction can be overridden. Pre-authorizing one that
  // does not exist yet would hand out a token the gate might spend on a
  // different contradiction later, which is not what the user agreed to.
  const outstanding = outstandingContradictions(content).find((c) => c.step.key === step.key);
  if (!outstanding) {
    return {
      ok: false,
      message:
        `Nothing to override on "${step.text}": no in-flight Galaxy invocation is bound to it. ` +
        `The evidence gate is not holding this step.`,
    };
  }

  return {
    ok: true,
    message:
      `Override recorded for "${step.text}" (${outstanding.invocation.status}). ` +
      `The next completion flip on this step goes through; a later contradiction on ` +
      `it is denied again.`,
    event: {
      step: step.key,
      stepState: step.state,
      invocationId: outstanding.invocation.invocationId,
      invocationStatus: outstanding.invocation.status,
      mode: resolveMode(),
      reason,
    },
  };
}

/** What the gate is holding right now, and how to address it. */
export function renderStatus(content: string): string {
  const outstanding = outstandingContradictions(content);
  const mode = resolveMode();
  if (outstanding.length === 0) {
    return `Evidence gate: ${mode}. No plan step is currently contradicted by an in-flight invocation.\n${USAGE}`;
  }
  const lines = outstanding.map(
    (c) => `  ${c.step.anchor ?? c.step.key}  ${c.invocation.status}  ${c.step.text}`,
  );
  return (
    `Evidence gate: ${mode}. Steps an in-flight invocation contradicts:\n` +
    lines.join("\n") +
    `\n${USAGE}`
  );
}

export function registerEvidenceOverrideCommand(pi: ExtensionAPI): void {
  pi.registerCommand("override", {
    description: "Override the evidence gate for one plan step, with a recorded reason",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const nbPath = getNotebookPath();
      if (!nbPath) {
        ctx.ui.notify(
          "No notebook in this session, so the evidence gate has nothing to hold.",
          "info",
        );
        return;
      }
      let content: string;
      try {
        content = fs.readFileSync(nbPath, "utf-8");
      } catch {
        ctx.ui.notify(`Couldn't read ${nbPath}.`, "error");
        return;
      }

      const result = planOverride(content, args ?? "");
      if (!result.ok) {
        ctx.ui.notify(result.message, "info");
        return;
      }

      grantEvidenceOverride(String(result.event.step));
      appendActivityEvent(path.dirname(nbPath), {
        timestamp: new Date().toISOString(),
        kind: "evidence.override",
        source: "user",
        payload: result.event,
      });
      ctx.ui.notify(result.message, "info");
    },
  });
}
