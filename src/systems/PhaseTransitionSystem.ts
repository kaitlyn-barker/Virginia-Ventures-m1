/**
 * PhaseTransitionSystem.ts — the cinematic "chapter card" between phases.
 *
 * Registers itself as gameState's transition runner: when the phase is about to
 * change, instead of the new phase activating immediately, this system fades a
 * full-screen card in over the scene (0.5s), holds it (3s), then fades back out
 * (0.5s) — and only commits the new phase at the midpoint, while the screen is
 * fully black. So the player reads "Summer — No one survives alone…" and the
 * world has already swapped over by the time the card lifts.
 *
 * The card shows the season name (gold), a season-colored diamond icon, a
 * subtitle (the phase's description), and a teaser line, framed by thin
 * ornamental dividers — all on a dark parchment card.
 *
 * It touches no gameplay: it only DEFERS the existing phase commit (handed to it
 * as a callback) behind the card. With this system absent, phases change exactly
 * as before.
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
  type Entity,
} from '@iwsdk/core';

import { gameState, type GamePhase } from '../game/GameState.js';
import { SEASON_ACCENT } from './seasons.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';

const PANEL_CONFIG = './ui/phase-transition.json';

const FADE = 0.5; // seconds to fade in / out
const HOLD = 3.0; // seconds the card holds at full opacity

/** Per-phase card copy. Arrival has no card (it's the boot/reset state). */
const CARD: Partial<Record<GamePhase, { subtitle: string; teaser: string }>> = {
  Spring: {
    subtitle: 'Planting Season',
    teaser: 'Your land awaits. What will you grow?',
  },
  Summer: {
    subtitle: 'Barter & Trade',
    teaser: 'No one survives alone. Time to trade.',
  },
  Fall: {
    subtitle: 'The Trade Ship',
    teaser: "England's ship has arrived. Choose wisely.",
  },
  Winter: {
    subtitle: 'Consequences',
    teaser: 'The frost has come. How did you fare?',
  },
};

type Stage = 'idle' | 'in' | 'hold' | 'out';

export class PhaseTransitionSystem extends createSystem({
  panel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  private doc?: UIKitDocument;
  private entity?: Entity;

  private stage: Stage = 'idle';
  private t = 0;
  private committed = false;
  private pendingCommit: (() => void) | null = null;

  init() {
    // Full-screen overlay, hidden until a transition runs. Interactable so it
    // absorbs clicks while the card is up (no tapping the banner under the fade).
    this.entity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: PANEL_CONFIG,
        maxWidth: 2.6,
        maxHeight: 2.0,
      })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '0%',
        left: '0vw',
        width: '100vw',
        height: '100%',
        // In front of every popup (0.2) / HUD (0.26) — smaller zOffset = closer —
        // but still beyond the camera near-clip plane (~0.1) so it isn't culled.
        zOffset: 0.14,
      });
    this.entity.object3D!.visible = false;

    this.cleanupFuncs.push(
      this.queries.panel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[entity.index] as
            | UIKitDocument
            | undefined;
          this.setOverlayVisible(false);
        },
        true,
      ),
    );

    // Become gameState's transition runner. Clear it on teardown.
    gameState.setTransitionRunner((_old, next, commit) => this.begin(next, commit));
    this.cleanupFuncs.push(() => gameState.setTransitionRunner(null));
  }

  /** Start a transition for `next`, deferring `commit` until the card is black. */
  private begin(next: GamePhase, commit: () => void): void {
    const info = CARD[next];
    // No card for Arrival (boot/reset) or if one is already mid-play — just
    // commit so a phase change is never swallowed.
    if (!info || this.stage !== 'idle') {
      commit();
      return;
    }
    this.pendingCommit = commit;
    this.committed = false;
    this.renderCard(next, info);
    this.setOverlayVisible(true);
    this.setOpacity(0);
    this.stage = 'in';
    this.t = 0;
  }

  update(delta: number): void {
    if (this.stage === 'idle') return;
    this.t += delta;

    switch (this.stage) {
      case 'in': {
        this.setOpacity(Math.min(1, this.t / FADE));
        if (this.t >= FADE) {
          this.setOpacity(1);
          // Commit the new phase now, under the fully-black card.
          if (!this.committed) {
            this.committed = true;
            this.pendingCommit?.();
            this.pendingCommit = null;
          }
          this.stage = 'hold';
          this.t = 0;
        }
        break;
      }
      case 'hold': {
        if (this.t >= HOLD) {
          this.stage = 'out';
          this.t = 0;
        }
        break;
      }
      case 'out': {
        this.setOpacity(Math.max(0, 1 - this.t / FADE));
        if (this.t >= FADE) {
          this.setOpacity(0);
          this.setOverlayVisible(false);
          this.stage = 'idle';
        }
        break;
      }
    }
  }

  // ─────────────────────────────── rendering ─────────────────────────────────

  private renderCard(
    phase: GamePhase,
    info: { subtitle: string; teaser: string },
  ): void {
    this.container('trans-icon')?.setProperties({
      backgroundColor: SEASON_ACCENT[phase],
    });
    this.text('trans-name')?.setProperties({ text: phase });
    this.text('trans-subtitle')?.setProperties({ text: info.subtitle });
    this.text('trans-teaser')?.setProperties({ text: info.teaser });
  }

  private setOpacity(opacity: number): void {
    this.container('trans-overlay')?.setProperties({ opacity });
  }

  private setOverlayVisible(visible: boolean): void {
    if (this.entity?.object3D) this.entity.object3D.visible = visible;
    this.container('trans-overlay')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    // A freshly-shown ScreenSpace panel needs a resize nudge to lay out (it only
    // auto-computes on load + window resize), or it renders mis-sized/invisible.
    if (visible) relayoutScreenSpacePanels();
  }

  private text(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }
}
