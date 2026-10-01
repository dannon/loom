import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  RETRY_LOOP_THRESHOLD,
  OBSERVATIONS_SESSION_CAP,
  newTriggerState,
  decideToolResultObservation,
  factsForToolResult,
  deliverObservation,
} from "../extensions/loom/observation-triggers.js";
import type { DeliverDeps } from "../extensions/loom/observation-triggers.js";
import type { Observation } from "../shared/observation-contract.js";
import type { ObservationFacts } from "../extensions/loom/observations.js";

const KEY = { mcpTool: "galaxy_run_tool", signature: "ToolExecutionError: dataset <id> failed" };

describe("decideToolResultObservation", () => {
  it("reports the first failure as a tool-error", () => {
    const state = newTriggerState();
    expect(decideToolResultObservation(state, KEY)).toEqual({
      kind: "tool-error",
      trigger: "tool_error",
    });
  });

  it("says nothing on the second identical failure", () => {
    const state = newTriggerState();
    decideToolResultObservation(state, KEY);
    expect(decideToolResultObservation(state, KEY)).toBeNull();
  });

  it("upgrades to a retry-loop at the threshold, exactly once", () => {
    const state = newTriggerState();
    expect(decideToolResultObservation(state, KEY)?.kind).toBe("tool-error");
    for (let i = 2; i < RETRY_LOOP_THRESHOLD; i++) {
      expect(decideToolResultObservation(state, KEY), `occurrence ${i}`).toBeNull();
    }
    expect(decideToolResultObservation(state, KEY)).toEqual({
      kind: "retry-loop",
      trigger: "retry_loop",
    });
    expect(decideToolResultObservation(state, KEY)).toBeNull();
    expect(decideToolResultObservation(state, KEY)).toBeNull();
  });

  it("keys on the tool AND the signature, so a different error is its own report", () => {
    const state = newTriggerState();
    decideToolResultObservation(state, KEY);
    expect(decideToolResultObservation(state, { ...KEY, signature: "HTTPError: 400" })?.kind).toBe(
      "tool-error",
    );
    expect(
      decideToolResultObservation(state, { ...KEY, mcpTool: "galaxy_invoke_workflow" })?.kind,
    ).toBe("tool-error");
  });

  it("never reports a signature-only or tool-only match as a loop", () => {
    const state = newTriggerState();
    for (let i = 0; i < 5; i++) {
      decideToolResultObservation(state, { mcpTool: `galaxy_tool_${i}`, signature: KEY.signature });
    }
    for (let i = 0; i < 5; i++) {
      expect(
        decideToolResultObservation(state, { mcpTool: "galaxy_run_tool", signature: `sig ${i}` })
          ?.kind,
      ).toBe("tool-error");
    }
  });

  it("reports nothing for an empty tool or signature", () => {
    const state = newTriggerState();
    expect(decideToolResultObservation(state, { mcpTool: "", signature: "x" })).toBeNull();
    expect(
      decideToolResultObservation(state, { mcpTool: "galaxy_run_tool", signature: "" }),
    ).toBeNull();
  });
});

describe("factsForToolResult", () => {
  it("builds facts from a galaxy tool failure", () => {
    const facts = factsForToolResult(
      "galaxy_run_tool",
      { tool_id: "Filter1", file_type: "tabular" },
      "ToolExecutionError: dataset 2a56fb8e4c1d9f70b3ac55e1d2f80911 failed",
    );
    expect(facts).toEqual({
      kind: "tool-error",
      trigger: "tool_error",
      mcpTool: "galaxy_run_tool",
      toolIds: ["Filter1"],
      datatypes: ["tabular"],
      rawSignature: "ToolExecutionError: dataset 2a56fb8e4c1d9f70b3ac55e1d2f80911 failed",
    });
  });

  it("normalises the mcp proxy call shape to the direct tool name", () => {
    const facts = factsForToolResult(
      "mcp",
      { server: "galaxy", tool: "run_tool", args: { tool_id: "Filter1" } },
      "boom",
    );
    expect(facts?.mcpTool).toBe("galaxy_run_tool");
    expect(facts?.toolIds).toEqual(["Filter1"]);
  });

  it("ignores a non-galaxy tool and an empty result", () => {
    expect(factsForToolResult("bash", { command: "ls" }, "No such file")).toBeNull();
    expect(factsForToolResult("galaxy_run_tool", {}, "")).toBeNull();
    expect(factsForToolResult("galaxy_run_tool", {}, "   ")).toBeNull();
  });
});

const facts: ObservationFacts = {
  kind: "tool-error",
  trigger: "tool_error",
  mcpTool: "galaxy_run_tool",
  toolIds: ["Filter1"],
  datatypes: ["tabular"],
  rawSignature: "ToolExecutionError: dataset 2a56fb8e4c1d9f70b3ac55e1d2f80911 failed",
};

function deps(over: Partial<DeliverDeps> = {}): DeliverDeps & {
  rows: Array<[string, Record<string, unknown>]>;
} {
  const rows: Array<[string, Record<string, unknown>]> = [];
  const base: DeliverDeps = {
    mode: "auto",
    state: newTriggerState(),
    installToken: () => "a".repeat(32),
    describe: async () => "",
    confirm: async () => true,
    submit: async () => ({
      ok: true,
      status: 202,
      id: "x",
      retractToken: "b".repeat(32),
      queueable: false,
    }),
    record: (kind, payload) => rows.push([kind, payload]),
  };
  return { ...base, ...over, rows };
}

const ctx = { hasUI: true } as unknown as ExtensionContext;

describe("deliverObservation", () => {
  // A delivered observation writes the sent log and the retract token under
  // the state dir, so every case runs against a throwaway HOME.
  let tmpHome: string;
  const realHome = process.env.HOME;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-trig-"));
    fs.mkdirSync(path.join(tmpHome, ".loom"), { recursive: true });
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("sends in auto mode and records built + sent", async () => {
    const d = deps();
    expect(await deliverObservation(facts, ctx, d)).toBe("sent");
    const kinds = d.rows.map(([k]) => k);
    expect(kinds).toEqual(["observation.built", "observation.sent"]);
    const built = d.rows[0][1];
    expect(built.signature).toBe("ToolExecutionError: dataset <id> failed");
    expect(built.leakScan).toBe("clean");
    expect(built.valid).toBe(true);
    expect(built.stage).toBe("tool-parameterization");
    expect(built.toolIds).toBe("Filter1");
    expect(d.state.delivered).toBe(1);
  });

  it("collects nothing when the mode is off", async () => {
    const d = deps({
      mode: "off",
      submit: async () => {
        throw new Error("must not send");
      },
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("skipped");
    expect(d.rows).toEqual([["observation.skipped", { reason: "mode-off" }]]);
  });

  it("never sends in ask mode without a UI to confirm with", async () => {
    const d = deps({
      mode: "ask",
      submit: async () => {
        throw new Error("must not send");
      },
    });
    const headless = { hasUI: false } as unknown as ExtensionContext;
    expect(await deliverObservation(facts, headless, d)).toBe("skipped");
    expect(d.rows).toEqual([["observation.skipped", { reason: "no-ui" }]]);
  });

  it("shows the payload and drops it when the user declines", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const d = deps({
      mode: "ask",
      confirm,
      submit: async () => {
        throw new Error("must not send");
      },
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("declined");
    expect(confirm).toHaveBeenCalledOnce();
    expect((confirm.mock.calls[0][0] as Observation).signature).toBe(
      "ToolExecutionError: dataset <id> failed",
    );
    expect(d.rows.map(([k]) => k)).toEqual(["observation.built", "observation.declined"]);
    expect(d.state.delivered).toBe(0);
  });

  it("sends in ask mode once confirmed", async () => {
    const d = deps({ mode: "ask" });
    expect(await deliverObservation(facts, ctx, d)).toBe("sent");
  });

  it("refuses to send a payload the validator rejects", async () => {
    const d = deps({
      describe: async () => "the run for alice@institute.edu failed",
      installToken: () => "NOT-HEX",
      submit: async () => {
        throw new Error("must not send");
      },
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("invalid");
    const invalid = d.rows.find(([k]) => k === "observation.invalid");
    expect(String(invalid?.[1].errors)).toContain("installToken:not-32-hex");
    // Field names only, never the value.
    expect(String(invalid?.[1].errors)).not.toContain("alice");
  });

  it("refuses to send when the whole-payload leak scan is dirty", async () => {
    const d = deps({
      submit: async () => {
        throw new Error("must not send");
      },
    });
    const dirty: ObservationFacts = {
      ...facts,
      toolIds: [],
      datatypes: ["bed"],
      rawSignature: "x",
    };
    // A tool id admitted by shape can still be the thing that trips the scan,
    // so force one past the extractor to prove the gate fires.
    const outcome = await deliverObservation(
      { ...dirty, toolIds: ["/home/alice/tool.xml"] },
      ctx,
      d,
    );
    expect(outcome).toBe("invalid");
    expect(String(d.rows.find(([k]) => k === "observation.invalid")?.[1].leaks)).toContain(
      "tools[0].id:home-path",
    );
  });

  it("queues a queueable failure and records it as queued", async () => {
    const d = deps({
      submit: async () => ({ ok: false, status: 503, error: "unconfigured", queueable: true }),
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("queued");
    expect(d.rows.map(([k]) => k)).toEqual(["observation.built", "observation.queued"]);
    expect(d.state.delivered).toBe(1);
  });

  it("drops a permanent rejection instead of queuing it forever", async () => {
    const d = deps({
      submit: async () => ({
        ok: false,
        status: 400,
        errors: ["signature:bad-length"],
        queueable: false,
      }),
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("invalid");
    expect(d.state.delivered).toBe(0);
  });

  it("stops at the session cap", async () => {
    const d = deps();
    d.state.delivered = OBSERVATIONS_SESSION_CAP;
    expect(await deliverObservation(facts, ctx, d)).toBe("skipped");
    expect(d.rows).toEqual([["observation.skipped", { reason: "session-cap" }]]);
  });

  it("survives a describe that throws, with an empty description", async () => {
    const d = deps({
      describe: async () => {
        throw new Error("model exploded");
      },
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("sent");
    expect(d.rows[0][1].descriptionLength).toBe(0);
  });
});

describe("registerObservationTriggers", () => {
  let tmpHome: string;
  const realHome = process.env.HOME;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-reg-"));
    fs.mkdirSync(path.join(tmpHome, ".loom"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".loom", "config.json"),
      JSON.stringify({ observations: { mode: "ask" } }),
    );
    process.env.HOME = tmpHome;
    delete process.env.ORBIT_OBSERVATIONS;
    delete process.env.LOOM_OBSERVATIONS;
  });
  afterEach(() => {
    process.env.HOME = realHome;
    vi.unstubAllGlobals();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function fakePi() {
    type Handler = (e: unknown, ctx: unknown) => Promise<unknown>;
    const handlers = new Map<string, Handler[]>();
    const api = {
      on: (name: string, fn: Handler) => {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      },
    };
    const emit = async (name: string, event: unknown, ctx: unknown) => {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    };
    return { api, emit };
  }

  const failure = {
    toolName: "galaxy_run_tool",
    input: { tool_id: "Filter1" },
    content: [{ type: "text", text: "ToolExecutionError: dataset 2a56fb8e4c1d9f70 failed" }],
    isError: true,
    details: undefined,
  };

  it("only enqueues inside tool_result, and confirms and sends on settle", async () => {
    const { registerObservationTriggers, pendingObservationCount } =
      await import("../extensions/loom/observation-triggers.js");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true, id: "x", retractToken: "b".repeat(32) }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.fn().mockResolvedValue(true);
    const ctx = {
      hasUI: true,
      ui: { confirm, input: vi.fn().mockResolvedValue(""), notify: vi.fn() },
    };
    const pi = fakePi();
    registerObservationTriggers(pi.api as any);
    await pi.emit("session_start", {}, ctx);

    await pi.emit("tool_result", failure, ctx);
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingObservationCount()).toBe(1);

    await pi.emit("agent_settled", {}, ctx);
    expect(confirm).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(pendingObservationCount()).toBe(0);
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(sent.signature).toBe("ToolExecutionError: dataset <id> failed");
  });

  it("enqueues nothing while the env hard-disable is set", async () => {
    process.env.LOOM_OBSERVATIONS = "off";
    const { registerObservationTriggers, pendingObservationCount } =
      await import("../extensions/loom/observation-triggers.js");
    const pi = fakePi();
    registerObservationTriggers(pi.api as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, {});
    await pi.emit("tool_result", failure, {});
    expect(pendingObservationCount()).toBe(0);
  });

  it("ignores a successful result and a non-galaxy failure", async () => {
    const { registerObservationTriggers, pendingObservationCount } =
      await import("../extensions/loom/observation-triggers.js");
    const pi = fakePi();
    registerObservationTriggers(pi.api as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, {});
    await pi.emit("tool_result", { ...failure, isError: false }, {});
    await pi.emit("tool_result", { ...failure, toolName: "bash", input: { command: "ls" } }, {});
    expect(pendingObservationCount()).toBe(0);
  });
});
