/**
 * GameState.ts — the shared, session-long game state for Virginia Ventures.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UNITY → WEB MENTAL MODEL (read this first if you're coming from Unity)
 * ─────────────────────────────────────────────────────────────────────────
 * In Unity you'd typically write a `GameManager` MonoBehaviour, mark it
 * `DontDestroyOnLoad`, and expose a static `Instance` so every scene could
 * reach the same object. You did that because loading a new *scene* in Unity
 * destroys every GameObject in the old scene — so without DontDestroyOnLoad
 * your manager (and its data) would be wiped between levels.
 *
 * On the web there are NO Unity scenes. The whole experience is one running
 * JavaScript program (one browser tab). An ES module is evaluated exactly
 * once, the first time it is imported, and the values it creates live for as
 * long as the tab is open. So a plain module-level object IS already a
 * "DontDestroyOnLoad singleton":
 *
 *   - Imported once          → like `Instance` being created once.
 *   - Shared by every import → every file that imports `gameState` gets the
 *                              exact same object reference (not a copy).
 *   - Survives the session   → nothing reloads it until the page reloads,
 *                              which is the web equivalent of quitting the app.
 *
 * The C# `event Action<...>` you'd fire from the manager becomes a tiny
 * hand-rolled emitter here: a Set of callback functions that we loop over and
 * call. Subscribing = `+=`, the callback list = the invocation list, emitting
 * = invoking the event. See `onPhaseChanged` / `emitPhaseChanged` below.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * The five phases of the colony experience. In Unity these might have been
 * separate scenes; here they're just a string union (a lightweight enum).
 */
export type GamePhase = 'Arrival' | 'Spring' | 'Summer' | 'Fall' | 'Winter';

/**
 * The fixed order phases advance through. `advancePhase()` walks this array.
 * 'Arrival' is the intro; the four seasons follow in calendar order.
 */
export const PHASE_ORDER: GamePhase[] = [
  'Arrival',
  'Spring',
  'Summer',
  'Fall',
  'Winter',
];

/**
 * The shape of a phase-changed listener. Mirrors C#'s
 * `event Action<GamePhase, GamePhase>` — it receives (oldPhase, newPhase).
 */
export type PhaseChangedListener = (
  oldPhase: GamePhase,
  newPhase: GamePhase,
) => void;

/** The shape of an end-of-simulation listener (no args — it's a simple signal). */
export type SimulationCompleteListener = () => void;

/**
 * A phase-transition runner. When registered (by the PhaseTransitionSystem), a
 * phase change is handed to it INSTEAD of being applied immediately: the runner
 * plays the chapter card and calls `commit()` at the right moment, so the new
 * phase only activates once the card has covered the screen. With no runner
 * registered, changes commit immediately (the original behavior).
 */
export type PhaseTransitionRunner = (
  oldPhase: GamePhase,
  newPhase: GamePhase,
  commit: () => void,
) => void;

/**
 * The shape of our shared state object. Kept as an interface so the exported
 * object below gets full type-checking and editor autocomplete.
 */
export interface GameState {
  currentPhase: GamePhase;
  decisionLog: string[];

  /**
   * The Spring planting result: how many of the 16 cells were planted with each
   * crop. Stored here (on the session-long singleton) so later phases and the
   * end-of-game review can read the split. Set by `recordPlanting` when the
   * student confirms their field at the end of Spring; 0/0 until then.
   */
  cornCells: number;
  tobaccoCells: number;

  /**
   * Index into PHASE_ORDER of the furthest phase the player has reached. Phases
   * at or before this are UNLOCKED (selectable from the season banner); phases
   * beyond it stay LOCKED until the seasons are finished in order. Starts at 0
   * (only 'Arrival' unlocked). This is what powers the locked progress tracker.
   */
  furthestPhaseIndex: number;

  /** True if `phase` has been reached and may be selected from the banner. */
  isPhaseUnlocked(phase: GamePhase): boolean;

  /**
   * True once the player has advanced PAST `phase` — its graded decisions are
   * final. Scripted/one-time content (cutscenes, need generation, the planting
   * confirm) guards on this so revisiting a finished season is non-destructive.
   */
  hasCompletedPhase(phase: GamePhase): boolean;

  /** Subscribe to phase changes. Returns an unsubscribe function. */
  onPhaseChanged(cb: PhaseChangedListener): () => void;

  /**
   * Subscribe to the end-of-simulation event — fired once when the student
   * finishes the Winter reflection. The surrounding course shell can react to
   * this (e.g. mark the lesson done). Returns an unsubscribe function.
   */
  onSimulationComplete(cb: SimulationCompleteListener): () => void;

  /** Fire `onSimulationComplete` (called by the reflection's Finish button). */
  completeSimulation(): void;

  /** Record the Spring planting split (clamped to non-negative whole numbers). */
  recordPlanting(cornCells: number, tobaccoCells: number): void;

  /** Advance to the next season in PHASE_ORDER (no-op past 'Winter'). */
  advancePhase(): void;

  /** Jump straight to a phase. Handy for testing from the browser console. */
  setPhase(phase: GamePhase): void;

  /**
   * Register the phase-transition runner (the chapter-card system). Pass `null`
   * to clear it and go back to immediate phase changes.
   */
  setTransitionRunner(runner: PhaseTransitionRunner | null): void;

  /** Record a player decision (for end-of-game review / scoring). */
  logDecision(description: string): void;

  /** Reset everything back to a fresh 'Arrival' start. */
  resetGame(): void;
}

/**
 * The emitter's backing store: a Set of listener callbacks.
 *
 * Why a Set and not an array? A Set automatically de-duplicates, so
 * subscribing the same function twice won't fire it twice, and removing a
 * listener is O(1). This is our equivalent of C#'s event invocation list.
 *
 * It lives at module scope (outside the object) so it's truly private — no
 * other file can reach in and tamper with the subscriber list.
 */
const phaseChangedListeners = new Set<PhaseChangedListener>();

/**
 * Backing store for the end-of-simulation event. Same hand-rolled emitter
 * pattern as the phase-changed event above (a private Set of callbacks).
 */
const simulationCompleteListeners = new Set<SimulationCompleteListener>();

/** Fire the simulation-complete event (snapshot the Set first, as above). */
function emitSimulationComplete(): void {
  for (const listener of [...simulationCompleteListeners]) {
    listener();
  }
}

/**
 * Internal "fire the event" helper. We snapshot the listeners into an array
 * before iterating so that a listener which unsubscribes (or subscribes)
 * during the callback can't corrupt the loop we're currently running.
 * This is the web stand-in for raising a C# event: `PhaseChanged?.Invoke(...)`.
 */
function emitPhaseChanged(oldPhase: GamePhase, newPhase: GamePhase): void {
  for (const listener of [...phaseChangedListeners]) {
    listener(oldPhase, newPhase);
  }
}

/**
 * The currently-registered transition runner (the chapter-card system), or null
 * for immediate phase changes. Lives at module scope so it's private.
 */
let transitionRunner: PhaseTransitionRunner | null = null;

/**
 * Apply a phase change — either immediately, or (if a runner is registered)
 * handed to the runner which commits it after the chapter card. The actual
 * commit (flip `currentPhase` + emit) is the same in both paths.
 */
function applyPhaseChange(
  state: GameState,
  oldPhase: GamePhase,
  newPhase: GamePhase,
): void {
  const commit = () => {
    state.currentPhase = newPhase;
    // Unlock progress: record the furthest phase ever reached so the banner can
    // gate locked (future) phases while still allowing revisits of past ones.
    const newIdx = PHASE_ORDER.indexOf(newPhase);
    if (newIdx > state.furthestPhaseIndex) state.furthestPhaseIndex = newIdx;
    emitPhaseChanged(oldPhase, newPhase);
  };
  if (transitionRunner) transitionRunner(oldPhase, newPhase, commit);
  else commit();
}

/**
 * THE singleton. Every `import { gameState }` anywhere in the app receives
 * this same object. No `new`, no DontDestroyOnLoad, no static Instance
 * boilerplate — the module system gives us all of that for free.
 */
export const gameState: GameState = {
  // Starting values. The game always opens in 'Arrival' with an empty log and
  // nothing planted yet.
  currentPhase: 'Arrival',
  decisionLog: [],
  cornCells: 0,
  tobaccoCells: 0,
  furthestPhaseIndex: 0,

  onPhaseChanged(cb: PhaseChangedListener): () => void {
    // Subscribe (the web version of `PhaseChanged += cb`).
    phaseChangedListeners.add(cb);
    // Return an unsubscribe closure (the version of `PhaseChanged -= cb`).
    // Callers should call this in their cleanup to avoid leaks.
    return () => {
      phaseChangedListeners.delete(cb);
    };
  },

  advancePhase(): void {
    const oldPhase = this.currentPhase;
    const currentIndex = PHASE_ORDER.indexOf(oldPhase);
    const nextIndex = currentIndex + 1;

    // Guard against running off the end of the calendar. After 'Winter'
    // there's no next season, so we simply do nothing (and don't emit).
    if (nextIndex >= PHASE_ORDER.length) {
      return;
    }

    const newPhase = PHASE_ORDER[nextIndex];
    applyPhaseChange(this, oldPhase, newPhase);
  },

  setPhase(phase: GamePhase): void {
    const oldPhase = this.currentPhase;
    // Setting to the phase we're already in is a no-op — no spurious event.
    if (phase === oldPhase) {
      return;
    }
    // Locked-progress rule: a player may revisit a phase they've already
    // reached, but cannot jump ahead to one they haven't unlocked by finishing
    // the prior seasons in order. Forward motion happens via advancePhase().
    if (PHASE_ORDER.indexOf(phase) > this.furthestPhaseIndex) {
      return;
    }
    applyPhaseChange(this, oldPhase, phase);
  },

  isPhaseUnlocked(phase: GamePhase): boolean {
    return PHASE_ORDER.indexOf(phase) <= this.furthestPhaseIndex;
  },

  hasCompletedPhase(phase: GamePhase): boolean {
    return PHASE_ORDER.indexOf(phase) < this.furthestPhaseIndex;
  },

  setTransitionRunner(runner: PhaseTransitionRunner | null): void {
    transitionRunner = runner;
  },

  logDecision(description: string): void {
    this.decisionLog.push(description);
  },

  recordPlanting(cornCells: number, tobaccoCells: number): void {
    // Cell counts can't be negative or fractional.
    this.cornCells = Math.max(0, Math.floor(cornCells));
    this.tobaccoCells = Math.max(0, Math.floor(tobaccoCells));
  },

  onSimulationComplete(cb: SimulationCompleteListener): () => void {
    // Subscribe (the web version of `SimulationComplete += cb`).
    simulationCompleteListeners.add(cb);
    return () => {
      simulationCompleteListeners.delete(cb);
    };
  },

  completeSimulation(): void {
    // Fire the one-time "the year + reflection are done" event. Purely a
    // signal — it touches no scores and writes nothing to the decision log.
    emitSimulationComplete();
  },

  resetGame(): void {
    const oldPhase = this.currentPhase;
    this.currentPhase = 'Arrival';
    // Clear in place (length = 0) so any code holding a reference to the same
    // array still sees the cleared contents — matches singleton semantics.
    this.decisionLog.length = 0;
    this.cornCells = 0;
    this.tobaccoCells = 0;
    this.furthestPhaseIndex = 0;
    // Fire so listeners (UI, etc.) re-render for the fresh start. We emit even
    // if we were already on 'Arrival' because a reset is a meaningful event.
    emitPhaseChanged(oldPhase, 'Arrival');
  },
};
