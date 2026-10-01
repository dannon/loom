import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLessonReplay, replayContent } from "../extensions/loom/lessons/replay";
import { registerLessonHint } from "../extensions/loom/lesson-hint";
import { resetLessonStore } from "../extensions/loom/lessons/store";
import { readCounters } from "../extensions/loom/lessons/counters";
import { resetActivity } from "../extensions/loom/activity";
import { resetState, setNotebookPath } from "../extensions/loom/state";

// The Tier-1 scenario's own fixture, so this and the eval cannot drift apart.
const FIXTURE = path.join(
  __dirname,
  "..",
  "evals",
  "scenarios",
  "lesson-surfaced-on-signature",
  "cwd",
);

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

let dir: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  resetState();
  resetActivity();
  resetLessonStore();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lesson-replay-"));
  cwd = path.join(dir, "cwd");
  copyDir(FIXTURE, cwd);
  setNotebookPath(path.join(cwd, "notebook.md"));
  prevHome = process.env.HOME;
  process.env.HOME = path.join(dir, "home");
  process.env.LOOM_LESSONS_DIR = path.join(cwd, "lessons");
  process.env.LOOM_LESSON_REPLAY = "lesson-events.jsonl";
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  delete process.env.LOOM_LESSONS_DIR;
  delete process.env.LOOM_LESSON_REPLAY;
  setNotebookPath(null);
  resetLessonStore();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startSession(): Promise<string[]> {
  const starts: ((e: unknown, c: unknown) => Promise<unknown>)[] = [];
  const pi = {
    on: (name: string, h: (e: unknown, c: unknown) => Promise<unknown>) => {
      if (name === "session_start") starts.push(h);
    },
  } as unknown as ExtensionAPI;
  registerLessonHint(pi);
  registerLessonReplay(pi);
  const stderr: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    stderr.push(a.join(" "));
  });
  for (const h of starts) await h({}, {});
  return stderr;
}

const rows = (): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(cwd, "activity.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("lesson replay", () => {
  it("surfaces the fixture lesson exactly once across a replayed retry", async () => {
    const stderr = await startSession();
    const all = rows();
    expect(all[0]).toMatchObject({
      kind: "lesson.replay",
      source: "lesson-replay",
      payload: { file: "lesson-events.jsonl", entries: 2 },
    });
    const surfaced = all.filter((r) => r.kind === "lesson.surfaced");
    expect(surfaced).toEqual([
      expect.objectContaining({
        source: "lesson-hint",
        payload: {
          lessonId: "galaxy-tools/reference-index-not-registered",
          trigger: "signature",
          surface: "tool_result",
        },
      }),
    ]);
    expect(readCounters()["galaxy-tools/reference-index-not-registered"].surfaced).toBe(1);
    // The hint the model would have seen, once.
    expect(stderr.join("\n").match(/\[loom lesson\]/g)).toHaveLength(1);
  });

  it("refuses a replay file outside the session directory", async () => {
    const outside = path.join(dir, "elsewhere.jsonl");
    fs.copyFileSync(path.join(cwd, "lesson-events.jsonl"), outside);
    process.env.LOOM_LESSON_REPLAY = "../elsewhere.jsonl";
    await startSession();
    expect(fs.existsSync(path.join(cwd, "activity.jsonl"))).toBe(false);
  });

  it("does nothing without the env var", async () => {
    delete process.env.LOOM_LESSON_REPLAY;
    await startSession();
    expect(fs.existsSync(path.join(cwd, "activity.jsonl"))).toBe(false);
  });

  it("keeps only text blocks from a recorded result", () => {
    expect(
      replayContent({
        tool: "x",
        result: { content: [{ type: "text", text: "a" }, { type: "image" }, null, "junk"] },
      }),
    ).toEqual([{ type: "text", text: "a" }]);
    expect(replayContent({ tool: "x" })).toEqual([]);
  });
});
