/**
 * PlayerInventory.ts — the colony's stock of tradeable goods.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS (and how Spring feeds Summer)
 * ─────────────────────────────────────────────────────────────────────────
 * This is the player's "what do I actually have to trade?" ledger. It carries
 * the consequences of Spring planting straight into Summer's barter phase:
 *
 *   - Corn        — one unit per CORN cell planted in Spring. Corn feeds the
 *                   settlement but is worth little in trade.
 *   - Tobacco     — one unit per TOBACCO cell planted in Spring. Tobacco is the
 *                   cash crop: great to trade, but you can't eat it.
 *   - Trade goods — a fixed 3 from the arrival supply package (tools, cloth,
 *                   beads brought across the Atlantic).
 *
 * The Spring planting decision therefore PRELOADS Summer: a player who planted
 * all tobacco arrives at the market rich in tradeable stock but short on food,
 * while a player who planted all corn can feed everyone but has little the NPCs
 * want. There is no "best" split — that tension is the whole lesson. See
 * `initializeFromPlanting` for the exact hand-off, and the NeedsSystem for where
 * these goods get spent (trading them to meet settlement needs).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UNITY → WEB MENTAL MODEL
 * ─────────────────────────────────────────────────────────────────────────
 * In Unity you'd hang this off the GameManager and mark it DontDestroyOnLoad so
 * it survived scene loads. On the web there are no scenes: a module-level object
 * is evaluated once and lives for the whole tab. So `playerInventory` below IS a
 * session-long singleton "on the shared game state" — same lifetime as
 * `gameState` and `colonyScore`, no ceremony required. The "inventory changed"
 * event is the same hand-rolled emitter the other singletons use: a Set of
 * callbacks we invoke so the HUD can re-render reactively.
 */

import { gameState } from './GameState.js';

/** The three kinds of tradeable goods the colony can hold. */
export type GoodType = 'corn' | 'tobacco' | 'trade_goods';

/** Every good type, in display order (handy for UIs and iteration). */
export const GOOD_TYPES: GoodType[] = ['corn', 'tobacco', 'trade_goods'];

/** Fixed number of trade goods the arrival supply package provides. */
export const ARRIVAL_TRADE_GOODS = 3;

/** One line item for the HUD: a good type and how many the player holds. */
export interface InventoryItem {
  type: GoodType;
  count: number;
}

/** An inventory-changed listener receives the full current item list. */
export type InventoryChangedListener = (items: InventoryItem[]) => void;

export interface PlayerInventory {
  /** How many of `type` the player currently holds (0 if none). */
  getItemCount(type: GoodType): number;

  /**
   * Spend `amount` of `type`. Returns false (and changes nothing) if the player
   * doesn't have enough — callers use the boolean to reject a trade.
   */
  removeItems(type: GoodType, amount: number): boolean;

  /** Gain `amount` of `type` (e.g. planting a cell, or receiving in a trade). */
  addItems(type: GoodType, amount: number): void;

  /** A defensive copy of every good + count, for the HUD to render. */
  getAllItems(): InventoryItem[];

  /**
   * Seed the starting inventory from Spring's planting results. Sets corn =
   * cells of corn planted, tobacco = cells of tobacco planted, and trade goods
   * to the fixed arrival amount. Call once when Spring ends.
   */
  initializeFromPlanting(cornCells: number, tobaccoCells: number): void;

  /**
   * How many CORN / TOBACCO cells were planted in Spring (the original tally,
   * unaffected by later trading). Used by Summer content to react to the
   * Spring strategy — e.g. a neighbour who can't help a corn-heavy player.
   */
  getPlantedCorn(): number;
  getPlantedTobacco(): number;

  /** Subscribe to inventory changes. Returns an unsubscribe function. */
  onInventoryChanged(cb: InventoryChangedListener): () => void;

  /** Reset to a fresh start: no crops, just the arrival trade goods. */
  reset(): void;
}

/** Private subscriber list for the inventory-changed event (see ColonyScore). */
const inventoryChangedListeners = new Set<InventoryChangedListener>();

/** Backing store. Starts empty of crops; the arrival package seeds trade goods. */
const counts: Record<GoodType, number> = {
  corn: 0,
  tobacco: 0,
  trade_goods: ARRIVAL_TRADE_GOODS,
};

/** The original Spring planting tally (kept even as `counts` change in trade). */
let plantedCorn = 0;
let plantedTobacco = 0;

export const playerInventory: PlayerInventory = {
  getItemCount(type: GoodType): number {
    return counts[type] ?? 0;
  },

  removeItems(type: GoodType, amount: number): boolean {
    // Guard against nonsense calls; a non-positive amount removes nothing.
    if (amount <= 0) return true;
    // The core scarcity check: you can only spend what you have.
    if (counts[type] < amount) return false;
    counts[type] -= amount;
    emitInventoryChanged();
    return true;
  },

  addItems(type: GoodType, amount: number): void {
    if (amount <= 0) return;
    counts[type] += amount;
    emitInventoryChanged();
  },

  getAllItems(): InventoryItem[] {
    // Return COPIES in a stable order so the HUD can't mutate live state.
    return GOOD_TYPES.map((type) => ({ type, count: counts[type] }));
  },

  initializeFromPlanting(cornCells: number, tobaccoCells: number): void {
    // Clamp to non-negative whole numbers — cell counts can't be negative.
    counts.corn = Math.max(0, Math.floor(cornCells));
    counts.tobacco = Math.max(0, Math.floor(tobaccoCells));
    counts.trade_goods = ARRIVAL_TRADE_GOODS;

    // Remember the planting strategy permanently (trading won't change these).
    plantedCorn = counts.corn;
    plantedTobacco = counts.tobacco;

    // Record the hand-off so the end-of-game review can show what Spring left
    // the player to work with in Summer.
    gameState.logDecision(
      `[Inventory] Harvest stocked: ${counts.corn} corn, ${counts.tobacco} tobacco, ${counts.trade_goods} trade goods`,
    );

    emitInventoryChanged();
  },

  getPlantedCorn(): number {
    return plantedCorn;
  },

  getPlantedTobacco(): number {
    return plantedTobacco;
  },

  onInventoryChanged(cb: InventoryChangedListener): () => void {
    inventoryChangedListeners.add(cb);
    return () => {
      inventoryChangedListeners.delete(cb);
    };
  },

  reset(): void {
    counts.corn = 0;
    counts.tobacco = 0;
    counts.trade_goods = ARRIVAL_TRADE_GOODS;
    plantedCorn = 0;
    plantedTobacco = 0;
    emitInventoryChanged();
  },
};

/**
 * Internal "fire the inventory-changed event" helper. Hand each listener a fresh
 * copy of the item list (via getAllItems) so subscribers can't mutate live
 * counts, and snapshot the listener Set first so a subscribe/unsubscribe inside
 * a callback can't disturb the loop in progress.
 */
function emitInventoryChanged(): void {
  const items = playerInventory.getAllItems();
  for (const listener of [...inventoryChangedListeners]) {
    listener(items);
  }
}
