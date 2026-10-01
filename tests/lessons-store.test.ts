import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadPackageLessons,
  packageSnapshotPath,
  snapshotEntryToLesson,
} from "../extensions/loom/lessons/store";

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
