/**
 * TradeShipDeparture.ts — Fall, STEP 5: "Departure & Fall Recap."
 *
 * The smuggler beat is done, so the trading vessel weighs anchor and leaves. The
 * Captain's parting words depend on how the colony treated the Crown this season
 * — high Crown Reputation earns a warm farewell, low earns a threat — which is
 * the payoff for every tax-paying / rule-following / smuggling decision the
 * player made in Steps 3-4. Then a recap panel tallies the season and, on
 * Continue, advances the game to Winter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A CAMERA "DISTANT SHOT" RATHER THAN SAILING THE SHIP
 * ─────────────────────────────────────────────────────────────────────────
 * Same reason as the arrival (see TradeShipArrival): the ship is a primitive
 * Group and its gangplank + deck sailors are SEPARATE static entities, so
 * sliding the ship away would strand them. Instead we pull the camera up and
 * back into a high, distant shot so the whole waterfront recedes — the "fade it
 * to a distant shot" option the brief allows — and the narrative ("the ship
 * disappears over the horizon") carries the rest.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW SCORES CARRY FORWARD
 * ─────────────────────────────────────────────────────────────────────────
 * Nothing resets between phases. colonyScore is a session-long singleton, so the
 * Food / Wealth / Crown-Reputation values the player leaves Fall with are exactly
 * what Winter inherits. We snapshot the score at end-of-Fall here (and PhaseSystem
 * also records it on the phase change) so the final results screen can show each
 * season's standing side by side.
 */

import {
  Vector3,
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
import { colonyScore, type ScoreSnapshot } from '../game/ColonyScore.js';
import { fallSequence } from '../game/FallSequence.js';
import { fallProgress } from '../game/FallProgress.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';

const PANEL_CONFIG = './ui/fall-summary.json';

/** Export net prices (after tax) + display names — must match ShipTrading. */
const EXPORT_PRICE: Record<string, number> = { tobacco: 8, corn: 3, trade_goods: 5 };
const EXPORT_NAME: Record<string, string> = {
  tobacco: 'Tobacco',
  corn: 'Corn',
  trade_goods: 'Trade Goods',
};

/** Import prices + display names — must match ShipTrading. */
const IMPORT_PRICE: Record<string, number> = {
  iron_tools: 12,
  blankets: 8,
  books: 6,
  luxury: 15,
};
const IMPORT_NAME: Record<string, string> = {
  iron_tools: 'Iron Tools',
  blankets: 'Cloth/Blankets',
  books: 'Books/Paper',
  luxury: 'Luxury Goods',
};

/** The 15-gold Dutch price (untaxed) — for the smuggling recap line. */
const DUTCH_PRICE = 15;

/** Departure camera move: from the dock dialogue view up to a high distant shot. */
const DEP_DURATION = 10; // seconds
const DEP_FROM_POS: [number, number, number] = [0, 1.7, -7];
const DEP_FROM_LOOK: [number, number, number] = [0, 1, -15];
const DEP_TO_POS: [number, number, number] = [0, 22, 28];
const DEP_TO_LOOK: [number, number, number] = [0, 0, -32];

/** When (seconds into departure) the recap panel appears over the pull-out. */
const SUMMARY_AT = 1.4;

/** The Fall → Winter transition narrative (verbatim from the brief). */
const NARRATIVE =
  'The ship disappears over the horizon as the first frost settles on Virginia. Winter is coming, and your decisions will determine whether your colony thrives or merely survives.';

const PILLARS: { key: keyof ScoreSnapshot; id: string; label: string }[] = [
  { key: 'foodSupply', id: 'sum-food', label: 'Food Supply' },
  { key: 'tradeWealth', id: 'sum-wealth', label: 'Trade Wealth' },
  { key: 'crownReputation', id: 'sum-rep', label: 'Crown Reputation' },
];

export class TradeShipDeparture extends createSystem({
  summaryPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
}) {
  private doc?: UIKitDocument;
  private panelEntity?: Entity;

  /** Driving the departure pull-out + holding the view until Continue. */
  private active = false;
  private clock = 0;
  private summaryShown = false;

  // Scratch (allocate once).
  private camPos!: Vector3;
  private camLook!: Vector3;
  private fromV!: Vector3;
  private toV!: Vector3;

  init() {
    this.camPos = new Vector3();
    this.camLook = new Vector3();
    this.fromV = new Vector3();
    this.toV = new Vector3();

    // Centered recap modal, hidden until the ship departs.
    this.panelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: PANEL_CONFIG, maxWidth: 1.8, maxHeight: 1.6 })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '12%',
        left: '24vw',
        width: '52vw',
        height: '76%',
      });
    this.panelEntity.object3D!.visible = false;

    // Capture the doc + wire Continue when the panel loads.
    this.cleanupFuncs.push(
      this.queries.summaryPanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.button('sum-continue')?.addEventListener('click', () =>
            this.onContinue(),
          );
          this.setVisible(false);
        },
        true,
      ),
    );

    // Step 4 → Step 5: the smuggler beat is resolved, the ship departs.
    this.cleanupFuncs.push(fallSequence.onSmugglingComplete(() => this.begin()));

    // Safety: stop if we leave Fall by any other route.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase) => {
        if (oldPhase === 'Fall') {
          this.active = false;
          this.setVisible(false);
        }
      }),
    );
  }

  // ───────────────────────────── departure cinematic ─────────────────────────

  private begin(): void {
    if (gameState.currentPhase !== 'Fall') return;
    this.clock = 0;
    this.active = true;
    this.summaryShown = false;
    console.log('[Fall] The trade ship departs - presenting the Fall recap.');
  }

  update(delta: number) {
    if (!this.active) return;
    this.clock += delta;

    // Pull the camera up and back into a distant shot (browser only; in XR the
    // headset owns the camera). Pin the rig so the pull-out math stays in world
    // space and locomotion can't fight it.
    if (!this.renderer.xr.isPresenting) {
      this.player.position.set(0, 0, 0);
      this.player.quaternion.identity();
      const p = smoothstep(clamp01(this.clock / DEP_DURATION));
      this.lerpArr(DEP_FROM_POS, DEP_TO_POS, p, this.camPos);
      this.lerpArr(DEP_FROM_LOOK, DEP_TO_LOOK, p, this.camLook);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
    }

    // Bring up the recap a beat into the pull-out.
    if (!this.summaryShown && this.clock >= SUMMARY_AT) {
      this.summaryShown = true;
      this.render();
      this.setVisible(true);
      this.logSummary();
    }
  }

  // ──────────────────────────────── rendering ────────────────────────────────

  private render(): void {
    if (!this.doc) return;

    // ── Captain's farewell, chosen by CURRENT Crown Reputation ──────────────
    // The same Crown-Reputation pillar the player has been raising (by paying tax
    // / following rules) or wrecking (by smuggling) now decides the goodbye.
    this.setText('sum-farewell', this.farewellLine());

    // ── Legitimate trade with the Crown ─────────────────────────────────────
    const sold = fallProgress.getSold();
    const bought = fallProgress.getBought();
    const exportGold = this.basketGold(sold, EXPORT_PRICE);
    const importGold = this.basketGold(bought, IMPORT_PRICE);

    const soldStr = this.formatBasket(sold, EXPORT_NAME);
    const boughtStr = this.formatBasket(bought, IMPORT_NAME);
    this.setText(
      'sum-exports',
      soldStr === '-'
        ? 'Exports sold: none'
        : `Exports sold: ${soldStr}  (+${exportGold} gold)`,
    );
    this.setText(
      'sum-imports',
      boughtStr === '-'
        ? 'Imports bought: none'
        : `Imports bought: ${boughtStr}  (-${importGold} gold)`,
    );
    this.setText('sum-tax', `Crown tax paid: ${fallProgress.getTotalTaxPaid()} gold`);

    // ── Smuggling section (only if the player engaged the smuggler) ─────────
    this.renderSmuggling();

    // ── Per-pillar Fall score changes (start-of-Fall → now) ─────────────────
    const start =
      fallProgress.getStartScore() ??
      colonyScore.phaseSnapshots.Summer ??
      colonyScore.getScoreSnapshot();
    const now = colonyScore.getScoreSnapshot();
    for (const { key, id, label } of PILLARS) {
      const from = Math.round(start[key]);
      const to = Math.round(now[key]);
      const d = to - from;
      const sign = d >= 0 ? '+' : '';
      this.setText(id, `${label}: ${from} -> ${to}  (${sign}${d})`);
    }

    this.setText('sum-narrative', NARRATIVE);
  }

  private renderSmuggling(): void {
    const outcome = fallProgress.getSmugglingOutcome();
    const n = fallProgress.getTobaccoToDutch();
    const gold = n * DUTCH_PRICE;

    let line: string;
    if (outcome === 'refused') {
      line = 'You refused the Dutch smuggler and stayed loyal to the Crown (+5 Crown Reputation).';
    } else if (outcome === 'smuggled-safe') {
      line = `Smuggled ${n} tobacco to the Dutch for ${gold} gold, untaxed. Undetected - Crown Reputation -20.`;
    } else if (outcome === 'smuggled-caught') {
      line = `Smuggled ${n} tobacco to the Dutch for ${gold} gold, untaxed. DISCOVERED - Crown Reputation -30 (caught!).`;
    } else {
      // 'none' — the smuggler never made his pitch; hide the whole section.
      this.setDisplay('sum-smuggle-title', false);
      this.setDisplay('sum-smuggle', false);
      return;
    }
    this.setDisplay('sum-smuggle-title', true);
    this.setDisplay('sum-smuggle', true);
    this.setText('sum-smuggle', line);
  }

  /** The Captain's farewell, by Crown Reputation tier (the brief's thresholds). */
  private farewellLine(): string {
    const rep = colonyScore.crownReputation;
    if (rep >= 70)
      return 'Captain Whitmore: "The Crown is pleased with your colony. We shall return in spring with favorable terms."';
    if (rep >= 40)
      return 'Captain Whitmore: "Your colony is... adequate. We expect better next season."';
    return 'Captain Whitmore: "The Crown is displeased. Do not test our patience, colonist."';
  }

  // ─────────────────────────────── continue → Winter ─────────────────────────

  private onContinue(): void {
    this.active = false;
    this.setVisible(false);
    // Snapshot end-of-Fall, then advance. The score is a session singleton, so
    // these exact pillar values carry straight into Winter.
    colonyScore.recordPhaseSnapshot('Fall');
    gameState.advancePhase(); // Fall → Winter
  }

  // ─────────────────────────────── logging ───────────────────────────────────

  private logSummary(): void {
    const sold = this.formatBasket(fallProgress.getSold(), EXPORT_NAME);
    const bought = this.formatBasket(fallProgress.getBought(), IMPORT_NAME);
    gameState.logDecision(
      `[Fall] Recap: sold ${sold}; bought ${bought}; Crown tax ${fallProgress.getTotalTaxPaid()} gold; smuggling ${fallProgress.getSmugglingOutcome()}; Crown Reputation ${Math.round(colonyScore.crownReputation)}.`,
    );
  }

  // ─────────────────────────────── small helpers ─────────────────────────────

  /** Total gold of a {good: qty} basket using the given price table. */
  private basketGold(basket: Record<string, number>, price: Record<string, number>): number {
    let g = 0;
    for (const [k, q] of Object.entries(basket)) g += (price[k] ?? 0) * q;
    return g;
  }

  /** "8 Tobacco, 2 Corn" from a {good: qty} basket (or "-" if empty). */
  private formatBasket(basket: Record<string, number>, names: Record<string, string>): string {
    const parts = Object.entries(basket)
      .filter(([, q]) => q > 0)
      .map(([k, q]) => `${q} ${names[k] ?? k}`);
    return parts.length ? parts.join(', ') : '-';
  }

  private lerpArr(
    a: [number, number, number],
    b: [number, number, number],
    p: number,
    out: Vector3,
  ): void {
    this.fromV.set(a[0], a[1], a[2]);
    this.toV.set(b[0], b[1], b[2]);
    out.copy(this.fromV).lerp(this.toV, p);
  }

  private setVisible(visible: boolean): void {
    if (this.panelEntity?.object3D) this.panelEntity.object3D.visible = visible;
    this.container('sum-root')?.setProperties({ display: visible ? 'flex' : 'none' });
    if (visible) relayoutScreenSpacePanels();
  }

  private setDisplay(id: string, show: boolean): void {
    this.container(id)?.setProperties({ display: show ? 'flex' : 'none' });
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

/** Clamp to [0,1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smoothstep easing (ease-in-out) for a gentler camera pull-out. */
function smoothstep(p: number): number {
  return p * p * (3 - 2 * p);
}
