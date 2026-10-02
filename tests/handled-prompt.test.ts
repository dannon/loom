import { describe, expect, it } from "vitest";
import { isHandledPrompt } from "../app/src/renderer/handled-prompt.js";

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
