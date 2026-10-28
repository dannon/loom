import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";
import { GALAXY_ARGS_CLASSIFIED_OPS } from "../shared/galaxy-destructive.js";
import type { GalaxyToolFamily } from "../shared/galaxy-tool-family.js";
import { appendActivityEvent } from "../extensions/loom/activity";
import { registerGalaxyDestructiveGate } from "../extensions/loom/galaxy-destructive-gate";
import { registerGalaxyOpPolicy } from "../extensions/loom/galaxy-op-policy";
import {
  registerGalaxyTools,
  registeredGalaxyTools,
  setGalaxyToolSource,
} from "../extensions/loom/galaxy-tool-source";

const NB = "/session/notebook.md";

vi.mock("../extensions/loom/state", async (actual) => ({
  ...(await actual<typeof import("../extensions/loom/state")>()),
  getNotebookPath: () => NB,
}));
vi.mock("../extensions/loom/activity", async (actual) => ({
  ...(await actual<typeof import("../extensions/loom/activity")>()),
  appendActivityEvent: vi.fn(),
}));
// Pass-throughs, so index.ts's calls to them can be counted.
vi.mock("../extensions/loom/galaxy-destructive-gate", async (actual) => {
  const real = await actual<typeof import("../extensions/loom/galaxy-destructive-gate")>();
  return { ...real, registerGalaxyDestructiveGate: vi.fn(real.registerGalaxyDestructiveGate) };
});
vi.mock("../extensions/loom/galaxy-op-policy", async (actual) => {
  const real = await actual<typeof import("../extensions/loom/galaxy-op-policy")>();
  return { ...real, registerGalaxyOpPolicy: vi.fn(real.registerGalaxyOpPolicy) };
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

let family: GalaxyToolFamily;

beforeEach(() => {
  // A shell with no files surface: exec-guard is not registered, so nothing else asks.
  setCapabilityProfile({ ...profileFromEnv({}), files: false });
  family = registerGalaxyTools({ registerTool: () => {} } as unknown as ExtensionAPI);
  vi.mocked(appendActivityEvent).mockClear();
});

afterEach(() => {
  setGalaxyToolSource(null);
  setCapabilityProfile(null);
});

function gate(
  classifyArgs: boolean,
  {
    hasUI = true,
    answer = true,
    signal,
  }: { hasUI?: boolean; answer?: boolean; signal?: AbortSignal } = {},
) {
  const handlers: Handler[] = [];
  registerGalaxyDestructiveGate(
    { on: (event: string, h: Handler) => event === "tool_call" && handlers.push(h) } as never,
    family,
    { classifyArgs },
  );
  expect(handlers).toHaveLength(1);
  const confirm = vi.fn(async (_title: string, _message: string, _opts?: object) => answer);
  const ctx = { hasUI, signal, ui: { confirm }, model: { id: "test-model" } };
  const call = (toolName: string, input: Record<string, unknown>) =>
    handlers[0]({ toolName, input }, ctx) as Promise<{ block: true; reason: string } | undefined>;
  return { call, confirm };
}

const audits = () =>
  vi.mocked(appendActivityEvent).mock.calls.map(([dir, event]) => ({ dir, ...event }));

describe("the bare-path destructive confirm", () => {
  it("asks before a history delete, in exec-guard's layout, and audits the yes", async () => {
    const { call, confirm } = gate(true);
    expect(await call("update_history", { history_id: "h1", deleted: true })).toBeUndefined();
    expect(confirm).toHaveBeenCalledWith(
      "Confirm destructive Galaxy operation",
      expect.stringMatching(
        /^test-model wants to: Mark the entire history \(h1\) as deleted.*\n\nContinue\?$/s,
      ),
      { signal: undefined },
    );
    expect(audits()).toEqual([
      expect.objectContaining({
        dir: "/session",
        kind: "guard.decision",
        source: "galaxy-destructive-gate",
        payload: expect.objectContaining({
          toolName: "update_history",
          decision: "ask",
          category: "galaxy:destructive",
          outcome: "allowed:destructive-confirm",
        }),
      }),
    ]);
  });

  it("asks with the purge headline (handler-level: galaxy-ops has no purged parameter)", async () => {
    const { call, confirm } = gate(true);
    await call("update_history", { history_id: "h1", purged: true });
    expect(confirm.mock.calls[0][1]).toMatch(/Permanently PURGE history h1/);
  });

  it("asks before the tools galaxy-ops marks destructive, naming their ids", async () => {
    const { call, confirm } = gate(true);
    await call("delete_user_tool", { uuid: "u-1" });
    await call("cancel_workflow_invocation", { invocation_id: "inv1" });
    expect(confirm.mock.calls.map((c) => c[1])).toEqual([
      "test-model wants to: Run delete_user_tool (uuid=u-1), which Galaxy marks destructive.\n\nContinue?",
      "test-model wants to: Run cancel_workflow_invocation (invocation_id=inv1), which Galaxy marks destructive.\n\nContinue?",
    ]);
  });

  it("blocks when the user declines, and audits the no", async () => {
    const { call } = gate(true, { answer: false });
    expect(await call("delete_user_tool", { uuid: "u-1" })).toEqual({
      block: true,
      reason: "Destructive Galaxy operation cancelled by user.",
    });
    expect(audits()[0].payload).toMatchObject({ outcome: "blocked:destructive-user" });
  });

  it("hands the confirm the turn's signal, so an interrupt withdraws the ask", async () => {
    const turn = new AbortController();
    const { call, confirm } = gate(true, { signal: turn.signal });
    await call("delete_user_tool", { uuid: "u-1" });
    expect(confirm.mock.calls[0][2]).toEqual({ signal: turn.signal });
  });

  it("blocks without blaming the user when the turn is interrupted mid-confirm", async () => {
    const turn = new AbortController();
    const { call, confirm } = gate(true, { signal: turn.signal });
    // pi resolves a withdrawn confirm as a no; even a late yes must not run the delete.
    confirm.mockImplementationOnce(async () => {
      turn.abort();
      return true;
    });
    expect(await call("update_history", { history_id: "h1", deleted: true })).toEqual({
      block: true,
      reason: "Destructive Galaxy operation not run: the turn was interrupted.",
    });
    expect(audits()[0].payload).toMatchObject({
      decision: "ask",
      outcome: "blocked:destructive-aborted",
    });
  });

  it("blocks with exec-guard's wording when no one is there to ask", async () => {
    const { call, confirm } = gate(true, { hasUI: false });
    const blocked = await call("update_history", { history_id: "h1", deleted: true });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/\(denied: no interactive session to approve\)$/);
    expect(confirm).not.toHaveBeenCalled();
    expect(audits()[0].payload).toMatchObject({ decision: "deny", outcome: "blocked:no-ui" });
  });

  it("leaves update_history to exec-guard on a files surface, and still asks for hinted tools", async () => {
    const { call, confirm } = gate(false);
    expect(await call("update_history", { history_id: "h1", deleted: true })).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    await call("delete_user_tool", { uuid: "u-1" });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("ignores ordinary calls, renames and names outside the family", async () => {
    const { call, confirm } = gate(true);
    await call("update_history", { history_id: "h1", name: "renamed" });
    await call("get_histories", {});
    await call("bash", { command: "ls" });
    expect(confirm).not.toHaveBeenCalled();
    expect(audits()).toEqual([]);
  });

  it("sees the boolean prepareArguments makes of the model's string", async () => {
    const tool = registeredGalaxyTools().find((t) => t.name === "update_history")!;
    const input = tool.prepareArguments!({ history_id: "h1", deleted: "true" }) as Record<
      string,
      unknown
    >;
    expect(input.deleted).toBe(true);
    const { call, confirm } = gate(true);
    await call("update_history", input);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("never treats a hint on an args-classified op as the whole call being destructive", async () => {
    expect(GALAXY_ARGS_CLASSIFIED_OPS).toEqual(["update_history"]);
    // The fork already marks update_history destructive; a galaxy-ops that follows must not
    // make a rename ask.
    setGalaxyToolSource({
      tools: () => [
        {
          ...registeredGalaxyTools().find((t) => t.name === "update_history")!,
          annotations: { destructiveHint: true },
        },
      ],
    });
    family = registerGalaxyTools({ registerTool: () => {} } as unknown as ExtensionAPI);
    const { call, confirm } = gate(true);
    await call("update_history", { history_id: "h1", name: "renamed" });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("index.ts registers the gate and the page policy", () => {
  async function load(): Promise<void> {
    const noop = () => undefined;
    const pi = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "getAllTools" || prop === "getActiveTools") return () => [];
          if (prop === "events") return { on: noop, emit: noop };
          return noop;
        },
      },
    );
    const mod = await import("../extensions/loom/index");
    mod.default(pi as never);
  }

  it("registers both everywhere, leaving the container's history delete to web-mode-gate", async () => {
    setGalaxyToolSource(null);
    setCapabilityProfile(null);
    const saved = { ...process.env };
    // No files surface, so exec-guard and the sandbox stay out of a stand-in pi.
    process.env.LOOM_LOCAL_EXEC = "off";
    try {
      vi.mocked(registerGalaxyDestructiveGate).mockClear();
      vi.mocked(registerGalaxyOpPolicy).mockClear();
      await load();
      expect(registerGalaxyDestructiveGate).toHaveBeenCalledTimes(1);
      expect(vi.mocked(registerGalaxyDestructiveGate).mock.calls[0][2]).toEqual({
        classifyArgs: false,
      });
      expect(registerGalaxyOpPolicy).toHaveBeenCalledTimes(1);

      // A shell with no files and no gate of its own (the browser worker) asks about it here.
      delete process.env.LOOM_LOCAL_EXEC;
      setGalaxyToolSource(null);
      setCapabilityProfile({ ...profileFromEnv(), files: false, shell: false });
      await load();
      expect(vi.mocked(registerGalaxyDestructiveGate).mock.calls[1][2]).toEqual({
        classifyArgs: true,
      });
    } finally {
      process.env = saved;
    }
  });
});
