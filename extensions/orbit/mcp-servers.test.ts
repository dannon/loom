import { describe, it, expect, vi } from "vitest";
import { loomMcpServers, registerLoomMcpServers } from "./mcp-servers";

describe("loomMcpServers", () => {
  it("registers BRC Analytics as direct tools and nothing for Galaxy, credentials or not", () => {
    vi.stubEnv("GALAXY_URL", "https://usegalaxy.org");
    vi.stubEnv("GALAXY_API_KEY", "k");
    try {
      expect(loomMcpServers()).toEqual({
        "brc-analytics": { url: "https://brc-analytics.org/api/v1/mcp/", exposure: "direct" },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("registerLoomMcpServers", () => {
  it("hands every server to pi", () => {
    const registerMcpServer = vi.fn();
    registerLoomMcpServers({ registerMcpServer } as never);
    expect(registerMcpServer.mock.calls.map(([name]) => name)).toEqual(["brc-analytics"]);
  });
});
