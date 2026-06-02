/**
 * SummerProgress.ts — a tiny session tracker for the Summer trading phase.
 *
 * Both the market stalls and the neighbouring farms funnel through
 * `MarketSystem.openTradeWith`, so this singleton is the one place that records
 * WHICH locations were visited and WHAT changed hands. The SummerRecap reads it
 * to decide when the recap should fire (≥2 of the 5 locations visited) and to
 * fill the trade summary. Same module-singleton pattern as gameState/colonyScore.
 */

/** Distinct trade-location ids visited this Summer (Martha/James/Anne/Thomas/Elizabeth). */
const visited = new Set<string>();

let tradeCount = 0;
const given: Record<string, number> = {};
const received: Record<string, number> = {};

/** Listeners notified each time a trade location is opened (with its id). */
const visitListeners = new Set<(id: string) => void>();

export const summerProgress = {
  /** Mark a trade location as visited (opening its panel counts as a visit). */
  recordVisit(id: string): void {
    visited.add(id);
    // Notify subscribers (e.g. the tutorial's character scripts). Snapshot the
    // set first so a subscribe/unsubscribe inside a callback is safe.
    for (const listener of [...visitListeners]) listener(id);
  },

  /** Subscribe to "a trader was opened" events. Returns an unsubscribe fn. */
  onVisit(cb: (id: string) => void): () => void {
    visitListeners.add(cb);
    return () => {
      visitListeners.delete(cb);
    };
  },

  /** Record a completed trade's goods (accumulated into running totals). */
  recordTrade(
    give: Record<string, number>,
    receive: Record<string, number>,
  ): void {
    tradeCount += 1;
    for (const [k, q] of Object.entries(give)) {
      if (q > 0) given[k] = (given[k] ?? 0) + q;
    }
    for (const [k, q] of Object.entries(receive)) {
      if (q > 0) received[k] = (received[k] ?? 0) + q;
    }
  },

  /** How many of the 5 trade locations have been visited. */
  getVisitedCount(): number {
    return visited.size;
  },

  /** The visited location ids (a copy). */
  getVisited(): string[] {
    return [...visited];
  },

  getTradeCount(): number {
    return tradeCount;
  },

  /** Total count of goods given / received across all trades. */
  getTotalGiven(): number {
    return Object.values(given).reduce((a, b) => a + b, 0);
  },
  getTotalReceived(): number {
    return Object.values(received).reduce((a, b) => a + b, 0);
  },

  /** Defensive copies of the per-good given/received tallies. */
  getGiven(): Record<string, number> {
    return { ...given };
  },
  getReceived(): Record<string, number> {
    return { ...received };
  },

  /** Clear everything for a fresh Summer. */
  reset(): void {
    visited.clear();
    tradeCount = 0;
    for (const k of Object.keys(given)) delete given[k];
    for (const k of Object.keys(received)) delete received[k];
  },
};
