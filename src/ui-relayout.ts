/**
 * ui-relayout.ts — force on-screen PanelUI panels to recompute their layout.
 *
 * ScreenSpaceUISystem only recalculates a panel's size/position the first frame
 * it enters screen space, and thereafter only when the window fires a 'resize'.
 * Panels whose content changes after that first frame — a toast handed new text,
 * the recap filling in its rows — otherwise keep their stale (often clipped or
 * mis-scaled) layout. Nudging a 'resize' on the next animation frame, after
 * UIKit has applied the new content and recomputed its natural size, makes the
 * screen-space layout re-fit to the real content.
 */
export function relayoutScreenSpacePanels(): void {
  // A freshly un-hidden panel needs a frame or two for UIKit to lay out its
  // (often newly set) text before its natural size is final, so fire several
  // nudges: one on the next frame, then a couple of short follow-ups to catch
  // the settled size.
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  for (const ms of [120, 350]) {
    setTimeout(() => window.dispatchEvent(new Event("resize")), ms);
  }
}
