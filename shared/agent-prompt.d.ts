export interface AgentPromptOptions {
  streamingBehavior?: "steer" | "followUp";
}

export function agentPromptPayload(
  message: string,
  options?: AgentPromptOptions,
): { type: "prompt"; message: string; streamingBehavior: "steer" | "followUp" };
