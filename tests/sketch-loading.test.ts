import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadSketchCorpus,
  parseSketch,
  matchSketchesForPlan,
  renderSketchForPrompt,
} from "../extensions/loom/sketches";
import {
  createPlan,
  resetState,
  addStep,
  getCurrentPlan,
} from "../extensions/loom/state";

function makeCorpus(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-sketches-"));
  const sketchesRoot = path.join(root, "sketches");
  fs.mkdirSync(sketchesRoot, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(sketchesRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return root;
}

const ALPHAGENOME_SKETCH = `---
name: alphagenome-gwas-regulatory
description: AlphaGenome GWAS regulatory interpretation
domain: variant-calling
tags:
  - alphagenome
  - gwas
  - regulatory
tools:
  - name: alphagenome_ism_scanner
    version: 0.6.1+galaxy0
  - name: alphagenome_variant_scorer
    version: 0.6.1+galaxy0
source:
  ecosystem: iwc
  workflow: 417e33144b294c21
expected_output:
  - role: ranked_positions_ism
    assertions:
      - Top ISM position scored above 3.0 for validated loci
      - Peak co-localizes with lead SNP within 500bp
---

# Body

Run ISM scanner, then rank variants.
`;

const UNRELATED_SKETCH = `---
name: rna-seq-deseq2
tags:
  - rna-seq
  - deseq2
tools:
  - name: deseq2
---

Body text.
`;

const MALFORMED_SKETCH = `---
not valid frontmatter at all
---

Body.
`;

describe("sketch parsing", () => {
  it("extracts frontmatter and body from a valid SKETCH.md", () => {
    const parsed = parseSketch(ALPHAGENOME_SKETCH);
    expect(parsed).toBeTruthy();
    expect(parsed!.frontmatter.name).toBe("alphagenome-gwas-regulatory");
    expect(parsed!.frontmatter.tags).toContain("alphagenome");
    expect(parsed!.frontmatter.tools?.[0].name).toBe("alphagenome_ism_scanner");
    expect(parsed!.frontmatter.source?.workflow).toBe("417e33144b294c21");
    expect(parsed!.frontmatter.expected_output?.[0].assertions).toHaveLength(2);
    expect(parsed!.body).toContain("Run ISM scanner");
  });

  it("returns null for malformed frontmatter", () => {
    expect(parseSketch(MALFORMED_SKETCH)).toBeNull();
    expect(parseSketch("no frontmatter here")).toBeNull();
  });
});

describe("sketch corpus loading", () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads multiple sketches from a corpus directory", () => {
    root = makeCorpus({
      "alphagenome/SKETCH.md": ALPHAGENOME_SKETCH,
      "rna-seq/SKETCH.md": UNRELATED_SKETCH,
    });

    const loaded = loadSketchCorpus(root);
    const names = loaded.map((s) => s.frontmatter.name).sort();
    expect(names).toEqual(["alphagenome-gwas-regulatory", "rna-seq-deseq2"]);
  });

  it("skips malformed sketches without crashing", () => {
    root = makeCorpus({
      "good/SKETCH.md": ALPHAGENOME_SKETCH,
      "broken/SKETCH.md": MALFORMED_SKETCH,
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = loadSketchCorpus(root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].frontmatter.name).toBe("alphagenome-gwas-regulatory");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns an empty array for missing corpus path", () => {
    expect(loadSketchCorpus("/nonexistent/path")).toEqual([]);
    expect(loadSketchCorpus("")).toEqual([]);
  });
});

describe("sketch matching against a plan", () => {
  beforeEach(() => {
    resetState();
  });

  it("matches on tool id overlap for an alphagenome plan", () => {
    createPlan({
      title: "AG Plan",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });
    addStep({
      name: "ISM",
      description: "ISM scan",
      executionType: "tool",
      toolId: "alphagenome_ism_scanner",
      inputs: [],
      expectedOutputs: [],
      dependsOn: [],
    });

    const corpus = [parseSketch(ALPHAGENOME_SKETCH)!, parseSketch(UNRELATED_SKETCH)!].map(
      (s, i) => ({ ...s, filePath: `/tmp/${i}/SKETCH.md` }),
    );

    const matches = matchSketchesForPlan(getCurrentPlan()!, corpus);
    expect(matches).toHaveLength(1);
    expect(matches[0].frontmatter.name).toBe("alphagenome-gwas-regulatory");
    expect(matches[0].reason).toContain("tool match");
  });

  it("returns an empty array when no signal matches", () => {
    createPlan({
      title: "Unrelated",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });
    addStep({
      name: "Something else entirely",
      description: "",
      executionType: "tool",
      toolId: "completely-unrelated-tool",
      inputs: [],
      expectedOutputs: [],
      dependsOn: [],
    });

    const corpus = [parseSketch(ALPHAGENOME_SKETCH)!].map((s, i) => ({
      ...s,
      filePath: `/tmp/${i}/SKETCH.md`,
    }));

    expect(matchSketchesForPlan(getCurrentPlan()!, corpus)).toEqual([]);
  });

  it("ranks exact workflow id match above tool-id overlap", () => {
    const exact = parseSketch(ALPHAGENOME_SKETCH)!;
    const toolOnly = parseSketch(
      ALPHAGENOME_SKETCH.replace("417e33144b294c21", "other-workflow-id"),
    )!;
    toolOnly.frontmatter.name = "alphagenome-variant";

    createPlan({
      title: "AG Workflow",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });
    // Add a workflow step with matching workflow ID
    addStep({
      name: "AG Workflow",
      description: "",
      executionType: "workflow",
      workflowId: "417e33144b294c21",
      inputs: [],
      expectedOutputs: [],
      dependsOn: [],
    });

    const corpus = [
      { ...toolOnly, filePath: "/tmp/a/SKETCH.md" },
      { ...exact, filePath: "/tmp/b/SKETCH.md" },
    ];
    const matches = matchSketchesForPlan(getCurrentPlan()!, corpus);

    expect(matches[0].frontmatter.name).toBe("alphagenome-gwas-regulatory");
    expect(matches[0].reason).toContain("exact workflow match");
  });
});

describe("renderSketchForPrompt", () => {
  it("includes name, matched-reason, assertions, and body", () => {
    const parsed = parseSketch(ALPHAGENOME_SKETCH)!;
    const rendered = renderSketchForPrompt({
      ...parsed,
      filePath: "/tmp/SKETCH.md",
      score: 20,
      reason: "2 tool match(es)",
    });

    expect(rendered).toContain("## Analysis Sketch: alphagenome-gwas-regulatory");
    expect(rendered).toContain("2 tool match(es)");
    expect(rendered).toContain("Top ISM position scored above 3.0");
    expect(rendered).toContain("Run ISM scanner");
  });
});
