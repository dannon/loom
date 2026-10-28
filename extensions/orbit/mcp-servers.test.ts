import { describe, it, expect, vi } from "vitest";
import { orbitMcpServers, registerOrbitMcpServers } from "./mcp-servers";

describe("orbitMcpServers", () => {
  it("registers BRC Analytics as direct tools and nothing for Galaxy, credentials or not", () => {
    vi.stubEnv("GALAXY_URL", "https://usegalaxy.org");
    vi.stubEnv("GALAXY_API_KEY", "k");
    try {
      expect(orbitMcpServers()).toEqual({
        "brc-analytics": { url: "https://brc-analytics.org/api/v1/mcp/", exposure: "direct" },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("registerOrbitMcpServers", () => {
  it("hands every server to pi", () => {
    const registerMcpServer = vi.fn();
    registerOrbitMcpServers({ registerMcpServer } as never);
    expect(registerMcpServer.mock.calls.map(([name]) => name)).toEqual(["brc-analytics"]);
  });
});
