/**
 * SpringProgress.ts — a tiny session tracker for the Spring planting phase.
 *
 * Spring has a short checklist of sub-tasks the student works through (talk to
 * Thomas for advice, plant the field, confirm the harvest). This singleton is
 * the one place those sub-tasks are marked done, so any UI (an objectives HUD,
 * the confirm step) can read the state or subscribe to "an objective was just
 * completed" events.
 *
 * Same module-singleton pattern as gameState / colonyScore / summerProgress: a
 * plain module-level object, evaluated once, shared by every import — see
 * GameState.ts for the full Unity→web explanation of why that works.
 */

/** The Spring sub-tasks we track. Add more here as later steps need them. */
export type SpringObjective = 'talkToThomas' | 'plantField' | 'confirmHarvest';

/** Sub-tasks completed so far this Spring. A Set makes completion idempotent. */
const completed = new Set<SpringObjective>();

/** Listeners notified the first time each objective is completed. */
const listeners = new Set<(id: SpringObjective) => void>();

/** Characters the student has interacted with this Spring (e.g. 'Thomas'). */
const talked = new Set<string>();

/** Listeners notified each time the student talks to a character (with its id).
 *  This is the funnel the tutorial uses to pop a per-character script — the
 *  Spring twin of SummerProgress.onVisit. */
const talkListeners = new Set<(id: string) => void>();

export const springProgress = {
  /**
   * Mark a sub-task complete. Idempotent: completing the same objective twice
   * does nothing the second time (and does NOT re-fire listeners), so callers
   * can call it freely without guarding against repeats.
   */
  complete(id: SpringObjective): void {
    if (completed.has(id)) return;
    completed.add(id);
    // Snapshot the set first so a subscribe/unsubscribe inside a callback is safe.
    for (const listener of [...listeners]) listener(id);
  },

  /** Has this sub-task been completed yet? */
  isComplete(id: SpringObjective): boolean {
    return completed.has(id);
  },

  /** Subscribe to "an objective was just completed" events. Returns unsubscribe. */
  onComplete(cb: (id: SpringObjective) => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },

  /** The completed sub-task ids (a copy). */
  getCompleted(): SpringObjective[] {
    return [...completed];
  },

  /** Record that the student interacted with a character; notify listeners. */
  recordTalk(id: string): void {
    talked.add(id);
    // Snapshot first so a subscribe/unsubscribe inside a callback is safe.
    for (const listener of [...talkListeners]) listener(id);
  },

  /** Has the student talked to this character yet this Spring? */
  hasTalkedTo(id: string): boolean {
    return talked.has(id);
  },

  /** Subscribe to "talked to a character" events. Returns an unsubscribe fn. */
  onTalk(cb: (id: string) => void): () => void {
    talkListeners.add(cb);
    return () => {
      talkListeners.delete(cb);
    };
  },

  /** Clear everything for a fresh Spring. */
  reset(): void {
    completed.clear();
    talked.clear();
  },
};
