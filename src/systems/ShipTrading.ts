/**
 * ShipTrading.ts — Fall, STEP 3: trading with the Royal Trading Company.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MERCANTILISM THE PLAYER FEELS HERE
 * ─────────────────────────────────────────────────────────────────────────
 * The decree (Step 2) stated the rules; this panel makes the student LIVE them,
 * in two ways they can see in the numbers:
 *
 *  1) THE 20% EXPORT TAX. Tobacco is "worth" 10 gold, but the Crown skims a
 *     fifth off every export, so the colonist actually nets 8. The panel shows
 *     "10 gold" struck through → "8 gold (after 20% Crown tax)". Selling a lot of
 *     tobacco fills the Crown's purse as much as your own — that gap IS the
 *     lesson, and the running "Crown tax paid" total keeps it visible.
 *
 *  2) THE IMPORT/EXPORT PRICE GAP. You sell raw materials cheap (tobacco 8, corn
 *     3) but must buy FINISHED goods dear (iron tools 12, luxury 15) — and only
 *     from England. Buy low / sell high, with the colony always on the losing
 *     side of the spread: the core mechanism by which the mother country profited
 *     from the colony.
 *
 * Gold is the in-panel medium: selling exports raises it, buying imports spends
 * it, and you can only buy what you can afford. "Complete Trade" finalises one
 * transaction (goods change hands, scores apply); you may run several, then
 * "Finish Trading" ends the visit and triggers Step 4 (the smuggler).
 *
 * Scoring on each completed trade (the brief):
 *   +2 Trade Wealth / tobacco sold, +1 / corn sold;
 *   +1 to a category per import bought — tools & blankets → Food, books → Crown
 *   Reputation, luxury → Trade Wealth; and +1 Crown Reputation per 5 gold of tax
 *   paid (obeying the Crown, even via its tax, earns its favour).
 */

import {
  createSystem,
  Interactable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  UIKit,
  UIKitDocument,
  eq,
  type Entity,
} from '@iwsdk/core';

import { gameState } from '../game/GameState.js';
import { colonyScore } from '../game/ColonyScore.js';
import { playerInventory, type GoodType } from '../game/PlayerInventory.js';
import { fallSequence } from '../game/FallSequence.js';
import { fallProgress } from '../game/FallProgress.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';

const PANEL_CONFIG = './ui/ship-trade.json';

/** Which score pillar an import feeds. */
type ScoreCat = 'food' | 'crown' | 'wealth';

/** An export the player can sell: net price (after Crown tax) + the per-unit tax. */
interface ExportDef {
  name: string;
  net: number; // gold received per unit, AFTER tax
  gross: number; // sticker price before tax
  tax: number; // gold skimmed by the Crown per unit
  btn: string; // panel button id
}

/** An English import the player can buy: price in gold + the pillar it boosts. */
interface ImportDef {
  name: string;
  price: number;
  cat: ScoreCat;
  btn: string;
}

/** Exports keyed by the PlayerInventory good type. Tobacco carries the 20% tax
 *  (10 → 8); corn and trade goods are untaxed. */
const EXPORTS: Record<GoodType, ExportDef> = {
  tobacco: { name: 'Tobacco', net: 8, gross: 10, tax: 2, btn: 'exp-tobacco' },
  corn: { name: 'Corn', net: 3, gross: 3, tax: 0, btn: 'exp-corn' },
  trade_goods: { name: 'Trade Goods', net: 5, gross: 5, tax: 0, btn: 'exp-goods' },
};

/** Imports keyed by an internal id. */
const IMPORTS: Record<string, ImportDef> = {
  iron_tools: { name: 'Iron Tools', price: 12, cat: 'food', btn: 'imp-tools' },
  blankets: { name: 'Cloth / Blankets', price: 8, cat: 'food', btn: 'imp-cloth' },
  books: { name: 'Books / Paper', price: 6, cat: 'crown', btn: 'imp-books' },
  luxury: { name: 'Luxury Goods', price: 15, cat: 'wealth', btn: 'imp-luxury' },
};

const EXPORT_GOODS = Object.keys(EXPORTS) as GoodType[];
const IMPORT_IDS = Object.keys(IMPORTS);

/** +1 Crown Reputation is granted for every this-many gold of tax paid. */
const GOLD_PER_REP = 5;

export class ShipTrading extends createSystem({
  tradePanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  private doc?: UIKitDocument;
  private panelEntity?: Entity;
  private open = false;

  /** The pending (not-yet-completed) transaction. */
  private sell: Record<GoodType, number> = { corn: 0, tobacco: 0, trade_goods: 0 };
  private buy: Record<string, number> = {};

  /** Crown Reputation already granted for tax this Fall (so the +1-per-5-gold
   *  award is incremental, not re-counted each trade). */
  private taxRepAwarded = 0;

  init() {
    // Centered parchment modal, hidden until Step 2 hands off.
    this.panelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: PANEL_CONFIG, maxWidth: 2.1, maxHeight: 1.6 })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '8%',
        left: '11vw',
        width: '78vw',
        height: '84%',
      });
    this.panelEntity.object3D!.visible = false;

    // Capture the document + wire all the buttons when the panel loads.
    this.cleanupFuncs.push(
      this.queries.tradePanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.wirePanel();
          this.setVisible(false);
        },
        true,
      ),
    );

    // Step 2 → Step 3: open when the player accepts the decree.
    this.cleanupFuncs.push(fallSequence.onDecreeAccepted(() => this.openPanel()));

    // Safety: hide if we leave Fall mid-trade.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase) => {
        if (oldPhase === 'Fall') {
          this.open = false;
          this.setVisible(false);
        }
      }),
    );
  }

  // ──────────────────────────────── open / close ─────────────────────────────

  private openPanel(): void {
    if (gameState.currentPhase !== 'Fall') return;
    // Fresh Fall ledger (trading begins now; smuggling comes after). Capture the
    // start-of-Fall score right after the reset — arrival and the decree don't
    // change the score, so this IS the end-of-Summer baseline the recap compares
    // against to show Fall's per-pillar movement.
    fallProgress.reset();
    fallProgress.setStartScore(colonyScore.getScoreSnapshot());
    this.taxRepAwarded = 0;
    this.resetPending();
    this.open = true;
    this.setVisible(true);
    this.setResponse('Captain Whitmore: "Let us see your goods, colonist."');
    this.refresh();
  }

  private wirePanel(): void {
    if (!this.doc) return;

    // The tobacco "10 gold" strikethrough: lay an absolutely-positioned bar over
    // the text (UIKit has no text-decoration — same trick NeedsSystem uses).
    this.container('tob-strike-bar')?.setProperties({
      positionType: 'absolute',
      positionTop: '45%',
      positionLeft: 0,
      positionRight: 0,
    });

    for (const g of EXPORT_GOODS) {
      this.button(EXPORTS[g].btn)?.addEventListener('click', () =>
        this.onExportClick(g),
      );
    }
    for (const id of IMPORT_IDS) {
      this.button(IMPORTS[id].btn)?.addEventListener('click', () =>
        this.onImportClick(id),
      );
    }
    this.button('btn-complete')?.addEventListener('click', () => this.onComplete());
    this.button('btn-cancel')?.addEventListener('click', () => this.onCancel());
    this.button('btn-finish')?.addEventListener('click', () => this.onFinish());
  }

  // ─────────────────────────────── interactions ──────────────────────────────

  /** Click an export → cycle how many to sell (0 → owned → 0). */
  private onExportClick(g: GoodType): void {
    if (!this.open) return;
    const owned = playerInventory.getItemCount(g);
    this.sell[g] = (this.sell[g] + 1) % (owned + 1);
    this.setResponse('');
    this.refresh();
  }

  /** Click an import → buy one more if affordable; clicking past your gold wraps
   *  back to zero (a way to clear it). You can only buy what the gold covers. */
  private onImportClick(id: string): void {
    if (!this.open) return;
    const price = IMPORTS[id].price;
    const gold = this.computeGold();
    if (gold >= price) {
      this.buy[id] = (this.buy[id] ?? 0) + 1;
      this.setResponse('');
    } else if ((this.buy[id] ?? 0) > 0) {
      this.buy[id] = 0; // refund this line so the player can re-budget
      this.setResponse('');
    } else {
      this.setResponse('You need more gold - sell more exports first.');
    }
    this.refresh();
  }

  /** Finalise the pending transaction: move goods, apply scores, bank the tax. */
  private onComplete(): void {
    if (!this.open) return;

    const tobaccoSold = this.sell.tobacco;
    const cornSold = this.sell.corn;
    const goodsSold = this.sell.trade_goods;
    const anySell = tobaccoSold + cornSold + goodsSold > 0;
    const anyBuy = Object.values(this.buy).some((n) => n > 0);
    if (!anySell && !anyBuy) {
      this.setResponse('Choose goods to sell, or imports to buy.');
      return;
    }

    // Hand over the sold exports (clamped earlier, but guard removeItems).
    for (const g of EXPORT_GOODS) {
      const n = this.sell[g];
      if (n > 0) playerInventory.removeItems(g, n);
    }

    // Tax skimmed off this transaction (tobacco only).
    const taxThisTrade = tobaccoSold * EXPORTS.tobacco.tax;

    // ── Scoring ───────────────────────────────────────────────────────────
    // Exports: tobacco builds the most wealth, corn a little.
    if (tobaccoSold > 0) colonyScore.addWealth(2 * tobaccoSold);
    if (cornSold > 0) colonyScore.addWealth(1 * cornSold);

    // Imports: each unit boosts its category once.
    for (const id of IMPORT_IDS) {
      const n = this.buy[id] ?? 0;
      if (n <= 0) continue;
      const cat = IMPORTS[id].cat;
      if (cat === 'food') colonyScore.addFood(n);
      else if (cat === 'crown') colonyScore.addReputation(n);
      else colonyScore.addWealth(n);
    }

    // Crown tax → +1 Crown Reputation per 5 gold paid, granted incrementally as
    // the running total crosses each 5-gold threshold.
    const totalTaxAfter = fallProgress.getTotalTaxPaid() + taxThisTrade;
    const repTarget = Math.floor(totalTaxAfter / GOLD_PER_REP);
    if (repTarget > this.taxRepAwarded) {
      colonyScore.addReputation(repTarget - this.taxRepAwarded);
      this.taxRepAwarded = repTarget;
    }

    // Record for the (future) Fall recap.
    const soldGoods = { tobacco: tobaccoSold, corn: cornSold, trade_goods: goodsSold };
    const boughtGoods: Record<string, number> = {};
    for (const id of IMPORT_IDS) if ((this.buy[id] ?? 0) > 0) boughtGoods[id] = this.buy[id];
    fallProgress.recordLegalTrade(soldGoods, boughtGoods, taxThisTrade);

    gameState.logDecision(
      `[Fall] Royal trade: sold ${this.formatBasket(
        EXPORT_GOODS.map((g) => [EXPORTS[g].name, this.sell[g]]),
      )}; bought ${this.formatBasket(
        IMPORT_IDS.map((id) => [IMPORTS[id].name, this.buy[id] ?? 0]),
      )}; Crown tax ${taxThisTrade} gold.`,
    );

    this.setResponse('Captain Whitmore: "A fine transaction. The Crown will be pleased."');
    this.resetPending();
    this.refresh();
  }

  /** Clear the pending basket without trading. */
  private onCancel(): void {
    if (!this.open) return;
    this.resetPending();
    this.setResponse('Transaction cleared.');
    this.refresh();
  }

  /** End the Company visit → Step 4 (the smuggler). */
  private onFinish(): void {
    this.open = false;
    this.setVisible(false);
    gameState.logDecision(
      `[Fall] Finished trading with the Crown: ${fallProgress.getLegalTradeCount()} transaction(s), ${fallProgress.getTotalTaxPaid()} gold total tax paid.`,
    );
    objectiveTracker.completeSubTask('fall-shiptrade');
    fallSequence.emitTradingComplete();
  }

  // ──────────────────────────────── gold math ────────────────────────────────

  /** Net gold of the pending basket: sells (after tax) minus buys. */
  private computeGold(): number {
    let gold = 0;
    for (const g of EXPORT_GOODS) gold += this.sell[g] * EXPORTS[g].net;
    for (const id of IMPORT_IDS) gold -= (this.buy[id] ?? 0) * IMPORTS[id].price;
    return gold;
  }

  // ──────────────────────────────── rendering ────────────────────────────────

  private refresh(): void {
    if (!this.doc) return;

    // Export buttons: name + selected/owned + net price.
    for (const g of EXPORT_GOODS) {
      const def = EXPORTS[g];
      const owned = playerInventory.getItemCount(g);
      const n = this.sell[g];
      const qty = n > 0 ? `${n} / ${owned}` : `x${owned}`;
      this.setText(def.btn, `${def.name}   ${qty}   +${def.net}g`);
    }

    // Import buttons: name + selected qty + price.
    for (const id of IMPORT_IDS) {
      const def = IMPORTS[id];
      const n = this.buy[id] ?? 0;
      const qty = n > 0 ? `x${n}  ` : '';
      this.setText(def.btn, `${def.name}   ${qty}${def.price}g`);
    }

    // Center transaction column.
    this.setText(
      'sell-list',
      this.formatBasket(EXPORT_GOODS.map((g) => [EXPORTS[g].name, this.sell[g]])),
    );
    this.setText(
      'buy-list',
      this.formatBasket(IMPORT_IDS.map((id) => [IMPORTS[id].name, this.buy[id] ?? 0])),
    );

    const gold = this.computeGold();
    this.setText('gold-amount', `Gold: ${gold}`);

    const pendingTax = this.sell.tobacco * EXPORTS.tobacco.tax;
    const committed = fallProgress.getTotalTaxPaid();
    this.setText(
      'tax-paid',
      `Crown tax paid: ${committed}${pendingTax > 0 ? `  (+${pendingTax} pending)` : ''}`,
    );

    // Disable-look the Complete button when the basket is empty? Keep simple:
    // the handler messages instead. Color the gold red if (impossible) negative.
    this.text('gold-amount')?.setProperties({ color: gold < 0 ? '#b03020' : '#8a5a00' });
  }

  // ─────────────────────────────── small helpers ─────────────────────────────

  private resetPending(): void {
    this.sell = { corn: 0, tobacco: 0, trade_goods: 0 };
    this.buy = {};
  }

  /** "3 Tobacco, 1 Corn" from [name, qty] pairs (or "-" if all zero). */
  private formatBasket(entries: [string, number][]): string {
    const parts = entries.filter(([, q]) => q > 0).map(([k, q]) => `${q} ${k}`);
    return parts.length ? parts.join(', ') : '-';
  }

  private setVisible(visible: boolean): void {
    if (this.panelEntity?.object3D) this.panelEntity.object3D.visible = visible;
    this.container('ship-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    if (visible) relayoutScreenSpacePanels();
  }

  private setResponse(value: string): void {
    this.setText('ship-response', value);
  }

  private text(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private button(id: string): UIKit.Text | undefined {
    return this.text(id);
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }

  private setText(id: string, value: string): void {
    this.text(id)?.setProperties({ text: value });
  }
}
