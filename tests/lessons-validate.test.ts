/**
 * The lesson schema (contract C3) is enforced by `lessons/validate.mjs` and
 * nothing else, so these tests are the schema's specification.
 *
 * Every case is the one known-good lesson below with exactly one thing changed.
 * That way a case reads as the violation it is testing, and a rule change
 * touches one place instead of thirty near-identical fixture files.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, normalizeSignature, validateLessonsDir } from "../lessons/validate.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORPUS = join(REPO_ROOT, "lessons");
const SCRIPT = join(CORPUS, "validate.mjs");

const GOOD = `---
type: Lesson
title: A good lesson about a thing that goes quietly wrong
description: One line saying what the situation is and why it is worth a lesson.
tags: [example]
status: draft
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2099-01-01"
sources:
  - { id: "loom#1" }

kind: pitfall
stage: [result-interpretation]
trigger:
  signatures: ["a literal normalized signature"]
  tools: [deseq2]
  mcp_tools: [galaxy_run_tool]
  formats: [tabular]
  hosts: ["zenodo.org"]
  extensions: [".tsv"]
  step_keywords: ["filter"]
cues: "When the thing is being done the way that goes wrong."
applies_to: { versions: "any", tested: "one audited run" }
evidence:
  symptom: verified
  cause: verified
  outcome: validated
  method: "reproduced, then fixed by the intervention"
graduated_to: []
upstream: []
supersedes: []
---

## Symptom

The number is bigger than it should be and nothing errors.

## Cause

A coercion turns a missing value into a passing one.

## Check first

Count the missing values and compare that count against the excess.

## Intervention

Exclude the missing values explicitly before comparing.

## Validate

The count equals the rows that pass among the non-missing ones. State both.

## Does NOT apply when

There are no missing values in that column.
`;

let temps: string[] = [];
afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-lessons-"));
  temps.push(dir);
  return dir;
}

/** Write one lesson into a throwaway corpus and return its violations. */
function check(text: string, rel = "stats/a-good-lesson.md"): string[] {
  const dir = tempDir();
  mkdirSync(join(dir, dirname(rel)), { recursive: true });
  writeFileSync(join(dir, rel), text, "utf8");
  return validateLessonsDir(dir);
}

/** The template with one substring swapped. Throws if the anchor moved. */
function swap(from: string, to: string): string {
  if (!GOOD.includes(from))
    throw new Error(`the template no longer contains ${JSON.stringify(from)}`);
  return GOOD.replace(from, to);
}

describe("a valid lesson", () => {
  it("passes with nothing to say", () => {
    expect(check(GOOD)).toEqual([]);
  });

  it("reports violations as path:line: message", () => {
    const violations = check(swap("status: draft", "status: reviewed"));
    expect(violations[0]).toMatch(/^stats\/a-good-lesson\.md:\d+: /);
  });
});

describe("the file's place in the tree", () => {
  it("rejects a namespace that is not one of the five", () => {
    expect(check(GOOD, "nope/a-good-lesson.md").join("\n")).toMatch(
      /nope:1: unknown namespace directory/,
    );
  });

  it("rejects a slug that is not lowercase-hyphenated", () => {
    expect(check(GOOD, "stats/Bad_Slug.md").join("\n")).toMatch(
      /slug must be lowercase words joined by hyphens/,
    );
  });

  it("rejects a lesson nested deeper than one level", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "stats", "deeper"), { recursive: true });
    writeFileSync(join(dir, "stats", "deeper", "x.md"), GOOD, "utf8");
    expect(validateLessonsDir(dir).join("\n")).toMatch(/lesson files only, one level deep/);
  });

  it("rejects a stray non-markdown file in a namespace", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "stats"), { recursive: true });
    writeFileSync(join(dir, "stats", "a-good-lesson.md"), GOOD, "utf8");
    writeFileSync(join(dir, "stats", "notes.txt"), "scratch\n", "utf8");
    expect(validateLessonsDir(dir).join("\n")).toMatch(/\.md lesson files only/);
  });

  it("says so when there are no lessons at all", () => {
    expect(validateLessonsDir(tempDir()).join("\n")).toMatch(/no lesson files found/);
  });
});

describe("frontmatter structure", () => {
  it("requires frontmatter", () => {
    expect(check("## Symptom\n\nno frontmatter here\n").join("\n")).toMatch(
      /missing YAML frontmatter/,
    );
  });

  it("reports unparseable YAML without a stack trace", () => {
    expect(check(swap("tags: [example]", "tags: [example")).join("\n")).toMatch(
      /frontmatter is not valid YAML/,
    );
  });

  it("rejects a key the schema does not define", () => {
    expect(check(swap("kind: pitfall", "extra: nope\nkind: pitfall")).join("\n")).toMatch(
      /unknown frontmatter key "extra"/,
    );
  });

  it("names a required key that is missing", () => {
    expect(check(swap("kind: pitfall\n", "")).join("\n")).toMatch(
      /missing required frontmatter key "kind"/,
    );
  });
});

describe("the OKF fields", () => {
  it("requires type: Lesson exactly", () => {
    expect(check(swap("type: Lesson", "type: Note")).join("\n")).toMatch(
      /type must be exactly "Lesson"/,
    );
  });

  it("caps the title", () => {
    const long = swap(
      "title: A good lesson about a thing that goes quietly wrong",
      `title: ${"x".repeat(LIMITS.title + 1)}`,
    );
    expect(check(long).join("\n")).toMatch(/title is 121 chars, max 120/);
  });

  it("keeps the description to one line", () => {
    const folded = swap(
      "description: One line saying what the situation is and why it is worth a lesson.",
      "description: |\n  two\n  lines",
    );
    expect(check(folded).join("\n")).toMatch(/description must be a single line/);
  });

  it("rejects an editorial status that is not draft, stable or deprecated", () => {
    expect(check(swap("status: draft", "status: reviewed")).join("\n")).toMatch(
      /status must be one of draft, stable, deprecated/,
    );
  });

  it("requires generated.by to name an agent or a human", () => {
    expect(
      check(swap('by: "human:loom-maintainers"', 'by: "loom-maintainers"')).join("\n"),
    ).toMatch(/generated\.by must look like/);
  });

  it("requires generated.at to be a date", () => {
    expect(check(swap('at: "2026-09-30"', 'at: "yesterday"')).join("\n")).toMatch(
      /generated\.at must be a YYYY-MM-DD date string/,
    );
  });

  it("requires stale_after to be a real calendar date", () => {
    expect(
      check(swap('stale_after: "2099-01-01"', 'stale_after: "2099-13-01"')).join("\n"),
    ).toMatch(/stale_after must be a YYYY-MM-DD date string/);
  });

  // `verified.by` is the one identity field in the schema, so it is pinned to a
  // maintainer pseudonym rather than left free.
  it("requires verified.by to be a human pseudonym", () => {
    const withVerified = swap(
      "stale_after:",
      'verified:\n  - { by: "alice", at: "2026-09-30" }\nstale_after:',
    );
    expect(check(withVerified).join("\n")).toMatch(/verified\[0\]\.by must look like "human:/);
  });

  it("requires every source to carry an id", () => {
    expect(check(swap('- { id: "loom#1" }', '- { title: "no id" }')).join("\n")).toMatch(
      /sources\[0\]\.id must be a string/,
    );
  });

  it("rejects an unknown key inside a source", () => {
    expect(check(swap('- { id: "loom#1" }', '- { id: "loom#1", url: "x" }')).join("\n")).toMatch(
      /sources\[0\] has unknown key "url"/,
    );
  });
});

describe("the Loom extension fields", () => {
  it("rejects a kind outside the five", () => {
    expect(check(swap("kind: pitfall", "kind: gotcha")).join("\n")).toMatch(
      /kind must be one of pitfall/,
    );
  });

  it("requires at least one stage", () => {
    expect(check(swap("stage: [result-interpretation]", "stage: []")).join("\n")).toMatch(
      /stage must be a non-empty list/,
    );
  });

  it("rejects a stage that is not one of the five", () => {
    expect(check(swap("stage: [result-interpretation]", "stage: [analysis]")).join("\n")).toMatch(
      /stage\[0\] must be one of data-acquisition/,
    );
  });

  it("rejects a repeated stage", () => {
    const doubled = swap(
      "stage: [result-interpretation]",
      "stage: [result-interpretation, result-interpretation]",
    );
    expect(check(doubled).join("\n")).toMatch(/stage lists "result-interpretation" twice/);
  });

  it("requires every trigger list, even an empty one", () => {
    expect(check(swap("  tools: [deseq2]\n", "")).join("\n")).toMatch(/trigger is missing "tools"/);
  });

  it("rejects an invented trigger list", () => {
    expect(check(swap("  tools: [deseq2]", "  tools: [deseq2]\n  cues: [x]")).join("\n")).toMatch(
      /trigger has unknown key "cues"/,
    );
  });

  // A signature stored unnormalized can never match the normalized signature
  // the matcher computes from a tool result, so it is dead weight at best.
  it("rejects a signature that normalization would change", () => {
    const raw = swap(
      'signatures: ["a literal normalized signature"]',
      'signatures: ["failed at https://example.org/x"]',
    );
    expect(check(raw).join("\n")).toMatch(
      /trigger\.signatures\[0\] is not normalized; store "failed at <url>"/,
    );
  });

  it("caps a signature at 200 chars", () => {
    const long = swap(
      'signatures: ["a literal normalized signature"]',
      `signatures: ["${"z".repeat(LIMITS.signature + 1)}"]`,
    );
    expect(check(long).join("\n")).toMatch(/trigger\.signatures\[0\] is 201 chars, max 200/);
  });

  it("requires mcp_tools to be galaxy_* names", () => {
    expect(check(swap("mcp_tools: [galaxy_run_tool]", "mcp_tools: [run_tool]")).join("\n")).toMatch(
      /trigger\.mcp_tools\[0\] must be a galaxy_\* MCP tool name/,
    );
  });

  it("requires hosts to be bare hostnames", () => {
    expect(
      check(swap('hosts: ["zenodo.org"]', 'hosts: ["https://zenodo.org"]')).join("\n"),
    ).toMatch(/trigger\.hosts\[0\] must be a bare hostname/);
  });

  it("requires extensions to carry their dot", () => {
    expect(check(swap('extensions: [".tsv"]', 'extensions: ["tsv"]')).join("\n")).toMatch(
      /trigger\.extensions\[0\] must be a lowercase dotted extension/,
    );
  });

  it("requires step keywords to be lowercase", () => {
    expect(
      check(swap('step_keywords: ["filter"]', 'step_keywords: ["Filter"]')).join("\n"),
    ).toMatch(/trigger\.step_keywords\[0\] must be lowercase words/);
  });

  it("refuses a lesson nothing can ever match", () => {
    const inert = GOOD.replace('signatures: ["a literal normalized signature"]', "signatures: []")
      .replace("tools: [deseq2]", "tools: []")
      .replace("mcp_tools: [galaxy_run_tool]", "mcp_tools: []")
      .replace("formats: [tabular]", "formats: []")
      .replace('hosts: ["zenodo.org"]', "hosts: []")
      .replace('extensions: [".tsv"]', "extensions: []")
      .replace('step_keywords: ["filter"]', "step_keywords: []");
    expect(check(inert).join("\n")).toMatch(/trigger has nothing machine-matchable/);
  });

  it("requires cues to say something", () => {
    const empty = swap('cues: "When the thing is being done the way that goes wrong."', 'cues: ""');
    expect(check(empty).join("\n")).toMatch(/cues is empty/);
  });

  it("requires both applies_to fields", () => {
    const half = swap(
      'applies_to: { versions: "any", tested: "one audited run" }',
      'applies_to: { versions: "any" }',
    );
    expect(check(half).join("\n")).toMatch(/applies_to is missing "tested"/);
  });

  it("rejects an evidence label outside its own vocabulary", () => {
    expect(check(swap("symptom: verified", "symptom: maybe")).join("\n")).toMatch(
      /evidence\.symptom must be one of verified, reported/,
    );
  });

  it("requires supersedes to hold lesson ids", () => {
    expect(check(swap("supersedes: []", 'supersedes: ["not-an-id"]')).join("\n")).toMatch(
      /supersedes\[0\] must be a lesson id/,
    );
  });

  // galaxy-api is the namespace for lessons kept but not surfaced, and
  // `graduated_to` is the field the matcher reads to decide that.
  it("requires a galaxy-api lesson to say where the durable fix lives", () => {
    expect(check(GOOD, "galaxy-api/a-good-lesson.md").join("\n")).toMatch(
      /a galaxy-api lesson must say where the durable fix lives/,
    );
  });
});

describe("the body", () => {
  it("requires every section but Cause", () => {
    const cut = swap(
      "## Validate\n\nThe count equals the rows that pass among the non-missing ones. State both.\n\n",
      "",
    );
    expect(check(cut).join("\n")).toMatch(/missing required section "## Validate"/);
  });

  it("accepts a lesson with no Cause", () => {
    const noCause = swap(
      "## Cause\n\nA coercion turns a missing value into a passing one.\n\n",
      "",
    );
    expect(check(noCause)).toEqual([]);
  });

  it("requires the sections in order", () => {
    const swapped = swap(
      "## Symptom\n\nThe number is bigger than it should be and nothing errors.\n\n## Cause\n\nA coercion turns a missing value into a passing one.",
      "## Cause\n\nA coercion turns a missing value into a passing one.\n\n## Symptom\n\nThe number is bigger than it should be and nothing errors.",
    );
    expect(check(swapped).join("\n")).toMatch(/sections are out of order/);
  });

  it("rejects a repeated section", () => {
    expect(check(`${GOOD}\n## Validate\n\nagain\n`).join("\n")).toMatch(
      /duplicate section "## Validate"/,
    );
  });

  it("rejects a heading that is not one of the six", () => {
    expect(check(`${GOOD}\n## Notes\n\nextra\n`).join("\n")).toMatch(
      /unexpected heading "## Notes"/,
    );
  });

  it("rejects an empty section", () => {
    const hollow = swap(
      "## Intervention\n\nExclude the missing values explicitly before comparing.",
      "## Intervention\n",
    );
    expect(check(hollow).join("\n")).toMatch(/section intervention is empty/);
  });

  it("caps a section at 600 chars", () => {
    const fat = swap(
      "Exclude the missing values explicitly before comparing.",
      "x".repeat(LIMITS.section + 1),
    );
    expect(check(fat).join("\n")).toMatch(/section intervention is 601 chars, max 600/);
  });

  // The three content controls: nothing to run, nothing to follow.
  it("rejects a fenced code block", () => {
    const fenced = swap(
      "Exclude the missing values explicitly before comparing.",
      "```\nawk '$1 != \"NA\"'\n```",
    );
    expect(check(fenced).join("\n")).toMatch(/no fenced code blocks/);
  });

  it("rejects a URL", () => {
    const linked = swap(
      "Exclude the missing values explicitly before comparing.",
      "See https://example.org for the fix.",
    );
    expect(check(linked).join("\n")).toMatch(/no URLs in a lesson body/);
  });

  it("rejects a markdown link", () => {
    const linked = swap(
      "Exclude the missing values explicitly before comparing.",
      "See [the docs](elsewhere).",
    );
    expect(check(linked).join("\n")).toMatch(/no markdown links in a lesson body/);
  });

  it("rejects a non-ASCII character and names its codepoint", () => {
    expect(check(swap("quietly wrong", "quietly \u2014 wrong")).join("\n")).toMatch(
      /non-ASCII character U\+2014/,
    );
  });
});

describe("normalizeSignature", () => {
  // The lesson side of the matcher. Chunk B's observation collector computes
  // the same function over a tool result; if the two disagree, nothing matches.
  it.each([
    ["Error at /Users/someone/data.txt", "Error at <path>"],
    ["Error at C:\\Users\\someone\\data.txt", "Error at <path>"],
    ["Error at ~/work/data.txt", "Error at <path>"],
    ["dataset 0123456789abcdef0 is bad", "dataset <id> is bad"],
    ["job 123456 died", "job <n> died"],
    ["see https://example.org/a?b=1", "see <url>"],
    ["mail someone@example.org", "mail <email>"],
    ["first line\nsecond line", "first line"],
    ["  collapses   whitespace  ", "collapses whitespace"],
    ["must be multiple of 16", "must be multiple of 16"],
    // URL before path, or the path rule leaves an `https:` stub behind.
    ["GET https://host/a/b?x=1 failed", "GET <url> failed"],
    // Path before id: a hex run inside a path goes with the path.
    ["read /tmp/2a56fb8e4c1d9f70/x", "read <path>"],
    // A single slash is prose, not a path.
    ["either and/or both", "either and/or both"],
    ["see /etc for it", "see /etc for it"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeSignature(input)).toBe(expected);
  });

  it("falls back to the unknown literal rather than an empty signature", () => {
    for (const input of [undefined, null, "", "   ", "\n\nsecond line"]) {
      expect(normalizeSignature(input), JSON.stringify(input)).toBe("unknown");
    }
  });

  it("truncates to 200 chars", () => {
    expect(normalizeSignature("z".repeat(500))).toHaveLength(200);
  });

  it("leaves an already-normalized signature alone", () => {
    const sig = "requires a value, but no legal values defined";
    expect(normalizeSignature(normalizeSignature(sig))).toBe(sig);
  });
});

describe("the CLI", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  function corpusWith(text: string): string {
    const dir = tempDir();
    mkdirSync(join(dir, "stats"), { recursive: true });
    writeFileSync(join(dir, "stats", "a-good-lesson.md"), text, "utf8");
    return dir;
  }

  it("exits 0 and counts the lessons when the corpus is clean", () => {
    const result = run(corpusWith(GOOD));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 lesson(s)");
  });

  it("exits 1 and prints every violation when it is not", () => {
    const result = run(corpusWith(swap("type: Lesson", "type: Note")));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lessons/validate: FAILED");
    expect(result.stderr).toMatch(/stats\/a-good-lesson\.md:\d+: type must be exactly "Lesson"/);
  });

  it("exits 2 on bad arguments", () => {
    expect(run("one", "two").status).toBe(2);
  });
});
