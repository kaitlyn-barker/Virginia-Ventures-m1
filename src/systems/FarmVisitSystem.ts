/**
 * FarmVisitSystem.ts — the two neighbouring farms you can visit in Summer.
 *
 * Beyond the central market (MarketSystem), two neighbours run their own farm
 * plots out at the edges of the settlement and will barter directly:
 *
 *   - Thomas (the Spring farmer NPC, reused) — has surplus CORN, wants tobacco.
 *     If you also went heavy on corn in Spring he can't help and points you to
 *     James instead.
 *   - Elizabeth — has HERBS, and will take corn OR tobacco for them.
 *
 * Both reuse the *exact same* trade panel as the market: this system just hands
 * a trader definition to `MarketSystem.openTradeWith(...)`. The farms only
 * become visitable during Summer, and after a visit the player is returned to
 * the settlement centre.
 */

import {
  createComponent,
  createSystem,
  Pressed,
  RayInteractable,
  Transform,
  Types,
  type Entity,
} from '@iwsdk/core';

import { gameState } from '../game/GameState.js';
import { playerInventory } from '../game/PlayerInventory.js';
import { MarketSystem, type TraderDef } from './MarketSystem.js';

/** Marks a visitable farm NPC and remembers whose farm it is. */
export const FarmPlot = createComponent('FarmPlot', {
  farmer: { type: Types.String, default: '' },
});

/** The neighbours whose farms can be visited (matched by NPC name). */
const FARMERS = ['Thomas', 'Elizabeth'] as const;

/** Planting "mostly corn" threshold that changes Thomas's response. */
const CORN_HEAVY_CELLS = 8;

/**
 * Thomas's normal offer: surplus corn for tobacco. 2 tobacco = 4 corn, i.e.
 * 0.5 tobacco per corn. (Received corn IS a tradeable good, so it lands back in
 * the player's inventory — MarketSystem routes it there automatically.)
 */
const THOMAS: TraderDef = {
  greeting: 'Back again, neighbor! I have plenty of corn this season.',
  wants: ['tobacco'],
  stock: { corn: 6 },
  offers: [{ item: 'corn', price: { tobacco: 0.5 } }],
};

/** Thomas when the player ALSO planted mostly corn — nothing to offer. */
const THOMAS_CORN_HEAVY: TraderDef = {
  greeting:
    'Looks like we both went heavy on corn! I cannot help you there, but James at the market might trade tools for your extra.',
  wants: ['tobacco'],
  stock: {},
  offers: [],
};

/**
 * Elizabeth: herbs for corn OR tobacco. 3 corn = 2 herbs (1.5 corn/herb) OR
 * 1 tobacco = 2 herbs (0.5 tobacco/herb). `mode: 'or'` lets either currency
 * (or a mix) pay.
 */
const ELIZABETH: TraderDef = {
  greeting:
    'My garden does well in this soil. But I need food for my children. What can you offer?',
  wants: ['corn', 'tobacco'],
  mode: 'or',
  stock: { herbs: 4 },
  offers: [{ item: 'herbs', price: { corn: 1.5, tobacco: 0.5 } }],
};

export class FarmVisitSystem extends createSystem({
  // Every transform entity — scanned once to find the farmer NPCs by name.
  npcCandidates: { required: [Transform] },
  // The tagged farm NPCs (used to toggle interactivity per phase).
  farms: { required: [FarmPlot] },
  // A farm the player just pressed (point + trigger).
  pressedFarms: { required: [FarmPlot, Pressed] },
}) {
  private tagged = new Set<string>();

  init() {
    // Find Thomas & Elizabeth by name and tag them (without editing Colonists.ts).
    this.cleanupFuncs.push(
      this.queries.npcCandidates.subscribe(
        'qualify',
        (entity) => this.tryTagFarm(entity),
        true,
      ),
    );

    // Farms are only visitable in Summer: toggle ray-interactivity on each
    // phase change (and apply the current phase right away).
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((_old, next) =>
        // Read-only on a revisited (finished) Summer, like the market — a player
        // looking back can't re-visit a neighbour to change their final score.
        this.setFarmsVisitable(
          next === 'Summer' && !gameState.hasCompletedPhase('Summer'),
        ),
      ),
    );
    this.setFarmsVisitable(
      gameState.currentPhase === 'Summer' &&
        !gameState.hasCompletedPhase('Summer'),
    );

    // Open the shared trade panel when a farm is pressed.
    this.cleanupFuncs.push(
      this.queries.pressedFarms.subscribe('qualify', (entity) => {
        if (
          gameState.currentPhase === 'Summer' &&
          !gameState.hasCompletedPhase('Summer')
        )
          this.openVisit(entity);
      }),
    );
  }

  /** Tag a farmer NPC with FarmPlot (interactivity is toggled per phase). */
  private tryTagFarm(entity: Entity): void {
    const name = entity.object3D?.name ?? '';
    if (!FARMERS.includes(name as (typeof FARMERS)[number]) || this.tagged.has(name))
      return;
    this.tagged.add(name);
    if (!entity.hasComponent(FarmPlot)) entity.addComponent(FarmPlot, { farmer: name });
    // Apply the current phase's interactivity to the freshly-tagged farm.
    this.setOneVisitable(
      entity,
      gameState.currentPhase === 'Summer' &&
        !gameState.hasCompletedPhase('Summer'),
    );
  }

  /** Add/remove RayInteractable on every tagged farm. */
  private setFarmsVisitable(on: boolean): void {
    for (const farm of this.queries.farms.entities) this.setOneVisitable(farm, on);
  }

  private setOneVisitable(entity: Entity, on: boolean): void {
    const has = entity.hasComponent(RayInteractable);
    if (on && !has) entity.addComponent(RayInteractable);
    else if (!on && has) entity.removeComponent(RayInteractable);
  }

  /** Open the right trader definition for this farm in the shared panel. */
  private openVisit(entity: Entity): void {
    const market = this.world.getSystem(MarketSystem);
    if (!market) return;

    const farmer = entity.getValue(FarmPlot, 'farmer') ?? '';
    let def: TraderDef;
    if (farmer === 'Thomas') {
      def =
        playerInventory.getPlantedCorn() >= CORN_HEAVY_CELLS
          ? THOMAS_CORN_HEAVY
          : THOMAS;
    } else {
      def = ELIZABETH;
    }

    market.openTradeWith(farmer, def, entity, {
      onClose: () => this.returnToCenter(),
    });
  }

  /** After a visit, bring the player rig back to the settlement centre. */
  private returnToCenter(): void {
    this.player.position.set(0, 0, 0);
    this.player.rotation.set(0, 0, 0);
  }
}
