import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

// The swap has to happen inside writeNoClobber, between its checks and the
// link, so the fs that paths.ts imports is wrapped here and armed per test.
let onWrite: (() => void) | undefined;
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const writeSync = ((...args: unknown[]) => {
    const n = (real.writeSync as (...a: unknown[]) => number)(...args);
    const hook = onWrite;
    onWrite = undefined;
    hook?.();
    return n;
  }) as typeof real.writeSync;
  return { ...real, default: { ...real, writeSync }, writeSync };
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
  onWrite = undefined;
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
    onWrite = () => {
      fs.renameSync(statsDir, elsewhere);
      fs.symlinkSync(elsewhere, statsDir);
    };
    expect(writeNoClobber(lessonFilePath("stats", "swapped"), "text")).toEqual({
      ok: false,
      reason: "error",
      detail: "symlinked directory",
    });
    expect(onWrite).toBeUndefined();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("still writes when nothing moved", () => {
    expect(writeNoClobber(lessonFilePath("stats", "steady"), "text")).toEqual({ ok: true });
    expect(fs.readFileSync(lessonFilePath("stats", "steady"), "utf-8")).toBe("text");
  });
});
