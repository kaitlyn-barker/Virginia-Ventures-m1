/**
 * RoyalDecreeSystem.ts — Fall, STEP 2: "The Royal Decree" (mercantilism).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE HISTORY THIS TEACHES — MERCANTILISM
 * ─────────────────────────────────────────────────────────────────────────
 * Under mercantilism, a colony existed to enrich the mother country. England
 * wanted two things from Virginia and wrote them into law (the Navigation Acts):
 *
 *   1) RAW MATERIALS, CHEAP — the colony's cash crop (tobacco) had to be sold
 *      ONLY to English merchants. With no other buyers allowed, England set the
 *      price and pocketed the difference when it resold the tobacco in Europe.
 *   2) A CAPTIVE MARKET FOR FINISHED GOODS — colonists were forbidden from
 *      manufacturing their own tools/cloth and had to BUY them from England, at
 *      a markup. Buy low (raw), sell high (manufactured): the whole point.
 *   3) A CUT OFF THE TOP — a tax/duty on tobacco exports (here 20%) skimmed
 *      revenue for the Crown on every shipment.
 *
 * The decree below states all three to the player. From this beat on, Crown
 * Reputation becomes the pillar in tension: obeying the rules pleases the Crown
 * but caps the colony's profit, while the smuggler down on the shore offers a
 * tempting, illegal way around them (that choice belongs to Ship Trading, Step 3).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW IT PLUGS IN
 * ─────────────────────────────────────────────────────────────────────────
 * This system owns one screen-space modal (compiled from ui/royal-decree.uikitml)
 * and nothing else. It does not drive the phase or the camera — TradeShipArrival
 * holds the cinematic framing for us. It simply:
 *   - waits for fallSequence.onArrivalComplete (Step 1 finished),
 *   - reveals the three rules one at a time (each fades in over 0.5s, 2s apart),
 *   - then shows the Captain's closing line + a Continue button,
 *   - and on Continue fires fallSequence.emitDecreeAccepted() — the seam Ship
 *     Trading (Step 3) will subscribe to next milestone.
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
import { fallSequence } from '../game/FallSequence.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';

const PANEL_CONFIG = './ui/royal-decree.json';

/** The three rule rows, in reveal order. */
const RULE_IDS = ['decree-rule-0', 'decree-rule-1', 'decree-rule-2'] as const;

/** How long each rule takes to fade from invisible to solid. */
const FADE_SECONDS = 0.5;

/** Gap between the START of one rule's fade and the next (0.5s fade + 2s gap). */
const RULE_INTERVAL = FADE_SECONDS + 2; // 2.5s

/** When (seconds into the reveal) the Captain line + Continue button appear:
 *  after the third rule has fully faded in, plus a short beat. */
const FINALE_AT = RULE_INTERVAL * (RULE_IDS.length - 1) + FADE_SECONDS + 0.6; // ≈ 6.1s

export class RoyalDecreeSystem extends createSystem({
  decreePanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  private doc?: UIKitDocument;
  private panelEntity?: Entity;

  /** True while the decree is on screen and its reveal timeline is running. */
  private presenting = false;
  /** Seconds since present() — drives the staged fade-ins. */
  private clock = 0;
  /** Latch so the finale (Captain line + Continue) only reveals once. */
  private finaleShown = false;

  init() {
    // Centered parchment modal, hidden until Step 1 hands off.
    this.panelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: PANEL_CONFIG, maxWidth: 1.7, maxHeight: 1.7 })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '10%',
        left: '28vw',
        width: '44vw',
        height: '80%',
      });
    this.panelEntity.object3D!.visible = false;

    // Capture the document + wire Continue when the panel loads; keep it hidden
    // and pre-set the staged elements to their "not yet revealed" state.
    this.cleanupFuncs.push(
      this.queries.decreePanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.button('decree-continue')?.addEventListener('click', () =>
            this.onContinue(),
          );
          this.resetStagedElements();
          this.setVisible(false);
        },
        true,
      ),
    );

    // Step 1 → Step 2: present the decree once the Captain's arrival is done.
    this.cleanupFuncs.push(
      fallSequence.onArrivalComplete(() => this.present()),
    );

    // Safety: if we somehow leave Fall while the decree is up, hide it.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase) => {
        if (oldPhase === 'Fall') {
          this.presenting = false;
          this.setVisible(false);
        }
      }),
    );
  }

  // ──────────────────────────────── presentation ─────────────────────────────

  private present(): void {
    if (gameState.currentPhase !== 'Fall') return;
    this.clock = 0;
    this.finaleShown = false;
    this.presenting = true;
    this.resetStagedElements();
    this.setVisible(true);
  }

  update(delta: number) {
    if (!this.presenting) return;
    this.clock += delta;

    // Fade each rule in on its schedule (rule i starts at i * RULE_INTERVAL).
    for (let i = 0; i < RULE_IDS.length; i++) {
      const start = i * RULE_INTERVAL;
      if (this.clock < start) continue;
      const opacity = clamp01((this.clock - start) / FADE_SECONDS);
      this.setOpacity(RULE_IDS[i], opacity);
    }

    // Once all rules are up, reveal the Captain's warning + the Continue button.
    if (!this.finaleShown && this.clock >= FINALE_AT) {
      this.finaleShown = true;
      this.setOpacity('decree-captain', 1);
      this.setOpacity('decree-continue', 1);
      // The reveal is done — stop ticking; nothing left to animate.
      this.presenting = false;
    }
  }

  private onContinue(): void {
    this.presenting = false;
    this.setVisible(false);

    // The brief's required log line, plus a review-log entry for the recap.
    console.log('Player read the Royal Decree — mercantilism rules presented');
    gameState.logDecision(
      '[Fall] Player read the Royal Decree - mercantilism rules presented (tobacco to England only, no home manufacturing, 20% tobacco export tax).',
    );

    // Step 2 → Step 3 seam: hand off to Ship Trading (built next milestone) and
    // release TradeShipArrival's cinematic view lock.
    objectiveTracker.completeSubTask('fall-decree');
    fallSequence.emitDecreeAccepted();
  }

  // ─────────────────────────────── element state ─────────────────────────────

  /** Put the staged elements (rules, Captain line, Continue) back to hidden so a
   *  re-present (e.g. replaying Fall) always starts from a clean slate. */
  private resetStagedElements(): void {
    for (const id of RULE_IDS) this.setOpacity(id, 0);
    this.setOpacity('decree-captain', 0);
    this.setOpacity('decree-continue', 0);
  }

  /**
   * Set an element's opacity AND keep its display in lock-step: opacity 0 also
   * sets display:none so a fully-faded element can't intercept clicks or hold
   * layout; any positive opacity flips it back to flex. This is how the staged
   * rules stay truly hidden before their turn, then fade in.
   */
  private setOpacity(id: string, opacity: number): void {
    this.text(id)?.setProperties({
      opacity,
      display: opacity <= 0 ? 'none' : 'flex',
    });
  }

  // ─────────────────────────────── visibility ────────────────────────────────

  private setVisible(visible: boolean): void {
    if (this.panelEntity?.object3D) this.panelEntity.object3D.visible = visible;
    this.container('decree-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    if (visible) relayoutScreenSpacePanels();
  }

  // ─────────────────────────────── doc helpers ───────────────────────────────

  private text(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private button(id: string): UIKit.Text | undefined {
    return this.text(id);
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }
}

/** Clamp to [0,1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
