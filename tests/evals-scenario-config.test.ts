import { describe, expect, it } from "vitest";
import { assertScenarioConfigIsSafe } from "../evals/lib/runner";

describe("assertScenarioConfigIsSafe", () => {
  it("lets a scenario turn lessons on and pick ask", () => {
    expect(() =>
      assertScenarioConfigIsSafe({ lessons: { enabled: true }, observations: { mode: "ask" } }),
    ).not.toThrow();
    expect(() => assertScenarioConfigIsSafe({})).not.toThrow();
  });

  it("refuses auto and the acknowledgement that would make it live", () => {
    expect(() => assertScenarioConfigIsSafe({ observations: { mode: "auto" } })).toThrow(
      /never be able to send/,
    );
    expect(() =>
      assertScenarioConfigIsSafe({
        observations: { mode: "ask", autoAcknowledgedAt: "2026-01-01T00:00:00Z" },
      }),
    ).toThrow(/never be able to send/);
  });
});
