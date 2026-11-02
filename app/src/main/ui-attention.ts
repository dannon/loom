// Extension UI requests the brain stays blocked on until the user answers.
// notify/setStatus/setWidget and friends are fire-and-forget. Only the ones the
// renderer opens a dialog for: flashing for an editor request would point the
// user at a dialog Orbit never shows.
const ANSWER_METHODS = new Set(["confirm", "select", "input"]);

export function waitsOnUser(request: { method?: unknown }): boolean {
  return typeof request.method === "string" && ANSWER_METHODS.has(request.method);
}

type AttentionWindow = {
  isDestroyed(): boolean;
  isFocused(): boolean;
  flashFrame(flag: boolean): void;
  once(event: "focus", listener: () => void): unknown;
};

const stopOnFocus = new WeakSet<AttentionWindow>();

/**
 * A dialog the brain is blocked on can't wait unseen behind another app
 * (#611): flash the taskbar entry until the window is focused. On macOS this
 * is one dock bounce. Elsewhere the flash stops on focus, not when the dialog
 * goes, so one cancelled meanwhile leaves the taskbar flashing until then.
 */
export function requestAttentionFor(win: AttentionWindow, request: { method?: unknown }): void {
  if (!waitsOnUser(request) || win.isDestroyed() || win.isFocused()) return;
  win.flashFrame(true);
  // One listener however many dialogs arrive while the window's in the back.
  if (stopOnFocus.has(win)) return;
  stopOnFocus.add(win);
  win.once("focus", () => {
    stopOnFocus.delete(win);
    if (!win.isDestroyed()) win.flashFrame(false);
  });
}
