import { describe, expect, it } from "vitest";
import { isHandledPrompt, promptStartsNoTurn } from "../shared/handled-prompt.js";

describe("isHandledPrompt", () => {
  it("recognizes a prompt an extension command consumed", () => {
    expect(
      isHandledPrompt({
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "handled" },
      }),
    ).toBe(true);
  });

  it("ignores prompts that start or queue a run, and other commands", () => {
    const base = { type: "response", command: "prompt", success: true };
    expect(isHandledPrompt({ ...base, data: { disposition: "started" } })).toBe(false);
    expect(isHandledPrompt({ ...base, data: { disposition: "queued" } })).toBe(false);
    expect(isHandledPrompt({ ...base, command: "steer", data: { disposition: "handled" } })).toBe(
      false,
    );
    expect(isHandledPrompt({ ...base, success: false, data: { disposition: "handled" } })).toBe(
      false,
    );
  });

  it("is a no-op for pi versions that send no disposition", () => {
    expect(isHandledPrompt({ type: "response", command: "prompt", success: true })).toBe(false);
  });
});

describe("promptStartsNoTurn", () => {
  it("covers handled commands and rejected prompts only", () => {
    const base = { type: "response", command: "prompt" };
    expect(promptStartsNoTurn({ ...base, success: true, data: { disposition: "handled" } })).toBe(
      true,
    );
    expect(promptStartsNoTurn({ ...base, success: false, error: "Preflight failed" })).toBe(true);
    expect(promptStartsNoTurn({ ...base, success: true, data: { disposition: "started" } })).toBe(
      false,
    );
    expect(promptStartsNoTurn({ ...base, success: true })).toBe(false);
    expect(promptStartsNoTurn({ ...base, command: "steer", success: false })).toBe(false);
  });
});
