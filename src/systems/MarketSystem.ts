/**
 * MarketSystem.ts — the Summer market: three trader stalls and the bartering UI.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TRADING LOOP (and why it's the heart of Summer)
 * ─────────────────────────────────────────────────────────────────────────
 * The settlement has NEEDS (see NeedsSystem); the only way to meet most of them
 * is to trade the crops you grew in Spring for the goods the NPCs hold. Each
 * trader wants something different and prices their wares in it:
 *
 *   - Martha the Herbalist  — wants CORN; sells herbs & blankets.
 *   - James the Blacksmith   — wants TOBACCO; sells iron tools & timber.
 *   - Anne the General Trader— wants CORN *and* TOBACCO; sells a bit of
 *                              everything, but at a steeper price.
 *
 * So a player who planted all tobacco can deal richly with James but has nothing
 * Martha wants; an all-corn player is the reverse. That Spring→Summer tension is
 * the lesson, carried here through PlayerInventory.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS MECHANICALLY
 * ─────────────────────────────────────────────────────────────────────────
 *  - Each trader NPC (built statically in environment/Colonists.ts) is found by
 *    name and tagged with `TradeStall` + `RayInteractable`, so the InputSystem
 *    raycasts it and adds `Pressed` when the player points & triggers.
 *  - Standing near a stall shows a small floating "Trade" prompt.
 *  - Pressing a stall opens the world-space trade panel for that trader.
 *  - You click your goods (→ "You Give") and their goods (→ "You Receive"); a
 *    fairness indicator compares the two using the trader's own price list.
 *  - "Propose Trade" → the NPC accepts a fair or generous offer (and the goods
 *    swap), or asks for more on an underpayment.
 *
 * Note: `RayInteractable` (not the deprecated `Interactable`) is the component
 * the InputSystem actually uses to drive Hovered/Pressed.
 */

import {
  AudioUtils,
  createComponent,
  createSystem,
  PanelDocument,
  PanelUI,
  Pressed,
  RayInteractable,
  ScreenSpace,
  Transform,
  Types,
  UIKit,
  UIKitDocument,
  Vector3,
  eq,
  type Entity,
} from '@iwsdk/core';

import { relayoutScreenSpacePanels } from '../ui-relayout.js';
import { sfx } from '../audio/Sfx.js';
import { gameState } from '../game/GameState.js';
import { colonyScore } from '../game/ColonyScore.js';
import { playerInventory } from '../game/PlayerInventory.js';
import { summerProgress } from '../game/SummerProgress.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';
import { NeedsSystem } from './NeedsSystem.js';

/** Marks a trader NPC and remembers which trader it is. */
export const TradeStall = createComponent('TradeStall', {
  trader: { type: Types.String, default: '' },
});

/** The three traders. */
type TraderId = 'Martha' | 'James' | 'Anne';

/** The goods the PLAYER can offer (their tradeable inventory). */
export type GiveGood = 'corn' | 'tobacco' | 'trade_goods';
export const GIVE_GOODS: GiveGood[] = ['corn', 'tobacco', 'trade_goods'];

/** One thing a trader sells, and its price in the good(s) they want. */
export interface Offer {
  item: string;
  price: Partial<Record<GiveGood, number>>;
}

export interface TraderDef {
  greeting: string;
  wants: GiveGood[];
  stock: Record<string, number>;
  offers: Offer[];
  /**
   * How the offer price is read:
   *  - 'and' (default): the player must cover the cost in EVERY wanted currency
   *    — `price[c]` is the amount required in c (Anne needs corn AND tobacco).
   *  - 'or': the player may pay in ANY wanted currency — `price[c]` is the cost
   *    if paying ENTIRELY in c, and partial payments across currencies add up
   *    (Elizabeth takes corn OR tobacco).
   */
  mode?: 'and' | 'or';
}

/** UI-only icon initial per good (for the colored-circle item icons). */
const GOOD_INITIAL: Record<string, string> = {
  corn: 'C',
  tobacco: 'T',
  trade_goods: 'G',
  herbs: 'H',
  blankets: 'B',
  iron_tools: 'I',
  timber: 'W',
};

/** UI-only icon color per good (presentation only — no gameplay meaning). */
const GOOD_COLOR: Record<string, string> = {
  corn: '#e3b23c',
  tobacco: '#6f8f3f',
  trade_goods: '#5a8fc7',
  herbs: '#7fa05a',
  blankets: '#c9a06a',
  iron_tools: '#8a8f99',
  timber: '#8a6a44',
};

/** Selected vs idle row styling for the goods rows. */
const ROW_SEL_BORDER = '#c79a4b';
const ROW_SEL_BG = '#4a3a26';
const ROW_IDLE = '#3a2e22';

/** Needle travel along the fairness track (track width 86 − needle 0.8). */
const NEEDLE_TRAVEL = 85;

/** Human-readable names for every good that appears in the market. */
export const GOOD_NAMES: Record<string, string> = {
  corn: 'Corn',
  tobacco: 'Tobacco',
  trade_goods: 'Goods',
  herbs: 'Herbs',
  blankets: 'Blankets',
  iron_tools: 'Iron Tools',
  timber: 'Timber',
};

/**
 * The trader catalogue. Prices follow the brief exactly:
 *   Martha: 3 corn = 1 herb bundle, 5 corn = 1 blanket set.
 *   James : 2 tobacco = 1 tool set, 1 tobacco = 1 timber bundle.
 *   Anne  : 2 corn + 2 tobacco = 1 of any item.
 */
const TRADERS: Record<TraderId, TraderDef> = {
  Martha: {
    greeting:
      'I have remedies for what ails you, but my family needs food. Bring me corn and we can trade.',
    wants: ['corn'],
    stock: { herbs: 5, blankets: 3 },
    offers: [
      { item: 'herbs', price: { corn: 3 } },
      { item: 'blankets', price: { corn: 5 } },
    ],
  },
  James: {
    greeting:
      'Fine ironwork takes time. I trade my goods for tobacco — I sell it to the ships for a profit.',
    wants: ['tobacco'],
    stock: { iron_tools: 4, timber: 6 },
    offers: [
      { item: 'iron_tools', price: { tobacco: 2 } },
      { item: 'timber', price: { tobacco: 1 } },
    ],
  },
  Anne: {
    greeting:
      'I have a little of everything, but quality comes at a price, friend.',
    wants: ['corn', 'tobacco'],
    stock: { herbs: 3, blankets: 3, iron_tools: 3, timber: 3 },
    offers: [
      { item: 'herbs', price: { corn: 2, tobacco: 2 } },
      { item: 'blankets', price: { corn: 2, tobacco: 2 } },
      { item: 'iron_tools', price: { corn: 2, tobacco: 2 } },
      { item: 'timber', price: { corn: 2, tobacco: 2 } },
    ],
  },
};

const TRADE_PANEL = './ui/trade-interface.json';
const PROMPT_PANEL = './ui/trade-prompt.json';

/** How close (metres) the player must be for the "Trade" prompt to appear. */
const PROMPT_RANGE = 3.5;

/** Fairness outcomes. */
type Fairness = 'empty' | 'under' | 'fair' | 'over';

export class MarketSystem extends createSystem({
  // Every transform entity — scanned once to find the trader NPCs by name.
  npcCandidates: { required: [Transform] },
  // Tagged trader stalls (for proximity checks).
  stalls: { required: [TradeStall] },
  // A stall the player just pressed (point + trigger).
  pressedStalls: { required: [TradeStall, Pressed] },
  // The two world-space panels, matched once their UIKit documents load.
  tradePanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', TRADE_PANEL)],
  },
  promptPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PROMPT_PANEL)],
  },
}) {
  /** Live trader stock (depletes as you buy), keyed by trader id. Market
   *  traders are seeded at init; others (farms) seed on first contact. */
  private stock: Record<string, Record<string, number>> = {};

  /** Trader ids already tagged, so we don't double-process the NPC scan. */
  private tagged = new Set<TraderId>();

  /** The currently open trade, if any. `onClose` lets the opener (e.g. a farm
   *  visit) run cleanup such as returning the player to the settlement centre. */
  private active?: {
    id: string;
    def: TraderDef;
    entity: Entity;
    onClose?: () => void;
  };

  /** The current proposal: what the player offers and what they want. */
  private give: Record<GiveGood, number> = { corn: 0, tobacco: 0, trade_goods: 0 };
  private receive: Record<string, number> = {};

  /** Cached panel docs + entities (single handles, not entity collections). */
  private tradeDoc?: UIKitDocument;
  private tradeEntity?: Entity;
  private promptEntity?: Entity;

  /** Lazily-resolved NeedsSystem (for fulfilling needs on receipt). */
  private needsSystem?: NeedsSystem;

  // Scratch vectors (allocate once — never in update()).
  private npcPos!: Vector3;
  private headPos!: Vector3;

  /** Fairness-needle tween: current + target position along the track (units). */
  private needlePos = 0;
  private needleTarget = 0;
  /** Remaining "Trade Complete!" banner time (s); <= 0 = hidden. */
  private bannerLeft = 0;

  init() {
    this.npcPos = new Vector3();
    this.headPos = new Vector3();

    // Deep copy the catalogue stock so trading mutates a runtime copy only.
    this.stock = {
      Martha: { ...TRADERS.Martha.stock },
      James: { ...TRADERS.James.stock },
      Anne: { ...TRADERS.Anne.stock },
    };

    // ── Create the two world-space panels (hidden until needed) ─────────────
    this.tradeEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: TRADE_PANEL,
        maxWidth: 1.5,
        maxHeight: 1.0,
      })
      .addComponent(RayInteractable)
      // ScreenSpace pins the trade panel as a centered overlay on desktop (a
      // world-space panel is hard to aim a mouse at) and converts to world-space
      // in XR, where the world-position set in openTradeWith() still applies.
      // Sat high so its lower edge clears the trader-description toast that the
      // tutorial layer parks along the bottom (they used to collide top-center).
      .addComponent(ScreenSpace, {
        top: '8%',
        left: '18vw',
        width: '64vw',
        height: '58%',
      });
    this.tradeEntity.object3D!.visible = false;

    this.promptEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: PROMPT_PANEL, maxWidth: 0.4, maxHeight: 0.16 });
    this.promptEntity.object3D!.visible = false;

    // ── Find the trader NPCs by name and make them interactive ──────────────
    //    The NPCs are static scenery built in Colonists.ts; we tag them at
    //    runtime rather than editing that file. `true` replays for NPCs that
    //    already exist (they do — colonists are built before systems register).
    this.cleanupFuncs.push(
      this.queries.npcCandidates.subscribe(
        'qualify',
        (entity) => this.tryTagStall(entity),
        true,
      ),
    );

    // ── Market is "open" only in Summer: toggle stall interactivity per phase ─
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((_old, next) =>
        // Only the FIRST Summer trades. On a locked-tracker revisit of a finished
        // Summer the market is read-only, so re-trading can't change the final
        // score after the fact.
        this.setStallsInteractive(
          next === 'Summer' && !gameState.hasCompletedPhase('Summer'),
        ),
      ),
    );
    this.setStallsInteractive(
      gameState.currentPhase === 'Summer' &&
        !gameState.hasCompletedPhase('Summer'),
    );

    // ── Open the trade panel when a stall is pressed (Summer only) ───────────
    this.cleanupFuncs.push(
      this.queries.pressedStalls.subscribe('qualify', (entity) => {
        if (gameState.currentPhase !== 'Summer') return;
        const trader = entity.getValue(TradeStall, 'trader') as TraderId;
        if (trader in TRADERS) this.openTrade(trader, entity);
      }),
    );

    // ── Wire the trade panel's buttons once its document loads ──────────────
    this.cleanupFuncs.push(
      this.queries.tradePanel.subscribe(
        'qualify',
        (entity) => {
          this.tradeDoc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.wireTradePanel();
        },
        true,
      ),
    );

  }

  /** If this entity is a trader NPC, tag it with TradeStall. Interactivity is
   *  gated to Summer (the market is only "open" then), like the farms. */
  private tryTagStall(entity: Entity): void {
    const name = entity.object3D?.name as TraderId | undefined;
    if (!name || !(name in TRADERS) || this.tagged.has(name)) return;
    this.tagged.add(name);
    if (!entity.hasComponent(TradeStall))
      entity.addComponent(TradeStall, { trader: name });
    this.setStallInteractive(
      entity,
      gameState.currentPhase === 'Summer' &&
        !gameState.hasCompletedPhase('Summer'),
    );
  }

  /** Add/remove RayInteractable on every tagged stall (market open ⇔ Summer). */
  private setStallsInteractive(on: boolean): void {
    for (const stall of this.queries.stalls.entities)
      this.setStallInteractive(stall, on);
  }

  private setStallInteractive(entity: Entity, on: boolean): void {
    const has = entity.hasComponent(RayInteractable);
    if (on && !has) entity.addComponent(RayInteractable);
    else if (!on && has) entity.removeComponent(RayInteractable);
  }

  // ───────────────────────────── proximity prompt ────────────────────────────

  update(delta: number) {
    // While a trade is open, slide the fairness needle toward its target and
    // tick down the "Trade Complete!" banner.
    if (this.active && this.tradeDoc) {
      if (Math.abs(this.needlePos - this.needleTarget) > 0.05) {
        // Frame-rate-independent exponential ease: smooth on every frame, and
        // (unlike a delta-clamped lerp) never snaps to target on a long frame.
        this.needlePos +=
          (this.needleTarget - this.needlePos) * (1 - Math.exp(-delta * 9));
        this.container('meter-needle')?.setProperties({ positionLeft: this.needlePos });
      }
      if (this.bannerLeft > 0) {
        this.bannerLeft -= delta;
        if (this.bannerLeft <= 0) {
          this.container('trade-banner')?.setProperties({ display: 'none' });
          // Trade complete: retire the panel once the celebration banner has had
          // its moment (the player re-clicks the trader for another deal). Cancel
          // dismisses immediately via its own handler.
          this.closeTrade();
        }
      }
    }

    // The "Trade" prompt only appears in Summer (when the market is open) and
    // while no trade panel is already open.
    if (gameState.currentPhase !== 'Summer' || this.active) {
      this.setVisible(this.promptEntity, false);
      return;
    }
    if (!this.promptEntity) return;

    this.player.head.getWorldPosition(this.headPos);

    // Find the nearest stall within range.
    let nearest: Entity | undefined;
    let nearestDist = PROMPT_RANGE;
    for (const stall of this.queries.stalls.entities) {
      stall.object3D!.getWorldPosition(this.npcPos);
      const d = this.npcPos.distanceTo(this.headPos);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = stall;
      }
    }

    if (!nearest) {
      this.setVisible(this.promptEntity, false);
      return;
    }

    // Park the prompt above that NPC's head, facing the player.
    nearest.object3D!.getWorldPosition(this.npcPos);
    const prompt = this.promptEntity.object3D!;
    prompt.position.set(this.npcPos.x, this.npcPos.y + 2.2, this.npcPos.z);
    this.faceHead(prompt);
    prompt.visible = true;
  }

  // ──────────────────────────────── open / close ─────────────────────────────

  /** Open the panel for one of the three market traders (Martha/James/Anne). */
  private openTrade(trader: TraderId, entity: Entity): void {
    this.openTradeWith(trader, TRADERS[trader], entity);
  }

  /**
   * Open the shared trade panel for ANY trader definition. Public so other
   * systems (e.g. FarmVisitSystem) drive the exact same panel + flow with their
   * own traders. `opts.onClose` runs when the panel closes — used to return the
   * player to the settlement centre after a farm visit.
   */
  openTradeWith(
    id: string,
    def: TraderDef,
    entity: Entity,
    opts?: { onClose?: () => void },
  ): void {
    this.active = { id, def, entity, onClose: opts?.onClose };
    this.give = { corn: 0, tobacco: 0, trade_goods: 0 };
    this.receive = {};

    // Visiting a trade location (opening its panel) counts toward the recap.
    // This same path serves the neighbor farms (FarmVisitSystem routes through
    // here), so it ticks the objective tracker's "visit a market/farm" step too.
    summerProgress.recordVisit(id);
    objectiveTracker.completeSubTask('summer-visit');

    // Seed this trader's live stock the first time we meet them.
    if (!this.stock[id]) this.stock[id] = { ...def.stock };

    if (!this.tradeEntity) return;

    // Position the panel between the NPC and the player (raised to eye height,
    // facing the player) so the NPC's body doesn't occlude it.
    entity.object3D!.getWorldPosition(this.npcPos);
    this.player.head.getWorldPosition(this.headPos);
    const dx = this.headPos.x - this.npcPos.x;
    const dz = this.headPos.z - this.npcPos.z;
    const len = Math.hypot(dx, dz) || 1;
    const offset = 0.9;
    const panel = this.tradeEntity.object3D!;
    panel.position.set(
      this.npcPos.x + (dx / len) * offset,
      1.5,
      this.npcPos.z + (dz / len) * offset,
    );
    this.faceHead(panel);
    panel.visible = true;
    // Show the ScreenSpace overlay root on desktop (object3D.visible alone does
    // not reveal the pinned DOM overlay); relayout fires after refresh() below.
    this.container('trade-root')?.setProperties({ display: 'flex' });

    // Fill the header + reset the proposal view (needle + banner to neutral).
    this.setText('npc-name', id);
    this.setText('npc-greeting', def.greeting);
    this.setText('npc-response', '');
    this.bannerLeft = 0;
    this.container('trade-banner')?.setProperties({ display: 'none' });
    this.needlePos = 0.05 * NEEDLE_TRAVEL;
    this.container('meter-needle')?.setProperties({ positionLeft: this.needlePos });
    this.refresh();
    // Refit the freshly-revealed ScreenSpace overlay to its new content.
    relayoutScreenSpacePanels(this.tradeDoc);
  }

  private closeTrade(): void {
    const onClose = this.active?.onClose;
    this.active = undefined;
    this.give = { corn: 0, tobacco: 0, trade_goods: 0 };
    this.receive = {};
    this.setVisible(this.tradeEntity, false);
    this.container('trade-root')?.setProperties({ display: 'none' });
    // Run any opener-supplied cleanup last (e.g. return to settlement centre).
    onClose?.();
  }

  // ──────────────────────────────── panel wiring ─────────────────────────────

  private wireTradePanel(): void {
    if (!this.tradeDoc) return;

    for (const g of GIVE_GOODS) {
      this.button(`btn-give-${g}`)?.addEventListener('click', () =>
        this.onGiveClick(g),
      );
    }
    for (let slot = 0; slot < 4; slot++) {
      this.button(`btn-their-${slot}`)?.addEventListener('click', () =>
        this.onTheirClick(slot),
      );
    }
    this.button('btn-propose')?.addEventListener('click', () => this.onPropose());
    this.button('btn-cancel')?.addEventListener('click', () => this.closeTrade());

    // The panel now carries ScreenSpace, so its DOM overlay would show on desktop
    // the instant the document loads (object3D.visible alone no longer hides it).
    // Start the root hidden; openTradeWith() reveals it when a stall is selected.
    this.container('trade-root')?.setProperties({ display: 'none' });

    // Hover affordance on the goods rows (gold border). Best-effort: if the
    // pointer-enter/leave events aren't delivered, the rows simply don't hover.
    for (const g of GIVE_GOODS) this.addRowHover(`btn-give-${g}`, () => this.give[g] > 0);
    for (let slot = 0; slot < 4; slot++)
      this.addRowHover(`btn-their-${slot}`, () => this.theirSlotSelected(slot));
  }

  /** Gold-border a row on hover; on leave restore its selected/idle styling. */
  private addRowHover(id: string, isSelected: () => boolean): void {
    const el = this.container(id) as
      | (UIKit.Container & {
          addEventListener?: (t: string, cb: () => void) => void;
        })
      | undefined;
    el?.addEventListener?.('pointerenter', () =>
      el.setProperties({ borderColor: ROW_SEL_BORDER }),
    );
    el?.addEventListener?.('pointerleave', () => this.setRowSelected(id, isSelected()),
    );
  }

  /** Whether the player has allocated any of the trader's offer slot `slot`. */
  private theirSlotSelected(slot: number): boolean {
    const offer = this.active?.def.offers[slot];
    return !!offer && (this.receive[offer.item] ?? 0) > 0;
  }

  /** Click one of YOUR goods → cycle how many you offer (0 → owned → 0). */
  private onGiveClick(g: GiveGood): void {
    if (!this.active) return;
    const owned = playerInventory.getItemCount(g);
    this.give[g] = (this.give[g] + 1) % (owned + 1);
    this.setText('npc-response', '');
    this.refresh();
  }

  /** Click one of THEIR goods → cycle how many you want (0 → in stock → 0). */
  private onTheirClick(slot: number): void {
    if (!this.active) return;
    const offers = this.active.def.offers;
    if (slot >= offers.length) return;
    const item = offers[slot].item;
    const inStock = this.stock[this.active.id][item] ?? 0;
    this.receive[item] = ((this.receive[item] ?? 0) + 1) % (inStock + 1);
    this.setText('npc-response', '');
    this.refresh();
  }

  // ─────────────────────────────── fairness logic ────────────────────────────

  /**
   * Compare what the player offers to the trader's price for the receive basket.
   *
   *  - 'and' mode: per WANTED currency, so Anne (corn AND tobacco) only reads
   *    "fair" when both are covered — paying all corn underpays her.
   *  - 'or' mode: a coverage ratio that sums each currency's fractional
   *    contribution, so Elizabeth (corn OR tobacco) is satisfied by either, or
   *    any mix that adds up.
   */
  private computeFairness(): Fairness {
    if (!this.active) return 'empty';
    const def = this.active.def;
    const eps = 1e-6;

    let receiveCount = 0;
    for (const qty of Object.values(this.receive)) if (qty > 0) receiveCount += qty;
    if (receiveCount === 0) return 'empty';

    if (def.mode === 'or') {
      // For each wanted currency, the cost if the WHOLE basket were paid in it.
      const costAllIn: Partial<Record<GiveGood, number>> = {};
      for (const [item, qty] of Object.entries(this.receive)) {
        if (qty <= 0) continue;
        const offer = def.offers.find((o) => o.item === item);
        if (!offer) continue;
        for (const c of def.wants) {
          const unit = offer.price[c] ?? 0;
          if (unit > 0) costAllIn[c] = (costAllIn[c] ?? 0) + unit * qty;
        }
      }
      // Coverage 1.0 = exactly paid (in any single currency or a mix).
      let coverage = 0;
      for (const c of def.wants) {
        const full = costAllIn[c] ?? 0;
        if (full > 0) coverage += this.give[c] / full;
      }
      if (coverage < 1 - eps) return 'under';
      if (coverage > 1 + eps) return 'over';
      return 'fair';
    }

    // 'and' (default): total cost in EACH wanted currency.
    const cost: Partial<Record<GiveGood, number>> = {};
    for (const [item, qty] of Object.entries(this.receive)) {
      if (qty <= 0) continue;
      const offer = def.offers.find((o) => o.item === item);
      if (!offer) continue;
      for (const c of def.wants) {
        const unit = offer.price[c] ?? 0;
        cost[c] = (cost[c] ?? 0) + unit * qty;
      }
    }
    let deficit = 0;
    let surplus = 0;
    for (const c of def.wants) {
      const need = cost[c] ?? 0;
      const got = this.give[c];
      deficit += Math.max(0, need - got);
      surplus += Math.max(0, got - need);
    }
    if (deficit > eps) return 'under';
    if (surplus > eps) return 'over';
    return 'fair';
  }

  private onPropose(): void {
    if (!this.active) return;
    const result = this.computeFairness();

    if (result === 'empty') {
      this.setText('npc-response', 'Choose what you would like to trade.');
      sfx.error();
      return;
    }
    if (result === 'under') {
      this.setText(
        'npc-response',
        'I appreciate the offer, but I need more for that.',
      );
      sfx.error();
      return;
    }
    if (result === 'fair') {
      this.setText('npc-response', 'Deal! Pleasure doing business.');
    } else {
      this.setText('npc-response', 'That is very generous of you! Deal!');
    }
    sfx.coin(); // bright ka-ching when a trade lands
    this.executeTrade(result);
  }

  // ──────────────────────────────── execution ────────────────────────────────

  private executeTrade(kind: 'fair' | 'over'): void {
    if (!this.active) return;
    const id = this.active.id;
    const stock = this.stock[id];

    // Hand over the player's goods → into the trader's stock.
    for (const g of GIVE_GOODS) {
      const amt = this.give[g];
      if (amt <= 0) continue;
      if (!playerInventory.removeItems(g, amt)) continue; // safety: skip if short
      stock[g] = (stock[g] ?? 0) + amt;
    }

    // Take the trader's goods. A received good that's a tradeable inventory good
    // (corn/tobacco/trade_goods — e.g. Thomas's surplus corn) goes into the
    // player's inventory; anything else is a settlement supply (herbs, tools…)
    // applied straight to a matching need.
    let needsMet = 0;
    for (const [item, qty] of Object.entries(this.receive)) {
      if (qty <= 0) continue;
      stock[item] = (stock[item] ?? 0) - qty;
      if ((GIVE_GOODS as string[]).includes(item)) {
        playerInventory.addItems(item as GiveGood, qty);
      } else {
        for (let i = 0; i < qty; i++) {
          if (this.getNeedsSystem()?.fulfillNeed(item)) needsMet++;
        }
      }
    }

    // Score: fair trades build wealth; overpaying costs a little (you still get
    // the goods). Meeting a settlement need rewards Food Supply.
    if (kind === 'fair') colonyScore.addWealth(3);
    else colonyScore.addWealth(-2);
    if (needsMet > 0) colonyScore.addFood(5 * needsMet);

    // Record the deal for the end-of-game review.
    const giveStr = this.formatBasket(
      GIVE_GOODS.map((g) => [g, this.give[g]] as [string, number]),
    );
    const receiveStr = this.formatBasket(Object.entries(this.receive));
    gameState.logDecision(
      `[Trade] ${id}: gave ${giveStr} for ${receiveStr} (${kind}${needsMet > 0 ? `, met ${needsMet} need${needsMet > 1 ? 's' : ''}` : ''})`,
    );

    // Tally the trade for the Summer recap.
    summerProgress.recordTrade({ ...this.give }, { ...this.receive });

    // Celebrate: flash the "Trade Complete!" banner + a coin chime.
    this.container('trade-banner')?.setProperties({ display: 'flex' });
    this.bannerLeft = 2.0;
    AudioUtils.createOneShot(this.world, '/audio/chime.mp3', {
      volume: 0.6,
      positional: false,
    });

    // Reset the proposal; refresh the (now changed) counts. Panel stays open.
    this.give = { corn: 0, tobacco: 0, trade_goods: 0 };
    this.receive = {};
    this.refresh();
  }

  // ──────────────────────────────── rendering ────────────────────────────────

  private refresh(): void {
    if (!this.tradeDoc || !this.active) return;
    const id = this.active.id;
    const def = this.active.def;

    // Your goods: qty (owned, or "offered / owned") + selected highlight.
    for (const g of GIVE_GOODS) {
      const owned = playerInventory.getItemCount(g);
      const alloc = this.give[g];
      this.setText(`give-qty-${g}`, alloc > 0 ? `${alloc} / ${owned}` : `${owned}`);
      this.setRowSelected(`btn-give-${g}`, alloc > 0);
    }

    // Their goods: fill each offer slot's icon + name + qty; hide unused rows.
    for (let slot = 0; slot < 4; slot++) {
      const row = this.container(`btn-their-${slot}`);
      const offer = def.offers[slot];
      if (!offer) {
        row?.setProperties({ display: 'none' });
        continue;
      }
      const item = offer.item;
      const inStock = this.stock[id][item] ?? 0;
      const alloc = this.receive[item] ?? 0;
      row?.setProperties({ display: 'flex' });
      this.text(`their-letter-${slot}`)?.setProperties({ text: GOOD_INITIAL[item] ?? '?' });
      this.container(`their-icon-${slot}`)?.setProperties({
        backgroundColor: GOOD_COLOR[item] ?? '#5a8fc7',
      });
      this.setText(`their-name-${slot}`, GOOD_NAMES[item] ?? item);
      this.setText(`their-qty-${slot}`, alloc > 0 ? `${alloc} / ${inStock}` : `${inStock}`);
      this.setRowSelected(`btn-their-${slot}`, alloc > 0);
    }

    // Proposal lists (center column).
    this.setText(
      'give-list',
      this.formatBasket(GIVE_GOODS.map((g) => [g, this.give[g]] as [string, number])),
    );
    this.setText('receive-list', this.formatBasket(Object.entries(this.receive)));

    // Fairness meter + Propose color.
    this.setFairness(this.computeFairness());
  }

  /** Gold-glow a selected goods row; plain otherwise. */
  private setRowSelected(id: string, selected: boolean): void {
    this.container(id)?.setProperties({
      borderColor: selected ? ROW_SEL_BORDER : ROW_IDLE,
      backgroundColor: selected ? ROW_SEL_BG : ROW_IDLE,
    });
  }

  /**
   * Update the fairness label + slide-target for the needle + the Propose
   * button color. Reads the SAME `computeFairness()` category — no trade value
   * or logic is changed, only the presentation.
   */
  private setFairness(result: Fairness): void {
    const map: Record<
      Fairness,
      { text: string; color: string; ratio: number; ok: boolean }
    > = {
      empty: { text: 'Choose goods to trade', color: '#cbb78f', ratio: 0.05, ok: false },
      under: { text: 'Bad deal', color: '#e0857a', ratio: 0.17, ok: false },
      fair: { text: 'Fair', color: '#7fd07f', ratio: 0.5, ok: true },
      over: { text: 'Generous', color: '#8fb4e8', ratio: 0.83, ok: true },
    };
    const f = map[result];
    this.text('fairness')?.setProperties({ text: f.text, color: f.color });
    this.needleTarget = f.ratio * NEEDLE_TRAVEL;
    this.button('btn-propose')?.setProperties({
      backgroundColor: f.ok ? '#4a8c3f' : '#4a4036',
      color: f.ok ? '#eafce6' : '#9a8f7a',
    });
  }

  // ─────────────────────────────── small helpers ─────────────────────────────

  /** Build "3 Corn, 1 Tobacco" from [good, qty] pairs (or "—" if all zero). */
  private formatBasket(entries: [string, number][]): string {
    const parts = entries
      .filter(([, q]) => q > 0)
      .map(([k, q]) => `${q} ${GOOD_NAMES[k] ?? k}`);
    return parts.length ? parts.join(', ') : '-';
  }

  /** Orient an Object3D so its front (+Z) faces the player's head (yaw only). */
  private faceHead(obj: { position: Vector3; rotation: { set: (x: number, y: number, z: number) => void } }): void {
    this.player.head.getWorldPosition(this.headPos);
    const yaw = Math.atan2(this.headPos.x - obj.position.x, this.headPos.z - obj.position.z);
    obj.rotation.set(0, yaw, 0);
  }

  private getNeedsSystem(): NeedsSystem | undefined {
    if (!this.needsSystem) this.needsSystem = this.world.getSystem(NeedsSystem);
    return this.needsSystem;
  }

  private setVisible(entity: Entity | undefined, visible: boolean): void {
    if (entity?.object3D) entity.object3D.visible = visible;
  }

  private text(id: string): UIKit.Text | undefined {
    return (this.tradeDoc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.tradeDoc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }

  /** Buttons are UIKit.Text-like for our purposes (text + click + properties). */
  private button(id: string): UIKit.Text | undefined {
    return this.text(id);
  }

  private setText(id: string, value: string): void {
    this.text(id)?.setProperties({ text: value });
  }
}
