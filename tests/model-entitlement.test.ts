import { describe, expect, it } from "vitest";
import {
  UnavailableModels,
  chatGptPlanRejection,
  unavailableModelLabel,
} from "../app/src/renderer/model-entitlement.js";
import { humanizeAgentError } from "../app/src/renderer/chat/error-humanizer.js";

// What pi's openai-codex stream raised for Scott (#609).
const STREAM_REJECTION =
  "Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.";
// The same refusal arriving as an HTTP error body.
const HTTP_REJECTION =
  '400: {"detail":"The \'gpt-5.3-codex-spark\' model is not supported when using Codex with a ChatGPT account."}';

describe("chatGptPlanRejection", () => {
  it("names the refused model from the stream error", () => {
    expect(chatGptPlanRejection(STREAM_REJECTION)).toEqual({ model: "gpt-5.3-codex-spark" });
  });

  it("names the refused model from an HTTP error body", () => {
    expect(chatGptPlanRejection(HTTP_REJECTION)).toEqual({ model: "gpt-5.3-codex-spark" });
  });

  it("still matches when the model id is missing", () => {
    expect(
      chatGptPlanRejection("This model is not supported when using Codex with a ChatGPT account."),
    ).toEqual({});
  });

  it("ignores other errors", () => {
    expect(chatGptPlanRejection("You have hit your ChatGPT usage limit.")).toBeNull();
    expect(chatGptPlanRejection(undefined)).toBeNull();
  });
});

describe("humanizeAgentError on a ChatGPT-plan rejection", () => {
  for (const [name, raw] of [
    ["stream", STREAM_REJECTION],
    ["HTTP body", HTTP_REJECTION],
  ] as const) {
    it(`explains the ${name} form and points at Preferences`, () => {
      const h = humanizeAgentError(raw);
      expect(h.retriable).toBe(false);
      expect(h.text).toContain("gpt-5.3-codex-spark");
      expect(h.text).toMatch(/ChatGPT/);
      expect(h.text).toMatch(/Preferences/);
      expect(h.text).not.toContain("Codex error:");
    });
  }
});

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("UnavailableModels", () => {
  it("remembers a refused model per provider", () => {
    const store = memoryStore();
    new UnavailableModels(store).mark("openai-codex", "gpt-5.3-codex-spark");
    const fresh = new UnavailableModels(store);
    expect(fresh.has("openai-codex", "gpt-5.3-codex-spark")).toBe(true);
    expect(fresh.has("openai", "gpt-5.3-codex-spark")).toBe(false);
    expect(fresh.has("openai-codex", "gpt-5.6-terra")).toBe(false);
  });

  it("forgets one model, or the whole provider", () => {
    const m = new UnavailableModels(memoryStore());
    m.mark("openai-codex", "a");
    m.mark("openai-codex", "b");
    m.clear("openai-codex", "a");
    expect(m.has("openai-codex", "a")).toBe(false);
    expect(m.has("openai-codex", "b")).toBe(true);
    m.clear("openai-codex");
    expect(m.has("openai-codex", "b")).toBe(false);
  });

  // Storage can be missing, blocked or hand-mangled; the picker should just
  // go unmarked rather than break.
  it("survives missing, throwing or corrupt storage", () => {
    expect(() => new UnavailableModels(undefined).mark("p", "m")).not.toThrow();
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const m = new UnavailableModels(throwing);
    expect(() => m.mark("p", "m")).not.toThrow();
    expect(m.has("p", "m")).toBe(false);
    const corrupt = memoryStore();
    corrupt.setItem("orbit.unavailableModels", "not json");
    expect(new UnavailableModels(corrupt).has("p", "m")).toBe(false);
  });

  it("labels a marked model", () => {
    expect(unavailableModelLabel("GPT-5.3 Codex Spark")).toBe(
      "GPT-5.3 Codex Spark — not available on your ChatGPT account",
    );
  });
});
