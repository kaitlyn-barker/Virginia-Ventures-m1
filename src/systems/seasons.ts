/**
 * seasons.ts — shared per-phase presentation data (labels + accent colors).
 *
 * This is plain data, not a system or component. Both the PhaseSystem (which
 * tints the per-phase scaffold markers) and the SeasonBannerSystem (which tints
 * the banner) read from here, so the season → color/label mapping lives in ONE
 * place. Change a color once and every part of the UI updates together.
 *
 * Colors come straight from the brief:
 *   Arrival = white, Spring = green, Summer = gold, Fall = orange, Winter = blue.
 */

import type { GamePhase } from '../game/GameState.js';

/**
 * Accent color per phase, as a CSS hex string. We keep it as a string because
 * UIKit's `setProperties({ color, backgroundColor })` expects CSS colors. For
 * the 3D marker meshes we convert this to a three.js Color with `new Color(hex)`.
 */
export const SEASON_ACCENT: Record<GamePhase, string> = {
  Arrival: '#f4f0e6', // near-white (parchment white) for the landing/intro
  Spring: '#5cb860', // fresh green — planting
  Summer: '#e3b23c', // warm gold — markets / peak season
  Fall: '#e07b39', // harvest orange — trading season
  Winter: '#a9d6ef', // pale ice blue — results / reflection
};

/**
 * The text shown on the banner per phase. The brief wanted a small ship/anchor
 * glyph for Arrival, but the UI font (Inter) has no ⚓ glyph and renders it as a
 * "tofu" box, so we keep plain names. Arrival's "ship" cue is carried instead by
 * its bright white accent bar (the SEASON_ACCENT color above).
 */
export const SEASON_LABEL: Record<GamePhase, string> = {
  Arrival: 'Arrival',
  Spring: 'Spring',
  Summer: 'Summer',
  Fall: 'Fall',
  Winter: 'Winter',
};
