/**
 * ui-relayout.ts — nudge on-screen PanelUI panels to recompute their layout.
 *
 * ScreenSpaceUISystem only recalculates a panel's size/position the first frame
 * it enters screen space, and thereafter only when the window fires a 'resize'.
 * Panels whose content changes after that first frame keep a stale (sometimes
 * mis-sized) layout. Dispatching a few synthetic 'resize' events after the
 * content settles nudges the layout to re-fit.
 *
 * IMPORTANT — why we do NOT detach the document here:
 * An earlier version "forced" a per-panel re-fit by detaching the panel's
 * document from the camera so the framework would re-add and re-measure it. That
 * re-parenting disrupted the @pmndrs/pointer-events handlers that UIKit buttons
 * rely on, so every panel that called this stopped responding to mouse clicks
 * (the welcome panel, which never calls this, kept working — that was the tell).
 * So this is deliberately a passive resize nudge only; it never re-parents a
 * panel. The optional `doc` argument is accepted (so existing call sites compile)
 * but intentionally ignored.
 */

export function relayoutScreenSpacePanels(_doc?: unknown): void {
  // One nudge on the next frame, then a couple of short follow-ups to catch the
  // settled natural size after UIKit finishes laying out wrapped text.
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  for (const ms of [120, 350]) {
    setTimeout(() => window.dispatchEvent(new Event('resize')), ms);
  }
}
