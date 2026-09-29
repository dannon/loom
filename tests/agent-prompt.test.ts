import { describe, expect, it } from "vitest";
import { agentPromptPayload } from "../shared/agent-prompt.js";

describe("agent prompt handoff", () => {
  it("queues a prompt if the agent becomes busy before it arrives", () => {
    expect(agentPromptPayload("are we done?")).toEqual({
      type: "prompt",
      message: "are we done?",
      streamingBehavior: "followUp",
    });
  });

  it("preserves an explicit steering request", () => {
    expect(agentPromptPayload("stop that job", { streamingBehavior: "steer" })).toEqual({
      type: "prompt",
      message: "stop that job",
      streamingBehavior: "steer",
    });
  });
});
