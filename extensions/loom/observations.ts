/**
 * Building and shipping an observation (community knowledge loop, contract C1).
 *
 * Everything that decides WHAT is in the payload lives in this half and is
 * pure given its inputs, so the privacy properties are testable without a
 * session: stage comes from an ordered tool-name table, tool ids and datatypes
 * come from a shape allowlist over the triggering call's arguments (never a
 * deep walk of user data), the server is an exact match against the C7
 * allowlist or "private", and the signature goes through the shared
 * normalizer. The description is validated and dropped on any failure rather
 * than trimmed -- a description that trips a leak pattern is not fixable from
 * here.
 */

import {
  PRIVATE_SERVER,
  PUBLIC_GALAXY_SERVERS,
  DATATYPES_MAX,
  DATATYPE_MAX,
  OBSERVATION_SCHEMA_VERSION,
  TOOLS_MAX,
  TOOL_ID_MAX,
  UNKNOWN_SIGNATURE,
  VERSION_MAX,
  capObservation,
  normalizeSignature,
  validateObservation,
} from "../../shared/observation-contract.js";
import type {
  Observation,
  ObservationApp,
  ObservationKind,
  ObservationPlatform,
  ObservationStage,
  ObservationTrigger,
} from "../../shared/observation-contract.js";
import { readLoomVersion } from "./feedback.js";
import { loadProfiles } from "./profiles.js";
import { isWsl } from "../../shared/wsl.js";
import { isDesktopShell } from "../../shared/orbit-env.js";
import { release } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────────

// Ordered; first match wins. The question each row answers is "what was the
// session trying to do when this call failed", not "what does the tool read",
// which is why a failed galaxy_run_tool is tool-parameterization (the
// submission was refused) rather than job-execution.
const STAGE_RULES: ReadonlyArray<readonly [RegExp, ObservationStage]> = Object.freeze([
  Object.freeze([/^galaxy_(?:upload|download|import)/, "data-acquisition"] as const),
  Object.freeze([/metadata|datatype|dbkey|genome_build/, "metadata-reconciliation"] as const),
  Object.freeze([
    /^galaxy_(?:run_tool|run_user_tool|invoke_workflow|create_user_tool|update_user_tool|get_tool|search_tool|recommend_iwc|search_iwc|get_iwc|get_workflow_input_template)/,
    "tool-parameterization",
  ] as const),
  Object.freeze([/^galaxy_(?:invocation|job|get_job|cancel)/, "job-execution"] as const),
  Object.freeze([
    /^galaxy_(?:get_dataset|get_datasets|get_history|get_histories|list_|create_history|get_collection)/,
    "result-interpretation",
  ] as const),
]);

export function stageForTool(mcpTool: string | undefined): ObservationStage {
  if (!mcpTool) return "unknown";
  for (const [re, stage] of STAGE_RULES) if (re.test(mcpTool)) return stage;
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool ids and datatypes
// ─────────────────────────────────────────────────────────────────────────────

// A Galaxy tool id is a public identifier, but it arrives from model-authored
// arguments, so it is admitted by shape rather than trusted. Either a bare id
// (Filter1, __FILTER_FROM_FILE__) or a toolshed path
// (host/repos/owner/repo/tool[/version]). Every segment must START with a word
// character, which is what rejects `../../etc/passwd` and `C:/Users/bob` --
// a flat character-class allowlist would admit both, because a path and a
// toolshed id are made of the same characters. `+` is in the body set because
// toolshed versions carry it (2.2.1+galaxy1).
const TOOL_ID_SHAPE = /^\w[\w.+-]*(?:\/\w[\w.+-]*)*$/;
const DATATYPE_SHAPE = /^[A-Za-z0-9._-]{1,40}$/;
const TOOL_ID_KEYS = ["tool_id", "tool_ids"] as const;
const DATATYPE_KEYS = ["file_type", "ext", "extension", "datatype"] as const;
// Galaxy's "work it out for me" sentinel is not a datatype signal.
const DATATYPE_SENTINELS = new Set(["auto", ""]);

/**
 * Toolshed ids are `<host>/repos/<owner>/<repo>/<tool>/<version>`. Splitting
 * the version off is what lets triage cluster a failure across versions.
 */
export function splitToolId(raw: string): { id: string; version?: string } {
  const t = String(raw ?? "").trim();
  if (!t) return { id: "" };
  const m = t.match(/^(.*\/repos\/[^/]+\/[^/]+\/[^/]+)\/(.+)$/);
  if (m) return { id: m[1], version: m[2] };
  return { id: t };
}

function collectStrings(
  input: Record<string, unknown> | undefined,
  keys: readonly string[],
): string[] {
  if (!input || typeof input !== "object") return [];
  const out: string[] = [];
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) if (typeof v === "string") out.push(v);
  }
  return out;
}

function dedupeCap(values: string[], max: number): string[] {
  return [...new Set(values)].slice(0, max);
}

export function extractToolIds(input: Record<string, unknown> | undefined): string[] {
  const admitted = collectStrings(input, TOOL_ID_KEYS)
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= TOOL_ID_MAX && TOOL_ID_SHAPE.test(v));
  return dedupeCap(admitted, TOOLS_MAX);
}

export function extractDatatypes(input: Record<string, unknown> | undefined): string[] {
  const admitted = collectStrings(input, DATATYPE_KEYS)
    .map((v) => v.trim().toLowerCase())
    .filter(
      (v) => !DATATYPE_SENTINELS.has(v) && v.length <= DATATYPE_MAX && DATATYPE_SHAPE.test(v),
    );
  return dedupeCap(admitted, DATATYPES_MAX);
}

// ─────────────────────────────────────────────────────────────────────────────
// Server and version
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exact hostname match against the C7 allowlist, else "private". Never a
 * suffix match: `usegalaxy.org.evil.example` and `test.usegalaxy.org` are both
 * private, and so is every institutional mirror and every localhost install.
 */
export function resolveObservationServer(url: string | undefined): string {
  const raw = String(url ?? "").trim();
  if (!raw) return PRIVATE_SERVER;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return PRIVATE_SERVER;
  }
  return PUBLIC_GALAXY_SERVERS.includes(host) ? host : PRIVATE_SERVER;
}

/**
 * The server this session is actually pointed at. GALAXY_URL is the live
 * answer -- /connect and switchProfile publish the active profile into it --
 * but a session whose active profile carries an encrypted-only key can have a
 * configured profile and no env URL, and reading that as "private" would
 * mislabel a public server. The profile's URL is not a secret.
 */
export function currentGalaxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GALAXY_URL) return env.GALAXY_URL;
  const { active, profiles } = loadProfiles();
  return active ? profiles[active]?.url : undefined;
}

// Nothing in the brain asks Galaxy for its version, and adding a probe is its
// own change with its own auth question. What we can have for free is the
// version galaxy-mcp already reports on a successful connect -- shape-checked
// hard, so a hostile or absent value just leaves the field off.
let galaxyVersion: string | undefined;

export function recordGalaxyVersionFromConnect(resultText: string | undefined): void {
  if (!resultText) return;
  const m = resultText.match(/"version"\s*:\s*"(\d+\.\d+(?:\.\d+)?[A-Za-z0-9.+-]{0,16})"/);
  if (m) galaxyVersion = m[1].slice(0, VERSION_MAX);
}

export function getGalaxyVersion(): string | undefined {
  return galaxyVersion;
}

export function resetGalaxyVersion(): void {
  galaxyVersion = undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

export interface ObservationFacts {
  kind: ObservationKind;
  trigger: ObservationTrigger;
  /** Overrides the tool-name table when the trigger knows better. */
  stage?: ObservationStage;
  mcpTool?: string;
  toolIds: string[];
  datatypes: string[];
  /** Raw error/outcome text; normalized here, never stored raw. */
  rawSignature: string;
  description?: string;
}

export interface ObservationEnvelope {
  id: string;
  clientTs: string;
  app: ObservationApp;
  version: string;
  platform: ObservationPlatform;
  wsl?: boolean;
  installToken: string;
  server: string;
  galaxyVersion?: string;
}

const PLATFORMS = new Set<ObservationPlatform>(["darwin", "linux", "win32"]);

export function buildObservation(facts: ObservationFacts, env: ObservationEnvelope): Observation {
  const candidate = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: env.id,
    clientTs: env.clientTs,
    client: {
      app: env.app,
      version: env.version,
      platform: env.platform,
      ...(env.wsl === true ? { wsl: true } : {}),
    },
    installToken: env.installToken,
    kind: facts.kind,
    stage: facts.stage ?? stageForTool(facts.mcpTool),
    trigger: facts.trigger,
    tools: facts.toolIds.map(splitToolId),
    ...(facts.mcpTool ? { mcpTool: facts.mcpTool } : {}),
    datatypes: facts.datatypes,
    signature: normalizeSignature(facts.rawSignature) || UNKNOWN_SIGNATURE,
    galaxy: {
      server: env.server,
      ...(env.galaxyVersion ? { version: env.galaxyVersion } : {}),
    },
    description: facts.description ?? "",
  };

  const capped = capObservation(candidate);
  // A description that can't pass is dropped whole. Trimming it would be
  // guessing at which half was the leak, and an empty description still leaves
  // a usable structured observation.
  if (capped.description) {
    const probe = validateObservation({ ...capped, description: "" });
    const full = validateObservation(capped);
    if (!full.ok && probe.ok) return { ...capped, description: "" };
  }
  return capped;
}

/** The impure half: who and where this install is. No secrets, no hostname. */
export function collectObservationEnvelope(installToken: string): ObservationEnvelope {
  const platform = process.platform as ObservationPlatform;
  return {
    id: crypto.randomUUID(),
    clientTs: new Date().toISOString(),
    app: isDesktopShell() ? "orbit" : "loom-cli",
    version: readLoomVersion() ?? "0.0.0",
    platform: PLATFORMS.has(platform) ? platform : "linux",
    ...(isWsl({ platform: process.platform, env: process.env, release: release() })
      ? { wsl: true }
      : {}),
    installToken,
    server: resolveObservationServer(currentGalaxyUrl()),
    ...(getGalaxyVersion() ? { galaxyVersion: getGalaxyVersion() } : {}),
  };
}
