import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loomToGalaxyMarkdown,
  galaxyMarkdownToLoom,
  loomToGalaxyMarkdownRich,
  galaxyInvocationValidator,
  galaxyJobValidator,
  type DirectiveValidators,
} from "../extensions/loom/galaxy-markdown-adapter";
import * as galaxyApi from "../extensions/loom/galaxy-api";

vi.mock("../extensions/loom/galaxy-api");

const ALL_VALID: DirectiveValidators = {
  invocation: { isValid: async () => true },
  job: { isValid: async () => true },
};
const NONE_VALID: DirectiveValidators = {
  invocation: { isValid: async () => false },
  job: { isValid: async () => false },
};

const NOTEBOOK = [
  "# chrM Variant Calling",
  "",
  "## Plan A: chrM Variant Calling [hybrid]",
  "",
  "- [x] {#plan-a-step-2} BWA alignment",
  "",
  "```loom-invocation",
  "invocation_id: abc123",
  "galaxy_server_url: https://test.galaxyproject.org",
  "notebook_anchor: plan-a-step-2",
  "label: BWA alignment",
  "submitted_at: 2026-05-29T12:00:00Z",
  "status: completed",
  "```",
  "",
  "| sample | mapped % |",
  "|--------|----------|",
  "| s1     | 96.2     |",
].join("\n");

describe("galaxy-markdown-adapter -- push", () => {
  it("replaces the loom-invocation fence with a hidden carrier and leaves narrative intact", () => {
    const out = loomToGalaxyMarkdown(NOTEBOOK);
    expect(out).not.toContain("```loom-invocation");
    expect(out).toMatch(/^\[loom-invocation:v1\]: #loom "[A-Za-z0-9+/=]+"$/m);
    expect(out).toContain("## Plan A: chrM Variant Calling [hybrid]");
    expect(out).toContain("- [x] {#plan-a-step-2} BWA alignment");
    expect(out).toContain("| s1     | 96.2     |");
  });
});

describe("galaxy-markdown-adapter -- round trip", () => {
  it("loom -> galaxy -> loom is the identity", () => {
    expect(galaxyMarkdownToLoom(loomToGalaxyMarkdown(NOTEBOOK))).toBe(NOTEBOOK);
  });

  it("is a no-op on content with no invocation blocks", () => {
    const plain = "# Title\n\nsome prose\n";
    expect(loomToGalaxyMarkdown(plain)).toBe(plain);
    expect(galaxyMarkdownToLoom(plain)).toBe(plain);
  });

  it("does not decode carrier-like syntax that appears inline in prose", () => {
    // A notebook documenting Loom's own format must survive the round trip: an
    // inline mention of the carrier is not a real (standalone-line) carrier.
    const prose = [
      "# Format docs",
      "",
      'On push, Loom emits `[loom-invocation:v1]: #loom "YWJj"` for each block.',
      "",
    ].join("\n");
    expect(loomToGalaxyMarkdown(prose)).toBe(prose);
    expect(galaxyMarkdownToLoom(prose)).toBe(prose);
  });

  it("preserves a human-authored ```galaxy fence on pull", () => {
    // A narrative galaxy directive someone wrote by hand (no carrier following)
    // must survive -- only Loom's own directives, which sit directly above a
    // carrier, get stripped.
    const authored = [
      "# Notes",
      "",
      "Example of a Galaxy directive you can use:",
      "",
      "```galaxy",
      "history_dataset_display(history_dataset_id=abc)",
      "```",
      "",
      "more prose",
      "",
    ].join("\n");
    expect(galaxyMarkdownToLoom(authored)).toBe(authored);
  });

  it("strips Loom's directive but keeps an adjacent human-authored ```galaxy fence", async () => {
    const human = ["```galaxy", "history_dataset_display(history_dataset_id=abc)", "```"].join(
      "\n",
    );
    const pushed = await loomToGalaxyMarkdownRich(NOTEBOOK, ALL_VALID);
    // Drop a hand-authored galaxy fence into the pushed page (with a blank line,
    // as a human would), then pull.
    const pulled = galaxyMarkdownToLoom(`${human}\n\n${pushed}`);
    expect(pulled).toContain("history_dataset_display(history_dataset_id=abc)");
    expect(pulled).toContain("```loom-invocation");
    expect(pulled).not.toContain("invocation_outputs(");
  });

  it("handles multiple invocation blocks", () => {
    const two =
      NOTEBOOK +
      "\n\n```loom-invocation\ninvocation_id: def456\ngalaxy_server_url: https://test.galaxyproject.org\nnotebook_anchor: plan-a-step-3\nlabel: calling\nsubmitted_at: 2026-05-29T13:00:00Z\nstatus: in_progress\n```\n";
    const pushed = loomToGalaxyMarkdown(two);
    expect((pushed.match(/^\[loom-invocation:v1\]: #loom "/gm) ?? []).length).toBe(2);
    expect(galaxyMarkdownToLoom(pushed)).toBe(two);
  });
});

describe("galaxy-markdown-adapter -- rich push", () => {
  it("emits a galaxy directive when the invocation id validates, plus the carrier", async () => {
    const out = await loomToGalaxyMarkdownRich(NOTEBOOK, ALL_VALID);
    expect(out).toContain("```galaxy");
    expect(out).toContain("invocation_outputs(invocation_id=abc123)");
    expect(out).toMatch(/^\[loom-invocation:v1\]: #loom "[A-Za-z0-9+/=]+"$/m);
    // round trip still restores the original, stripping the directive
    expect(galaxyMarkdownToLoom(out)).toBe(NOTEBOOK);
  });

  it("omits the directive when the id does not validate, but keeps the carrier", async () => {
    const out = await loomToGalaxyMarkdownRich(NOTEBOOK, NONE_VALID);
    expect(out).not.toContain("```galaxy");
    expect(out).toMatch(/^\[loom-invocation:v1\]: #loom "[A-Za-z0-9+/=]+"$/m);
    expect(galaxyMarkdownToLoom(out)).toBe(NOTEBOOK);
  });

  it("omits the directive without calling the validator when the block has no invocation_id", async () => {
    const noId = [
      "# Notes",
      "",
      "```loom-invocation",
      "galaxy_server_url: https://test.galaxyproject.org",
      "notebook_anchor: plan-a-step-2",
      "label: BWA alignment",
      "status: completed",
      "```",
      "",
    ].join("\n");
    const validator = {
      isValid: async () => {
        throw new Error("validator must not be consulted when there is no invocation_id");
      },
    };
    const out = await loomToGalaxyMarkdownRich(noId, { invocation: validator, job: validator });
    expect(out).not.toContain("```galaxy");
    expect(out).toMatch(/^\[loom-invocation:v1\]: #loom "[A-Za-z0-9+/=]+"$/m);
    expect(galaxyMarkdownToLoom(out)).toBe(noId);
  });
});

describe("galaxy-markdown-adapter -- carrier whitespace tolerance", () => {
  it("decodes a carrier that picked up trailing whitespace and still strips its directive", async () => {
    const rich = await loomToGalaxyMarkdownRich(NOTEBOOK, ALL_VALID);
    // Simulate a storage round trip that appended whitespace to the carrier line.
    const withTrailingWs = rich.replace(
      /(\[loom-invocation:v1\]: #loom "[A-Za-z0-9+/=]+")$/m,
      "$1  ",
    );
    expect(withTrailingWs).not.toBe(rich); // guard: the mutation actually landed

    const pulled = galaxyMarkdownToLoom(withTrailingWs);
    expect(pulled).toContain("```loom-invocation");
    expect(pulled).toContain("invocation_id: abc123");
    expect(pulled).not.toContain("[loom-invocation:v1]"); // carrier was decoded, not left behind
    expect(pulled).not.toContain("invocation_outputs("); // Loom's own directive was stripped
  });
});

describe("galaxy-markdown-adapter -- galaxyInvocationValidator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a path-like id before making any network call", async () => {
    expect(await galaxyInvocationValidator.isValid("../histories")).toBe(false);
    expect(galaxyApi.galaxyGet).not.toHaveBeenCalled();
  });

  it("validates a hex id (encoded into the path) when the server echoes the same id", async () => {
    vi.mocked(galaxyApi.galaxyGet).mockResolvedValue({ id: "abc123" });
    expect(await galaxyInvocationValidator.isValid("abc123")).toBe(true);
    expect(galaxyApi.galaxyGet).toHaveBeenCalledWith("/invocations/abc123");
  });

  it("rejects when the server returns 200 for a different resource", async () => {
    vi.mocked(galaxyApi.galaxyGet).mockResolvedValue({ id: "somethingelse" });
    expect(await galaxyInvocationValidator.isValid("abc123")).toBe(false);
  });

  it("rejects when the lookup throws", async () => {
    vi.mocked(galaxyApi.galaxyGet).mockRejectedValue(new Error("404"));
    expect(await galaxyInvocationValidator.isValid("abc123")).toBe(false);
  });
});

const JOB_BLOCK = [
  "```loom-job",
  "job_id: 5f2c1a9e0b7d3c44",
  "galaxy_server_url: https://test.galaxyproject.org",
  "notebook_anchor: plan-a-step-3",
  "label: FastQC",
  "tool_id: toolshed.g2.bx.psu.edu/repos/devteam/fastqc/fastqc/0.74+galaxy0",
  "submitted_at: 2026-05-29T12:30:00Z",
  "status: completed",
  "```",
].join("\n");

const SESSION_BLOCK = [
  "```loom-session",
  "id: 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  "started_at: 2026-05-29T11:00:00Z",
  "ended_at: 2026-05-29T13:00:00Z",
  "notebook: notebook.md",
  "orphaned_active_steps: 0",
  "```",
].join("\n");

const HUMAN_GALAXY = ["```galaxy", "history_dataset_display(history_dataset_id=abc)", "```"].join(
  "\n",
);

const MIXED = [
  NOTEBOOK,
  "",
  "## QC",
  "",
  JOB_BLOCK,
  "",
  "Here is the report I pinned by hand:",
  "",
  HUMAN_GALAXY,
  "",
  SESSION_BLOCK,
  "",
].join("\n");

describe("galaxy-markdown-adapter -- job and session fences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("carries a loom-job fence and round-trips it", () => {
    const body = `# NB\n\n${JOB_BLOCK}\n\ntail\n`;
    const pushed = loomToGalaxyMarkdown(body);
    expect(pushed).not.toContain("```loom-job");
    expect(pushed).toMatch(/^\[loom-job:v1\]: #loom "[A-Za-z0-9+/=]+"$/m);
    expect(galaxyMarkdownToLoom(pushed)).toBe(body);
  });

  it("carries a loom-session fence and round-trips it", () => {
    const body = `# NB\n\n${SESSION_BLOCK}\n`;
    const pushed = loomToGalaxyMarkdown(body);
    expect(pushed).not.toContain("```loom-session");
    expect(pushed).toMatch(/^\[loom-session:v1\]: #loom "[A-Za-z0-9+/=]+"$/m);
    expect(galaxyMarkdownToLoom(pushed)).toBe(body);
  });

  it("emits a job_parameters directive directly above a validated job's carrier", async () => {
    const isValid = vi.fn(async () => true);
    const out = await loomToGalaxyMarkdownRich(`# NB\n\n${JOB_BLOCK}\n`, {
      invocation: { isValid: async () => false },
      job: { isValid },
    });
    expect(isValid).toHaveBeenCalledWith("5f2c1a9e0b7d3c44");
    const lines = out.split("\n");
    const at = lines.indexOf("job_parameters(job_id=5f2c1a9e0b7d3c44)");
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe("```galaxy");
    expect(lines[at + 1]).toBe("```");
    expect(lines[at + 2]).toMatch(/^\[loom-job:v1\]: #loom "/);
    expect(galaxyMarkdownToLoom(out)).toBe(`# NB\n\n${JOB_BLOCK}\n`);
  });

  it("omits the job directive when the job id does not validate", async () => {
    const out = await loomToGalaxyMarkdownRich(`# NB\n\n${JOB_BLOCK}\n`, NONE_VALID);
    expect(out).not.toContain("```galaxy");
    expect(out).not.toContain("job_parameters(");
    expect(out).toMatch(/^\[loom-job:v1\]: #loom "/m);
    expect(galaxyMarkdownToLoom(out)).toBe(`# NB\n\n${JOB_BLOCK}\n`);
  });

  it("never emits a directive for a malformed job id, even through the real validator", async () => {
    const hostile = JOB_BLOCK.replace("job_id: 5f2c1a9e0b7d3c44", "job_id: ../jobs");
    const out = await loomToGalaxyMarkdownRich(`# NB\n\n${hostile}\n`, {
      invocation: galaxyInvocationValidator,
      job: galaxyJobValidator,
    });
    expect(out).not.toContain("job_parameters(");
    expect(galaxyApi.galaxyGet).not.toHaveBeenCalled();
    expect(galaxyMarkdownToLoom(out)).toBe(`# NB\n\n${hostile}\n`);
  });

  it("gives a session block a carrier only, never a directive", async () => {
    const invocation = vi.fn(async () => true);
    const job = vi.fn(async () => true);
    const out = await loomToGalaxyMarkdownRich(`# NB\n\n${SESSION_BLOCK}\n`, {
      invocation: { isValid: invocation },
      job: { isValid: job },
    });
    expect(out).not.toContain("```galaxy");
    expect(invocation).not.toHaveBeenCalled();
    expect(job).not.toHaveBeenCalled();
    expect(galaxyMarkdownToLoom(out)).toBe(`# NB\n\n${SESSION_BLOCK}\n`);
  });

  it("round-trips a mixed notebook and keeps the human-authored ```galaxy block", async () => {
    const out = await loomToGalaxyMarkdownRich(MIXED, ALL_VALID);
    for (const kind of ["invocation", "job", "session"]) {
      expect(out).not.toContain("```loom-" + kind);
      expect(out).toMatch(new RegExp(`^\\[loom-${kind}:v1\\]: #loom "`, "m"));
    }
    expect(out).toContain("invocation_outputs(invocation_id=abc123)");
    expect(out).toContain("job_parameters(job_id=5f2c1a9e0b7d3c44)");
    expect(out).toContain(HUMAN_GALAXY);

    const pulled = galaxyMarkdownToLoom(out);
    expect(pulled).toBe(MIXED);
    expect(pulled).not.toContain("job_parameters(");
    expect(pulled).not.toContain("invocation_outputs(");
  });

  it("decodes a hand-built old-format invocation carrier and strips its directive", () => {
    // Byte-for-byte the shape of pages pushed before job/session support.
    const start = NOTEBOOK.indexOf("```loom-invocation");
    const block = NOTEBOOK.slice(start, NOTEBOOK.indexOf("\n```", start) + 4);
    expect(block.endsWith("```")).toBe(true);
    const b64 = Buffer.from(block, "utf8").toString("base64");
    const carrier = `[loom-invocation:v1]: #loom "${b64}"`;
    const page = [
      "# Old page",
      "```galaxy",
      "invocation_outputs(invocation_id=abc123)",
      "```",
      carrier,
      "",
    ].join("\n");
    expect(galaxyMarkdownToLoom(page)).toBe(`# Old page\n${block}\n`);
    // And the encoder still writes exactly that carrier line.
    expect(loomToGalaxyMarkdown(block)).toBe(carrier);
  });

  it("decodes job and session carriers labelled with the orbit prefix", () => {
    const orbitJob = JOB_BLOCK.replace("```loom-job", "```orbit-job");
    const orbitSession = SESSION_BLOCK.replace("```loom-session", "```orbit-session");
    const enc = (s: string) => Buffer.from(s, "utf8").toString("base64");
    const page = [
      "```galaxy",
      "job_parameters(job_id=5f2c1a9e0b7d3c44)",
      "```",
      `[orbit-job:v1]: #orbit "${enc(orbitJob)}"`,
      `[orbit-session:v1]: #orbit "${enc(orbitSession)}"`,
    ].join("\n");
    expect(galaxyMarkdownToLoom(page)).toBe(`${orbitJob}\n${orbitSession}`);
  });

  it("leaves a carrier-shaped line of an unknown kind alone", () => {
    const page = '[loom-galaxy-page:v1]: #loom "YWJj"\n';
    expect(galaxyMarkdownToLoom(page)).toBe(page);
  });
});

describe("galaxy-markdown-adapter -- galaxyJobValidator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a path-like id before making any network call", async () => {
    expect(await galaxyJobValidator.isValid("../histories")).toBe(false);
    expect(await galaxyJobValidator.isValid(".")).toBe(false);
    expect(galaxyApi.galaxyGet).not.toHaveBeenCalled();
  });

  it("validates a hex id when the server echoes the same id", async () => {
    vi.mocked(galaxyApi.galaxyGet).mockResolvedValue({ id: "abc123" });
    expect(await galaxyJobValidator.isValid("abc123")).toBe(true);
    expect(galaxyApi.galaxyGet).toHaveBeenCalledWith("/jobs/abc123");
  });

  it("rejects when the server returns 200 for a different resource", async () => {
    vi.mocked(galaxyApi.galaxyGet).mockResolvedValue({ id: "somethingelse" });
    expect(await galaxyJobValidator.isValid("abc123")).toBe(false);
  });

  it("rejects when the lookup throws", async () => {
    vi.mocked(galaxyApi.galaxyGet).mockRejectedValue(new Error("404"));
    expect(await galaxyJobValidator.isValid("abc123")).toBe(false);
  });
});
