import { describe, expect, it, vi } from "vitest";
import { createModalClaim } from "../app/src/renderer/ext-modal-claim";

describe("extension dialogs, one at a time", () => {
  it("a newer dialog cancels the one it replaces before taking the buttons", () => {
    const claim = createModalClaim();
    const cancelFirst = vi.fn();
    claim(cancelFirst);
    const cancelSecond = vi.fn();
    claim(cancelSecond);
    expect(cancelFirst).toHaveBeenCalledTimes(1);
    expect(cancelSecond).not.toHaveBeenCalled();
  });

  it("a dialog that already answered is not cancelled later", () => {
    const claim = createModalClaim();
    const cancelFirst = vi.fn();
    const release = claim(cancelFirst);
    release();
    claim(vi.fn());
    expect(cancelFirst).not.toHaveBeenCalled();
  });

  it("an old dialog's late release doesn't free the newer one", () => {
    const claim = createModalClaim();
    const releaseFirst = claim(() => releaseFirst());
    const cancelSecond = vi.fn();
    claim(cancelSecond);
    releaseFirst();
    const cancelThird = vi.fn();
    claim(cancelThird);
    expect(cancelSecond).toHaveBeenCalledTimes(1);
  });
});
