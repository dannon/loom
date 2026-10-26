import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  EMPTY_COMPLETION_GAVE_UP,
  EMPTY_COMPLETION_NUDGE,
  EMPTY_COMPLETION_RETRYING,
  endedEmpty,
  registerEmptyCompletionCheck,
} from "../extensions/loom/empty-completion";
import { createFollowUpDelivery, setActiveFollowUpDelivery } from "../extensions/loom/auto-resume";

const assistant = (content: unknown[], stopReason = "stop") => ({
  role: "assistant",
  content,
  stopReason,
});

describe("endedEmpty", () => {
  it("catches a normal stop with no text", () => {
    expect(endedEmpty([assistant([])])).toBe(true);
    expect(endedEmpty([assistant([{ type: "text", text: "  \n" }])])).toBe(true);
    // Thinking isn't an answer the user sees.
    expect(endedEmpty([assistant([{ type: "thinking", thinking: "hmm" }])])).toBe(true);
  });

  it("leaves real answers, tool calls, errors and aborts alone", () => {
    expect(endedEmpty([assistant([{ type: "text", text: "Done." }])])).toBe(false);
    expect(endedEmpty([assistant([{ type: "toolCall", id: "1", name: "x" }], "toolUse")])).toBe(
      false,
    );
    expect(endedEmpty([assistant([], "error")])).toBe(false);
    expect(endedEmpty([assistant([], "aborted")])).toBe(false);
    expect(endedEmpty([])).toBe(false);
  });

  it("judges only the last assistant message", () => {
    expect(endedEmpty([assistant([{ type: "text", text: "Earlier." }]), assistant([])])).toBe(true);
    expect(endedEmpty([assistant([]), assistant([{ type: "text", text: "Later." }])])).toBe(false);
  });
});

/**
 * #605 through the real Pi loop: a tool call, then an empty completion. Pi
 * treats that as a normal end of run, so without the check the user gets
 * silence. The follow-up wiring mirrors session-lifecycle's.
 */
async function runEmptyAfterTools(replies: Array<"empty" | "answer">) {
  const dir = mkdtempSync(join(tmpdir(), "loom-empty-completion-"));
  let dispose: (() => void) | undefined;
  const notices: Array<{ text: string; level?: string }> = [];
  const prompts: string[] = [];
  let turns = 0;
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const wireFollowUps = (pi: ExtensionAPI) => {
      const followUps = createFollowUpDelivery(
        (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
        { graceMs: 0 },
      );
      setActiveFollowUpDelivery(followUps);
      pi.on("agent_start", async () => followUps.agentStarted());
      pi.on("agent_settled", async () => followUps.agentSettled());
      pi.on("message_end", async (event) => {
        const msg = event.message;
        if (msg.role !== "user") return;
        const text =
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n");
        prompts.push(text);
        followUps.userMessageRecorded(text);
      });
    };
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [wireFollowUps, registerEmptyCompletionCheck],
      systemPrompt: "Empty completion fixture.",
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(dir, "models-cache.json"),
      refreshOnCreate: false,
    });
    runtime.registerProvider("empty-fixture", {
      api: "openai-completions",
      apiKey: "fixture-key",
      baseUrl: "http://fixture.invalid",
      models: [
        {
          id: "fixture",
          name: "Fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 4096,
        },
      ],
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        const turn = turns++;
        // Each run: one tool call, then whatever the script says.
        const reply = turn % 2 === 1 ? replies[(turn - 1) / 2] : undefined;
        const content: AssistantMessage["content"] =
          reply === undefined
            ? [{ type: "toolCall", id: `look-${turn}`, name: "lookup", arguments: {} }]
            : reply === "answer"
              ? [{ type: "text", text: "Here is the answer." }]
              : [];
        const message: AssistantMessage = {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: reply === undefined ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end(message);
        return stream;
      },
    });
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(dir),
      modelRuntime: runtime,
      model: runtime.getModel("empty-fixture", "fixture"),
      thinkingLevel: "off",
      tools: ["lookup"],
      customTools: [
        {
          name: "lookup",
          label: "Lookup",
          description: "Test-only lookup",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text" as const, text: "found it" }] }),
        },
      ],
    });
    dispose = () => session.dispose();
    const uiContext = new Proxy(
      {
        notify: (text: string, level?: string) => notices.push({ text, level }),
      } as Record<string, unknown>,
      { get: (t, p) => (p in t ? t[p as string] : () => undefined) },
    ) as unknown as ExtensionUIContext;
    await session.bindExtensions({ uiContext });
    await session.prompt("What did you find?");
    // The retry is a follow-up released after the run settles.
    for (let i = 0; i < 50 && (session.isStreaming || turns < replies.length * 2); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await session.agent.waitForIdle?.();
    return { notices, prompts, turns };
  } finally {
    setActiveFollowUpDelivery(null);
    dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("empty completion through the Pi runtime (#605)", () => {
  it("says so and asks the model once more for its answer", async () => {
    const { notices, prompts, turns } = await runEmptyAfterTools(["empty", "answer"]);
    expect(notices).toEqual([{ text: EMPTY_COMPLETION_RETRYING, level: "warning" }]);
    expect(prompts).toEqual(["What did you find?", EMPTY_COMPLETION_NUDGE]);
    expect(turns).toBe(4);
  }, 20_000);

  it("gives up visibly when the retry is empty too", async () => {
    const { notices, prompts, turns } = await runEmptyAfterTools(["empty", "empty"]);
    expect(notices).toEqual([
      { text: EMPTY_COMPLETION_RETRYING, level: "warning" },
      { text: EMPTY_COMPLETION_GAVE_UP, level: "error" },
    ]);
    expect(prompts).toEqual(["What did you find?", EMPTY_COMPLETION_NUDGE]);
    expect(turns).toBe(4);
  }, 20_000);
});
