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
  RayInteractable,
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
import { sfx } from '../audio/Sfx.js';

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
      .addComponent(RayInteractable)
      .addComponent(ScreenSpace, {
        top: '10%',
        left: '28vw',
        width: '44vw',
        height: '80%',
        // Sit a hair closer than the default popup depth (0.2) so the decree is
        // unambiguously the front-most INTERACTIVE layer: the browser pointer
        // system picks the dominant hit among same-depth panels by a tie-break,
        // so any other screen-space panel that lingers at 0.2 could otherwise
        // steal the Continue click. Still behind the transition card (0.14) and
        // well beyond the camera near-clip (~0.1).
        zOffset: 0.18,
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
    // Keep the revealed Continue button click-through every frame it's on screen.
    // It was faded in from opacity 0, and while it sat at opacity 0 UIKit treated
    // it as not-visible and forced its pointerEvents to 'none' — fading back up
    // does NOT restore that, and re-enabling it in the reveal tick doesn't stick
    // (isVisible is still propagating). Re-asserting every frame the decree is up
    // is cheap (a no-op once it's already 'auto') and reliably fixes the
    // "Continue renders but ignores clicks" bug. Keyboard (below) is the backup.
    if (this.finaleShown && this.panelEntity?.object3D?.visible) {
      this.button('decree-continue')?.setProperties({ pointerEvents: 'auto' });
    }

    // Keyboard path to advance the decree once the Continue button is revealed.
    // It never depends on the pointer hit-testing the on-screen button, so it
    // still works if a viewport quirk makes that button hard to click.
    if (
      this.finaleShown &&
      this.panelEntity?.object3D?.visible &&
      (this.input.keyboard.getKeyDown('Enter') ||
        this.input.keyboard.getKeyDown('Space'))
    ) {
      this.onContinue();
      return;
    }

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
      this.setOpacity('decree-hint', 1);
      // Re-fit the on-screen panel now that every element is present, so its
      // interactive bounds cover the freshly-revealed Continue button (the
      // one-time fit at present() happened before this content existed). The
      // button's pointer interactivity is re-asserted every frame at the top of
      // update() (see the "Continue not clickable" note there).
      relayoutScreenSpacePanels(this.doc);
      // The reveal is done — stop ticking the fade timeline.
      this.presenting = false;
    }
  }

  private onContinue(): void {
    // Ignore stray clicks before the button has actually been revealed.
    if (!this.finaleShown) return;
    sfx.click();
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
    this.setOpacity('decree-hint', 0);
  }

  /**
   * Fade a staged element by opacity ONLY — its display stays put so it always
   * reserves its slot in the parchment's column. That keeps the panel's height
   * (and therefore its screen-space fit + interactive bounds) constant from the
   * first frame, so the Continue button lands where it's expected and stays
   * clickable. An unrevealed element is simply transparent, not removed. The
   * decree's root is hidden wholesale via setVisible() until present(), so these
   * pre-revealed-but-transparent elements never show early.
   */
  private setOpacity(id: string, opacity: number): void {
    this.text(id)?.setProperties({ opacity });
  }

  // ─────────────────────────────── visibility ────────────────────────────────

  private setVisible(visible: boolean): void {
    if (this.panelEntity?.object3D) this.panelEntity.object3D.visible = visible;
    this.container('decree-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    if (visible) relayoutScreenSpacePanels(this.doc);
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
