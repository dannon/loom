import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseUserLesson } from "../extensions/loom/lessons/user-lesson";
import { LESSON_NAMESPACES, parseLesson, validateLessonMarkdown } from "../shared/lesson-rules.js";
import { validateLessonFile } from "../lessons/validate.mjs";
import { LESSON_BODY, lessonFile } from "./lessons-fixture";

const errorsFor = (raw: string): string => {
  const out = parseUserLesson("a/b", raw);
  return out.ok ? "" : out.errors.join("\n");
};

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
  it("needs frontmatter", () => {
    expect(errorsFor(LESSON_BODY)).toContain("missing YAML frontmatter");
  });

  it("refuses frontmatter that is not valid YAML or not a mapping", () => {
    expect(errorsFor("---\n: : :\n---\n" + LESSON_BODY)).toMatch(/not valid YAML|mapping/);
    expect(errorsFor("---\n- a\n---\n" + LESSON_BODY)).toContain("must be a YAML mapping");
  });

  it("refuses a missing required key, an unknown key, and a bad status", () => {
    expect(errorsFor(lessonFile().replace(/^stale_after:.*\n/m, ""))).toContain(
      'missing required frontmatter key "stale_after"',
    );
    expect(errorsFor(lessonFile({ extra: { run_this: "yes" } }))).toContain(
      'unknown frontmatter key "run_this"',
    );
    expect(errorsFor(lessonFile({ status: "retired" }))).toContain("status must be one of");
  });

  it("refuses a missing required section and an unknown heading", () => {
    expect(errorsFor(lessonFile({ body: "\n## Symptom\n\nonly this one\n" }))).toContain(
      'missing required section "## Check first"',
    );
    expect(errorsFor(lessonFile({ body: LESSON_BODY + "\n## Workaround\n\nnope\n" }))).toContain(
      "unexpected heading",
    );
  });

  it("caps a section at 600 chars", () => {
    const fat = LESSON_BODY.replace(
      "A filter silently reads blank cells as zero.",
      "x ".repeat(301),
    );
    expect(errorsFor(lessonFile({ body: fat }))).toContain("section symptom is 601 chars, max 600");
  });

  it("refuses fenced code, URLs and markdown links in the body", () => {
    expect(errorsFor(lessonFile({ body: LESSON_BODY + "\n```sh\nrm -rf x\n```\n" }))).toContain(
      "no fenced code blocks",
    );
    expect(
      errorsFor(lessonFile({ body: LESSON_BODY.replace("coerces", "see https://example.com") })),
    ).toContain("no URLs in a lesson body");
    expect(
      errorsFor(lessonFile({ body: LESSON_BODY.replace("coerces", "[see this](elsewhere)") })),
    ).toContain("no markdown links");
  });

  it("refuses identifying data anywhere -- paths, emails, hex ids", () => {
    const leaks = [
      "read /Users/ada/data/x.tsv first",
      "mail ada@example.org about it",
      "history f2db41e1fa331b3e has it",
      "on 10.1.2.3 it fails",
    ];
    for (const leak of leaks) {
      expect(errorsFor(lessonFile({ body: LESSON_BODY.replace("coerces", leak) })), leak).not.toBe(
        "",
      );
      expect(errorsFor(lessonFile({ title: `Title ${leak}` })), leak).not.toBe("");
    }
  });

  it("refuses non-ASCII text, raw or YAML-escaped", () => {
    expect(errorsFor(lessonFile({ title: "Smart “quotes”" }))).toContain("non-ASCII");
    expect(
      errorsFor(lessonFile().replace(/^title:.*$/m, 'title: "right-to-left \\u202e override"')),
    ).toContain("non-ASCII");
  });

  it("refuses YAML aliases and comments", () => {
    expect(errorsFor(lessonFile().replace("tags: [filtering]", "tags: &t [filtering]"))).toContain(
      "anchors, aliases",
    );
    expect(
      errorsFor(lessonFile().replace("tags: [filtering]", "tags: [filtering] # hi")),
    ).toContain("no YAML comments");
  });

  it("refuses an unknown trigger field and an unnormalized or generic signature", () => {
    expect(errorsFor(lessonFile().replace("  signatures: []", "  error_signatures: []"))).toContain(
      'trigger has unknown key "error_signatures"',
    );
    expect(errorsFor(lessonFile({ trigger: { signatures: '["failed"]' } }))).toContain(
      "too generic",
    );
    expect(
      errorsFor(lessonFile({ trigger: { signatures: '["job 1234567 failed badly"]' } })),
    ).toContain("is not normalized");
  });

  it("refuses an oversized file before parsing it", () => {
    expect(errorsFor(lessonFile({ extra: { cues: `"${"x".repeat(17000)}"` } }))).toContain(
      "bytes, max 16384",
    );
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
      expect(errors.sort()).toEqual(strip(validateLessonFile("stats/x.md", raw)));
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
