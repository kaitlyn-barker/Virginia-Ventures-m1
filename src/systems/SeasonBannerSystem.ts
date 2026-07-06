/**
 * SeasonBannerSystem.ts — the persistent season selector banner.
 *
 * A bar of five tabs (Arrival · Spring · Summer · Fall · Winter) that appears on
 * entry and STAYS on screen the whole session. Two jobs:
 *   1) Show which season you're in — the active tab is filled with that season's
 *      accent color (Arrival white, Spring green, Summer gold, Fall orange,
 *      Winter blue); the rest stay muted.
 *   2) Let you switch — tapping a tab calls `gameState.setPhase(thatSeason)`,
 *      which drives the whole game (PhaseSystem toggles that phase's objects).
 *
 * HOW THIS HOOKS UP (Unity → web):
 *   There's no Unity Awake; a system's one-time setup is `init()`. We don't need
 *   a per-frame `update()` here at all — the bar is positioned by the ScreenSpace
 *   component (a fixed on-screen HUD), and everything else is event-driven:
 *     - When the panel's UIKit document finishes loading, we wire each tab's
 *       click handler and paint the initial highlight (the query 'qualify' event).
 *     - When the phase changes (from a tab tap here, or `advancePhase()` / a
 *       console `setPhase` anywhere else), we repaint the highlight so the bar
 *       always reflects the true current season.
 */

import {
  InputComponent,
  createComponent,
  createSystem,
  PanelDocument,
  UIKit,
  UIKitDocument,
} from '@iwsdk/core';

import { gameState, PHASE_ORDER, type GamePhase } from '../game/GameState.js';
import { hudSettings } from '../game/HudSettings.js';
import { SEASON_ACCENT } from './seasons.js';
import { sfx } from '../audio/Sfx.js';

/** Tag marking the single entity that is the season selector banner. */
export const SeasonBanner = createComponent('SeasonBanner', {});

// Tab palette for the three states of the locked progress tracker:
//   • current  — filled with the season's accent color (bright, dark text)
//   • done     — a phase you've finished and may revisit (medium parchment)
//   • locked   — a future phase you haven't unlocked yet (dim, faded)
const TAB_ACTIVE_TEXT = '#241a12'; // dark text reads well on every accent color
const TAB_DONE_BG = '#5a4730';
const TAB_DONE_TEXT = '#ecdcb6';
const TAB_LOCKED_BG = '#241c14';
const TAB_LOCKED_TEXT = '#6b5d45';

export class SeasonBannerSystem extends createSystem({
  // Match the banner only once its UIKit document has loaded (PanelDocument is
  // attached by PanelUISystem after the JSON is parsed).
  banner: { required: [SeasonBanner, PanelDocument] },
}) {
  init() {
    // (1) When the banner document is ready (now or later), wire its tab buttons
    //     and paint the current season. `true` replays for an already-loaded doc.
    this.cleanupFuncs.push(
      this.queries.banner.subscribe(
        'qualify',
        (entity) => {
          const doc = this.getDoc(entity.index);
          if (!doc) return;
          this.wireTabs(doc);
          this.refreshHighlight(doc, gameState.currentPhase);
          // The HUD tab: tucks the dashboard layer (score / inventory /
          // objectives / needs / narrator) away and brings it back. The banner
          // itself stays — it's the nav bar and hosts this very toggle.
          const hudTab = doc.getElementById('hud-toggle') as UIKit.Text | null;
          hudTab?.addEventListener('click', () => {
            sfx.click();
            hudSettings.toggle();
          });
          this.refreshHudTab(doc);
        },
        true,
      ),
    );

    // Repaint the HUD tab whenever the setting flips (from any source).
    this.cleanupFuncs.push(
      hudSettings.onChanged(() => {
        for (const entity of this.queries.banner.entities) {
          const doc = this.getDoc(entity.index);
          if (doc) this.refreshHudTab(doc);
        }
      }),
    );

    // (2) Keep the highlight in sync with the real phase, no matter what caused
    //     the change (a tab tap here, advancePhase(), or a console setPhase).
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((_oldPhase, newPhase) => {
        for (const entity of this.queries.banner.entities) {
          const doc = this.getDoc(entity.index);
          if (doc) this.refreshHighlight(doc, newPhase);
        }
      }),
    );
  }

  /** Read the loaded UIKit document off the entity (or undefined if not ready). */
  private getDoc(index: number): UIKitDocument | undefined {
    return PanelDocument.data.document[index] as UIKitDocument | undefined;
  }

  /** Attach a click handler to every season tab → switch to that phase. */
  private wireTabs(doc: UIKitDocument): void {
    for (const phase of PHASE_ORDER) {
      const tab = doc.getElementById(`season-${phase}`) as UIKit.Text | null;
      tab?.addEventListener('click', () => this.onTabClick(phase));
    }
  }

  /**
   * Handle a tab tap under the locked-progress rules:
   *   • a LOCKED (future) season can't be selected — you must finish the prior
   *     seasons in order (this is the soft-lock-proofing for young players);
   *   • the 'Arrival' intro isn't a revisitable season once you've left it;
   *   • otherwise switch to that already-reached season.
   */
  private onTabClick(phase: GamePhase): void {
    // A locked future season buzzes a gentle "not yet" instead of doing nothing,
    // so a young player gets clear feedback that they must finish in order.
    if (!gameState.isPhaseUnlocked(phase)) {
      sfx.error();
      return;
    }
    if (phase === 'Arrival' && gameState.currentPhase !== 'Arrival') return;
    if (phase === gameState.currentPhase) return; // already here — no sound
    sfx.click();
    gameState.setPhase(phase);
  }

  /**
   * Paint each tab for its state: the current season gets its bright accent; a
   * finished season gets the "done / revisit" parchment look; a not-yet-unlocked
   * season is dimmed so a young player can see, at a glance, how far they've got
   * and that future seasons are still locked.
   */
  private refreshHighlight(doc: UIKitDocument, current: GamePhase): void {
    for (const phase of PHASE_ORDER) {
      const tab = doc.getElementById(`season-${phase}`) as UIKit.Text | null;
      if (!tab) continue;
      if (phase === current) {
        tab.setProperties({
          backgroundColor: SEASON_ACCENT[phase],
          color: TAB_ACTIVE_TEXT,
          opacity: 1,
        });
      } else if (gameState.isPhaseUnlocked(phase)) {
        tab.setProperties({
          backgroundColor: TAB_DONE_BG,
          color: TAB_DONE_TEXT,
          opacity: 1,
        });
      } else {
        tab.setProperties({
          backgroundColor: TAB_LOCKED_BG,
          color: TAB_LOCKED_TEXT,
          opacity: 0.55,
        });
      }
    }
  }

  /** Paint the HUD toggle tab to show the current state at a glance. */
  private refreshHudTab(doc: UIKitDocument): void {
    const tab = doc.getElementById('hud-toggle') as UIKit.Text | null;
    tab?.setProperties({
      text: hudSettings.visible ? 'HUD: on' : 'HUD: off',
      backgroundColor: hudSettings.visible ? TAB_DONE_BG : TAB_LOCKED_BG,
      color: hudSettings.visible ? TAB_DONE_TEXT : TAB_LOCKED_TEXT,
      opacity: 1,
    });
  }

  /**
   * Keyboard / controller shortcuts for the same toggle: H on desktop, and the
   * X (left) or B (right) face button in VR — buttons the built-in locomotion
   * and grab systems don't use, so nothing else fights over them.
   */
  update(): void {
    if (this.input.keyboard.getKeyDown('KeyH')) hudSettings.toggle();
    if (
      this.input.xr.gamepads.left?.getButtonDown(InputComponent.X_Button) ||
      this.input.xr.gamepads.right?.getButtonDown(InputComponent.B_Button)
    ) {
      hudSettings.toggle();
    }
  }
}
