import { describe, it, expect, beforeEach } from "vitest";
import {
  createPlan,
  resetState,
  addStep,
  addWorkflowStep,
  setStepParameterOverrides,
  getCurrentPlan,
} from "../extensions/loom/state";
import { generateNotebook } from "../extensions/loom/notebook-writer";
import { parseNotebook, notebookToPlan } from "../extensions/loom/notebook-parser";

describe("workflow_set_overrides", () => {
  beforeEach(() => {
    resetState();
  });

  function seedWorkflowPlan() {
    createPlan({
      title: "Parameter Overrides",
      researchQuestion: "Does the override ride through to galaxy-mcp?",
      dataDescription: "synthetic",
      expectedOutcomes: [],
      constraints: [],
    });
    addWorkflowStep({
      workflowId: "wf-ag-gwas",
      trsId: "iwc-ag-gwas",
      workflowStructure: {
        name: "AlphaGenome GWAS",
        version: 1,
        toolIds: ["alphagenome_ism_scanner", "alphagenome_variant_scorer"],
        toolNames: ["ism_scanner", "variant_scorer"],
        inputLabels: ["Lead SNP"],
        outputLabels: ["Ranked positions"],
        stepCount: 2,
      },
    });
  }

  it("stores overrides on the step", () => {
    seedWorkflowPlan();
    const merged = setStepParameterOverrides("1", {
      variant_ism_width: 600,
      "ism_scanner.max_region_width": 600,
    });

    expect(merged).toEqual({
      variant_ism_width: 600,
      "ism_scanner.max_region_width": 600,
    });
    expect(getCurrentPlan()!.steps[0].parameterOverrides).toEqual(merged);
  });

  it("merges (not replaces) across repeated calls", () => {
    seedWorkflowPlan();
    setStepParameterOverrides("1", { variant_ism_width: 600 });
    const merged = setStepParameterOverrides("1", {
      "ism_scanner.max_region_width": 600,
    });
    expect(merged).toEqual({
      variant_ism_width: 600,
      "ism_scanner.max_region_width": 600,
    });
  });

  it("renders a deviation table under the step in the notebook", () => {
    seedWorkflowPlan();
    setStepParameterOverrides("1", {
      variant_ism_width: 600,
      enable_stranded: true,
    });

    const markdown = generateNotebook(getCurrentPlan()!);
    expect(markdown).toContain("Parameter overrides (deviations from workflow defaults)");
    expect(markdown).toContain("| variant_ism_width | 600 |");
    expect(markdown).toContain("| enable_stranded | true |");
  });

  it("round-trips overrides through parseNotebook", () => {
    seedWorkflowPlan();
    setStepParameterOverrides("1", {
      variant_ism_width: 600,
      "ism_scanner.max_region_width": 600,
      notes: "per-locus sensitivity tweak",
    });

    const markdown = generateNotebook(getCurrentPlan()!);
    const parsed = parseNotebook(markdown);
    const restored = notebookToPlan(parsed!);

    expect(restored.steps[0].parameterOverrides).toEqual({
      variant_ism_width: 600,
      "ism_scanner.max_region_width": 600,
      notes: "per-locus sensitivity tweak",
    });
  });

  it("errors when the step is missing", () => {
    seedWorkflowPlan();
    expect(() => setStepParameterOverrides("999", { x: 1 })).toThrow(
      /Step 999 not found/
    );
  });

  it("handles nested override values verbatim (passed straight to invoke_workflow)", () => {
    seedWorkflowPlan();
    const overrides = {
      "1": { variant_ism_width: 600 },
      "2": { scorers: ["CHIP_TF", "ATAC"], include_lead: true },
    };
    setStepParameterOverrides("1", overrides);

    const markdown = generateNotebook(getCurrentPlan()!);
    const restored = notebookToPlan(parseNotebook(markdown)!);

    expect(restored.steps[0].parameterOverrides).toEqual(overrides);
  });
});

describe("parameter overrides round-trip on a plain tool step", () => {
  beforeEach(() => {
    resetState();
  });

  it("works on tool steps too, not just workflow steps", () => {
    createPlan({
      title: "Tool step overrides",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });
    addStep({
      name: "ISM",
      description: "",
      executionType: "tool",
      toolId: "alphagenome_ism_scanner",
      inputs: [],
      expectedOutputs: [],
      dependsOn: [],
    });
    setStepParameterOverrides("1", { max_region_width: 600 });

    const markdown = generateNotebook(getCurrentPlan()!);
    const restored = notebookToPlan(parseNotebook(markdown)!);
    expect(restored.steps[0].parameterOverrides).toEqual({ max_region_width: 600 });
  });
});
