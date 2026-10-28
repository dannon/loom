import { describe, it, expect } from "vitest";
import { renderUsageTable, sumUsage } from "../evals/lib/usage";
import type { AnyEvent, ScenarioRun } from "../evals/lib/types";

function turnEnd(
  usage: Record<string, unknown>,
  role = "assistant",
  stopReason = "stop",
): AnyEvent {
  return { type: "turn_end", message: { role, usage, stopReason }, toolResults: [] };
}

function run(modelId: string | null, events: AnyEvent[]): ScenarioRun {
  return {
    scenarioDir: "/tmp/s",
    scenario: { name: "s", tier: 2, requiresModel: true, inputs: ["x"], assertions: {} },
    model: modelId ? { id: modelId, provider: "p", model: "m" } : null,
    exitCode: 0,
    events,
    stdout: "",
    stderr: "",
    notebookContent: null,
    activityEvents: [],
    failures: [],
    durationMs: 1,
  };
}

describe("sumUsage", () => {
  it("sums every model call, not just the first", () => {
    const u = sumUsage([
      { type: "turn_start" },
      turnEnd({ input: 10, output: 1, cacheRead: 0, cacheWrite: 50, totalTokens: 61 }),
      { type: "message_end", message: { role: "assistant", usage: { input: 999 } } },
      turnEnd({ input: 2, output: 3, cacheRead: 50, cacheWrite: 0, totalTokens: 55 }),
      turnEnd({ input: 4, output: 5, cacheRead: 50, cacheWrite: 10, totalTokens: 69 }),
    ]);
    expect(u).toEqual({
      calls: 3,
      errors: 0,
      input: 16,
      output: 9,
      cacheRead: 100,
      cacheWrite: 60,
      totalTokens: 185,
      cost: 0,
    });
  });

  it("reads cost.total and treats missing fields as zero", () => {
    const u = sumUsage([turnEnd({ output: 4, cost: { total: 0.5 } })]);
    expect(u).toMatchObject({ calls: 1, input: 0, output: 4, cost: 0.5 });
  });

  it("counts failed calls (a 429, say) as calls and as errors", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    const u = sumUsage([
      turnEnd(zero, "assistant", "error"),
      turnEnd(zero, "assistant", "aborted"),
      turnEnd({ input: 5, output: 1, totalTokens: 6 }),
    ]);
    expect(u).toMatchObject({ calls: 3, errors: 2, input: 5, totalTokens: 6 });
  });

  it("returns null when no model call reported usage", () => {
    expect(sumUsage([])).toBeNull();
    // the shape the old reader expected: usage on the event itself is not pi's
    expect(sumUsage([{ type: "turn_end", usage: { input: 10 } }])).toBeNull();
    expect(sumUsage([turnEnd({ input: 10 }, "user")])).toBeNull();
  });
});

describe("renderUsageTable", () => {
  it("groups runs by model and skips runs without usage", () => {
    const table = renderUsageTable([
      run("b", [turnEnd({ input: 1000, output: 10, totalTokens: 1010 })]),
      run("a", [turnEnd({ input: 2000, output: 20, totalTokens: 2020 })]),
      run("a", [turnEnd({ input: 2000, output: 20, totalTokens: 2020 })]),
      run(null, []),
    ]);
    expect(table).not.toBeNull();
    const rows = table!.split("\n").filter((l) => /^\| [ab] \|/.test(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^\| a \| 2 \| 2 \| 0 \| 4\.0K \|/);
    expect(rows[0]).toContain("| 4.0K | 2.0K |"); // total, then average per run
    expect(rows[1]).toMatch(/^\| b \| 1 \| 1 \|/);
  });

  it("returns null when no run reported usage", () => {
    expect(renderUsageTable([run(null, [])])).toBeNull();
  });
});
