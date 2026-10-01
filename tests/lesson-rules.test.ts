/**
 * The brain-facing surface of shared/lesson-rules.js. The rules themselves are
 * pinned by tests/lessons-validate.test.ts against the corpus form; what this
 * file pins is that the path-less form a proposal goes through judges the same
 * bytes the same way, and that the parser never throws on hostile input.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BODY_SECTIONS,
  LESSON_NAMESPACES,
  MAX_FILE_BYTES,
  PROPOSABLE_NAMESPACES,
  isValidLessonNamespace,
  isValidLessonSlug,
  lessonIdFromPath,
  parseLesson,
  validateLessonFile,
  validateLessonMarkdown,
} from "../shared/lesson-rules.js";
import { collectLessonFiles, parseLesson as corpusParseLesson } from "../lessons/validate.mjs";

const CORPUS = fileURLToPath(new URL("../lessons", import.meta.url));
const REL = "stats/na-coerced-to-zero-in-filters.md";
const GOOD = readFileSync(join(CORPUS, REL), "utf8");

function swap(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to);
  if (out === text) throw new Error(`fixture edit did not apply: ${String(from)}`);
  return out;
}

describe("validateLessonMarkdown", () => {
  it("accepts every lesson in the corpus", () => {
    for (const rel of collectLessonFiles(CORPUS)) {
      expect(validateLessonMarkdown(readFileSync(join(CORPUS, rel), "utf8")), rel).toEqual({
        ok: true,
      });
    }
  });

  it("refuses something that is not text", () => {
    expect(validateLessonMarkdown(undefined as unknown as string).ok).toBe(false);
  });

  // Each of these is a rule the corpus form already enforces. The path-less
  // form must reach the same verdict on the same bytes, line for line, or a
  // proposal and the corpus gate are running different schemas.
  const MUTATIONS: [string, (t: string) => string][] = [
    [
      "URL in a section",
      (t) => swap(t, "## Validate\n", "## Validate\nSee https://evil.example/x\n"),
    ],
    [
      "home path in a section",
      (t) => swap(t, "## Validate\n", "## Validate\nRead /Users/alice/x.tsv\n"),
    ],
    [
      "email in the title",
      (t) => swap(t, /^title: .*$/m, "title: mail bob@lab.example.org about it"),
    ],
    ["fenced code", (t) => swap(t, "## Validate\n", "## Validate\n```\nrm -rf x\n```\n")],
    ["markdown link", (t) => swap(t, "## Validate\n", "## Validate\nSee [this](x).\n")],
    ["YAML comment", (t) => swap(t, /^kind: (.*)$/m, "kind: $1 # note")],
    ["YAML alias", (t) => swap(t, /^cues: (.*)$/m, "cues: &c $1\nupstream_copy: *c")],
    ["non-ASCII", (t) => swap(t, "## Validate\n", "## Validate\nA \u2014 dash.\n")],
    ["escaped control char", (t) => swap(t, /^title: .*$/m, 'title: "ok\\u202e reversed"')],
    ["status outside the enum", (t) => swap(t, /^status: .*$/m, "status: trusted")],
    ["missing required section", (t) => swap(t, /## Intervention\n[\s\S]*?(?=## Validate)/, "")],
    ["extra heading", (t) => swap(t, "## Validate\n", "## Validate\n## Policy\n")],
    ["setext rule", (t) => swap(t, "## Validate\n", "## Validate\n---\n")],
    ["oversize file", (t) => t + "x".repeat(MAX_FILE_BYTES)],
    ["no frontmatter", (t) => t.replace(/^---\n/, "")],
  ];

  for (const [name, mutate] of MUTATIONS) {
    it(`rejects ${name}, with the same lines and messages as the corpus form`, () => {
      const bad = mutate(GOOD);
      const result = validateLessonMarkdown(bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      for (const e of result.errors) expect(e).toMatch(/^\d+: \S/);
      const corpus = validateLessonFile(REL, bad).map((e) => e.slice(REL.length + 1));
      expect(result.errors).toEqual(corpus);
    });
  }

  it("leaves namespace, slug and the galaxy-api rule to the corpus form, which has a path", () => {
    // A graduated lesson with its graduated_to emptied is only wrong because of
    // where it lives; with no path there is nothing to judge that by.
    const rel = "galaxy-api/hid-is-not-an-id.md";
    const text = swap(
      readFileSync(join(CORPUS, rel), "utf8"),
      /^graduated_to:[\s\S]*?(?=^upstream:)/m,
      "graduated_to: []\n",
    );
    expect(validateLessonFile(rel, text).join("\n")).toMatch(/graduated_to/);
    expect(validateLessonMarkdown(text)).toEqual({ ok: true });
    expect(validateLessonFile("Stats/x.md", GOOD).join("\n")).toMatch(/namespace/);
  });
});

describe("parseLesson", () => {
  it("returns frontmatter, sections and the line of each", () => {
    const parsed = parseLesson(GOOD);
    expect(parsed.errors).toEqual([]);
    expect(parsed.frontmatter?.type).toBe("Lesson");
    expect(typeof parsed.frontmatter?.stale_after).toBe("string");
    expect(parsed.sections.symptom).toBeTruthy();
    expect(parsed.sections.not_when).toBeTruthy();
    const lines = GOOD.split("\n");
    expect(lines[parsed.lines.title - 1]).toMatch(/^title:/);
    expect(lines[parsed.lines.check_first - 1]).toBe("## Check first");
  });

  it("reads CRLF files the same as LF", () => {
    const parsed = parseLesson(GOOD.replace(/\n/g, "\r\n"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.sections).toEqual(parseLesson(GOOD).sections);
  });

  it("never throws, and reports a structural failure as frontmatter null plus errors", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      "",
      "no frontmatter at all",
      "---\nunterminated: true\n",
      "---\n---\n",
      "---\n- a\n- list\n---\n",
      "---\na: 1\na: 2\n---\n",
      "---\na: &x [1]\nb: *x\n---\n",
      "---\na: !!js/function 'x'\n---\n",
      "---\n# a comment\na: 1\n---\n",
      "---\na: [unclosed\n---\n",
      "---\n" + "a: 1\n".repeat(10) + "x".repeat(MAX_FILE_BYTES) + "\n---\n",
    ];
    for (const input of hostile) {
      let parsed: ReturnType<typeof parseLesson> | undefined;
      expect(() => (parsed = parseLesson(input as string)), JSON.stringify(input)).not.toThrow();
      expect(parsed!.frontmatter, JSON.stringify(input)).toBeNull();
      expect(parsed!.errors.length, JSON.stringify(input)).toBeGreaterThan(0);
      for (const e of parsed!.errors) expect(e).toMatch(/^\d+: \S/);
    }
  });

  it("is what the corpus build reads, and the build's wrapper still throws", () => {
    expect(corpusParseLesson(GOOD).frontmatter).toEqual(parseLesson(GOOD).frontmatter);
    expect(() => corpusParseLesson("no frontmatter")).toThrow(/frontmatter/);
  });
});

describe("ids, namespaces and slugs", () => {
  it("never offers galaxy-api for a new proposal", () => {
    expect(LESSON_NAMESPACES).toContain("galaxy-api");
    expect(PROPOSABLE_NAMESPACES).not.toContain("galaxy-api");
    expect([...PROPOSABLE_NAMESPACES, "galaxy-api"].sort()).toEqual([...LESSON_NAMESPACES].sort());
  });

  it("names the body sections without the heading marker, in C3 order", () => {
    expect(BODY_SECTIONS.map((s) => s.heading)).toEqual([
      "Symptom",
      "Cause",
      "Check first",
      "Intervention",
      "Validate",
      "Does NOT apply when",
    ]);
    expect(BODY_SECTIONS.filter((s) => !s.required).map((s) => s.key)).toEqual(["cause"]);
  });

  it("maps <namespace>/<slug>.md to an id and refuses everything else", () => {
    expect(lessonIdFromPath("stats/na-is-zero.md")).toBe("stats/na-is-zero");
    expect(lessonIdFromPath("stats\\na-is-zero.md")).toBe("stats/na-is-zero");
    for (const bad of [
      "na-is-zero.md",
      "stats/na-is-zero",
      "stats/sub/na-is-zero.md",
      "../stats/x.md",
      "stats/../x.md",
      "unknown/x.md",
      "stats/Upper.md",
      "stats/with space.md",
      "stats__x.md",
      "",
    ]) {
      expect(lessonIdFromPath(bad), bad).toBeNull();
    }
    expect(lessonIdFromPath(undefined as unknown as string)).toBeNull();
  });

  it("checks namespaces and slugs by value", () => {
    expect(isValidLessonNamespace("data")).toBe(true);
    expect(isValidLessonNamespace("Data")).toBe(false);
    expect(isValidLessonNamespace(undefined)).toBe(false);
    expect(isValidLessonSlug("a-b-c")).toBe(true);
    for (const bad of ["", "-a", "a-", "a--b", "A", "a_b", "a/b", "..", "a".repeat(81), 3]) {
      expect(isValidLessonSlug(bad), String(bad)).toBe(false);
    }
  });
});
