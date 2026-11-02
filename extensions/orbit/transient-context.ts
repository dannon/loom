/**
 * Puts a per-call message just before the user's last turn, or last when there
 * is none yet. What goes in this way is project or harness data, often
 * agent-writable, so it mustn't take the final, highest-attention slot from the
 * user's own request.
 */
export function insertBeforeLastUser<M extends { role: string }>(messages: M[], msg: M): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      messages.splice(i, 0, msg);
      return;
    }
  }
  messages.push(msg);
}
