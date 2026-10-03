/**
 * pi (0.99+) answers a prompt that an extension command consumed with
 * `{disposition: "handled"}` and starts no turn for it -- so no agent_end
 * follows to clear the thinking state the send path set, or to stand down the
 * shell's stall watchdog.
 *
 * @param {Record<string, unknown>} event
 */
export function isHandledPrompt(event) {
  const data = /** @type {{ disposition?: unknown } | undefined} */ (event.data);
  return event.command === "prompt" && event.success !== false && data?.disposition === "handled";
}

/**
 * A prompt response after which no turn is coming: either a command consumed
 * it, or preflight rejected it.
 *
 * @param {Record<string, unknown>} event
 */
export function promptStartsNoTurn(event) {
  return (
    event.type === "response" &&
    event.command === "prompt" &&
    (event.success === false || isHandledPrompt(event))
  );
}
