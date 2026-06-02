/**
 * SummerRecap.ts — closes out the Summer phase.
 *
 * Fires once the player has visited at least 2 of the 5 trade locations (the 3
 * market stalls + 2 farms), or after a soft 7-minute timer — whichever comes
 * first. It shows a recap modal (needs met/unmet, trades made, the season's
 * score change), settles the unmet-need penalties, records the end-of-Summer
 * score snapshot, and previews Fall. "Continue" advances the phase.
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
import { colonyScore, type ScoreSnapshot } from '../game/ColonyScore.js';
import { summerProgress } from '../game/SummerProgress.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';
import { NeedsSystem } from './NeedsSystem.js';

const PANEL_CONFIG = './ui/summer-recap.json';

/** Visit this many of the 5 trade locations to end Summer early. */
const VISIT_THRESHOLD = 2;

/** Soft fallback: end Summer after this many seconds even with fewer visits. */
const SOFT_TIMER_SECONDS = 7 * 60;

/** The Fall transition narrative (ASCII only — the UI font lacks em-dash). */
const NARRATIVE =
  "As the leaves begin to turn, a ship appears on the horizon. The English trading vessel has arrived - and with it, the Crown's rules...";

/** Pretty labels for the three score pillars. */
const PILLARS: { key: keyof ScoreSnapshot; label: string }[] = [
  { key: 'foodSupply', label: 'Food Supply' },
  { key: 'tradeWealth', label: 'Trade Wealth' },
  { key: 'crownReputation', label: 'Crown Reputation' },
];

export class SummerRecap extends createSystem({
  recapPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  private recapShown = false;
  private timer = 0;
  private startSnapshot?: ScoreSnapshot;

  private doc?: UIKitDocument;
  private panelEntity?: Entity;
  private needsSystem?: NeedsSystem;

  init() {
    // Centered recap modal, hidden until Summer ends.
    this.panelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: PANEL_CONFIG, maxWidth: 1.7, maxHeight: 1.5 })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '16%',
        left: '22vw',
        width: '56vw',
        height: '68%',
      });
    this.panelEntity.object3D!.visible = false;

    // Capture the doc + wire Continue when the panel loads; keep it hidden.
    this.cleanupFuncs.push(
      this.queries.recapPanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.button('recap-continue')?.addEventListener('click', () => {
            this.setVisible(false);
            gameState.advancePhase(); // Summer → Fall
          });
          this.setVisible(false);
        },
        true,
      ),
    );

    // Each time Summer (re)starts, reset the recap state and remember the score.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((_old, next) => {
        if (next === 'Summer') this.onSummerStart();
      }),
    );
    if (gameState.currentPhase === 'Summer') this.onSummerStart();
  }

  private onSummerStart(): void {
    this.recapShown = false;
    this.timer = 0;
    summerProgress.reset();
    this.startSnapshot = colonyScore.getScoreSnapshot();
    this.setVisible(false);
  }

  update(delta: number) {
    if (gameState.currentPhase !== 'Summer' || this.recapShown) return;
    this.timer += delta;
    if (
      summerProgress.getVisitedCount() >= VISIT_THRESHOLD ||
      this.timer >= SOFT_TIMER_SECONDS
    ) {
      this.showRecap();
    }
  }

  private showRecap(): void {
    this.recapShown = true;

    // Settle Summer: apply the unmet-need penalties (idempotent — the Summer→Fall
    // transition won't double-charge), then record the end-of-Summer snapshot.
    this.getNeedsSystem()?.applyUnmetPenalties();
    colonyScore.recordPhaseSnapshot('Summer');

    this.render();
    this.setVisible(true);

    const status = this.getNeedsSystem()?.getNeedsStatus() ?? [];
    const met = status.filter((s) => s.isMet).length;
    gameState.logDecision(
      `[Summer] Recap: ${summerProgress.getTradeCount()} trades across ${summerProgress.getVisitedCount()} location(s); needs met ${met}/${status.length}; prosperity ${Math.round(colonyScore.prosperityScore)}`,
    );
  }

  // ──────────────────────────────── rendering ────────────────────────────────

  private render(): void {
    if (!this.doc) return;

    // Needs: green if met, red if not (with the Food Supply penalty).
    const status = this.getNeedsSystem()?.getNeedsStatus() ?? [];
    for (let i = 0; i < 3; i++) {
      const el = this.text(`recap-need-${i}`);
      if (!el) continue;
      const need = status[i];
      if (!need) {
        el.setProperties({ display: 'none' });
        continue;
      }
      if (need.isMet) {
        el.setProperties({
          display: 'flex',
          text: `MET    ${need.description}`,
          color: '#5cb860',
        });
      } else {
        el.setProperties({
          display: 'flex',
          text: `UNMET  ${need.description}  (${need.penalty} Food)`,
          color: '#d9534f',
        });
      }
    }

    // Trade summary.
    const trades = summerProgress.getTradeCount();
    const visited = summerProgress.getVisitedCount();
    if (trades === 0) {
      this.setText('recap-trades', `No trades made (visited ${visited} of 5 locations).`);
    } else {
      this.setText(
        'recap-trades',
        `${trades} trade${trades === 1 ? '' : 's'} across ${visited} of 5 locations - gave ${summerProgress.getTotalGiven()} goods, received ${summerProgress.getTotalReceived()}.`,
      );
    }

    // Score change across Summer (start → now, after penalties).
    const start = this.startSnapshot;
    const now = colonyScore.getScoreSnapshot();
    for (const { key, label } of PILLARS) {
      const from = Math.round(start ? start[key] : now[key]);
      const to = Math.round(now[key]);
      const delta = to - from;
      const sign = delta >= 0 ? '+' : '';
      this.setText(
        `recap-score-${key === 'foodSupply' ? 'food' : key === 'tradeWealth' ? 'wealth' : 'rep'}`,
        `${label}: ${from} -> ${to}  (${sign}${delta})`,
      );
    }

    this.setText('recap-narrative', NARRATIVE);
  }

  // ─────────────────────────────── small helpers ─────────────────────────────

  private setVisible(visible: boolean): void {
    if (this.panelEntity?.object3D) this.panelEntity.object3D.visible = visible;
    this.container('recap-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    if (visible) relayoutScreenSpacePanels();
  }

  private getNeedsSystem(): NeedsSystem | undefined {
    if (!this.needsSystem) this.needsSystem = this.world.getSystem(NeedsSystem);
    return this.needsSystem;
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
