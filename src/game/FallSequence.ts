/**
 * FallSequence.ts — the tiny step-coordinator for the Fall "Trade Ship" phase.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (and why it's separate from gameState)
 * ─────────────────────────────────────────────────────────────────────────
 * Fall is not one screen — it is a SCRIPTED SEQUENCE of beats that must run in
 * order, each owned by its own system:
 *
 *     Step 1  TradeShipArrival   — ship arrival cinematic + Captain's dialogue
 *     Step 2  RoyalDecreeSystem  — the Crown's mercantilism rules (the decree)
 *     Step 3  (next milestone)   — Ship Trading with the 20% tobacco tax
 *
 * gameState.onPhaseChanged tells everyone "we are now in Fall", but it can't say
 * "Step 1 just finished, Step 2 may begin". That hand-off between beats is what
 * this file carries. It is the SAME hand-rolled emitter idiom the other session
 * singletons use (GameState / ColonyScore / PlayerInventory / SummerProgress): a
 * Set of callbacks we invoke. Subscribing = C#'s `+=`, emitting = raising the
 * event.
 *
 * Keeping the beats decoupled through this emitter (instead of one system
 * reaching into the next) means Step 3 can be built later by simply subscribing
 * to `onDecreeAccepted` — Steps 1 and 2 never have to change to know about it.
 * That is exactly the seam the Summer→Fall systems left for Fall, applied again
 * one level down.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** A Fall-step listener takes no args — the event name carries the meaning. */
export type FallStepListener = () => void;

export interface FallSequence {
  /**
   * Step 1 → Step 2 seam. TradeShipArrival fires this once the Captain finishes
   * his arrival dialogue; RoyalDecreeSystem listens and presents the decree.
   */
  onArrivalComplete(cb: FallStepListener): () => void;
  emitArrivalComplete(): void;

  /**
   * Step 2 → Step 3 seam. RoyalDecreeSystem fires this when the player clicks
   * "Continue" on the decree. ShipTrading listens here to open the trade panel.
   */
  onDecreeAccepted(cb: FallStepListener): () => void;
  emitDecreeAccepted(): void;

  /**
   * Step 3 → Step 4 seam. ShipTrading fires this when the player clicks "Finish
   * Trading". SmugglingChoice listens to start the smuggler encounter.
   */
  onTradingComplete(cb: FallStepListener): () => void;
  emitTradingComplete(): void;

  /**
   * Step 4 → Step 5 seam. SmugglingChoice fires this once the smuggler beat is
   * resolved (whether the player smuggled or refused). It is also where
   * TradeShipArrival finally releases its cinematic camera/rig hold — the whole
   * Fall set-piece (arrival → decree → trading → smuggling) plays against the
   * same held dock framing, and control returns to the player only here.
   */
  onSmugglingComplete(cb: FallStepListener): () => void;
  emitSmugglingComplete(): void;
}

/**
 * Private subscriber lists, one per event. Sets de-duplicate and remove in O(1)
 * — see GameState for the fuller "why a Set" explanation.
 */
const arrivalListeners = new Set<FallStepListener>();
const decreeListeners = new Set<FallStepListener>();
const tradingListeners = new Set<FallStepListener>();
const smugglingListeners = new Set<FallStepListener>();

/** Snapshot-before-iterate so a callback that (un)subscribes can't corrupt the loop. */
function emit(listeners: Set<FallStepListener>): void {
  for (const listener of [...listeners]) listener();
}

/**
 * THE singleton. Every `import { fallSequence }` receives this same object, for
 * the life of the tab — no `new`, no ceremony (see GameState for the full
 * Unity→web explanation).
 */
export const fallSequence: FallSequence = {
  onArrivalComplete(cb) {
    arrivalListeners.add(cb);
    return () => {
      arrivalListeners.delete(cb);
    };
  },
  emitArrivalComplete() {
    emit(arrivalListeners);
  },

  onDecreeAccepted(cb) {
    decreeListeners.add(cb);
    return () => {
      decreeListeners.delete(cb);
    };
  },
  emitDecreeAccepted() {
    emit(decreeListeners);
  },

  onTradingComplete(cb) {
    tradingListeners.add(cb);
    return () => {
      tradingListeners.delete(cb);
    };
  },
  emitTradingComplete() {
    emit(tradingListeners);
  },

  onSmugglingComplete(cb) {
    smugglingListeners.add(cb);
    return () => {
      smugglingListeners.delete(cb);
    };
  },
  emitSmugglingComplete() {
    emit(smugglingListeners);
  },
};
