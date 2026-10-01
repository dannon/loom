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
  OBSERVATIONS_ROUTE,
  OBSERVATIONS_ENDPOINT_URL,
  OBSERVATION_KEY_HEADER,
  OBSERVATION_MAX_BYTES,
  OBSERVATION_SCHEMA_VERSION,
  PRIVATE_SERVER,
  PUBLIC_GALAXY_SERVERS,
  RETRACT_TOKEN_HEADER,
  DATATYPES_MAX,
  DATATYPE_MAX,
  TOOLS_MAX,
  TOOL_ID_MAX,
  VERSION_MAX,
  capObservation,
  normalizeSignature,
  observationByteLength,
  scanObservationForLeaks,
  textLeaks,
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
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { release } from "node:os";
import { getConfigDir } from "./config.js";
import { readLoomVersion } from "./feedback.js";
import { loadProfiles } from "./profiles.js";
import { isWsl } from "../../shared/wsl.js";
import { isDesktopShell, readEnv } from "../../shared/orbit-env.js";

// -----------------------------------------------------------------------------
// Stage
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Tool ids and datatypes
// -----------------------------------------------------------------------------

// A Galaxy tool id is a public identifier, but it arrives from model-authored
// arguments, so it is admitted by shape rather than trusted. Either a bare,
// single-segment id (Filter1, __FILTER_FROM_FILE__) or a path on one of the
// PUBLIC toolsheds (host/repos/owner/repo/tool[/version]). Anything else with
// a slash in it -- `home/alice/run.sh`, a private toolshed's hostname, an IP --
// is dropped: a path and a toolshed id are made of the same characters, so
// only the host can tell them apart. `+` is in the body set because toolshed
// versions carry it (2.2.1+galaxy1).
const BARE_TOOL_ID_SHAPE = /^\w[\w.+-]*$/;
const TOOLSHED_TOOL_ID_SHAPE =
  /^(?:toolshed\.g2\.bx\.psu\.edu|testtoolshed\.g2\.bx\.psu\.edu)\/repos\/\w[\w.+-]*\/\w[\w.+-]*\/\w[\w.+-]*(?:\/\w[\w.+-]*)?$/;
// Galaxy datatypes are lowercase words with at most a couple of dotted
// suffixes (fastqsanger.gz, vcf_bgzip). No hyphen and no upper case, which
// keeps out the commonest shape of a file stem posing as a datatype; a stem
// that happens to be datatype-shaped still gets through, since there is no
// registry here to check against.
const DATATYPE_SHAPE = /^[a-z0-9_]+(?:\.[a-z0-9_]+){0,2}$/;
// galaxy-mcp's own tool names. The proxy shape builds this from model-authored
// text, so it is checked rather than passed through.
const MCP_TOOL_SHAPE = /^galaxy_[a-z0-9_]{1,73}$/;

export function isAdmissibleToolId(v: string): boolean {
  return (
    v.length > 0 &&
    v.length <= TOOL_ID_MAX &&
    (BARE_TOOL_ID_SHAPE.test(v) || TOOLSHED_TOOL_ID_SHAPE.test(v))
  );
}

export function isAdmissibleDatatype(v: string): boolean {
  return !DATATYPE_SENTINELS.has(v) && v.length <= DATATYPE_MAX && DATATYPE_SHAPE.test(v);
}

export function isAdmissibleMcpTool(v: string | undefined): v is string {
  return typeof v === "string" && MCP_TOOL_SHAPE.test(v);
}
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
    .filter(isAdmissibleToolId);
  return dedupeCap(admitted, TOOLS_MAX);
}

export function extractDatatypes(input: Record<string, unknown> | undefined): string[] {
  const admitted = collectStrings(input, DATATYPE_KEYS)
    .map((v) => v.trim().toLowerCase())
    .filter(isAdmissibleDatatype);
  return dedupeCap(admitted, DATATYPES_MAX);
}

// -----------------------------------------------------------------------------
// Server and version
// -----------------------------------------------------------------------------

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
// hard (a release number, optionally devN/rcN/postN, nothing free-form that
// could carry a site name), so a hostile or absent value just leaves the field
// off. It is remembered against the server it came from, so switching servers
// mid-session can't label one server's failure with another's version.
const GALAXY_VERSION_SHAPE = /^\d{2}\.\d{1,2}(?:\.\d{1,3})?(?:\.?(?:dev|rc|post)\d{1,3})?$/;
let galaxyVersion: { version: string; url: string | undefined } | undefined;

export function recordGalaxyVersionFromConnect(resultText: string | undefined): void {
  if (!resultText) return;
  const m = resultText.match(/"version"\s*:\s*"([^"]{1,40})"/);
  if (m && GALAXY_VERSION_SHAPE.test(m[1])) {
    galaxyVersion = { version: m[1], url: currentGalaxyUrl() };
  }
}

export function getGalaxyVersion(): string | undefined {
  if (!galaxyVersion || galaxyVersion.url !== currentGalaxyUrl()) return undefined;
  return galaxyVersion.version;
}

export function resetGalaxyVersion(): void {
  galaxyVersion = undefined;
}

// -----------------------------------------------------------------------------
// Build
// -----------------------------------------------------------------------------

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
  const mcpTool = isAdmissibleMcpTool(facts.mcpTool) ? facts.mcpTool : undefined;
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
    stage: facts.stage ?? stageForTool(mcpTool),
    trigger: facts.trigger,
    // Re-admitted here as well as in the extractors: facts can arrive from a
    // caller that never went through them.
    tools: facts.toolIds.filter(isAdmissibleToolId).map(splitToolId),
    ...(mcpTool ? { mcpTool } : {}),
    datatypes: facts.datatypes.filter(isAdmissibleDatatype),
    signature: normalizeSignature(facts.rawSignature),
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
    const leaky = textLeaks(capped.description).length > 0;
    if ((!full.ok || leaky) && probe.ok) return { ...capped, description: "" };
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

// -----------------------------------------------------------------------------
// Transport
// -----------------------------------------------------------------------------

// ORBIT_OBSERVATIONS_URL points this at `wrangler dev` for local work, the same
// way LOOM_FEEDBACK_URL does for /feedback.
function endpointBase(): string {
  return readEnv("OBSERVATIONS_URL") || OBSERVATIONS_ENDPOINT_URL;
}

const TIMEOUT_MS = 10_000;

export const OUTBOX_FILE = "observations-outbox.jsonl";
export const SENT_LOG_FILE = "observations-sent.jsonl";
export const TOKEN_STORE_FILE = "observations-tokens.json";

export function observationsFilePath(name: string): string {
  return join(getConfigDir(), name);
}

export interface SubmitObservationResult {
  ok: boolean;
  status?: number;
  id?: string;
  retractToken?: string;
  error?: string;
  /** Field names only -- the route never echoes a rejected value. */
  errors?: string[];
  /**
   * Whether the outbox should keep this for later. A transport failure, a 429
   * and a 503 (the route exists but isn't configured yet) are all "try again";
   * a 400 or a 401 would fail identically forever, so queuing them would just
   * grow a file nobody can drain.
   */
  queueable: boolean;
}

// The intake route answers 500 when the id already exists (a primary-key
// collision), which a resend of the same observation can never get past. So a
// 500 gets a small bounded retry here, in case it was a blip, and then counts as
// permanent -- queuing it would loop the outbox on a row that is already there
// or never will be.
const ATTEMPTS_ON_500 = 2;

function queueableStatus(status: number): boolean {
  return status === 429 || (status > 500 && status < 600);
}

export async function submitObservation(obs: Observation): Promise<SubmitObservationResult> {
  if (observationByteLength(obs) > OBSERVATION_MAX_BYTES) {
    return { ok: false, error: "observation exceeds the intake size cap", queueable: false };
  }
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = readEnv("FEEDBACK_KEY");
    if (key) headers[OBSERVATION_KEY_HEADER] = key;
    let res: Response | undefined;
    for (let attempt = 1; attempt <= ATTEMPTS_ON_500; attempt++) {
      res = await fetch(endpointBase() + OBSERVATIONS_ROUTE, {
        method: "POST",
        headers,
        body: JSON.stringify(obs),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // A redirect would replay the body and the shared key to wherever it
        // points. The route never redirects, so one is a refusal, not a hop.
        redirect: "manual",
      });
      if (res.status !== 500) break;
      if (attempt < ATTEMPTS_ON_500) await res.body?.cancel().catch(() => {});
    }
    if (!res) throw new Error("no response");
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      id?: string;
      retractToken?: string;
      error?: string;
      errors?: string[];
    };
    return {
      ok: res.ok,
      status: res.status,
      id: data.id,
      retractToken: data.retractToken,
      error: data.error,
      errors: data.errors,
      queueable: res.ok ? false : queueableStatus(res.status),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      queueable: true,
    };
  }
}

export interface RetractResult {
  ok: boolean;
  status?: number;
  /** A 404 means the row is not there, which is the outcome the user wanted. */
  alreadyGone: boolean;
  error?: string;
}

export async function retractObservation(id: string, retractToken: string): Promise<RetractResult> {
  try {
    const headers: Record<string, string> = { [RETRACT_TOKEN_HEADER]: retractToken };
    const key = readEnv("FEEDBACK_KEY");
    if (key) headers[OBSERVATION_KEY_HEADER] = key;
    const res = await fetch(`${endpointBase()}${OBSERVATIONS_ROUTE}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
    await res.json().catch(() => ({}));
    // Idempotent by contract: a repeat retract is a 404, and reporting that as
    // a failure would push the user into retrying something already done.
    if (res.status === 404) return { ok: true, status: 404, alreadyGone: true };
    return { ok: res.ok, status: res.status, alreadyGone: false };
  } catch (err) {
    return {
      ok: false,
      alreadyGone: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// -----------------------------------------------------------------------------
// Local logs
// -----------------------------------------------------------------------------

function appendLine(name: string, value: unknown, mode?: number): string | null {
  try {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    appendFileSync(file, JSON.stringify(value) + "\n", { encoding: "utf-8", mode: mode ?? 0o644 });
    if (mode !== undefined) {
      try {
        chmodSync(file, mode);
      } catch {
        /* perm-tightening is best-effort */
      }
    }
    return file;
  } catch {
    return null;
  }
}

/** Durability backstop: a POST that could succeed later is never lost. */
export function appendToObservationOutbox(obs: Observation): string | null {
  // 0600: this file carries the install token, which is the thing that ties
  // rows together. Nothing else in it is sensitive, but that is enough.
  return appendLine(OUTBOX_FILE, obs, 0o600);
}

export const OUTBOX_DRAIN_MAX = 10;

/**
 * Retry what the outbox holds, oldest first, at most OUTBOX_DRAIN_MAX per call.
 * Each row is re-validated before it goes -- the file is local and could have
 * been edited -- and anything that fails, or that the route now refuses for
 * good, is dropped rather than kept to fail forever. Only queueable failures
 * stay.
 */
export async function drainObservationOutbox(
  submit: (obs: Observation) => Promise<SubmitObservationResult>,
): Promise<{ sent: number; kept: number; dropped: number }> {
  const file = observationsFilePath(OUTBOX_FILE);
  const counts = { sent: 0, kept: 0, dropped: 0 };
  if (!existsSync(file)) return counts;
  const lines = readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length === 0) return counts;

  const keep: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (i >= OUTBOX_DRAIN_MAX) {
      keep.push(line);
      continue;
    }
    let obs: Observation;
    try {
      obs = JSON.parse(line) as Observation;
    } catch {
      counts.dropped += 1;
      continue;
    }
    if (!validateObservation(obs).ok || scanObservationForLeaks(obs).length > 0) {
      counts.dropped += 1;
      continue;
    }
    const res = await submit(obs);
    if (res.ok) {
      if (res.retractToken) saveRetractToken(obs.id, res.retractToken);
      appendSentLog(sentLogEntryFor(obs, "sent"));
      counts.sent += 1;
    } else if (res.queueable) {
      keep.push(line);
    } else {
      counts.dropped += 1;
    }
  }
  counts.kept = keep.length;

  // Rewrite in place via a temp file, so a crash mid-write can't truncate rows
  // that are still owed.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, keep.map((l) => l + "\n").join(""), { mode: 0o600 });
  renameSync(tmp, file);
  return counts;
}

export interface ObservationSentEntry {
  at: string;
  id: string;
  status: "sent" | "queued" | "retracted";
  kind: string;
  stage: string;
  trigger: string;
  signature: string;
  tools: string[];
  mcpTool?: string;
  datatypes: string[];
  server: string;
  description: string;
}

/**
 * The readable "what have I sent" row. Deliberately carries neither the
 * install token nor the retract token, so `/observations sent` can show the
 * log without handing either one over.
 */
export function sentLogEntryFor(
  obs: Observation,
  status: ObservationSentEntry["status"],
): ObservationSentEntry {
  return {
    at: new Date().toISOString(),
    id: obs.id,
    status,
    kind: obs.kind,
    stage: obs.stage,
    trigger: obs.trigger,
    signature: obs.signature,
    tools: obs.tools.map((t) => t.id),
    ...(obs.mcpTool ? { mcpTool: obs.mcpTool } : {}),
    datatypes: obs.datatypes,
    server: obs.galaxy.server,
    description: obs.description,
  };
}

export function appendSentLog(entry: ObservationSentEntry): string | null {
  // 0600 like the outbox. The rows hold no token, but what an install has
  // reported is the user's business, not every local process's.
  return appendLine(SENT_LOG_FILE, entry, 0o600);
}

export function readSentLog(): ObservationSentEntry[] {
  const file = observationsFilePath(SENT_LOG_FILE);
  if (!existsSync(file)) return [];
  const out: ObservationSentEntry[] = [];
  try {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ObservationSentEntry);
      } catch {
        // Skip, same as the activity log's own hydrate.
      }
    }
  } catch {
    return out;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Retract tokens
// -----------------------------------------------------------------------------

function readTokenStore(): Record<string, string> {
  const file = observationsFilePath(TOKEN_STORE_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt store costs the ability to retract older rows, which is better
    // than throwing out of a command the user is standing in front of.
    return {};
  }
}

function writeTokenStore(store: Record<string, string>): void {
  try {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, TOKEN_STORE_FILE);
    writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best-effort */
    }
  } catch {
    /* losing a token costs retraction, not correctness */
  }
}

/**
 * The Worker returns a retract token once, so it has to be kept to make
 * `/observations retract` possible. Kept out of the sent log and listed in the
 * exec-guard's credential stores so the agent can never read it.
 */
export function saveRetractToken(id: string, token: string): void {
  writeTokenStore({ ...readTokenStore(), [id]: token });
}

export function readRetractToken(id: string): string | undefined {
  const token = readTokenStore()[id];
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

export function forgetRetractToken(id: string): void {
  const store = readTokenStore();
  if (!(id in store)) return;
  delete store[id];
  writeTokenStore(store);
}
