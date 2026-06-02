/**
 * Reflection.ts — Winter, Part C: "Reflect on Your Year."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES
 * ─────────────────────────────────────────────────────────────────────────
 * After the Results Dashboard, the student steps through a few reflection
 * questions, one at a time. The questions are PERSONALIZED: this system reads
 * `gameState.decisionLog` (the record of what the student actually did) and
 * rewords prompts to match — e.g. "you planted more tobacco than corn" vs "more
 * corn than tobacco". Each answer is saved to `reflectionStore`.
 *
 * STRICTLY: it only READS the decision log (never writes to it) and never
 * touches scores. Answers go to the separate ReflectionStore singleton.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UNITY → WEB MENTAL MODEL
 * ─────────────────────────────────────────────────────────────────────────
 * A "system" is the web version of a Unity script; `init()` is its Awake (the
 * World calls it once after registration). `startReflection()` is a tiny module-
 * level emitter — the stand-in for a C# `static event` — so the dashboard button
 * can kick this off without holding a reference to the system instance.
 */

import {
  AudioUtils,
  Interactable,
  PanelDocument,
  PanelUI,
  Quaternion,
  UIKit,
  UIKitDocument,
  Vector3,
  createSystem,
  eq,
  type Entity,
} from '@iwsdk/core';

import { gameState } from '../game/GameState.js';
import { reflectionStore } from '../game/ReflectionStore.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';

const PANEL_CONFIG = './ui/reflection.json';

/** How many choice <span>s the panel authors (we hide any unused ones). */
const MAX_CHOICES = 3;

/** Choice colors: muted brown when idle, gold when selected (matches the game). */
const CHOICE_IDLE_BG = '#3a2e22';
const CHOICE_IDLE_TEXT = '#e8dcc0';
const CHOICE_SELECTED_BG = '#c79a4b';
const CHOICE_SELECTED_TEXT = '#2a2018';

/** Where the panel sits relative to the player rig (same as the dashboard). */
const PANEL_DISTANCE = 2.2; // metres in front of the rig
const PANEL_HEIGHT = 1.5; // metres above the rig floor (reading height)

/** One reflection question: a stable id, the prompt, and 2–3 answer choices. */
interface ReflectionQuestion {
  id: string;
  prompt: string;
  choices: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// startReflection() — the public trigger the dashboard's "Reflect" button calls
// (replacing its placeholder log). Module-level emitter, same pattern as
// ResultsDashboard.openDashboard().
// ─────────────────────────────────────────────────────────────────────────
const startListeners = new Set<() => void>();

/** Begin the reflection sequence. Safe to call once the system is registered. */
export function startReflection(): void {
  for (const cb of [...startListeners]) cb();
}

export class Reflection extends createSystem({
  reflectionPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  private doc?: UIKitDocument;
  private panelEntity?: Entity;

  /** The personalized question list, built fresh each time we start. */
  private questions: ReflectionQuestion[] = [];
  /** Which question is currently showing (0-based). */
  private stepIndex = 0;
  /** Which choice is selected for the current question (-1 = none yet). */
  private selectedIndex = -1;

  // Scratch objects for the anchor math (allocate once, reuse).
  private tmpPos!: Vector3;
  private tmpQuat!: Quaternion;
  private forward!: Vector3;

  init() {
    this.tmpPos = new Vector3();
    this.tmpQuat = new Quaternion();
    this.forward = new Vector3();

    // World-space panel (no ScreenSpace), hidden until startReflection() fires.
    this.panelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: PANEL_CONFIG, maxWidth: 1.5, maxHeight: 1.3 })
      .addComponent(Interactable);
    this.panelEntity.object3D!.visible = false;

    // Grab the document + wire the choices and Next once the panel loads.
    this.cleanupFuncs.push(
      this.queries.reflectionPanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          for (let i = 0; i < MAX_CHOICES; i++) {
            const idx = i; // capture for the closure
            this.span(`choice-${i}`)?.addEventListener('click', () =>
              this.onChoose(idx),
            );
          }
          this.span('reflect-next')?.addEventListener('click', () =>
            this.onNext(),
          );
          // The closing screen's Finish button (Step 4).
          this.span('reflect-finish')?.addEventListener('click', () =>
            this.onFinish(),
          );
          this.setVisible(false);
        },
        true,
      ),
    );

    // Subscribe to the public start trigger (the dashboard button calls it).
    startListeners.add(this.handleStart);
    this.cleanupFuncs.push(() => startListeners.delete(this.handleStart));
  }

  /** Bound handler so add/delete reference the same function instance. */
  private handleStart = (): void => this.start();

  // ─────────────────────────────────── start ─────────────────────────────────

  private start(): void {
    // Build personalized questions from the decision log, reset to question 0.
    this.questions = this.buildQuestions();
    this.stepIndex = 0;
    // Make sure we're on the QUESTION view, not a leftover closing view.
    this.container('reflect-question')?.setProperties({ display: 'flex' });
    this.container('reflect-closing')?.setProperties({ display: 'none' });
    this.anchorInFrontOfPlayer();
    this.render();
    this.setVisible(true);
    objectiveTracker.completeSubTask('winter-reflection');
    console.log(
      `[Winter] Reflection started - ${this.questions.length} question(s).`,
    );
  }

  /**
   * Build the three reflection questions in plain student language. Q1 and Q2
   * are fixed; Q3 is PERSONALIZED from the decision log (see below). Read-only:
   * we never modify the log.
   *
   * HOW WE READ THE LOG FOR Q3: during Fall, SmugglingChoice.ts records exactly
   * one of these lines via gameState.logDecision(...):
   *   "[Fall] Player chose to smuggle tobacco - ..."   → the student smuggled
   *   "[Fall] Player refused smuggling - ..."          → the student refused
   * So we just scan the log for the "chose to smuggle" phrase. If it's there,
   * the student smuggled and Q3 asks whether the risk paid off; otherwise (they
   * refused, OR never even met the smuggler) we use the "played it safe" wording.
   */
  private buildQuestions(): ReflectionQuestion[] {
    const smuggled = gameState.decisionLog.some((e) =>
      /chose to smuggle/i.test(e),
    );

    const questions: ReflectionQuestion[] = [];

    // Q1 — TRADE-OFFS: scarce land forced a food-vs-cash-crop choice.
    questions.push({
      id: 'land',
      prompt: 'You only had so much land. How did you decide what to plant?',
      choices: [
        "I grew mostly food so my colony wouldn't go hungry.",
        'I grew mostly tobacco to earn more money to trade.',
        'I tried to balance food and tobacco.',
      ],
    });

    // Q2 — THE CROWN TAX / MERCANTILISM: was England's tobacco tax fair?
    questions.push({
      id: 'tax',
      prompt:
        'England made you pay a tax on the tobacco you sold. Was that fair to the colony?',
      choices: [
        'Yes - the colony was part of England, so it made sense.',
        'No - the colony did the work but England took a share.',
        "I'm not sure - there are good points on both sides.",
      ],
    });

    // Q3 — RISK: prompt AND the first two choices change with the smuggling read.
    // (Em dashes are written as " - " hyphens; the bundled UIKit font has no
    // em-dash glyph and would warn/blank it out.)
    if (smuggled) {
      questions.push({
        id: 'risk',
        prompt:
          'You sold tobacco to the Dutch trader to avoid the tax. Was the risk worth it?',
        choices: [
          'The reward was worth the risk of getting caught.',
          'It was too risky - getting caught would hurt the colony.',
          "I didn't think about it much at the time.",
        ],
      });
    } else {
      questions.push({
        id: 'risk',
        prompt:
          'You chose not to smuggle, even though it paid more. Why did you play it safe?',
        choices: [
          'Avoiding trouble with the Crown mattered more than extra money.',
          'I wanted the extra money but worried about getting caught.',
          "I didn't think about it much at the time.",
        ],
      });
    }

    return questions;
  }

  // ──────────────────────────────── interaction ──────────────────────────────

  /** A choice was tapped: remember it and repaint the buttons (selected = gold). */
  private onChoose(index: number): void {
    const q = this.questions[this.stepIndex];
    if (!q || index >= q.choices.length) return;
    this.selectedIndex = index;
    this.paintChoices(q);
  }

  /**
   * "Next" tapped: save the answer, then advance to the next question (or
   * finish). Does nothing until the student has actually picked a choice.
   */
  private onNext(): void {
    if (this.selectedIndex < 0) return; // must choose before advancing
    const q = this.questions[this.stepIndex];
    if (!q) return;

    // STEP 3 — record the answer (questionId → chosen text) into the NEW store.
    // No scoring: reflection has no right/wrong answers; we just save the pick.
    reflectionStore.record(q.id, q.choices[this.selectedIndex]);

    this.stepIndex += 1;
    if (this.stepIndex >= this.questions.length) {
      this.showClosing(); // answered the last question → closing screen
    } else {
      this.render();
    }
  }

  /**
   * STEP 4 — after the final question, swap to the closing view. We log the
   * full answers object here so it's easy to confirm everything captured
   * correctly (this is the teacher's review record).
   */
  private showClosing(): void {
    console.log('[Winter] Reflection answers:', reflectionStore.getAnswers());
    this.container('reflect-question')?.setProperties({ display: 'none' });
    this.container('reflect-closing')?.setProperties({ display: 'flex' });
  }

  /**
   * The closing "Finish" button. Plays the completion sound and fires the
   * GameState `onSimulationComplete` event so the surrounding course shell can
   * react, then hides the panel.
   */
  private onFinish(): void {
    this.playCompleteSound();
    gameState.completeSimulation(); // fire the end-of-simulation event
    this.setVisible(false);
    console.log('[Winter] Simulation complete - reflection finished.');
  }

  /**
   * PLACEHOLDER "reflection complete" sound. There's no /audio/reflection_complete
   * .mp3 yet (only chime.mp3), so this AudioUtils call is the fallback — same
   * pattern as WinterScene's winter_wind: wired here, fails quietly until the
   * real file is dropped into public/audio/.
   */
  private playCompleteSound(): void {
    try {
      AudioUtils.createOneShot(this.world, '/audio/reflection_complete.mp3', {
        volume: 0.5,
        positional: false,
      });
    } catch (err) {
      console.warn('[Winter] reflection_complete unavailable (placeholder):', err);
    }
  }

  // ──────────────────────────────── rendering ────────────────────────────────

  /** Draw the current question: progress line, prompt, choices, Next label. */
  private render(): void {
    const q = this.questions[this.stepIndex];
    if (!q || !this.doc) return;

    this.selectedIndex = -1; // each new question starts unanswered

    this.setText(
      'reflect-progress',
      `Question ${this.stepIndex + 1} of ${this.questions.length}`,
    );
    this.setText('reflect-prompt', q.prompt);
    this.paintChoices(q);

    // The control reads "Finish" on the last question, "Next" otherwise.
    this.setText(
      'reflect-next',
      this.stepIndex === this.questions.length - 1 ? 'Finish' : 'Next',
    );
  }

  /** Show/label the choices for `q`, highlighting the selected one; hide extras. */
  private paintChoices(q: ReflectionQuestion): void {
    for (let i = 0; i < MAX_CHOICES; i++) {
      const span = this.span(`choice-${i}`);
      if (!span) continue;
      if (i < q.choices.length) {
        const selected = i === this.selectedIndex;
        span.setProperties({
          text: q.choices[i],
          display: 'flex',
          backgroundColor: selected ? CHOICE_SELECTED_BG : CHOICE_IDLE_BG,
          color: selected ? CHOICE_SELECTED_TEXT : CHOICE_IDLE_TEXT,
        });
      } else {
        span.setProperties({ display: 'none' }); // hide unused choice slots
      }
    }
  }

  // ─────────────────────────────── placement ─────────────────────────────────

  /** Anchor the panel in front of the player RIG at reading height (see the
   *  identical helper in ResultsDashboard for the full explanation). */
  private anchorInFrontOfPlayer(): void {
    const panel = this.panelEntity?.object3D;
    if (!panel) return;
    this.player.getWorldPosition(this.tmpPos);
    this.player.getWorldQuaternion(this.tmpQuat);
    this.forward.set(0, 0, -1).applyQuaternion(this.tmpQuat);
    panel.position
      .copy(this.tmpPos)
      .addScaledVector(this.forward, PANEL_DISTANCE);
    panel.position.y = this.tmpPos.y + PANEL_HEIGHT;
    panel.quaternion.copy(this.tmpQuat);
  }

  // ─────────────────────────────── small helpers ─────────────────────────────

  private setVisible(visible: boolean): void {
    if (this.panelEntity?.object3D) this.panelEntity.object3D.visible = visible;
    this.container('reflect-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
  }

  /** A clickable/styleable text span (choices + Next are all spans). */
  private span(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }

  private setText(id: string, value: string): void {
    this.span(id)?.setProperties({ text: value });
  }
}
