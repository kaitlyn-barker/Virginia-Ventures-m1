/**
 * FallProgress.ts — a tiny session tracker for the Fall "Trade Ship" phase.
 *
 * Records WHAT happened economically during Fall so a later recap (Step 5) can
 * summarise it: how much tobacco/corn/goods went to the Crown's ships, the
 * total Crown tax paid, which English imports were bought, and — crucially —
 * whether the player smuggled to the Dutch and whether the Crown found out.
 *
 * Same module-singleton idiom as gameState / colonyScore / summerProgress: one
 * object, imported everywhere, alive for the whole tab. See GameState for the
 * fuller Unity→web explanation.
 */

import type { ScoreSnapshot } from './ColonyScore.js';

/** The illegal-trade outcome, once the smuggler beat has resolved. */
export type SmugglingOutcome = 'none' | 'refused' | 'smuggled-safe' | 'smuggled-caught';

const sold: Record<string, number> = {}; // goods sold to England (corn/tobacco/trade_goods)
const bought: Record<string, number> = {}; // English imports bought (tools/blankets/books/luxury)

let legalTrades = 0;
let totalTaxPaid = 0; // gold of Crown tax skimmed off tobacco exports
let tobaccoToDutch = 0; // tobacco sold to the smuggler's Dutch buyer
let smugglingOutcome: SmugglingOutcome = 'none';

/** The three pillar scores as Fall began (the end-of-Summer baseline), so the
 *  Fall recap can show how much each pillar moved DURING Fall. Captured once
 *  trading opens (arrival/decree don't touch the score). */
let startScore: ScoreSnapshot | null = null;

export const fallProgress = {
  /** Record one finalised legal transaction with the Royal Trading Company. */
  recordLegalTrade(
    soldGoods: Record<string, number>,
    boughtGoods: Record<string, number>,
    taxPaid: number,
  ): void {
    legalTrades += 1;
    for (const [k, q] of Object.entries(soldGoods)) {
      if (q > 0) sold[k] = (sold[k] ?? 0) + q;
    }
    for (const [k, q] of Object.entries(boughtGoods)) {
      if (q > 0) bought[k] = (bought[k] ?? 0) + q;
    }
    totalTaxPaid += Math.max(0, taxPaid);
  },

  /** Record the smuggling outcome (and any tobacco sold to the Dutch). */
  recordSmuggling(outcome: SmugglingOutcome, dutchTobacco: number): void {
    smugglingOutcome = outcome;
    tobaccoToDutch += Math.max(0, dutchTobacco);
  },

  getLegalTradeCount(): number {
    return legalTrades;
  },
  getTotalTaxPaid(): number {
    return totalTaxPaid;
  },
  getTobaccoToDutch(): number {
    return tobaccoToDutch;
  },
  getSmugglingOutcome(): SmugglingOutcome {
    return smugglingOutcome;
  },

  /** Record / read the start-of-Fall score baseline (see `startScore`). */
  setStartScore(snapshot: ScoreSnapshot): void {
    startScore = snapshot;
  },
  getStartScore(): ScoreSnapshot | null {
    return startScore;
  },
  /** Defensive copies of the per-good sold / bought tallies. */
  getSold(): Record<string, number> {
    return { ...sold };
  },
  getBought(): Record<string, number> {
    return { ...bought };
  },

  /** Clear everything for a fresh Fall. */
  reset(): void {
    for (const k of Object.keys(sold)) delete sold[k];
    for (const k of Object.keys(bought)) delete bought[k];
    legalTrades = 0;
    totalTaxPaid = 0;
    tobaccoToDutch = 0;
    smugglingOutcome = 'none';
    startScore = null;
  },
};
