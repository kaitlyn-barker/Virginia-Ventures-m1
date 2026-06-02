/**
 * ColonyScore.ts — the colony "prosperity" scoring model for Virginia Ventures.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS TEACHES (the hidden curriculum)
 * ─────────────────────────────────────────────────────────────────────────
 * Three scores compete with each other. The student never sees the words
 * "scarcity", "opportunity cost", or "tradeoff", but they FEEL them: every
 * choice that pushes one pillar up tends to leave another behind.
 *
 *   - Food Supply       — keeps the settlement fed. Planting corn raises it,
 *                         but corn is worth little in trade.
 *   - Trade Wealth      — money from smart trading. Tobacco is lucrative but
 *                         feeds no one.
 *   - Crown Reputation  — how pleased England is. Following the rules raises
 *                         it, but the rules cap your profit.
 *
 * The overall prosperity score is the average of the three, so you can't win
 * by maxing one and ignoring the rest — balance is the lesson.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UNITY → WEB MENTAL MODEL
 * ─────────────────────────────────────────────────────────────────────────
 * Just like GameState, this is a single module-level object that lives for the
 * whole session (a DontDestroyOnLoad singleton without the ceremony). The
 * "score changed" event is the same hand-rolled emitter pattern: a Set of
 * callbacks we invoke whenever a pillar changes — the web stand-in for a C#
 * `event Action`. The UI we build later will subscribe to it and re-render.
 * ─────────────────────────────────────────────────────────────────────────
 */

import type { GamePhase } from './GameState.js';

/** A read-only copy of the three pillar values at a moment in time. */
export interface ScoreSnapshot {
  foodSupply: number;
  tradeWealth: number;
  crownReputation: number;
}

/** Letter grades derived from the prosperity score. */
export type ScoreGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/** A score-changed listener receives a fresh snapshot of all three pillars. */
export type ScoreChangedListener = (snapshot: ScoreSnapshot) => void;

export interface ColonyScore {
  // The three competing pillars. Each is constrained to 0–100 at all times.
  foodSupply: number;
  tradeWealth: number;
  crownReputation: number;

  /** End-of-phase snapshots, keyed by the phase they were taken in. */
  phaseSnapshots: Partial<Record<GamePhase, ScoreSnapshot>>;

  /** Add (or subtract, if negative) food, clamped to 0–100. */
  addFood(amount: number): void;
  /** Add (or subtract) trade wealth, clamped to 0–100. */
  addWealth(amount: number): void;
  /** Add (or subtract) crown reputation, clamped to 0–100. */
  addReputation(amount: number): void;

  /** The average of the three pillars (0–100). Read it as a property. */
  readonly prosperityScore: number;

  /** Letter grade (A/B/C/D/F) for the current prosperity score. */
  getScoreGrade(): ScoreGrade;

  /** A defensive copy of the three current values. */
  getScoreSnapshot(): ScoreSnapshot;

  /** Take a snapshot now and file it under `phase` (call at end of a phase). */
  recordPhaseSnapshot(phase: GamePhase): void;

  /** Subscribe to score changes. Returns an unsubscribe function. */
  onScoreChanged(cb: ScoreChangedListener): () => void;

  /** Reset all three pillars to 50 and clear recorded snapshots. */
  reset(): void;
}

/**
 * clamp() — force a number into the [min, max] range.
 *
 * The math, spelled out for beginners:
 *   - Math.max(min, value) raises anything below `min` UP to `min`.
 *   - Math.min(max, ...)   lowers anything above `max` DOWN to `max`.
 * Nesting them means the result can never escape [min, max]. We use this so a
 * pillar can never go negative or blow past 100, no matter how big the change.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Private subscriber list for the score-changed event (see GameState for why a Set). */
const scoreChangedListeners = new Set<ScoreChangedListener>();

export const colonyScore: ColonyScore = {
  // Every pillar starts at the neutral midpoint, 50 — a balanced colony.
  foodSupply: 50,
  tradeWealth: 50,
  crownReputation: 50,

  phaseSnapshots: {},

  addFood(amount: number): void {
    this.foodSupply = clamp(this.foodSupply + amount, 0, 100);
    emitScoreChanged();
  },

  addWealth(amount: number): void {
    this.tradeWealth = clamp(this.tradeWealth + amount, 0, 100);
    emitScoreChanged();
  },

  addReputation(amount: number): void {
    this.crownReputation = clamp(this.crownReputation + amount, 0, 100);
    emitScoreChanged();
  },

  // A getter, so `colonyScore.prosperityScore` always recomputes from the
  // current pillars — no stale cached value to keep in sync.
  get prosperityScore(): number {
    return (this.foodSupply + this.tradeWealth + this.crownReputation) / 3;
  },

  getScoreGrade(): ScoreGrade {
    const score = this.prosperityScore;
    // Standard grading bands on the 0–100 prosperity average.
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  },

  getScoreSnapshot(): ScoreSnapshot {
    // Return a COPY (new object), not a reference to live fields. Otherwise a
    // snapshot stored at end-of-phase would keep changing as the game went on.
    return {
      foodSupply: this.foodSupply,
      tradeWealth: this.tradeWealth,
      crownReputation: this.crownReputation,
    };
  },

  recordPhaseSnapshot(phase: GamePhase): void {
    this.phaseSnapshots[phase] = this.getScoreSnapshot();
  },

  onScoreChanged(cb: ScoreChangedListener): () => void {
    scoreChangedListeners.add(cb);
    return () => {
      scoreChangedListeners.delete(cb);
    };
  },

  reset(): void {
    this.foodSupply = 50;
    this.tradeWealth = 50;
    this.crownReputation = 50;
    // Drop every recorded snapshot by swapping in a fresh empty record.
    this.phaseSnapshots = {};
    emitScoreChanged();
  },
};

/**
 * Internal "fire the score-changed event" helper. We hand each listener a
 * fresh snapshot (a copy) so subscribers can't accidentally mutate the live
 * scores. Snapshot the listener Set first so a subscribe/unsubscribe inside a
 * callback can't disturb the loop in progress.
 */
function emitScoreChanged(): void {
  const snapshot = colonyScore.getScoreSnapshot();
  for (const listener of [...scoreChangedListeners]) {
    listener(snapshot);
  }
}
