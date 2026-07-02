/**
 * ui-relayout.ts — force on-screen PanelUI panels to recompute their layout.
 *
 * ScreenSpaceUISystem computes a panel's size/position when it first enters
 * screen space, and thereafter only when the window fires a 'resize'. Two things
 * make that unreliable for HUDs whose content settles a frame or two later (for
 * example after the UI font finishes loading and wrapped text reflows):
 *
 *  1. Panels created hidden at startup (like the Summer "Done Trading" button)
 *     are measured before their natural size settles, so their stored layout is
 *     stale — a right-anchored panel ends up clipped off the screen edge.
 *  2. ScreenSpaceUISystem.update() clears its internal `resized` flag right after
 *     the FIRST in-screen-space panel it re-fits, so a single 'resize' event
 *     only ever re-fits one panel. Dispatching synthetic resize events (the old
 *     approach here) therefore never reliably reached the other HUDs.
 *
 * So instead of nudging via 'resize', we run the framework's own per-panel
 * layout pass (`calculateLayout`) directly, for every panel currently in screen
 * space, a few times as the content settles.
 *
 * IMPORTANT — why we do NOT detach the document:
 * An even earlier version "forced" a re-fit by detaching a panel's document from
 * the camera so the framework would re-add and re-measure it. That re-parenting
 * severed the @pmndrs/pointer-events handlers UIKit buttons rely on, so every
 * panel that called this stopped responding to mouse clicks. Calling
 * `calculateLayout` in place only reads component values and sets the document's
 * scale/position — it never re-parents — so pointer events stay intact.
 */
import {
  PanelDocument,
  ScreenSpaceUISystem,
  type Entity,
  type World,
} from '@iwsdk/core';

/**
 * The one World, captured at startup so this free function can reach the live
 * ScreenSpaceUISystem without every call site threading it through. Set via
 * {@link initRelayout} right after `World.create(...)` resolves.
 */
let relayoutWorld: World | undefined;

/** Register the world once at startup (call from index.ts after World.create). */
export function initRelayout(world: World): void {
  relayoutWorld = world;
}

/**
 * The private members of ScreenSpaceUISystem we drive directly. `calculateLayout`
 * is private in the framework, but calling it in place is exactly the safe re-fit
 * we want (see file header).
 */
interface ScreenSpaceLayout {
  camera: unknown;
  queries: { panels: { entities: Iterable<Entity> } };
  calculateLayout(entity: Entity): void;
}

/**
 * Re-fit every screen-space PanelUI to its current (settled) content size. The
 * legacy `_hint` argument (a panel document) is accepted for call-site
 * compatibility but ignored — we re-fit all in-screen-space panels.
 */
export function relayoutScreenSpacePanels(_hint?: unknown): void {
  const world = relayoutWorld;
  if (!world) return;

  const refit = () => {
    const ss = world.getSystem(ScreenSpaceUISystem) as unknown as
      | ScreenSpaceLayout
      | undefined;
    if (!ss) return;
    for (const entity of ss.queries.panels.entities) {
      const doc = PanelDocument.data.document[entity.index] as
        | { parent?: unknown }
        | undefined;
      // Only panels currently parented to the camera are in screen space;
      // re-fitting a world-space (XR) panel would misplace it.
      if (doc && doc.parent === ss.camera) ss.calculateLayout(entity);
    }
  };

  // Re-fit on the next frame, then a couple of short follow-ups to catch the
  // settled natural size after UIKit finishes laying out wrapped text / fonts.
  requestAnimationFrame(refit);
  for (const ms of [120, 350]) {
    setTimeout(refit, ms);
  }
}
