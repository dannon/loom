import { describe, it, expect } from "vitest";
import { loadPiDefaultModels, piDefaultModel } from "../shared/pi-default-model.js";

describe("piDefaultModel", () => {
  const defaults = { anthropic: "claude-opus-4-8", "openai-codex": "gpt-x" };

  it("finds the provider's default, ignoring case the way pi does", () => {
    expect(piDefaultModel("anthropic", defaults)).toBe("claude-opus-4-8");
    expect(piDefaultModel("OpenAI-Codex", defaults)).toBe("gpt-x");
  });

  it("has nothing for an unknown or missing provider, so --provider stays bare and pi refuses it", () => {
    expect(piDefaultModel("typo", defaults)).toBeUndefined();
    expect(piDefaultModel(undefined, defaults)).toBeUndefined();
    expect(piDefaultModel("anthropic", {})).toBeUndefined();
  });
});

describe("loadPiDefaultModels", () => {
  it("reads the installed pi's per-provider defaults", async () => {
    const defaults = await loadPiDefaultModels();
    expect(typeof defaults.anthropic).toBe("string");
    expect(defaults.anthropic.length).toBeGreaterThan(0);
  });

  it("returns an empty table instead of throwing when pi can't be located", async () => {
    const defaults = await loadPiDefaultModels(() => {
      throw new Error("not installed");
    });
    expect(defaults).toEqual({});
  });
});
