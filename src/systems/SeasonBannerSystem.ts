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
  createComponent,
  createSystem,
  PanelDocument,
  UIKit,
  UIKitDocument,
} from '@iwsdk/core';

import { gameState, PHASE_ORDER, type GamePhase } from '../game/GameState.js';
import { SEASON_ACCENT } from './seasons.js';

/** Tag marking the single entity that is the season selector banner. */
export const SeasonBanner = createComponent('SeasonBanner', {});

// Muted (inactive) tab colors; the active tab is painted with SEASON_ACCENT.
const TAB_IDLE_BG = '#3a2e22';
const TAB_IDLE_TEXT = '#cbb78f';
const TAB_ACTIVE_TEXT = '#241a12'; // dark text reads well on every accent color

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
        },
        true,
      ),
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
      // Tapping a tab IS the season switch — the same call a console
      // `game.setPhase('Summer')` would make. setPhase ignores a tap on the
      // season you're already in, so re-tapping the active tab is harmless.
      tab?.addEventListener('click', () => gameState.setPhase(phase));
    }
  }

  /** Fill the active season's tab with its accent color; mute all the others. */
  private refreshHighlight(doc: UIKitDocument, current: GamePhase): void {
    for (const phase of PHASE_ORDER) {
      const tab = doc.getElementById(`season-${phase}`) as UIKit.Text | null;
      if (!tab) continue;
      if (phase === current) {
        tab.setProperties({
          backgroundColor: SEASON_ACCENT[phase],
          color: TAB_ACTIVE_TEXT,
        });
      } else {
        tab.setProperties({
          backgroundColor: TAB_IDLE_BG,
          color: TAB_IDLE_TEXT,
        });
      }
    }
  }
}
