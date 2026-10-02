/**
 * pi (0.99+) answers a prompt that an extension command consumed with
 * `{disposition: "handled"}` and starts no turn for it -- so no agent_end
 * follows to clear the thinking state the send path set.
 */
export function isHandledPrompt(event: Record<string, unknown>): boolean {
  const data = event.data as { disposition?: unknown } | undefined;
  return event.command === "prompt" && event.success !== false && data?.disposition === "handled";
}
