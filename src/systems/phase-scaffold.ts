/**
 * phase-scaffold.ts — TEMPORARY placeholder objects for the phase system.
 *
 * The brief's phase groups (ArrivalSequence, farm plot, market stalls, trade
 * ship, WinterScene, …) don't exist as entities yet — they get built in later
 * milestones. To prove the state machine works TODAY, this file drops one small
 * floating marker per phase, each tagged with `PhaseObject`, in a row above the
 * path. Switch phases and exactly one marker is visible at a time.
 *
 * This is dev scaffolding, NOT real game content: when the actual per-phase
 * objects are authored, tag THEM with `PhaseObject` (the exact same one line)
 * and delete this file + its call in index.ts. The PhaseSystem won't change.
 */

import {
  BoxGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  type World,
} from '@iwsdk/core';

import { PHASE_ORDER, type GamePhase } from '../game/GameState.js';
import { SEASON_ACCENT } from './seasons.js';
import { PhaseObject } from './PhaseSystem.js';

/** Build the five debug markers and tag each with its phase. */
export function buildPhaseScaffold(world: World): void {
  PHASE_ORDER.forEach((phase: GamePhase, i: number) => {
    // A small cube tinted with the season's accent color so it's easy to tell
    // which phase is currently active just by looking.
    const mesh = new Mesh(
      new BoxGeometry(0.5, 0.5, 0.5),
      new MeshStandardMaterial({
        color: new Color(SEASON_ACCENT[phase]),
        roughness: 0.8,
      }),
    );
    // Name it so it's easy to find in the ECS inspector / scene tree.
    mesh.name = `PhaseMarker:${phase}`;
    // Spread the five markers left-to-right, floating above the central path so
    // they're visible from the player's starting viewpoint and clear of buildings.
    mesh.position.set((i - 2) * 1.1, 3.2, 11);

    const entity = world.createTransformEntity(mesh);
    // The one line that "registers" this entity with the phase state machine.
    entity.addComponent(PhaseObject, { phase });
  });
}
