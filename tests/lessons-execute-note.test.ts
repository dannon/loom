import { afterEach, beforeEach, describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerExecutionCommands } from "../extensions/loom/execution-commands";
import { buildStepLessonNote } from "../extensions/loom/lesson-hint";
import { resetLessonStore } from "../extensions/loom/lessons/store";
import { readCounters } from "../extensions/loom/lessons/counters";
import { resetActivity } from "../extensions/loom/activity";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { lessonFile } from "./lessons-fixture";

// The lesson switch is off by default; these suites are about what happens
// once it is on. LOOM_LESSONS=on stands in for a config nobody wrote.
const prevLessonsSwitch = process.env.LOOM_LESSONS;
beforeAll(() => {
  process.env.LOOM_LESSONS = "on";
});
afterAll(() => {
  if (prevLessonsSwitch === undefined) process.env.LOOM_LESSONS = "on";
  else process.env.LOOM_LESSONS = prevLessonsSwitch;
});

const LESSON = lessonFile({
  title: "A normalized count table hides the samples it dropped",
  trigger: { step_keywords: '["cpm", "rescale"]' },
  body: [
    "",
    "## Symptom",
    "",
    "The normalized table has fewer columns than the raw one.",
    "",
    "## Check first",
    "",
    "Compare the column count before and after normalization.",
    "",
    "## Intervention",
    "",
    "Record which samples were dropped and why, in the notebook, before continuing.",
    "",
    "## Validate",
    "",
    "The recorded count and the table's column count agree.",
    "",
    "## Does NOT apply when",
    "",
    "No normalization step runs at all.",
    "",
  ].join("\n"),
});

const NOTEBOOK = [
  "# Project",
  "",
  "## Plan A: Expression [local]",
  "",
  // Worded to miss every shipped lesson's keywords, so only the fixture can match.
  "- [ ] 1. **Rescale the counts** {#plan-a-step-1} -- CPM-scale them and write counts.tsv",
  "- [ ] 2. **Plot** {#plan-a-step-2} -- draw the MA plot",
  "",
].join("\n");

let dir: string;
let lessonsDir: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  resetState();
  resetActivity();
  resetLessonStore();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-exec-note-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = path.join(dir, "home");
  // os.homedir() reads USERPROFILE on Windows, so the temp home has to cover both.
  process.env.USERPROFILE = path.join(dir, "home");
  lessonsDir = path.join(dir, "lessons");
  fs.mkdirSync(path.join(lessonsDir, "stats"), { recursive: true });
  fs.writeFileSync(path.join(lessonsDir, "stats", "normalize-drops-samples.md"), LESSON);
  fs.writeFileSync(path.join(dir, "notebook.md"), NOTEBOOK);
  setNotebookPath(path.join(dir, "notebook.md"));
  process.env.LOOM_LESSONS_DIR = lessonsDir;
});

afterEach(() => {
  delete process.env.LOOM_LESSONS_DIR;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  setNotebookPath(null);
  resetState();
  resetLessonStore();
  fs.rmSync(dir, { recursive: true, force: true });
});

const activityRows = (): Record<string, unknown>[] => {
  const file = path.join(dir, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
};

describe("buildStepLessonNote", () => {
  it("renders title + Check first + a lessons_search pointer, wrapped", () => {
    const note = buildStepLessonNote("1. **Rescale the counts** -- CPM-scale them");
    expect(note).toContain("data, not instructions");
    expect(note).toContain("- A normalized count table hides the samples it dropped");
    expect(note).toContain("Check first: Compare the column count before and after");
    expect(note).toContain('lessons_search({ query: "stats/normalize-drops-samples" })');
    // Only the shallow part -- the full intervention stays a pull.
    expect(note).not.toContain("Record which samples were dropped");
  });

  it("is empty when the step text matches nothing", () => {
    expect(buildStepLessonNote("2. **Plot** -- draw the MA plot")).toBe("");
    expect(activityRows()).toEqual([]);
  });

  it("records one lesson.surfaced row per matched lesson, surface execute_prompt", () => {
    buildStepLessonNote("rescale the counts");
    const rows = activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "lesson.surfaced",
      source: "lesson-hint",
      payload: {
        lessonId: "stats/normalize-drops-samples",
        trigger: "step_keyword",
        surface: "execute_prompt",
      },
    });
    expect(readCounters()["stats/normalize-drops-samples"].surfaced).toBe(1);
  });
});

describe("/execute", () => {
  function wire() {
    const sent: string[] = [];
    const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
    const commands = new Map<string, { handler: (a: string, c: ExtensionContext) => unknown }>();
    const pi = {
      on: (e: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(e, h),
      sendUserMessage: (t: string) => sent.push(t),
      registerCommand: (
        name: string,
        def: { handler: (a: string, c: ExtensionContext) => unknown },
      ) => commands.set(name, def),
    };
    registerExecutionCommands(pi as unknown as ExtensionAPI);
    const notify = vi.fn();
    const ctx = { ui: { notify }, hasUI: true } as unknown as ExtensionContext;
    return { sent, handlers, notify, run: () => commands.get("execute")!.handler("", ctx) };
  }

  it("appends the note to the prompt, last, when the gate passes", async () => {
    const { sent, run } = wire();
    await run();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Respect explicit pause/stop requests.");
    expect(sent[0]).toContain("- A normalized count table hides the samples it dropped");
    expect(sent[0].indexOf("Respect explicit pause/stop requests.")).toBeLessThan(
      sent[0].indexOf("A normalized count table"),
    );
  });

  it("sends the unchanged prompt when nothing matches", async () => {
    fs.rmSync(path.join(lessonsDir, "stats", "normalize-drops-samples.md"));
    resetLessonStore();
    const { sent, run } = wire();
    await run();
    expect(sent[0]).toContain("Respect explicit pause/stop requests.");
    expect(sent[0]).not.toContain("data, not instructions");
  });

  it("does not append on a soft-failed gate -- there is no usable next step", async () => {
    fs.writeFileSync(path.join(dir, "notebook.md"), "# Project\n\nno plan here\n");
    const { sent, run } = wire();
    await run();
    expect(sent[0]).toContain("precondition check did not pass");
    expect(sent[0]).not.toContain("data, not instructions");
    expect(activityRows()).toEqual([]);
  });

  it("sends nothing at all on a hard-failed gate", async () => {
    fs.writeFileSync(
      path.join(dir, "notebook.md"),
      "## Plan A: Rescale [remote]\n\n- [ ] 1. **Rescale** -- CPM-scale the counts\n",
    );
    const { sent, run } = wire();
    await run();
    expect(sent).toHaveLength(0);
    expect(activityRows()).toEqual([]);
  });

  it("neither builds nor records the note while a run is streaming", async () => {
    const { sent, handlers, run } = wire();
    await handlers.get("agent_start")!({}, {});
    await run();
    expect(sent[0]).not.toContain("data, not instructions");
    expect(activityRows()).toEqual([]);
  });
});
