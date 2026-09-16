import { describe, expect, it } from "vitest";
import {
  ambiguousAnchorMessage,
  collectNotebookAnchors,
  listNotebookAnchors,
  resolveNotebookAnchor,
  unknownAnchorMessage,
} from "../extensions/loom/notebook-anchors";

const PLAN = `# Project notebook

## Plan A: chrM Variant Calling [galaxy]

### Steps

- [ ] 1. **QC FASTQs** {#plan-a-step-1} — fastp adapter trim
- [ ] 2. **Align to chrM reference** {#plan-a-step-2} — BWA-MEM
`;

/** What the plan convention writes when anchors are suppressed (Llama-4). */
const ANCHORLESS_PLAN = `# Project notebook

## Plan A: chrM Variant Calling [galaxy]

### Steps

- [ ] 1. **QC FASTQs** — fastp adapter trim
  - Routing: galaxy
- [ ] 2. **Align to chrM reference** — BWA-MEM
  - Routing: galaxy
`;

/** Resolve, or null -- most cases only care about the happy answer. */
function resolve(content: string, input: string): string | null {
  const res = resolveNotebookAnchor(content, input);
  return res.kind === "resolved" ? res.anchor : null;
}

describe("collectNotebookAnchors", () => {
  it("collects explicit {#anchor} markers as written", () => {
    expect(collectNotebookAnchors(PLAN).explicit).toEqual(["plan-a-step-1", "plan-a-step-2"]);
  });

  it("derives a slug from every markdown heading", () => {
    const { headings } = collectNotebookAnchors(PLAN);
    expect(headings).toContain("plan-a-chrm-variant-calling-galaxy");
    expect(headings).toContain("project-notebook");
    expect(headings).toContain("steps");
  });

  it("strips an explicit anchor out of the heading it is attached to", () => {
    const { explicit, headings } = collectNotebookAnchors("## Results {#results-section}\n");
    expect(explicit).toEqual(["results-section"]);
    expect(headings).toEqual(["results"]);
  });

  it("numbers repeated heading slugs the way GitHub does", () => {
    const { headings } = collectNotebookAnchors("## Results\n\n## Results\n\n## Results\n");
    expect(headings).toEqual(["results", "results-1", "results-2"]);
  });

  it("derives a positional address for a plan step with no explicit anchor", () => {
    expect(collectNotebookAnchors(ANCHORLESS_PLAN).steps).toEqual([
      "plan-a-step-1",
      "plan-a-step-2",
    ]);
  });

  it("does not derive a second address for a step that names itself", () => {
    // Two addresses for one step means a block can record the one the evidence
    // gate never matches.
    expect(collectNotebookAnchors(PLAN).steps).toEqual([]);
  });

  it("ignores checkbox lines outside a plan section", () => {
    expect(collectNotebookAnchors("## Notes\n\n- [ ] 1. **Buy milk**\n").steps).toEqual([]);
  });

  it("stops deriving step addresses at the next h2", () => {
    const content = `${ANCHORLESS_PLAN}\n## Results\n\n- [ ] 1. **Not a plan step**\n`;
    expect(collectNotebookAnchors(content).steps).toEqual(["plan-a-step-1", "plan-a-step-2"]);
  });

  it("ignores anchors and headings inside fenced blocks", () => {
    // The plan convention's own worked example lives in a ```plan fence, and
    // the chat draft gets pasted into notebooks. Quoted content is not the
    // plan: binding a run to an example step would bind it to nothing.
    const content = `# Notes

\`\`\`plan
## Plan B: Example [galaxy]

- [ ] 1. **Example step** {#plan-b-step-1} — from the template
\`\`\`
`;
    expect(listNotebookAnchors(content)).toEqual(["notes"]);
  });

  it("does not let ~~~ close a backtick fence", () => {
    // A symmetric toggle ends the quote here and exposes everything after it.
    const content = ["# Notes", "```markdown", "~~~", "- [ ] Quoted {#evil}", "```", ""].join("\n");
    expect(listNotebookAnchors(content)).toEqual(["notes"]);
  });

  it("does not let a shorter run of backticks close a longer fence", () => {
    const content = ["# Notes", "````markdown", "```", "Quoted {#evil}", "````", ""].join("\n");
    expect(listNotebookAnchors(content)).toEqual(["notes"]);
  });

  it("sees a fence opened inside a list item", () => {
    const content = ["# Notes", "- ```markdown", "  Quoted {#evil}", "  ```", ""].join("\n");
    expect(listNotebookAnchors(content)).toEqual(["notes"]);
  });

  it("does not let an indented code sample swallow the rest of the file", () => {
    // Four-space-indented content is a code block, so its ``` is not a fence.
    // Reading it as one hides every real anchor below it.
    const content = [
      "# Notes",
      "",
      "    ```",
      "    fenced sample inside indented code",
      "",
      "## Results",
      "",
      "- [ ] 1. **Real step** {#plan-a-step-1}",
      "",
    ].join("\n");
    expect(listNotebookAnchors(content)).toContain("plan-a-step-1");
    expect(listNotebookAnchors(content)).toContain("results");
  });

  it("does not treat a loom-invocation block's own notebook_anchor as an anchor", () => {
    // Otherwise every recorded block would validate the next record call for
    // the same anchor -- the check would confirm its own writes.
    const content = `# Notes

\`\`\`loom-invocation
invocation_id: inv-1
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-9
label: QC
submitted_at: 2026-09-16T00:00:00Z
status: in_progress
summary: ""
\`\`\`
`;
    expect(listNotebookAnchors(content)).toEqual(["notes"]);
    expect(resolve(content, "plan-a-step-9")).toBeNull();
  });

  it("keeps both spellings when a notebook carries a case collision", () => {
    // De-duplicating them would hide a collision the author should see.
    const anchors = listNotebookAnchors("- [ ] **A** {#Step-1}\n- [ ] **B** {#step-1}\n");
    expect(anchors).toEqual(["Step-1", "step-1"]);
  });
});

describe("resolveNotebookAnchor", () => {
  it("resolves an anchor that exists", () => {
    expect(resolve(PLAN, "plan-a-step-2")).toBe("plan-a-step-2");
  });

  it("resolves a heading slug", () => {
    expect(resolve(PLAN, "plan-a-chrm-variant-calling-galaxy")).toBe(
      "plan-a-chrm-variant-calling-galaxy",
    );
  });

  it("resolves a derived step address in an anchorless plan", () => {
    expect(resolve(ANCHORLESS_PLAN, "plan-a-step-2")).toBe("plan-a-step-2");
  });

  it("accepts the prose form the Llama-4 guidance teaches", () => {
    // `anchorGuidance({omit: true})` tells the model to say "Plan A step 2"
    // because the proxy in front of it rejects curly braces.
    expect(resolve(ANCHORLESS_PLAN, "Plan A step 2")).toBe("plan-a-step-2");
  });

  it("accepts the markdown spellings a model copies out of the notebook", () => {
    for (const input of ["{#plan-a-step-1}", "#plan-a-step-1", " plan-a-step-1 "]) {
      expect(resolve(PLAN, input)).toBe("plan-a-step-1");
    }
  });

  it("canonicalizes case to the spelling in the notebook", () => {
    // The block's notebook_anchor is matched against the step's anchor
    // verbatim (evidence-gate.ts findContradictions), so a case-drifted copy
    // would record a block that binds to no step at all.
    const content = "## Plan A: X [galaxy]\n\n- [ ] 1. **QC** {#Plan-A-Step-1} — fastp\n";
    expect(resolve(content, "plan-a-step-1")).toBe("Plan-A-Step-1");
  });

  it("refuses to guess between two anchors that differ only in case", () => {
    const content = "- [ ] **A** {#Plan-A-Step-1}\n- [ ] **B** {#PLAN-a-step-1}\n";
    const res = resolveNotebookAnchor(content, "plan-a-step-1");
    expect(res.kind).toBe("ambiguous");
    expect(res).toHaveProperty("candidates", ["Plan-A-Step-1", "PLAN-a-step-1"]);
  });

  it("prefers an exact match over a case-insensitive one", () => {
    const content = "- [ ] **A** {#Step-1}\n- [ ] **B** {#step-1}\n";
    expect(resolve(content, "step-1")).toBe("step-1");
  });

  it("returns unknown for an anchor nothing resolves to", () => {
    expect(resolveNotebookAnchor(PLAN, "plan-1-step-3").kind).toBe("unknown");
  });

  it("returns unknown for an empty or brace-only input", () => {
    expect(resolveNotebookAnchor(PLAN, "   ").kind).toBe("unknown");
    expect(resolveNotebookAnchor(PLAN, "{#}").kind).toBe("unknown");
  });
});

describe("rejection messages", () => {
  it("lists the anchors that do exist", () => {
    const msg = unknownAnchorMessage("plan-1-step-3", listNotebookAnchors(PLAN));
    expect(msg).toContain('"plan-1-step-3"');
    expect(msg).toContain("plan-a-step-1");
    expect(msg).toContain("plan-a-step-2");
  });

  it("caps a long list rather than dumping the whole notebook", () => {
    const many = Array.from({ length: 30 }, (_, i) => `anchor-${i}`);
    const msg = unknownAnchorMessage("nope", many);
    expect(msg).toContain("anchor-0");
    expect(msg).not.toContain("anchor-29");
    expect(msg).toContain("10 more");
  });

  it("says what to do when the notebook has no anchors at all", () => {
    const msg = unknownAnchorMessage("plan-a-step-1", []);
    expect(msg).toContain("no headings, plan steps or {#anchor}");
    expect(msg).toContain("{#plan-a-step-1}");
  });

  it("names both spellings of an ambiguous anchor", () => {
    const msg = ambiguousAnchorMessage("plan-a-step-1", ["Plan-A-Step-1", "PLAN-a-step-1"]);
    expect(msg).toContain("Plan-A-Step-1");
    expect(msg).toContain("PLAN-a-step-1");
  });
});
