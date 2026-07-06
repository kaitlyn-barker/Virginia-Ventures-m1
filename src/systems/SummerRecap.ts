/**
 * SummerRecap.ts — closes out the Summer phase.
 *
 * The player ends Summer themselves: a persistent "Done Trading" button (a
 * bottom-right HUD, ui/summer-finish.uikitml) is shown the whole season so they
 * can barter with as many of the five traders as they like and weigh their
 * options before committing. Pressing it (or, as a soft fallback so the game
 * can't soft-lock, a long idle timer) shows the recap modal (needs met/unmet,
 * trades made, the season's score change), settles the unmet-need penalties,
 * records the end-of-Summer score snapshot, and previews Fall. "Continue"
 * advances the phase.
 */

import {
  createSystem,
  RayInteractable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  UIKit,
  UIKitDocument,
  eq,
  type Entity,
} from '@iwsdk/core';

import { HudAnchor } from '../ui/hudFollow.js';
import { gameState } from '../game/GameState.js';
import { colonyScore, type ScoreSnapshot } from '../game/ColonyScore.js';
import { summerProgress } from '../game/SummerProgress.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';
import { sfx } from '../audio/Sfx.js';
import { NeedsSystem } from './NeedsSystem.js';

const PANEL_CONFIG = './ui/summer-recap.json';

/** The persistent "Done Trading" button HUD shown bottom-right during Summer. */
const FINISH_CONFIG = './ui/summer-finish.json';

/**
 * Soft fallback ONLY: end Summer automatically after this many seconds. The
 * player normally ends the season with the "Done Trading" button, so this just
 * prevents a soft-lock if it's never pressed. Generous so it never cuts short a
 * player still weighing their trades.
 */
const SOFT_TIMER_SECONDS = 12 * 60;

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
  finishPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', FINISH_CONFIG)],
  },
}) {
  private recapShown = false;
  private timer = 0;
  private startSnapshot?: ScoreSnapshot;

  private doc?: UIKitDocument;
  private panelEntity?: Entity;
  private needsSystem?: NeedsSystem;

  /** The "Done Trading" button HUD (the player's way to end Summer). */
  private finishDoc?: UIKitDocument;
  private finishEntity?: Entity;

  init() {
    // Centered recap modal, hidden until Summer ends.
    this.panelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: PANEL_CONFIG, maxWidth: 1.7, maxHeight: 1.5 })
      .addComponent(RayInteractable)
      .addComponent(ScreenSpace, {
        top: '16%',
        left: '22vw',
        width: '56vw',
        height: '68%',
      })
      // XR: center the recap in front of the headset (its Transform is never
      // positioned, so without this it would land at the world origin).
      .addComponent(HudAnchor, { offset: [0, 0, -1.7] });
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
            sfx.fanfare(); // Summer complete — celebrate the season finished.
            this.setVisible(false);
            gameState.advancePhase(); // Summer → Fall
          });
          this.setVisible(false);
        },
        true,
      ),
    );

    // The persistent "Done Trading" button: a small bottom-right HUD (mirroring
    // the inventory HUD on the opposite corner) the player presses to end Summer
    // whenever they're ready. Hidden until Summer begins and once the recap shows.
    this.finishEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: FINISH_CONFIG, maxWidth: 1.15, maxHeight: 0.42 })
      .addComponent(RayInteractable)
      .addComponent(ScreenSpace, {
        // Mirror the inventory HUD on the opposite (right) corner, bottom-aligned
        // to flank the nav bar. A taller-than-the-content box keeps the fit
        // width-governed so the label never overflows and clips at the screen
        // edge on desktop.
        bottom: '92px',
        right: '20px',
        width: '320px',
        height: '110px',
        // Persistent HUD: sit slightly farther than the default popup depth so
        // the centered trade panel / recap modal render in front of it.
        zOffset: 0.26,
      })
      // XR: mirror the inventory HUD ([-0.8, -0.62, -2.1]) on the opposite
      // (right) side of the view — same corner pairing as on desktop.
      .addComponent(HudAnchor, { offset: [0.8, -0.62, -2.1] });
    this.finishEntity.object3D!.visible = false;

    // Wire the Done Trading button once its document loads; keep it hidden until
    // Summer is actually live.
    this.cleanupFuncs.push(
      this.queries.finishPanel.subscribe(
        'qualify',
        (entity) => {
          this.finishDoc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.finishEl('btn-finish-summer')?.addEventListener('click', () =>
            this.onFinishPressed(),
          );
          this.setFinishVisible(this.summerTradingLive());
        },
        true,
      ),
    );

    // Each time Summer (re)starts, reset the recap state and remember the score.
    // Leaving Summer hides the Done Trading button.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase, next) => {
        if (next === 'Summer') this.onSummerStart();
        else if (oldPhase === 'Summer') this.setFinishVisible(false);
      }),
    );
    if (gameState.currentPhase === 'Summer') this.onSummerStart();
  }

  /** True while the LIVE Summer is in progress (so the finish button shows).
   *  A finished-Summer revisit stays read-only — no re-ending the season. */
  private summerTradingLive(): boolean {
    return (
      gameState.currentPhase === 'Summer' &&
      !this.recapShown &&
      !gameState.hasCompletedPhase('Summer')
    );
  }

  /** The player pressed "Done Trading" — end the season on their terms. */
  private onFinishPressed(): void {
    if (!this.summerTradingLive()) return;
    sfx.click();
    this.showRecap();
  }

  private onSummerStart(): void {
    this.recapShown = false;
    this.timer = 0;
    summerProgress.reset();
    this.startSnapshot = colonyScore.getScoreSnapshot();
    this.setVisible(false);
    // Reveal the "Done Trading" button for the live season.
    this.setFinishVisible(this.summerTradingLive());
  }

  update(delta: number) {
    if (gameState.currentPhase !== 'Summer' || this.recapShown) return;
    // The player ends Summer with the "Done Trading" button; this soft timer is
    // only a fallback so the game can't soft-lock if it's never pressed.
    this.timer += delta;
    if (this.timer >= SOFT_TIMER_SECONDS) this.showRecap();
  }

  private showRecap(): void {
    this.recapShown = true;
    // The season is ending — retire the Done Trading button.
    this.setFinishVisible(false);

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
    if (visible) relayoutScreenSpacePanels(this.doc);
  }

  /** Show/hide the persistent "Done Trading" button HUD. */
  private setFinishVisible(visible: boolean): void {
    if (this.finishEntity?.object3D) this.finishEntity.object3D.visible = visible;
    const root = (this.finishDoc?.getElementById('finish-root') as
      | UIKit.Container
      | null) ?? undefined;
    root?.setProperties({ display: visible ? 'flex' : 'none' });
    if (visible) relayoutScreenSpacePanels(this.finishDoc);
  }

  /** A clickable element in the finish-button document. */
  private finishEl(id: string): UIKit.Text | undefined {
    return (this.finishDoc?.getElementById(id) as UIKit.Text | null) ?? undefined;
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
