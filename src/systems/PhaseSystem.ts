/**
 * PhaseSystem.ts — the season state machine for Virginia Ventures.
 *
 * Replaces the Unity "PhaseController" MonoBehaviour. Its job: whenever the game
 * phase changes, turn ON the objects that belong to the new phase and turn OFF
 * everything else — the colony visibly becomes an Arrival beach, then a Spring
 * farm, then a Summer market, and so on.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UNITY → WEB MENTAL MODEL (read this if you're coming from Unity)
 * ─────────────────────────────────────────────────────────────────────────
 * 1) SUBSCRIBING TO EVENTS — Awake() vs init().
 *    In Unity you'd hook the event in Awake/OnEnable:
 *        void Awake() { GameState.OnPhaseChanged += HandlePhaseChanged; }
 *        void OnDestroy() { GameState.OnPhaseChanged -= HandlePhaseChanged; }
 *    A web ECS "system" has no Awake. Its one-time setup goes in `init()`, which
 *    the World calls once after the system is registered. So `init()` IS our
 *    Awake. We subscribe to `gameState.onPhaseChanged(...)` there, and we push
 *    the returned unsubscribe function into `this.cleanupFuncs` so it runs on
 *    teardown — that's the web version of the `-=` in OnDestroy.
 *
 * 2) WHY TOGGLE ENTITIES IN CODE INSTEAD OF INSPECTOR ARRAYS.
 *    In Unity you'd drag GameObjects into five serialized `GameObject[]` arrays
 *    on the PhaseController (one array per phase) and loop over them. On the web
 *    there is no Inspector and no drag-and-drop. The data-driven equivalent is a
 *    tiny COMPONENT (`PhaseObject` below) that we attach to an entity to say
 *    "this thing belongs to phase X". The system then QUERIES for everything
 *    carrying that component. Querying (instead of hand-keeping arrays) means:
 *      - new phase content added later is picked up automatically once tagged,
 *      - nothing breaks when you add Summer/Fall after Arrival/Spring already work.
 *    (This also follows the IWSDK rule: don't store entity arrays in a system —
 *    use queries.)
 *
 * 3) "ENABLE/DISABLE" = visibility + an interactive tag.
 *    Disable  → hide the entity AND remove its `RayInteractable` tag (can't click it).
 *    Enable   → show the entity AND add `RayInteractable` (clickable this phase).
 *    A few objects (e.g. crops planted in Spring) should stay VISIBLE in later
 *    phases but become non-interactive — that's the `persistVisible` flag.
 */

import {
  createComponent,
  createSystem,
  RayInteractable,
  Types,
  type Entity,
} from '@iwsdk/core';

import { gameState, PHASE_ORDER, type GamePhase } from '../game/GameState.js';
import { colonyScore } from '../game/ColonyScore.js';

/**
 * PhaseObject — the "which phase do I belong to?" tag.
 *
 * Attach this to any entity that should appear/disappear with the seasons:
 *     entity.addComponent(PhaseObject, { phase: 'Spring' });
 * That single line is the code equivalent of dragging the object into the
 * "Spring" array on a Unity Inspector.
 *
 * Fields:
 *  - `phase`          the phase this object is active/interactive in.
 *  - `persistVisible` if true, the object stays VISIBLE (but non-interactive)
 *                     in any later phase too. Example: crops planted in Spring
 *                     remain on the ground through Summer/Fall, just not clickable.
 */
export const PhaseObject = createComponent('PhaseObject', {
  phase: { type: Types.String, default: 'Arrival' },
  persistVisible: { type: Types.Boolean, default: false },
});

export class PhaseSystem extends createSystem({
  // Query EVERY entity tagged as belonging to a phase. `this.queries.phaseObjects
  // .entities` is always the live, up-to-date set — no manual bookkeeping.
  phaseObjects: { required: [PhaseObject] },
}) {
  init() {
    // (1) Keep newly-created phase objects in sync. When an entity gains a
    //     PhaseObject component at any time (now or far in the future), apply
    //     the CURRENT phase to it immediately so it shows/hides correctly. The
    //     `true` replays this for objects that already exist at subscribe time.
    this.cleanupFuncs.push(
      this.queries.phaseObjects.subscribe(
        'qualify',
        (entity) => {
          this.disablePhaseObject(entity);
          this.enableIfBelongs(entity, gameState.currentPhase);
        },
        true, // replayExisting — also fire for entities already present
      ),
    );

    // (2) React to phase changes (the web version of `OnPhaseChanged += ...`).
    //     `onPhaseChanged` hands us (oldPhase, newPhase).
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase, newPhase) => {
        // STEP 4 — snapshot the score for the phase that JUST ENDED.
        // The emitter fires synchronously the instant the phase flips, so the
        // scores are still exactly what they were at the end of `oldPhase`.
        // Recording here is equivalent to "snapshot just before advancePhase".
        // The Results Dashboard later reads phaseSnapshots to show
        // end-of-Spring vs end-of-Summer values side by side.
        colonyScore.recordPhaseSnapshot(oldPhase);

        // Then swap the visible/interactive world over to the new phase.
        this.activatePhase(newPhase);
      }),
    );

    // (3) Apply the starting phase once at boot so Arrival's objects are live
    //     from frame one (no event has fired yet at this point).
    this.activatePhase(gameState.currentPhase);
  }

  /**
   * activatePhase — the heart of the state machine.
   *
   * Implemented exactly as the brief describes it: FIRST disable every phase
   * group, THEN enable only the ones the active phase owns. Doing it in two
   * clean passes means we never have to special-case "what was on before" — we
   * always start from a known all-off state.
   */
  activatePhase(active: GamePhase): void {
    // Pass A — turn EVERYTHING off (hidden + non-interactive).
    for (const entity of this.queries.phaseObjects.entities) {
      this.disablePhaseObject(entity);
    }
    // Pass B — turn back on only what belongs to the active phase (plus any
    // "persistVisible" scenery from earlier phases, kept visible but locked).
    for (const entity of this.queries.phaseObjects.entities) {
      this.enableIfBelongs(entity, active);
    }

    // The brief asks for this exact log line on every change.
    console.log(`Phase changed to: ${active}`);

    // Per-phase activation hooks. The generic two-pass above already handles the
    // 3D PhaseObject scenery (e.g. Spring crops tagged `persistVisible` stay
    // VISIBLE-but-non-interactive in Summer; Arrival/Spring scenery toggles
    // exactly as before — that handling is untouched).
    //
    // Summer's interactive CONTENT is not PhaseObject scenery — it's owned by
    // dedicated systems that each react to gameState.onPhaseChanged, so it lights
    // up the moment the phase flips and we must NOT re-toggle it here (that would
    // double-fire need generation or force-show the "hidden until selected" trade
    // panel). For reference, entering Summer brings up:
    //   • NeedsSystem        — generates needs + shows the Settlement Needs panel
    //   • MarketSystem        — the 3 stalls + the trade panel (hidden until a
    //                           stall is selected)
    //   • FarmVisitSystem     — makes Thomas's & Elizabeth's farms visitable
    //   • InventoryHudSystem  — the goods readout (persistent across phases)
    // Earlier-phase UI (supply selection / arrival sequence / planting UI) belongs
    // to those phases' own content and is simply not active outside them.
    if (active === 'Spring') {
      // Spring's content: the 4x4 field + seed bags are PhaseObject scenery
      // (toggled by the two-pass above); Thomas's advice (ThomasAdviceSystem)
      // and the planting HUD (SpringPlantingSystem) light up via their own
      // phase listeners — same pattern as Summer below.
      console.log('Spring phase activated — farm ready, Thomas available');
    }
    if (active === 'Summer') {
      console.log(
        'Summer phase activated — Needs generated, market open, farms visitable',
      );
    }
    if (active === 'Fall') {
      // Fall ("The Trade Ship") follows the SAME design as Summer: its
      // interactive content is NOT PhaseObject scenery — it's owned by dedicated
      // systems that each react to gameState.onPhaseChanged, so we must not
      // re-toggle it here. Entering Fall brings up, in sequence:
      //   • TradeShipArrival   — ship-arrival cinematic + Captain dialogue
      //   • RoyalDecreeSystem  — the Crown's three mercantilism rules
      //   • ShipTrading        — Royal Trading Company panel (20% tobacco tax)
      //   • SmugglingChoice    — the Smuggler (kept HIDDEN until his Step-4 beat)
      //   • TradeShipDeparture — farewell, recap, and the hand-off to Winter
      // The ship and Captain are existing always-visible waterfront/colonist
      // scenery the Fall systems animate (so they need no toggling here either).
      //
      // The colony's OTHER content correctly goes quiet on its own: every Summer
      // system gates its interactivity to the Summer phase (MarketSystem stalls,
      // FarmVisitSystem triggers, NeedsSystem's panel, SummerRecap), so leaving
      // Summer already disabled them — the buildings, farm, and market NPCs stay
      // VISIBLE but non-interactive, as if watching the ship.
      console.log('Fall phase activated — Trade ship arriving');
    }
  }

  /** Disable: hide the object and strip its interactive tag. */
  private disablePhaseObject(entity: Entity): void {
    if (entity.object3D) entity.object3D.visible = false;
    if (entity.hasComponent(RayInteractable))
      entity.removeComponent(RayInteractable);
  }

  /**
   * Enable the entity if it belongs to `active` — or keep it visible-but-locked
   * if it's a persistent object from an earlier phase.
   */
  private enableIfBelongs(entity: Entity, active: GamePhase): void {
    const owner = (entity.getValue(PhaseObject, 'phase') ?? 'Arrival') as GamePhase;
    const persistVisible = entity.getValue(PhaseObject, 'persistVisible') ?? false;

    const activeIdx = PHASE_ORDER.indexOf(active);
    const ownerIdx = PHASE_ORDER.indexOf(owner);

    if (ownerIdx === activeIdx) {
      // This is the active phase's own object → fully enabled (show + clickable).
      if (entity.object3D) entity.object3D.visible = true;
      if (!entity.hasComponent(RayInteractable))
        entity.addComponent(RayInteractable);
    } else if (persistVisible && activeIdx > ownerIdx) {
      // Older scenery that should linger (e.g. Spring crops seen in Summer):
      // visible, but NOT interactive. Leave RayInteractable off (Pass A
      // already removed it) and just make it visible again.
      if (entity.object3D) entity.object3D.visible = true;
    }
    // Otherwise it stays disabled (already handled by Pass A).
  }
}
