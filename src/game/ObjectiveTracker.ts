/**
 * ObjectiveTracker.ts — the shared completion state behind the on-screen
 * quest tracker (see systems/ObjectiveTrackerSystem.ts).
 *
 * This is a tiny VIEW-MODEL, not gameplay: it owns no scores, no inventory, no
 * phase logic. It just remembers which checklist sub-tasks the player has
 * finished and fires a change event so the tracker panel can repaint. Every
 * gameplay system stays exactly as it was; each one simply *reports* a finished
 * step here by calling `objectiveTracker.completeSubTask(id)` (or, for the one
 * sub-task that counts toward a target, `setProgress(id, current, total)`).
 *
 * Same hand-rolled emitter pattern as SpringProgress / ColonyScore: a Set of
 * completed ids, a Set of listeners, and a snapshot-before-iterate emit so a
 * subscribe/unsubscribe inside a callback is safe.
 */

/** A sub-task id, e.g. 'spring-confirm'. Defined alongside the objective data. */
export type ObjectiveTaskId = string;

/** Live progress for a counted sub-task (e.g. settlement needs met). */
export interface TaskProgress {
  current: number;
  total: number;
}

type ChangeListener = (taskId: ObjectiveTaskId) => void;

const completed = new Set<ObjectiveTaskId>();
const progress = new Map<ObjectiveTaskId, TaskProgress>();
const listeners = new Set<ChangeListener>();

export const objectiveTracker = {
  /**
   * Mark a sub-task done. Idempotent — completing the same id twice is a no-op,
   * so callers don't need their own "already fired" guards. Fires the change
   * event (which the tracker panel uses to fill the circle, pulse, ding, and
   * glow the next task).
   */
  completeSubTask(taskId: ObjectiveTaskId): void {
    if (completed.has(taskId)) return;
    completed.add(taskId);
    emit(taskId);
  },

  /**
   * Report live progress for a counted sub-task (the Summer "meet your needs"
   * row). When `current` reaches `total` the task is also marked complete. Each
   * call fires the change event so the label can update as needs are met.
   */
  setProgress(taskId: ObjectiveTaskId, current: number, total: number): void {
    progress.set(taskId, { current, total });
    if (total > 0 && current >= total) completed.add(taskId);
    emit(taskId);
  },

  /** True once this sub-task has been completed. */
  isComplete(taskId: ObjectiveTaskId): boolean {
    return completed.has(taskId);
  },

  /** The live progress for a counted sub-task, or undefined if none reported. */
  getProgress(taskId: ObjectiveTaskId): TaskProgress | undefined {
    return progress.get(taskId);
  },

  /** Subscribe to "a sub-task changed". Returns an unsubscribe function. */
  onChange(cb: ChangeListener): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },

  /** Wipe all progress (used by the dev "restart" path). */
  reset(): void {
    completed.clear();
    progress.clear();
    emit('reset');
  },
};

/** Snapshot the listener set first so a callback may (un)subscribe safely. */
function emit(taskId: ObjectiveTaskId): void {
  for (const listener of [...listeners]) listener(taskId);
}
