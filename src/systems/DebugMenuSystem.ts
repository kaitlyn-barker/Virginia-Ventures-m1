/**
 * DebugMenuSystem.ts — a DEV-ONLY test menu for playtesting the whole arc.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A DEBUG MENU MATTERS (and why it must never ship)
 * ─────────────────────────────────────────────────────────────────────────
 * Virginia Ventures is a long, linear simulation: Arrival → Spring → Summer →
 * Fall → Winter, with planting, trading, a decree, smuggling, and a results
 * dashboard gating each other in sequence. To test the *end* of that chain
 * (say, the Winter results screen) you'd otherwise have to replay the entire
 * thing by hand every time — minutes per attempt, and easy to get into a state
 * you can't reproduce. A debug menu collapses that to one click: jump straight
 * to any phase with sane seed data, nudge each score, or reset. It's the same
 * idea as a Unity "cheat panel" you'd wrap in `#if UNITY_EDITOR` so it compiles
 * into editor/test builds but is stripped from the shipping player.
 *
 * The web equivalent of `#if UNITY_EDITOR` is Vite's `import.meta.env.DEV`:
 *   - In `vite dev` (and the IWER emulator) it is `true`.
 *   - In `vite build` it is replaced with the literal `false`, so the
 *     `if (import.meta.env.DEV)` guard in index.ts becomes `if (false)` and
 *     Rollup tree-shakes this entire module (and the dynamic import that loads
 *     it) out of the production bundle. The menu, its UI JSON, and this code
 *     simply do not exist in a shipped build — no key combo can summon it.
 *
 * Toggle: the backquote/grave key (`).  We read it via the engine's stateful
 * keyboard (`this.input.keyboard.getKeyDown('Backquote')`) rather than a raw DOM
 * listener so it lives inside the ECS frame and is torn down with the system.
 */

import {
  Interactable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  UIKit,
  UIKitDocument,
  createSystem,
  eq,
  type Entity,
} from '@iwsdk/core';

import { gameState, type GamePhase } from '../game/GameState.js';
import { colonyScore } from '../game/ColonyScore.js';
import { playerInventory } from '../game/PlayerInventory.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';

const MENU_CONFIG = './ui/debug-menu.json';

/** Sensible seed data applied right before jumping to each phase. */
type Seed = () => void;

/**
 * Per-phase test seeds. Each runs BEFORE setPhase so the phase's systems wake up
 * to a believable mid-game state (the inventory/scores they expect to read).
 */
const PHASE_SEEDS: Record<Exclude<GamePhase, 'Arrival'>, Seed> = {
  // Spring is the planting phase itself — start it clean (no harvest yet).
  Spring: () => {
    playerInventory.reset();
    gameState.recordPlanting(0, 0);
  },
  // Summer barter expects a stocked harvest: 8 corn, 8 tobacco, +3 arrival
  // trade goods (initializeFromPlanting always re-seeds trade_goods to 3).
  Summer: () => {
    gameState.recordPlanting(8, 8);
    playerInventory.initializeFromPlanting(8, 8);
  },
  // Fall trading needs goods to sell too — reuse the Summer harvest.
  Fall: () => {
    gameState.recordPlanting(8, 8);
    playerInventory.initializeFromPlanting(8, 8);
  },
  // Winter only shows consequences — drive the three final scores to a spread
  // that lands in a mid band (Food 60 / Wealth 55 / Rep 50).
  Winter: () => {
    setScores(60, 55, 50);
  },
};

/** Drive the three pillars to absolute targets using the clamped add* API. */
function setScores(food: number, wealth: number, rep: number): void {
  colonyScore.addFood(food - colonyScore.foodSupply);
  colonyScore.addWealth(wealth - colonyScore.tradeWealth);
  colonyScore.addReputation(rep - colonyScore.crownReputation);
}

export class DebugMenuSystem extends createSystem({
  menuPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', MENU_CONFIG)],
  },
}) {
  private menuEntity?: Entity;
  private menuDoc?: UIKitDocument;
  private open = false;

  init() {
    // Top-right test panel. Created hidden; the backquote key toggles it.
    this.menuEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: MENU_CONFIG, maxWidth: 0.9, maxHeight: 1.1 })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: '16px',
        right: '16px',
        width: '320px',
        height: 'auto',
        // Dev tool sits closest to the camera (smaller zOffset than the 0.2
        // popups and 0.26 HUD) so it overlays everything when toggled on.
        zOffset: 0.12,
      });
    this.menuEntity.object3D!.visible = false;

    this.cleanupFuncs.push(
      this.queries.menuPanel.subscribe(
        'qualify',
        (entity) => {
          this.menuDoc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.wireButtons();
          this.refresh();
          // Apply the initial hidden state to the document too.
          this.applyVisibility();
        },
        true,
      ),
    );

    // Keep the live readouts current no matter what changes the state.
    this.cleanupFuncs.push(
      colonyScore.onScoreChanged(() => this.refresh()),
    );
    this.cleanupFuncs.push(
      gameState.onPhaseChanged(() => this.refresh()),
    );

    console.log('[DEBUG] Test menu ready - press ` (backquote) to toggle.');
  }

  update() {
    // Toggle on the rising edge of the backquote key.
    if (this.input.keyboard.getKeyDown('Backquote')) {
      this.open = !this.open;
      this.applyVisibility();
      if (this.open) this.refresh();
      console.log(`[DEBUG] Test menu ${this.open ? 'opened' : 'closed'}.`);
    }
  }

  // ─────────────────────────────── wiring ───────────────────────────────

  private wireButtons(): void {
    const doc = this.menuDoc;
    if (!doc) return;

    // Skip-to-phase: seed test data first, then flip the phase.
    (['Spring', 'Summer', 'Fall', 'Winter'] as const).forEach((phase) => {
      this.button(`skip-${phase}`)?.addEventListener('click', () =>
        this.skipTo(phase),
      );
    });

    // Score nudges (+10 each, clamped 0–100 by ColonyScore).
    this.button('add-food')?.addEventListener('click', () => {
      colonyScore.addFood(10);
      console.log('[DEBUG] +10 Food');
    });
    this.button('add-wealth')?.addEventListener('click', () => {
      colonyScore.addWealth(10);
      console.log('[DEBUG] +10 Wealth');
    });
    this.button('add-rep')?.addEventListener('click', () => {
      colonyScore.addReputation(10);
      console.log('[DEBUG] +10 Reputation');
    });

    // Full reset back to a fresh Arrival start.
    this.button('dbg-reset')?.addEventListener('click', () => {
      gameState.resetGame();
      colonyScore.reset();
      playerInventory.reset();
      console.log('[DEBUG] Game reset to a fresh Arrival start.');
    });
  }

  private skipTo(phase: Exclude<GamePhase, 'Arrival'>): void {
    PHASE_SEEDS[phase]();
    // Dev tool: unlock the target first so setPhase allows the forward jump
    // (normal play gates ahead-of-progress phases behind advancePhase()).
    gameState.unlockThrough(phase);
    gameState.setPhase(phase);
    console.log(`DEBUG: Skipped to ${phase}`);
  }

  // ───────────────────────────── presentation ─────────────────────────────

  private applyVisibility(): void {
    if (this.menuEntity?.object3D) this.menuEntity.object3D.visible = this.open;
    (this.menuDoc?.getElementById('debug-root') as UIKit.Container | null)
      ?.setProperties({ display: this.open ? 'flex' : 'none' });
    if (this.open) relayoutScreenSpacePanels(this.menuDoc);
  }

  /** Repaint the phase label + the three live score boxes + prosperity. */
  private refresh(): void {
    if (!this.menuDoc) return;
    this.setText('dbg-phase', `Phase: ${gameState.currentPhase}`);
    this.setText('dbg-food', `Food ${Math.round(colonyScore.foodSupply)}`);
    this.setText('dbg-wealth', `Wealth ${Math.round(colonyScore.tradeWealth)}`);
    this.setText('dbg-rep', `Rep ${Math.round(colonyScore.crownReputation)}`);
    this.setText(
      'dbg-prosperity',
      `Prosperity ${Math.round(colonyScore.prosperityScore)} (${colonyScore.getScoreGrade()})`,
    );
  }

  private button(id: string): UIKit.Text | undefined {
    return (this.menuDoc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private setText(id: string, value: string): void {
    (this.menuDoc?.getElementById(id) as UIKit.Text | null)?.setProperties({
      text: value,
    });
  }
}
