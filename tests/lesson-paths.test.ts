import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  draftFilePath,
  draftsDir,
  lessonFilePath,
  lessonsDir,
  listDrafts,
  listLocalLessons,
  parseLessonId,
  readLessonFile,
  writeNoClobber,
  writeOverwrite,
} from "../extensions/loom/lessons/paths";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lesson-paths-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("path resolution", () => {
  it("puts lessons under the state directory", () => {
    expect(lessonsDir()).toBe(path.join(tmp, ".loom", "lessons"));
    expect(lessonFilePath("stats", "na-is-zero")).toBe(
      path.join(tmp, ".loom", "lessons", "stats", "na-is-zero.md"),
    );
  });

  it("keeps staged drafts out of the lessons tree entirely", () => {
    expect(draftsDir()).toBe(path.join(tmp, ".loom", "lesson-drafts"));
    expect(draftsDir().startsWith(lessonsDir())).toBe(false);
    expect(draftFilePath("stats", "na-is-zero")).toBe(
      path.join(tmp, ".loom", "lesson-drafts", "stats__na-is-zero.md"),
    );
  });

  it("throws rather than building a path from an invalid namespace or slug", () => {
    for (const [ns, slug] of [
      ["../etc", "x"],
      ["stats", "../../etc/passwd"],
      ["stats", "with/slash"],
      ["stats", "with\\backslash"],
      ["unknown", "x"],
      ["stats", "Upper"],
      ["stats", ""],
    ] as [string, string][]) {
      expect(() => lessonFilePath(ns, slug)).toThrow(/namespace|slug/i);
      expect(() => draftFilePath(ns, slug)).toThrow(/namespace|slug/i);
    }
  });

  it("parses a lesson id or returns null", () => {
    expect(parseLessonId(" stats/na-is-zero ")).toEqual({ namespace: "stats", slug: "na-is-zero" });
    for (const bad of ["", "stats", "stats/", "/x", "a/b/c", "../x", "stats/Upper", undefined, 7]) {
      expect(parseLessonId(bad), String(bad)).toBeNull();
    }
  });
});

describe("listing", () => {
  function plant(rel: string, text = "---\ntype: Lesson\n---\n## Symptom\nx\n") {
    const target = path.join(lessonsDir(), rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }

  it("returns nothing when the directory does not exist", () => {
    expect(listLocalLessons()).toEqual([]);
    expect(listDrafts()).toEqual([]);
  });

  it("lists namespaced lessons, sorted by id", () => {
    plant("stats/zeta.md");
    plant("stats/alpha.md");
    plant("data/beta.md");
    expect(listLocalLessons().map((l) => l.id)).toEqual(["data/beta", "stats/alpha", "stats/zeta"]);
  });

  it("skips anything that is not a slug-named .md file inside a known namespace", () => {
    plant("stats/alpha.md");
    plant("stats/NOTES.txt");
    plant("stats/Bad Name.md");
    plant("stats/sub/deep.md");
    plant("whatever/x.md");
    plant("top-level.md");
    fs.symlinkSync(
      path.join(lessonsDir(), "stats", "alpha.md"),
      path.join(lessonsDir(), "stats", "linked.md"),
    );
    expect(listLocalLessons().map((l) => l.id)).toEqual(["stats/alpha"]);
  });

  it("lists staged drafts with their reconstructed ids", () => {
    fs.mkdirSync(draftsDir(), { recursive: true });
    for (const name of [
      "stats__na-is-zero.md",
      "junk.md",
      "stats__a__b.md",
      "galaxy-api__x.md",
      "nope__x.md",
      "stats__x.txt",
    ]) {
      fs.writeFileSync(path.join(draftsDir(), name), "draft");
    }
    expect(listDrafts().map((d) => d.id)).toEqual(["galaxy-api/x", "stats/na-is-zero"]);
  });
});

describe("reading", () => {
  function put(text: string) {
    const target = lessonFilePath("stats", "alpha");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  }

  it("reads a lesson file under the byte cap", () => {
    expect(readLessonFile(put("hello"))).toEqual({ ok: true, text: "hello" });
  });

  it("refuses a file over the byte cap instead of loading it", () => {
    const result = readLessonFile(put("x".repeat(17 * 1024)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/too large/i);
  });

  it("refuses to follow a symlink", () => {
    const outside = path.join(tmp, "secret.txt");
    fs.writeFileSync(outside, "not a lesson");
    const target = lessonFilePath("stats", "alpha");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(outside, target);
    expect(readLessonFile(target)).toEqual({ ok: false, detail: "not a regular file" });
  });

  it("reports a missing file without echoing its path", () => {
    const result = readLessonFile(lessonFilePath("stats", "nope"));
    expect(result).toEqual({ ok: false, detail: "no such file" });
  });
});

describe("writing", () => {
  function leftovers(dir: string) {
    return fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
  }

  it("creates the namespace directory and writes the file, leaving no temp file", () => {
    const target = lessonFilePath("stats", "alpha");
    expect(writeNoClobber(target, "content")).toEqual({ ok: true });
    expect(fs.readFileSync(target, "utf-8")).toBe("content");
    expect(leftovers(path.dirname(target))).toEqual([]);
  });

  it("never overwrites an existing lesson", () => {
    const target = lessonFilePath("stats", "alpha");
    writeNoClobber(target, "original");
    expect(writeNoClobber(target, "replacement")).toEqual({ ok: false, reason: "exists" });
    expect(fs.readFileSync(target, "utf-8")).toBe("original");
    expect(leftovers(path.dirname(target))).toEqual([]);
  });

  it("never writes through a symlink planted at the lesson path", () => {
    const outside = path.join(tmp, "victim.txt");
    fs.writeFileSync(outside, "untouched");
    const target = lessonFilePath("stats", "alpha");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(outside, target);
    expect(writeNoClobber(target, "payload")).toEqual({ ok: false, reason: "exists" });
    expect(fs.readFileSync(outside, "utf-8")).toBe("untouched");
  });

  it("reports a write failure instead of throwing", () => {
    // The namespace directory is a regular file, so mkdir fails for real.
    fs.mkdirSync(lessonsDir(), { recursive: true });
    fs.writeFileSync(path.join(lessonsDir(), "stats"), "not a directory");
    const result = writeNoClobber(lessonFilePath("stats", "alpha"), "content");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("error");
  });

  it("lets a draft be replaced, unlike a lesson", () => {
    const target = draftFilePath("stats", "alpha");
    expect(writeOverwrite(target, "first")).toEqual({ ok: true });
    expect(writeOverwrite(target, "second")).toEqual({ ok: true });
    expect(fs.readFileSync(target, "utf-8")).toBe("second");
    expect(leftovers(draftsDir())).toEqual([]);
  });
});

describe("symlinked directories", () => {
  it("refuses to read or write through a symlinked namespace directory", () => {
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "alpha.md"), "planted");
    fs.mkdirSync(lessonsDir(), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(lessonsDir(), "stats"));
    expect(readLessonFile(lessonFilePath("stats", "alpha"))).toEqual({
      ok: false,
      detail: "inside a symlinked directory",
    });
    expect(writeNoClobber(lessonFilePath("stats", "beta"), "x")).toMatchObject({
      ok: false,
      reason: "error",
    });
    expect(fs.existsSync(path.join(elsewhere, "beta.md"))).toBe(false);
  });

  it("refuses to stage a draft through a symlinked drafts directory", () => {
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(path.dirname(draftsDir()), { recursive: true });
    fs.symlinkSync(elsewhere, draftsDir());
    expect(writeOverwrite(draftFilePath("stats", "alpha"), "x").ok).toBe(false);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});
