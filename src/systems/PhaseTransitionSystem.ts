/**
 * PhaseTransitionSystem.ts — the cinematic "chapter card" between phases.
 *
 * Registers itself as gameState's transition runner: when the phase is about to
 * change, instead of the new phase activating immediately, this system fades a
 * full-screen card in over the scene (0.4s), holds it (1.6s), then fades back out
 * (0.4s) — and only commits the new phase at the midpoint, while the screen is
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

import { HudAnchor } from '../ui/hudFollow.js';
import { gameState, type GamePhase } from '../game/GameState.js';
import { SEASON_ACCENT } from './seasons.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';
import { sfx } from '../audio/Sfx.js';

const PANEL_CONFIG = './ui/phase-transition.json';

const FADE = 0.4; // seconds to fade in / out
const HOLD = 1.6; // seconds the card holds at full opacity

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
      })
      // XR: hold the chapter card centered in front of the headset, nearer than
      // every other panel (they sit at -1.6..-1.95) so it still reads as the
      // front-most layer. Without this it would land at the world origin.
      .addComponent(HudAnchor, { offset: [0, 0, -1.5] });
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

    // Keep the backdrop matched to the viewport while a card is showing, so a
    // mid-transition window resize doesn't reintroduce letterboxing / off-center.
    const onResize = () => {
      if (this.stage === 'idle') return;
      this.sizeOverlayToViewport();
      relayoutScreenSpacePanels(this.doc);
    };
    window.addEventListener('resize', onResize);
    this.cleanupFuncs.push(() => window.removeEventListener('resize', onResize));
  }

  /**
   * Stretch the dark backdrop to the viewport's exact aspect ratio so it fully
   * covers the screen with no letterbox — which, because ScreenSpace anchors the
   * fitted panel at top-left, is also what lands the flex-centered card dead
   * center. A fixed-aspect (square) backdrop instead fits-by-height on a
   * landscape viewport and clings to the left edge, dragging the card off-center
   * and leaving a strip of world showing — the "covers half the screen" bug.
   */
  private sizeOverlayToViewport(): void {
    const canvas = this.renderer?.domElement as HTMLCanvasElement | undefined;
    const w = canvas?.clientWidth || window.innerWidth;
    const h = canvas?.clientHeight || window.innerHeight;
    const aspect = h > 0 ? w / h : 1;
    this.container('trans-overlay')?.setProperties({
      width: 120 * aspect,
      height: 120,
    });
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
    this.sizeOverlayToViewport();
    this.setOverlayVisible(true);
    this.setOpacity(0);
    sfx.chime(); // a calm bell announces the new season / chapter
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
    this.container('trans-overlay')?.setProperties({
      opacity,
      // Interactivity MUST follow visibility. This overlay is full-screen and
      // sits at zOffset 0.14 — in front of every popup, including the Royal
      // Decree (0.18). If it's ever left faded-out but still interactive (an
      // interrupted / not-fully-committed fade-out), it silently swallows the
      // clicks meant for the panel behind it — the "Continue not clickable" bug.
      // So it only absorbs pointer input while it's actually visible.
      pointerEvents: opacity <= 0.001 ? 'none' : 'auto',
    });
  }

  private setOverlayVisible(visible: boolean): void {
    if (this.entity?.object3D) this.entity.object3D.visible = visible;
    this.container('trans-overlay')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    // A freshly-shown ScreenSpace panel needs a resize nudge to lay out (it only
    // auto-computes on load + window resize), or it renders mis-sized/invisible.
    if (visible) relayoutScreenSpacePanels(this.doc);
  }

  private text(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }
}
