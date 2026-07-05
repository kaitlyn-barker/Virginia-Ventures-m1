/**
 * IdleMotionSystem.ts — cheap "life" for the static colonist NPCs (P2.3).
 *
 * The colonists are placeholder primitive humanoids with no rigged idle clips
 * (see Colonists.ts), so they stand dead-still — which reads as a frozen diorama.
 * Motion sells a world more than mesh detail, so this system gives every tagged
 * NPC a subtle, endless idle: a gentle weight-shift sway (a couple of degrees of
 * yaw) plus a tiny breathing bob. Each NPC gets a phase offset from its entity
 * index so the crowd never moves in lockstep.
 *
 * It's deliberately tiny and allocation-free (VR frame budget): the base pose is
 * captured once into the AmbientSway component, then every frame is two sines.
 * Script-driven figures (the Captain, the Smuggler) are NOT tagged — their
 * cinematics move them, and an idle offset would fight that.
 */

import { createComponent, createSystem, Types } from '@iwsdk/core';

/**
 * Tag + per-NPC idle state. `captured` latches the base pose on the first frame
 * so the sway oscillates around wherever the NPC was placed (any scale/yaw).
 */
export const AmbientSway = createComponent('AmbientSway', {
  captured: { type: Types.Boolean, default: false },
  baseY: { type: Types.Float32, default: 0 },
  baseYaw: { type: Types.Float32, default: 0 },
});

/** Breathing bob height (metres) and its speed (rad/s). */
const BOB_AMP = 0.012;
const BOB_SPEED = 1.15;
/** Weight-shift yaw sway amplitude (radians ≈ 2.3°) and its speed (rad/s). */
const YAW_AMP = 0.04;
const YAW_SPEED = 0.5;

export class IdleMotionSystem extends createSystem({
  swayers: { required: [AmbientSway] },
}) {
  update(_delta: number, time: number): void {
    for (const entity of this.queries.swayers.entities) {
      const obj = entity.object3D;
      if (!obj) continue;

      // Capture the placed pose once, then always oscillate around it.
      if (!entity.getValue(AmbientSway, 'captured')) {
        entity.setValue(AmbientSway, 'baseY', obj.position.y);
        entity.setValue(AmbientSway, 'baseYaw', obj.rotation.y);
        entity.setValue(AmbientSway, 'captured', true);
      }
      const baseY = entity.getValue(AmbientSway, 'baseY')!;
      const baseYaw = entity.getValue(AmbientSway, 'baseYaw')!;

      // Per-NPC phase from the index so the crowd doesn't breathe in unison.
      const phase = entity.index * 0.7;
      obj.position.y = baseY + Math.sin(time * BOB_SPEED + phase) * BOB_AMP;
      obj.rotation.y =
        baseYaw + Math.sin(time * YAW_SPEED + phase * 1.3) * YAW_AMP;
    }
  }
}
