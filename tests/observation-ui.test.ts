import { describe, it, expect, vi } from "vitest";
import {
  PRIVACY_STATEMENT,
  renderObservationForConfirm,
  confirmObservation,
  DESCRIPTION_SYSTEM_PROMPT,
  describeFactsPrompt,
  describeWithModel,
  describeObservation,
} from "../extensions/loom/observation-ui.js";
import type { Observation } from "../shared/observation-contract.js";
import type { ObservationFacts } from "../extensions/loom/observations.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const obs: Observation = {
  schemaVersion: 1,
  id: "550e8400-e29b-41d4-a716-446655440000",
  clientTs: "2026-09-30T12:00:00.000Z",
  client: { app: "loom-cli", version: "0.8.0", platform: "darwin" },
  installToken: "a".repeat(32),
  kind: "tool-error",
  stage: "tool-parameterization",
  trigger: "tool_error",
  tools: [{ id: "Filter1", version: "1.1.1" }],
  mcpTool: "galaxy_run_tool",
  datatypes: ["tabular"],
  signature: "ToolExecutionError: dataset <id> failed",
  galaxy: { server: "usegalaxy.org" },
  description: "A filter step refused a header-only table.",
};

const facts: ObservationFacts = {
  kind: "tool-error",
  trigger: "tool_error",
  mcpTool: "galaxy_run_tool",
  toolIds: ["Filter1"],
  datatypes: ["tabular"],
  rawSignature: "ToolExecutionError: dataset 2a56fb8e4c1d9f70b3ac55e1d2f80911 failed",
};

describe("renderObservationForConfirm", () => {
  it("shows every field that will be sent", () => {
    const text = renderObservationForConfirm(obs);
    for (const needle of [
      "kind: tool-error",
      "stage: tool-parameterization",
      "trigger: tool_error",
      "galaxy server: usegalaxy.org",
      "mcp tool: galaxy_run_tool",
      "galaxy tools: Filter1 1.1.1",
      "datatypes: tabular",
      "signature: ToolExecutionError: dataset <id> failed",
      "description: A filter step refused a header-only table.",
      "client: loom-cli 0.8.0 darwin",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("never prints the install token value", () => {
    const text = renderObservationForConfirm(obs);
    expect(text).not.toContain("a".repeat(32));
    expect(text).toContain("install token:");
  });

  it("renders an empty description and absent optionals readably", () => {
    const text = renderObservationForConfirm({
      ...obs,
      description: "",
      mcpTool: undefined,
      tools: [],
      datatypes: [],
      galaxy: { server: "private" },
    });
    expect(text).toContain("description: (none)");
    expect(text).toContain("galaxy tools: (none)");
    expect(text).toContain("galaxy server: private");
  });
});

describe("confirmObservation", () => {
  it("puts the payload in the confirm and returns the answer", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const ctx = { hasUI: true, ui: { confirm } } as unknown as ExtensionContext;
    expect(await confirmObservation(obs, ctx)).toBe(true);
    const [title, message] = confirm.mock.calls[0];
    expect(String(title)).toMatch(/send this/i);
    expect(String(message)).toContain("signature: ToolExecutionError: dataset <id> failed");
    expect(String(message)).toContain(PRIVACY_STATEMENT);
  });

  it("returns false rather than throwing when the UI is gone", async () => {
    const ctx = {
      hasUI: true,
      ui: {
        confirm: () => {
          throw new Error("stale context");
        },
      },
    } as unknown as ExtensionContext;
    expect(await confirmObservation(obs, ctx)).toBe(false);
  });
});

describe("describeFactsPrompt", () => {
  it("hands the model the normalized signature, never the raw text", () => {
    const prompt = describeFactsPrompt(facts);
    expect(prompt).toContain("ToolExecutionError: dataset <id> failed");
    expect(prompt).not.toContain("2a56fb8e4c1d9f70b3ac55e1d2f80911");
    expect(prompt).toContain("galaxy_run_tool");
    expect(prompt).toContain("Filter1");
  });

  it("names the rules in the system prompt", () => {
    for (const needle of ["500", "no URLs", "no file paths", "no dataset"]) {
      expect(DESCRIPTION_SYSTEM_PROMPT, needle).toContain(needle);
    }
  });
});

describe("describeWithModel", () => {
  it("returns a clean one-liner", async () => {
    const out = await describeWithModel(
      facts,
      async () => "  A filter step refused a table with only a header row.\n",
    );
    expect(out).toBe("A filter step refused a table with only a header row.");
  });

  it("drops a description that would not pass the validator", async () => {
    for (const bad of [
      "see https://usegalaxy.org/api for details",
      "wrote /Users/alice/run.log",
      "dataset 42 was empty",
      "résultat manquant",
      "mail alice@institute.edu",
      "the run on galaxy.cancer-center.internal timed out",
      "job 3f2b8c1a-1234-4abc-8def-a123b56c89ab was lost",
    ]) {
      expect(await describeWithModel(facts, async () => bad), bad).toBe("");
    }
  });

  it("takes only the first line and caps the length", async () => {
    const out = await describeWithModel(facts, async () => "first line\nsecond line");
    expect(out).toBe("first line");
    const long = await describeWithModel(facts, async () => "x".repeat(900));
    expect(long).toHaveLength(500);
  });

  it("gives up at the deadline even if the provider ignores the abort", async () => {
    const started = Date.now();
    const out = await describeWithModel(facts, () => new Promise<string>(() => {}), 50);
    expect(out).toBe("");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("returns empty on a model failure or an empty answer", async () => {
    expect(
      await describeWithModel(facts, async () => {
        throw new Error("provider down");
      }),
    ).toBe("");
    expect(await describeWithModel(facts, async () => "   ")).toBe("");
  });
});

describe("describeObservation", () => {
  it("asks the user in ask mode, validating and re-prompting once", async () => {
    const input = vi
      .fn()
      .mockResolvedValueOnce("the run for alice@institute.edu failed")
      .mockResolvedValueOnce("A paired-end input was rejected.");
    const notify = vi.fn();
    const ctx = { hasUI: true, ui: { input, notify } } as unknown as ExtensionContext;
    expect(await describeObservation("ask", facts, ctx)).toBe("A paired-end input was rejected.");
    expect(input).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("left blank"), "warning");
  });

  it("accepts an empty answer in ask mode without nagging", async () => {
    const input = vi.fn().mockResolvedValue("");
    const ctx = { hasUI: true, ui: { input, notify: vi.fn() } } as unknown as ExtensionContext;
    expect(await describeObservation("ask", facts, ctx)).toBe("");
    expect(input).toHaveBeenCalledOnce();
  });

  it("gives up after the second bad answer", async () => {
    const input = vi.fn().mockResolvedValue("mail alice@institute.edu");
    const ctx = { hasUI: true, ui: { input, notify: vi.fn() } } as unknown as ExtensionContext;
    expect(await describeObservation("ask", facts, ctx)).toBe("");
    expect(input).toHaveBeenCalledTimes(2);
  });

  it("in auto mode calls the session's model registry, bounded, with only the normalized fields", async () => {
    const complete = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "A filter step rejected its input." }],
    });
    const ctx = {
      hasUI: false,
      model: { id: "m", provider: "p" },
      modelRegistry: { complete },
    } as unknown as ExtensionContext;
    expect(await describeObservation("auto", facts, ctx)).toBe("A filter step rejected its input.");
    const [model, context, options] = complete.mock.calls[0];
    expect(model).toEqual({ id: "m", provider: "p" });
    expect(JSON.stringify(context)).not.toContain("2a56fb8e4c1d9f70b3ac55e1d2f80911");
    expect(options.maxTokens).toBeGreaterThan(0);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns empty in off mode and with no model in auto mode", async () => {
    const ctx = { hasUI: false, model: undefined } as unknown as ExtensionContext;
    expect(await describeObservation("off", facts, ctx)).toBe("");
    expect(await describeObservation("auto", facts, ctx)).toBe("");
  });
});
