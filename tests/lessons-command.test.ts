import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LESSONS_CONFIRM_MESSAGE,
  LESSONS_CONFIRM_TITLE,
  LESSONS_USAGE,
  formatLessonsStatus,
  registerLessonsCommand,
} from "../extensions/loom/lessons-command";
import { getLessonStore, resetLessonStore } from "../extensions/loom/lessons/store";
import { envNames } from "../shared/orbit-env.js";
import { lessonFile } from "./lessons-fixture";

let dir: string;
let home: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "USERPROFILE", "LOOM_LESSONS_DIR", ...envNames("LESSONS")];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lessons-cmd-"));
  home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".loom"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LOOM_LESSONS_DIR = path.join(dir, "lessons");
  for (const name of envNames("LESSONS")) delete process.env[name];
  resetLessonStore();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetLessonStore();
  fs.rmSync(dir, { recursive: true, force: true });
});

const configPath = () => path.join(home, ".loom", "config.json");
const writeConfig = (obj: unknown) => fs.writeFileSync(configPath(), JSON.stringify(obj));
const readConfig = () =>
  fs.existsSync(configPath()) ? JSON.parse(fs.readFileSync(configPath(), "utf-8")) : null;

function harness(opts: { hasUI?: boolean; confirm?: boolean | Error } = {}) {
  const commands = new Map<
    string,
    { handler: (a: string | undefined, c: unknown) => Promise<void> }
  >();
  const notes: { msg: string; level: string }[] = [];
  const confirm = vi.fn(async () => {
    if (opts.confirm instanceof Error) throw opts.confirm;
    return opts.confirm === true;
  });
  registerLessonsCommand({
    registerCommand: (name: string, def: { handler: never }) => commands.set(name, def),
  } as never);
  const ctx = {
    hasUI: opts.hasUI !== false,
    ui: { notify: (msg: string, level = "info") => notes.push({ msg, level }), confirm },
  };
  const run = (args?: string) => commands.get("lessons")!.handler(args, ctx);
  return { run, notes, confirm };
}

describe("formatLessonsStatus", () => {
  it("is two lines, on or off, and names the observations mode when on", () => {
    const off = formatLessonsStatus({ enabled: false, source: "default", observationsMode: "off" });
    expect(off.split("\n")).toHaveLength(2);
    expect(off).toMatch(/^Lessons: off\./);
    expect(off).toContain("/lessons on");
    const on = formatLessonsStatus({ enabled: true, source: "config", observationsMode: "ask" });
    expect(on.split("\n")).toHaveLength(2);
    expect(on).toMatch(/^Lessons: on\./);
    expect(on).toContain("/observations mode (ask)");
    expect(on).toContain("/lessons off");
  });

  it("adds a third line when the env has the last word", () => {
    const text = formatLessonsStatus({ enabled: false, source: "env", observationsMode: "off" });
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("LOOM_LESSONS=off");
    expect(text).toContain("can't be changed from here");
  });
});

describe("/lessons", () => {
  it("bare and `status` both show the two-line status, off by default", async () => {
    const h = harness();
    await h.run();
    await h.run("status");
    expect(h.notes).toHaveLength(2);
    for (const n of h.notes) {
      expect(n.level).toBe("info");
      expect(n.msg).toMatch(/^Lessons: off\./);
      expect(n.msg).toContain("no failure report is collected or sent");
    }
  });

  it("shows on, with the observations mode, once the config says so", async () => {
    writeConfig({ lessons: { enabled: true }, observations: { mode: "ask" } });
    const h = harness();
    await h.run("status");
    expect(h.notes[0].msg).toMatch(/^Lessons: on\./);
    expect(h.notes[0].msg).toContain("(ask)");
  });

  it("rejects an unknown subcommand with the usage", async () => {
    const h = harness();
    await h.run("maybe");
    expect(h.notes[0]).toEqual({
      msg: `Unknown subcommand "maybe".\n${LESSONS_USAGE}`,
      level: "warning",
    });
  });

  it("`on` asks once, in plain words, and writes only on a yes", async () => {
    writeConfig({ testerId: "orbit-007", lessons: { suppress: ["stats/x"] } });
    const h = harness({ confirm: true });
    await h.run("on");
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm).toHaveBeenCalledWith(LESSONS_CONFIRM_TITLE, LESSONS_CONFIRM_MESSAGE);
    expect(LESSONS_CONFIRM_MESSAGE).toContain("You get:");
    expect(LESSONS_CONFIRM_MESSAGE).toContain("You contribute:");
    expect(LESSONS_CONFIRM_MESSAGE).toContain("/lesson");
    expect(LESSONS_CONFIRM_MESSAGE).toContain("/observations mode");
    expect(readConfig()).toMatchObject({
      testerId: "orbit-007",
      lessons: { suppress: ["stats/x"], enabled: true },
    });
    expect(h.notes[0].msg).toMatch(/^Lessons are on\./);
    expect(h.notes[0].msg).toContain("/observations mode ask or auto");
  });

  it("`on` declined leaves the config as it was", async () => {
    const h = harness({ confirm: false });
    await h.run("on");
    expect(readConfig()).toBeNull();
    expect(h.notes[0]).toEqual({ msg: "Left off. Nothing was changed.", level: "info" });
  });

  it("`on` treats a confirm that throws as a no", async () => {
    const h = harness({ confirm: new Error("dialog closed") });
    await h.run("on");
    expect(readConfig()).toBeNull();
    expect(h.notes[0].msg).toBe("Left off. Nothing was changed.");
  });

  it("`on` needs a UI for the confirm", async () => {
    const h = harness({ hasUI: false, confirm: true });
    await h.run("on");
    expect(h.confirm).not.toHaveBeenCalled();
    expect(readConfig()).toBeNull();
    expect(h.notes[0].level).toBe("warning");
    expect(h.notes[0].msg).toContain("interactive mode");
  });

  it("`on` when already on changes nothing and asks nothing", async () => {
    writeConfig({ lessons: { enabled: true } });
    const h = harness({ confirm: true });
    await h.run("on");
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.notes[0]).toEqual({ msg: "Lessons are already on.", level: "info" });
  });

  it("`on` under LOOM_LESSONS=off refuses before asking", async () => {
    process.env.LOOM_LESSONS = "off";
    const h = harness({ confirm: true });
    await h.run("on");
    expect(h.confirm).not.toHaveBeenCalled();
    expect(readConfig()).toBeNull();
    expect(h.notes[0].level).toBe("warning");
    expect(h.notes[0].msg).toContain("hard-disabled");
  });

  it("`on` loads the corpus for this session without a restart", async () => {
    const lessons = path.join(dir, "lessons", "galaxy-tools");
    fs.mkdirSync(lessons, { recursive: true });
    fs.writeFileSync(
      path.join(lessons, "reference-index-not-registered.md"),
      lessonFile({ title: "Reference index not registered for the chosen build" }),
    );
    expect(getLessonStore().lessons).toEqual([]);
    const h = harness({ confirm: true });
    await h.run("on");
    expect(getLessonStore().lessons.map((l) => l.id)).toContain(
      "galaxy-tools/reference-index-not-registered",
    );
  });

  it("`off` writes false straight away and empties the corpus for this session", async () => {
    writeConfig({ lessons: { enabled: true }, testerId: "orbit-007" });
    const h = harness();
    await h.run("off");
    expect(readConfig()).toMatchObject({ lessons: { enabled: false }, testerId: "orbit-007" });
    expect(h.notes[0].msg).toMatch(/^Lessons are off\./);
    expect(getLessonStore().lessons).toEqual([]);
  });

  it("`off` when already off changes nothing", async () => {
    const h = harness();
    await h.run("off");
    expect(readConfig()).toBeNull();
    expect(h.notes[0]).toEqual({ msg: "Lessons are already off.", level: "info" });
  });

  it("says so when the config can't be written, and leaves it alone", async () => {
    fs.writeFileSync(configPath(), "{ not json");
    const h = harness({ confirm: true });
    await h.run("on");
    expect(h.notes[0].level).toBe("error");
    expect(h.notes[0].msg).toContain("couldn't be read");
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("{ not json");
  });
});
