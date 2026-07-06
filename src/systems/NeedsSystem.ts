/**
 * NeedsSystem.ts — the Summer "Barter & Trade" challenge for Virginia Ventures.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS PHASE TEACHES
 * ─────────────────────────────────────────────────────────────────────────
 * When Summer begins the settlement announces 2–3 pressing NEEDS (broken plow,
 * illness, low food stores, …). Each need maps to an item the student must
 * acquire by trading with the colony's NPCs. Needs they meet are crossed off;
 * needs they ignore cost the colony Food Supply when Summer ends. The hidden
 * lesson is triage under scarcity: you usually can't satisfy everything, so you
 * weigh urgency (a high-urgency miss hurts 3× a low-urgency one) against what
 * the NPCs are actually willing to trade.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW IT PLUGS INTO THE EXISTING ARCHITECTURE (nothing here is modified)
 * ─────────────────────────────────────────────────────────────────────────
 *  - gameState.onPhaseChanged → we start when the phase becomes 'Summer' and
 *    settle up (apply penalties) when it leaves 'Summer'. Same emitter the
 *    PhaseSystem and SeasonBannerSystem already listen to.
 *  - colonyScore.addFood(...) → unmet-need penalties subtract from Food Supply.
 *  - gameState.logDecision(...) → every need generated and every need met is
 *    recorded for the end-of-game review.
 *  - A PanelUI + ScreenSpace HUD panel ('./ui/settlement-needs.json', compiled
 *    from ui/settlement-needs.uikitml) shows the live checklist on the left.
 *
 * The 3D trade NPCs and the call into `fulfillNeed(...)` live in a separate
 * Summer trade system; this system owns the needs, the checklist UI, and the
 * scoring. `fulfillNeed` is the public seam between the two.
 */

import {
  AudioUtils,
  createSystem,
  Interactable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  UIKit,
  UIKitDocument,
  eq,
} from '@iwsdk/core';

import { HudAnchor } from '../ui/hudFollow.js';
import { gameState } from '../game/GameState.js';
import { hudSettings } from '../game/HudSettings.js';
import { colonyScore } from '../game/ColonyScore.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';

/** How badly a missed need stings. The student never sees these numbers. */
export type Urgency = 'high' | 'medium' | 'low';

/** The static definition of a possible need (the "pool" we draw from). */
export interface NeedDef {
  /** Player-facing sentence shown on the checklist row. */
  description: string;
  /** The item type that satisfies this need (matched by trades). */
  item: string;
  /** Drives the marker color and the size of the unmet penalty. */
  urgency: Urgency;
}

/** A need that's actually active this Summer: its definition plus met-state. */
interface ActiveNeed {
  def: NeedDef;
  isMet: boolean;
}

/**
 * THE POOL — every need that *could* appear. Summer draws a random 2–3 of these.
 * Edit/extend this list to add new needs; the rest of the system adapts.
 */
const NEED_POOL: NeedDef[] = [
  {
    description:
      'Your plow blade broke. You need iron tools from the blacksmith.',
    item: 'iron_tools',
    urgency: 'high',
  },
  {
    description: 'Illness in the settlement. You need medicinal herbs.',
    item: 'herbs',
    urgency: 'high',
  },
  {
    description: 'Your food stores are running low. You need extra corn.',
    item: 'corn',
    urgency: 'medium',
  },
  {
    description:
      'Winter is coming. You need wool blankets for your settlers.',
    item: 'blankets',
    urgency: 'medium',
  },
  {
    description: 'Your barn roof leaks. You need timber and nails.',
    item: 'timber',
    urgency: 'low',
  },
];

/** Food Supply lost per unmet need, by urgency. (high hurts most.) */
const URGENCY_PENALTY: Record<Urgency, number> = {
  high: -15,
  medium: -10,
  low: -5,
};

/** The bang/dot color for each urgency on the checklist (CSS strings). */
const URGENCY_COLOR: Record<Urgency, string> = {
  high: '#d9534f', // red
  medium: '#e3b23c', // yellow / gold
  low: '#9a8f7a', // muted gray
};

const MET_GREEN = '#5cb860'; // check + strike color
const TEXT_IDLE = '#e8dcc0'; // unmet need text
const TEXT_MET = '#8a8470'; // dimmed text once struck through

/** The HUD panel's UI config (compiled from ui/settlement-needs.uikitml). */
const PANEL_CONFIG = './ui/settlement-needs.json';

/** How many rows the .uikitml authored — our hard cap on simultaneous needs. */
const MAX_ROWS = 3;

export class NeedsSystem extends createSystem({
  // Match our needs panel once PanelUISystem has parsed its JSON and attached
  // the live UIKit document (PanelDocument). Same pattern as SeasonBannerSystem.
  needsPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  /**
   * The needs active THIS Summer. This is plain game data (not entity
   * references), so holding it on the system is fine — the "don't store entity
   * arrays" rule is about ECS entities, which these are not.
   */
  private needs: ActiveNeed[] = [];

  /** Guards against applying the unmet penalties twice (the SummerRecap and the
   *  Summer→Fall transition can both ask). Reset when a new Summer's needs roll. */
  private penaltiesApplied = false;

  /** The loaded checklist document, captured when the panel qualifies. */
  private doc?: UIKitDocument;

  init() {
    // (1) Build the checklist HUD panel. ScreenSpace pins it to the left of the
    //     screen in the browser; in XR it becomes a world-space panel. It's
    //     created hidden and only revealed during Summer (see setPanelHidden).
    this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: PANEL_CONFIG,
        maxWidth: 1.1,
        maxHeight: 0.85,
      })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '290px',
        left: '24px',
        width: '320px',
        height: '300px',
        // Persistent Summer HUD: sit slightly farther than the default popup
        // depth (0.2) so the trade panel / recap render in front of it.
        zOffset: 0.26,
      })
      // XR: float the needs checklist mid-left in front of the headset, below
      // the score HUD ([-1.15, 0.5]) and narrator banner ([-1.15, 0.02]) that
      // share the left column on desktop. Same 2.4m HUD shell.
      .addComponent(HudAnchor, { offset: [-1.15, -0.5, -2.4] });

    // Re-apply visibility when the player toggles the HUD layer.
    this.cleanupFuncs.push(hudSettings.onChanged(() => this.applyVisibility()));

    // (2) When the panel's document finishes loading (now or later), grab a
    //     reference and paint whatever state we're in. `true` replays for a
    //     panel that's already loaded by the time we subscribe.
    this.cleanupFuncs.push(
      this.queries.needsPanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.renderChecklist();
          // Only show the panel if we're already in Summer (e.g. the doc loaded
          // mid-phase); otherwise keep it hidden until Summer begins.
          this.setPanelHidden(gameState.currentPhase !== 'Summer');
        },
        true,
      ),
    );

    // (3) Drive the whole phase off the shared emitter. Entering Summer rolls a
    //     fresh set of needs; leaving Summer settles the unmet ones.
    //     NOTE ON ORDERING: index.ts registers this system BEFORE PhaseSystem so
    //     this listener runs first. That means our unmet-need penalties land on
    //     colonyScore *before* PhaseSystem records its end-of-Summer snapshot —
    //     so the snapshot correctly reflects the penalties.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase, newPhase) => {
        if (newPhase === 'Summer') {
          this.startSummer();
        } else if (oldPhase === 'Summer') {
          this.endSummer();
        }
      }),
    );

    // (4) Dev convenience: drive the system from the browser console, e.g.
    //     `needs.fulfillNeed('herbs')` or `needs.applyUnmetPenalties()`.
    (window as unknown as Record<string, unknown>).needs = this;
  }

  // ───────────────────────────── phase lifecycle ─────────────────────────────

  /** Summer begins: roll new needs, reveal the panel, log what was demanded. */
  private startSummer(): void {
    // Locked-tracker revisit: if Summer is already finished, keep the needs
    // exactly as the player left them — rolling a fresh set would wipe their
    // progress and let them re-fulfil for extra score.
    if (!gameState.hasCompletedPhase('Summer')) {
      this.generateNeeds();
    }
    this.renderChecklist();
    this.setPanelHidden(false);
  }

  /** Summer ends: apply penalties for anything still unmet, hide the panel. */
  private endSummer(): void {
    this.applyUnmetPenalties();
    this.setPanelHidden(true);
  }

  // ───────────────────────────── need generation ────────────────────────────

  /**
   * Pick a random 2–3 needs from the pool. Replay variety comes from two
   * independent rolls:
   *   1) COUNT — 2 or 3 (a coin flip), so some summers are busier than others.
   *   2) COMPOSITION — which needs, via a Fisher–Yates shuffle of the pool.
   * With a 5-need pool that's C(5,2)+C(5,3) = 10 + 10 = 20 distinct need-sets,
   * and because urgencies differ across them, the *stakes* (total penalty at
   * risk) shift run to run too. No two playthroughs feel the same, and students
   * can't memorize a single "correct" sequence of trades.
   */
  private generateNeeds(): void {
    this.penaltiesApplied = false; // a fresh Summer — penalties not yet settled
    const count = 2 + Math.floor(Math.random() * 2); // 2 or 3
    const pool = [...NEED_POOL];

    // Fisher–Yates shuffle (unbiased — every ordering equally likely).
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    this.needs = pool.slice(0, count).map((def) => ({ def, isMet: false }));

    // Objective tracker: seed the "meet your settlement needs" row's target so
    // its label reads "(0 of N met)" and completes once every need is met.
    objectiveTracker.setProgress('summer-meetneeds', 0, this.needs.length);

    for (const need of this.needs) {
      gameState.logDecision(
        `[Summer] New need (${need.def.urgency}): ${need.def.description}`,
      );
    }
  }

  // ─────────────────────────── trade integration ────────────────────────────

  /**
   * Provide an item to the settlement. Called by the Summer trade system when a
   * trade hands over goods. Marks the FIRST matching unmet need as met, crosses
   * it off the checklist, and plays a confirmation chime.
   *
   * @returns true if a need was satisfied; false if nothing needed this item.
   */
  fulfillNeed(itemType: string): boolean {
    const index = this.needs.findIndex(
      (need) => !need.isMet && need.def.item === itemType,
    );
    if (index === -1) return false;

    this.needs[index].isMet = true;
    gameState.logDecision(
      `[Summer] Need met: ${this.needs[index].def.description} (provided ${itemType})`,
    );

    this.markRowMet(index);
    this.playCheckSound();

    // Objective tracker: advance the "meet your settlement needs" count.
    const metCount = this.needs.filter((n) => n.isMet).length;
    objectiveTracker.setProgress('summer-meetneeds', metCount, this.needs.length);
    return true;
  }

  /**
   * Apply the Food Supply penalty for every need still unmet. Idempotent within
   * a Summer: both the SummerRecap and the Summer→Fall transition may call it,
   * but the penalties land only once (reset when the next Summer's needs roll).
   */
  applyUnmetPenalties(): void {
    if (this.penaltiesApplied) return;
    this.penaltiesApplied = true;
    for (const need of this.needs) {
      if (need.isMet) continue;
      const penalty = URGENCY_PENALTY[need.def.urgency];
      colonyScore.addFood(penalty);
      gameState.logDecision(
        `[Summer] Unmet need penalty ${penalty} Food Supply — ${need.def.description}`,
      );
    }
  }

  /**
   * A read-only snapshot of this Summer's needs for the recap panel: each need's
   * text, urgency, whether it was met, and the Food Supply penalty if not.
   */
  getNeedsStatus(): {
    description: string;
    urgency: Urgency;
    isMet: boolean;
    penalty: number;
  }[] {
    return this.needs.map((n) => ({
      description: n.def.description,
      urgency: n.def.urgency,
      isMet: n.isMet,
      penalty: URGENCY_PENALTY[n.def.urgency],
    }));
  }

  // ──────────────────────────────── rendering ───────────────────────────────

  /** Repaint all rows: fill the active needs, hide the unused rows. */
  private renderChecklist(): void {
    if (!this.doc) return;

    for (let i = 0; i < MAX_ROWS; i++) {
      const need = this.needs[i];
      if (!need) {
        // No need for this slot — hide the whole row.
        this.setDisplay(`need-${i}-row`, 'none');
        continue;
      }

      this.setDisplay(`need-${i}-row`, 'flex');

      // Reset to the "unmet" look (in case a row is being reused next Summer).
      const marker = this.text(`need-${i}-marker`);
      marker?.setProperties({
        text: '!',
        color: URGENCY_COLOR[need.def.urgency],
      });

      const text = this.text(`need-${i}-text`);
      text?.setProperties({ text: need.def.description, color: TEXT_IDLE });

      this.setDisplay(`need-${i}-strike`, 'none');

      // If a need is already met (e.g. re-render after fulfillment), restyle it.
      if (need.isMet) this.markRowMet(i);
    }
  }

  /** Cross a single row off: green check, dimmed text, strike line over it. */
  private markRowMet(index: number): void {
    if (!this.doc) return;

    // "Met" is shown by the green color + strike line below; no glyph marker
    // (the bundled font has no checkmark, and "x" reads as a failure mark).
    this.text(`need-${index}-marker`)?.setProperties({
      text: '',
      color: MET_GREEN,
    });
    this.text(`need-${index}-text`)?.setProperties({ color: TEXT_MET });

    // The strike "line" is an absolutely-positioned bar laid over the text —
    // UIKit has no text-decoration, so we draw the strikethrough ourselves.
    const strike = this.container(`need-${index}-strike`);
    strike?.setProperties({
      positionType: 'absolute',
      positionTop: '45%',
      positionLeft: 0,
      positionRight: 0,
      display: 'flex',
    });
  }

  // ─────────────────────────────── UI helpers ───────────────────────────────

  /** Show/hide the whole panel by toggling its root container's display. */
  /** This system's own reason to hide (any phase that isn't Summer); the
   *  player's HUD toggle is combined in applyVisibility(). */
  private ownHidden = true;

  private setPanelHidden(hidden: boolean): void {
    this.ownHidden = hidden;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const show = !this.ownHidden && hudSettings.visible;
    this.container('needs-root')?.setProperties({
      display: show ? 'flex' : 'none',
    });
  }

  private setDisplay(id: string, display: 'none' | 'flex'): void {
    this.container(id)?.setProperties({ display });
  }

  private text(id: string): UIKit.Text | undefined {
    return (this.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(id: string): UIKit.Container | undefined {
    return (
      (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined
    );
  }

  /** Play the confirmation chime as a fire-and-forget, non-positional sound. */
  private playCheckSound(): void {
    AudioUtils.createOneShot(this.world, './audio/chime.mp3', {
      volume: 0.6,
      positional: false,
    });
  }
}
