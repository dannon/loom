import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getLessonStore,
  isFresh,
  listUserLessonFiles,
  loadLessonStore,
  loadPackageLessons,
  loadUserLessons,
  packageSnapshotPath,
  resetLessonStore,
  snapshotEntryToLesson,
  userLessonsDir,
} from "../extensions/loom/lessons/store";
import { readCounters } from "../extensions/loom/lessons/counters";
import { lessonFile } from "./lessons-fixture";

const SECTIONS = {
  symptom: "s",
  check_first: "c",
  intervention: "i",
  validate: "v",
  not_when: "n",
};

const entry = (over: Record<string, unknown> = {}) => ({
  id: "stats/na-coerced-to-zero-in-filters",
  title: "A filter reads missing values as zero",
  sections: SECTIONS,
  ...over,
});

const snapshot = (lessons: unknown[]) => ({
  schema: 1,
  built_at: "2026-09-30T00:00:00.000Z",
  source: { repo: "galaxyproject/loom", commit: "deadbeef" },
  licence: "CC-BY-4.0",
  lessons,
});

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lessons-store-"));
  file = path.join(dir, "snapshot.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("packageSnapshotPath", () => {
  it("resolves lessons/snapshot.json at the package root", () => {
    const p = packageSnapshotPath();
    expect(p.replace(/\\/g, "/")).toMatch(/\/lessons\/snapshot\.json$/);
    // The repo checkout has one, so this also proves the three-levels-up walk.
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(path.dirname(p)), "package.json"))).toBe(true);
  });
});

describe("snapshotEntryToLesson", () => {
  it("keeps every field the matcher and the renderers read", () => {
    const lesson = snapshotEntryToLesson(
      entry({
        description: "d",
        tags: ["stats", 7],
        status: "stable",
        stale_after: "2027-01-01",
        kind: "pitfall",
        stage: ["result-interpretation"],
        cues: "a normalizing step",
        graduated_to: ["galaxy-mcp#51"],
        supersedes: ["stats/old"],
        trigger: {
          signatures: ["coerced to zero"],
          tools: ["featurecounts"],
          mcp_tools: ["galaxy_run_tool"],
          formats: ["tabular"],
          hosts: ["ncbi.nlm.nih.gov"],
          extensions: [".gtf"],
          step_keywords: ["normalize"],
        },
        sections: { ...SECTIONS, cause: "why" },
      }),
    );
    expect(lesson).toMatchObject({
      id: "stats/na-coerced-to-zero-in-filters",
      status: "stable",
      stale_after: "2027-01-01",
      graduated_to: ["galaxy-mcp#51"],
      origin: "package",
      trigger: { signatures: ["coerced to zero"], hosts: ["ncbi.nlm.nih.gov"] },
      sections: { cause: "why", not_when: "n" },
    });
    // Non-string array members are dropped rather than carried through.
    expect(lesson?.tags).toEqual(["stats"]);
  });

  it("rejects an entry missing an id, a title, or any required section", () => {
    expect(snapshotEntryToLesson(entry({ id: "" }))).toBeNull();
    expect(snapshotEntryToLesson(entry({ title: 3 }))).toBeNull();
    expect(snapshotEntryToLesson(entry({ sections: { ...SECTIONS, validate: "" } }))).toBeNull();
    expect(snapshotEntryToLesson(entry({ sections: undefined }))).toBeNull();
    expect(snapshotEntryToLesson("nope")).toBeNull();
    expect(snapshotEntryToLesson([entry()])).toBeNull();
  });

  it("drops a status it does not recognise instead of trusting it", () => {
    expect(snapshotEntryToLesson(entry({ status: "retired" }))?.status).toBeUndefined();
  });

  it("treats an array-shaped trigger as no trigger", () => {
    expect(snapshotEntryToLesson(entry({ trigger: ["x"] }))?.trigger?.signatures).toBeUndefined();
  });
});

describe("loadPackageLessons", () => {
  it("reads a well-formed snapshot", () => {
    fs.writeFileSync(file, JSON.stringify(snapshot([entry()])));
    const out = loadPackageLessons(file);
    expect(out.warnings).toEqual([]);
    expect(out.lessons.map((l) => l.id)).toEqual(["stats/na-coerced-to-zero-in-filters"]);
  });

  it("reads the real shipped snapshot without a warning", () => {
    const out = loadPackageLessons();
    expect(out.warnings).toEqual([]);
    expect(out.lessons.length).toBeGreaterThan(0);
  });

  it("fails soft and silently when there is no snapshot at all", () => {
    const out = loadPackageLessons(path.join(dir, "absent.json"));
    expect(out).toEqual({ lessons: [], warnings: [] });
  });

  it("refuses a snapshot whose schema is not 1", () => {
    fs.writeFileSync(file, JSON.stringify({ ...snapshot([entry()]), schema: 2 }));
    const out = loadPackageLessons(file);
    expect(out.lessons).toEqual([]);
    expect(out.warnings[0]).toContain("schema 2");
  });

  it("refuses unparseable JSON and a missing lessons array", () => {
    fs.writeFileSync(file, "{not json");
    expect(loadPackageLessons(file).warnings[0]).toContain("not valid JSON");
    fs.writeFileSync(file, JSON.stringify({ schema: 1 }));
    expect(loadPackageLessons(file).warnings[0]).toContain("no lessons array");
  });

  it("skips a malformed entry but keeps its neighbours", () => {
    fs.writeFileSync(file, JSON.stringify(snapshot([entry(), { id: "x" }])));
    const out = loadPackageLessons(file);
    expect(out.lessons).toHaveLength(1);
    expect(out.warnings[0]).toContain("malformed lesson entry");
  });

  it("refuses a snapshot bigger than the size cap", () => {
    fs.writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
    expect(loadPackageLessons(file).warnings[0]).toContain("larger than");
  });

  it("never puts the snapshot's directory in a warning", () => {
    fs.writeFileSync(file, "{not json");
    expect(loadPackageLessons(file).warnings[0]).not.toContain(dir);
  });
});

const userFile = (title: string, opts: Parameters<typeof lessonFile>[0] = {}) =>
  lessonFile({ title, ...opts });

function plant(root: string, rel: string, contents: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

describe("listUserLessonFiles", () => {
  const rel = (root: string) => (f: string) => path.relative(root, f).replace(/\\/g, "/");

  it("reads only <namespace>/<slug>.md, in id order", () => {
    const root = path.join(dir, "lessons");
    plant(root, "stats/na-coerced.md", "x");
    plant(root, "data/download-is-html.md", "x");
    plant(root, "galaxy-api/run-tool-returns-on-submit.md", "x");
    expect(listUserLessonFiles(root).map(rel(root))).toEqual([
      "data/download-is-html.md",
      "galaxy-api/run-tool-returns-on-submit.md",
      "stats/na-coerced.md",
    ]);
  });

  it("ignores a top-level file, counters.json, and a non-.md file", () => {
    const root = path.join(dir, "lessons");
    plant(root, "stats/keep.md", "x");
    plant(root, "loose.md", "x");
    plant(root, "counters.json", "{}");
    plant(root, "stats/notes.txt", "x");
    expect(listUserLessonFiles(root).map(rel(root))).toEqual(["stats/keep.md"]);
  });

  it("ignores a directory that is not one of the five namespaces", () => {
    const root = path.join(dir, "lessons");
    plant(root, "misc/thing.md", "x");
    plant(root, "Stats/thing.md", "x");
    // A case-insensitive filesystem resolves "stats" to the "Stats" directory;
    // either way, only a real namespace directory is ever read.
    const found = listUserLessonFiles(root).map(rel(root));
    expect(found.every((f) => /^stats\//i.test(f))).toBe(true);
    expect(found.some((f) => f.startsWith("misc/"))).toBe(false);
  });

  it("does not descend past <namespace>/<slug>.md", () => {
    const root = path.join(dir, "lessons");
    plant(root, "stats/deeper/thing.md", "x");
    expect(listUserLessonFiles(root)).toEqual([]);
  });

  it("ignores the lesson-drafts sibling entirely", () => {
    const state = path.join(dir, "state");
    plant(path.join(state, "lessons"), "stats/accepted.md", "x");
    plant(path.join(state, "lesson-drafts"), "stats/not-accepted.md", "x");
    const found = listUserLessonFiles(path.join(state, "lessons"));
    expect(found.map((f) => path.basename(f))).toEqual(["accepted.md"]);
  });

  it("does not follow a symlink into the lessons tree", () => {
    const root = path.join(dir, "lessons");
    const outside = path.join(dir, "outside.md");
    fs.mkdirSync(path.join(root, "stats"), { recursive: true });
    fs.writeFileSync(outside, "x");
    fs.symlinkSync(outside, path.join(root, "stats", "linked.md"));
    expect(listUserLessonFiles(root)).toEqual([]);
  });

  it("does not follow a symlinked namespace directory", () => {
    const root = path.join(dir, "lessons");
    const outsideDir = path.join(dir, "elsewhere");
    plant(outsideDir, "thing.md", "x");
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(root, "stats"));
    expect(listUserLessonFiles(root)).toEqual([]);
  });

  it("returns [] for a dir that does not exist", () => {
    expect(listUserLessonFiles(path.join(dir, "nope"))).toEqual([]);
  });

  it("stops at 200 files", () => {
    const root = path.join(dir, "lessons");
    for (let i = 0; i < 205; i++) plant(root, `stats/l${String(i).padStart(3, "0")}.md`, "x");
    expect(listUserLessonFiles(root)).toHaveLength(200);
  });
});

describe("loadUserLessons", () => {
  it("derives the id from the path and marks the origin", () => {
    const root = path.join(dir, "lessons");
    plant(root, "reproduction/metadata-incomplete.md", userFile("Deposited metadata is partial"));
    const out = loadUserLessons(root);
    expect(out.warnings).toEqual([]);
    expect(out.lessons[0]).toMatchObject({
      id: "reproduction/metadata-incomplete",
      origin: "user",
    });
  });

  it("skips an invalid file with a warning naming the lesson and the rule, not the path", () => {
    const root = path.join(dir, "lessons");
    plant(root, "stats/bad.md", "no frontmatter here");
    const out = loadUserLessons(root);
    expect(out.lessons).toEqual([]);
    expect(out.warnings[0]).toContain("stats/bad");
    expect(out.warnings[0]).toContain("missing YAML frontmatter");
    expect(out.warnings[0]).not.toContain(dir);
  });

  it("does not echo the offending value back into a warning", () => {
    const root = path.join(dir, "lessons");
    plant(
      root,
      "stats/leaky.md",
      userFile("Leaky", { trigger: { hosts: '["SECRET-TOKEN-VALUE.example"]' } }),
    );
    const out = loadUserLessons(root);
    expect(out.lessons).toEqual([]);
    expect(out.warnings.join("\n")).not.toContain("SECRET-TOKEN-VALUE");
  });

  it("skips an oversized file", () => {
    const root = path.join(dir, "lessons");
    plant(root, "stats/fat.md", "x".repeat(64 * 1024 + 1));
    expect(loadUserLessons(root).warnings[0]).toContain("larger than");
  });
});

describe("isFresh", () => {
  const now = new Date("2026-09-30T18:00:00.000Z");
  const base = snapshotEntryToLesson(entry())!;
  it("drops deprecated and past-dated lessons, keeps the rest", () => {
    expect(isFresh({ ...base, status: "deprecated", stale_after: "2027-01-01" }, now)).toBe(false);
    expect(isFresh({ ...base, stale_after: "2026-01-01" }, now)).toBe(false);
    expect(isFresh({ ...base, stale_after: "2026-09-29" }, now)).toBe(false);
    expect(isFresh({ ...base, stale_after: "2027-01-01" }, now)).toBe(true);
  });

  it("keeps a lesson on its stale_after date itself (>= today, UTC)", () => {
    expect(isFresh({ ...base, stale_after: "2026-09-30" }, now)).toBe(true);
  });

  it("treats a missing or malformed stale_after as stale", () => {
    expect(isFresh({ ...base, stale_after: "soon" }, now)).toBe(false);
    expect(isFresh({ ...base, stale_after: undefined }, now)).toBe(false);
  });
});

describe("loadLessonStore", () => {
  const now = new Date("2026-09-30T00:00:00.000Z");
  let root: string;
  const pkgEntry = () => entry({ stale_after: "2027-01-01" });
  beforeEach(() => {
    root = path.join(dir, "lessons");
    fs.mkdirSync(root, { recursive: true });
  });

  it("merges both tiers and sorts by id", () => {
    fs.writeFileSync(file, JSON.stringify(snapshot([pkgEntry()])));
    plant(root, "data/local-thing.md", userFile("A local thing"));
    const store = loadLessonStore({ dir: root, snapshotFile: file, now });
    expect(store.lessons.map((l) => l.id)).toEqual([
      "data/local-thing",
      "stats/na-coerced-to-zero-in-filters",
    ]);
    expect(store.conflicts).toEqual([]);
  });

  it("keeps the curated lesson and logs a conflict when a local file reuses its id", () => {
    fs.writeFileSync(file, JSON.stringify(snapshot([pkgEntry()])));
    plant(root, "stats/na-coerced-to-zero-in-filters.md", userFile("My own version"));
    const store = loadLessonStore({ dir: root, snapshotFile: file, now });
    expect(store.lessons).toHaveLength(1);
    expect(store.lessons[0].title).toBe("A filter reads missing values as zero");
    expect(store.lessons[0].origin).toBe("package");
    expect(store.conflicts[0]).toContain("stats/na-coerced-to-zero-in-filters");
    expect(store.conflicts[0]).toContain("shadows a curated one");
  });

  it("drops suppressed ids from both tiers", () => {
    fs.writeFileSync(file, JSON.stringify(snapshot([pkgEntry()])));
    plant(root, "data/local-thing.md", userFile("A local thing"));
    const store = loadLessonStore({
      dir: root,
      snapshotFile: file,
      now,
      suppress: ["data/local-thing", "stats/na-coerced-to-zero-in-filters"],
    });
    expect(store.lessons).toEqual([]);
  });

  it("drops a deprecated or stale local lesson", () => {
    plant(root, "stats/a.md", userFile("Deprecated", { status: "deprecated" }));
    plant(root, "stats/b.md", userFile("Stale", { staleAfter: "2020-01-01" }));
    plant(root, "stats/c.md", userFile("Current"));
    const store = loadLessonStore({ dir: root, snapshotFile: file, now });
    expect(store.lessons.map((l) => l.id)).toEqual(["stats/c"]);
  });

  it("drops a package lesson that went stale after the snapshot was built", () => {
    fs.writeFileSync(file, JSON.stringify(snapshot([entry({ stale_after: "2026-09-01" })])));
    expect(loadLessonStore({ dir: root, snapshotFile: file, now }).lessons).toEqual([]);
  });

  it("keeps a graduated lesson in the store -- the matcher is what filters it", () => {
    plant(
      root,
      "stats/g.md",
      userFile("Graduated", { extra: { graduated_to: '["galaxy-mcp issue 51"]' } }),
    );
    const store = loadLessonStore({ dir: root, snapshotFile: file, now });
    expect(store.lessons.map((l) => l.id)).toEqual(["stats/g"]);
    expect(store.lessons[0].graduated_to).toEqual(["galaxy-mcp issue 51"]);
  });

  it("ignores a local file outside the five namespaces, so it can never shadow", () => {
    plant(root, "loose.md", userFile("Loose"));
    plant(root, "misc/thing.md", userFile("Misc"));
    const store = loadLessonStore({ dir: root, snapshotFile: file, now });
    expect(store.lessons).toEqual([]);
  });
});

describe("getLessonStore", () => {
  let prevHome: string | undefined;
  let home: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".loom"), { recursive: true });
    process.env.HOME = home;
    resetLessonStore();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    delete process.env.LOOM_LESSONS;
    delete process.env.LOOM_LESSONS_DIR;
    resetLessonStore();
  });

  const config = (obj: unknown) =>
    fs.writeFileSync(path.join(home, ".loom", "config.json"), JSON.stringify(obj));

  it("reads ~/.loom/lessons by default and LOOM_LESSONS_DIR instead when set", () => {
    expect(userLessonsDir()).toBe(path.join(home, ".loom", "lessons"));
    plant(path.join(home, ".loom", "lessons"), "stats/home.md", userFile("From home"));
    plant(path.join(dir, "other"), "stats/other.md", userFile("From override"));
    expect(getLessonStore().lessons.map((l) => l.id)).toContain("stats/home");
    resetLessonStore();
    process.env.LOOM_LESSONS_DIR = path.join(dir, "other");
    const ids = getLessonStore().lessons.map((l) => l.id);
    expect(ids).toContain("stats/other");
    expect(ids).not.toContain("stats/home");
  });

  // Planted rather than read from the shipped snapshot, whose lessons go stale
  // on a calendar date this test should not depend on.
  const plantHome = () =>
    plant(path.join(home, ".loom", "lessons"), "stats/home.md", userFile("From home"));

  it("is empty when LOOM_LESSONS=off or lessons.enabled is false", () => {
    plantHome();
    expect(getLessonStore().lessons.length).toBeGreaterThan(0);
    resetLessonStore();
    process.env.LOOM_LESSONS = "off";
    expect(getLessonStore().lessons).toEqual([]);
    delete process.env.LOOM_LESSONS;
    resetLessonStore();
    config({ lessons: { enabled: false } });
    expect(getLessonStore().lessons).toEqual([]);
  });

  it("applies lessons.suppress and mirrors it into counters.json", () => {
    plantHome();
    config({ lessons: { suppress: ["stats/home"] } });
    expect(getLessonStore().lessons.map((l) => l.id)).not.toContain("stats/home");
    expect(readCounters()["stats/home"]).toMatchObject({ suppressed: true, surfaced: 0 });
  });

  it("memoizes until reset", () => {
    const first = getLessonStore();
    expect(getLessonStore()).toBe(first);
  });
});
