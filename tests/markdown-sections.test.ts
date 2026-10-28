import { describe, expect, it } from "vitest";
import {
  applySectionEdit,
  repeatedHeadingRefusal,
  sectionsHeaded,
} from "../shared/markdown-sections.js";

const TWO_PLANS = [
  "# Notebook",
  "",
  "## Plan A: QC [remote]",
  "",
  "### Steps",
  "",
  "- [ ] 1. **QC** {#plan-a-step-1}",
  "",
  "## Plan B: Align [remote]",
  "",
  "### Steps",
  "",
  "- [ ] 1. **Align** {#plan-b-step-1}",
  "",
].join("\n");

describe("markdown sections", () => {
  it("runs a section to the next heading of the same or a higher level", () => {
    expect(sectionsHeaded(TWO_PLANS, "## Plan A: QC [remote]")).toEqual([
      "## Plan A: QC [remote]\n\n### Steps\n\n- [ ] 1. **QC** {#plan-a-step-1}\n",
    ]);
    expect(sectionsHeaded(TWO_PLANS, "# Notebook")).toEqual([TWO_PLANS]);
  });

  it("replaces a section's subsections with the ones section_content carries", () => {
    const after = applySectionEdit(
      TWO_PLANS,
      "## Plan A: QC [remote]",
      "## Plan A: QC [remote]\n\n### Steps\n\n- [x] 1. **QC** {#plan-a-step-1}\n",
    );
    expect(after.match(/\{#plan-a-step-1\}/g)).toHaveLength(1);
    expect(after).toContain("- [x] 1. **QC**");
    expect(after).not.toContain("- [ ] 1. **QC**");
    expect(after).toContain("- [ ] 1. **Align** {#plan-b-step-1}");
  });

  it("does not read a '#' line inside fenced code as a heading", () => {
    const page = "## Methods\n```bash\n# align\nbwa mem a\n```\n## Results\nr";
    expect(sectionsHeaded(page, "# align")).toEqual([]);
    expect(
      applySectionEdit(page, "## Methods", "## Methods\n```bash\n# align\nbwa mem2 a\n```"),
    ).toBe("## Methods\n```bash\n# align\nbwa mem2 a\n```\n## Results\nr");
  });

  it("closes a fence only on a fence of the same character, at least as long", () => {
    const page = "## A\n````\n```\n## inside\n````\n## B\nb";
    expect(sectionsHeaded(page, "## inside")).toEqual([]);
    expect(sectionsHeaded(page, "## B")).toEqual(["## B\nb"]);
  });

  it("refuses a heading the page repeats, naming each parent heading", () => {
    const refusal = repeatedHeadingRefusal(TWO_PLANS, "### Steps");
    expect(refusal).toMatch(/2 sections/);
    expect(refusal).toContain('"## Plan A: QC [remote]"');
    expect(refusal).toContain('"## Plan B: Align [remote]"');
    expect(repeatedHeadingRefusal(TWO_PLANS, "## Plan A: QC [remote]")).toBeUndefined();
    expect(repeatedHeadingRefusal(TWO_PLANS, "## Methods")).toBeUndefined();
    expect(() => applySectionEdit(TWO_PLANS, "### Steps", "### Steps\nx")).toThrow(/2 sections/);
  });

  it("keeps the flat cases byte for byte", () => {
    expect(
      applySectionEdit("# T\n\n## Plan\nold\n\n## Results\nr\n", "## Plan", "## Plan\nnew\n"),
    ).toBe("# T\n\n## Plan\nnew\n\n## Results\nr\n");
    expect(applySectionEdit("# T\n\n## Plan\nold\n", "## Methods", "## Methods\nm")).toBe(
      "# T\n\n## Plan\nold\n\n## Methods\nm",
    );
    expect(applySectionEdit("", "## Plan", "## Plan\nfirst")).toBe("## Plan\nfirst");
    expect(applySectionEdit("intro\n\n## Plan\nold", "## Plan", "## Plan\nnew\n\n")).toBe(
      "intro\n\n## Plan\nnew\n\n",
    );
    expect(applySectionEdit("## Plan \nold\n## Plan\nkeep", "## Plan", "## Plan\nnew")).toBe(
      "## Plan \nold\n## Plan\nnew",
    );
  });

  it("rewrites only a section's lead when section_content carries no subsections", () => {
    // A page title holds the whole notebook; an intro-only edit under it must keep every plan.
    const after = applySectionEdit(TWO_PLANS, "# Notebook", "# Notebook\nUpdated summary\n");
    expect(after).toBe(TWO_PLANS.replace("# Notebook\n\n", "# Notebook\nUpdated summary\n\n"));
    expect(after).toContain("{#plan-a-step-1}");
    expect(after).toContain("{#plan-b-step-1}");
    const plan = "## Plan A\nold\n### Steps\n- [ ] 1\n## Plan B\nb";
    expect(applySectionEdit(plan, "## Plan A", "## Plan A\nnew")).toBe(
      "## Plan A\nnew\n### Steps\n- [ ] 1\n## Plan B\nb",
    );
  });

  it("reads a line opening with inline backtick code as prose, not a fence", () => {
    // CommonMark allows no backtick in a backtick fence's info string, so this is a code span.
    const page = "## A\n```x``` is code\n## B\nold b";
    expect(sectionsHeaded(page, "## B")).toEqual(["## B\nold b"]);
    expect(applySectionEdit(page, "## B", "## B\nnew")).toBe("## A\n```x``` is code\n## B\nnew");
    expect(sectionsHeaded("## A\n```js\n## no\n```\n## B\nb", "## no")).toEqual([]);
    expect(sectionsHeaded("## A\n~~~ a`b\n## no\n~~~\n## B\nb", "## no")).toEqual([]);
  });
});
