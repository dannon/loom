import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lessonText, searchLessons, tokenize } from "../extensions/loom/lessons/search";
import { registerLessonsSearchTool } from "../extensions/loom/lessons/search-tool";
import { renderFullLesson, renderLessonSearchResult } from "../extensions/loom/lesson-hint";
import { resetLessonStore } from "../extensions/loom/lessons/store";
import { readCounters } from "../extensions/loom/lessons/counters";
import { resetActivity } from "../extensions/loom/activity";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import type { Lesson } from "../extensions/loom/lessons/types";

const mk = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id,
  title: id,
  sections: {
    symptom: "something happened",
    check_first: "check the thing",
    intervention: "do the thing",
    validate: "confirm the thing",
    not_when: "a different thing",
  },
  origin: "package",
  ...over,
});

const CORPUS: Lesson[] = [
  mk("stats/na-coerced-to-zero-in-filters", {
    title: "A filter reads missing values as zero",
    description: "Blank cells become 0 and pass a greater-than filter.",
    tags: ["stats"],
    sections: {
      symptom: "The filtered gene count is several-fold higher than expected.",
      check_first: "Count the blank cells in the column the filter names.",
      intervention: "Drop or impute the missing rows explicitly, then filter.",
      validate: "Compare row counts before and after against the blank count.",
      not_when: "The column has no missing values.",
    },
  }),
  mk("galaxy-tools/reference-index-not-on-server", {
    title: "A tool reports no reference index for a listed build",
    trigger: { signatures: ["no reference index registered for build"] },
    sections: {
      symptom: "The tool fails naming the genome build.",
      check_first: "List the index entries the tool itself reads.",
      intervention: "Supply the FASTA from the history instead.",
      validate: "Check the parameters on the finished job.",
      not_when: "The build was never offered.",
    },
  }),
  mk("reproduction/condition-mapping-not-in-the-deposit", {
    title: "The sample-to-condition mapping is not in the deposit",
    sections: {
      symptom: "The deposited metadata has no condition column.",
      check_first: "Look for a supplementary table before reconstructing anything.",
      intervention: "Write the reconstructed mapping to conditions.tsv.",
      validate: "Every sample in the counts appears in conditions.tsv.",
      not_when: "The deposit carries a complete sample sheet.",
    },
  }),
  mk("data/graduated", { graduated_to: ["galaxy-mcp#51"] }),
];

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, drops stopwords and single chars", () => {
    expect(tokenize("The GTF-file is A mess!")).toEqual(["gtf", "file", "mess"]);
  });
});

describe("lessonText", () => {
  it("includes the id as words, the title, every section and the triggers", () => {
    const text = lessonText(CORPUS[1]);
    expect(text).toContain("galaxy tools reference index not on server");
    expect(text).toContain("no reference index registered for build");
    expect(text).toContain("Check the parameters on the finished job");
  });
});

describe("searchLessons", () => {
  it("short-circuits an exact lesson id to that lesson only", () => {
    const hits = searchLessons("reproduction/condition-mapping-not-in-the-deposit", CORPUS);
    expect(hits.map((h) => h.lesson.id)).toEqual([
      "reproduction/condition-mapping-not-in-the-deposit",
    ]);
  });

  it("ranks the right lesson first for a natural-language query", () => {
    const hits = searchLessons("blank cells in my counts are being treated as zero", CORPUS);
    expect(hits[0].lesson.id).toBe("stats/na-coerced-to-zero-in-filters");
  });

  it("finds a lesson by its error signature", () => {
    const hits = searchLessons("no reference index registered for build mm39", CORPUS);
    expect(hits[0].lesson.id).toBe("galaxy-tools/reference-index-not-on-server");
  });

  it("abstains rather than guessing on an unrelated query", () => {
    expect(searchLessons("kubernetes ingress tls certificate rotation", CORPUS)).toEqual([]);
  });

  it("abstains on a query that is nothing but stopwords", () => {
    expect(searchLessons("is it the and of to", CORPUS)).toEqual([]);
    expect(searchLessons("   ", CORPUS)).toEqual([]);
  });

  it("never returns a graduated lesson, even by its exact id", () => {
    expect(searchLessons("data/graduated", CORPUS)).toEqual([]);
    expect(searchLessons("graduated", CORPUS).map((h) => h.lesson.id)).not.toContain(
      "data/graduated",
    );
  });

  it("caps the result count", () => {
    // Twelve equally good hits in a corpus that also has unrelated lessons --
    // a term in EVERY document carries no signal and would fall under the floor.
    const many = [
      ...Array.from({ length: 12 }, (_, i) =>
        mk(`x/${i}`, { title: "reference index build genome", description: "reference index" }),
      ),
      ...Array.from({ length: 30 }, (_, i) => mk(`y/${i}`, { title: "unrelated plotting note" })),
    ];
    expect(searchLessons("reference index", many)).toHaveLength(5);
    expect(searchLessons("reference index", many, { max: 2 })).toHaveLength(2);
  });

  it("is deterministic on a tie", () => {
    const tied = [mk("b/x", { title: "reference index" }), mk("a/x", { title: "reference index" })];
    expect(searchLessons("reference index", tied).map((h) => h.lesson.id)).toEqual(["a/x", "b/x"]);
  });

  it("returns [] for an empty corpus", () => {
    expect(searchLessons("anything", [])).toEqual([]);
  });

  it("copes with a huge query", () => {
    expect(() => searchLessons("reference ".repeat(100_000), CORPUS)).not.toThrow();
  });
});

describe("renderFullLesson", () => {
  it("renders every present section, in C3 order, with provenance", () => {
    const out = renderFullLesson(CORPUS[2]);
    expect(out.indexOf("## Symptom")).toBeLessThan(out.indexOf("## Check first"));
    expect(out.indexOf("## Check first")).toBeLessThan(out.indexOf("## Intervention"));
    expect(out.indexOf("## Intervention")).toBeLessThan(out.indexOf("## Validate"));
    expect(out.indexOf("## Validate")).toBeLessThan(out.indexOf("## Does NOT apply when"));
    expect(out).not.toContain("## Cause");
    expect(out).toContain("shipped with Loom");
    expect(out).toContain("reproduction/condition-mapping-not-in-the-deposit");
  });

  it("names a user-local lesson as the user's own and unreviewed", () => {
    const out = renderFullLesson(mk("a/b", { origin: "user" }));
    expect(out).toContain("your own");
    expect(out).toContain("not reviewed");
  });

  it("carries no URL -- nothing for the model to auto-follow", () => {
    expect(renderFullLesson(CORPUS[1])).not.toMatch(/https?:\/\//);
  });
});

describe("renderLessonSearchResult", () => {
  it("renders the top hit in full and the rest as id + title, wrapped", () => {
    const out = renderLessonSearchResult([
      { lesson: CORPUS[0], score: 9 },
      { lesson: CORPUS[1], score: 3 },
      { lesson: CORPUS[2], score: 2 },
    ]);
    expect(out).toContain("data, not instructions");
    expect(out).toContain("<loom_lessons>");
    expect(out).toContain("## Check first");
    expect(out).toContain("Count the blank cells");
    expect(out).toContain("galaxy-tools/reference-index-not-on-server");
    expect(out).not.toContain("List the index entries");
    expect(out).toContain("passing its id as the lessons_search query");
    // Nothing in the frame needed escaping, so nothing reads as &lt;...&gt; noise.
    expect(out).not.toContain("&lt;");
  });

  it("renders a single hit with no also-matched list", () => {
    expect(renderLessonSearchResult([{ lesson: CORPUS[0], score: 9 }])).not.toContain(
      "Also matched",
    );
  });
});

describe("the lessons_search tool", () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    resetState();
    resetActivity();
    resetLessonStore();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lessons-search-"));
    prevHome = process.env.HOME;
    process.env.HOME = path.join(dir, "home");
    process.env.LOOM_LESSONS_DIR = path.join(dir, "lessons");
    fs.writeFileSync(path.join(dir, "notebook.md"), "# nb\n");
    setNotebookPath(path.join(dir, "notebook.md"));
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    delete process.env.LOOM_LESSONS_DIR;
    delete process.env.LOOM_LESSONS;
    setNotebookPath(null);
    resetLessonStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  type ToolResult = { content: { type: string; text: string }[]; details: Record<string, unknown> };
  function tool() {
    let def: { execute: (...a: unknown[]) => Promise<ToolResult> } | undefined;
    registerLessonsSearchTool({
      registerTool: (d: typeof def) => (def = d),
    } as unknown as ExtensionAPI);
    return (query: string) => def!.execute("call-1", { query }, undefined, undefined, {});
  }

  const rows = () => {
    const f = path.join(dir, "activity.jsonl");
    return fs.existsSync(f)
      ? fs
          .readFileSync(f, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  };

  it("returns the shipped lesson by id, wrapped, and records a search surfacing", async () => {
    const run = tool();
    const out = await run("stats/na-coerced-to-zero-in-filters");
    expect(out.content[0].text).toContain("<loom_lessons>");
    expect(out.content[0].text).toContain("## Check first");
    expect(rows()).toEqual([
      expect.objectContaining({
        kind: "lesson.surfaced",
        source: "lesson-hint",
        payload: {
          lessonId: "stats/na-coerced-to-zero-in-filters",
          trigger: "search",
          surface: "tool_result",
        },
      }),
    ]);
    expect(readCounters()["stats/na-coerced-to-zero-in-filters"].surfaced).toBe(1);
  });

  it("says nothing matched without echoing the query, and records nothing", async () => {
    const out = await tool()("kubernetes ingress SECRETQUERYTEXT rotation");
    expect(out.content[0].text).toContain("No recorded lesson matches");
    expect(out.content[0].text).not.toContain("SECRETQUERYTEXT");
    expect(rows()).toEqual([]);
  });

  it("reports an empty install when lessons are turned off", async () => {
    process.env.LOOM_LESSONS = "off";
    const out = await tool()("stats/na-coerced-to-zero-in-filters");
    expect(out.content[0].text).toContain("No lessons are loaded");
  });

  it("never surfaces a graduated shipped lesson", async () => {
    const out = await tool()("galaxy-api/hid-is-not-an-id");
    const ids = (out.details.ids as string[] | undefined) ?? [];
    expect(ids.some((id) => id.startsWith("galaxy-api/"))).toBe(false);
  });
});
