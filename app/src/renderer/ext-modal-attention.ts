// A dialog the brain is blocked on has to be impossible to miss (#611). The
// extension dialogs used to open with focus still in the composer, so the user
// could keep typing past a /approve confirm and never see that it was waiting.

/**
 * Returns `open(modal)`, which focuses the dialog, shows the "waiting for you"
 * banner, and returns a close that undoes both once the last dialog is answered.
 */
export function createDialogAttention(opts: {
  banner: HTMLElement;
}): (modal: HTMLElement) => () => void {
  let open = 0;
  // Where focus was before the first of any overlapping dialogs.
  let previous: HTMLElement | null = null;
  return (modal) => {
    if (open === 0) previous = document.activeElement as HTMLElement | null;
    open++;
    opts.banner.classList.remove("hidden");
    // The dialog itself, not its Yes button: an Enter meant for the composer
    // must not approve anything.
    if (!modal.hasAttribute("tabindex")) modal.tabIndex = -1;
    modal.focus();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      open--;
      // Another dialog still waiting keeps the banner and the focus.
      if (open > 0) return;
      opts.banner.classList.add("hidden");
      // Only if focus is still where the dialog left it.
      const active = document.activeElement;
      const stillOurs = !active || active === document.body || modal.contains(active);
      if (stillOurs && previous?.isConnected) previous.focus();
      previous = null;
    };
  };
}
