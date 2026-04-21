import { describe, it, expect, afterEach } from "vitest";
import { buildSessionIndexContext } from "../../extensions/loom/context";

describe("buildSessionIndexContext", () => {
  const original = process.env.LOOM_SESSION_INDEX;
  afterEach(() => {
    if (original === undefined) delete process.env.LOOM_SESSION_INDEX;
    else process.env.LOOM_SESSION_INDEX = original;
  });

  it("returns empty string when flag is off", () => {
    delete process.env.LOOM_SESSION_INDEX;
    expect(buildSessionIndexContext()).toBe("");
  });

  it("returns a prompt block with the three tool names when flag is on", () => {
    process.env.LOOM_SESSION_INDEX = "1";
    const ctx = buildSessionIndexContext();
    expect(ctx).toContain("chat_search");
    expect(ctx).toContain("chat_session_context");
    expect(ctx).toContain("chat_find_tool_calls");
  });
});
