import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
// Capture the readline "line" handler so tests can feed brain stdout events
// through handleLine() (the real one is wired in start()).
let lineHandler: ((line: string) => void) | null = null;
// Per-stdout handlers, so a test can feed lines from a brain that already exited.
const lineHandlers = new Map<unknown, (line: string) => void>();
const createInterfaceMock = vi.fn((opts: { input: unknown }) => ({
  on: (event: string, cb: (line: string) => void) => {
    if (event !== "line") return;
    lineHandler = cb;
    lineHandlers.set(opts.input, cb);
  },
}));
const existsSyncMock = vi.fn(() => false);
const readdirSyncMock = vi.fn(() => []);

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  // execFile is pulled in transitively via agent.ts -> proc-monitor.ts
  // (collectDescendantsOf walks `ps` for the abort-kill path, #64). Tests
  // don't trigger abort, but the import must resolve.
  execFile: vi.fn(),
}));

vi.mock("node:readline", () => ({
  createInterface: createInterfaceMock,
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: existsSyncMock,
    readdirSync: readdirSyncMock,
  },
}));

vi.mock("node:os", () => ({
  default: {
    homedir: () => "/tmp/home",
  },
}));

// app/src/main/agent.ts → secure-config.ts imports `electron` at module top.
// vitest.config.ts aliases that specifier so it resolves from both sides to
// one id (see tests/stubs/electron.ts) and this factory replaces it. Stub the
// small surface area we transitively use; safeStorageAvailable() reads
// isEncryptionAvailable().
vi.mock("electron", () => ({
  // agent.ts imports `app` and reads `app?.isPackaged`; false routes it to the
  // dev resolution paths (no packaged bundle). Without this export vitest
  // throws "No 'app' export is defined on the 'electron' mock".
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(""),
    decryptString: () => "",
  },
}));

function makeProcess(pid: number) {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.pid = pid;
  proc.stdin = { writable: true, write: vi.fn() };
  proc.stdout = new EventEmitter() as EventEmitter & {
    removeAllListeners: ReturnType<typeof vi.fn>;
  };
  proc.stdout.removeAllListeners = vi.fn();
  proc.stderr = new EventEmitter() as EventEmitter & {
    removeAllListeners: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  proc.stderr.removeAllListeners = vi.fn();
  proc.stderr.on = vi.fn();
  proc.kill = vi.fn();
  proc.removeAllListeners = vi.fn();
  return proc;
}

describe("AgentManager", () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    createInterfaceMock.mockClear();
    lineHandler = null;
    lineHandlers.clear();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReset();
    readdirSyncMock.mockReturnValue([]);
  });

  it("reports prompt preflight rejection and refuses commands without a brain", async () => {
    const proc = makeProcess(101);
    spawnMock.mockReturnValue(proc);
    const { AgentManager } = await import("../app/src/main/agent.js");
    const window = {
      isDestroyed: () => false,
      setTitle: vi.fn(),
      webContents: { send: vi.fn() },
    };
    const manager = new AgentManager(window as any, "/analysis");

    await expect(manager.sendCommand({ type: "prompt", message: "are we done?" })).rejects.toThrow(
      "Agent is not running",
    );
    manager.start();
    const reply = manager.sendCommand({
      type: "prompt",
      message: "are we done?",
      streamingBehavior: "followUp",
    });
    const sent = JSON.parse(proc.stdin.write.mock.calls.at(-1)![0]);
    lineHandler?.(
      JSON.stringify({
        type: "response",
        id: sent.id,
        command: "prompt",
        success: false,
        error: "Preflight failed",
      }),
    );
    await expect(reply).rejects.toThrow("Preflight failed");
    manager.stop();
  });

  it("restarts in the new cwd without using --continue", async () => {
    const firstProc = makeProcess(101);
    const secondProc = makeProcess(202);
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const { AgentManager } = await import("../app/src/main/agent.js");
    const window = {
      isDestroyed: () => false,
      setTitle: vi.fn(),
      webContents: { send: vi.fn() },
    };

    const manager = new AgentManager(window as any, "/analysis/old");
    manager.start();

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "node",
      expect.arrayContaining(["--mode", "rpc"]),
      expect.objectContaining({ cwd: "/analysis/old" }),
    );
    expect(spawnMock.mock.calls[0][1] as string[]).not.toContain("--continue");

    expect(manager.switchCwd("/analysis/new")).toBe(true);

    expect(firstProc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "node",
      expect.arrayContaining(["--mode", "rpc"]),
      expect.objectContaining({ cwd: "/analysis/new" }),
    );
    expect(spawnMock.mock.calls[1][1] as string[]).not.toContain("--continue");
  });

  it("does not restart when the cwd is unchanged", async () => {
    const firstProc = makeProcess(101);
    spawnMock.mockReturnValue(firstProc);

    const { AgentManager } = await import("../app/src/main/agent.js");
    const window = {
      isDestroyed: () => false,
      setTitle: vi.fn(),
      webContents: { send: vi.fn() },
    };

    const manager = new AgentManager(window as any, "/analysis/same");
    manager.start();

    expect(manager.switchCwd("/analysis/same")).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(firstProc.kill).not.toHaveBeenCalled();
  });

  describe("MCP bootstrap notifications", () => {
    it.each(["idle", "prompt sent", "tool running"] as const)(
      "forwards the notice without restarting when %s",
      async (phase) => {
        vi.useFakeTimers();
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager } = await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        try {
          manager.start();
          if (phase !== "idle") {
            manager.send({ type: "prompt", message: "Build the composite figure." });
          }
          if (phase === "tool running") {
            lineHandler?.(JSON.stringify({ type: "agent_start" }));
            lineHandler?.(
              JSON.stringify({
                type: "tool_execution_start",
                toolCallId: "collection-read",
                toolName: "get_collection_details",
              }),
            );
          }

          const response = manager.sendCommand({ type: "get_state" });
          // Attach a rejection handler before advancing the restart timer so the
          // regression reports a failed assertion rather than an unhandled rejection.
          const responseOutcome = response.catch((error: unknown) => error);
          const command = JSON.parse(proc.stdin.write.mock.calls.at(-1)![0]);
          const notice = {
            type: "extension_ui_request",
            id: "mcp-bootstrap-notice",
            method: "notify",
            message: "MCP: direct tools for another-server will be available after restart",
            notifyType: "info",
          };
          lineHandler?.(JSON.stringify(notice));
          // The old implementation scheduled a destructive restart on the next tick.
          vi.advanceTimersByTime(1);

          expect(proc.kill).not.toHaveBeenCalled();
          expect(spawnMock).toHaveBeenCalledTimes(1);
          expect(window.webContents.send).toHaveBeenCalledWith("agent:ui-request", notice);
          expect(manager.getStatusSnapshot()).toMatchObject({
            status: "running",
            turnActive: phase === "tool running",
          });

          // The in-flight RPC and tool result must still reach their consumers.
          lineHandler?.(
            JSON.stringify({
              type: "response",
              id: command.id,
              success: true,
              data: { alive: true },
            }),
          );
          await expect(responseOutcome).resolves.toEqual({ alive: true });
          if (phase === "tool running") {
            const result = {
              type: "tool_execution_end",
              toolCallId: "collection-read",
              toolName: "get_collection_details",
              result: { content: [{ type: "text", text: "Collection retrieved" }] },
              isError: false,
            };
            lineHandler?.(JSON.stringify(result));
            expect(window.webContents.send).toHaveBeenCalledWith("agent:event", result);
            lineHandler?.(JSON.stringify({ type: "agent_end" }));
          }
          vi.advanceTimersByTime(100);
          expect(proc.kill).not.toHaveBeenCalled();
          expect(spawnMock).toHaveBeenCalledTimes(1);
        } finally {
          manager.stop();
          vi.useRealTimers();
        }
      },
    );
  });

  describe("stall watchdog (#185)", () => {
    function agentEvents(window: { webContents: { send: ReturnType<typeof vi.fn> } }) {
      return window.webContents.send.mock.calls.filter((c: unknown[]) => c[0] === "agent:event");
    }
    function errorEvents(window: { webContents: { send: ReturnType<typeof vi.fn> } }) {
      return agentEvents(window).filter(
        (c: unknown[]) => (c[1] as { type?: string })?.type === "error",
      );
    }

    it("surfaces a synthetic error when the brain goes silent after a prompt", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS } = await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "How many histories do I have?" });
        expect(errorEvents(window)).toHaveLength(0);

        vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);

        const errors = errorEvents(window);
        expect(errors).toHaveLength(1);
        expect((errors[0][1] as { message?: string }).message).toMatch(/responding|stalled/i);
        // Best-effort: tell the wedged brain to abort so the next prompt works.
        expect(proc.stdin.write).toHaveBeenCalledWith(expect.stringMatching(/"type":"abort"/));
        // Turn is no longer considered active after recovery.
        expect(manager.getStatusSnapshot().turnActive).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives a compaction its own limit and says so when it fires (#603)", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS, COMPACTION_SILENCE_TIMEOUT_MS } =
          await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "keep going" });
        lineHandler?.(JSON.stringify({ type: "compaction_start", reason: "threshold" }));
        vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS * 2);
        expect(errorEvents(window)).toHaveLength(0);

        vi.advanceTimersByTime(COMPACTION_SILENCE_TIMEOUT_MS);
        const errors = errorEvents(window);
        expect(errors).toHaveLength(1);
        const message = (errors[0][1] as { message?: string }).message;
        expect(message).toMatch(/summariz/i);
        expect(message).not.toMatch(/two minutes/);
        expect(proc.stdin.write).toHaveBeenCalledWith(expect.stringMatching(/"type":"abort"/));
      } finally {
        vi.useRealTimers();
      }
    });

    it("times a compaction again once the dialog that paused it is answered (#616)", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager, COMPACTION_SILENCE_TIMEOUT_MS } =
          await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();
        const aborts = () =>
          proc.stdin.write.mock.calls.filter(([line]) => /"type":"abort"/.test(line as string));

        manager.send({ type: "prompt", message: "Keep going" });
        lineHandler?.(JSON.stringify({ type: "compaction_start", reason: "threshold" }));
        lineHandler?.(
          JSON.stringify({ type: "extension_ui_request", id: "ui1", method: "confirm" }),
        );
        vi.advanceTimersByTime(COMPACTION_SILENCE_TIMEOUT_MS * 2);
        expect(aborts()).toHaveLength(0);

        manager.send({ type: "extension_ui_response", id: "ui1", confirmed: true });
        vi.advanceTimersByTime(COMPACTION_SILENCE_TIMEOUT_MS);
        expect(aborts()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops the compaction when the brain is stopped and started again (#616)", async () => {
      vi.useFakeTimers();
      try {
        const first = makeProcess(101);
        const second = makeProcess(202);
        spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
        const { AgentManager, COMPACTION_SILENCE_TIMEOUT_MS } =
          await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "Keep going" });
        lineHandler?.(JSON.stringify({ type: "compaction_start", reason: "threshold" }));
        // stop() strips the old brain's listeners, so its exit handler never runs.
        manager.stop();
        manager.start();
        vi.advanceTimersByTime(COMPACTION_SILENCE_TIMEOUT_MS * 2);
        expect(second.stdin.write).not.toHaveBeenCalledWith(
          expect.stringMatching(/"type":"abort"/),
        );
        expect(errorEvents(window)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops a crashed brain's compaction before the silent restart", async () => {
      vi.useFakeTimers();
      try {
        const first = makeProcess(101);
        const second = makeProcess(202);
        spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS } = await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "keep going" });
        lineHandler?.(JSON.stringify({ type: "compaction_start", reason: "threshold" }));
        first.emit("exit", 1, null);
        vi.advanceTimersByTime(200);
        expect(spawnMock).toHaveBeenCalledTimes(2);

        // The replacement brain isn't compacting, so its prompt is back on 120s.
        manager.send({ type: "prompt", message: "hello again" });
        vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);
        expect(errorEvents(window)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores stdout a crashed brain flushes after its exit (#616)", async () => {
      vi.useFakeTimers();
      try {
        const first = makeProcess(101);
        const second = makeProcess(202);
        spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS } = await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();
        const firstLine = lineHandlers.get(first.stdout)!;
        const reply = manager.sendCommand({ type: "get_state" });
        const sent = JSON.parse(first.stdin.write.mock.calls.at(-1)![0]);

        first.emit("exit", 1, null);
        await expect(reply).rejects.toThrow("Agent stopped");
        firstLine(JSON.stringify({ type: "response", id: sent.id, success: true, data: {} }));
        // Node can deliver buffered stdout after 'exit', before and after the restart.
        firstLine(JSON.stringify({ type: "compaction_start", reason: "threshold" }));
        vi.advanceTimersByTime(200);
        expect(spawnMock).toHaveBeenCalledTimes(2);
        firstLine(JSON.stringify({ type: "compaction_start", reason: "threshold" }));
        const firstStderr = (first.stderr as { on: ReturnType<typeof vi.fn> }).on.mock.calls.find(
          ([event]) => event === "data",
        )![1] as (chunk: Buffer) => void;
        firstStderr(Buffer.from("old brain's last words\n"));
        expect(manager.getStderr()).not.toContain("old brain");
        expect(
          window.webContents.send.mock.calls.filter(
            ([channel, data]) =>
              channel === "agent:event" && (data as { type?: string }).type === "compaction_start",
          ),
        ).toHaveLength(0);
        const errorsBefore = errorEvents(window).length;

        manager.send({ type: "prompt", message: "Try again" });
        vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);
        const errors = errorEvents(window).slice(errorsBefore);
        expect(errors).toHaveLength(1);
        expect((errors[0][1] as { message?: string }).message).toMatch(/stopped responding/i);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ["a handled command", { success: true, data: { disposition: "handled" } }],
      ["a rejected prompt", { success: false, error: "Preflight failed" }],
    ])("stands down after %s, which starts no turn", async (_label, outcome) => {
      vi.useFakeTimers();
      try {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS } = await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "/status" });
        lineHandler?.(JSON.stringify({ type: "response", command: "prompt", ...outcome }));
        vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS * 2);

        expect(errorEvents(window)).toHaveLength(0);
        expect(proc.stdin.write).not.toHaveBeenCalledWith(expect.stringMatching(/"type":"abort"/));
      } finally {
        vi.useRealTimers();
      }
    });

    describe("slash commands doing slow I/O (#674)", () => {
      async function boot() {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const mod = await import("../app/src/main/agent.js");
        const { agentPromptPayload } = await import("../shared/agent-prompt.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new mod.AgentManager(window as any, "/analysis");
        manager.start();
        const aborts = () =>
          proc.stdin.write.mock.calls.filter(([line]) => /"type":"abort"/.test(line as string));
        // The renderer's path: ipc-handlers awaits sendCommand, which tags an id.
        const prompt = (message: string) => {
          const reply = manager.sendCommand(agentPromptPayload(message));
          const id = JSON.parse(proc.stdin.write.mock.calls.at(-1)![0]).id as string;
          return { reply, id };
        };
        const respond = (id: string, data: Record<string, unknown>) =>
          lineHandler?.(
            JSON.stringify({ type: "response", id, command: "prompt", success: true, data }),
          );
        return { ...mod, proc, window, manager, aborts, prompt, respond };
      }

      it("does not cancel a command that takes minutes to reach its dialog", async () => {
        vi.useFakeTimers();
        try {
          const {
            TURN_SILENCE_TIMEOUT_MS,
            COMMAND_SILENCE_TIMEOUT_MS,
            window,
            aborts,
            prompt,
            respond,
            manager,
          } = await boot();
          lineHandler?.(JSON.stringify({ type: "agent_settled", aborted: false }));

          // /approve re-fetches the template and checks formats against a
          // rate-limited Galaxy before it confirms.
          const { reply, id } = prompt("/approve prop-m6zts1");
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS * 3);
          expect(errorEvents(window)).toHaveLength(0);
          expect(aborts()).toHaveLength(0);

          lineHandler?.(
            JSON.stringify({ type: "extension_ui_request", id: "ui1", method: "confirm" }),
          );
          manager.send({ type: "extension_ui_response", id: "ui1", confirmed: true });
          respond(id, { disposition: "handled" });
          await expect(reply).resolves.toEqual({ disposition: "handled" });
          // Past the command's own ceiling too: the answer has to settle it.
          vi.advanceTimersByTime(COMMAND_SILENCE_TIMEOUT_MS * 2);
          expect(errorEvents(window)).toHaveLength(0);
          expect(aborts()).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("doesn't cut off a command sent after an ordinary turn has finished", async () => {
        vi.useFakeTimers();
        try {
          const { TURN_SILENCE_TIMEOUT_MS, window, aborts, prompt, manager } = await boot();

          // Chat with the model, then approve what it proposed.
          manager.sendCommand({ type: "prompt", message: "run fastp on the reads" });
          lineHandler?.(JSON.stringify({ type: "agent_start" }));
          lineHandler?.(JSON.stringify({ type: "agent_end" }));
          prompt("/approve prop-m6zts1");
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS * 3);

          expect(errorEvents(window)).toHaveLength(0);
          expect(aborts()).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("still catches a hung turn that a command starts after pi answers it", async () => {
        vi.useFakeTimers();
        try {
          const { TURN_SILENCE_TIMEOUT_MS, window, aborts, prompt, respond, manager } =
            await boot();

          const { id } = prompt("/approve prop-m6zts1");
          lineHandler?.(
            JSON.stringify({ type: "extension_ui_request", id: "ui1", method: "confirm" }),
          );
          manager.send({ type: "extension_ui_response", id: "ui1", confirmed: true });
          respond(id, { disposition: "handled" });
          // The approved run /approve queued, starting after the handled reply.
          lineHandler?.(JSON.stringify({ type: "agent_start" }));
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);

          const errors = errorEvents(window);
          expect(errors).toHaveLength(1);
          expect((errors[0][1] as { message?: string }).message).toMatch(/stopped responding/i);
          expect(aborts()).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("stands down once the turn a command started ends", async () => {
        vi.useFakeTimers();
        try {
          const { COMMAND_SILENCE_TIMEOUT_MS, window, aborts, prompt, respond } = await boot();

          const { id } = prompt("/execute");
          respond(id, { disposition: "handled" });
          lineHandler?.(JSON.stringify({ type: "agent_start" }));
          lineHandler?.(JSON.stringify({ type: "agent_end" }));
          vi.advanceTimersByTime(COMMAND_SILENCE_TIMEOUT_MS * 2);

          expect(errorEvents(window)).toHaveLength(0);
          expect(aborts()).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("isn't fooled by a reply to some other request during a command's dialog", async () => {
        vi.useFakeTimers();
        try {
          const { COMMAND_SILENCE_TIMEOUT_MS, window, aborts, prompt, manager, proc } =
            await boot();

          prompt("/sync push");
          lineHandler?.(
            JSON.stringify({ type: "extension_ui_request", id: "ui1", method: "confirm" }),
          );
          const state = manager.sendCommand({ type: "get_state" });
          const stateId = JSON.parse(proc.stdin.write.mock.calls.at(-1)![0]).id;
          lineHandler?.(
            JSON.stringify({ type: "response", id: stateId, command: "get_state", success: true }),
          );
          await state;
          // The user is still reading the dialog.
          vi.advanceTimersByTime(COMMAND_SILENCE_TIMEOUT_MS * 2);
          expect(errorEvents(window)).toHaveLength(0);
          expect(aborts()).toHaveLength(0);

          // The reply didn't settle /sync either: it's timed again once answered.
          manager.send({ type: "extension_ui_response", id: "ui1", confirmed: true });
          vi.advanceTimersByTime(COMMAND_SILENCE_TIMEOUT_MS - 1);
          expect(errorEvents(window)).toHaveLength(0);
          vi.advanceTimersByTime(1);
          expect(errorEvents(window)).toHaveLength(1);
          expect(aborts()).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("still catches a hung turn behind a slash prompt that wasn't a command", async () => {
        vi.useFakeTimers();
        try {
          const { TURN_SILENCE_TIMEOUT_MS, window, aborts, prompt, respond } = await boot();

          // pi only knows "/data/reads.fq looks odd" isn't a command once it
          // looks; then it starts an ordinary turn.
          const { id } = prompt("/data/reads.fq looks odd");
          respond(id, { disposition: "started" });
          lineHandler?.(JSON.stringify({ type: "agent_start" }));
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);

          const errors = errorEvents(window);
          expect(errors).toHaveLength(1);
          expect((errors[0][1] as { message?: string }).message).toMatch(/stopped responding/i);
          expect(aborts()).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("leaves nothing to time out once a non-command slash prompt's turn ends", async () => {
        vi.useFakeTimers();
        try {
          const { COMMAND_SILENCE_TIMEOUT_MS, window, prompt, respond } = await boot();

          const { id } = prompt("/data/reads.fq looks odd");
          respond(id, { disposition: "started" });
          lineHandler?.(JSON.stringify({ type: "agent_start" }));
          lineHandler?.(JSON.stringify({ type: "agent_end" }));
          vi.advanceTimersByTime(COMMAND_SILENCE_TIMEOUT_MS * 2);

          expect(errorEvents(window)).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("still catches a model turn that stalls while a command is running", async () => {
        vi.useFakeTimers();
        try {
          const { TURN_SILENCE_TIMEOUT_MS, window, aborts, prompt, manager } = await boot();

          manager.sendCommand({ type: "prompt", message: "summarize my history" });
          lineHandler?.(JSON.stringify({ type: "agent_start" }));
          prompt("/reconcile");
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);

          expect(errorEvents(window)).toHaveLength(1);
          expect(aborts()).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("keeps a slash prompt sent without an id on the turn limit", async () => {
        vi.useFakeTimers();
        try {
          const { TURN_SILENCE_TIMEOUT_MS, window, manager } = await boot();

          // No id means no response to settle it by, so it can't be held off.
          manager.send({ type: "prompt", message: "/approve prop-m6zts1" });
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);

          expect(errorEvents(window)).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("settles a slash prompt that pi rejects", async () => {
        vi.useFakeTimers();
        try {
          const { COMMAND_SILENCE_TIMEOUT_MS, COMPACTION_SILENCE_TIMEOUT_MS, window, prompt } =
            await boot();

          // Not a command, and pi won't start a turn mid-compaction.
          lineHandler?.(JSON.stringify({ type: "compaction_start", reason: "manual" }));
          const { reply, id } = prompt("/data/reads.fq looks odd");
          lineHandler?.(
            JSON.stringify({
              type: "response",
              id,
              command: "prompt",
              success: false,
              error: "Cannot submit a prompt while compaction is in progress.",
            }),
          );
          await expect(reply).rejects.toThrow(/compaction/);
          vi.advanceTimersByTime(COMMAND_SILENCE_TIMEOUT_MS * 2);
          expect(errorEvents(window)).toHaveLength(0);

          // Standing the prompt down left the compaction's own ceiling running.
          vi.advanceTimersByTime(COMPACTION_SILENCE_TIMEOUT_MS);
          const errors = errorEvents(window);
          expect(errors).toHaveLength(1);
          expect((errors[0][1] as { message?: string }).message).toMatch(/summariz/i);
        } finally {
          vi.useRealTimers();
        }
      });

      it("gives up on a command that never finishes, without claiming to cancel it", async () => {
        vi.useFakeTimers();
        try {
          const {
            TURN_SILENCE_TIMEOUT_MS,
            COMMAND_SILENCE_TIMEOUT_MS,
            window,
            aborts,
            prompt,
            manager,
          } = await boot();

          prompt("/approve prop-m6zts1");
          vi.advanceTimersByTime(COMMAND_SILENCE_TIMEOUT_MS - 1);
          expect(errorEvents(window)).toHaveLength(0);
          vi.advanceTimersByTime(1);

          const errors = errorEvents(window);
          expect(errors).toHaveLength(1);
          const message = (errors[0][1] as { message?: string }).message;
          expect(message).toMatch(/\/approve/);
          expect(message).not.toMatch(/cancel/i);
          // pi's abort can't stop a command handler, so don't pretend it does.
          expect(aborts()).toHaveLength(0);
          expect(manager.getStatusSnapshot().turnActive).toBe(false);

          // The hung command is forgotten: no repeat, and the next prompt is timed.
          vi.advanceTimersByTime(COMMAND_SILENCE_TIMEOUT_MS * 2);
          expect(errorEvents(window)).toHaveLength(1);
          manager.sendCommand({ type: "prompt", message: "is Galaxy up?" });
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);
          expect(errorEvents(window)).toHaveLength(2);
          expect(aborts()).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("forgets a crashed brain's commands before the silent restart", async () => {
        vi.useFakeTimers();
        try {
          const first = makeProcess(101);
          const second = makeProcess(202);
          spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
          const { AgentManager, TURN_SILENCE_TIMEOUT_MS, COMMAND_SILENCE_TIMEOUT_MS } =
            await import("../app/src/main/agent.js");
          const window = {
            isDestroyed: () => false,
            setTitle: vi.fn(),
            webContents: { send: vi.fn() },
          };
          const manager = new AgentManager(window as any, "/analysis");
          manager.start();

          const reply = manager.sendCommand({ type: "prompt", message: "/approve prop-x" });
          first.emit("exit", 1, null);
          await expect(reply).rejects.toThrow("Agent stopped");
          vi.advanceTimersByTime(200);
          expect(spawnMock).toHaveBeenCalledTimes(2);

          // The lost /approve is reported like any turn a crash took, on the
          // turn limit, and the dead command leaves no ceiling behind.
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS);
          const lost = errorEvents(window);
          expect(lost).toHaveLength(1);
          expect((lost[0][1] as { message?: string }).message).toMatch(/stopped responding/i);
          vi.advanceTimersByTime(COMMAND_SILENCE_TIMEOUT_MS * 2);
          expect(errorEvents(window)).toHaveLength(1);

          // The new brain's first prompt is on the turn limit too.
          manager.send({ type: "prompt", message: "hello again" });
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);
          expect(errorEvents(window)).toHaveLength(2);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it("keeps watching a running turn when a queued prompt is handled", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS } = await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "hi" });
        lineHandler?.(JSON.stringify({ type: "agent_start" }));
        manager.send({ type: "prompt", message: "/status", streamingBehavior: "followUp" });
        lineHandler?.(
          JSON.stringify({
            type: "response",
            command: "prompt",
            success: true,
            data: { disposition: "handled" },
          }),
        );
        vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);

        expect(errorEvents(window)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("forwards an awaited prompt response so the renderer sees its disposition", async () => {
      const proc = makeProcess(101);
      spawnMock.mockReturnValue(proc);
      const { AgentManager } = await import("../app/src/main/agent.js");
      const window = {
        isDestroyed: () => false,
        setTitle: vi.fn(),
        webContents: { send: vi.fn() },
      };
      const manager = new AgentManager(window as any, "/analysis");
      manager.start();

      const reply = manager.sendCommand({ type: "prompt", message: "/status" });
      const sent = JSON.parse(proc.stdin.write.mock.calls.at(-1)![0]);
      const response = {
        type: "response",
        id: sent.id,
        command: "prompt",
        success: true,
        data: { disposition: "handled" },
      };
      lineHandler?.(JSON.stringify(response));

      await expect(reply).resolves.toEqual({ disposition: "handled" });
      expect(agentEvents(window).map((c: unknown[]) => c[1])).toContainEqual(response);

      // Other awaited commands stay private to their caller.
      const state = manager.sendCommand({ type: "get_state" });
      const stateId = JSON.parse(proc.stdin.write.mock.calls.at(-1)![0]).id;
      lineHandler?.(
        JSON.stringify({ type: "response", id: stateId, command: "get_state", success: true }),
      );
      await state;
      expect(
        agentEvents(window).some((c: unknown[]) => (c[1] as { id?: string }).id === stateId),
      ).toBe(false);
      manager.stop();
    });

    it("does not fire when the brain keeps streaming activity", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS } = await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "hi" });
        // Brain stays alive: an event arrives just before each deadline.
        for (let i = 0; i < 4; i++) {
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS - 1);
          lineHandler?.(JSON.stringify({ type: "message_update" }));
        }

        expect(errorEvents(window)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([false, true])(
      "preserves an active turn across sleep (recovers after wake: %s)",
      async (recovers) => {
        vi.useFakeTimers();
        try {
          const proc = makeProcess(101);
          spawnMock.mockReturnValue(proc);
          const { AgentManager, TURN_SILENCE_TIMEOUT_MS } =
            await import("../app/src/main/agent.js");
          const window = {
            isDestroyed: () => false,
            setTitle: vi.fn(),
            webContents: { send: vi.fn() },
          };
          const manager = new AgentManager(window as any, "/analysis");
          manager.start();
          manager.send({ type: "prompt", message: "continue" });
          lineHandler?.(JSON.stringify({ type: "agent_start" }));
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS - 1);

          manager.suspendWatchdog();
          // A buffered event after suspend must not restart the timer.
          lineHandler?.(JSON.stringify({ type: "message_start" }));
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS * 5);
          expect(errorEvents(window)).toHaveLength(0);
          expect(manager.getStatusSnapshot().turnActive).toBe(true);
          expect(proc.stdin.write).not.toHaveBeenCalledWith(
            expect.stringMatching(/"type":"abort"/),
          );
          expect(proc.kill).not.toHaveBeenCalled();

          manager.resumeWatchdog();
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS - 1);
          expect(errorEvents(window)).toHaveLength(0);
          if (recovers) lineHandler?.(JSON.stringify({ type: "agent_end" }));
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS * 2);
          expect(errorEvents(window)).toHaveLength(recovers ? 0 : 1);
          const aborts = proc.stdin.write.mock.calls.filter(([line]: [string]) =>
            line.includes('"type":"abort"'),
          );
          expect(aborts).toHaveLength(recovers ? 0 : 1);
          expect(manager.getStatusSnapshot().turnActive).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("disarms on agent_end so a completed turn never false-fires", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS } = await import("../app/src/main/agent.js");
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "hi" });
        lineHandler?.(JSON.stringify({ type: "agent_start" }));
        lineHandler?.(JSON.stringify({ type: "agent_end" }));

        vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS * 3);

        expect(errorEvents(window)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("sets the window title from the cwd on construction, switch, and setCwd", async () => {
    spawnMock.mockReturnValue(makeProcess(101));

    const { AgentManager } = await import("../app/src/main/agent.js");
    const setTitle = vi.fn();
    const window = {
      isDestroyed: () => false,
      setTitle,
      webContents: { send: vi.fn() },
    };

    // os.homedir() is mocked to "/tmp/home" at the top of this file.
    const manager = new AgentManager(window as any, "/tmp/home/projectA");
    expect(setTitle).toHaveBeenLastCalledWith("~/projectA — Orbit");

    expect(manager.switchCwd("/srv/data/projectB")).toBe(true);
    expect(setTitle).toHaveBeenLastCalledWith("/srv/data/projectB — Orbit");

    manager.setCwd("/tmp/home/projectC");
    expect(setTitle).toHaveBeenLastCalledWith("~/projectC — Orbit");
  });

  /**
   * #439: a deterministic config failure (EX_CONFIG) is not a crash. Retrying
   * it cannot change the answer, and the three silent restarts replaced the
   * brain's own explanation with a generic "crashed repeatedly" box.
   */
  describe("startup failure surfacing (#439)", () => {
    // makeProcess() stubs stderr.on, which would swallow the brain's output
    // before AgentManager could buffer it. These tests need the real emitter.
    function makeProcessWithStderr(pid: number) {
      const proc = makeProcess(pid);
      const stderr = proc.stderr as unknown as EventEmitter;
      proc.stderr.on = stderr.addListener.bind(stderr) as never;
      return proc;
    }

    function statusEvents(window: { webContents: { send: ReturnType<typeof vi.fn> } }) {
      return window.webContents.send.mock.calls.filter((c: unknown[]) => c[0] === "agent:status");
    }

    function makeWindow() {
      return {
        isDestroyed: () => false,
        setTitle: vi.fn(),
        webContents: { send: vi.fn() },
      };
    }

    it("does not retry a config failure, and shows what the brain said", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcessWithStderr(101);
        spawnMock.mockReturnValue(proc);

        const { AgentManager } = await import("../app/src/main/agent.js");
        const window = makeWindow();
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        proc.stderr.emit(
          "data",
          Buffer.from('orbit: provider "openai-codex" requires a sign-in.\n'),
        );
        proc.emit("exit", 78, null);

        // The restart path defers by 100ms; give it every chance to fire.
        vi.advanceTimersByTime(5000);
        expect(spawnMock).toHaveBeenCalledTimes(1);

        // The chat pane is the only surface that renders multi-line text, so
        // the brain's full message goes there...
        const chatError = window.webContents.send.mock.calls.find(
          (c: unknown[]) => c[0] === "agent:event" && (c[1] as { type?: string })?.type === "error",
        );
        expect((chatError?.[1] as { message: string }).message).toContain("requires a sign-in");

        // ...and the width-capped pill gets a one-liner. It must be the LAST
        // status write: the renderer's chat-error handler resets the badge to a
        // bare "error", so a summary sent first would be clobbered.
        const last = statusEvents(window).at(-1);
        expect(last?.[1]).toBe("error");
        expect(last?.[2]).toContain("requires a sign-in");
        expect(last?.[2]).not.toContain("\n");
        // The generic crash text is precisely what this replaces.
        expect(last?.[2]).not.toContain("crashed repeatedly");
      } finally {
        vi.useRealTimers();
      }
    });

    it("still retries an ordinary crash", async () => {
      vi.useFakeTimers();
      try {
        const first = makeProcessWithStderr(101);
        const second = makeProcessWithStderr(202);
        spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

        const { AgentManager } = await import("../app/src/main/agent.js");
        const window = makeWindow();
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        // Exit 1 stays "something went wrong" -- a transient fault earns a retry.
        first.emit("exit", 1, null);
        vi.advanceTimersByTime(200);

        expect(spawnMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("attaches the stderr tail once the retry budget is spent", async () => {
      vi.useFakeTimers();
      try {
        const procs = [101, 202, 303, 404].map(makeProcessWithStderr);
        spawnMock.mockImplementation(() => procs.shift()!);
        const all = [...procs];

        const { AgentManager } = await import("../app/src/main/agent.js");
        const window = makeWindow();
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        // Three restarts are allowed in the window; the fourth exit gives up.
        for (const proc of all) {
          proc.stderr.emit("data", Buffer.from("pi: connection reset by peer\n"));
          proc.emit("exit", 1, null);
          vi.advanceTimersByTime(200);
        }

        const last = statusEvents(window).at(-1);
        expect(last?.[1]).toBe("error");
        expect(last?.[2]).toContain("crashed repeatedly");
        // The stderr rides the chat channel, not the pill.
        expect(last?.[2]).not.toContain("connection reset by peer");
        const chatError = window.webContents.send.mock.calls
          .filter(
            (c: unknown[]) =>
              c[0] === "agent:event" && (c[1] as { type?: string })?.type === "error",
          )
          .at(-1);
        expect((chatError?.[1] as { message: string }).message).toContain(
          "connection reset by peer",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
