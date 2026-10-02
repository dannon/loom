import { describe, it, expect } from "vitest";
import { stripLegacyMcpEntries } from "../bin/legacy-mcp-config.js";

describe("stripLegacyMcpEntries", () => {
  it("drops Loom's servers and the adapter settings, keeping the user's own", () => {
    const config = {
      mcpServers: {
        galaxy: { command: "uvx", env: { GALAXY_API_KEY: "plaintext" } },
        "brc-analytics": { url: "https://dev.brc-analytics.org/api/v1/mcp/" },
        mine: { command: "my-server" },
      },
      settings: { scriptMode: false },
    };
    expect(stripLegacyMcpEntries(config)).toEqual({ changed: true, empty: false });
    expect(config).toEqual({ mcpServers: { mine: { command: "my-server" } } });
  });

  it("reports empty when only Loom's entries were there", () => {
    const config = { mcpServers: { galaxy: { command: "uvx" } }, settings: { scriptMode: false } };
    expect(stripLegacyMcpEntries(config)).toEqual({ changed: true, empty: true });
  });

  it("leaves a file with nothing of ours alone", () => {
    const config = { mcpServers: { mine: { command: "x" } }, autoEnableCodemode: false };
    expect(stripLegacyMcpEntries(config)).toEqual({ changed: false, empty: false });
    expect(config).toEqual({ mcpServers: { mine: { command: "x" } }, autoEnableCodemode: false });
  });

  it("tolerates a file without mcpServers", () => {
    expect(stripLegacyMcpEntries({})).toEqual({ changed: false, empty: true });
  });
});
