import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import {
  MODEL_SCRIPT_MODEL_ID,
  MODEL_SCRIPT_PROVIDER,
  createScriptedModel,
  isModelScriptEnabled,
  parseModelScript,
  modelScriptRefusal,
  registerModelScript,
  resetModelScriptState,
  turnToMessage,
} from "../extensions/loom/model-script";
import { execFileSync } from "child_process";
import { resetActivity } from "../extensions/loom/activity";
import { resetState, setNotebookPath } from "../extensions/loom/state";

let dir: string;
let cwd: string;

beforeEach(() => {
  resetModelScriptState();
  resetState();
  resetActivity();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-model-script-"));
  cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "notebook.md"), "# nb\n");
  setNotebookPath(path.join(cwd, "notebook.md"));
});

afterEach(() => {
  delete process.env.LOOM_MODEL_SCRIPT;
  delete process.env.ORBIT_MODEL_SCRIPT;
  setNotebookPath(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

interface FakePi {
  pi: ExtensionAPI;
  providers: unknown[];
  models: Model<string>[];
  /** What setModel answers, in order; true once it runs out. */
  answers: boolean[];
  aborts: number;
  start: () => Promise<void>;
  emit: (name: string, event: unknown, ctx?: unknown) => Promise<void>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, ((e: unknown, c: unknown) => Promise<unknown>)[]>();
  const f: FakePi = {
    pi: undefined as unknown as ExtensionAPI,
    providers: [],
    models: [],
    answers: [],
    aborts: 0,
    start: async () => f.emit("session_start", {}),
    emit: async (name, event, ctx = {}) => {
      for (const h of handlers.get(name) ?? []) await h(event, ctx);
    },
  };
  f.pi = {
    on: (name: string, h: (e: unknown, c: unknown) => Promise<unknown>) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
    },
    registerProvider: (p: unknown) => f.providers.push(p),
    setModel: async (m: Model<string>) => {
      const ok = f.answers.length > 0 ? f.answers.shift()! : true;
      if (ok) f.models.push(m);
      return ok;
    },
  } as unknown as ExtensionAPI;
  return f;
}

const rows = (): Record<string, unknown>[] => {
  const file = path.join(cwd, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
};

/** Ask the scripted model for its next turn, the way pi's agent loop does. */
async function nextTurn(
  scripted: ReturnType<typeof createScriptedModel>,
): Promise<{ stopReason: string; content: unknown[] }> {
  const model = scripted.faux.getModel();
  const stream = scripted.faux.provider.streamSimple(
    model,
    { messages: [] } as unknown as TranscriptContext,
    undefined,
  );
  const message = await stream.result();
  return { stopReason: message.stopReason, content: message.content };
}

describe("parseModelScript", () => {
  it("reads tool and text turns in order", () => {
    const parsed = parseModelScript(
      [
        JSON.stringify({ text: "hello" }),
        "",
        JSON.stringify({ tool: "edit", input: { path: "notebook.md", edits: [] } }),
        JSON.stringify({ tool: "bash", input: { command: "ls" }, text: "looking" }),
      ].join("\n"),
    );
    expect(parsed.skipped).toBe(0);
    expect(parsed.turns).toEqual([
      { text: "hello" },
      { tool: "edit", input: { path: "notebook.md", edits: [] }, text: undefined },
      { tool: "bash", input: { command: "ls" }, text: "looking" },
    ]);
  });

  it("defaults a tool call's input to an empty object", () => {
    expect(parseModelScript(JSON.stringify({ tool: "galaxy_invocation_check_all" })).turns).toEqual(
      [{ tool: "galaxy_invocation_check_all", input: {}, text: undefined }],
    );
  });

  it("counts lines that aren't a turn instead of guessing", () => {
    const parsed = parseModelScript(
      [
        "not json",
        "[1,2]",
        '"a string"',
        JSON.stringify({ tool: "edit", input: "notebook.md" }),
        JSON.stringify({ tool: "", text: "empty tool name" }),
        JSON.stringify({ tool: 3 }),
        JSON.stringify({ other: true }),
        JSON.stringify({ text: "kept" }),
      ].join("\n"),
    );
    expect(parsed.turns).toEqual([{ text: "kept" }]);
    expect(parsed.skipped).toBe(7);
  });
});

describe("turnToMessage", () => {
  it("ends a tool turn with toolUse so pi runs the call and asks again", () => {
    const msg = turnToMessage({ tool: "edit", input: { path: "x" }, text: "first" });
    expect(msg.stopReason).toBe("toolUse");
    expect(msg.content).toEqual([
      { type: "text", text: "first" },
      expect.objectContaining({ type: "toolCall", name: "edit", arguments: { path: "x" } }),
    ]);
  });

  it("ends a text turn, and a missing one, with stop", () => {
    expect(turnToMessage({ text: "done" }).stopReason).toBe("stop");
    const empty = turnToMessage(undefined);
    expect(empty.stopReason).toBe("stop");
    expect(empty.content).toEqual([]);
  });
});

describe("createScriptedModel", () => {
  it("answers one turn per call and ends cleanly once the script runs out", async () => {
    const scripted = createScriptedModel();
    scripted.load([{ tool: "bash", input: { command: "ls" } }, { text: "done" }]);
    expect((await nextTurn(scripted)).stopReason).toBe("toolUse");
    expect(await nextTurn(scripted)).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    });
    // Not the faux provider's "No more faux responses queued" error.
    expect(await nextTurn(scripted)).toEqual({ stopReason: "stop", content: [] });
    expect(await nextTurn(scripted)).toEqual({ stopReason: "stop", content: [] });
  });

  it("hands out copies, so a tool that mutates its arguments can't rewrite the script", async () => {
    const turns = [{ tool: "edit", input: { path: "notebook.md" } }];
    const scripted = createScriptedModel();
    scripted.load(turns);
    turns[0].input.path = "elsewhere.md";
    const { content } = await nextTurn(scripted);
    expect(content).toEqual([expect.objectContaining({ arguments: { path: "notebook.md" } })]);
  });
});

describe("registerModelScript", () => {
  it("is off unless the variable is set", () => {
    expect(isModelScriptEnabled()).toBe(false);
    process.env.LOOM_MODEL_SCRIPT = "  ";
    expect(isModelScriptEnabled()).toBe(false);
    process.env.LOOM_MODEL_SCRIPT = "model-script.jsonl";
    expect(isModelScriptEnabled()).toBe(true);
    delete process.env.LOOM_MODEL_SCRIPT;
    process.env.ORBIT_MODEL_SCRIPT = "model-script.jsonl";
    expect(isModelScriptEnabled()).toBe(true);
  });

  it("registers the faux provider and selects its model, with a model.script row first", async () => {
    fs.writeFileSync(
      path.join(cwd, "model-script.jsonl"),
      `${JSON.stringify({ text: "hi" })}\nnot json\n`,
    );
    process.env.LOOM_MODEL_SCRIPT = "model-script.jsonl";
    const f = fakePi();
    registerModelScript(f.pi);
    expect(f.providers).toHaveLength(1);
    expect(f.providers[0]).toMatchObject({ id: MODEL_SCRIPT_PROVIDER });
    await f.start();
    expect(f.models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      `${MODEL_SCRIPT_PROVIDER}/${MODEL_SCRIPT_MODEL_ID}`,
    ]);
    expect(rows()).toEqual([
      expect.objectContaining({
        kind: "model.script",
        source: "model-script",
        payload: {
          file: "model-script.jsonl",
          entries: 1,
          skipped: 1,
          model: `${MODEL_SCRIPT_PROVIDER}/${MODEL_SCRIPT_MODEL_ID}`,
          selected: true,
        },
      }),
    ]);
  });

  it("refuses a script outside the session directory but still never falls through to a real model", async () => {
    fs.writeFileSync(path.join(dir, "elsewhere.jsonl"), JSON.stringify({ text: "hi" }));
    process.env.LOOM_MODEL_SCRIPT = "../elsewhere.jsonl";
    const f = fakePi();
    registerModelScript(f.pi);
    await f.start();
    expect(f.models).toHaveLength(1);
    expect(f.models[0].provider).toBe(MODEL_SCRIPT_PROVIDER);
    const [row] = rows();
    expect(row.payload).toEqual(
      expect.objectContaining({ file: null, entries: 0, rejected: "outside-session-dir" }),
    );
    // The configured spelling of a path outside the session is never logged.
    expect(JSON.stringify(row)).not.toContain("elsewhere");
  });

  it("refuses a symlink inside the session that points outside it", async () => {
    const outside = path.join(dir, "elsewhere.jsonl");
    fs.writeFileSync(outside, JSON.stringify({ text: "hi" }));
    try {
      fs.symlinkSync(outside, path.join(cwd, "model-script.jsonl"));
    } catch {
      return; // no symlink permission (Windows without developer mode)
    }
    process.env.LOOM_MODEL_SCRIPT = "model-script.jsonl";
    const f = fakePi();
    registerModelScript(f.pi);
    await f.start();
    expect(rows()[0].payload).toEqual(
      expect.objectContaining({ entries: 0, rejected: "outside-session-dir" }),
    );
  });

  it("records a missing script as rejected", async () => {
    process.env.LOOM_MODEL_SCRIPT = "nope.jsonl";
    const f = fakePi();
    registerModelScript(f.pi);
    await f.start();
    expect(rows()[0].payload).toEqual(expect.objectContaining({ entries: 0, rejected: "missing" }));
  });

  it("reads the script once per process, even across a fresh extension instance", async () => {
    // pi reruns extension factories on /new, resume and fork; a new instance
    // must not pick up lines an earlier scripted turn wrote into the file.
    const file = path.join(cwd, "model-script.jsonl");
    fs.writeFileSync(file, JSON.stringify({ text: "one" }));
    process.env.LOOM_MODEL_SCRIPT = "model-script.jsonl";
    const first = fakePi();
    registerModelScript(first.pi);
    await first.start();
    fs.writeFileSync(file, JSON.stringify({ tool: "bash", input: { command: "rm -rf x" } }));
    const second = fakePi();
    registerModelScript(second.pi);
    await second.start();
    expect(rows().filter((r) => r.kind === "model.script")).toHaveLength(1);
    // The new instance still selects the scripted model.
    expect(second.models[0].provider).toBe(MODEL_SCRIPT_PROVIDER);
  });

  it("refuses a named pipe instead of waiting on it", async () => {
    if (process.platform === "win32") return;
    execFileSync("mkfifo", [path.join(cwd, "model-script.jsonl")]);
    process.env.LOOM_MODEL_SCRIPT = "model-script.jsonl";
    const f = fakePi();
    registerModelScript(f.pi);
    await f.start(); // would hang here if the pipe were read
    expect(rows()[0].payload).toEqual(
      expect.objectContaining({ entries: 0, rejected: "not-a-file" }),
    );
  });

  it("retries a selection pi refused, and says so when it never takes", async () => {
    fs.writeFileSync(path.join(cwd, "model-script.jsonl"), JSON.stringify({ text: "hi" }));
    process.env.LOOM_MODEL_SCRIPT = "model-script.jsonl";
    const once = fakePi();
    once.answers = [false];
    registerModelScript(once.pi);
    await once.start();
    expect(once.models).toHaveLength(1);
    expect(rows()[0].payload).toEqual(expect.objectContaining({ selected: true }));

    resetModelScriptState();
    fs.rmSync(path.join(cwd, "activity.jsonl"));
    const never = fakePi();
    never.answers = [false, false];
    registerModelScript(never.pi);
    await never.start();
    expect(rows()[0].payload).toEqual(expect.objectContaining({ selected: false }));
  });

  it("moves the session back when something selects another model", async () => {
    fs.writeFileSync(path.join(cwd, "model-script.jsonl"), JSON.stringify({ text: "hi" }));
    process.env.LOOM_MODEL_SCRIPT = "model-script.jsonl";
    const f = fakePi();
    registerModelScript(f.pi);
    await f.start();
    await f.emit("model_select", {
      model: { provider: MODEL_SCRIPT_PROVIDER, id: MODEL_SCRIPT_MODEL_ID },
      source: "set",
    });
    expect(f.models).toHaveLength(1);
    await f.emit("model_select", {
      model: { provider: "anthropic", id: "claude-opus-5-5" },
      source: "set",
    });
    expect(f.models).toHaveLength(2);
    expect(f.models[1].provider).toBe(MODEL_SCRIPT_PROVIDER);
    expect(rows().find((r) => r.kind === "model.script.reselected")?.payload).toEqual({
      from: "anthropic/claude-opus-5-5",
      source: "set",
      selected: true,
    });
  });

  it("aborts any request that reaches a real provider", async () => {
    process.env.LOOM_MODEL_SCRIPT = "model-script.jsonl";
    const f = fakePi();
    registerModelScript(f.pi);
    await f.start();
    let aborted = 0;
    await f.emit(
      "before_provider_request",
      { payload: {} },
      { abort: () => aborted++, model: { provider: "anthropic", id: "claude-opus-5-5" } },
    );
    expect(aborted).toBe(1);
    expect(rows().find((r) => r.kind === "model.script.blocked")?.payload).toEqual({
      model: "anthropic/claude-opus-5-5",
    });
  });

  it("the scripted model itself never reaches that hook", async () => {
    // The backstop above relies on it: the faux provider ignores onPayload.
    const scripted = createScriptedModel();
    scripted.load([{ text: "hi" }]);
    let payloads = 0;
    const stream = scripted.faux.provider.streamSimple(
      scripted.faux.getModel(),
      { messages: [] } as unknown as TranscriptContext,
      {
        onPayload: async (p: unknown) => {
          payloads++;
          return p;
        },
      } as never,
    );
    await stream.result();
    expect(payloads).toBe(0);
  });

  it("refuses tools that call a model directly", () => {
    expect(modelScriptRefusal("team_dispatch")).toBeNull();
    process.env.LOOM_MODEL_SCRIPT = "model-script.jsonl";
    expect(modelScriptRefusal("team_dispatch")).toMatch(/team_dispatch is unavailable/);
  });
});

describe("the extension entry", () => {
  async function load(env: Record<string, string>): Promise<string[]> {
    const registered: string[] = [];
    const noop = () => undefined;
    const pi = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "registerProvider")
            return (p: { id?: string } | string) =>
              registered.push(typeof p === "string" ? p : (p.id ?? "?"));
          if (prop === "getAllTools" || prop === "getActiveTools") return () => [];
          if (prop === "events") return { on: noop, emit: noop };
          return noop;
        },
      },
    );
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const mod = await import("../extensions/loom/index");
      mod.default(pi as never);
    } finally {
      process.env = saved;
    }
    return registered;
  }

  it("registers no scripted provider unless LOOM_MODEL_SCRIPT is set", async () => {
    delete process.env.LOOM_MODEL_SCRIPT;
    delete process.env.ORBIT_MODEL_SCRIPT;
    expect(await load({})).not.toContain(MODEL_SCRIPT_PROVIDER);
    expect(await load({ LOOM_MODEL_SCRIPT: "model-script.jsonl" })).toContain(
      MODEL_SCRIPT_PROVIDER,
    );
  });
});

describe("team_dispatch under the seam", () => {
  it("refuses before resolving or calling any model", async () => {
    let execute: ((...a: unknown[]) => Promise<{ content: { text: string }[] }>) | undefined;
    const pi = {
      registerTool: (def: { name: string; execute: typeof execute }) => {
        if (def.name === "team_dispatch") execute = def.execute;
      },
    } as unknown as ExtensionAPI;
    const { registerTeamTools } = await import("../extensions/loom/teams/tool");
    registerTeamTools(pi);
    process.env.LOOM_MODEL_SCRIPT = "model-script.jsonl";
    const spec = {
      description: "check it",
      model: "anthropic:claude-opus-5-5",
      roles: [
        { name: "a", system_prompt: "p" },
        { name: "b", system_prompt: "c" },
      ],
    };
    // A ctx that throws if the tool tries to look a model up.
    const ctx = new Proxy(
      {},
      {
        get: () => {
          throw new Error("model lookup");
        },
      },
    );
    const result = await execute!("id", spec, undefined, () => undefined, ctx);
    expect(result.content[0].text).toMatch(/unavailable while LOOM_MODEL_SCRIPT is set/);
  });
});
