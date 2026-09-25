import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

vi.mock("../extensions/loom/state.js", () => ({
  resetState: vi.fn(),
  initSessionArtifacts: vi.fn(),
  getNotebookPath: vi.fn(() => null),
  stopWatchingNotebook: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-poller.js", () => ({
  startGalaxyPoller: vi.fn(),
  stopGalaxyPoller: vi.fn(),
  setPollTickHook: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-page-sync.js", () => ({
  initGalaxyPageSync: vi.fn(),
  flushNotebookToGalaxy: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-cred-drift.js", () => ({ maybeNudgeGalaxyReconnect: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: vi.fn(() => ({})) }));

import { startGalaxyPoller } from "../extensions/loom/galaxy-poller.js";
import { registerSessionLifecycle } from "../extensions/loom/session-lifecycle";
import { registerCommandsAsUserInput } from "../extensions/loom/auto-resume";

type SessionHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

async function start(hasUI = true) {
  const handlers = new Map<string, SessionHandler>();
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const pi = {
    on: (name: string, handler: SessionHandler) => handlers.set(name, handler),
    sendUserMessage,
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => unknown }) =>
      commands.set(name, opts),
  } as unknown as ExtensionAPI;
  registerCommandsAsUserInput(pi);
  pi.registerCommand("execute", { description: "", handler: vi.fn() });
  const ctx = {
    hasUI,
    ui: { setToolsExpanded: vi.fn(), notify },
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "test-session" },
  } as unknown as ExtensionContext;
  registerSessionLifecycle(pi);
  await handlers.get("session_start")!({}, ctx);
  const emit = (name: string, event: unknown) => handlers.get(name)!(event, ctx);
  return { sendUserMessage, notify, emit, commands };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LOOM_AUTO_RESUME", undefined);
  vi.stubEnv("LOOM_FRESH_SESSION", "1");
});
afterEach(() => vi.unstubAllEnvs());

describe("session Galaxy follow-up wiring", () => {
  it.each([true, false])(
    "queues a turn by default, including headless sessions (hasUI=%s)",
    async (hasUI) => {
      const { sendUserMessage, notify } = await start(hasUI);
      const [toast, resume] = vi.mocked(startGalaxyPoller).mock.calls[0];
      expect(resume).toBeTypeOf("function");
      resume!("Verify finished imports");
      // Pi starts immediately if idle and queues behind active work if busy.
      expect(sendUserMessage).toHaveBeenCalledWith("Verify finished imports", {
        deliverAs: "followUp",
      });
      toast!("Verification queued", "info");
      expect(notify).toHaveBeenCalledTimes(hasUI ? 1 : 0);
    },
  );

  it("keeps explicit opt-out sessions notification-only", async () => {
    vi.stubEnv("LOOM_AUTO_RESUME", "0");
    await start();
    expect(vi.mocked(startGalaxyPoller).mock.calls[0][1]).toBeUndefined();
  });

  const aborted = { messages: [{ role: "assistant", stopReason: "aborted", content: [] }] };
  const resumeFn = () => vi.mocked(startGalaxyPoller).mock.calls[0][1]!;

  it("pauses after the cap and notifies, until the user types or runs a command", async () => {
    const { sendUserMessage, notify, emit, commands } = await start();
    for (let i = 0; i < 5; i++) resumeFn()(`auto ${i}`);
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/paused after 3/), "info");

    // The brain's own prompts don't count as the user saying "keep going".
    await emit("input", { type: "input", text: "x", source: "extension" });
    resumeFn()("still paused");
    expect(sendUserMessage).toHaveBeenCalledTimes(3);

    await emit("input", { type: "input", text: "continue", source: "rpc" });
    resumeFn()("resumed by input");
    expect(sendUserMessage).toHaveBeenCalledTimes(4);

    for (let i = 0; i < 3; i++) resumeFn()("fill");
    await commands.get("execute")!.handler("", {});
    resumeFn()("resumed by /execute");
    expect(sendUserMessage).toHaveBeenLastCalledWith("resumed by /execute", {
      deliverAs: "followUp",
    });
  });

  it("stops waking the agent after the user stops a turn, until they speak again", async () => {
    const { sendUserMessage, emit } = await start();
    await emit("agent_start", {});
    resumeFn()("held during the turn");
    await emit("agent_end", aborted);
    await emit("agent_settled", {});
    resumeFn()("after stop");
    expect(sendUserMessage).not.toHaveBeenCalled();
    await emit("input", { type: "input", text: "go on", source: "interactive" });
    resumeFn()("after input");
    expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith("after input", {
      deliverAs: "followUp",
    });
  });

  it("lets an explicit opt-out win over user input", async () => {
    vi.stubEnv("LOOM_AUTO_RESUME", "0");
    const { emit } = await start();
    await emit("input", { type: "input", text: "continue", source: "rpc" });
    expect(vi.mocked(startGalaxyPoller).mock.calls[0][1]).toBeUndefined();
  });
});
