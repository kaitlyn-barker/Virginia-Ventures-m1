/**
 * PointerRefreshSystem.ts — keeps browser pointer picking fresh while the
 * mouse is stationary.
 *
 * WHY THIS EXISTS (the "unclickable Continue button" root cause):
 * @pmndrs/pointer-events only recomputes a pointer's scene intersection on
 * `pointermove` (IWSDK's CanvasPointerSystem doesn't opt into its
 * `intersectEveryFrame` mode). A `pointerdown` re-uses the intersection
 * committed by the LAST move. So when the scene changes under a motionless
 * cursor — a modal pops up after a camera cinematic (Royal Decree, ship
 * trade), a panel re-lays out after a window resize — the pointer still
 * "sees" whatever was there before: clicks silently press stale geometry and
 * the hover cursor never turns into a hand. Physically moving the mouse one
 * pixel fixes it, which is why the bug looked intermittent and never
 * reproduced under automation (synthetic tests always move before clicking).
 *
 * THE FIX: remember where the real mouse last was, and while it sits idle
 * (and no button is held), periodically re-dispatch a synthetic `pointermove`
 * at that same position with the same pointerId. The forwarder can't tell it
 * from a real move, so it re-raycasts against the CURRENT scene and the
 * committed intersection tracks reality. ~7 events/sec only while idle —
 * negligible next to the per-move raycasts the app already does.
 */

import { createSystem } from '@iwsdk/core';

/** Re-sync cadence while the mouse is idle (seconds). Fast enough that a
 *  panel appearing under the cursor is clickable before a human can react. */
const REFRESH_INTERVAL = 0.15;

export class PointerRefreshSystem extends createSystem({}) {
  /** Last real cursor position, in client coords. */
  private lastX = 0;
  private lastY = 0;
  /** pointerId of the real mouse (captured from its events, not assumed). */
  private pointerId = 1;
  /** True while the cursor is over the canvas (leave clears it). */
  private inside = false;
  /** True while any button is held — never inject moves mid-drag/grab. */
  private buttonHeld = false;
  /** True for the tick that processes our own synthetic event. */
  private ignoreSynthetic = false;
  /** Seconds since the last real OR synthetic move reached the forwarder. */
  private idleClock = 0;

  init() {
    const canvas = this.renderer.domElement;

    const onMove = (e: PointerEvent) => {
      if (this.ignoreSynthetic) return; // our own injection — not real motion
      if (e.pointerType !== 'mouse') return;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.pointerId = e.pointerId;
      this.inside = true;
      this.idleClock = 0;
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') this.buttonHeld = true;
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') this.buttonHeld = false;
    };
    const onLeave = () => {
      this.inside = false;
      this.buttonHeld = false;
    };

    canvas.addEventListener('pointermove', onMove, { capture: true });
    canvas.addEventListener('pointerdown', onDown, { capture: true });
    canvas.addEventListener('pointerup', onUp, { capture: true });
    canvas.addEventListener('pointerleave', onLeave, { capture: true });
    this.cleanupFuncs.push(() => {
      canvas.removeEventListener('pointermove', onMove, { capture: true });
      canvas.removeEventListener('pointerdown', onDown, { capture: true });
      canvas.removeEventListener('pointerup', onUp, { capture: true });
      canvas.removeEventListener('pointerleave', onLeave, { capture: true });
    });
  }

  update(delta: number) {
    // Canvas pointer forwarding is inert inside an immersive session, and a
    // hidden tab has no cursor to keep honest.
    if (this.renderer.xr.isPresenting || document.hidden) return;
    if (!this.inside || this.buttonHeld) return;

    this.idleClock += delta;
    if (this.idleClock < REFRESH_INTERVAL) return;
    this.idleClock = 0;

    // Same pointerId as the real mouse so the forwarder refreshes the REAL
    // pointer's committed intersection, not a parallel synthetic one.
    this.ignoreSynthetic = true;
    this.renderer.domElement.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: this.lastX,
        clientY: this.lastY,
        pointerId: this.pointerId,
        pointerType: 'mouse',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        view: window,
        buttons: 0,
      }),
    );
    this.ignoreSynthetic = false;
  }
}
