/**
 * SummerTutorialSystem.ts — the Summer "how to play" coaching layer.
 *
 * Three teaching aids, all built from UIKit panels and shown only during Summer:
 *   1. A one-time OUTLINE modal when Summer begins — exactly what to do.
 *   2. Dismissible TIPS that pop up at helpful moments (after the outline, and
 *      a nudge if the student is idle).
 *   3. Per-character SCRIPTS — a short line of dialogue + a coaching hint that
 *      pops up when the student opens a trader (market stall OR farm).
 *
 * It is purely additive: it listens to gameState.onPhaseChanged and to
 * summerProgress.onVisit (the single funnel every trader interaction passes
 * through), and never drives the trade systems themselves.
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
import { summerProgress } from '../game/SummerProgress.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';

const TUTORIAL_CONFIG = './ui/summer-tutorial.json';
const TIP_CONFIG = './ui/summer-tip.json';

/** Seconds of Summer with no trades before we nudge the student. */
const IDLE_NUDGE_SECONDS = 25;

/** Dismissible tips, by key. */
const TIPS: Record<string, { title: string; body: string }> = {
  intro: {
    title: 'Tip',
    body: 'Check the Settlement Needs on the left, then point at a trader and pull the trigger to barter. Aim for a green Fair Trade.',
  },
  nudge: {
    title: 'Tip',
    body: 'Walk up to a trader and pull the trigger to start trading. The market stalls are by the well; the two farms are out at the edges.',
  },
};

/** Per-character dialogue scripts shown when a trader is opened. */
const SCRIPTS: Record<string, { title: string; body: string }> = {
  Martha: {
    title: 'Martha, the Herbalist',
    body: '"My remedies can cure the fever going round - but my children must eat. Bring me corn and the herbs are yours." (She wants corn: 3 corn = a bundle of herbs.)',
  },
  James: {
    title: 'James, the Blacksmith',
    body: '"Good iron is not cheap. I trade my tools for tobacco - the ships pay well for it." (He wants tobacco: 2 tobacco = a set of tools.)',
  },
  Anne: {
    title: 'Anne, the General Trader',
    body: '"I keep a little of everything, friend - but my finest goods cost both corn and tobacco." (Offer corn AND tobacco together.)',
  },
  Thomas: {
    title: 'Thomas, your Neighbor',
    body: '"Plenty of corn off my field this year! Trade me tobacco and take some home." (He wants tobacco: 2 tobacco = 4 corn.)',
  },
  Elizabeth: {
    title: 'Elizabeth, the Gardener',
    body: '"Herbs grow well in my plot. I will take corn or tobacco - whatever you can spare for the little ones." (Pay in corn OR tobacco for herbs.)',
  },
};

export class SummerTutorialSystem extends createSystem({
  tutorialPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', TUTORIAL_CONFIG)],
  },
  tipPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', TIP_CONFIG)],
  },
}) {
  private tutorialDoc?: UIKitDocument;
  private tipDoc?: UIKitDocument;
  private tutorialEntity?: Entity;
  private tipEntity?: Entity;

  /** The big outline shows once per session; tips/scripts reset each Summer. */
  private tutorialDismissed = false;
  private shownThisSummer = new Set<string>();
  private summerElapsed = 0;

  init() {
    // Outline modal (centered, top), hidden until Summer.
    this.tutorialEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: TUTORIAL_CONFIG,
        maxWidth: 1.7,
        maxHeight: 1.4,
      })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '22%',
        left: '24vw',
        width: '52vw',
        height: '60%',
      });
    this.tutorialEntity.object3D!.visible = false;

    // Tip / script toast (top-right corner), hidden until needed.
    this.tipEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: TIP_CONFIG, maxWidth: 0.95, maxHeight: 0.62 })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '20px',
        right: '20px',
        width: '320px',
        height: '210px',
      });
    this.tipEntity.object3D!.visible = false;

    // Wire the outline's Begin button once its document loads.
    this.cleanupFuncs.push(
      this.queries.tutorialPanel.subscribe(
        'qualify',
        (entity) => {
          this.tutorialDoc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.button(this.tutorialDoc, 'tut-begin')?.addEventListener(
            'click',
            () => this.onBegin(),
          );
          this.setTutorialVisible(false);
        },
        true,
      ),
    );

    // Wire the toast's Dismiss button once its document loads.
    this.cleanupFuncs.push(
      this.queries.tipPanel.subscribe(
        'qualify',
        (entity) => {
          this.tipDoc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.button(this.tipDoc, 'tip-dismiss')?.addEventListener('click', () =>
            this.setTipVisible(false),
          );
          this.setTipVisible(false);
        },
        true,
      ),
    );

    // React to phase changes.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase, newPhase) => {
        if (newPhase === 'Summer') this.onSummerStart();
        else if (oldPhase === 'Summer') this.hideAll();
      }),
    );
    if (gameState.currentPhase === 'Summer') this.onSummerStart();

    // Pop a character script whenever a trader is opened.
    this.cleanupFuncs.push(
      summerProgress.onVisit((id) => {
        if (gameState.currentPhase === 'Summer') this.showScript(id);
      }),
    );
  }

  update(delta: number) {
    if (gameState.currentPhase !== 'Summer') return;
    this.summerElapsed += delta;
    // Idle nudge: outline dismissed, no trades yet, and a little time has passed.
    if (
      this.tutorialDismissed &&
      summerProgress.getVisitedCount() === 0 &&
      this.summerElapsed >= IDLE_NUDGE_SECONDS
    ) {
      this.postTip('nudge');
    }
  }

  // ───────────────────────────── phase lifecycle ─────────────────────────────

  private onSummerStart(): void {
    this.shownThisSummer.clear();
    this.summerElapsed = 0;
    this.setTipVisible(false);
    // Show the full outline the first time only; afterwards a quick tip suffices.
    if (!this.tutorialDismissed) this.setTutorialVisible(true);
    else this.postTip('intro');
  }

  private hideAll(): void {
    this.setTutorialVisible(false);
    this.setTipVisible(false);
  }

  // ───────────────────────────── tips & scripts ──────────────────────────────

  private onBegin(): void {
    this.setTutorialVisible(false);
    this.tutorialDismissed = true;
    this.postTip('intro');
  }

  /** Show a tip once per Summer (keyed). */
  private postTip(key: string): void {
    const tip = TIPS[key];
    if (!tip || this.shownThisSummer.has(`tip:${key}`)) return;
    this.shownThisSummer.add(`tip:${key}`);
    this.showToast(tip.title, tip.body);
  }

  /** Show a trader's dialogue script once per Summer (keyed by trader id). */
  private showScript(id: string): void {
    const script = SCRIPTS[id];
    if (!script || this.shownThisSummer.has(`script:${id}`)) return;
    this.shownThisSummer.add(`script:${id}`);
    this.showToast(script.title, script.body);
  }

  private showToast(title: string, body: string): void {
    this.setText(this.tipDoc, 'tip-title', title);
    this.setText(this.tipDoc, 'tip-body', body);
    this.setTipVisible(true);
  }

  // ─────────────────────────────── visibility ────────────────────────────────

  private setTutorialVisible(visible: boolean): void {
    if (this.tutorialEntity?.object3D)
      this.tutorialEntity.object3D.visible = visible;
    this.container(this.tutorialDoc, 'tut-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    if (visible) relayoutScreenSpacePanels();
  }

  private setTipVisible(visible: boolean): void {
    if (this.tipEntity?.object3D) this.tipEntity.object3D.visible = visible;
    this.container(this.tipDoc, 'tip-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    if (visible) relayoutScreenSpacePanels();
  }

  // ─────────────────────────────── doc helpers ───────────────────────────────

  private el(doc: UIKitDocument | undefined, id: string): UIKit.Text | undefined {
    return (doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private button(
    doc: UIKitDocument | undefined,
    id: string,
  ): UIKit.Text | undefined {
    return this.el(doc, id);
  }

  private container(
    doc: UIKitDocument | undefined,
    id: string,
  ): UIKit.Container | undefined {
    return (doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }

  private setText(
    doc: UIKitDocument | undefined,
    id: string,
    value: string,
  ): void {
    this.el(doc, id)?.setProperties({ text: value });
  }
}
