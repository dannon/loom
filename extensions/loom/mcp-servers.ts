/**
 * The MCP servers Loom brings with it, registered with pi's built-in MCP support.
 *
 * Registrations live only in this session, so the brain registers on every load.
 * Galaxy is not one of them: its tools run in-process (galaxy-tool-source.ts).
 */

import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";

export function loomMcpServers(): Record<string, McpServerConfig> {
  return {
    // Public, anonymous BRC genome/assembly/lineage lookups -- no credentials, so
    // always on.
    "brc-analytics": {
      url: "https://brc-analytics.org/api/v1/mcp/",
      exposure: "direct",
    },
  };
}

export function registerLoomMcpServers(pi: ExtensionAPI): void {
  for (const [name, config] of Object.entries(loomMcpServers())) {
    pi.registerMcpServer(name, config);
  }
}
