/**
 * Auto-registration: every Galaxy submission gets a notebook block, the
 * moment it happens, without the agent being asked to do anything.
 *
 * Recording used to be model-initiated -- prose in the system prompt asking
 * for `galaxy_invocation_record` after a submission, and a record tool that
 * verified nothing about the id it was handed. A turn that died between the
 * submit and the record left a running job nobody was tracking, and a
 * distracted model left the same. This hook closes that by reading the id out
 * of Galaxy's own response to the submission, which is also what makes
 * `server_verified: true` mean anything.
 *
 * Two placement facts. It is registered in the mode-independent part of
 * index.ts rather than inside the exec-guard, because the guard is skipped
 * when `LOOM_LOCAL_EXEC=off` (the web/container shell) and capture has to
 * work there too. And it hangs off `tool_execution_start` as well as
 * `tool_execution_end`, because pi's end event carries only `{toolCallId,
 * toolName, result, isError}` -- the tool's *arguments* are on the start
 * event, and `run_user_tool`'s uuid and the uploads' file names exist nowhere
 * else.
 *
 * Attribution is captured at dispatch, not at result. The attempt id is
 * minted when the tool starts and the step anchor is read then too, so a
 * submission that takes thirty seconds to answer is attributed to the step
 * that made it rather than to whatever the agent moved on to. That is the
 * whole reason for the in-flight map.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { stringify as stringifyYaml } from "yaml";
import { appendActivityEvent } from "./activity";
import { getGalaxyConfig } from "./galaxy-api";
import { upsertJobBlock, type JobYaml } from "./galaxy-job-block";
import { upsertUdtBlock } from "./galaxy-udt-block";
import {
  isSubmissionTool,
  parseSubmission,
  resolveResultPayload,
  type ParsedSubmission,
  type ResolvedResult,
} from "./galaxy-submission";
import type { HarnessBlockFields } from "./harness-block-fields";
import {
  readNotebook,
  upsertInvocationBlock,
  withNotebookLock,
  writeNotebook,
  type InvocationYaml,
} from "./notebook-writer";
import { getCurrentStepAnchor, getNotebookPath } from "./state";
import { ulid } from "./ulid";

/** What a block carries when nothing pointed the submission at a plan step. */
export const UNATTRIBUTED = "unattributed";

/** Where per-attempt provenance lives, relative to the analysis directory. */
export const PROVENANCE_DIR = path.join(".loom", "provenance");
export const UDT_PROVENANCE_DIR = path.join(PROVENANCE_DIR, "udt");

interface Dispatch {
  attemptId: string;
  toolName: string;
  args: Record<string, unknown>;
  stepAnchor: string;
  submittedAt: string;
}

/**
 * In-flight submissions, keyed by pi's tool call id.
 *
 * Bounded because a start without a matching end is possible -- an aborted
 * turn, a tool that never returns -- and an unbounded map in a long session
 * is a slow leak. The cap is far above any real concurrent tool count; when
 * it is hit the oldest entry goes, which at worst costs that submission its
 * dispatch-time anchor, not its registration.
 */
const MAX_IN_FLIGHT = 256;
const inFlight = new Map<string, Dispatch>();

/** Test seam: drop in-flight state between cases. */
export function resetSubmissionCapture(): void {
  inFlight.clear();
}

function rememberDispatch(toolCallId: string, toolName: string, args: unknown): Dispatch {
  const dispatch: Dispatch = {
    attemptId: ulid(),
    toolName,
    args: (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
    stepAnchor: getCurrentStepAnchor() ?? UNATTRIBUTED,
    submittedAt: new Date().toISOString(),
  };
  if (inFlight.size >= MAX_IN_FLIGHT) {
    const oldest = inFlight.keys().next();
    if (!oldest.done) inFlight.delete(oldest.value);
  }
  inFlight.set(toolCallId, dispatch);
  return dispatch;
}

/**
 * Recover the dispatch record, or synthesise one.
 *
 * A missing record means we never saw the start event, so we do NOT fall back
 * to the current step anchor: that is exactly the misattribution the
 * capture-at-dispatch design exists to avoid. Unattributed is the honest
 * answer.
 */
function takeDispatch(toolCallId: string, toolName: string): Dispatch {
  const found = inFlight.get(toolCallId);
  if (found) {
    inFlight.delete(toolCallId);
    return found;
  }
  return {
    attemptId: ulid(),
    toolName,
    args: {},
    stepAnchor: UNATTRIBUTED,
    submittedAt: new Date().toISOString(),
  };
}

function sessionDir(): string | null {
  const nb = getNotebookPath();
  return nb ? path.dirname(nb) : null;
}

function record(kind: string, payload: Record<string, unknown>): void {
  const dir = sessionDir();
  if (!dir) return;
  appendActivityEvent(dir, {
    timestamp: new Date().toISOString(),
    kind,
    source: "submission-capture",
    payload,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Filenames
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make a Galaxy-supplied tool id safe to use as a filename.
 *
 * The id reaches us from Galaxy, but Galaxy derived it from the agent's own
 * tool definition, so it is agent-influenced and a path separator or a `..`
 * in it would write outside `.loom/provenance/udt/`. Everything outside a
 * conservative allowlist becomes an underscore, leading dots go, and the
 * result is capped; an id that sanitises away to nothing is rejected by the
 * caller rather than written to some default name.
 */
export function safeProvenanceFilename(toolId: string): string | null {
  const cleaned = toolId
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (!cleaned || /^_+$/.test(cleaned)) return null;
  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing the record
// ─────────────────────────────────────────────────────────────────────────────

function harnessFields(dispatch: Dispatch, historyId?: string): HarnessBlockFields {
  return {
    attemptId: dispatch.attemptId,
    ...(historyId ? { historyId } : {}),
    submittedBy: "harness",
    serverVerified: true,
    enrichment: "pending",
    enrichmentAttempts: 0,
  };
}

/**
 * Write every block this submission produces in one locked read-modify-write.
 *
 * One lock for the whole set, not one per job: a mapped-over run produces a
 * block per job, and N separate read-modify-write cycles against the same
 * file is N chances to lose one to a concurrent writer.
 */
async function writeBlocks(
  notebookPath: string,
  submission: ParsedSubmission,
  dispatch: Dispatch,
): Promise<void> {
  const galaxyServerUrl = getGalaxyConfig()?.url ?? "";
  const harness = harnessFields(dispatch, submission.historyId);

  await withNotebookLock(notebookPath, async () => {
    let content = await readNotebook(notebookPath);

    if (submission.kind === "invocation" && submission.invocationId) {
      const inv: InvocationYaml = {
        invocationId: submission.invocationId,
        galaxyServerUrl,
        notebookAnchor: dispatch.stepAnchor,
        label: submission.label,
        submittedAt: dispatch.submittedAt,
        status: "in_progress",
      };
      content = upsertInvocationBlock(content, inv, harness);
    }

    for (const job of submission.jobs ?? []) {
      const block: JobYaml = {
        jobId: job.jobId,
        galaxyServerUrl,
        notebookAnchor: dispatch.stepAnchor,
        label: submission.label,
        ...(job.toolId ? { toolId: job.toolId } : {}),
        submittedAt: dispatch.submittedAt,
        status: "in_progress",
      };
      // tool_version is only ever in the submission response -- GET
      // /api/jobs/{id} drops it -- so seed the job summary with it now rather
      // than hoping enrichment can find it later.
      content = upsertJobBlock(content, block, {
        ...harness,
        ...(job.historyId && !submission.historyId ? { historyId: job.historyId } : {}),
        jobs: [
          {
            jobId: job.jobId,
            ...(job.toolId ? { toolId: job.toolId } : {}),
            ...(job.toolVersion ? { toolVersion: job.toolVersion } : {}),
          },
        ],
      });
    }

    if (submission.kind === "udt" && submission.udt) {
      const definition = await writeUdtDefinition(
        path.dirname(notebookPath),
        submission.udt.toolId,
        submission.udt.representation,
      );
      if (definition) {
        content = upsertUdtBlock(content, {
          toolId: submission.udt.toolId,
          toolUuid: submission.udt.uuid,
          definition,
          createdAt: dispatch.submittedAt,
          notebookAnchor: dispatch.stepAnchor,
          attemptId: dispatch.attemptId,
        });
      }
    }

    await writeNotebook(notebookPath, content);
  });
}

/**
 * Persist a user-defined tool's definition beside the notebook. Returns the
 * analysis-relative path written, or null when the id can't be made into a
 * safe filename.
 */
async function writeUdtDefinition(
  analysisDir: string,
  toolId: string,
  representation: unknown,
): Promise<string | null> {
  const safe = safeProvenanceFilename(toolId);
  if (!safe) return null;

  const relative = path.join(UDT_PROVENANCE_DIR, `${safe}.yaml`);
  const absolute = path.join(analysisDir, relative);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, stringifyYaml(representation), "utf-8");
  // Always POSIX separators in the notebook: the block is read on whatever
  // platform opens the analysis next, not the one that wrote it.
  return relative.split(path.sep).join("/");
}

// ─────────────────────────────────────────────────────────────────────────────
// The hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-read a result the MCP adapter truncated.
 *
 * Over 50 KiB (or 2000 lines) pi-mcp-adapter replaces the text with a preview
 * plus a notice and spills the full copy to a temp file. The preview is not
 * valid JSON, so without this a big mapped-over submission -- precisely the
 * one whose record matters most -- would log `submission.unparsed`.
 */
function rereadTruncated(resolved: ResolvedResult): ResolvedResult {
  if (!resolved.truncatedPath) return resolved;
  try {
    return {
      ...resolved,
      value: undefined,
      text: fs.readFileSync(resolved.truncatedPath, "utf-8"),
    };
  } catch {
    return resolved;
  }
}

/**
 * Handle one finished submission tool. Exported so the Tier-1 scenarios can
 * replay a recorded result through exactly this path.
 */
export async function handleSubmissionResult(
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
): Promise<void> {
  const dispatch = takeDispatch(toolCallId, toolName);

  // A failed submission is not a submission: galaxy-mcp raises rather than
  // returning success=false, and nothing was created.
  if (isError) return;

  const notebookPath = getNotebookPath();
  if (!notebookPath) return;

  let resolved = resolveResultPayload(result);
  let outcome = parseSubmission(toolName, dispatch.args, resolved);
  if (!outcome.ok && resolved.truncatedPath) {
    resolved = rereadTruncated(resolved);
    outcome = parseSubmission(toolName, dispatch.args, resolved);
  }

  if (!outcome.ok) {
    record("submission.unparsed", {
      tool: toolName,
      attempt_id: dispatch.attemptId,
      step_anchor: dispatch.stepAnchor,
      reason: outcome.reason,
    });
    return;
  }

  const submission = outcome.submission;
  try {
    await writeBlocks(notebookPath, submission, dispatch);
  } catch (err) {
    // The run is real and running whether or not we managed to write it down;
    // say so rather than claiming a registration that did not land.
    record("submission.unparsed", {
      tool: toolName,
      attempt_id: dispatch.attemptId,
      step_anchor: dispatch.stepAnchor,
      reason: `could not write the record: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  record("submission.registered", {
    tool: toolName,
    attempt_id: dispatch.attemptId,
    step_anchor: dispatch.stepAnchor,
    kind: submission.kind,
    label: submission.label,
    submitted_by: "harness",
    ...(submission.historyId ? { history_id: submission.historyId } : {}),
    ...(submission.invocationId ? { invocation_id: submission.invocationId } : {}),
    ...(submission.jobs ? { job_ids: submission.jobs.map((j) => j.jobId) } : {}),
    ...(submission.udt ? { tool_id: submission.udt.toolId, tool_uuid: submission.udt.uuid } : {}),
    ...(submission.partial ? { partial: true } : {}),
  });
}

export function registerSubmissionCapture(pi: ExtensionAPI): void {
  pi.on("tool_execution_start", async (event) => {
    if (!isSubmissionTool(event.toolName)) return;
    rememberDispatch(event.toolCallId, event.toolName, event.args);
  });

  pi.on("tool_execution_end", async (event) => {
    if (!isSubmissionTool(event.toolName)) return;
    try {
      await handleSubmissionResult(
        event.toolCallId,
        event.toolName,
        event.result,
        event.isError === true,
      );
    } catch (err) {
      // Never let capture take the turn down: the submission already happened.
      console.error("[submission-capture] failed:", err);
    }
  });
}
