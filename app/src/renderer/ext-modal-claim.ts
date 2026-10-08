// One extension dialog at a time. The input, select and confirm dialogs share
// one overlay and one set of buttons, so a second request arriving while the
// first is open used to stack a second set of listeners on the same buttons:
// one click answered both, and the first was answered with whatever the second
// one said. A newer request now cancels the older one first, which fails
// closed -- a cancelled approval can be asked for again.

/** Returns `claim(cancel)`, which cancels whatever held the modal and returns a release. */
export function createModalClaim(): (cancel: () => void) => () => void {
  let active: (() => void) | null = null;
  return (cancel) => {
    const previous = active;
    active = null;
    previous?.();
    active = cancel;
    return () => {
      if (active === cancel) active = null;
    };
  };
}
