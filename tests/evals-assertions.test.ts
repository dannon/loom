import { describe, it, expect } from "vitest";
import { evaluate } from "../evals/lib/assertions";
import type { AnyEvent, Assertions, ModelEntry, ScenarioRun } from "../evals/lib/types";

function textEvents(text: string): AnyEvent[] {
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
    { type: "turn_end" },
  ];
}

function makeRun(opts: {
  events?: AnyEvent[];
  notebookContent?: string | null;
  assertions: Assertions;
  model?: ModelEntry | null;
}): ScenarioRun {
  return {
    scenarioDir: "/tmp/x",
    scenario: {
      name: "test",
      tier: 2,
      inputs: ["go"],
      assertions: opts.assertions,
    },
    model: opts.model ?? null,
    exitCode: 0,
    events: opts.events ?? [],
    stdout: "",
    stderr: "",
    notebookContent: opts.notebookContent ?? null,
    failures: [],
    durationMs: 1,
  };
}

describe("evals assertions: dimension tagging", () => {
  it("tags a routing failure as 'routing' and a validity failure as 'validity'", () => {
    const run = makeRun({
      notebookContent: "## Plan 1: Thing [local]\n- [ ] 1. **Do** -- a real description here",
      assertions: { notebook: { plan: { routingIn: ["galaxy"], minPendingSteps: 3 } } },
    });
    const failures = evaluate(run);
    const routing = failures.find((f) => f.assertion.endsWith("routingIn"));
    const validity = failures.find((f) => f.assertion.endsWith("minPendingSteps"));
    expect(routing?.dimension).toBe("routing");
    expect(validity?.dimension).toBe("validity");
  });

  it("tags exitCode failures as 'other'", () => {
    const run = makeRun({ assertions: { exitCode: 0 } });
    run.exitCode = 1;
    const failures = evaluate(run);
    expect(failures[0].dimension).toBe("other");
  });
});

describe("evals assertions: tool mentions", () => {
  const nb = (body: string) => `## Plan 1: Metagenomics [galaxy]\n- [ ] 1. **Classify** -- ${body}`;

  it("passes when the plan mentions one of the allowed tools (case-insensitive)", () => {
    const run = makeRun({
      notebookContent: nb("run kraken2 to assign taxonomy to reads"),
      assertions: { notebook: { plan: { mentionsOneOf: ["Kraken", "MetaPhlAn"] } } },
    });
    expect(evaluate(run)).toHaveLength(0);
  });

  it("fails (dimension tools) when none of the allowed tools appear", () => {
    const run = makeRun({
      notebookContent: nb("eyeball the reads and guess the organisms"),
      assertions: { notebook: { plan: { mentionsOneOf: ["Kraken", "MetaPhlAn"] } } },
    });
    const f = evaluate(run);
    expect(f).toHaveLength(1);
    expect(f[0].dimension).toBe("tools");
    expect(f[0].assertion).toContain("mentionsOneOf");
  });

  it("fails when a banned tool is named", () => {
    const run = makeRun({
      notebookContent: nb("BLAST every read against nt, no classifier"),
      assertions: { notebook: { plan: { mentionsNoneOf: ["BLAST"] } } },
    });
    const f = evaluate(run);
    expect(f).toHaveLength(1);
    expect(f[0].dimension).toBe("tools");
    expect(f[0].assertion).toContain("mentionsNoneOf");
  });
});

describe("evals assertions: source-aware plan (Assertions.plan)", () => {
  it("reads the notebook plan when source defaults to 'any' and notebook has one", () => {
    const run = makeRun({
      events: textEvents("Here is a draft idea, no formal plan."),
      notebookContent: "## Plan 1: Real [galaxy]\n- [ ] 1. **Align** -- HISAT2 over hg38 reads",
      assertions: { plan: { routingIn: ["galaxy"], mentionsOneOf: ["HISAT2"] } },
    });
    expect(evaluate(run)).toHaveLength(0);
  });

  it("falls back to chat when no notebook plan exists", () => {
    const run = makeRun({
      events: textEvents("## Plan 1: Chatted [local]\n- [ ] 1. **Rename** -- tidy the files up"),
      notebookContent: null,
      assertions: { plan: { routingIn: ["local"] } },
    });
    expect(evaluate(run)).toHaveLength(0);
  });

  it("honors an explicit source: 'chat' and does not read the notebook", () => {
    const run = makeRun({
      events: textEvents("## Plan 1: Chatted [hybrid]\n- [ ] 1. **Step** -- do the thing here"),
      notebookContent: "## Plan 1: Notebook [galaxy]\n- [ ] 1. **Step** -- other thing here",
      assertions: { plan: { source: "chat", routingIn: ["galaxy"] } },
    });
    // chat routing is hybrid; expected galaxy -> exactly one routing failure.
    // If `plan` is unimplemented this yields 0 failures and the test fails.
    const f = evaluate(run);
    expect(f).toHaveLength(1);
    expect(f[0].dimension).toBe("routing");
  });
});

describe("evals assertions: behavior asksClarifyingQuestion", () => {
  it("passes when the agent asks a question and writes no plan", () => {
    const run = makeRun({
      events: textEvents("Happy to help! What data do you have, and what's the goal?"),
      notebookContent: null,
      assertions: { behavior: { asksClarifyingQuestion: true } },
    });
    expect(evaluate(run)).toHaveLength(0);
  });

  it("fails (behavior) when the agent fabricates a plan instead of asking", () => {
    const run = makeRun({
      events: textEvents("## Plan 1: Guessed [galaxy]\n- [ ] 1. **Align** -- assume RNA-seq here"),
      notebookContent: null,
      assertions: { behavior: { asksClarifyingQuestion: true } },
    });
    const f = evaluate(run);
    expect(f.some((x) => x.dimension === "behavior")).toBe(true);
  });

  it("fails when the agent neither asks nor errors out (no question mark)", () => {
    const run = makeRun({
      events: textEvents("Okay."),
      notebookContent: null,
      assertions: { behavior: { asksClarifyingQuestion: true } },
    });
    const f = evaluate(run);
    expect(f.some((x) => x.assertion.includes("asksClarifyingQuestion"))).toBe(true);
  });
});

describe("evals assertions: null notebook content with plan assertions", () => {
  it("produces validity, routing, AND tools failures when notebook is absent but plan assertions are declared", () => {
    // When notebookContent is null and notebook.plan is declared, the old code
    // pushed only a single generic 'other' failure and returned early, leaving
    // routing and tools dimensions showing false green on the leaderboard.
    const run = makeRun({
      notebookContent: null,
      assertions: {
        notebook: {
          plan: {
            exists: true,
            routingIn: ["galaxy"],
            mentionsOneOf: ["STAR"],
          },
        },
      },
    });
    const failures = evaluate(run);
    const dims = new Set(failures.map((f) => f.dimension));
    expect(dims).toContain("validity");
    expect(dims).toContain("routing");
    expect(dims).toContain("tools");
  });
});

describe("evals assertions: null plan fails all declared dimensions", () => {
  it("produces validity, routing, AND tools failures when no plan is found", () => {
    // A run with no plan anywhere -- empty events, null notebookContent.
    // The scenario declares routing and tools assertions alongside exists.
    // Before the fix, only a single validity failure was pushed; routing and
    // tools dimensions were silently skipped, making the leaderboard look green.
    const run = makeRun({
      events: [],
      notebookContent: null,
      assertions: {
        plan: {
          exists: true,
          routingIn: ["galaxy"],
          minPendingSteps: 4,
          mentionsOneOf: ["STAR"],
        },
      },
    });
    const failures = evaluate(run);
    const dims = new Set(failures.map((f) => f.dimension));
    expect(dims).toContain("validity");
    expect(dims).toContain("routing");
    expect(dims).toContain("tools");
  });
});

describe("evals assertions: chatText regex matchers", () => {
  it("matches a YAML value across quoting and spacing variants", () => {
    const pattern = "container:\\s*[\"']?(?:docker://)?quay\\.io/biocontainers/";
    for (const draft of [
      "container: quay.io/biocontainers/pandas:1.5.2",
      'container: "quay.io/biocontainers/pandas:1.5.2"',
      "container:  docker://quay.io/biocontainers/pandas:1.5.2",
    ]) {
      const run = makeRun({
        events: textEvents(draft),
        assertions: { chatText: { mustMatch: [pattern] } },
      });
      expect(evaluate(run), draft).toHaveLength(0);
    }
  });

  it("fails when nothing matches", () => {
    const run = makeRun({
      events: textEvents("container: python:3.12-slim"),
      assertions: { chatText: { mustMatch: ["container:\\s*quay\\.io/biocontainers/"] } },
    });
    const f = evaluate(run);
    expect(f).toHaveLength(1);
    expect(f[0].assertion).toBe("chatText.mustMatch");
  });

  it("mustNotMatch fires only on a real match", () => {
    const assertions: Assertions = { chatText: { mustNotMatch: ["^\\s*command:\\s*seqkit"] } };
    expect(evaluate(makeRun({ events: textEvents("no command here"), assertions }))).toHaveLength(
      0,
    );
    expect(
      evaluate(makeRun({ events: textEvents("command: seqkit seq"), assertions })),
    ).toHaveLength(1);
  });

  it("records an invalid pattern as a failure instead of throwing", () => {
    const run = makeRun({
      events: textEvents("anything"),
      assertions: { chatText: { mustMatch: ["("] } },
    });
    const f = evaluate(run);
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("invalid regex");
  });
});

describe("evals assertions: infra vs capability", () => {
  const model: ModelEntry = { id: "tacc:qwen3-32b", provider: "tacc", model: "Qwen3-32B" };

  it("names a tier-2 run that produced no assistant text", () => {
    const run = makeRun({
      events: [{ type: "agent_start" }],
      model,
      assertions: { chatText: { mustInclude: ["ALPHATAU"] } },
    });
    const f = evaluate(run);
    expect(f.map((x) => x.assertion)).toContain("run.noModelOutput");
    expect(f[0].detail).toContain("check credentials/proxy");
  });

  it("stays quiet when the model did answer", () => {
    const run = makeRun({
      events: textEvents("ALPHATAU"),
      model,
      assertions: { chatText: { mustInclude: ["ALPHATAU"] } },
    });
    expect(evaluate(run)).toHaveLength(0);
  });

  it("stays quiet on tier-1 scenarios, which have no model", () => {
    const run = makeRun({ events: [], assertions: { exitCode: 0 } });
    expect(evaluate(run)).toHaveLength(0);
  });
});

describe("evals assertions: stripThinkingTags", () => {
  const model: ModelEntry = {
    id: "tacc:qwen3-32b",
    provider: "tacc",
    model: "Qwen3-32B",
    stripThinkingTags: true,
  };

  it("strips a closed think block", () => {
    const run = makeRun({
      events: textEvents("<think>maybe container: python:3.12</think>the answer"),
      model,
      assertions: { chatText: { mustNotInclude: ["python:3.12"], mustInclude: ["the answer"] } },
    });
    expect(evaluate(run)).toHaveLength(0);
  });

  it("strips an unterminated block from a run killed at the timeout", () => {
    // Llama-3.3-70B does exactly this: SIGTERM lands mid-thought, so there is
    // no closing tag and the raw reasoning used to be graded as the answer.
    const run = makeRun({
      events: textEvents("<think>let me try container: quay.io/biocontainers/pandas"),
      model,
      assertions: { chatText: { mustInclude: ["quay.io/biocontainers"] } },
    });
    const f = evaluate(run);
    expect(f.map((x) => x.assertion)).toContain("chatText.mustInclude");
  });
});
