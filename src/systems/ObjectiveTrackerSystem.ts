/**
 * ObjectiveTrackerSystem.ts — the persistent, quest-style objective tracker.
 *
 * A right-side HUD panel (below where the score readout sits) that always shows
 * the player WHAT TO DO right now: the current phase + a season-colored badge,
 * the headline objective for that phase, and a checklist of sub-tasks. As each
 * step is finished its circle fills with a green check, the row gives a subtle
 * pulse + a soft "ding", and the NEXT to-do task glows so the player's eye is
 * led straight to it.
 *
 * It is purely a VIEW: it owns no gameplay. Each gameplay system reports a
 * finished step through the `objectiveTracker` singleton (completeSubTask /
 * setProgress); this system listens for those changes and the phase changes and
 * repaints. Same wiring as SeasonBannerSystem / NeedsSystem:
 *   - build the PanelUI + ScreenSpace entity in init(),
 *   - capture its UIKit document via a query 'qualify' subscription,
 *   - paint, and repaint on phase changes and objective changes.
 *
 * NOTE on two sub-tasks with no dedicated gameplay event:
 *   - 'arrival-supply' ("Choose your supply package") — this build has no
 *     separate supply-selection step (Arrival → Spring is the banner tab by
 *     design), so it's checked off as the player leaves Arrival.
 *   - 'summer-checkneeds' ("Check your settlement needs") — orientation only,
 *     so it's auto-checked a few seconds into Summer, right as the needs panel
 *     appears on the left, to draw the eye there. Both are navigation aids; no
 *     gameplay, scoring, or phase logic is touched.
 */

import {
  AudioUtils,
  createSystem,
  Follower,
  Interactable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  UIKit,
  UIKitDocument,
  eq,
} from '@iwsdk/core';

import { hudFollow } from '../ui/hudFollow.js';

import { gameState, PHASE_ORDER, type GamePhase } from '../game/GameState.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';
import { SEASON_ACCENT, SEASON_LABEL } from './seasons.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';
import { arrivalSequence } from '../game/ArrivalSequence.js';

/** The tracker panel's UI config (compiled from ui/objective-tracker.uikitml). */
const PANEL_CONFIG = './ui/objective-tracker.json';

/** How many sub-task rows the .uikitml authored (we hide the unused ones). */
const MAX_ROWS = 4;

/** Seconds into Summer before the orientation "check your needs" task auto-ticks. */
const CHECK_NEEDS_DELAY_MS = 3500;

// Checklist colors (parchment palette, matching settlement-needs / the banner).
const MET_GREEN = '#5cb860';
const CIRCLE_IDLE_BG = '#2a2018';
const CIRCLE_IDLE_BORDER = '#6b5a3c';
const ROW_IDLE_BORDER = '#322619';
const LABEL_TODO = '#cbb78f';
const LABEL_NEXT = '#f4ead2';
const LABEL_DONE = '#8a8470';

/** One checklist sub-task. */
interface SubTask {
  id: string;
  label: string;
}

/** The objective shown for a phase: a headline + its checklist. */
interface Objective {
  title: string;
  tasks: SubTask[];
}

/**
 * The per-phase objectives. The sub-task ids here are the exact strings the
 * gameplay systems pass to `objectiveTracker.completeSubTask(...)`.
 */
const OBJECTIVES: Record<GamePhase, Objective> = {
  Arrival: {
    title: 'Welcome to Virginia! Get your supplies.',
    tasks: [
      { id: 'arrival-watch', label: 'Watch the arrival story' },
      { id: 'arrival-supply', label: 'Choose your supply package' },
    ],
  },
  Spring: {
    title: 'Plant your crops before summer!',
    tasks: [
      { id: 'spring-thomas', label: 'Talk to Thomas for farming advice' },
      { id: 'spring-plant', label: 'Plant seeds in all 16 plots' },
      { id: 'spring-confirm', label: 'Confirm your planting choices' },
    ],
  },
  Summer: {
    title: 'Trade with your neighbors to survive.',
    tasks: [
      { id: 'summer-checkneeds', label: 'Check your settlement needs (left panel)' },
      { id: 'summer-visit', label: 'Visit the market or a neighbor farm' },
      { id: 'summer-meetneeds', label: 'Meet your settlement needs' },
    ],
  },
  Fall: {
    title: 'The English ship has arrived. Trade wisely.',
    tasks: [
      { id: 'fall-decree', label: "Listen to the Crown's trade rules" },
      { id: 'fall-shiptrade', label: 'Trade your goods with the ship' },
      { id: 'fall-choice', label: 'Make your final choice' },
    ],
  },
  Winter: {
    title: 'See how your colony survived!',
    tasks: [
      { id: 'winter-results', label: 'Review your results' },
      { id: 'winter-reflection', label: 'Read the reflection questions' },
    ],
  },
};

/** The dynamic Summer row whose label tracks how many needs are met. */
const MEET_NEEDS_TASK = 'summer-meetneeds';

export class ObjectiveTrackerSystem extends createSystem({
  // Match our tracker panel once PanelUISystem has parsed its JSON and attached
  // the live UIKit document. Same pattern as SeasonBannerSystem / NeedsSystem.
  trackerPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  /** The loaded tracker document, captured when the panel qualifies. */
  private doc?: UIKitDocument;

  /** The phase whose objective is currently painted. */
  private currentPhase: GamePhase = gameState.currentPhase;

  /** Sub-tasks we've already animated to "done" (so the ding/pulse fires once). */
  private animatedDone = new Set<string>();

  init() {
    // (1) Build the tracker HUD on the right, below the score area. ScreenSpace
    //     pins it on the right in the browser; in XR it becomes a world panel.
    this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: PANEL_CONFIG,
        maxWidth: 1.3,
        maxHeight: 0.95,
      })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '120px',
        right: '20px',
        width: '340px',
        height: '300px',
        // Persistent HUD: sit slightly farther than the default popup depth
        // (0.2) so dialogues / decree / recap popups render in front of it.
        zOffset: 0.26,
      })
      // XR: float the objective tracker to the upper-right in front of the headset.
      .addComponent(Follower, hudFollow(this.player.head, [0.82, 0.12, -1.92]));

    // (2) When the document is ready (now or later), capture it and paint the
    //     current phase. `true` replays for an already-loaded panel.
    this.cleanupFuncs.push(
      this.queries.trackerPanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[entity.index] as
            | UIKitDocument
            | undefined;
          this.renderPhase(this.currentPhase, false);
          // Hidden on the welcome/title screen; revealed on enter-colony.
          this.setHidden(gameState.currentPhase === 'Arrival');
        },
        true,
      ),
    );

    // Reveal the tracker once the player enters the colony (matches the score +
    // inventory HUDs) so it never overlaps the centered welcome card.
    this.cleanupFuncs.push(
      arrivalSequence.onEnterColony(() => this.setHidden(false)),
    );

    // (3) Swap the objective when the phase changes. Leaving Arrival ticks the
    //     "choose your supplies" step; entering Summer schedules the orientation
    //     "check your needs" tick.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase, newPhase) => {
        if (oldPhase === 'Arrival') {
          objectiveTracker.completeSubTask('arrival-supply');
        }
        this.currentPhase = newPhase;
        this.renderPhase(newPhase, false);
        if (newPhase === 'Summer') {
          setTimeout(
            () => objectiveTracker.completeSubTask('summer-checkneeds'),
            CHECK_NEEDS_DELAY_MS,
          );
        }
      }),
    );

    // (4) Repaint whenever a sub-task completes / its progress changes. This is
    //     what fills a circle, pulses + dings, and glows the next task. On a dev
    //     reset, forget which tasks we've animated so they can ding again.
    this.cleanupFuncs.push(
      objectiveTracker.onChange((taskId) => {
        if (taskId === 'reset') this.animatedDone.clear();
        this.renderPhase(this.currentPhase, true);
      }),
    );

    // (5) Dev convenience: drive it from the console, e.g.
    //     `objectives.completeSubTask('spring-confirm')`.
    (window as unknown as Record<string, unknown>).objectives = objectiveTracker;
  }

  // ──────────────────────────────── rendering ───────────────────────────────

  /**
   * Paint the checklist for `phase`. When `animate` is true (an objective
   * actually changed), a task that just flipped to done gets a pulse + ding;
   * on a plain phase swap we paint the done state silently.
   */
  private renderPhase(phase: GamePhase, animate: boolean): void {
    if (!this.doc) return;
    const objective = OBJECTIVES[phase];

    // Header: season badge tint + phase name, and the headline objective.
    this.container('quest-badge')?.setProperties({
      backgroundColor: SEASON_ACCENT[phase],
    });
    this.text('quest-phase')?.setProperties({ text: SEASON_LABEL[phase] });
    this.text('quest-title')?.setProperties({ text: objective.title });

    // Find the first not-yet-done task — that's the one we glow as "do this next".
    const nextIndex = objective.tasks.findIndex(
      (t) => !objectiveTracker.isComplete(t.id),
    );

    for (let i = 0; i < MAX_ROWS; i++) {
      const task = objective.tasks[i];
      if (!task) {
        this.setDisplay(`quest-row-${i}`, 'none');
        continue;
      }
      this.setDisplay(`quest-row-${i}`, 'flex');

      const done = objectiveTracker.isComplete(task.id);
      this.text(`quest-label-${i}`)?.setProperties({ text: this.labelFor(task) });

      if (done) {
        const isNew = animate && !this.animatedDone.has(task.id);
        this.paintDone(i);
        if (isNew) this.celebrate(i);
        this.animatedDone.add(task.id);
      } else {
        this.paintTodo(i, i === nextIndex);
      }
    }

    // Content width/height shifts with the new text — re-fit the screen layout.
    relayoutScreenSpacePanels(this.doc);
  }

  /** The label text, with the live "x of y met" suffix for the needs row. */
  private labelFor(task: SubTask): string {
    if (task.id !== MEET_NEEDS_TASK) return task.label;
    const p = objectiveTracker.getProgress(MEET_NEEDS_TASK);
    if (!p || p.total <= 0) return task.label;
    return `${task.label} (${p.current} of ${p.total} met)`;
  }

  /** A finished row: green-filled circle with a check, dimmed label. */
  private paintDone(i: number): void {
    this.container(`quest-circle-${i}`)?.setProperties({
      backgroundColor: MET_GREEN,
      borderColor: MET_GREEN,
      borderWidth: 0.22,
    });
    // Done is shown by the green-filled circle itself; no inner glyph (the
    // bundled font has no checkmark, and a literal "x" reads as a failure mark).
    this.text(`quest-check-${i}`)?.setProperties({ text: '' });
    this.text(`quest-label-${i}`)?.setProperties({ color: LABEL_DONE });
    this.container(`quest-row-${i}`)?.setProperties({ borderColor: ROW_IDLE_BORDER });
  }

  /** A to-do row: hollow circle. If it's the next task, glow the circle + row. */
  private paintTodo(i: number, isNext: boolean): void {
    const accent = SEASON_ACCENT[this.currentPhase];
    this.container(`quest-circle-${i}`)?.setProperties({
      backgroundColor: CIRCLE_IDLE_BG,
      borderColor: isNext ? accent : CIRCLE_IDLE_BORDER,
      borderWidth: isNext ? 0.34 : 0.22,
    });
    this.text(`quest-check-${i}`)?.setProperties({ text: '' });
    this.text(`quest-label-${i}`)?.setProperties({
      color: isNext ? LABEL_NEXT : LABEL_TODO,
    });
    this.container(`quest-row-${i}`)?.setProperties({
      borderColor: isNext ? accent : ROW_IDLE_BORDER,
    });
  }

  /** The "just completed" flourish: a soft ding + a brief circle pulse. */
  private celebrate(i: number): void {
    // Soft "ding" — fire-and-forget, non-positional (reuse the existing chime).
    AudioUtils.createOneShot(this.world, '/audio/chime.mp3', {
      volume: 0.5,
      positional: false,
    });
    // Pulse: flash the circle's border bright + thick, then settle back to the
    // done style. UIKit has no transition, so we drive it with a short timer.
    const circle = this.container(`quest-circle-${i}`);
    circle?.setProperties({ borderColor: '#ffffff', borderWidth: 0.42 });
    setTimeout(() => {
      circle?.setProperties({ borderColor: MET_GREEN, borderWidth: 0.22 });
    }, 220);
  }

  // ─────────────────────────────── UI helpers ───────────────────────────────

  private setDisplay(id: string, display: 'none' | 'flex'): void {
    this.container(id)?.setProperties({ display });
  }

  /** Show/hide the whole tracker HUD by toggling its root container. */
  private setHidden(hidden: boolean): void {
    this.setDisplay('quest-root', hidden ? 'none' : 'flex');
  }

  private text(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }
}
