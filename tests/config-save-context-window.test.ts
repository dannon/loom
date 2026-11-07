import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-ctxwin-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmp);
  // Never probe the keychain; secrets here are plaintext anyway.
  vi.stubEnv("ORBIT_DISABLE_SAFE_STORAGE", "1");
  fs.mkdirSync(path.join(tmp, ".orbit"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".orbit", "config.json"),
    JSON.stringify({
      llm: {
        active: "openai-compatible",
        providers: {
          "openai-compatible": {
            baseUrl: "http://box:11434/v1",
            model: "qwen3:30b",
            apiKey: "k",
            contextWindow: 32768,
          },
        },
      },
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Preferences has no contextWindow field, so the renderer never sends one.
describe("config:save keeps a hand-set context window (#603)", () => {
  it("survives a save that only changes the model", async () => {
    const { reconcileIncomingConfig } = await import("../app/src/main/ipc-handlers.js");
    const out = reconcileIncomingConfig({
      llm: {
        active: "openai-compatible",
        providers: { "openai-compatible": { baseUrl: "http://box:11434/v1", model: "qwen3:8b" } },
      },
    });
    expect(out.llm?.providers?.["openai-compatible"]).toMatchObject({
      model: "qwen3:8b",
      contextWindow: 32768,
    });
  });

  it("survives a save that only adds a trailing slash", async () => {
    const { reconcileIncomingConfig } = await import("../app/src/main/ipc-handlers.js");
    const out = reconcileIncomingConfig({
      llm: {
        active: "openai-compatible",
        providers: { "openai-compatible": { baseUrl: "http://box:11434/v1/" } },
      },
    });
    expect(out.llm?.providers?.["openai-compatible"]?.contextWindow).toBe(32768);
  });

  it("is dropped when the entry moves to a different server", async () => {
    const { reconcileIncomingConfig } = await import("../app/src/main/ipc-handlers.js");
    const out = reconcileIncomingConfig({
      llm: {
        active: "openai-compatible",
        providers: { "openai-compatible": { baseUrl: "http://other:8000/v1" } },
      },
    });
    expect(out.llm?.providers?.["openai-compatible"]?.contextWindow).toBeUndefined();
  });
});
