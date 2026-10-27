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
  getCollectionDetails,
  getDatasetDetails,
  getDatatypesMapping,
  getToolDetails,
  getWorkflowDetails,
  listUserTools,
  resolveWorkflowSlots,
  subtypeSatisfies,
  type DatatypesMapping,
  type GalaxyContext,
} from "@galaxyproject/galaxy-ops";
import { readEnv } from "../../shared/orbit-env.js";
import { appendActivityEvent } from "./activity";
import { galaxyOpsContext } from "./galaxy-api";
import {
  UNPINNED,
  inputKey,
  targetId,
  type InputFormats,
  type Proposal,
  type ProposalTarget,
} from "./registry-proposal";
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
      // Galaxy can answer for a tool id it doesn't have with a different tool
      // or lineage. Freezing that schema against a Spec naming this id would
      // approve one thing and describe another.
      if (body.id !== id) {
        throw new TemplateUnavailableError(
          `Galaxy answered with tool ${String(body.id)} when asked for ${id}; propose the tool id Galaxy has`,
        );
      }
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
// Dataset formats, for the format check
// ─────────────────────────────────────────────────────────────────────────────

/** Reads what Galaxy says about a proposal's inputs; null where the check can't run. */
export type InputFormatFetcher = (
  inputs: Proposal["inputs"],
  signal?: AbortSignal,
) => Promise<InputFormats>;

interface Converter {
  source: string;
  target: string;
}

/**
 * Whether Galaxy would take `ext` where `accepted` are asked for: the same
 * datatype or a subclass of one (`fastqsanger` for `fastq`), or something an
 * installed converter turns into one (`fastqsanger.gz` for `fastqsanger`,
 * which Galaxy converts implicitly). Galaxy's own hierarchy, not a table of
 * ours, so a server's custom datatypes are read the way it reads them.
 */
export function datatypeAccepts(
  mapping: DatatypesMapping,
  converters: Converter[] | null,
): (ext: string, accepted: string[]) => boolean | undefined {
  const known = (e: string) => mapping.ext_to_class_name[e] !== undefined;
  const isA = (sub: string, sup: string) =>
    known(sub) && known(sup) && subtypeSatisfies(sub, [sup], mapping);
  return (ext, accepted) => {
    if (!known(ext)) return undefined;
    if (accepted.some((a) => isA(ext, a))) return true;
    if (converters?.some((c) => isA(ext, c.source) && accepted.some((a) => isA(c.target, a)))) {
      return true;
    }
    // A converter list we couldn't read, or an accepted format the server
    // doesn't describe, might have been the way in.
    if (!converters || !accepted.every(known)) return undefined;
    return false;
  };
}

/** The hierarchy and converters change only with the server's config; read them once. */
const datatypeCache = new Map<
  string,
  Promise<{ accepts: InputFormats["accepts"]; complete: boolean }>
>();

async function readDatatypes(
  ctx: GalaxyContext,
): Promise<{ accepts: InputFormats["accepts"]; complete: boolean }> {
  const mapping = await getDatatypesMapping(ctx);
  // galaxy-ops answers a failed read with an empty mapping.
  if (Object.keys(mapping.ext_to_class_name ?? {}).length === 0) {
    return { accepts: null, complete: false };
  }
  let converters: Converter[] | null = null;
  try {
    const { data } = await ctx.client.GET("/api/datatypes/converters");
    if (Array.isArray(data)) converters = data;
  } catch {
    // Unknown converters only make more pairings unknown.
  }
  return { accepts: datatypeAccepts(mapping, converters), complete: converters !== null };
}

export async function fetchInputFormatsWith(
  ctx: GalaxyContext,
  serverKey: string,
  inputs: Proposal["inputs"],
): Promise<InputFormats> {
  let pending = datatypeCache.get(serverKey);
  if (!pending) {
    pending = readDatatypes(ctx).catch(() => ({ accepts: null, complete: false }));
    datatypeCache.set(serverKey, pending);
  }
  const { accepts, complete } = await pending;
  // A partial read serves this proposal but isn't kept, so a blip doesn't
  // leave every later check unable to refuse anything.
  if (!complete) datatypeCache.delete(serverKey);

  const extensions = new Map<string, string[] | null>();
  await Promise.all(
    inputs.map(async (input) => {
      const key = inputKey(input);
      if (extensions.has(key)) return;
      extensions.set(key, null);
      try {
        if (input.src === "hda") {
          const { dataset } = await getDatasetDetails(
            { datasetId: input.id, includePreview: false },
            ctx,
          );
          const ext = dataset.extension ?? dataset.file_ext;
          if (typeof ext === "string" && ext !== "") extensions.set(key, [ext]);
        } else if (input.src === "hdca") {
          const c = await getCollectionDetails({ collectionId: input.id, maxElements: 1 }, ctx);
          const exts = c.elements_datatypes?.filter((e) => typeof e === "string" && e !== "");
          if (exts && exts.length > 0) extensions.set(key, exts);
        }
        // A library dataset (ldda) isn't read here; it goes unchecked.
      } catch {
        // Left null: the check lists it as unchecked rather than guessing.
      }
    }),
  );
  return { extensions, accepts };
}

/** For the configured Galaxy server; null when there isn't one to ask. */
export function inputFormatFetcherFor(_sessionDir: string): InputFormatFetcher | null {
  // Replayed templates stand in for a Galaxy that isn't there.
  if (readEnv("TEMPLATE_REPLAY")?.trim()) return null;
  return async (inputs, signal) => {
    const ctx = galaxyOpsContext(signal);
    if (!ctx) return { extensions: new Map(), accepts: null };
    return fetchInputFormatsWith(ctx, ctx.baseUrl ?? "", inputs);
  };
}

/** Test seam: forget what was read about each server's datatypes. */
export function resetDatatypeCache(): void {
  datatypeCache.clear();
}

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
const replaySnapshots = new Map<string, Record<string, unknown> | Error>();

/**
 * Read the replay file once and keep what it said. Primed at session start,
 * before the model has had a turn, so editing the file mid-session -- the
 * model can write inside the session directory -- changes nothing.
 */
export function primeTemplateReplay(sessionDir: string): void {
  const configured = readEnv("TEMPLATE_REPLAY")?.trim();
  if (!configured) return;
  const file = resolveReplayPath(sessionDir, configured);
  const key = file ?? `${sessionDir}::${configured}`;
  if (replaySnapshots.has(key)) return;
  try {
    if (!file) throw new Error("outside the session directory");
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!isRecord(parsed)) throw new Error("not a JSON object");
    replaySnapshots.set(key, parsed);
  } catch (err) {
    replaySnapshots.set(key, err instanceof Error ? err : new Error(String(err)));
  }
}

export function replayTemplateFetcher(sessionDir: string): TemplateFetcher | null {
  const configured = readEnv("TEMPLATE_REPLAY")?.trim();
  if (!configured) return null;
  const file = resolveReplayPath(sessionDir, configured);
  primeTemplateReplay(sessionDir);
  const snapshot = replaySnapshots.get(file ?? `${sessionDir}::${configured}`);
  return async (target) => {
    const key = `${target.kind}:${targetId(target)}`;
    if (!snapshot || snapshot instanceof Error) {
      throw new TemplateUnavailableError(
        `template replay unreadable: ${snapshot instanceof Error ? snapshot.message : "not loaded"}`,
      );
    }
    const entry = snapshot[key];
    if (!isRecord(entry) || typeof entry.version !== "string" || !("body" in entry)) {
      throw new TemplateUnavailableError(`template replay has no entry for ${key}`);
    }
    appendActivityEvent(sessionDir, {
      timestamp: new Date().toISOString(),
      kind: "template.replay",
      source: "template-replay",
      payload: { file: path.relative(sessionDir, file as string), key, version: entry.version },
    });
    return { body: structuredClone(entry.body), version: entry.version };
  };
}

/** Replay when the eval seam is on, Galaxy otherwise. */
export function templateFetcherFor(sessionDir: string): TemplateFetcher {
  return replayTemplateFetcher(sessionDir) ?? galaxyTemplateFetcher;
}
