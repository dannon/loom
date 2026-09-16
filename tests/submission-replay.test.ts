import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isSubmissionReplayEnabled,
  parseReplayFile,
  registerSubmissionReplay,
  resolveReplayPath,
} from "../extensions/loom/submission-replay";
import { resetSubmissionCapture } from "../extensions/loom/galaxy-submission-capture";
import { findInvocationBlocks } from "../extensions/loom/notebook-writer";
import { resetState, setNotebookPath } from "../extensions/loom/state";

let tmpDir: string;
let nbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-replay-"));
  nbPath = path.join(tmpDir, "notebook.md");
  fs.writeFileSync(nbPath, "# Analysis\n", "utf-8");
  resetState();
  resetSubmissionCapture();
  setNotebookPath(nbPath);
});

afterEach(() => {
  resetState();
  resetSubmissionCapture();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LOOM_SUBMISSION_REPLAY;
});

const INVOCATION = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        data: {
          id: "ff1e2d3c4b5a6978",
          model_class: "WorkflowInvocation",
          workflow_id: "c0ffee1234567890",
          history_id: "0a248a1f62a0cc04",
        },
        success: true,
      }),
    },
  ],
  details: { server: "galaxy" },
};

async function runReplay(): Promise<void> {
  const handlers: ((event: unknown, ctx: unknown) => Promise<unknown>)[] = [];
  registerSubmissionReplay({
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (event === "session_start") handlers.push(handler);
    },
  } as never);
  for (const h of handlers) await h({ type: "session_start" }, {});
}

function activityKinds(): string[] {
  const file = path.join(tmpDir, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).kind as string);
}

describe("submission replay: enablement", () => {
  it("is off unless the env var names something", () => {
    expect(isSubmissionReplayEnabled()).toBe(false);
    process.env.LOOM_SUBMISSION_REPLAY = "   ";
    expect(isSubmissionReplayEnabled()).toBe(false);
    process.env.LOOM_SUBMISSION_REPLAY = "submissions.jsonl";
    expect(isSubmissionReplayEnabled()).toBe(true);
  });
});

describe("submission replay: containment", () => {
  it("resolves a relative path inside the session dir", () => {
    expect(resolveReplayPath("/work/analysis", "submissions.jsonl")).toBe(
      path.resolve("/work/analysis/submissions.jsonl"),
    );
    expect(resolveReplayPath("/work/analysis", "fixtures/s.jsonl")).toBe(
      path.resolve("/work/analysis/fixtures/s.jsonl"),
    );
  });

  it("refuses anything that escapes the session dir", () => {
    // The seam writes blocks claiming server_verified: true, so the env var
    // alone must not be able to aim it at a file elsewhere on the machine.
    expect(resolveReplayPath("/work/analysis", "../secrets.jsonl")).toBeNull();
    expect(resolveReplayPath("/work/analysis", "/etc/passwd")).toBeNull();
    expect(resolveReplayPath("/work/analysis", "../analysis-other/s.jsonl")).toBeNull();
    // The directory itself is not a file inside it.
    expect(resolveReplayPath("/work/analysis", ".")).toBeNull();
  });
});

describe("submission replay: parsing", () => {
  it("skips blank and malformed lines rather than aborting", () => {
    const entries = parseReplayFile(
      ['{"tool":"galaxy_run_tool"}', "", "not json", "{}", '{"tool":"galaxy_upload_file"}'].join(
        "\n",
      ),
    );
    expect(entries.map((e) => e.tool)).toEqual(["galaxy_run_tool", "galaxy_upload_file"]);
  });
});

describe("submission replay: driving the hook", () => {
  it("registers a recorded submission and marks the record as replayed", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "submissions.jsonl"),
      JSON.stringify({
        tool: "galaxy_invoke_workflow",
        args: { workflow_id: "c0ffee1234567890" },
        stepAnchor: "plan-a-step-1",
        result: INVOCATION,
      }) + "\n",
      "utf-8",
    );
    process.env.LOOM_SUBMISSION_REPLAY = "submissions.jsonl";

    await runReplay();

    const [block] = findInvocationBlocks(fs.readFileSync(nbPath, "utf-8"));
    expect(block.invocationId).toBe("ff1e2d3c4b5a6978");
    expect(block.notebookAnchor).toBe("plan-a-step-1");

    // A replayed record is never silently indistinguishable from a real one.
    expect(activityKinds()).toContain("submission.replay");
    expect(activityKinds()).toContain("submission.registered");
  });

  it("does nothing at all when the file is outside the session dir", async () => {
    const outside = path.join(os.tmpdir(), `loom-replay-outside-${Date.now()}.jsonl`);
    fs.writeFileSync(
      outside,
      JSON.stringify({ tool: "galaxy_invoke_workflow", result: INVOCATION }) + "\n",
      "utf-8",
    );
    process.env.LOOM_SUBMISSION_REPLAY = path.relative(tmpDir, outside);

    await runReplay();

    expect(findInvocationBlocks(fs.readFileSync(nbPath, "utf-8"))).toHaveLength(0);
    expect(activityKinds()).not.toContain("submission.replay");
    fs.rmSync(outside, { force: true });
  });

  it("does nothing when the variable is unset", async () => {
    await runReplay();
    expect(activityKinds()).not.toContain("submission.replay");
  });
});
