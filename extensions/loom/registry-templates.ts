/**
 * Fetching the template a proposal is validated against and an approval
 * freezes, through galaxy-ops in process -- the same operations galaxy-mcp
 * exposes, so the gated path reads Galaxy the way the tools we recommend do.
 *
 * What gets frozen (the registry-core handoff asked slice 2 to confirm this):
 *
 * - a tool: Galaxy's own description of it with `io_details`
 *   (`getToolDetails`), not galaxy-mcp's filled-in skeleton;
 * - a workflow: Galaxy's details at the resolved version
 *   (`getWorkflowDetails`) together with the run form's input slots
 *   (`resolveWorkflowSlots`, which reads `download?style=run`);
 * - a user-defined tool: the tool's record from Galaxy, representation and
 *   all, found by uuid in `listUserTools`.
 *
 * Where galaxy-ops can't yet do what's asked it says so instead of guessing:
 * it can't describe a tool at a version other than the one its id names,
 * template an older workflow version, or fetch one user-defined tool by uuid.
 * Those are listed in the PR as galaxy-ops gaps.
 */

import * as fs from "fs";
import * as path from "path";
import {
  getToolDetails,
  getWorkflowDetails,
  listUserTools,
  resolveWorkflowSlots,
  type GalaxyContext,
} from "@galaxyproject/galaxy-ops";
import { readEnv } from "../../shared/orbit-env.js";
import { appendActivityEvent } from "./activity";
import { galaxyOpsContext } from "./galaxy-api";
import { UNPINNED, targetId, type ProposalTarget } from "./registry-proposal";
import type { TemplateSnapshot } from "./registry-submitter";
import { resolveReplayPath } from "./submission-replay";

export type TemplateFetcher = (
  target: ProposalTarget,
  historyId: string,
  signal?: AbortSignal,
) => Promise<TemplateSnapshot>;

/** A template fetch that can't be done, with a sentence the model or user can act on. */
export class TemplateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateUnavailableError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Galaxy's answer as a sentence, without the stack. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchTemplateWith(
  ctx: GalaxyContext,
  target: ProposalTarget,
  historyId: string,
): Promise<TemplateSnapshot> {
  const id = targetId(target);
  if (!id) throw new TemplateUnavailableError(`the ${target.kind} has no id`);
  try {
    if (target.kind === "tool") {
      const body = await getToolDetails({ toolId: id, ioDetails: true }, ctx);
      if (typeof body.version !== "string" || body.version === "") {
        throw new TemplateUnavailableError(`Galaxy did not say which version of ${id} it has`);
      }
      return { body, version: body.version };
    }

    if (target.kind === "workflow") {
      const details = await getWorkflowDetails({ workflowId: id }, ctx);
      const latest = String(details.version);
      if (target.version !== UNPINNED && target.version !== latest) {
        throw new TemplateUnavailableError(
          `workflow ${id} is at version ${latest}; galaxy-ops can only read the run form of ` +
            `the latest version, so version ${target.version} can't be approved yet`,
        );
      }
      const resolved = await resolveWorkflowSlots(ctx, id, historyId);
      return { body: { workflow: details, slots: resolved.slots }, version: latest };
    }

    for (let offset = 0; offset < 10_000;) {
      const page = await listUserTools({ active: true, limit: 100, offset }, ctx);
      const hit = page.items.find((t) => t.uuid === id);
      if (hit) {
        const rep = isRecord(hit.representation) ? hit.representation : null;
        const version = typeof rep?.version === "string" ? rep.version : "";
        if (!version) {
          throw new TemplateUnavailableError(
            `user-defined tool ${id} has no version in its definition`,
          );
        }
        return { body: hit, version };
      }
      if (!page.pagination.hasNext || page.pagination.nextOffset === undefined) break;
      offset = page.pagination.nextOffset;
    }
    throw new TemplateUnavailableError(`no active user-defined tool with uuid ${id}`);
  } catch (err) {
    if (err instanceof TemplateUnavailableError) throw err;
    throw new TemplateUnavailableError(
      `Galaxy couldn't describe ${target.kind} ${id}: ${reason(err)}`,
    );
  }
}

/** The fetcher for the configured Galaxy server. */
export const galaxyTemplateFetcher: TemplateFetcher = async (target, historyId, signal) => {
  const ctx = galaxyOpsContext(signal);
  if (!ctx) {
    throw new TemplateUnavailableError(
      "Galaxy isn't configured in this session (GALAXY_URL, GALAXY_API_KEY)",
    );
  }
  return fetchTemplateWith(ctx, target, historyId);
};

// ─────────────────────────────────────────────────────────────────────────────
// Eval-only replay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `LOOM_TEMPLATE_REPLAY` names a JSON file inside the session directory whose
 * keys are `<kind>:<id>` and whose values are `{body, version}` -- recorded
 * templates, so the Tier-1 scenarios can approve without a Galaxy server.
 *
 * Same constraints as the submission replay: off unless set, the file must
 * resolve inside the session directory, and every fetch it answers writes a
 * `template.replay` activity row, so an approval frozen from a replayed
 * template is never indistinguishable from one frozen from Galaxy. It only
 * stands in for Galaxy's answer; consent still comes from `/approve`.
 */
export function replayTemplateFetcher(sessionDir: string): TemplateFetcher | null {
  const configured = readEnv("TEMPLATE_REPLAY")?.trim();
  if (!configured) return null;
  const file = resolveReplayPath(sessionDir, configured);
  return async (target) => {
    const key = `${target.kind}:${targetId(target)}`;
    let entry: unknown;
    try {
      if (!file) throw new Error("outside the session directory");
      entry = (JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>)[key];
    } catch (err) {
      throw new TemplateUnavailableError(`template replay unreadable: ${reason(err)}`);
    }
    if (!isRecord(entry) || typeof entry.version !== "string" || !("body" in entry)) {
      throw new TemplateUnavailableError(`template replay has no entry for ${key}`);
    }
    appendActivityEvent(sessionDir, {
      timestamp: new Date().toISOString(),
      kind: "template.replay",
      source: "template-replay",
      payload: { file: path.relative(sessionDir, file as string), key, version: entry.version },
    });
    return { body: entry.body, version: entry.version };
  };
}

/** Replay when the eval seam is on, Galaxy otherwise. */
export function templateFetcherFor(sessionDir: string): TemplateFetcher {
  return replayTemplateFetcher(sessionDir) ?? galaxyTemplateFetcher;
}
