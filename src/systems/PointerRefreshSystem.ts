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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECOND JOB — camera-chain reconciliation (the DEEPER dead-click cause):
 * @pmndrs/pointer-events builds each mouse ray by RECOMPOSING the camera's
 * world matrix from LOCAL matrices up the parent chain
 * (updateAndCheckWorldTransformation), while the renderer trusts the stored
 * `matrixWorld`. IWSDK's player rig drives some of those nodes by writing
 * matrixWorld directly, leaving their locals stale — normally harmless
 * because the two paths stay equal. But when a cinematic locks the camera
 * (TradeShipArrival holds the dock view through the whole Fall set-piece)
 * the player's accumulated WASD movement lives ONLY in the stale locals: the
 * render shows the locked dock framing while every pointer ray originates
 * from where the player last walked. Result: ALL panels (decree Continue,
 * ship trade, season tabs) go globally unclickable — no hover cursor, no
 * errors, keyboard still works — but only for players who actually walked,
 * which is why no jump-to-phase test ever reproduced it.
 *
 * THE FIX: every frame, walk the camera's ancestor chain and, wherever
 * parentWorld × local no longer matches the node's authoritative
 * matrixWorld, rewrite the node's LOCAL transform from that matrixWorld.
 * After reconciliation both bookkeeping paths agree, so pointer rays always
 * originate exactly where the camera renders from. When nothing diverged
 * (normal play) the comparison is a cheap no-op.
 */

import { createSystem, Matrix4, type Object3D } from '@iwsdk/core';

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

  // Preallocated scratch for the camera-chain reconciliation (no per-frame GC).
  private parentWorld!: Matrix4;
  private expected!: Matrix4;
  private parentInv!: Matrix4;
  private chain: Object3D[] = [];

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

    this.parentWorld = new Matrix4();
    this.expected = new Matrix4();
    this.parentInv = new Matrix4();
  }

  /**
   * Make parentWorld × local == matrixWorld hold for every node from the
   * scene down to the camera, adopting each node's authoritative matrixWorld
   * into its local transform wherever the two bookkeeping paths diverged
   * (see the header comment). No-op when nothing diverged.
   */
  private reconcileCameraChain(): void {
    this.chain.length = 0;
    let node: Object3D | null = this.camera;
    while (node) {
      this.chain.push(node);
      node = node.parent;
    }
    this.parentWorld.identity();
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const n = this.chain[i];
      this.expected.multiplyMatrices(this.parentWorld, n.matrix);
      if (!matricesClose(this.expected.elements, n.matrixWorld.elements)) {
        // Adopt the render-authoritative world matrix into the locals so the
        // pointer library's local-chain recomposition reproduces it exactly.
        this.parentInv.copy(this.parentWorld).invert();
        n.matrix.multiplyMatrices(this.parentInv, n.matrixWorld);
        n.matrix.decompose(n.position, n.quaternion, n.scale);
      }
      this.parentWorld.copy(n.matrixWorld);
    }
    this.chain.length = 0;
  }

  update(delta: number) {
    // Canvas pointer forwarding is inert inside an immersive session. Note:
    // deliberately NO document.hidden gate — macOS Chrome reports occluded
    // (but still rendering) windows as hidden, which silently disabled the
    // refresher; if update() is running at all, the loop is alive and the
    // ~7 events/sec are harmless.
    if (this.renderer.xr.isPresenting) return;

    // Keep pointer rays and rendered view in agreement even while cinematics
    // hold the camera — runs every frame, regardless of mouse state.
    this.reconcileCameraChain();

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

/** Element-wise matrix comparison with a tolerance loose enough to ignore
 *  float noise but far tighter than any real pose divergence (which is on
 *  the order of whole meters when the player has walked). */
function matricesClose(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-4) return false;
  }
  return true;
}
