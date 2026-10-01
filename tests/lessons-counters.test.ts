import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  bumpSurfaced,
  countersPath,
  readCounters,
  syncSuppressedFlags,
} from "../extensions/loom/lessons/counters";

let dir: string;
let file: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-counters-"));
  file = path.join(dir, "nested", "counters.json");
  prevHome = process.env.HOME;
  process.env.HOME = path.join(dir, "home");
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  delete process.env.LOOM_LESSONS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("countersPath", () => {
  it("lives under the state dir and ignores LOOM_LESSONS_DIR", () => {
    expect(countersPath()).toBe(path.join(dir, "home", ".loom", "lessons", "counters.json"));
    // This is the install's own tally, not shareable content.
    process.env.LOOM_LESSONS_DIR = path.join(dir, "elsewhere");
    expect(countersPath()).toBe(path.join(dir, "home", ".loom", "lessons", "counters.json"));
  });
});

describe("bumpSurfaced", () => {
  it("creates the file and the directory on the first surfacing, mode 0600", () => {
    bumpSurfaced("stats/a", { file, now: new Date("2026-09-30T12:00:00.000Z") });
    expect(readCounters(file)).toEqual({
      "stats/a": { surfaced: 1, suppressed: false, lastSurfaced: "2026-09-30T12:00:00.000Z" },
    });
    if (process.platform !== "win32") {
      expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    }
  });

  it("writes to the default path under HOME when no file is given", () => {
    bumpSurfaced("stats/a");
    expect(readCounters()["stats/a"].surfaced).toBe(1);
    expect(fs.existsSync(countersPath())).toBe(true);
  });

  it("increments and refreshes lastSurfaced, keeping other ids untouched", () => {
    bumpSurfaced("stats/a", { file, now: new Date("2026-09-30T12:00:00.000Z") });
    bumpSurfaced("data/b", { file, now: new Date("2026-09-30T12:00:00.000Z") });
    bumpSurfaced("stats/a", { file, now: new Date("2026-10-01T09:00:00.000Z") });
    const counters = readCounters(file);
    expect(counters["stats/a"].surfaced).toBe(2);
    expect(counters["stats/a"].lastSurfaced).toBe("2026-10-01T09:00:00.000Z");
    expect(counters["data/b"].surfaced).toBe(1);
  });

  it("preserves an existing suppressed flag", () => {
    syncSuppressedFlags(["stats/a"], { file });
    bumpSurfaced("stats/a", { file });
    expect(readCounters(file)["stats/a"]).toMatchObject({ surfaced: 1, suppressed: true });
  });

  it("never throws when the path is unwritable, and leaves no temp file", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "a file, not a directory");
    expect(() => bumpSurfaced("stats/a", { file: path.join(blocker, "c.json") })).not.toThrow();
    const unrenamable = path.join(dir, "taken");
    fs.mkdirSync(path.join(unrenamable, "counters.json"), { recursive: true });
    expect(() =>
      bumpSurfaced("stats/a", { file: path.join(unrenamable, "counters.json") }),
    ).not.toThrow();
    expect(fs.readdirSync(unrenamable)).toEqual(["counters.json"]);
  });
});

describe("syncSuppressedFlags", () => {
  it("sets the flag for suppressed ids and clears it for the rest", () => {
    bumpSurfaced("stats/a", { file });
    syncSuppressedFlags(["stats/a", "data/new"], { file });
    expect(readCounters(file)["stats/a"].suppressed).toBe(true);
    expect(readCounters(file)["data/new"]).toEqual({
      surfaced: 0,
      suppressed: true,
      lastSurfaced: "",
    });
    syncSuppressedFlags([], { file });
    expect(readCounters(file)["stats/a"].suppressed).toBe(false);
  });

  it("does not touch the file when nothing changed", () => {
    syncSuppressedFlags(["stats/a"], { file });
    const before = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, before.replace("\n}", "\n}\n"));
    syncSuppressedFlags(["stats/a"], { file });
    expect(fs.readFileSync(file, "utf8")).toBe(before.replace("\n}", "\n}\n"));
  });
});

describe("readCounters", () => {
  it("returns {} for a missing, unparseable, or non-object file", () => {
    expect(readCounters(path.join(dir, "absent.json"))).toEqual({});
    fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
    expect(readCounters(path.join(dir, "bad.json"))).toEqual({});
    fs.writeFileSync(path.join(dir, "arr.json"), "[1,2]");
    expect(readCounters(path.join(dir, "arr.json"))).toEqual({});
  });

  it("coerces a hand-edited row back into shape", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ "stats/a": { surfaced: -4, suppressed: "yes", lastSurfaced: 1 } }),
    );
    expect(readCounters(file)["stats/a"]).toEqual({
      surfaced: 0,
      suppressed: false,
      lastSurfaced: "",
    });
  });

  it("keeps a __proto__ key as a plain key", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"__proto__": {"surfaced": 3}}');
    const counters = readCounters(file);
    expect(Object.keys(counters)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).surfaced).toBeUndefined();
  });
});
