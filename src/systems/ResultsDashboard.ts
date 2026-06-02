/**
 * ResultsDashboard.ts — Winter, Part B: "Your First Year in Virginia."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES
 * ─────────────────────────────────────────────────────────────────────────
 * After the Winter visuals settle, WinterScene (Step 8) calls `openDashboard()`
 * and this system shows a world-space parchment panel summarising the whole
 * year: each of the three pillars with its final value /100, a bar, and a
 * +/- change tag, plus an earned "Colony Title". A single "Reflect on Your Year"
 * button hands off to Part C (a placeholder for now).
 *
 * It is READ-ONLY with respect to the score: it calls
 * `ColonyScore.getScoreSnapshot()` and reads `phaseSnapshots.Arrival`, but never
 * mutates any pillar. Nothing here changes scoring logic or earlier panels.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UNITY → WEB MENTAL MODEL
 * ─────────────────────────────────────────────────────────────────────────
 * A "system" is the web version of a Unity script; `init()` is its Awake (the
 * World calls it once after registration). `openDashboard()` is a tiny module-
 * level emitter — the web stand-in for a C# `static event` — so WinterScene can
 * trigger this system without holding a direct reference to its instance.
 */

import {
  AudioUtils,
  Interactable,
  PanelDocument,
  PanelUI,
  Quaternion,
  UIKit,
  UIKitDocument,
  Vector3,
  createSystem,
  eq,
  type Entity,
} from '@iwsdk/core';

import { colonyScore, type ScoreSnapshot } from '../game/ColonyScore.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';
// Part C handoff: the "Reflect on Your Year" button starts the reflection.
import { startReflection } from './Reflection.js';

const PANEL_CONFIG = './ui/results-dashboard.json';

/** Bar-track width in the panel's units — must match `.bar-track { width }` in
 *  results-dashboard.uikitml. The fill width = this × (score / 100). */
const BAR_TRACK_WIDTH = 26;

/** Where the panel sits relative to the player rig when opened. */
const PANEL_DISTANCE = 2.2; // metres in front of the rig (comfortable reading)
const PANEL_HEIGHT = 1.5; // metres above the rig's floor (eye-ish level)

/** Green for a gain, red for a loss — tag colors (match the game's palette). */
const TAG_UP = '#5cb860';
const TAG_DOWN = '#d9655b';

/** Bar-fill animation timing (Step 3). Each bar lerps its width 0 → target over
 *  BAR_FILL_DURATION seconds, and each pillar STARTS BAR_STAGGER seconds later
 *  than the one before it — so the three bars fill in sequence, not all at once
 *  (Food first, then Trade ~0.2s later, then Crown ~0.2s after that). */
const BAR_FILL_DURATION = 1.0; // seconds for one bar to fill
const BAR_STAGGER = 0.2; // seconds between each bar starting

/** Bar colors by final value: thriving green / steady gold / struggling red. */
const BAR_GREEN = '#5cb860'; // pillar >= 70
const BAR_GOLD = '#c79a4b'; // pillar 40–69
const BAR_RED = '#c2603f'; // pillar < 40

/**
 * The three pillars, paired with the panel element ids that show them. Keeping
 * this as one table means the render loop below stays a simple for-of.
 */
const PILLARS: {
  key: keyof ScoreSnapshot;
  barId: string;
  numId: string;
  tagId: string;
}[] = [
  { key: 'foodSupply', barId: 'bar-food', numId: 'num-food', tagId: 'tag-food' },
  { key: 'tradeWealth', barId: 'bar-wealth', numId: 'num-wealth', tagId: 'tag-wealth' },
  { key: 'crownReputation', barId: 'bar-rep', numId: 'num-rep', tagId: 'tag-rep' },
];

// ─────────────────────────────────────────────────────────────────────────
// openDashboard() — the public trigger WinterScene Step 8 calls.
//
// A module-level Set of callbacks (the same hand-rolled emitter pattern used by
// GameState/ColonyScore). The ResultsDashboard system subscribes to it in init;
// calling openDashboard() fires every subscriber. This decouples the caller
// (WinterScene) from this system's instance.
// ─────────────────────────────────────────────────────────────────────────
const openListeners = new Set<() => void>();

/** Open the Winter Results Dashboard. Safe to call once the system is registered. */
export function openDashboard(): void {
  for (const cb of [...openListeners]) cb();
}

export class ResultsDashboard extends createSystem({
  dashboardPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  private doc?: UIKitDocument;
  private panelEntity?: Entity;
  private opened = false; // one-shot guard (the dashboard opens once)

  // Bar-fill tween state (Step 3).
  private barAnimating = false;
  private barElapsed = 0; // seconds since the bar animation began
  private readonly barTargets: number[] = [0, 0, 0]; // final fill widths per pillar

  // Scratch objects — allocate once, reuse every open (VR frame-budget habit).
  private tmpPos!: Vector3;
  private tmpQuat!: Quaternion;
  private forward!: Vector3;

  init() {
    this.tmpPos = new Vector3();
    this.tmpQuat = new Quaternion();
    this.forward = new Vector3();

    // World-space panel (NO ScreenSpace): it lives in the 3D world, anchored in
    // front of the player rig (positioned in open()). Hidden until opened.
    this.panelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: PANEL_CONFIG, maxWidth: 1.6, maxHeight: 1.5 })
      .addComponent(Interactable);
    this.panelEntity.object3D!.visible = false;

    // Grab the UIKit document + wire the Reflect button once the panel loads.
    this.cleanupFuncs.push(
      this.queries.dashboardPanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.button('reflect-btn')?.addEventListener('click', () =>
            this.onReflect(),
          );
          this.setVisible(false);
        },
        true,
      ),
    );

    // Subscribe to the public open() trigger (WinterScene Step 8 calls it).
    openListeners.add(this.handleOpen);
    this.cleanupFuncs.push(() => openListeners.delete(this.handleOpen));
  }

  /** Bound handler so add/delete reference the same function instance. */
  private handleOpen = (): void => this.open();

  // ─────────────────────────────── open / place ──────────────────────────────

  private open(): void {
    if (this.opened) return; // the year-end dashboard shows exactly once
    this.opened = true;

    this.anchorInFrontOfPlayer();
    this.render();
    this.setVisible(true);
    this.playAppearSound();
    objectiveTracker.completeSubTask('winter-results');
    console.log('[Winter] Results Dashboard opened.');
  }

  /**
   * PLACEHOLDER "dashboard appears" sound. There's no /audio/dashboard_appear.mp3
   * yet (only chime.mp3), so this AudioUtils call is the fallback — same pattern
   * as WinterScene's winter_wind: the wiring is here and fails quietly until the
   * real file is dropped into public/audio/.
   */
  private playAppearSound(): void {
    try {
      AudioUtils.createOneShot(this.world, '/audio/dashboard_appear.mp3', {
        volume: 0.5,
        positional: false,
      });
    } catch (err) {
      console.warn('[Winter] dashboard_appear unavailable (placeholder):', err);
    }
  }

  /**
   * Position the panel a comfortable reading distance in front of the player
   * RIG (not the headset), at eye-ish height, facing the player. We read the
   * rig's world transform, step PANEL_DISTANCE along its forward (−Z) direction,
   * and copy the rig's orientation so the panel's front faces back at the player.
   */
  private anchorInFrontOfPlayer(): void {
    const panel = this.panelEntity?.object3D;
    if (!panel) return;

    this.player.getWorldPosition(this.tmpPos);
    this.player.getWorldQuaternion(this.tmpQuat);
    // Rig forward is local −Z rotated by the rig's orientation.
    this.forward.set(0, 0, -1).applyQuaternion(this.tmpQuat);

    panel.position
      .copy(this.tmpPos)
      .addScaledVector(this.forward, PANEL_DISTANCE);
    panel.position.y = this.tmpPos.y + PANEL_HEIGHT; // lift to reading height
    // Same orientation as the rig → the panel's +Z front faces the player.
    panel.quaternion.copy(this.tmpQuat);
  }

  // ──────────────────────────────── rendering ────────────────────────────────

  /**
   * Fill the panel from the scores. This is the heart of STEP 2:
   *   final = the score right now (end of the year)
   *   start = where each pillar BEGAN
   *   change = final − start
   */
  private render(): void {
    if (!this.doc) return;

    // FINAL scores — a defensive copy of the live pillars (read-only).
    const final = colonyScore.getScoreSnapshot();

    // START scores. Every pillar begins at 50 (see ColonyScore's initializer).
    // PhaseSystem records a snapshot of the OUTGOING phase on every change, so
    // the Arrival→Spring transition stores `phaseSnapshots.Arrival` = the values
    // at the end of Arrival, i.e. the untouched starting 50s (Arrival is the
    // intro and never scores). We prefer that stored snapshot and fall back to a
    // literal 50/50/50 if it somehow isn't present (e.g. a direct jump to Winter).
    const start: ScoreSnapshot = colonyScore.phaseSnapshots.Arrival ?? {
      foodSupply: 50,
      tradeWealth: 50,
      crownReputation: 50,
    };

    // Fill the numbers + change tags immediately; the BARS animate (Step 3), so
    // here we only set each bar's color + starting width (0) and remember its
    // target width for update() to lerp toward.
    PILLARS.forEach(({ key, barId, numId, tagId }, i) => {
      const value = Math.round(final[key]); // 0–100
      const change = Math.round(final[key] - start[key]); // final − start

      // Number: "73/100".
      this.setText(numId, `${value}/100`);

      // Change tag: "+12" (green) or "-8" (red); "+0" reads as neutral-green.
      const sign = change >= 0 ? '+' : ''; // negatives already carry their '-'
      this.text(tagId)?.setProperties({
        text: `${sign}${change}`,
        color: change >= 0 ? TAG_UP : TAG_DOWN,
      });

      // Bar: color it by tier, start it EMPTY (width 0), and stash the target.
      const clamped = Math.max(0, Math.min(100, value));
      this.barTargets[i] = (BAR_TRACK_WIDTH * clamped) / 100;
      this.container(barId)?.setProperties({
        width: 0,
        backgroundColor: this.barColor(value),
      });
    });

    // Kick off the staggered bar fill — update() does the per-frame lerp.
    this.barElapsed = 0;
    this.barAnimating = true;

    // STEP 4 — the earned Colony Title + a strongest-pillar subtitle.
    this.setText('colony-title', this.colonyTitle(final));
    this.setText(
      'colony-subtitle',
      `Your strength was ${this.strongestPillar(final)}.`,
    );
  }

  /**
   * STEP 3 — animate the bars. Runs every frame while a fill is in progress.
   *
   * STAGGER (beginner note): each bar waits its turn. Bar 0 (Food) starts at
   * t=0, bar 1 (Trade) at t=0.2s, bar 2 (Crown) at t=0.4s. We compute a per-bar
   * progress by subtracting that bar's start offset from the shared clock, then
   * clamping to 0–1. So a bar reads 0 until its turn, then lerps to full over
   * BAR_FILL_DURATION. The width lerp is just `target × progress` (start = 0).
   */
  update(delta: number): void {
    if (!this.barAnimating) return;
    this.barElapsed += delta;

    let allDone = true;
    PILLARS.forEach(({ barId }, i) => {
      const startAt = i * BAR_STAGGER; // this bar's stagger offset
      const t = clamp01((this.barElapsed - startAt) / BAR_FILL_DURATION);
      this.container(barId)?.setProperties({ width: this.barTargets[i] * t });
      if (t < 1) allDone = false; // still filling at least one bar
    });

    if (allDone) this.barAnimating = false; // every bar reached its target
  }

  /** Bar color by final pillar value: green ≥70, gold 40–69, muted red <40. */
  private barColor(value: number): string {
    if (value >= 70) return BAR_GREEN;
    if (value >= 40) return BAR_GOLD;
    return BAR_RED;
  }

  /**
   * STEP 4 — pick the Colony Title from the AVERAGE of the three final pillars.
   * (Balance is the lesson: one big pillar can't carry a low average.)
   */
  private colonyTitle(s: ScoreSnapshot): string {
    const avg = (s.foodSupply + s.tradeWealth + s.crownReputation) / 3;
    if (avg >= 75) return 'Thriving Colony';
    if (avg >= 55) return 'Steady Settlement';
    if (avg >= 40) return 'Struggling Outpost';
    return 'Colony in Crisis';
  }

  /** The name of the highest-scoring pillar (ties resolve food → trade → crown). */
  private strongestPillar(s: ScoreSnapshot): string {
    const max = Math.max(s.foodSupply, s.tradeWealth, s.crownReputation);
    if (s.foodSupply === max) return 'Food Supply';
    if (s.tradeWealth === max) return 'Trade Wealth';
    return 'Crown Reputation';
  }

  // ─────────────────────────────── reflect → Part C ──────────────────────────

  /**
   * "Reflect on Your Year" → Part C. There is no Part C yet, so this is a
   * placeholder (same staging the dashboard itself used in Part B). Wire the
   * real reflection screen here later.
   */
  private onReflect(): void {
    // Hand off to Part C: hide this dashboard and start the reflection sequence.
    // (Step 5: this replaced the earlier "START REFLECTION" placeholder log with
    // the real call.) We do NOT write to the decision log here.
    this.setVisible(false);
    startReflection();
  }

  // ─────────────────────────────── small helpers ─────────────────────────────

  private setVisible(visible: boolean): void {
    if (this.panelEntity?.object3D) this.panelEntity.object3D.visible = visible;
    this.container('dash-root')?.setProperties({ display: visible ? 'flex' : 'none' });
  }

  private text(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private button(id: string): UIKit.Text | undefined {
    return this.text(id);
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }

  private setText(id: string, value: string): void {
    this.text(id)?.setProperties({ text: value });
  }
}

/** Clamp a number to [0, 1] — keeps a bar's fill progress in range. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
