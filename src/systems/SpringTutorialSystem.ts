/**
 * SpringTutorialSystem.ts — the Spring "how to play" coaching layer.
 *
 * The Spring twin of SummerTutorialSystem. Three teaching aids, all built from
 * UIKit panels and shown only during Spring:
 *   1. A one-time OUTLINE modal when Spring begins — exactly what to do.
 *   2. Dismissible TIPS that pop up at helpful moments (after the outline, a
 *      nudge if the student hasn't planted, and a reminder once the field is
 *      full to press Confirm Planting).
 *   3. Per-character SCRIPTS — a short line of dialogue + a coaching hint that
 *      pops up when the student interacts with a farm character (Thomas, the
 *      mentor; Elizabeth, the gardener neighbor).
 *
 * It is purely additive coaching: it reads gameState / springProgress and the
 * FarmCell tally, and never drives the planting or dialogue systems themselves.
 *
 * Character-interaction funnel: Thomas's advice (ThomasAdviceSystem) calls
 * springProgress.recordTalk('Thomas') when it opens; this system also makes the
 * named farm neighbors (Elizabeth) selectable in Spring and records a talk when
 * they're picked. Either way `springProgress.onTalk` fires and we pop the
 * matching script — exactly how Summer keys scripts off summerProgress.onVisit.
 */

import {
  Follower,
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
  eq,
  type Entity,
} from '@iwsdk/core';

import { hudFollow } from '../ui/hudFollow.js';
import { gameState } from '../game/GameState.js';
import { springProgress } from '../game/SpringProgress.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';
import { sfx } from '../audio/Sfx.js';
import { FarmCell } from './FarmSystem.js';

const TUTORIAL_CONFIG = './ui/spring-tutorial.json';
const TIP_CONFIG = './ui/spring-tip.json';

/** Seconds of Spring with nothing planted before we nudge the student. */
const IDLE_NUDGE_SECONDS = 25;

/** The whole field is 16 plots (used to detect "field full → confirm"). */
const TOTAL_CELLS = 16;

/**
 * Named farm characters this system makes selectable in Spring to show a script.
 * Thomas is NOT here — ThomasAdviceSystem owns his selection (his advice
 * dialogue) and funnels the talk to us via springProgress.recordTalk('Thomas').
 */
const NEIGHBORS = ['Elizabeth'] as const;

/** Tags a Spring farm neighbor so we can toggle their selectability per phase. */
export const SpringNeighbor = createComponent('SpringNeighbor', {
  who: { type: Types.String, default: '' },
});

/** Dismissible tips, by key. */
const TIPS: Record<string, { title: string; body: string }> = {
  intro: {
    title: 'Tip',
    body: 'Click a seed bag on the stump to pick a crop, then click any plot to plant it. Click the other bag to switch crops. Talk to Thomas for advice first.',
  },
  nudge: {
    title: 'Tip',
    body: 'Click a corn or tobacco seed bag on the stump beside your field, then click a plot to plant it. Fill all 16 plots.',
  },
  ready: {
    title: 'Tip',
    body: 'Your whole field is planted! Look to the panel above the field and press Confirm Planting to bring in the harvest and finish Spring.',
  },
};

/** Per-character scripts shown when the student interacts with that character. */
const SCRIPTS: Record<string, { title: string; body: string }> = {
  Thomas: {
    title: 'Thomas, your Neighbor',
    body: '"First spring is the hardest, friend. Plant corn to fill bellies and tobacco to fill your purse - but never all of one. Balance carries a colony through winter."',
  },
  Elizabeth: {
    title: 'Elizabeth, the Gardener',
    body: '"I tend herbs the settlement will want come summer. Plant your field wisely now, and you will have plenty to trade me later."',
  },
};

export class SpringTutorialSystem extends createSystem({
  tutorialPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', TUTORIAL_CONFIG)],
  },
  tipPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', TIP_CONFIG)],
  },
  // Every transform entity — scanned once to find the neighbor NPCs by name.
  npcCandidates: { required: [Transform] },
  // The tagged neighbors (toggled selectable per phase).
  neighbors: { required: [SpringNeighbor] },
  // A neighbor the student just picked (point + trigger) in Spring.
  pressedNeighbor: { required: [SpringNeighbor, Pressed] },
  // Cell tally, to spot "nothing planted yet" and "field full".
  cornCells: { required: [FarmCell], where: [eq(FarmCell, 'crop', 'corn')] },
  tobaccoCells: { required: [FarmCell], where: [eq(FarmCell, 'crop', 'tobacco')] },
  allCells: { required: [FarmCell] },
}) {
  private tutorialDoc?: UIKitDocument;
  private tipDoc?: UIKitDocument;
  private tutorialEntity?: Entity;
  private tipEntity?: Entity;

  /** The outline shows once per session; tips/scripts reset each Spring. */
  private tutorialDismissed = false;
  private shownThisSpring = new Set<string>();
  private springElapsed = 0;

  /** Neighbor NPCs already tagged (so the scan doesn't double-process). */
  private tagged = new Set<string>();

  init() {
    // Outline modal (centered), hidden until Spring.
    this.tutorialEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: TUTORIAL_CONFIG,
        maxWidth: 1.7,
        maxHeight: 1.4,
      })
      .addComponent(RayInteractable)
      .addComponent(ScreenSpace, {
        top: '24%',
        left: '24vw',
        width: '52vw',
        height: '56%',
      })
      // XR: center the outline modal in front of the headset (its Transform is
      // never positioned, so without this it would land at the world origin).
      .addComponent(Follower, hudFollow(this.player.head, [0, 0, -1.7]));
    this.tutorialEntity.object3D!.visible = false;

    // Tip / script toast (top-right corner), hidden until needed.
    this.tipEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: TIP_CONFIG, maxWidth: 0.95, maxHeight: 0.62 })
      .addComponent(RayInteractable)
      // Top-CENTER (not the top-right corner) so it never sits under the
      // objective tracker HUD or get clipped against the very top of the canvas.
      .addComponent(ScreenSpace, {
        top: '14%',
        left: 'calc(50vw - 160px)',
        width: '320px',
        height: '210px',
      })
      // XR: keep the tip toast upper-center in front of the headset, mirroring
      // its top-center desktop spot.
      .addComponent(Follower, hudFollow(this.player.head, [0, 0.4, -1.7]));
    this.tipEntity.object3D!.visible = false;

    // Wire the outline's Begin button once its document loads.
    this.cleanupFuncs.push(
      this.queries.tutorialPanel.subscribe(
        'qualify',
        (entity) => {
          this.tutorialDoc = PanelDocument.data.document[entity.index] as
            | UIKitDocument
            | undefined;
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
          this.tipDoc = PanelDocument.data.document[entity.index] as
            | UIKitDocument
            | undefined;
          this.button(this.tipDoc, 'tip-dismiss')?.addEventListener('click', () => {
            sfx.click();
            this.setTipVisible(false);
          });
          this.setTipVisible(false);
        },
        true,
      ),
    );

    // Find the neighbor NPCs (Elizabeth) by name and tag them.
    this.cleanupFuncs.push(
      this.queries.npcCandidates.subscribe(
        'qualify',
        (entity) => this.tryTagNeighbor(entity),
        true,
      ),
    );

    // React to phase changes.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase, newPhase) => {
        if (newPhase === 'Spring') this.onSpringStart();
        else if (oldPhase === 'Spring') this.onSpringEnd(newPhase);
      }),
    );
    if (gameState.currentPhase === 'Spring') this.onSpringStart();

    // Pop a character script whenever the student talks to someone.
    this.cleanupFuncs.push(
      springProgress.onTalk((id) => {
        if (gameState.currentPhase === 'Spring') this.showScript(id);
      }),
    );

    // A neighbor was picked → record the talk (which fires the script above).
    this.cleanupFuncs.push(
      this.queries.pressedNeighbor.subscribe('qualify', (entity) => {
        if (gameState.currentPhase !== 'Spring') return;
        springProgress.recordTalk(entity.getValue(SpringNeighbor, 'who') ?? '');
      }),
    );
  }

  update(delta: number) {
    if (gameState.currentPhase !== 'Spring') return;
    this.springElapsed += delta;

    const planted =
      this.queries.cornCells.entities.size + this.queries.tobaccoCells.entities.size;

    // Idle nudge: outline dismissed, nothing planted, and a little time passed.
    if (
      this.tutorialDismissed &&
      planted === 0 &&
      this.springElapsed >= IDLE_NUDGE_SECONDS
    ) {
      this.postTip('nudge');
    }

    // Field full → remind the student to confirm.
    if (this.queries.allCells.entities.size >= TOTAL_CELLS && planted >= TOTAL_CELLS) {
      this.postTip('ready');
    }
  }

  // ───────────────────────────── phase lifecycle ─────────────────────────────

  private onSpringStart(): void {
    this.shownThisSpring.clear();
    this.springElapsed = 0;
    this.setTipVisible(false);
    this.setNeighborsSelectable(true);
    // Show the full outline the first time only; afterwards a quick tip suffices.
    if (!this.tutorialDismissed) this.setTutorialVisible(true);
    else this.postTip('intro');
  }

  private onSpringEnd(nextPhase: string): void {
    this.setTutorialVisible(false);
    this.setTipVisible(false);
    // Leave neighbor selectability alone if Summer wants it next (FarmVisitSystem
    // manages it then); otherwise turn it off.
    if (nextPhase !== 'Summer') this.setNeighborsSelectable(false);
  }

  // ───────────────────────────── neighbor NPCs ───────────────────────────────

  /** Tag a neighbor NPC (Elizabeth) so it can be made selectable in Spring. */
  private tryTagNeighbor(entity: Entity): void {
    const name = entity.object3D?.name ?? '';
    if (!NEIGHBORS.includes(name as (typeof NEIGHBORS)[number]) || this.tagged.has(name))
      return;
    this.tagged.add(name);
    if (!entity.hasComponent(SpringNeighbor))
      entity.addComponent(SpringNeighbor, { who: name });
    if (gameState.currentPhase === 'Spring') this.setOneSelectable(entity, true);
  }

  /** Add/remove RayInteractable on every tagged neighbor (selectable in Spring). */
  private setNeighborsSelectable(on: boolean): void {
    for (const n of this.queries.neighbors.entities) this.setOneSelectable(n, on);
  }

  private setOneSelectable(entity: Entity, on: boolean): void {
    const has = entity.hasComponent(RayInteractable);
    if (on && !has) entity.addComponent(RayInteractable);
    else if (!on && has) entity.removeComponent(RayInteractable);
  }

  // ───────────────────────────── tips & scripts ──────────────────────────────

  private onBegin(): void {
    sfx.click();
    this.setTutorialVisible(false);
    this.tutorialDismissed = true;
    this.postTip('intro');
  }

  /** Show a tip once per Spring (keyed). */
  private postTip(key: string): void {
    const tip = TIPS[key];
    if (!tip || this.shownThisSpring.has(`tip:${key}`)) return;
    this.shownThisSpring.add(`tip:${key}`);
    this.showToast(tip.title, tip.body);
  }

  /** Show a character's script once per Spring (keyed by character id). */
  private showScript(id: string): void {
    const script = SCRIPTS[id];
    if (!script || this.shownThisSpring.has(`script:${id}`)) return;
    this.shownThisSpring.add(`script:${id}`);
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
    if (visible) relayoutScreenSpacePanels(this.tutorialDoc);
  }

  private setTipVisible(visible: boolean): void {
    if (this.tipEntity?.object3D) this.tipEntity.object3D.visible = visible;
    this.container(this.tipDoc, 'tip-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    if (visible) relayoutScreenSpacePanels(this.tipDoc);
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
