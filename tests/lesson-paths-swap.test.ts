import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

// The swap has to happen inside writeNoClobber, between its checks and the
// link, so the fs that paths.ts imports is wrapped here and armed per test.
// It fires after closeSync: Windows will not rename a directory holding an
// open file.
let onClose: (() => void) | undefined;
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const closeSync = ((fd: number) => {
    real.closeSync(fd);
    const hook = onClose;
    onClose = undefined;
    hook?.();
  }) as typeof real.closeSync;
  return { ...real, default: { ...real, closeSync }, closeSync };
});

const fs = await vi.importActual<typeof import("fs")>("fs");
const { lessonFilePath, lessonsDir, writeNoClobber } =
  await import("../extensions/loom/lessons/paths");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lesson-swap-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmp);
});
afterEach(() => {
  onClose = undefined;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("writeNoClobber against a directory swapped mid-write", () => {
  it("takes the lesson back when it landed outside the lessons tree", () => {
    const statsDir = path.join(lessonsDir(), "stats");
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(statsDir, { recursive: true });
    // After the checks and the temp write, before the link: move the real
    // directory out and leave a link to it in its place.
    onClose = () => {
      fs.renameSync(statsDir, elsewhere);
      fs.symlinkSync(elsewhere, statsDir);
    };
    expect(writeNoClobber(lessonFilePath("stats", "swapped"), "text")).toEqual({
      ok: false,
      reason: "error",
      detail: "symlinked directory",
    });
    expect(onClose).toBeUndefined();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("still writes when nothing moved", () => {
    expect(writeNoClobber(lessonFilePath("stats", "steady"), "text")).toEqual({ ok: true });
    expect(fs.readFileSync(lessonFilePath("stats", "steady"), "utf-8")).toBe("text");
  });
});
