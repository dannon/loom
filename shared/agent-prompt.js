/**
 * A renderer can briefly think a turn is idle after an `agent_end` from a
 * failed model attempt, while Pi is already retrying. Always supply a queue
 * policy: Pi ignores it when idle and queues behind an active turn otherwise.
 *
 * @param {string} message
 * @param {{ streamingBehavior?: "steer" | "followUp" }} [options]
 */
export function agentPromptPayload(message, options) {
  return {
    type: "prompt",
    message,
    streamingBehavior: options?.streamingBehavior === "steer" ? "steer" : "followUp",
  };
}
