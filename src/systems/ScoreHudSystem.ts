/**
 * ScoreHudSystem.ts — the game-style colony score HUD (top-left).
 *
 * Three stat bars (Food Supply / Trade Wealth / Crown Reputation) plus a live
 * "Colony Prosperity" average + letter grade, all reading from the shared
 * `colonyScore` singleton. It is a pure VIEW — it never writes a score.
 *
 * Most of the polish lives in update(): each bar's fill tweens toward its new
 * value over ~0.5s, a "+5 / -10" floater rises and fades on every change (green
 * up, red down), a bar shimmers gold above 75 and pulses red below 25, and the
 * prosperity value + grade badge recolor live as the bars settle.
 *
 * Wiring mirrors the other HUD systems (NeedsSystem / InventoryHudSystem):
 *   - build the PanelUI + ScreenSpace entity in init(),
 *   - capture its UIKit document via a query 'qualify' subscription,
 *   - subscribe to colonyScore.onScoreChanged to kick off tweens + floaters,
 *   - paint per frame in update().
 *
 * It starts hidden and reveals once the player dismisses the welcome card
 * (arrivalSequence.onEnterColony), so it never overlaps that panel on boot.
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
} from '@iwsdk/core';

import { hudFollow } from '../ui/hudFollow.js';

import { gameState } from '../game/GameState.js';
import { colonyScore, type ScoreSnapshot } from '../game/ColonyScore.js';
import { arrivalSequence } from '../game/ArrivalSequence.js';

/** The HUD panel's UI config (compiled from ui/score-hud.uikitml). */
const PANEL_CONFIG = './ui/score-hud.json';

/** Track width in UIKit units — must match `.hud-track { width: 22 }`. */
const TRACK_W = 22;

/** Seconds for a fill to tween from its old value to the new one. */
const TWEEN_TIME = 0.5;

/** Floater lifetime (s) and how far it rises (UIKit units) before fading out. */
const FLOAT_TIME = 1.1;
const FLOAT_RISE = 1.7;
const FLOAT_TOP = 0.6; // matches `.hud-float { positionTop: 0.6 }` (rises upward)

const FLOAT_UP = '#6dd06d'; // gain (green)
const FLOAT_DOWN = '#d9534f'; // loss (red)
const SHIMMER = '#ffd77a'; // gold glow above 75
const PULSE = '#d9534f'; // red glow below 25

/** Letter-grade badge backgrounds (brief: A gold, B green, C yellow, D orange, F red). */
const GRADE_BG: Record<string, string> = {
  A: '#c9a84c',
  B: '#4a8c3f',
  C: '#e3c53c',
  D: '#e07b39',
  F: '#d9534f',
};

/** One tracked pillar: which score field it shows + its animation state. */
interface Pillar {
  key: 'food' | 'wealth' | 'crown';
  read: () => number;
  /** The currently-displayed (tweening) value. */
  shown: number;
  /** Tween endpoints + clock. */
  from: number;
  to: number;
  elapsed: number;
  /** Last actual score we saw (to compute the +/- delta). */
  last: number;
  /** Remaining floater lifetime; <= 0 means inactive. */
  floatLeft: number;
  /** Cheap dirty-check caches so a settled bar stops writing every frame. */
  lastInt: number;
  lastWidth: number;
  lastBorder: string;
}

export class ScoreHudSystem extends createSystem({
  scorePanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  private doc?: UIKitDocument;

  private pillars: Pillar[] = [
    this.makePillar('food', () => colonyScore.foodSupply),
    this.makePillar('wealth', () => colonyScore.tradeWealth),
    this.makePillar('crown', () => colonyScore.crownReputation),
  ];

  /** Elapsed clock (s) for shimmer/pulse oscillation. */
  private clock = 0;

  /** Dirty caches for the prosperity line. */
  private lastPros = -1;
  private lastGrade = '';

  private makePillar(key: Pillar['key'], read: () => number): Pillar {
    const v = read();
    return {
      key,
      read,
      shown: v,
      from: v,
      to: v,
      elapsed: TWEEN_TIME,
      last: v,
      floatLeft: 0,
      lastInt: -1,
      lastWidth: -1,
      lastBorder: '',
    };
  }

  init() {
    // (1) Build the HUD top-left. Created hidden; revealed on enter-colony.
    this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: PANEL_CONFIG,
        maxWidth: 1.15,
        maxHeight: 0.78,
      })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '20px',
        left: '20px',
        width: '270px',
        height: '188px',
        // Persistent HUD: sit slightly farther than the default popup depth so
        // dialogues / decree / recap popups render in front of it.
        zOffset: 0.26,
      })
      // XR: float the score HUD to the upper-left in front of the headset.
      .addComponent(Follower, hudFollow(this.player.head, [-0.95, 0.3, -1.95]));

    // (2) Capture the document when it loads, paint once, set initial visibility.
    this.cleanupFuncs.push(
      this.queries.scorePanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[entity.index] as
            | UIKitDocument
            | undefined;
          // Past the welcome card already (e.g. hot reload mid-game)? Show now.
          this.setHidden(gameState.currentPhase === 'Arrival');
          this.paint(0);
        },
        true,
      ),
    );

    // (3) Reveal when the player dismisses the welcome card.
    this.cleanupFuncs.push(
      arrivalSequence.onEnterColony(() => this.setHidden(false)),
    );

    // (4) On a score change: start each changed pillar's tween + float a delta.
    this.cleanupFuncs.push(
      colonyScore.onScoreChanged((snap) => this.onScoreChanged(snap)),
    );
  }

  // ─────────────────────────────── reactions ─────────────────────────────────

  private onScoreChanged(snap: ScoreSnapshot): void {
    const next: Record<Pillar['key'], number> = {
      food: snap.foodSupply,
      wealth: snap.tradeWealth,
      crown: snap.crownReputation,
    };
    for (const p of this.pillars) {
      const value = next[p.key];
      const delta = value - p.last;
      p.last = value;
      if (delta === 0) continue;
      // Retarget the tween from wherever the bar currently sits.
      p.from = p.shown;
      p.to = value;
      p.elapsed = 0;
      // Kick off the rising floater.
      p.floatLeft = FLOAT_TIME;
      const rounded = Math.round(delta);
      this.text(`hud-float-${p.key}`)?.setProperties({
        text: `${rounded > 0 ? '+' : ''}${rounded}`,
        color: delta > 0 ? FLOAT_UP : FLOAT_DOWN,
        opacity: 1,
        positionTop: FLOAT_TOP,
        display: 'flex',
      });
    }
  }

  // ─────────────────────────────── per-frame ─────────────────────────────────

  update(delta: number): void {
    if (!this.doc) return;
    this.clock += delta;
    this.paint(delta);
  }

  private paint(delta: number): void {
    for (const p of this.pillars) {
      // Advance the fill tween (ease-out) toward the target value.
      if (p.elapsed < TWEEN_TIME) {
        p.elapsed = Math.min(TWEEN_TIME, p.elapsed + delta);
        const f = p.elapsed / TWEEN_TIME;
        const eased = 1 - (1 - f) * (1 - f);
        p.shown = p.from + (p.to - p.from) * eased;
      } else {
        p.shown = p.to;
      }

      // Fill width (only write when it actually moved).
      const width = TRACK_W * (Math.max(0, Math.min(100, p.shown)) / 100);
      if (Math.abs(width - p.lastWidth) > 0.02) {
        p.lastWidth = width;
        this.container(`hud-fill-${p.key}`)?.setProperties({ width });
      }

      // Value readout (only write when the rounded integer changes).
      const intVal = Math.round(p.shown);
      if (intVal !== p.lastInt) {
        p.lastInt = intVal;
        this.text(`hud-value-${p.key}`)?.setProperties({ text: `${intVal}/100` });
      }

      // Shimmer above 75 / pulse below 25 — a gold/red glow border on the fill.
      this.applyGlow(p, intVal);

      // Floater: rise + fade, then hide (display lockstep with opacity).
      if (p.floatLeft > 0) {
        p.floatLeft = Math.max(0, p.floatLeft - delta);
        const prog = 1 - p.floatLeft / FLOAT_TIME; // 0 → 1
        if (p.floatLeft === 0) {
          this.text(`hud-float-${p.key}`)?.setProperties({
            opacity: 0,
            display: 'none',
          });
        } else {
          this.text(`hud-float-${p.key}`)?.setProperties({
            opacity: Math.max(0, 1 - prog),
            positionTop: FLOAT_TOP - prog * FLOAT_RISE,
          });
        }
      }
    }

    // Prosperity = average of the displayed (tweening) pillars, live grade.
    const pros = Math.round(
      (this.pillars[0].shown + this.pillars[1].shown + this.pillars[2].shown) / 3,
    );
    if (pros !== this.lastPros) {
      this.lastPros = pros;
      this.text('hud-pros-value')?.setProperties({ text: `${pros}` });
      const grade = this.gradeFor(pros);
      if (grade !== this.lastGrade) {
        this.lastGrade = grade;
        this.text('hud-grade')?.setProperties({
          text: grade,
          backgroundColor: GRADE_BG[grade],
        });
      }
    }
  }

  /** Oscillate a gold (>75) or red (<25) glow border on the fill, else none. */
  private applyGlow(p: Pillar, intVal: number): void {
    let key = 'none';
    if (intVal > 75) key = 'shimmer';
    else if (intVal < 25) key = 'pulse';

    if (key === 'none') {
      if (p.lastBorder !== 'none') {
        p.lastBorder = 'none';
        this.container(`hud-fill-${p.key}`)?.setProperties({ borderWidth: 0 });
      }
      return;
    }

    // A subtle sinusoidal glow — gold shimmers quick, red pulses slow.
    const speed = key === 'shimmer' ? 5.2 : 3.0;
    const osc = 0.5 + 0.5 * Math.sin(this.clock * speed);
    const w = (key === 'shimmer' ? 0.12 : 0.1) + 0.18 * osc;
    this.container(`hud-fill-${p.key}`)?.setProperties({
      borderColor: key === 'shimmer' ? SHIMMER : PULSE,
      borderWidth: w,
    });
    p.lastBorder = key;
  }

  // ─────────────────────────────── helpers ───────────────────────────────────

  private gradeFor(score: number): string {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }

  private setHidden(hidden: boolean): void {
    this.container('hud-root')?.setProperties({ display: hidden ? 'none' : 'flex' });
  }

  private text(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }
}
