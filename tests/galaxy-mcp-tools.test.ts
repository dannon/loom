import { describe, it, expect } from "vitest";
import { galaxyMcpToolName, isGalaxyMcpTool } from "../shared/galaxy-mcp-tools.js";

describe("galaxyMcpToolName", () => {
  it("returns the galaxy-mcp tool behind pi's name", () => {
    expect(galaxyMcpToolName("mcp__galaxy__run_tool")).toBe("run_tool");
  });

  it("rejects Loom's own tools and other servers", () => {
    expect(galaxyMcpToolName("galaxy_job_record")).toBeUndefined();
    expect(galaxyMcpToolName("mcp__brc_analytics__get_genome")).toBeUndefined();
    expect(galaxyMcpToolName(undefined)).toBeUndefined();
  });

  it("rejects a server named galaxy_ or galaxy-, whose tools come out as mcp__galaxy___<tool>", () => {
    expect(galaxyMcpToolName("mcp__galaxy___run_tool")).toBeUndefined();
    expect(isGalaxyMcpTool("mcp__galaxy___run_tool")).toBe(false);
    expect(galaxyMcpToolName("mcp__galaxy__")).toBeUndefined();
  });
});
