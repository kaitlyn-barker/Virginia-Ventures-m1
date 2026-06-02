/**
 * ThomasAdviceSystem.ts — Thomas's Spring farming advice (branching dialogue).
 *
 * In Spring the player plants a 4x4 field (see FarmSystem). Thomas, the
 * neighbouring farmer, is the teacher for the corn-vs-tobacco tradeoff: point
 * at him and select him and he opens a short branching conversation, then sends
 * you off to plant. Finishing the talk marks the "Talk to Thomas" sub-task done.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW THE PLAYER OPENS THE DIALOGUE (the "built-in pointer")
 * ─────────────────────────────────────────────────────────────────────────
 * We don't write any raycasting. Adding `RayInteractable` to Thomas is the whole
 * opt-in: the built-in InputSystem then raycasts the controller pointer for us
 * and, when the player points at Thomas and pulls the trigger, adds the
 * transient `Pressed` tag to his entity. We just watch for "Thomas gained
 * Pressed" (a query subscription) and open the panel. This is the same pattern
 * the Summer MarketSystem / FarmVisitSystem use for their trader NPCs.
 *
 * Thomas is ALSO a Summer trade target (FarmVisitSystem), and that system already
 * toggles his `RayInteractable` for Summer. To avoid the two systems fighting
 * over that one shared tag, this system only ADDS it for Spring (and removes it
 * when Spring ends to a non-Summer phase); it never touches the Summer case.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DIALOGUE PANEL
 * ─────────────────────────────────────────────────────────────────────────
 * The panel is a world-space UIKit document (ui/thomas-dialogue.uikitml →
 * ./ui/thomas-dialogue.json) shown floating beside Thomas, facing the player —
 * the same world-space-panel approach as the market's trade panel. We swap its
 * body text and show/hide its buttons to walk a tiny state machine:
 *
 *   opening ──[corn]──▶ corn ──┐
 *           └─[tobacco]▶ tobacco┤──[Got it]──▶ closing ──[Get planting!]──▶ done
 *
 * (You can hear BOTH crops before moving on — the two question buttons stay
 * available in the branch state, which is exactly the "balance both" lesson.)
 */

import {
  createComponent,
  createSystem,
  Interactable,
  PanelDocument,
  PanelUI,
  Pressed,
  RayInteractable,
  ScreenSpace,
  Transform,
  UIKit,
  UIKitDocument,
  eq,
  type Entity,
} from '@iwsdk/core';

import { gameState } from '../game/GameState.js';
import { springProgress } from '../game/SpringProgress.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';

/** Tags Thomas as the Spring farming advisor (found by NPC name at startup). */
export const SpringAdvisor = createComponent('SpringAdvisor', {});

const DIALOGUE_PANEL = './ui/thomas-dialogue.json';

/** Thomas's exact lines (em-dashes softened to hyphens for the panel font). */
const LINES = {
  opening:
    "Welcome, neighbor! First spring is the hardest. Your land is ready - but choose your crops wisely.",
  corn:
    "Corn fills bellies. Plant plenty and your settlement won't go hungry come winter. But it fetches little at market - folks grow their own.",
  tobacco:
    "Ah, tobacco - the gold leaf! The English ships pay dear for it. But you cannot eat it. Plant too much and you'll be trading desperately for food all summer.",
  closing:
    "My advice? Don't put all your seed in one basket. A wise colonist balances the belly and the purse. Now - get planting!",
} as const;

/** The conversation's current step. */
type DlgState = 'opening' | 'corn' | 'tobacco' | 'closing';

export class ThomasAdviceSystem extends createSystem({
  // Every transform entity — scanned once to find Thomas by name.
  npcCandidates: { required: [Transform] },
  // Thomas just got pressed (pointer + trigger).
  pressedAdvisor: { required: [SpringAdvisor, Pressed] },
  // The dialogue panel, matched once its UIKit document has loaded.
  dialoguePanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', DIALOGUE_PANEL)],
  },
}) {
  /** Thomas's entity, resolved by name at startup. */
  private thomas?: Entity;

  /** The dialogue panel entity + its loaded document. */
  private panelEntity?: Entity;
  private doc?: UIKitDocument;

  /** Where we are in the conversation. */
  private state: DlgState = 'opening';

  init() {
    // ── Create the bottom-of-view dialogue box (hidden until Thomas is opened) ─
    this.panelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: DIALOGUE_PANEL,
        maxWidth: 1.9,
        maxHeight: 0.62,
      })
      // Interactable so the box's buttons receive pointer/ray clicks.
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        bottom: '78px',
        left: '8vw',
        width: '84vw',
        height: '210px',
        // In front of the bottom HUDs (inventory/banner at 0.26) but behind the
        // phase-transition overlay (0.14) and above the camera near-clip.
        zOffset: 0.18,
      });
    this.panelEntity.object3D!.visible = false;

    // ── Find Thomas by name and tag him as the Spring advisor ────────────────
    //    (`true` replays for NPCs that already exist — colonists are built
    //    before systems register, so Thomas is already in the world here.)
    this.cleanupFuncs.push(
      this.queries.npcCandidates.subscribe(
        'qualify',
        (entity) => this.tryTagThomas(entity),
        true,
      ),
    );

    // ── Make Thomas selectable only during Spring ────────────────────────────
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase, newPhase) => {
        if (newPhase === 'Spring') {
          this.setThomasInteractive(true);
        } else if (oldPhase === 'Spring') {
          // Leaving Spring: close any open talk. Only strip his RayInteractable
          // when the NEXT phase doesn't also want it — Summer does (for trading,
          // managed by FarmVisitSystem), so we leave it alone there.
          this.closeDialogue();
          if (newPhase !== 'Summer') this.setThomasInteractive(false);
        }
      }),
    );
    // Apply the current phase right away (e.g. if we boot straight into Spring).
    if (gameState.currentPhase === 'Spring') this.setThomasInteractive(true);

    // ── Open the dialogue when Thomas is pressed (Spring only) ───────────────
    this.cleanupFuncs.push(
      this.queries.pressedAdvisor.subscribe('qualify', () => {
        if (gameState.currentPhase === 'Spring') this.openDialogue();
      }),
    );

    // ── Wire the panel's buttons once its document loads ─────────────────────
    this.cleanupFuncs.push(
      this.queries.dialoguePanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[entity.index] as
            | UIKitDocument
            | undefined;
          this.wirePanel();
          // Start hidden (the root's CSS default is display:flex).
          this.setBoxVisible(false);
        },
        true,
      ),
    );
  }

  /** If this entity is Thomas, tag him with SpringAdvisor and remember him. */
  private tryTagThomas(entity: Entity): void {
    if (this.thomas || entity.object3D?.name !== 'Thomas') return;
    this.thomas = entity;
    if (!entity.hasComponent(SpringAdvisor)) entity.addComponent(SpringAdvisor);
    // Apply the current phase's interactivity to the freshly-tagged Thomas.
    if (gameState.currentPhase === 'Spring') this.setThomasInteractive(true);
  }

  /** Add/remove RayInteractable on Thomas (selectable for Spring advice). */
  private setThomasInteractive(on: boolean): void {
    const t = this.thomas;
    if (!t) return;
    const has = t.hasComponent(RayInteractable);
    if (on && !has) t.addComponent(RayInteractable);
    else if (!on && has) t.removeComponent(RayInteractable);
  }

  // ──────────────────────────────── open / close ─────────────────────────────

  private openDialogue(): void {
    if (!this.panelEntity || !this.thomas) return;

    // Funnel the interaction to the tutorial layer so it can pop Thomas's
    // character script (the Spring twin of SummerProgress.onVisit).
    springProgress.recordTalk('Thomas');

    // Reveal the bottom-of-view box and re-fit its on-screen layout.
    this.setBoxVisible(true);

    // Always (re)start the conversation from the opening line.
    this.setState('opening');
  }

  private closeDialogue(): void {
    this.setBoxVisible(false);
  }

  /** Show/hide the box (object3D + root display + relayout when shown). */
  private setBoxVisible(visible: boolean): void {
    if (this.panelEntity?.object3D) this.panelEntity.object3D.visible = visible;
    this.container('dlg-root')?.setProperties({ display: visible ? 'flex' : 'none' });
    if (visible) relayoutScreenSpacePanels();
  }

  // ──────────────────────────────── panel wiring ─────────────────────────────

  private wirePanel(): void {
    this.button('btn-corn')?.addEventListener('click', () => this.setState('corn'));
    this.button('btn-tobacco')?.addEventListener('click', () =>
      this.setState('tobacco'),
    );
    this.button('btn-advance')?.addEventListener('click', () => this.onAdvance());
  }

  /** Move to a dialogue step: show the full line + the right buttons at once. */
  private setState(state: DlgState): void {
    this.state = state;
    this.setText('dlg-body', LINES[state]);

    // The two question buttons are available everywhere EXCEPT the closing line.
    this.container('dlg-options')?.setProperties({
      display: state !== 'closing' ? 'flex' : 'none',
    });

    // The "Continue" affordance is hidden on the opening line (the player must
    // hear at least one crop first); otherwise it advances, ending on the
    // closing line's "Get planting!".
    const advance = this.button('btn-advance');
    if (state === 'opening') {
      advance?.setProperties({ display: 'none' });
    } else {
      advance?.setProperties({
        display: 'flex',
        text: state === 'closing' ? 'Get planting! >' : 'Continue >',
      });
    }
  }

  /** The advance button: branch → closing, or closing → finish the talk. */
  private onAdvance(): void {
    if (this.state === 'closing') this.finishDialogue();
    else this.setState('closing');
  }

  /** End the conversation: close the panel, complete the sub-task, log it once. */
  private finishDialogue(): void {
    this.closeDialogue();
    if (!springProgress.isComplete('talkToThomas')) {
      springProgress.complete('talkToThomas');
      objectiveTracker.completeSubTask('spring-thomas');
      gameState.logDecision('Talked to Thomas for farming advice');
    }
  }

  // ─────────────────────────────── small helpers ─────────────────────────────

  private el(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private button(id: string): UIKit.Text | undefined {
    return this.el(id);
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }

  private setText(id: string, value: string): void {
    this.el(id)?.setProperties({ text: value });
  }
}
