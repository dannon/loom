import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildStepLessonNote, decideHintForEvent } from "../extensions/loom/lesson-hint";
import { renderReproductionIndex } from "../extensions/loom/lessons/reproduction-index";
import { registerLessonsSearchTool } from "../extensions/loom/lessons/search-tool";
import { getLessonStore, resetLessonStore } from "../extensions/loom/lessons/store";
import { resetActivity } from "../extensions/loom/activity";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lessonFile } from "./lessons-fixture";

// Not key-shaped on purpose: a custom endpoint's key can look like anything,
// so the only thing that catches it is knowing the value.
const CONFIG_KEY = "LessonCfgKey7Value9";
const ENV_KEY = "LessonEnvKey3Value1";
const ID = "reproduction/metadata-quotes-a-key";

const LESSON = lessonFile({
  title: `Deposited metadata disagrees with the paper ${CONFIG_KEY}`,
  trigger: {
    signatures: '["condition column is empty for every sample"]',
    step_keywords: '["reconcile", "metadata"]',
  },
  body: [
    "",
    "## Symptom",
    "",
    "The condition column is blank.",
    "",
    "## Check first",
    "",
    `Compare the sample sheet against ${CONFIG_KEY} and ${ENV_KEY} before doing anything.`,
    "",
    "## Intervention",
    "",
    `Ask the user, quoting ${ENV_KEY}. Then rebuild the sheet.`,
    "",
    "## Validate",
    "",
    "Every sample has a condition.",
    "",
    "## Does NOT apply when",
    "",
    "The paper deposits no metadata at all.",
    "",
  ].join("\n"),
});

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  resetState();
  resetActivity();
  resetLessonStore();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lesson-redact-"));
  prevHome = process.env.HOME;
  process.env.HOME = path.join(dir, "home");
  const stateDir = path.join(dir, "home", ".loom");
  fs.mkdirSync(path.join(stateDir, "lessons", "reproduction"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({
      llm: { active: "anthropic", providers: { anthropic: { apiKey: CONFIG_KEY } } },
    }),
  );
  fs.writeFileSync(
    path.join(stateDir, "lessons", "reproduction", "metadata-quotes-a-key.md"),
    LESSON,
  );
  process.env.ANTHROPIC_API_KEY = ENV_KEY;
  fs.writeFileSync(path.join(dir, "notebook.md"), "# nb\n");
  setNotebookPath(path.join(dir, "notebook.md"));
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  setNotebookPath(null);
  resetState();
  resetLessonStore();
  fs.rmSync(dir, { recursive: true, force: true });
});

function expectScrubbed(out: string): void {
  expect(out).not.toContain(CONFIG_KEY);
  expect(out).not.toContain(ENV_KEY);
  expect(out).toContain("[redacted]");
}

describe("a user-local lesson quoting a key", () => {
  it("is loaded, so the surfaces below really carry it", () => {
    expect(getLessonStore().lessons.map((l) => l.id)).toContain(ID);
  });

  it("is redacted in the inline hint with no redactor registered after it", () => {
    const decision = decideHintForEvent(
      {
        toolName: "bash",
        input: {},
        content: [{ type: "text", text: "condition column is empty for every sample" }],
      },
      new Set(),
    );
    expect(decision).not.toBeNull();
    expectScrubbed(JSON.stringify(decision!.content));
  });

  it("is redacted in the /execute note", () => {
    const note = buildStepLessonNote("Reconcile the metadata against the paper");
    expect(note).toContain(ID);
    expectScrubbed(note);
  });

  it("is redacted in the reproduction index", () => {
    const index = renderReproductionIndex(getLessonStore().lessons);
    expect(index).toContain(ID);
    expectScrubbed(index);
  });

  it("is redacted in the lessons_search result itself, before any tool_result hook", async () => {
    let execute: ((...a: unknown[]) => Promise<{ content: { text: string }[] }>) | undefined;
    registerLessonsSearchTool({
      registerTool: (t: { execute: typeof execute }) => {
        execute = t.execute;
      },
    } as unknown as ExtensionAPI);
    const result = await execute!("call-1", { query: ID }, undefined, undefined, {});
    const out = result.content.map((c) => c.text).join("\n");
    expect(out).toContain(ID);
    expectScrubbed(out);
  });
});
