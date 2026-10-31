/**
 * A typed block quoted inside an outer Markdown fence -- a ```` or ~~~ example
 * in documentation, a pasted transcript, an indented sample -- is an example,
 * not a record. Every scanner has to agree on that, because each one getting it
 * wrong is its own bug: the poller polls the example's id, the evidence gate
 * binds a step to the example's status, and a write to that id rewrites the
 * documentation instead of the real block.
 */

import { describe, expect, it } from "vitest";
import { outerCodeLines } from "../shared/notebook-fences.js";
import {
  appendBlock,
  findInvocationBlocks,
  findProposalBlocks,
  findSessionSummaryBlocks,
  renderInvocationYaml,
  renderSessionSummaryYaml,
  upsertInvocationBlock,
  upsertSessionSummaryBlock,
  type InvocationYaml,
  type SessionSummaryYaml,
} from "../extensions/orbit/notebook-writer";
import {
  findJobBlocks,
  renderJobYaml,
  upsertJobBlock,
  type JobYaml,
} from "../extensions/orbit/galaxy-job-block";
import {
  findGalaxyPageBlocks,
  renderGalaxyPageBlock,
  stripGalaxyPageBlocks,
  upsertGalaxyPageBlock,
  type GalaxyPageBindingYaml,
} from "../extensions/orbit/galaxy-page-binding";
import { findUdtBlocks, renderUdtYaml, upsertUdtBlock } from "../extensions/orbit/galaxy-udt-block";
import {
  detectCompletions,
  findContradictions,
  parsePlanSteps,
} from "../extensions/orbit/evidence-gate";
import {
  galaxyMarkdownToOrbit,
  orbitToGalaxyMarkdown,
  orbitToGalaxyMarkdownRich,
} from "../extensions/orbit/galaxy-markdown-adapter";
import { pageContentProblem } from "../shared/galaxy-page-cells.js";
import { listNotebookAnchors } from "../extensions/orbit/notebook-anchors";
import { parseInvocationBlocks } from "../app/src/renderer/galaxy-invocations.js";
import { parseGalaxyHistoryBindings } from "../app/src/renderer/galaxy-history.js";
import { parseJobBlocks } from "../app/src/renderer/dashboard/data-sources.js";

const inv = (o: Partial<InvocationYaml> = {}): InvocationYaml => ({
  invocationId: "inv-real",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-1",
  label: "Align reads",
  submittedAt: "2026-09-01T10:00:00Z",
  status: "in_progress",
  summary: "",
  ...o,
});

const job = (o: Partial<JobYaml> = {}): JobYaml => ({
  jobId: "job-real",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-1",
  label: "FastQC",
  toolId: "fastqc",
  submittedAt: "2026-09-01T10:00:00Z",
  status: "in_progress",
  summary: "",
  ...o,
});

const session = (o: Partial<SessionSummaryYaml> = {}): SessionSummaryYaml => ({
  id: "sess-real",
  startedAt: "2026-09-01T10:00:00Z",
  endedAt: "2026-09-01T11:00:00Z",
  notebook: "notebook.md",
  orphanedActiveSteps: 0,
  ...o,
});

const page = (o: Partial<GalaxyPageBindingYaml> = {}): GalaxyPageBindingYaml => ({
  pageId: "page-real",
  pageSlug: "my-page",
  galaxyServerUrl: "https://usegalaxy.org",
  historyId: "hist-real",
  lastSyncedRevision: "rev-1",
  boundAt: "2026-09-01T10:00:00Z",
  ...o,
});

const udt = {
  toolId: "my_tool",
  toolUuid: "uuid-real",
  definition: "tools/my_tool.yml",
  createdAt: "2026-09-01T10:00:00Z",
  notebookAnchor: "plan-a-step-1",
};

function block(text: string, prefix?: string): string {
  const trimmed = text.trimEnd();
  return prefix ? trimmed.replace(/^```[a-z]+-/, "```" + prefix + "-") : trimmed;
}

/** Each real block once, and a quoted copy of each in every outer-code shape. */
function examples(): string {
  const quoted = [
    block(renderInvocationYaml(inv({ status: "completed", invocationId: "inv-real" }))),
    block(renderInvocationYaml(inv({ invocationId: "inv-example" })), "loom"),
    block(renderJobYaml(job({ status: "completed" }))),
    block(renderSessionSummaryYaml(session())),
    block(renderGalaxyPageBlock(page({ historyId: "hist-example" }))),
    block(renderUdtYaml({ ...udt, toolUuid: "uuid-example" })),
  ].join("\n\n");
  const indented = block(renderInvocationYaml(inv({ invocationId: "inv-indented" })))
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
  return [
    "## How records look",
    "",
    "````markdown",
    quoted,
    "````",
    "",
    "~~~text",
    block(renderInvocationYaml(inv({ invocationId: "inv-tilde" }))),
    "~~~",
    "",
    "An indented sample:",
    "",
    indented,
    "",
  ].join("\n");
}

function notebook(): string {
  return [
    "# Notebook",
    "",
    "## Plan A: Align [galaxy]",
    "",
    "- [ ] 1. **Align** {#plan-a-step-1} -- bwa",
    "",
    examples(),
    "## Records",
    "",
    block(renderInvocationYaml(inv())),
    "",
    block(renderJobYaml(job()), "loom"),
    "",
    block(renderSessionSummaryYaml(session())),
    "",
    block(renderGalaxyPageBlock(page())),
    "",
    block(renderUdtYaml(udt), "loom"),
    "",
  ].join("\n");
}

describe("outerCodeLines", () => {
  it("masks a fence only up to a close of the same character, at least as long", () => {
    const lines = ["````md", "```", "inside", "````", "after"];
    expect(outerCodeLines(lines)).toEqual([true, true, true, true, false]);
    const tilde = ["~~~", "```", "inside", "~~~", "after"];
    expect(outerCodeLines(tilde)).toEqual([true, true, true, true, false]);
  });

  it("does not let a plain ``` fence hide one of our blocks it cannot be quoting", () => {
    const lines = ["```text", "```orbit-invocation", "invocation_id: x", "```", "after"];
    expect(outerCodeLines(lines).every((m) => !m)).toBe(true);
  });

  it("opens fences in a CRLF notebook", () => {
    const content = ["~~~markdown", "```orbit-job", "job_id: ex", "```", "~~~", ""].join("\r\n");
    expect(outerCodeLines(content.split("\n")).slice(0, 5)).toEqual([true, true, true, true, true]);
    expect(findJobBlocks(content)).toEqual([]);
  });

  it("masks nothing for an outer fence that never closes", () => {
    const real = block(renderInvocationYaml(inv())).split("\n");
    const lines = ["~~~~", "stray", "", ...real];
    expect(outerCodeLines(lines).every((m) => !m)).toBe(true);
    expect(findInvocationBlocks(lines.join("\n")).map((b) => b.invocationId)).toEqual(["inv-real"]);
  });

  it("does not let an unterminated block of ours hide the next one", () => {
    const real = block(renderInvocationYaml(inv())).split("\n");
    const lines = ["```orbit-job", "job_id: orphan", "", ...real];
    expect(outerCodeLines(lines).every((m) => !m)).toBe(true);
  });

  it("reads a list-item fence and an info string with a backtick per CommonMark", () => {
    expect(outerCodeLines(["- ~~~", "  x", "  ~~~"])).toEqual([true, true, true]);
    expect(outerCodeLines(["```a`b", "x"])).toEqual([false, false]);
  });
});

describe("blocks quoted inside outer Markdown code are not live", () => {
  const nb = notebook();

  it("the brain's finders see only the real blocks", () => {
    expect(findInvocationBlocks(nb).map((b) => [b.invocationId, b.status])).toEqual([
      ["inv-real", "in_progress"],
    ]);
    expect(findJobBlocks(nb).map((b) => [b.jobId, b.status])).toEqual([
      ["job-real", "in_progress"],
    ]);
    expect(findSessionSummaryBlocks(nb).map((s) => s.id)).toEqual(["sess-real"]);
    expect(findGalaxyPageBlocks(nb).map((p) => p.historyId)).toEqual(["hist-real"]);
    expect(findUdtBlocks(nb).map((u) => u.toolUuid)).toEqual(["uuid-real"]);
  });

  it("the renderer's parsers see only the real blocks", () => {
    expect(parseInvocationBlocks(nb).map((b) => b.invocationId)).toEqual(["inv-real"]);
    expect(parseJobBlocks(nb).map((j) => j.jobId)).toEqual(["job-real"]);
    expect(parseGalaxyHistoryBindings(nb).map((b) => b.historyId)).toEqual(["hist-real"]);
  });

  it("an upsert rewrites the real block and leaves the example verbatim", () => {
    const before = examples();
    const done = inv({ status: "completed", summary: "aligned" });
    const out = upsertInvocationBlock(nb, done);
    expect(out.startsWith(nb.slice(0, nb.indexOf(before) + before.length))).toBe(true);
    expect(findInvocationBlocks(out).map((b) => b.status)).toEqual(["completed"]);

    const jobOut = upsertJobBlock(nb, job({ status: "failed" }));
    expect(jobOut).toContain(before);
    expect(findJobBlocks(jobOut).map((b) => b.status)).toEqual(["failed"]);

    const sessOut = upsertSessionSummaryBlock(
      nb,
      session({ endedAt: "2026-09-01T12:00:00Z", orphanedActiveSteps: 3 }),
    );
    expect(sessOut).toContain(before);
    expect(findSessionSummaryBlocks(sessOut).map((s) => s.orphanedActiveSteps)).toEqual([3]);

    const pageOut = upsertGalaxyPageBlock(nb, page({ lastSyncedRevision: "rev-2" }));
    expect(pageOut).toContain(before);
    expect(findGalaxyPageBlocks(pageOut).map((p) => p.lastSyncedRevision)).toEqual(["rev-2"]);

    const udtOut = upsertUdtBlock(nb, { ...udt, definition: "tools/v2.yml" });
    expect(udtOut).toContain(before);
    expect(findUdtBlocks(udtOut).map((u) => u.definition)).toEqual(["tools/v2.yml"]);
  });

  it("a write for an id only an example carries appends a real block instead", () => {
    const out = upsertInvocationBlock(nb, inv({ invocationId: "inv-example" }));
    expect(out).toContain(examples());
    expect(out.trimEnd().endsWith("```")).toBe(true);
    expect(findInvocationBlocks(out).map((b) => b.invocationId)).toEqual([
      "inv-real",
      "inv-example",
    ]);
  });

  it("stripping page bindings leaves a quoted binding in place", () => {
    const out = stripGalaxyPageBlocks(nb);
    expect(out).toContain(examples());
    expect(findGalaxyPageBlocks(out)).toEqual([]);
  });

  it("the evidence gate does not let an example's status satisfy a real step", () => {
    const after = nb.replace("- [ ] 1. **Align**", "- [x] 1. **Align**");
    const flips = detectCompletions(nb, after);
    expect(flips.map((s) => s.anchor)).toEqual(["plan-a-step-1"]);
    // The quoted copy says `completed`; the real block is still running.
    expect(findContradictions(nb, flips).map((c) => c.invocation.invocationId)).toEqual([
      "inv-real",
    ]);
  });

  it("the Galaxy push carries quoted blocks too, but shows only real runs", async () => {
    // Galaxy rejects a page with an orbit-* fence line anywhere in it, quoted or
    // not, so examples travel as carriers; only real blocks earn a directive.
    const carried = [
      "# Notes",
      "",
      "~~~markdown",
      block(renderInvocationYaml(inv({ invocationId: "inv-example" }))),
      block(renderJobYaml(job({ jobId: "job-example" })), "loom"),
      block(renderSessionSummaryYaml(session({ id: "sess-example" }))),
      "~~~",
      "",
      block(renderInvocationYaml(inv())),
      "",
      block(renderJobYaml(job())),
      "",
    ].join("\n");
    const valid = { invocation: { isValid: async () => true }, job: { isValid: async () => true } };
    for (const pushed of [
      orbitToGalaxyMarkdown(carried),
      await orbitToGalaxyMarkdownRich(carried, valid),
    ]) {
      expect(pageContentProblem(pushed)).toBeUndefined();
      expect(galaxyMarkdownToOrbit(pushed)).toBe(carried);
    }
    const rich = await orbitToGalaxyMarkdownRich(carried, valid);
    expect(rich.match(/^```galaxy$/gm)).toHaveLength(2);
    expect(rich).not.toContain("inv-example");
    expect(rich).not.toContain("job-example");
  });

  it("anchors in a quoted block are still not anchors", () => {
    const quotedStep = nb.replace(
      "## How records look\n",
      "## How records look\n\n~~~markdown\n- [ ] 2. **Example** {#quoted-step}\n~~~\n",
    );
    expect(listNotebookAnchors(quotedStep)).toContain("plan-a-step-1");
    expect(listNotebookAnchors(quotedStep)).not.toContain("quoted-step");
    expect(listNotebookAnchors(quotedStep.replace(/\n/g, "\r\n"))).not.toContain("quoted-step");
  });

  it("a stray fence before a real block does not hide it", () => {
    const real = block(renderInvocationYaml(inv()));
    const doubleClose = `${block(renderJobYaml(job()))}\n\`\`\`\n\nSome prose.\n\n${real}\n`;
    const unclosed = `\`\`\`python\nx = 1\n\n${real}\n`;
    for (const content of [doubleClose, unclosed]) {
      expect(findInvocationBlocks(content).map((b) => b.invocationId)).toEqual(["inv-real"]);
      const out = upsertInvocationBlock(content, inv({ status: "completed" }));
      expect(findInvocationBlocks(out).map((b) => b.status)).toEqual(["completed"]);
      expect(out.match(/^```orbit-invocation$/gm)).toHaveLength(1);
    }
  });

  it("an opener indented by accident, with its body flush, is still the real record", () => {
    const lines = block(renderInvocationYaml(inv())).split("\n");
    for (const indent of ["    ", "\t"]) {
      const content = `- Step one\n\n${indent}${lines[0]}\n${lines.slice(1).join("\n")}\n`;
      expect(findInvocationBlocks(content).map((b) => b.invocationId)).toEqual(["inv-real"]);
      const out = upsertInvocationBlock(content, inv({ status: "completed" }));
      expect(findInvocationBlocks(out).map((b) => b.status)).toEqual(["completed"]);
      expect(out.match(/```orbit-invocation$/gm)).toHaveLength(1);
    }
  });

  it("a fence opened in a list item ends with the item", () => {
    const real = block(renderInvocationYaml(inv()));
    const content = `- ~~~md\n  quoted\n\n${real}\n~~~\n`;
    expect(findInvocationBlocks(content).map((b) => b.invocationId)).toEqual(["inv-real"]);
    const out = upsertInvocationBlock(content, inv({ status: "completed" }));
    expect(out.match(/^```orbit-invocation$/gm)).toHaveLength(1);
    // Indented to the item's content, a quoted block is still inside it.
    const quoted = `- ~~~md\n${real.replace(/^/gm, "  ")}\n  ~~~\n`;
    expect(outerCodeLines(quoted.split("\n")).slice(0, 5).every(Boolean)).toBe(true);
  });

  it("the plan parser does not let a quoted step overwrite a real one", () => {
    const content = [
      "## Plan A: x",
      "- [x] Align {#align}",
      "",
      "~~~markdown",
      "```",
      "- [ ] Align {#align}",
      "```",
      "~~~",
      "",
    ].join("\n");
    expect(parsePlanSteps(content).get("#align")?.state).toBe("x");
  });

  it("an append never lands inside a closed example that quotes an unterminated opener", () => {
    const quotedOrphan = [
      "````markdown",
      "```orbit-invocation",
      "invocation_id: half",
      "````",
    ].join("\n");
    const content = `# Notebook\n\n${quotedOrphan}\n`;
    const out = appendBlock(content, block(renderInvocationYaml(inv())).split("\n"));
    expect(out.startsWith(content.trimEnd())).toBe(true);
    expect(findInvocationBlocks(out).map((b) => b.invocationId)).toEqual(["inv-real"]);
    // And a real block below that example can still be replaced in place.
    const updated = upsertInvocationBlock(out, inv({ status: "completed" }));
    expect(findInvocationBlocks(updated).map((b) => b.status)).toEqual(["completed"]);
    expect(updated.match(/^```orbit-invocation$/gm)).toHaveLength(2);
  });

  it("proposal blocks follow the same rule", () => {
    const real = ["```orbit-proposal", "proposal_id: p-real", "```"].join("\n");
    const quoted = ["~~~", "```orbit-proposal", "proposal_id: p-example", "```", "~~~"].join("\n");
    const ids = (c: string) => findProposalBlocks(c).map((p) => p.proposalId);
    expect(ids(`${quoted}\n\n${real}\n`)).toEqual(["p-real"]);
  });
});
