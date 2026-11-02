import { describe, expect, it, vi } from "vitest";
import { requestAttentionFor, waitsOnUser } from "../app/src/main/ui-attention";

function win(focused: boolean) {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    isDestroyed: () => false,
    isFocused: () => focused,
    flashFrame: vi.fn(),
    once: (_e: "focus", l: () => void) => listeners.push(l),
    focus: () => listeners.splice(0).forEach((l) => l()),
  };
}

describe("asking for attention when the brain waits on a dialog", () => {
  it("only dialogs the brain blocks on wait on the user", () => {
    for (const method of ["confirm", "select", "input"]) expect(waitsOnUser({ method })).toBe(true);
    // The renderer has no editor dialog, so there'd be nothing to look at.
    for (const method of ["editor", "notify", "setStatus", "setWidget", undefined])
      expect(waitsOnUser({ method })).toBe(false);
  });

  it("flashes an unfocused window for a confirm, and stops once it's focused", () => {
    const w = win(false);
    requestAttentionFor(w, { method: "confirm" });
    expect(w.flashFrame).toHaveBeenLastCalledWith(true);
    w.focus();
    expect(w.flashFrame).toHaveBeenLastCalledWith(false);
  });

  it("leaves a focused window, and a notify, alone", () => {
    const focused = win(true);
    requestAttentionFor(focused, { method: "confirm" });
    const background = win(false);
    requestAttentionFor(background, { method: "notify" });
    expect(focused.flashFrame).not.toHaveBeenCalled();
    expect(background.flashFrame).not.toHaveBeenCalled();
  });

  it("adds one focus listener however many dialogs arrive in the background", () => {
    const w = win(false);
    requestAttentionFor(w, { method: "confirm" });
    requestAttentionFor(w, { method: "select" });
    expect(w.listeners).toHaveLength(1);
    w.focus();
    requestAttentionFor(w, { method: "confirm" });
    expect(w.listeners).toHaveLength(1);
  });
});
