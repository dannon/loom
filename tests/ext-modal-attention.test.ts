// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDialogAttention } from "../app/src/renderer/ext-modal-attention";

// #611: an approval dialog opened while focus stayed in the composer, so it was
// easy to keep typing past it without noticing anything was waiting.
describe("a dialog waiting on the user", () => {
  let composer: HTMLTextAreaElement;
  let modal: HTMLElement;
  let banner: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <textarea id="input"></textarea>
      <div id="dialog-waiting" class="hidden"></div>
      <div id="ext-overlay"><div class="modal"><button>Yes</button></div></div>`;
    composer = document.getElementById("input") as HTMLTextAreaElement;
    modal = document.querySelector(".modal") as HTMLElement;
    banner = document.getElementById("dialog-waiting")!;
    composer.focus();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("takes focus off the composer, without focusing a button Enter would press", () => {
    const open = createDialogAttention({ banner });
    open(modal);
    expect(document.activeElement).toBe(modal);
    // happy-dom focuses a bare div anyway; Chromium needs the tabindex.
    expect(modal.getAttribute("tabindex")).toBe("-1");
  });

  it("shows the banner while it waits, and hands focus back once answered", () => {
    const open = createDialogAttention({ banner });
    const close = open(modal);
    expect(banner.classList.contains("hidden")).toBe(false);
    close();
    expect(banner.classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(composer);
  });

  it("keeps the banner up until the last of overlapping dialogs closes", () => {
    const open = createDialogAttention({ banner });
    const closeFirst = open(modal);
    const closeSecond = open(modal);
    closeFirst();
    expect(banner.classList.contains("hidden")).toBe(false);
    closeSecond();
    closeSecond();
    expect(banner.classList.contains("hidden")).toBe(true);
    // A second close of the same dialog must not throw off the next one.
    composer.focus();
    open(modal)();
    expect(document.activeElement).toBe(composer);
  });

  it("doesn't hand focus back to the composer while another dialog still waits", () => {
    const open = createDialogAttention({ banner });
    const closeFirst = open(modal);
    open(modal);
    closeFirst();
    expect(document.activeElement).toBe(modal);
  });

  it("doesn't pull focus back if the user already moved it elsewhere", () => {
    const other = document.createElement("input");
    document.body.appendChild(other);
    const close = createDialogAttention({ banner })(modal);
    other.focus();
    close();
    expect(document.activeElement).toBe(other);
  });
});
