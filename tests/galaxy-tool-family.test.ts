import { describe, expect, it } from "vitest";
import { bareFamily } from "../shared/galaxy-tool-family.js";

// Each guard's own test covers how it uses the family; this is the family itself.
describe("bareFamily", () => {
  const family = bareFamily(["run_tool", "get_dataset_details"]);

  it("names its Galaxy tools by themselves", () => {
    expect(family.tool("run_tool")).toBe("run_tool");
    expect(family.toolName("run_tool")).toBe("run_tool");
    expect(family.toolName("get_dataset_details")).toBe("get_dataset_details");
  });

  it("claims nothing else", () => {
    expect(family.toolName("bash")).toBeUndefined();
    expect(family.toolName("galaxy_job_record")).toBeUndefined();
    expect(family.toolName("mcp__brc_analytics__get_genome")).toBeUndefined();
    expect(family.toolName("")).toBeUndefined();
    expect(family.toolName(undefined)).toBeUndefined();
  });
});
