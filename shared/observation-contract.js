// Shared observation wire contract (community knowledge loop, contract C1).
// Dual-file (.js runtime + .d.ts types) to match feedback-contract: the brain
// resolves a real .js at runtime, so a single .ts would risk a missing runtime
// file. No Node imports here -- this file is renderer-safe and is shared by the
// brain, Orbit, and (by verbatim copy) the orbit-feedback Worker.
//
// normalizeSignature, LEAK_PATTERNS and validateObservation are security
// controls, not formatting helpers. They fail closed: a payload that trips a
// leak pattern is dropped, never "cleaned up and sent anyway". The Worker keeps
// a byte-compatible copy of the same regexes, so a change here is a change
// there.

export const OBSERVATION_SCHEMA_VERSION = 1;
export const OBSERVATIONS_ROUTE = "/observations";
// Same shared key as /feedback -- one secret per install, two routes.
export const OBSERVATION_KEY_HEADER = "X-Orbit-Feedback-Key";
export const RETRACT_TOKEN_HEADER = "X-Retract-Token";
export const OBSERVATIONS_ENDPOINT_URL = "https://orbit-feedback.dannon-baker.workers.dev";
// The Worker's body cap. Enforced client-side too so a doomed POST is never sent.
export const OBSERVATION_MAX_BYTES = 16 * 1024;

// Contract C7: the single source of truth for the public-server allowlist.
// Anything else is "private" -- an exact hostname match, never a suffix match,
// so an institutional mirror at galaxy.usegalaxy.org.example cannot pass.
export const PUBLIC_GALAXY_SERVERS = Object.freeze([
  "usegalaxy.org",
  "usegalaxy.eu",
  "usegalaxy.org.au",
  "usegalaxy.fr",
  "usegalaxy.no",
  "usegalaxy.cz",
  "test.galaxyproject.org",
]);
export const PRIVATE_SERVER = "private";

export const OBSERVATION_KINDS = Object.freeze([
  "tool-error",
  "retry-loop",
  "assertion-failed",
  "user-correction",
  "silent-wrong-result",
  "other",
]);
export const OBSERVATION_STAGES = Object.freeze([
  "data-acquisition",
  "metadata-reconciliation",
  "tool-parameterization",
  "job-execution",
  "result-interpretation",
  "unknown",
]);
export const OBSERVATION_TRIGGERS = Object.freeze([
  "tool_error",
  "retry_loop",
  "assertion",
  "user_correction",
  "explicit",
]);
export const OBSERVATION_APPS = Object.freeze(["orbit", "loom-cli"]);
export const OBSERVATION_PLATFORMS = Object.freeze(["darwin", "linux", "win32"]);

export const SIGNATURE_MAX = 200;
export const DESCRIPTION_MAX = 500;
export const TOOLS_MAX = 5;
export const TOOL_ID_MAX = 200;
export const TOOL_VERSION_MAX = 40;
export const MCP_TOOL_MAX = 80;
export const DATATYPES_MAX = 5;
export const DATATYPE_MAX = 40;
export const VERSION_MAX = 40;

// Ordered. Broadest, most leak-prone forms first, so a narrower rule can never
// carve a URL or an email in half and leave the remnant looking harmless.
// Deviation from C1's listed order (which put paths before URLs) -- see the
// contracts.md amendment that accompanies this module.
const NORMALIZERS = Object.freeze([
  [/https?:\/\/\S+/g, "<url>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  // Two separators required, so ordinary prose ("and/or") is not read as a
  // path. A single-segment absolute path like /etc is not identifying.
  [/(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s"'`<>|]*[\\/][^\s"'`<>|]*/g, "<path>"],
  [/[0-9a-fA-F]{16,}/g, "<id>"],
  [/\d{5,}/g, "<n>"],
  // The crude hid/dataset/history-followed-by-a-number shape the validator
  // rejects. Neutralising it here means an ordinary Galaxy message about a
  // two-digit hid still produces a usable signature instead of being dropped.
  [/\b(history|dataset|hid)\b([^A-Za-z0-9]{0,4})\d+/gi, "$1$2<n>"],
  // Last: the validator requires printable ASCII, and a non-English Galaxy
  // message should still cluster on its ASCII skeleton rather than be dropped.
  [/[^\x20-\x7E]+/g, "<x>"],
]);

export function normalizeSignature(text) {
  let s = String(text ?? "")
    .split(/\r?\n/)[0]
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, repl] of NORMALIZERS) s = s.replace(re, repl);
  // Plain slice: appending an ellipsis would make the result non-ASCII and the
  // validator would then reject every truncated signature.
  return s.slice(0, SIGNATURE_MAX);
}

// The leak table. No `g` flags: `test()` on a global regex is stateful and
// would skip every other call. Names are the error suffix the validator
// reports, so a 400 from the Worker still never echoes a value.
export const LEAK_PATTERNS = Object.freeze([
  Object.freeze(["url", /https?:\/\//i]),
  Object.freeze(["home-path", /\/Users\/|\/home\//i]),
  Object.freeze(["windows-path", /[A-Za-z]:[\\/]/]),
  Object.freeze(["tilde-path", /~[\\/]/]),
  Object.freeze(["long-hex", /[0-9a-fA-F]{16,}/]),
  Object.freeze(["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/]),
  // Crude but cheap, per C1: a Galaxy id phrase followed by a number.
  Object.freeze(["galaxy-id-phrase", /\b(?:history|dataset|hid)\b[^A-Za-z0-9]{0,4}\d/i]),
  Object.freeze(["non-ascii", /[^\x20-\x7E]/]),
]);

const TOP_KEYS = new Set([
  "schemaVersion",
  "id",
  "clientTs",
  "client",
  "installToken",
  "kind",
  "stage",
  "trigger",
  "tools",
  "mcpTool",
  "datatypes",
  "signature",
  "galaxy",
  "description",
]);
const CLIENT_KEYS = new Set(["app", "version", "platform", "wsl"]);
const GALAXY_KEYS = new Set(["version", "server"]);
const TOOL_KEYS = new Set(["id", "version"]);

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const INSTALL_TOKEN_RE = /^[0-9a-f]{32}$/;

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pushUnknownKeys(obj, allowed, prefix, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`${prefix ? prefix + "." : ""}${k}:unknown-key`);
  }
}

function badString(v, max, { allowEmpty = false } = {}) {
  if (typeof v !== "string") return true;
  if (!allowEmpty && v.length === 0) return true;
  return v.length > max;
}

export function validateObservation(obj) {
  if (!isPlainObject(obj)) return { ok: false, errors: ["observation:not-an-object"] };
  const o = obj;
  const errors = [];

  pushUnknownKeys(o, TOP_KEYS, "", errors);
  if (o.schemaVersion !== OBSERVATION_SCHEMA_VERSION) errors.push("schemaVersion:unsupported");
  if (typeof o.id !== "string" || !UUID_V4_RE.test(o.id)) errors.push("id:not-a-uuid-v4");
  if (typeof o.clientTs !== "string" || !ISO_TS_RE.test(o.clientTs)) {
    errors.push("clientTs:not-iso-8601");
  }

  if (!isPlainObject(o.client)) {
    errors.push("client:not-an-object");
  } else {
    const c = o.client;
    pushUnknownKeys(c, CLIENT_KEYS, "client", errors);
    if (!OBSERVATION_APPS.includes(c.app)) errors.push("client.app:not-allowed");
    if (badString(c.version, VERSION_MAX)) errors.push("client.version:bad-length");
    if (!OBSERVATION_PLATFORMS.includes(c.platform)) errors.push("client.platform:not-allowed");
    if (c.wsl !== undefined && typeof c.wsl !== "boolean") errors.push("client.wsl:not-a-boolean");
  }

  if (typeof o.installToken !== "string" || !INSTALL_TOKEN_RE.test(o.installToken)) {
    errors.push("installToken:not-32-hex");
  }
  if (!OBSERVATION_KINDS.includes(o.kind)) errors.push("kind:not-allowed");
  if (!OBSERVATION_STAGES.includes(o.stage)) errors.push("stage:not-allowed");
  if (!OBSERVATION_TRIGGERS.includes(o.trigger)) errors.push("trigger:not-allowed");

  if (!Array.isArray(o.tools)) {
    errors.push("tools:not-an-array");
  } else if (o.tools.length > TOOLS_MAX) {
    errors.push("tools:too-many");
  } else {
    o.tools.forEach((t, i) => {
      if (!isPlainObject(t)) {
        errors.push(`tools[${i}]:not-an-object`);
        return;
      }
      pushUnknownKeys(t, TOOL_KEYS, `tools[${i}]`, errors);
      if (badString(t.id, TOOL_ID_MAX)) errors.push(`tools[${i}].id:bad-length`);
      if (t.version !== undefined && badString(t.version, TOOL_VERSION_MAX)) {
        errors.push(`tools[${i}].version:bad-length`);
      }
    });
  }

  if (o.mcpTool !== undefined && badString(o.mcpTool, MCP_TOOL_MAX)) {
    errors.push("mcpTool:bad-length");
  }

  if (!Array.isArray(o.datatypes)) {
    errors.push("datatypes:not-an-array");
  } else if (o.datatypes.length > DATATYPES_MAX) {
    errors.push("datatypes:too-many");
  } else {
    o.datatypes.forEach((d, i) => {
      if (badString(d, DATATYPE_MAX)) errors.push(`datatypes[${i}]:bad-length`);
    });
  }

  if (badString(o.signature, SIGNATURE_MAX)) errors.push("signature:bad-length");
  if (badString(o.description, DESCRIPTION_MAX, { allowEmpty: true })) {
    errors.push("description:bad-length");
  }

  if (!isPlainObject(o.galaxy)) {
    errors.push("galaxy:not-an-object");
  } else {
    const g = o.galaxy;
    pushUnknownKeys(g, GALAXY_KEYS, "galaxy", errors);
    const serverOk =
      typeof g.server === "string" &&
      (PUBLIC_GALAXY_SERVERS.includes(g.server) || g.server === PRIVATE_SERVER);
    if (!serverOk) errors.push("galaxy.server:not-allowed");
    if (g.version !== undefined && badString(g.version, VERSION_MAX)) {
      errors.push("galaxy.version:bad-length");
    }
  }

  // The two free-text fields carry the leak risk, so they get the full table.
  for (const field of ["signature", "description"]) {
    const value = o[field];
    if (typeof value !== "string") continue;
    for (const [name, re] of LEAK_PATTERNS) {
      if (re.test(value)) errors.push(`${field}:${name}`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Belt-and-braces: run the leak table over EVERY string in the payload, at any
 * depth, not just the two free-text fields. Structured fields are shape-checked
 * upstream, so this should always come back empty -- when it does not, the
 * caller drops the observation. installToken is skipped because it is 32 hex by
 * construction and would trip the long-hex rule.
 */
export function scanObservationForLeaks(obs) {
  const hits = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      if (path === "installToken") return;
      for (const [name, re] of LEAK_PATTERNS) {
        if (re.test(value)) hits.push(`${path}:${name}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(obs, "");
  return hits;
}

function sliceOr(v, max, fallback) {
  return typeof v === "string" ? v.slice(0, max) : fallback;
}

/**
 * Coerce a built observation into the contract's shape and caps. Pair with
 * validateObservation: cap first ("make it fit"), then validate ("is it
 * legal"). Truncation is a plain slice -- an ellipsis character would make the
 * field non-ASCII and the validator would reject it.
 */
export function capObservation(obs) {
  const o = isPlainObject(obs) ? obs : {};
  const client = isPlainObject(o.client) ? o.client : {};
  const galaxy = isPlainObject(o.galaxy) ? o.galaxy : {};
  const tools = (Array.isArray(o.tools) ? o.tools : [])
    .slice(0, TOOLS_MAX)
    .map((t) => {
      const src = isPlainObject(t) ? t : {};
      const version = sliceOr(src.version, TOOL_VERSION_MAX, "");
      return {
        id: sliceOr(src.id, TOOL_ID_MAX, ""),
        ...(version ? { version } : {}),
      };
    })
    .filter((t) => t.id.length > 0);
  const datatypes = (Array.isArray(o.datatypes) ? o.datatypes : [])
    .slice(0, DATATYPES_MAX)
    .map((d) => sliceOr(d, DATATYPE_MAX, ""))
    .filter((d) => d.length > 0);
  const mcpTool = sliceOr(o.mcpTool, MCP_TOOL_MAX, "");
  const galaxyVersion = sliceOr(galaxy.version, VERSION_MAX, "");

  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: o.id,
    clientTs: o.clientTs,
    client: {
      app: client.app,
      version: sliceOr(client.version, VERSION_MAX, ""),
      platform: client.platform,
      ...(client.wsl === true ? { wsl: true } : {}),
    },
    installToken: o.installToken,
    kind: o.kind,
    stage: o.stage,
    trigger: o.trigger,
    tools,
    ...(mcpTool ? { mcpTool } : {}),
    datatypes,
    signature: sliceOr(o.signature, SIGNATURE_MAX, ""),
    galaxy: {
      server: galaxy.server,
      ...(galaxyVersion ? { version: galaxyVersion } : {}),
    },
    description: sliceOr(o.description, DESCRIPTION_MAX, ""),
  };
}

const textEncoder = new TextEncoder();

export function observationByteLength(obs) {
  try {
    return textEncoder.encode(JSON.stringify(obs)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
