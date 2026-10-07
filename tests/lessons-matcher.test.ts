import { describe, expect, it } from "vitest";
import {
  collectStringValues,
  extensionMatches,
  extractExtensions,
  extractHosts,
  hostMatches,
  isMatchable,
  matchHaystack,
  matchStepText,
  matchToolEvent,
  mcpToolMatches,
  toolCandidates,
  toolMatches,
  wordHaystack,
} from "../extensions/loom/lessons/matcher";
import { loadPackageLessons } from "../extensions/loom/lessons/store";
import type { Lesson, LessonTrigger } from "../extensions/loom/lessons/types";

const SECTIONS = {
  symptom: "s",
  check_first: "c",
  intervention: "i",
  validate: "v",
  not_when: "n",
};

const lesson = (id: string, trigger: LessonTrigger, over: Partial<Lesson> = {}): Lesson => ({
  id,
  title: `title of ${id}`,
  trigger,
  sections: SECTIONS,
  origin: "package",
  ...over,
});

const GUID = "toolshed.g2.bx.psu.edu/repos/iuc/featurecounts/featurecounts/2.0.3+galaxy2";

describe("matchHaystack", () => {
  it("normalizes every line with C1's rules and lowercases for comparison", () => {
    expect(
      matchHaystack(
        "ValueError: No Reference Index for build mm39\n  at /home/ada/run.py line 12\n",
      ),
    ).toEqual(["valueerror: no reference index for build mm39", "at <path> line 12"]);
  });

  it("drops blank lines", () => {
    expect(matchHaystack("a line\n\n   \n")).toEqual(["a line"]);
  });

  it("windows a very long line so its tail is still reachable", () => {
    const tail = "no reference index registered for build mm39";
    const lines = matchHaystack(`${"filler ".repeat(200)}${tail}`);
    expect(lines.some((l) => l.includes("no reference index registered for build"))).toBe(true);
  });

  it("finds a 150-char signature wherever it sits on a long line", () => {
    const sig = `${"z".repeat(10)} ${"q".repeat(139)}`;
    for (let offset = 0; offset < 400; offset += 7) {
      const line = `${"a".repeat(offset)} ${sig} ${"b ".repeat(3000)}`;
      const l = lesson("s/long", { signatures: [sig] });
      expect(
        matchToolEvent({ toolName: "bash", input: {}, resultText: line }, [l]),
        `offset ${offset}`,
      ).toHaveLength(1);
    }
  });

  it("caps the total text it will look at", () => {
    expect(matchHaystack("x".repeat(500_000)).length).toBeLessThan(4100);
  });
});

describe("collectStringValues", () => {
  it("walks nested objects and arrays, values only -- never keys", () => {
    const values = collectStringValues({
      tool_id: GUID,
      inputs: { gtf: { src: "hda", id: "abc" }, extras: ["a.gtf", 3] },
    });
    expect(values).toContain(GUID);
    expect(values).toContain("a.gtf");
    expect(values).not.toContain("tool_id");
  });

  it("stops at the depth cap instead of recursing forever", () => {
    let deep: unknown = "bottom";
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(collectStringValues(deep)).not.toContain("bottom");
  });

  it("stops at the value cap", () => {
    expect(collectStringValues(Array.from({ length: 2000 }, () => "x")).length).toBe(500);
  });
});

describe("extractHosts / hostMatches", () => {
  it("pulls hosts out of urls, stripping userinfo and port", () => {
    const hosts = extractHosts(
      "curl https://ada:pw@ftp.ncbi.nlm.nih.gov:8443/genomes/x.gtf and ftp://ftp.ensembl.org/y",
    );
    expect([...hosts].sort()).toEqual(["ftp.ensembl.org", "ftp.ncbi.nlm.nih.gov"]);
  });

  it("matches a parent domain on a dot boundary only", () => {
    const hosts = extractHosts("https://ftp.ncbi.nlm.nih.gov/x");
    expect(hostMatches(hosts, "ncbi.nlm.nih.gov")).toBe(true);
    expect(hostMatches(hosts, "ftp.ncbi.nlm.nih.gov")).toBe(true);
    expect(hostMatches(hosts, "nih.gov")).toBe(true);
    expect(hostMatches(hosts, "evilncbi.nlm.nih.gov")).toBe(false);
    expect(hostMatches(extractHosts("https://evilncbi.nlm.nih.gov/x"), "ncbi.nlm.nih.gov")).toBe(
      false,
    );
    expect(hostMatches(hosts, "gov.uk")).toBe(false);
    expect(hostMatches(hosts, "")).toBe(false);
  });

  it("is not fooled by a lookalike host in the userinfo", () => {
    const hosts = extractHosts("https://ncbi.nlm.nih.gov@evil.example/x");
    expect(hostMatches(hosts, "ncbi.nlm.nih.gov")).toBe(false);
  });
});

describe("extractExtensions / extensionMatches", () => {
  it("finds letter-led extensions and ignores version segments", () => {
    const exts = extractExtensions("in.gtf out.fastq.gz tool/2.0.1 archive.TAR");
    expect([...exts].sort()).toEqual(["fastq", "gtf", "gz", "tar"]);
  });

  it("matches a dotted extension on the end of a file name, as one unit", () => {
    expect(extensionMatches("x/counts.tsv.gz", ".tsv.gz")).toBe(true);
    expect(extensionMatches("x/counts.tsv.gz", ".gz")).toBe(true);
    expect(extensionMatches("x/counts.tsv", ".tsv.gz")).toBe(false);
    expect(extensionMatches("ref.GTF", ".gtf")).toBe(true);
    expect(extensionMatches("ref.gtf2", ".gtf")).toBe(false);
    expect(extensionMatches("the .gtf format", ".gtf")).toBe(false);
  });
});

describe("toolCandidates / toolMatches", () => {
  it("matches a bare id and the name segment of a ToolShed GUID, case-insensitively", () => {
    const c = toolCandidates([GUID, "Filter1"]);
    expect(toolMatches(c, "featurecounts")).toBe(true);
    expect(toolMatches(c, "FeatureCounts")).toBe(true);
    expect(toolMatches(c, "filter1")).toBe(true);
    expect(toolMatches(c, "featurecount")).toBe(false);
    // The owner and repo segments are not the tool.
    expect(toolMatches(c, "iuc")).toBe(false);
  });

  it("reads the name segment, not the repo, when they differ", () => {
    const c = toolCandidates(["toolshed.g2.bx.psu.edu/repos/iuc/rgrnastar/rna_starsolo/2.7.11a"]);
    expect(toolMatches(c, "rna_starsolo")).toBe(true);
    expect(toolMatches(c, "rgrnastar")).toBe(false);
  });

  it("accepts a GUID without a version and with a scheme", () => {
    expect(toolMatches(toolCandidates(["https://ts.example/repos/o/r/deseq2"]), "deseq2")).toBe(
      true,
    );
  });

  it("does not match a tool id buried in free text", () => {
    expect(toolMatches(toolCandidates(["please run deseq2 on this"]), "deseq2")).toBe(false);
  });

  it("refuses an entry too short to discriminate", () => {
    expect(toolMatches(toolCandidates(["at"]), "at")).toBe(false);
  });
});

describe("mcpToolMatches", () => {
  it("compares after stripping either prefix, on both sides", () => {
    expect(mcpToolMatches("galaxy_run_tool", "galaxy_run_tool")).toBe(true);
    expect(mcpToolMatches("mcp__galaxy__run_tool", "galaxy_run_tool")).toBe(true);
    expect(mcpToolMatches("galaxy_run_tool", "run_tool")).toBe(true);
    expect(mcpToolMatches("galaxy_run_tool", "galaxy_upload_file")).toBe(false);
    expect(mcpToolMatches("", "galaxy_run_tool")).toBe(false);
  });

  it("does not take another server sharing the galaxy prefix for galaxy-mcp", () => {
    // A server named "galaxy_" or "galaxy__x" registers under pi as
    // mcp__galaxy___<tool> or mcp__galaxy__x__<tool>.
    expect(mcpToolMatches("mcp__galaxy___run_tool", "galaxy_run_tool")).toBe(false);
    expect(mcpToolMatches("mcp__galaxy__x__run_tool", "galaxy_run_tool")).toBe(false);
  });
});

describe("isMatchable", () => {
  it("is false for any non-empty graduated_to", () => {
    expect(isMatchable(lesson("a", {}))).toBe(true);
    expect(isMatchable(lesson("a", {}, { graduated_to: [] }))).toBe(true);
    expect(isMatchable(lesson("a", {}, { graduated_to: ["  "] }))).toBe(true);
    expect(isMatchable(lesson("a", {}, { graduated_to: ["galaxy-mcp#51"] }))).toBe(false);
  });
});

describe("matchToolEvent", () => {
  const ev = (over: Partial<Parameters<typeof matchToolEvent>[0]> = {}) => ({
    toolName: "galaxy_run_tool",
    input: {},
    resultText: "",
    ...over,
  });

  it("matches a normalized signature anywhere in the result text", () => {
    const l = lesson("g/ref", { signatures: ["no reference index registered for build"] });
    const out = matchToolEvent(
      ev({
        resultText:
          "Traceback\nValueError: No reference index   registered for build mm39 (job 998877)\n",
      }),
      [l],
    );
    expect(out).toHaveLength(1);
    expect(out[0].trigger).toBe("signature");
  });

  it("matches a signature carrying placeholders against raw text", () => {
    const l = lesson("g/job", { signatures: ["job <n> failed on <path>"] });
    const out = matchToolEvent(
      ev({ resultText: "job 445566 failed on /data/runs/alpha/out.bam" }),
      [l],
    );
    expect(out.map((m) => m.trigger)).toEqual(["signature"]);
  });

  it("matches signatures regardless of isError -- it is not an input", () => {
    const l = lesson("g/inv", { signatures: ["invocation failed"] });
    expect(
      matchToolEvent(ev({ resultText: '{"results":[{"state":"invocation failed"}]}' }), [l]),
    ).toHaveLength(1);
  });

  it("refuses a signature shorter than the 8-char floor", () => {
    expect(
      matchToolEvent(ev({ resultText: "failed" }), [lesson("a", { signatures: ["failed"] })]),
    ).toEqual([]);
  });

  it("matches an mcp tool name and a tool family out of the arguments", () => {
    const byMcp = lesson("a/mcp", { mcp_tools: ["galaxy_run_tool"] });
    const byTool = lesson("b/tool", { tools: ["featurecounts"] });
    const out = matchToolEvent(ev({ input: { tool_id: GUID } }), [byMcp, byTool]);
    expect(out.map((m) => [m.lesson.id, m.trigger])).toEqual([
      ["a/mcp", "tool"],
      ["b/tool", "tool"],
    ]);
  });

  it("matches the tool and its arguments when pi spells it mcp__galaxy__", () => {
    const byMcp = lesson("a/mcp", { mcp_tools: ["galaxy_run_tool"] });
    const byTool = lesson("b/tool", { tools: ["featurecounts"] });
    const out = matchToolEvent(
      ev({ toolName: "mcp__galaxy__run_tool", input: { tool_id: GUID } }),
      [byMcp, byTool],
    );
    expect(out.map((m) => [m.lesson.id, m.trigger])).toEqual([
      ["a/mcp", "tool"],
      ["b/tool", "tool"],
    ]);
  });

  it("matches a host and an extension out of a bash command", () => {
    const byHost = lesson("a/host", { hosts: ["ncbi.nlm.nih.gov"] });
    const byExt = lesson("b/ext", { extensions: [".gtf"] });
    const out = matchToolEvent(
      ev({
        toolName: "bash",
        input: { command: "curl -O https://ftp.ncbi.nlm.nih.gov/genomes/ref.gtf" },
      }),
      [byHost, byExt],
    );
    expect(out.map((m) => [m.lesson.id, m.trigger])).toEqual([
      ["a/host", "host"],
      ["b/ext", "extension"],
    ]);
  });

  it("matches a format against a datatype argument and against a file extension", () => {
    const l = lesson("a/fmt", { formats: ["gtf"] });
    expect(matchToolEvent(ev({ input: { file_type: "gtf" } }), [l])[0].trigger).toBe("extension");
    expect(matchToolEvent(ev({ input: { path: "ref.gtf" } }), [l])[0].trigger).toBe("extension");
    expect(matchToolEvent(ev({ input: { file_type: "bam" } }), [l])).toEqual([]);
  });

  it("never matches on the result text for anything but signatures", () => {
    const l = lesson("a", { hosts: ["ncbi.nlm.nih.gov"], tools: ["deseq2"], extensions: [".gtf"] });
    expect(
      matchToolEvent(ev({ resultText: "https://ncbi.nlm.nih.gov/x.gtf ran deseq2" }), [l]),
    ).toEqual([]);
  });

  it("never matches a graduated lesson", () => {
    const l = lesson("a", { signatures: ["no reference index"] }, { graduated_to: ["#51"] });
    expect(matchToolEvent(ev({ resultText: "no reference index here" }), [l])).toEqual([]);
  });

  it("reports one match per lesson, with the most specific trigger", () => {
    const l = lesson("a", {
      signatures: ["no reference index"],
      mcp_tools: ["galaxy_run_tool"],
      hosts: ["ncbi.nlm.nih.gov"],
    });
    const out = matchToolEvent(
      ev({
        resultText: "no reference index here",
        input: { url: "https://ftp.ncbi.nlm.nih.gov/x" },
      }),
      [l],
    );
    expect(out).toHaveLength(1);
    expect(out[0].trigger).toBe("signature");
  });

  it("ranks signature over tool over host over extension", () => {
    const out = matchToolEvent(
      ev({
        resultText: "no reference index here",
        input: { tool_id: "featurecounts", url: "https://ftp.ncbi.nlm.nih.gov/ref.gtf" },
      }),
      [
        lesson("d/ext", { extensions: [".gtf"] }),
        lesson("c/host", { hosts: ["ncbi.nlm.nih.gov"] }),
        lesson("b/tool", { tools: ["featurecounts"] }),
        lesson("a/sig", { signatures: ["no reference index"] }),
      ],
    );
    expect(out.map((m) => m.lesson.id)).toEqual(["a/sig", "b/tool", "c/host", "d/ext"]);
  });

  it("breaks an equal-trigger tie by origin, then by id", () => {
    const sig = { signatures: ["no reference index"] };
    const out = matchToolEvent(ev({ resultText: "no reference index" }), [
      lesson("b/pkg", sig),
      lesson("a/pkg", sig),
      lesson("z/mine", sig, { origin: "user" }),
    ]);
    expect(out.map((m) => m.lesson.id)).toEqual(["z/mine", "a/pkg", "b/pkg"]);
  });

  it("returns [] for a lesson with no trigger block at all", () => {
    expect(matchToolEvent(ev({ resultText: "anything" }), [lesson("a", {})])).toEqual([]);
  });

  it("fires the shipped STARsolo lesson on its real tool GUID", () => {
    const shipped = loadPackageLessons().lessons;
    const out = matchToolEvent(
      ev({ input: { tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/rgrnastar/rna_starsolo/2.7.11a" } }),
      shipped,
    );
    expect(out.map((m) => m.lesson.id)).toContain("galaxy-tools/reference-index-not-on-server");
    // galaxy-api/* lessons have graduated, so none of them can ever fire.
    expect(out.some((m) => m.lesson.id.startsWith("galaxy-api/"))).toBe(false);
  });
});

describe("wordHaystack", () => {
  it("folds to space-separated lowercase words, padded for whole-word tests", () => {
    expect(wordHaystack("Normalize the counts (CPM)!")).toBe(" normalize the counts cpm ");
  });
});

describe("matchStepText", () => {
  const kw = (id: string, step_keywords: string[], over = {}) =>
    lesson(id, { step_keywords }, over);

  it("matches a whole word, not a substring", () => {
    const l = kw("a", ["gtf"]);
    expect(matchStepText("download the GTF annotation", [l])).toHaveLength(1);
    expect(matchStepText("run gtfoobar on it", [l])).toEqual([]);
  });

  it("matches a multi-word keyword as a phrase", () => {
    const l = kw("a", ["sample to condition"]);
    expect(matchStepText("Rebuild the sample-to-condition map", [l])).toHaveLength(1);
    expect(matchStepText("sample and then condition", [l])).toEqual([]);
  });

  it("reports step_keyword as the trigger and the keyword as the match", () => {
    const out = matchStepText("normalize the counts", [kw("a", ["normalize"])]);
    expect(out[0]).toMatchObject({ trigger: "step_keyword", matched: "normalize" });
  });

  it("never matches a graduated lesson, and ignores empty or tiny keywords", () => {
    expect(matchStepText("normalize", [kw("a", ["normalize"], { graduated_to: ["#1"] })])).toEqual(
      [],
    );
    expect(matchStepText("do a thing", [kw("a", ["a", "", "  "])])).toEqual([]);
  });

  it("returns [] for empty step text", () => {
    expect(matchStepText("   ", [kw("a", ["normalize"])])).toEqual([]);
  });

  it("ranks user-local ahead of package on the equal trigger, then by id", () => {
    const out = matchStepText("normalize the counts", [
      kw("b/pkg", ["normalize"]),
      kw("a/pkg", ["normalize"]),
      kw("z/mine", ["normalize"], { origin: "user" }),
    ]);
    expect(out.map((m) => m.lesson.id)).toEqual(["z/mine", "a/pkg", "b/pkg"]);
  });
});
