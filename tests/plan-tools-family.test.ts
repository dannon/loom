import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPlanTools } from "../extensions/loom/tools";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { SPELLED } from "./galaxy-test-helpers";

// The record tools name the submission tool they follow, and those names reach the model, so
// they go through the family. Nothing else pins this text, so the parts the model acts on are
// pinned here under a family that spells every name its own way.
const notAnId = (kind: string, tool: string) =>
  `Galaxy has no ${kind} "nothex!!" ("nothex!!" is not a Galaxy id (they are hex)). ` +
  `Nothing was recorded -- re-read the id from the ${tool} result.`;

interface Registered {
  name: string;
  description: string;
  parameters: { properties: Record<string, { description?: string }> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: { text: string }[] }>;
}

function planTools(...args: unknown[]): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const pi = { registerTool: (t: Registered) => tools.set(t.name, t) };
  (registerPlanTools as (...a: unknown[]) => void)(pi, ...args);
  return tools;
}

async function absentMessage(tool: Registered, idKey: string): Promise<string> {
  const result = await tool.execute("call", {
    [idKey]: "nothex!!",
    notebookAnchor: "plan-a-step-1",
    label: "x",
  });
  return JSON.parse(result.content[0].text).error;
}

beforeEach(() => {
  resetState();
  // The id check runs before the notebook is touched, so the path need not exist.
  setNotebookPath("/nonexistent/loom-plan-tools/notebook.md");
});

afterEach(() => resetState());

describe("plan tools: model-facing names go through the family", () => {
  it("names the family's submission tools", async () => {
    const tools = planTools(SPELLED);
    const inv = tools.get("galaxy_invocation_record")!;
    const job = tools.get("galaxy_job_record")!;
    const bare = /(?<!gx_)\b(run_tool|invoke_workflow)\b/;

    expect(inv.description).toContain("block the moment gx_invoke_workflow returned");
    expect(inv.description).toContain("Both arguments are checked before anything is written");
    expect(inv.description).not.toMatch(bare);
    expect(inv.parameters.properties.invocationId.description).toBe(
      "Galaxy invocation ID returned from gx_invoke_workflow",
    );
    expect(await absentMessage(inv, "invocationId")).toBe(
      notAnId("invocation", "gx_invoke_workflow"),
    );

    expect(job.description).toContain("block the moment gx_run_tool returned");
    expect(job.description).toContain("`toolId` is used only when creating.");
    expect(job.description).not.toMatch(bare);
    expect(job.parameters.properties.jobId.description).toBe(
      "Galaxy job ID returned from gx_run_tool",
    );
    expect(await absentMessage(job, "jobId")).toBe(
      notAnId("job", "gx_run_tool") + " A tool run returns a job id, not a dataset id.",
    );
  });
});
