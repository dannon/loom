import { describe, expect, it } from "vitest";
import { setupContextInjection } from "../extensions/orbit/context";

/**
 * Issue #320 (angle 2): asked to "save the chat history to a file", the agent
 * streamed a confident "...saved as chat_history.md" and then the turn ended on
 * an opaque provider error -- with no file written. Two behaviors need steering:
 * (1) never claim a save that a write tool didn't actually perform, and
 * (2) reproducing a whole transcript verbatim is itself a recitation-stop
 * trigger, so route the user to the real export affordance / prefer a summary.
 *
 * These are regression guards: prompt content can't assert model *behavior*,
 * but they fail loudly if the steer is silently dropped or reworded away from
 * its load-bearing phrases. Matching is whitespace-normalized so a benign
 * reflow of the prose doesn't break them.
 */
async function assembledPrompt(): Promise<string> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(event, handler);
    },
  };
  setupContextInjection(pi as any);
  const { systemPrompt } = (await handlers.get("before_agent_start")!({}, {})) as {
    systemPrompt: string;
  };
  return systemPrompt.replace(/\s+/g, " ");
}

describe("save-claim honesty guardrail (issue #320 angle 2)", () => {
  it("forbids claiming a save the agent didn't actually make", async () => {
    const prompt = await assembledPrompt();
    expect(prompt).toContain(
      "Never tell the user something was saved unless a write tool actually ran and succeeded",
    );
  });

  it("ties a successful write back to the verification discipline (not a free pass)", async () => {
    const prompt = await assembledPrompt();
    expect(prompt).toContain("Verification before completion");
  });

  it("explains the recitation/verbatim stop that surfaces as an opaque error", async () => {
    const prompt = await assembledPrompt();
    expect(prompt).toContain("recitation");
  });

  it("routes a full transcript to the chat-export button, not hand reconstruction", async () => {
    const prompt = await assembledPrompt();
    expect(prompt).toContain("chat-export button in the Chat pane header");
    expect(prompt).toContain("rather than reconstructing it by hand");
  });

  it("prefers a summary or excerpt over echoing every message verbatim", async () => {
    const prompt = await assembledPrompt();
    expect(prompt).toContain("summary or a specific excerpt");
  });
});
