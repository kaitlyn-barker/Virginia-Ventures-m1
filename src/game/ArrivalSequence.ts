/**
 * ArrivalSequence.ts — the tiny coordinator for the "Arrival" intro phase.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (and why it's separate from gameState)
 * ─────────────────────────────────────────────────────────────────────────
 * The game boots in the 'Arrival' phase with the welcome panel up. But the
 * orientation cinematic must NOT play on boot — it plays only once the student
 * presses "Enter the Colony" on that panel. gameState.onPhaseChanged can't
 * carry that "the player just pressed Enter" signal (we're already in Arrival,
 * so no phase flip happens), and the welcome panel lives in a different system
 * (PanelSystem) than the one that runs the cinematic (ArrivalCinematic).
 *
 * This singleton is the seam between them. It is the SAME hand-rolled emitter
 * idiom the other session singletons use (GameState / FallSequence / …): a Set
 * of callbacks we invoke. PanelSystem fires `emitEnterColony()` on the button
 * click; ArrivalCinematic listens via `onEnterColony` and starts the tour
 * (and ScoreHudSystem listens on the same seam to reveal the score HUD).
 * Decoupling them through this emitter means neither has to import the other.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** An Arrival listener takes no args — the event name carries the meaning. */
export type ArrivalListener = () => void;

export interface ArrivalSequence {
  /**
   * Welcome → cinematic seam. PanelSystem fires this when the student clicks
   * "Enter the Colony"; ArrivalCinematic listens and begins the guided tour
   * (and ScoreHudSystem reveals the score HUD).
   */
  onEnterColony(cb: ArrivalListener): () => void;
  emitEnterColony(): void;

  /**
   * Cinematic-done seam. ArrivalCinematic fires this once the tour finishes and
   * control returns to the player. Nothing consumes it yet, but it's the hook a
   * later beat (e.g. an auto-advance into Spring, or a "Begin" prompt) can use
   * without ArrivalCinematic ever having to change.
   */
  onCinematicComplete(cb: ArrivalListener): () => void;
  emitCinematicComplete(): void;
}

/** Private subscriber lists, one per event (a Set de-dupes + removes in O(1)). */
const enterListeners = new Set<ArrivalListener>();
const completeListeners = new Set<ArrivalListener>();

/** Snapshot-before-iterate so a callback that (un)subscribes can't corrupt the loop. */
function emit(listeners: Set<ArrivalListener>): void {
  for (const listener of [...listeners]) listener();
}

/** THE singleton — every `import { arrivalSequence }` shares this one object. */
export const arrivalSequence: ArrivalSequence = {
  onEnterColony(cb) {
    enterListeners.add(cb);
    return () => {
      enterListeners.delete(cb);
    };
  },
  emitEnterColony() {
    emit(enterListeners);
  },

  onCinematicComplete(cb) {
    completeListeners.add(cb);
    return () => {
      completeListeners.delete(cb);
    };
  },
  emitCinematicComplete() {
    emit(completeListeners);
  },
};
