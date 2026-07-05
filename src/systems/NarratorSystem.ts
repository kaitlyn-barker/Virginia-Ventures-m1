/**
 * NarratorSystem.ts — the view for the plain-words tradeoff callouts (P2.4).
 *
 * Shows one narrator line at a time in a slim banner under the score HUD: a
 * quick fade-in, a hold scaled to the line's length, then a fade-out. Multiple
 * callouts queue so a burst of decisions doesn't clobber each other. The whole
 * thing is suppressible from Settings (gameSettings.narration) and honors the
 * chosen text size in XR.
 *
 * Pure view: it never touches scores or game state — it only listens to the
 * `narrator` emitter (see game/Narrator.ts) and paints.
 */

import {
  createSystem,
  Follower,
  Interactable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  UIKit,
  UIKitDocument,
  eq,
  type Entity,
} from '@iwsdk/core';

import { hudFollow } from '../ui/hudFollow.js';
import {
  narrator,
  type NarratorMessage,
  type NarratorTone,
} from '../game/Narrator.js';
import { gameSettings } from '../game/GameSettings.js';

const PANEL_CONFIG = './ui/narrator.json';

/** Accent stripe color per tone (the pillar the tradeoff is about). */
const TONE_COLOR: Record<NarratorTone, string> = {
  food: '#6dbf5a', // Food Supply — green
  wealth: '#d9a441', // Trade Wealth — gold
  crown: '#9b6dd0', // Crown Reputation — royal purple
  neutral: '#c9a84c', // generic parchment gold
};

const FADE_IN = 0.35;
const FADE_OUT = 0.55;
/** Hold time scales with line length, clamped to a comfortable reading range. */
const MIN_HOLD = 3.6;
const MAX_HOLD = 7.5;

type Phase = 'idle' | 'in' | 'hold' | 'out';

export class NarratorSystem extends createSystem({
  panel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  private doc?: UIKitDocument;
  private entity?: Entity;

  /** Pending callouts (shown one at a time, oldest first). */
  private queue: NarratorMessage[] = [];
  private phase: Phase = 'idle';
  private clock = 0;
  private holdFor = MIN_HOLD;

  init() {
    // Slim banner directly under the score HUD (top-left). Created hidden.
    this.entity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: PANEL_CONFIG, maxWidth: 1.4, maxHeight: 0.4 })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '222px', // just below the score HUD (top 20 + height 188 + gap)
        left: '20px',
        width: '380px',
        height: '96px',
        zOffset: 0.26,
      })
      // XR: float it under the score HUD in front of the headset.
      .addComponent(Follower, hudFollow(this.player.head, [-0.95, -0.05, -1.95]));
    this.entity.object3D!.visible = false;

    this.cleanupFuncs.push(
      this.queries.panel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[entity.index] as
            | UIKitDocument
            | undefined;
          this.hideNow();
        },
        true,
      ),
    );

    // Queue every callout; the update loop plays them out one at a time.
    this.cleanupFuncs.push(
      narrator.subscribe((msg) => this.enqueue(msg)),
    );

    // If narration is switched OFF mid-callout, clear it immediately.
    this.cleanupFuncs.push(
      gameSettings.subscribe((s) => {
        if (!s.narration) {
          this.queue.length = 0;
          this.hideNow();
        }
      }),
    );
  }

  private enqueue(msg: NarratorMessage): void {
    if (!gameSettings.current.narration) return; // suppressed by the player
    this.queue.push(msg);
  }

  update(delta: number): void {
    if (!this.doc) return;

    // Nothing showing → start the next queued callout (if any).
    if (this.phase === 'idle') {
      const next = this.queue.shift();
      if (!next) return;
      this.present(next);
      return;
    }

    this.clock += delta;
    if (this.phase === 'in') {
      const t = Math.min(1, this.clock / FADE_IN);
      this.setOpacity(t);
      if (t >= 1) {
        this.phase = 'hold';
        this.clock = 0;
      }
    } else if (this.phase === 'hold') {
      if (this.clock >= this.holdFor) {
        this.phase = 'out';
        this.clock = 0;
      }
    } else if (this.phase === 'out') {
      const t = Math.min(1, this.clock / FADE_OUT);
      this.setOpacity(1 - t);
      if (t >= 1) this.hideNow();
    }
  }

  private present(msg: NarratorMessage): void {
    if (!this.entity) return;
    this.text('narrator-line')?.setProperties({ text: msg.text });
    this.container('narrator-accent')?.setProperties({
      backgroundColor: TONE_COLOR[msg.tone],
    });
    this.container('narrator-root')?.setProperties({ display: 'flex' });
    this.entity.object3D!.visible = true;
    this.entity.object3D!.scale.setScalar(gameSettings.textScale());
    this.holdFor = Math.min(MAX_HOLD, Math.max(MIN_HOLD, msg.text.length * 0.06));
    this.phase = 'in';
    this.clock = 0;
    this.setOpacity(0);
  }

  private setOpacity(o: number): void {
    this.container('narrator-root')?.setProperties({ opacity: o });
  }

  private hideNow(): void {
    this.phase = 'idle';
    this.clock = 0;
    this.container('narrator-root')?.setProperties({ display: 'none' });
    if (this.entity?.object3D) this.entity.object3D.visible = false;
  }

  private text(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }
}
