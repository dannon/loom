// Loom used to write its MCP servers into mcp.json for pi-mcp-adapter. The brain
// now registers them with pi's built-in MCP, where a file entry of the same name
// wins over a registration -- a leftover galaxy entry would pin an old profile
// (and the plaintext key earlier versions wrote) indefinitely.

const LEGACY_SERVER_NAMES = ["galaxy", "brc-analytics"];

/**
 * Remove Loom's servers and the adapter-only `settings` block from a parsed
 * mcp.json, leaving anything the user added.
 * @param {Record<string, any>} config
 * @returns {{ changed: boolean, empty: boolean }} `empty` when nothing is left worth keeping.
 */
export function stripLegacyMcpEntries(config) {
  let changed = false;
  const servers = config.mcpServers;
  if (servers && typeof servers === "object") {
    for (const name of LEGACY_SERVER_NAMES) {
      if (name in servers) {
        delete servers[name];
        changed = true;
      }
    }
  }
  if ("settings" in config) {
    delete config.settings;
    changed = true;
  }
  const otherKeys = Object.keys(config).filter((k) => k !== "mcpServers");
  const empty = otherKeys.length === 0 && Object.keys(servers ?? {}).length === 0;
  return { changed, empty };
}
