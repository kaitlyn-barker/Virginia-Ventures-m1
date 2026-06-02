/**
 * InventoryHudSystem.ts — the always-on tradeable-goods readout (bottom-left).
 *
 * Builds a small inventory panel and keeps its counts in sync with the shared
 * `playerInventory` singleton. It's purely a VIEW: it owns no game state, just
 * reflects whatever the inventory holds. Whenever the inventory changes — Spring
 * stocking the harvest, or a Summer trade spending goods — the emitter fires and
 * we repaint the three counts.
 *
 * Same wiring pattern as SeasonBannerSystem / NeedsSystem:
 *   - create the PanelUI + ScreenSpace entity in init(),
 *   - wait for its UIKit document via a query 'qualify' subscription,
 *   - then paint, and repaint on every inventory-changed event.
 */

import {
  createSystem,
  Interactable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  UIKit,
  UIKitDocument,
  eq,
} from '@iwsdk/core';

import { playerInventory } from '../game/PlayerInventory.js';

/** The HUD panel's UI config (compiled from ui/inventory.uikitml). */
const PANEL_CONFIG = './ui/inventory.json';

export class InventoryHudSystem extends createSystem({
  // Match our inventory panel once PanelUISystem has parsed its JSON and
  // attached the live UIKit document (PanelDocument).
  invPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  /** The loaded inventory document, captured when the panel qualifies. */
  private doc?: UIKitDocument;

  init() {
    // (1) Build the inventory HUD. ScreenSpace pins it to the bottom-left in the
    //     browser, sitting just above the season banner (banner is bottom:20px,
    //     ~64px tall). In XR it becomes a world-space HUD panel.
    this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: PANEL_CONFIG,
        maxWidth: 1.6,
        maxHeight: 0.3,
      })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        bottom: '92px',
        left: '24px',
        width: '340px',
        height: '60px',
        // Persistent HUD: sit slightly farther than the default popup depth
        // (zOffset 0.2) so trade/dialogue/recap popups always render in front.
        zOffset: 0.26,
      });

    // (2) When the document is ready (now or later), grab it and paint the
    //     current counts. `true` replays for an already-loaded panel.
    this.cleanupFuncs.push(
      this.queries.invPanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.render(playerInventory.getAllItems());
        },
        true,
      ),
    );

    // (3) Repaint whenever the inventory changes — Spring stocking the harvest,
    //     or a Summer trade spending goods. Registered for cleanup on teardown.
    this.cleanupFuncs.push(
      playerInventory.onInventoryChanged((items) => this.render(items)),
    );
  }

  /** Write each good's count into its HUD chip. */
  private render(items: { type: string; count: number }[]): void {
    if (!this.doc) return;
    for (const item of items) {
      const el = this.doc.getElementById(
        `inv-${item.type}-count`,
      ) as UIKit.Text | null;
      el?.setProperties({ text: String(item.count) });
    }
  }
}
