/**
 * SpringPlantingSystem.ts — the Spring planting HUD: the live crop tally and the
 * "Confirm Planting" button that ends Spring and hands the harvest to Summer.
 *
 * FarmSystem owns the 4x4 field and the grab-to-plant mechanic; this system only
 * READS the planted cells (it never changes them) to:
 *   1. Show a live Corn / Tobacco / Empty tally as the student plants.
 *   2. Keep "Confirm Planting" disabled until all 16 cells are filled.
 *   3. On confirm, apply the corn-vs-tobacco TRADEOFF and advance to Summer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW THE LIVE TALLY WORKS (reactive queries, not polling)
 * ─────────────────────────────────────────────────────────────────────────
 * Each plot is an entity with a `FarmCell` component whose `crop` field is
 * 'empty' | 'corn' | 'tobacco'. We declare three queries — one matching ALL
 * cells, one matching only cells `where crop == 'corn'`, one `where crop ==
 * 'tobacco'`. elics re-evaluates these value-filtered queries whenever a cell's
 * `crop` changes (FarmSystem calls `setValue`), firing qualify/disqualify. We
 * subscribe to those and refresh the HUD, so the tally updates the instant a
 * cell is planted or changed — no per-frame polling needed. The counts are just
 * the sizes of the query sets.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW CONFIRM TALLIES THE GRID, APPLIES THE TRADEOFF, AND HANDS OFF TO SUMMER
 * ─────────────────────────────────────────────────────────────────────────
 * On confirm (only allowed once every cell is filled — `empty === 0`):
 *   • TALLY    — corn = number of 'corn' cells, tobacco = number of 'tobacco'
 *                cells (read straight off the filtered-query sizes).
 *   • TRADEOFF — corn feeds people, tobacco earns money, so we raise the colony
 *                scores accordingly: Food += 2 x corn, Wealth += 2 x tobacco.
 *                (ColonyScore clamps each pillar to 0–100.) An all-corn field
 *                maxes Food but adds no Wealth; all-tobacco is the reverse —
 *                that's the lesson, felt rather than told.
 *   • RECORD   — store the split on GameState (cornCells/tobaccoCells) and log
 *                the decision for the end-of-game review.
 *   • HAND OFF — seed PlayerInventory from the split (corn=corn, tobacco=tobacco,
 *                plus the fixed arrival trade goods). Summer's market trades
 *                against exactly this stock.
 *   • ADVANCE  — gameState.advancePhase() flips Spring → Summer; PhaseSystem
 *                snapshots end-of-Spring scores and swaps the world over.
 */

import {
  createSystem,
  PanelDocument,
  PanelUI,
  RayInteractable,
  UIKit,
  UIKitDocument,
  eq,
  type Entity,
} from '@iwsdk/core';

import { gameState } from '../game/GameState.js';
import { colonyScore } from '../game/ColonyScore.js';
import { playerInventory } from '../game/PlayerInventory.js';
import { springProgress } from '../game/SpringProgress.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';
import { FarmCell } from './FarmSystem.js';

const PLANTING_PANEL = './ui/spring-planting.json';

/** The whole field is 16 cells — confirm unlocks only when all are planted. */
const TOTAL_CELLS = 16;

export class SpringPlantingSystem extends createSystem({
  // All plot cells, and the two value-filtered subsets that drive the tally.
  // The `where` filters re-evaluate when a cell's `crop` changes (see header).
  allCells: { required: [FarmCell] },
  cornCells: { required: [FarmCell], where: [eq(FarmCell, 'crop', 'corn')] },
  tobaccoCells: { required: [FarmCell], where: [eq(FarmCell, 'crop', 'tobacco')] },
  // The planting HUD, matched once its UIKit document has loaded.
  plantingPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PLANTING_PANEL)],
  },
}) {
  private panelEntity?: Entity;
  private doc?: UIKitDocument;

  /** Mirrors whether the field is fully planted; gates the confirm action. */
  private canConfirm = false;

  init() {
    // ── Create the planting panel, hidden until Spring ───────────────────────
    //    It's a WORLD-SPACE panel (not a screen HUD): a screen-locked HUD sits
    //    a few cm from the eye and can't be reliably ray-clicked in XR, but the
    //    Confirm button must be clickable with the controller. So we anchor it
    //    floating just past the north edge of the 4x4 field (FARM_CENTER is
    //    (-7, 12)), raised to head height and facing south toward the player who
    //    stands at the seed stump — same world-space + RayInteractable approach
    //    as the market trade panel and Thomas's dialogue.
    this.panelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: PLANTING_PANEL,
        maxWidth: 1.1,
        maxHeight: 0.85,
      })
      // RayInteractable so the Confirm button receives pointer/ray clicks.
      .addComponent(RayInteractable);
    const panel = this.panelEntity.object3D!;
    panel.position.set(-7, 2.2, 9.6); // above/just beyond the field's far edge
    panel.rotation.set(0, 0, 0); // front (+Z) faces the player to the south
    panel.visible = false;

    // ── Wire the panel once its document loads, then show it for the phase ───
    this.cleanupFuncs.push(
      this.queries.plantingPanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[entity.index] as
            | UIKitDocument
            | undefined;
          this.button('btn-confirm')?.addEventListener('click', () =>
            this.onConfirm(),
          );
          this.refresh();
          this.setPanelVisible(gameState.currentPhase === 'Spring');
        },
        true,
      ),
    );

    // ── Live tally: refresh whenever a cell becomes/stops being corn/tobacco ─
    //    (and when cells first appear). These fire as the student plants.
    for (const key of ['cornCells', 'tobaccoCells', 'allCells'] as const) {
      this.cleanupFuncs.push(
        this.queries[key].subscribe('qualify', () => this.refresh()),
      );
      this.cleanupFuncs.push(
        this.queries[key].subscribe('disqualify', () => this.refresh()),
      );
    }

    // ── Show the HUD only during Spring ──────────────────────────────────────
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((_oldPhase, newPhase) => {
        const isSpring = newPhase === 'Spring';
        this.setPanelVisible(isSpring);
        if (isSpring) this.refresh();
      }),
    );
    this.setPanelVisible(gameState.currentPhase === 'Spring');
  }

  // ────────────────────────────── live tally ────────────────────────────────

  /** Recount the field and update the tally + the confirm button's state. */
  private refresh(): void {
    const total = this.queries.allCells.entities.size;
    const corn = this.queries.cornCells.entities.size;
    const tobacco = this.queries.tobaccoCells.entities.size;
    const empty = Math.max(0, total - corn - tobacco);

    this.setText('tally-corn', `Corn: ${corn}`);
    this.setText('tally-tobacco', `Tobacco: ${tobacco}`);
    this.setText('tally-empty', `Empty: ${empty}`);

    // Confirm unlocks only once the whole field is planted.
    this.canConfirm = total >= TOTAL_CELLS && empty === 0;
    // Objective tracker: tick "plant all 16 plots" the moment the field fills
    // (idempotent — only the first full field actually fires the change event).
    if (this.canConfirm) objectiveTracker.completeSubTask('spring-plant');
    this.button('btn-confirm')?.setProperties(
      this.canConfirm
        ? { backgroundColor: '#5cb860', color: '#1f2a17', text: 'Confirm Planting' }
        : {
            backgroundColor: '#4a4036',
            color: '#8a7d68',
            text: `Confirm Planting (${empty} left)`,
          },
    );
  }

  // ───────────────────────────────── confirm ────────────────────────────────

  /** End Spring: tally → tradeoff → record → hand off to Summer → advance. */
  private onConfirm(): void {
    // Guard: ignore clicks unless we're in Spring with a fully-planted field
    // (the button is also styled disabled in that case).
    if (gameState.currentPhase !== 'Spring' || !this.canConfirm) return;
    // Locked-tracker revisit: Spring is already graded and recorded, so a second
    // confirm must not re-apply the scoring tradeoff or advance the phase again.
    if (gameState.hasCompletedPhase('Spring')) return;

    const corn = this.queries.cornCells.entities.size;
    const tobacco = this.queries.tobaccoCells.entities.size;

    // TRADEOFF — corn feeds the colony, tobacco earns trade wealth.
    colonyScore.addFood(2 * corn);
    colonyScore.addWealth(2 * tobacco);

    // RECORD — keep the split on the shared state + the decision log + objective.
    gameState.recordPlanting(corn, tobacco);
    gameState.logDecision(`Spring: planted ${corn} corn and ${tobacco} tobacco`);
    springProgress.complete('plantField');
    objectiveTracker.completeSubTask('spring-confirm');

    // HAND OFF — seed Summer's tradeable stock from the Spring harvest.
    playerInventory.initializeFromPlanting(corn, tobacco);

    // Observable confirmation line — reads the values back off GameState +
    // ColonyScore so the stored split and the applied tradeoff are verifiable.
    console.log(
      `Spring confirmed — GameState planted ${gameState.cornCells} corn, ` +
        `${gameState.tobaccoCells} tobacco; ` +
        `Food ${colonyScore.foodSupply}, Wealth ${colonyScore.tradeWealth}`,
    );

    // ADVANCE — Spring → Summer (PhaseSystem snapshots + swaps the world; our
    // phase listener hides this HUD).
    gameState.advancePhase();
  }

  // ─────────────────────────────── visibility ───────────────────────────────

  private setPanelVisible(visible: boolean): void {
    if (this.panelEntity?.object3D) this.panelEntity.object3D.visible = visible;
    this.container('plant-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
  }

  // ─────────────────────────────── doc helpers ──────────────────────────────

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
