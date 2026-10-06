// Loom used to write its MCP servers into mcp.json for pi-mcp-adapter. The brain
// now registers them with pi's built-in MCP, where a file entry of the same name
// wins over a registration -- a leftover galaxy entry would pin an old profile
// (and the plaintext key earlier versions wrote) indefinitely.
//
// The same file can hold the user's own servers, written for the adapter. pi
// ignores the adapter's fields rather than rejecting them, so a tool the user
// excluded would quietly become callable. Translate what pi can express and
// disable what it can't.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const LEGACY_SERVER_NAMES = ["galaxy", "brc-analytics"];

/** Sits beside mcp.json and holds the bytes the migration last rewrote or removed. */
export const BACKUP_SUFFIX = ".loom-backup";

// Present only on an entry written for pi's built-in MCP, which Loom never did:
// a galaxy or brc-analytics entry carrying one is the user's own override.
const PI_NATIVE_FIELDS = ["exposure", "toolExposure", "enabled", "timeout", "auth"];

// Adapter features with no pi equivalent. Keeping such a server on would drop a
// safeguard (approval prompts) or connect without the configured credentials.
const UNSUPPORTED_FIELDS = [
  "approveTools",
  "bearerTokenStore",
  "requestHeadersCommand",
  "caFile",
  "socket",
];

const ADAPTER_ONLY_FIELDS = [
  ...UNSUPPORTED_FIELDS,
  "directTools",
  "includeTools",
  "excludeTools",
  "bearerToken",
  "bearerTokenEnv",
  "lifecycle",
  "idleTimeout",
  "requestTimeoutMs",
  "exposeResources",
  "toolPrefix",
  "searchKeywords",
  "debug",
  "trace",
  "httpTransport",
  "inheritEnv",
  "literalEnv",
  "pluginDataDir",
];

/** @param {unknown} v */
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} v @returns {string[]} */
const stringList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);

/** @param {Record<string, any>} entry */
function isLoomWritten(entry) {
  return isObject(entry) && !PI_NATIVE_FIELDS.some((f) => f in entry);
}

/**
 * Rewrite one user server's adapter fields into pi's. Returns a notice when the
 * server had to be disabled.
 * @param {string} name
 * @param {Record<string, any>} entry
 * @returns {string | null}
 */
function translateAdapterEntry(name, entry) {
  const unsupported = UNSUPPORTED_FIELDS.filter((f) => {
    const v = entry[f];
    return v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0);
  });

  /** @type {Record<string, string>} */
  const toolExposure = {};
  let exposure;
  const direct = entry.directTools;
  if (direct === true) exposure = "direct";
  else if (direct === "search") exposure = "deferred";
  for (const tool of stringList(direct)) toolExposure[tool] = "direct";

  const include = stringList(entry.includeTools);
  if (include.length > 0) {
    for (const tool of include) toolExposure[tool] ??= exposure ?? "codemode";
    exposure = "hidden";
  }
  for (const tool of stringList(entry.excludeTools)) toolExposure[tool] = "hidden";

  if (exposure) entry.exposure = exposure;
  if (Object.keys(toolExposure).length > 0) entry.toolExposure = toolExposure;
  if (typeof entry.requestTimeoutMs === "number" && entry.requestTimeoutMs > 0) {
    entry.timeout = Math.ceil(entry.requestTimeoutMs / 1000);
  }

  const headers = isObject(entry.headers) ? entry.headers : {};
  const hasAuthHeader = Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
  const token =
    typeof entry.bearerTokenEnv === "string"
      ? `\${${entry.bearerTokenEnv}}`
      : typeof entry.bearerToken === "string"
        ? entry.bearerToken
        : null;
  if (token && !hasAuthHeader) entry.headers = { ...headers, Authorization: `Bearer ${token}` };

  for (const f of ADAPTER_ONLY_FIELDS) delete entry[f];
  // The adapter's auth was a mode string; pi's is an object naming a provider.
  if (typeof entry.auth === "string" || entry.auth === false) delete entry.auth;

  if (unsupported.length === 0) return null;
  entry.enabled = false;
  return (
    `MCP server "${name}" used ${unsupported.join(", ")}, which pi's built-in MCP ` +
    `does not support, so Loom disabled it in mcp.json. Review it and re-enable with /mcp.`
  );
}

/**
 * Remove Loom's own servers and the adapter's settings from a parsed mcp.json,
 * and translate the user's remaining servers to pi's built-in MCP fields.
 * @param {Record<string, any>} config
 * @returns {{ changed: boolean, empty: boolean, removedGalaxy: boolean, notices: string[], shadowing: string[] }}
 *   `empty` when nothing is left worth keeping. `shadowing` names the galaxy /
 *   brc-analytics entries that stay because they carry pi's own fields: a file
 *   entry beats the brain's registration, so each one pins whatever it says.
 */
export function stripLegacyMcpEntries(config) {
  let changed = false;
  let removedGalaxy = false;
  /** @type {string[]} */
  const notices = [];
  /** @type {string[]} */
  const shadowing = [];
  const servers = isObject(config.mcpServers) ? config.mcpServers : null;
  if (servers) {
    for (const [name, entry] of Object.entries(servers)) {
      if (LEGACY_SERVER_NAMES.includes(name)) {
        if (!isLoomWritten(entry)) {
          if (isObject(entry) && entry.enabled !== false) shadowing.push(name);
          continue;
        }
        delete servers[name];
        changed = true;
        if (name === "galaxy") removedGalaxy = true;
        continue;
      }
      if (!isObject(entry) || !ADAPTER_ONLY_FIELDS.some((f) => f in entry)) continue;
      const notice = translateAdapterEntry(name, entry);
      if (notice) notices.push(notice);
      changed = true;
    }
  }
  if (isObject(config.settings) && "scriptMode" in config.settings) {
    delete config.settings.scriptMode;
    if (Object.keys(config.settings).length === 0) delete config.settings;
    changed = true;
  }
  const otherKeys = Object.keys(config).filter((k) => k !== "mcpServers");
  const empty = otherKeys.length === 0 && Object.keys(servers ?? {}).length === 0;
  return { changed, empty, removedGalaxy, notices, shadowing };
}

/** @param {string} name @param {string} mcpConfigPath */
function shadowingNotice(name, mcpConfigPath) {
  const what =
    name === "galaxy"
      ? "the Galaxy server and key saved there, not the profile from /connect"
      : "that BRC Analytics server, not the one Loom ships";
  return (
    `${mcpConfigPath} still has a "${name}" entry written for pi's built-in MCP. ` +
    `A file entry wins over the brain's registration, so Loom will use ${what}. ` +
    `Remove the entry if that is not what you want.`
  );
}

/**
 * Replace `dest` with `tmpPath`. Windows can refuse the rename for a moment
 * while an indexer or antivirus has the file open, so try a few times before
 * giving up.
 * @param {string} tmpPath @param {string} dest
 */
function renameWithRetry(tmpPath, dest) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmpPath, dest);
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      Atomics.wait(pause, 0, 0, 100 * attempt);
    }
  }
}

/**
 * Migrate the mcp.json at `mcpConfigPath` in place. Before the file changes,
 * its current bytes go to `<path>.loom-backup` (mode 0600; it may carry a key).
 * Nothing here throws: a file that cannot be updated is left as it was and
 * described in the returned notices, because refusing to start would leave the
 * user with no way to fix it from inside Loom, and there is no restriction to
 * lose when the file cannot be written at all.
 * @param {string} mcpConfigPath
 * @returns {{ notices: string[] }} messages for the launcher to print
 */
export function migrateLegacyMcpConfig(mcpConfigPath) {
  /** @type {string[]} */
  const notices = [];
  if (!existsSync(mcpConfigPath)) return { notices };

  let raw;
  let mcpConfig;
  try {
    raw = readFileSync(mcpConfigPath, "utf-8");
    mcpConfig = JSON.parse(raw);
  } catch {
    // An unparseable mcp.json is pi's to report, and pi loads none of it -- so
    // no stale galaxy entry in it can shadow the brain's registration either.
    return { notices };
  }
  if (!mcpConfig || typeof mcpConfig !== "object") return { notices };

  const {
    changed,
    empty,
    removedGalaxy,
    notices: translated,
    shadowing,
  } = stripLegacyMcpEntries(mcpConfig);
  for (const name of shadowing) notices.push(shadowingNotice(name, mcpConfigPath));
  if (!changed) return { notices };

  const backupPath = `${mcpConfigPath}${BACKUP_SUFFIX}`;
  const tmpPath = `${mcpConfigPath}.${process.pid}.tmp`;
  try {
    writeFileSync(backupPath, raw, { mode: 0o600 });
    if (empty) {
      rmSync(mcpConfigPath);
    } else {
      writeFileSync(tmpPath, JSON.stringify(mcpConfig, null, 2) + "\n", { mode: 0o600 });
      renameWithRetry(tmpPath, mcpConfigPath);
    }
    notices.push(...translated);
    notices.push(`The previous ${mcpConfigPath} is saved as ${backupPath}.`);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    // Left as it is, the file is read the old way: an old galaxy entry wins
    // over the brain's registration (pinning every session to that account and
    // key), and the user's own servers lose the tool restrictions pi ignores.
    const why = removedGalaxy
      ? `Loom will keep using the Galaxy account saved there`
      : `the servers Loom meant to migrate keep settings pi ignores, such as tool restrictions`;
    notices.push(
      `Could not update ${mcpConfigPath} (${err instanceof Error ? err.message : err}), ` +
        `so ${why}. Fix the file's permissions, or remove those entries, and restart Loom.`,
    );
  }
  return { notices };
}
