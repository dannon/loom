import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  galaxyToolFamily,
  installedGalaxyToolSource,
  registerGalaxyTools,
  registeredGalaxyTools,
  setGalaxyToolSource,
  type GalaxyTool,
} from "../extensions/loom/galaxy-tool-source";
import { GALAXY_TOOL_NAMES } from "./galaxy-family-fixture";

const stub = (name: string): GalaxyTool => ({
  name,
  label: name,
  description: `stub ${name}`,
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
});

function fakePi() {
  const registerTool = vi.fn();
  return { pi: { registerTool } as unknown as ExtensionAPI, registerTool };
}

afterEach(() => {
  setGalaxyToolSource(null);
});

describe("galaxy tool source", () => {
  it("with no source registered yet the family claims nothing", () => {
    expect(galaxyToolFamily().toolName("run_tool")).toBeUndefined();
  });

  it("the family is the registered source's names", () => {
    setGalaxyToolSource({ tools: () => [stub("run_tool")] });
    expect(installedGalaxyToolSource()).not.toBeNull();
    const family = registerGalaxyTools(fakePi().pi);
    expect(galaxyToolFamily()).toBe(family);
    expect(galaxyToolFamily().tool("run_tool")).toBe("run_tool");
  });

  it("registers the source's tools in order and names them as the family", () => {
    setGalaxyToolSource({ tools: () => [stub("run_tool"), stub("get_dataset_details")] });
    const { pi, registerTool } = fakePi();
    const family = registerGalaxyTools(pi);
    expect(registerTool.mock.calls.map(([t]) => t.name)).toEqual([
      "run_tool",
      "get_dataset_details",
    ]);
    expect(family.toolName("run_tool")).toBe("run_tool");
    expect(family.toolName("get_dataset_details")).toBe("get_dataset_details");
    expect(family.toolName("bash")).toBeUndefined();
    expect(family.tool("run_tool")).toBe("run_tool");
    expect(galaxyToolFamily()).toBe(family);
  });

  it("with no source installed registers the default galaxy-ops source", () => {
    const { pi, registerTool } = fakePi();
    const family = registerGalaxyTools(pi);
    const names = registerTool.mock.calls.map(([t]) => t.name);
    // The tests' fixture family, then the saved-output reader outside it.
    expect(names).toEqual([...GALAXY_TOOL_NAMES, "galaxy_read_output"]);
    expect(family.toolName("run_tool")).toBe("run_tool");
    expect(family.toolName("list_jobs")).toBe("list_jobs");
    expect(family.toolName("get_job_logs")).toBe("get_job_logs");
    expect(family.toolName("galaxy_read_output")).toBeUndefined();
    expect(galaxyToolFamily().toolName("run_tool")).toBe("run_tool");
    expect(registeredGalaxyTools()).toHaveLength(48);
  });

  it("registers a source's companions after its tools, outside the family", () => {
    setGalaxyToolSource({ tools: () => [stub("run_tool")], companions: () => [stub("reader")] });
    const { pi, registerTool } = fakePi();
    const family = registerGalaxyTools(pi);
    expect(registerTool.mock.calls.map(([t]) => t.name)).toEqual(["run_tool", "reader"]);
    expect(family.toolName("reader")).toBeUndefined();
  });

  it("refuses two tools under one name before registering any", () => {
    setGalaxyToolSource({ tools: () => [stub("run_tool")], companions: () => [stub("run_tool")] });
    const { pi, registerTool } = fakePi();
    expect(() => registerGalaxyTools(pi)).toThrow("two Galaxy tools are named run_tool");
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("uninstalling the source forgets the registered family", () => {
    setGalaxyToolSource({ tools: () => [stub("run_tool")] });
    registerGalaxyTools(fakePi().pi);
    expect(galaxyToolFamily().toolName("run_tool")).toBe("run_tool");
    setGalaxyToolSource(null);
    expect(galaxyToolFamily().toolName("run_tool")).toBeUndefined();
    expect(registeredGalaxyTools()).toEqual([]);
  });
});
