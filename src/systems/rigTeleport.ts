/**
 * rigTeleport.ts — teleport the player rig THROUGH the locomotion engine.
 *
 * Writing `player.position` directly only moves the rig for one frame: with
 * `locomotion: { useWorker: true }` the Locomotor engine keeps its own
 * authoritative copy of the player position and pushes it onto the rig every
 * frame, so a raw write is silently overwritten on the next tick (the
 * cinematics get away with per-frame pinning only because they re-write at a
 * later priority every single frame). For a one-shot move that must STICK —
 * the XR tour vantages, the tour's final standing spot, the Fall dock seat —
 * the move has to go through `locomotor.teleport()`, exactly like the
 * player's own teleport marker does.
 *
 * `locomotor` is a private field on LocomotionSystem (private only at the
 * TypeScript level), so we reach it with a narrow structural cast rather than
 * forking the SDK. If the field ever disappears the call degrades to a no-op
 * and the caller's direct rig write still gives the old one-frame behavior.
 */

import { LocomotionSystem, Vector3 } from '@iwsdk/core';

import type { World } from '@iwsdk/core';

const target = new Vector3();

export function teleportRig(world: World, x: number, z: number): void {
  const system = world.getSystem(LocomotionSystem) as unknown as
    | { locomotor?: { teleport(position: Vector3): void } }
    | undefined;
  target.set(x, 0, z);
  system?.locomotor?.teleport(target);
}
