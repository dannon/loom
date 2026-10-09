import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseUserLesson } from "../extensions/loom/lessons/user-lesson";
import { LESSON_NAMESPACES, parseLesson, validateLessonMarkdown } from "../shared/lesson-rules.js";
import { validateLessonFile } from "../lessons/validate.mjs";
import { LESSON_BODY, lessonFile } from "./lessons-fixture";

/**
 * A refusal, checked by shape and line rather than by message wording: the
 * shared rule module is replaced at merge time and its messages may differ.
 */
function expectRefused(raw: string, line?: number): void {
  const out = parseUserLesson("a/b", raw);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.errors.length).toBeGreaterThan(0);
  for (const e of out.errors) expect(e).toMatch(/^\d+: \S/);
  if (line !== undefined) expect(out.errors.map((e) => Number(e.split(":")[0]))).toContain(line);
}

/** 1-based line of the first line of `raw` containing `needle`. */
const lineOf = (raw: string, needle: string): number =>
  raw.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("parseUserLesson -- the happy path", () => {
  it("builds a Lesson with the id it was given and origin user", () => {
    const out = parseUserLesson(
      "stats/na-coerced-to-zero-in-filters",
      lessonFile({ trigger: { signatures: '["coerced to zero here"]' } }),
    );
    if (!out.ok) throw new Error(out.errors.join("; "));
    expect(out.lesson).toMatchObject({
      id: "stats/na-coerced-to-zero-in-filters",
      title: "A filter reads missing values as zero",
      status: "draft",
      stale_after: "2099-01-01",
      origin: "user",
      trigger: { signatures: ["coerced to zero here"], step_keywords: ["normalize", "filter"] },
    });
    // Empty trigger lists are omitted, not carried as [].
    expect(out.lesson.trigger?.tools).toBeUndefined();
    expect(out.lesson.sections.check_first).toContain("Count the blank cells");
    expect(out.lesson.sections.cause).toContain("coerces before it compares");
  });

  it("treats Cause as optional", () => {
    const body = LESSON_BODY.replace(/## Cause[\s\S]*?(?=## Check first)/, "");
    const out = parseUserLesson("a/b", lessonFile({ body }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.lesson.sections.cause).toBeUndefined();
  });

  it("accepts every lesson in the shipped corpus", () => {
    const root = path.join(__dirname, "..", "lessons");
    for (const ns of LESSON_NAMESPACES) {
      for (const f of fs.readdirSync(path.join(root, ns))) {
        const out = parseUserLesson(`${ns}/${f}`, fs.readFileSync(path.join(root, ns, f), "utf8"));
        expect(out.ok, `${ns}/${f}: ${out.ok ? "" : out.errors.join("; ")}`).toBe(true);
      }
    }
  });
});

describe("parseUserLesson -- refusals", () => {
  it("needs frontmatter, and frontmatter that is a YAML mapping", () => {
    expectRefused(LESSON_BODY);
    expectRefused("---\n: : :\n---\n" + LESSON_BODY);
    expectRefused("---\n- a\n---\n" + LESSON_BODY);
  });

  it("refuses a missing required key, an unknown key, and a bad status", () => {
    expectRefused(lessonFile().replace(/^stale_after:.*\n/m, ""));
    const unknown = lessonFile({ extra: { run_this: "yes" } });
    expectRefused(unknown, lineOf(unknown, "run_this"));
    const status = lessonFile({ status: "retired" });
    expectRefused(status, lineOf(status, "status:"));
  });

  it("refuses a missing required section and an unknown heading", () => {
    expectRefused(lessonFile({ body: "\n## Symptom\n\nonly this one\n" }));
    const extra = lessonFile({ body: LESSON_BODY + "\n## Workaround\n\nnope\n" });
    expectRefused(extra, lineOf(extra, "## Workaround"));
  });

  it("caps a section at 600 chars", () => {
    const ok = LESSON_BODY.replace(
      "A filter silently reads blank cells as zero.",
      "x ".repeat(300),
    );
    expect(parseUserLesson("a/b", lessonFile({ body: ok })).ok).toBe(true);
    const fat = LESSON_BODY.replace(
      "A filter silently reads blank cells as zero.",
      "x ".repeat(301),
    );
    expectRefused(lessonFile({ body: fat }));
  });

  it("refuses fenced code, URLs and markdown links in the body", () => {
    for (const body of [
      LESSON_BODY + "\n```sh\nrm -rf x\n```\n",
      LESSON_BODY.replace("coerces", "see https://example.com"),
      LESSON_BODY.replace("coerces", "see example.com/page"),
      LESSON_BODY.replace("coerces", "[see this](elsewhere)"),
    ]) {
      const raw = lessonFile({ body });
      expectRefused(raw);
    }
  });

  it("refuses identifying data anywhere -- paths, emails, hex ids, IPs", () => {
    const leaks = [
      "read /Users/ada/data/x.tsv first",
      "mail ada@example.org about it",
      "history f2db41e1fa331b3e has it",
      "on 10.1.2.3 it fails",
    ];
    for (const leak of leaks) {
      expectRefused(lessonFile({ body: LESSON_BODY.replace("coerces", leak) }));
      expectRefused(lessonFile({ title: `Title ${leak}` }));
    }
  });

  it("refuses non-ASCII text, raw or YAML-escaped", () => {
    expectRefused(lessonFile({ title: "Smart \u201cquotes\u201d" }));
    expectRefused(lessonFile().replace(/^title:.*$/m, 'title: "right-to-left \\u202e override"'));
  });

  it("refuses YAML aliases and comments", () => {
    expectRefused(lessonFile().replace("tags: [filtering]", "tags: &t [filtering]"));
    expectRefused(lessonFile().replace("tags: [filtering]", "tags: [filtering] # hi"));
  });

  it("refuses an unknown trigger field and an unnormalized or generic signature", () => {
    expectRefused(lessonFile().replace("  signatures: []", "  error_signatures: []"));
    expectRefused(lessonFile({ trigger: { signatures: '["failed"]' } }));
    expectRefused(lessonFile({ trigger: { signatures: '["job 1234567 failed badly"]' } }));
    expect(
      parseUserLesson("a/b", lessonFile({ trigger: { signatures: '["job <n> failed badly"]' } }))
        .ok,
    ).toBe(true);
  });

  it("refuses an oversized file before parsing it", () => {
    expectRefused(lessonFile({ extra: { cues: `"${"x".repeat(17000)}"` } }), 1);
  });
});

describe("shared/lesson-rules.js against the corpus validator", () => {
  // The stand-in carries the corpus validator's rules behind a path-free API.
  // Same input, same verdict, minus the namespace/slug rules a path implies.
  const strip = (lines: string[]) => lines.map((l) => l.replace(/^stats\/x\.md:/, "")).sort();
  const cases: [string, string][] = [
    ["valid", lessonFile()],
    ["no frontmatter", LESSON_BODY],
    ["bad yaml", "---\n: : :\n---\n" + LESSON_BODY],
    ["non-ascii", lessonFile({ title: "café" })],
    ["url in body", lessonFile({ body: LESSON_BODY.replace("coerces", "www.example.org/x") })],
    ["fence", lessonFile({ body: LESSON_BODY + "\n~~~\nx\n~~~\n" })],
    ["html", lessonFile({ body: LESSON_BODY.replace("coerces", "<img src=x>") })],
    ["unknown key", lessonFile({ extra: { nope: "1" } })],
    ["bad trigger", lessonFile({ trigger: { hosts: '["https://x.org/a"]' } })],
    ["link field", lessonFile({ extra: { upstream: '["http://x.org/a?q=1"]' } })],
  ];
  for (const [name, raw] of cases) {
    it(name, () => {
      const verdict = validateLessonMarkdown(raw);
      const errors = verdict.ok ? [] : verdict.errors;
      const lines = (xs: string[]) => [...new Set(xs.map((e) => Number(e.split(":")[0])))].sort();
      expect(verdict.ok).toBe(validateLessonFile("stats/x.md", raw).length === 0);
      expect(lines(errors)).toEqual(lines(strip(validateLessonFile("stats/x.md", raw))));
    });
  }
});

describe("parseLesson", () => {
  it("returns sections by key with their lines, and never throws", () => {
    const parsed = parseLesson(lessonFile());
    expect(parsed.errors).toEqual([]);
    expect(parsed.sections.not_when).toContain("no missing values");
    expect(parsed.lines.check_first).toBeGreaterThan(parsed.lines.symptom);
    expect(parsed.lines.title).toBe(3);
  });

  it("reports a structural failure as frontmatter null plus errors", () => {
    for (const raw of ["", "nope", "---\nunclosed", "---\n[1\n---\n", "x".repeat(20000)]) {
      const parsed = parseLesson(raw);
      expect(parsed.frontmatter, raw.slice(0, 20)).toBeNull();
      expect(parsed.errors.length, raw.slice(0, 20)).toBeGreaterThan(0);
    }
    expect(parseLesson(undefined as unknown as string).errors.length).toBeGreaterThan(0);
  });
});
