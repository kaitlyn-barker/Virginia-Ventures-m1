/**
 * SmugglingChoice.ts — Fall, STEP 4: "The Smuggling Choice."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LESSON: colonial frustration with mercantilism (and its risk)
 * ─────────────────────────────────────────────────────────────────────────
 * Having just felt the Crown's tax and price spread (Step 3), the player is
 * offered the historical temptation: an illegal Dutch buyer who pays MORE (15
 * gold/tobacco) with NO tax. This is exactly why colonists chafed under the
 * Navigation Acts and why smuggling was rampant — the rules left real money on
 * the table.
 *
 * But smuggling carried real danger, so the choice is a genuine risk/reward:
 *   - SMUGGLE: big Trade Wealth (+5/tobacco) but a flat -20 Crown Reputation for
 *     the disloyalty, AND a 30% chance the Crown finds out (another -10 + a stern
 *     rebuke). High ceiling, real downside.
 *   - REFUSE: no profit, but +5 Crown Reputation for staying loyal. Safe.
 * There is no "correct" answer — it trades the colony's wealth against the
 * Crown's favour, which is the whole Fall tension distilled into one decision.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STAGING
 * ─────────────────────────────────────────────────────────────────────────
 * Triggered by fallSequence.onTradingComplete. The Captain walks back up the
 * gangplank; a 3s pause; then the Smuggler NPC (built in Colonists.ts near the
 * shore) slips up to the player. These placeholder colonists have no walk clip,
 * so we glide them. TradeShipArrival is still holding the dock camera framing, so
 * all of this plays in shot; we only move NPCs here, never the camera/rig.
 */

import {
  Vector3,
  createSystem,
  RayInteractable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  Transform,
  UIKit,
  UIKitDocument,
  eq,
  type Entity,
} from '@iwsdk/core';

import { HudAnchor } from '../ui/hudFollow.js';
import { gameState } from '../game/GameState.js';
import { colonyScore } from '../game/ColonyScore.js';
import { playerInventory } from '../game/PlayerInventory.js';
import { fallSequence } from '../game/FallSequence.js';
import { fallProgress } from '../game/FallProgress.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';
import { narrator } from '../game/Narrator.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';
import { sfx } from '../audio/Sfx.js';
import { CAPTAIN_SPOT, CAPTAIN_GANGPLANK_TOP } from './TradeShipArrival.js';

const SMUGGLER_CONFIG = './ui/smuggler.json';
const DUTCH_CONFIG = './ui/dutch-trade.json';

const CAPTAIN_NAME = 'Captain Whitmore';
const SMUGGLER_NAME = 'Smuggler';

/** Where the Smuggler stops, just in front of the player (who is at the held
 *  dialogue view ≈ (0,1.7,-7) looking north). */
const APPROACH_TARGET = new Vector3(1.5, 0, -10);

/** Cinematic timeline (seconds since onTradingComplete). */
const CAPTAIN_WALK_END = 3.5; // Captain walks back up the gangplank
const PAUSE_END = 6.5; // beat
const APPROACH_END = 9.5; // Smuggler reaches the player → show the pitch

/** The toe of the gangplank: north of here the Captain is stepping up onto the
 *  deck (y rises 0 → 0.5). South of it he is on the flat dock (y = 0). */
const GANGPLANK_TOE_Z = CAPTAIN_GANGPLANK_TOP.z + 0.5; // -32.9

/** Economics + scoring (the brief). */
const DUTCH_PRICE = 15;
const SMUGGLE_WEALTH_PER = 5;
const SMUGGLE_REP_PENALTY = -20;
const DISCOVERY_REP_PENALTY = -10;
const REFUSE_REP = 5;
const DISCOVERY_CHANCE = 30; // out of 100

/** Spoken outcome lines. */
const LINE_REFUSE =
  'The Smuggler: "Your loss, friend. But I respect an honest colonist."';
const LINE_SAFE = 'The Smuggler: "Smooth as silk. They will never know."';
const LINE_CAUGHT =
  'Captain Whitmore: "We have received word of unauthorized trading. The Crown is most displeased, colonist."';

export class SmugglingChoice extends createSystem({
  npcCandidates: { required: [Transform] },
  smugglerPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', SMUGGLER_CONFIG)],
  },
  dutchPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', DUTCH_CONFIG)],
  },
}) {
  private captain?: Entity;
  private smuggler?: Entity;

  private smugDoc?: UIKitDocument;
  private dutchDoc?: UIKitDocument;
  private smugEntity?: Entity;
  private dutchEntity?: Entity;

  /** Cinematic state. */
  private active = false; // walking/approach cinematic running
  private clock = 0;
  private pitchShown = false;
  private smugglerStart!: Vector3; // where the Smuggler began (captured at begin)

  /** Dutch deal state. */
  private dutchTobacco = 0;

  // Scratch (allocate once).
  private posV!: Vector3;

  init() {
    this.posV = new Vector3();
    this.smugglerStart = new Vector3();

    // ── Smuggler pitch modal (centered), hidden until the encounter ─────────
    this.smugEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: SMUGGLER_CONFIG, maxWidth: 1.7, maxHeight: 1.1 })
      .addComponent(RayInteractable)
      .addComponent(ScreenSpace, {
        top: '24%',
        left: '20vw',
        width: '60vw',
        height: '52%',
      })
      // XR: center the pitch in front of the headset (its Transform is never
      // positioned, so without this it would land at the world origin).
      .addComponent(HudAnchor, { offset: [0, 0, -1.7] });
    this.smugEntity.object3D!.visible = false;

    // ── Dutch trade panel (centered), hidden until Choice A ─────────────────
    this.dutchEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: DUTCH_CONFIG, maxWidth: 1.3, maxHeight: 1.0 })
      .addComponent(RayInteractable)
      .addComponent(ScreenSpace, {
        top: '26%',
        left: '28vw',
        width: '44vw',
        height: '48%',
      })
      // XR: the Dutch deal replaces the pitch (they never show together), a
      // touch nearer so it reads as the follow-up step.
      .addComponent(HudAnchor, { offset: [0, 0, -1.6] });
    this.dutchEntity.object3D!.visible = false;

    // Wire the smuggler panel.
    this.cleanupFuncs.push(
      this.queries.smugglerPanel.subscribe(
        'qualify',
        (entity) => {
          this.smugDoc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.button(this.smugDoc, 'btn-smuggle')?.addEventListener('click', () =>
            this.onSmuggle(),
          );
          this.button(this.smugDoc, 'btn-refuse')?.addEventListener('click', () =>
            this.onRefuse(),
          );
          this.button(this.smugDoc, 'smug-continue')?.addEventListener('click', () =>
            this.onContinue(),
          );
          this.setVisible(this.smugEntity, this.smugDoc, 'smug-root', false);
        },
        true,
      ),
    );

    // Wire the Dutch panel.
    this.cleanupFuncs.push(
      this.queries.dutchPanel.subscribe(
        'qualify',
        (entity) => {
          this.dutchDoc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.button(this.dutchDoc, 'dutch-tobacco')?.addEventListener('click', () =>
            this.onDutchCycle(),
          );
          this.button(this.dutchDoc, 'dutch-deal')?.addEventListener('click', () =>
            this.onDutchDeal(),
          );
          this.setVisible(this.dutchEntity, this.dutchDoc, 'dutch-root', false);
        },
        true,
      ),
    );

    // Find the Captain and the Smuggler by name (replays for NPCs already built).
    this.cleanupFuncs.push(
      this.queries.npcCandidates.subscribe(
        'qualify',
        (entity) => {
          const name = entity.object3D?.name;
          if (name === CAPTAIN_NAME && !this.captain) this.captain = entity;
          else if (name === SMUGGLER_NAME && !this.smuggler) {
            this.smuggler = entity;
            // The Smuggler stays HIDDEN until his Step-4 approach (he is lurking
            // "near the dock"). Hidden from boot through Spring/Summer/Fall
            // arrival — he only reveals himself when he slips up to the player.
            if (entity.object3D) entity.object3D.visible = false;
          }
        },
        true,
      ),
    );

    // Step 3 → Step 4: begin once legal trading is finished.
    this.cleanupFuncs.push(fallSequence.onTradingComplete(() => this.begin()));

    // Safety: stop + hide if we leave Fall.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase) => {
        if (oldPhase === 'Fall') this.stopEncounter();
      }),
    );
  }

  // ───────────────────────────── cinematic start ─────────────────────────────

  private begin(): void {
    if (gameState.currentPhase !== 'Fall') return;
    this.clock = 0;
    this.active = true;
    this.pitchShown = false;
    this.dutchTobacco = 0;
    // Capture the Smuggler's current spot so he walks from wherever he stands,
    // and keep him hidden until the approach reveals him.
    if (this.smuggler?.object3D) {
      this.smugglerStart.copy(this.smuggler.object3D.position);
      this.smuggler.object3D.visible = false;
    }
    this.setVisible(this.smugEntity, this.smugDoc, 'smug-root', false);
    this.setVisible(this.dutchEntity, this.dutchDoc, 'dutch-root', false);
    console.log('[Fall] Legal trading done - the Captain departs, a smuggler approaches.');
  }

  private stopEncounter(): void {
    this.active = false;
    this.setVisible(this.smugEntity, this.smugDoc, 'smug-root', false);
    this.setVisible(this.dutchEntity, this.dutchDoc, 'dutch-root', false);
    // The Smuggler goes back into hiding once Fall ends.
    if (this.smuggler?.object3D) this.smuggler.object3D.visible = false;
  }

  update(delta: number) {
    if (!this.active) return;
    this.clock += delta;
    const t = this.clock;

    // (1) Captain walks back up the gangplank, facing north (yaw π).
    const capObj = this.captain?.object3D;
    if (capObj) {
      const p = clamp01(t / CAPTAIN_WALK_END);
      const z = lerp(CAPTAIN_SPOT.z, CAPTAIN_GANGPLANK_TOP.z, p);
      const y = z <= GANGPLANK_TOE_Z ? 0.5 * clamp01((GANGPLANK_TOE_Z - z) / 0.5) : 0;
      capObj.position.set(0, y, z);
      capObj.rotation.set(0, Math.PI, 0);
    }

    // (2) After the pause, the Smuggler reveals himself and slips up to the
    //     player, facing them. (Hidden until this moment — see begin().)
    const smugObj = this.smuggler?.object3D;
    if (smugObj && t >= PAUSE_END) {
      smugObj.visible = true;
      const p = clamp01((t - PAUSE_END) / (APPROACH_END - PAUSE_END));
      this.posV.copy(this.smugglerStart).lerp(APPROACH_TARGET, p);
      smugObj.position.copy(this.posV);
      // Face the player (held view ≈ z=-7 on the x=0 axis).
      const yaw = Math.atan2(0 - this.posV.x, -7 - this.posV.z);
      smugObj.rotation.set(0, yaw, 0);
    }

    // (3) Smuggler has arrived → present the pitch, end the cinematic.
    if (t >= APPROACH_END && !this.pitchShown) {
      this.pitchShown = true;
      this.active = false;
      this.showPitch();
    }
  }

  // ─────────────────────────────── the choice ────────────────────────────────

  private showPitch(): void {
    // Pitch text is authored in markup; just (re)assert the visible state.
    this.setDisplay(this.smugDoc, 'smug-choices', true);
    this.setDisplay(this.smugDoc, 'smug-outcome', false);
    this.setDisplay(this.smugDoc, 'smug-continue', false);
    this.setVisible(this.smugEntity, this.smugDoc, 'smug-root', true);
  }

  /** Choice B — refuse. Safe, +5 Crown Reputation. */
  private onRefuse(): void {
    sfx.click();
    colonyScore.addReputation(REFUSE_REP);
    fallProgress.recordSmuggling('refused', 0);
    gameState.logDecision('[Fall] Player refused smuggling - stayed loyal to the Crown');
    console.log('Player refused smuggling — stayed loyal to the Crown');
    narrator.say(
      'You obeyed the Crown and turned the smuggler away. The King trusts your colony more — but you passed up the Dutch silver that could have grown your wealth.',
      'crown',
    );
    this.showOutcome(LINE_REFUSE);
  }

  /** Choice A — smuggle. Open the simplified Dutch trade panel. */
  private onSmuggle(): void {
    sfx.click();
    this.dutchTobacco = 0;
    this.setVisible(this.smugEntity, this.smugDoc, 'smug-root', false);
    this.refreshDutch();
    this.setVisible(this.dutchEntity, this.dutchDoc, 'dutch-root', true);
  }

  // ─────────────────────────────── Dutch trade ───────────────────────────────

  /** Cycle how much tobacco to smuggle (0 → owned → 0). */
  private onDutchCycle(): void {
    sfx.click();
    const owned = playerInventory.getItemCount('tobacco');
    this.dutchTobacco = (this.dutchTobacco + 1) % (owned + 1);
    this.refreshDutch();
  }

  /** Conclude the illegal deal: sell the tobacco, apply scores, roll discovery. */
  private onDutchDeal(): void {
    sfx.coin();
    const n = this.dutchTobacco;
    if (n > 0) playerInventory.removeItems('tobacco', n);

    // Reward: lucrative, untaxed Dutch silver.
    if (n > 0) colonyScore.addWealth(SMUGGLE_WEALTH_PER * n);
    // Cost: choosing to defy the Crown is a flat reputation hit.
    colonyScore.addReputation(SMUGGLE_REP_PENALTY);

    // Risk: a 30% chance the Crown discovers the unauthorized trade.
    const roll = Math.floor(Math.random() * 100);
    const discovered = roll < DISCOVERY_CHANCE;
    if (discovered) colonyScore.addReputation(DISCOVERY_REP_PENALTY);

    fallProgress.recordSmuggling(discovered ? 'smuggled-caught' : 'smuggled-safe', n);
    const tag = discovered ? 'discovered' : 'not discovered';
    gameState.logDecision(
      `[Fall] Player chose to smuggle tobacco - ${tag} (sold ${n} to the Dutch for ${n * DUTCH_PRICE} gold, no tax).`,
    );
    console.log(`Player chose to smuggle tobacco — ${tag}`);

    // Tradeoff callout (P2.4): name the wealth-vs-Crown cost in plain words.
    if (n > 0) {
      narrator.say(
        discovered
          ? 'You sold to the Dutch for more gold — but the Crown found out. Defying the King cost your colony dearly in his eyes.'
          : 'You sold to the Dutch for more gold and got away with it. Your wealth grew — but breaking the Crown\'s rules lowered the King\'s trust in your colony.',
        'crown',
      );
    }

    // Back to the smuggler card for the outcome line.
    this.setVisible(this.dutchEntity, this.dutchDoc, 'dutch-root', false);
    this.showOutcome(discovered ? LINE_CAUGHT : LINE_SAFE);
  }

  private refreshDutch(): void {
    const owned = playerInventory.getItemCount('tobacco');
    this.setText(this.dutchDoc, 'dutch-owned', `Your tobacco: x${owned}`);
    this.setText(
      this.dutchDoc,
      'dutch-tobacco',
      `Smuggle: ${this.dutchTobacco} / ${owned} tobacco`,
    );
    this.setText(
      this.dutchDoc,
      'dutch-value',
      `You receive: ${this.dutchTobacco * DUTCH_PRICE} gold`,
    );
  }

  // ─────────────────────────────── resolution ────────────────────────────────

  /** Show the spoken outcome + a Continue button on the smuggler card. */
  private showOutcome(line: string): void {
    this.setDisplay(this.smugDoc, 'smug-choices', false);
    this.setText(this.smugDoc, 'smug-outcome', line);
    this.setDisplay(this.smugDoc, 'smug-outcome', true);
    this.setDisplay(this.smugDoc, 'smug-continue', true);
    this.setVisible(this.smugEntity, this.smugDoc, 'smug-root', true);
  }

  /** Continue → Step 5 (and TradeShipArrival releases the camera hold). */
  private onContinue(): void {
    sfx.click();
    this.setVisible(this.smugEntity, this.smugDoc, 'smug-root', false);
    objectiveTracker.completeSubTask('fall-choice');
    fallSequence.emitSmugglingComplete();
  }

  // ─────────────────────────────── doc helpers ───────────────────────────────

  private setVisible(
    entity: Entity | undefined,
    doc: UIKitDocument | undefined,
    rootId: string,
    visible: boolean,
  ): void {
    if (entity?.object3D) entity.object3D.visible = visible;
    this.container(doc, rootId)?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    if (visible) relayoutScreenSpacePanels(doc);
  }

  private setDisplay(
    doc: UIKitDocument | undefined,
    id: string,
    show: boolean,
  ): void {
    this.container(doc, id)?.setProperties({ display: show ? 'flex' : 'none' });
  }

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

/** Clamp to [0,1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Scalar linear interpolation. */
function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}
