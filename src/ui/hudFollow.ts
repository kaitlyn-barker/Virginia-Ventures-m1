/**
 * hudFollow.ts — make a persistent ScreenSpace HUD panel usable in immersive XR.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────
 * IWSDK's ScreenSpace component head-locks a panel under the camera on DESKTOP
 * (CSS top/left/width). But the instant an XR session starts, ScreenSpaceUISystem
 * returns the panel to WORLD space at its entity Transform — which for these HUDs
 * is calibrated for the flat-browser camera (≈ z 15). The XR rig spawns at the
 * origin, so the panel ends up behind the headset and the player never sees it.
 *
 * THE FIX
 * ─────────────────────────────────────────────────────────────────────────
 * Attach the built-in `Follower` component, targeting the headset (player.head).
 * In XR the panel's object3D is kept a fixed distance in front of the head (a
 * lazy, dead-zoned follow so it doesn't swim with every glance). On DESKTOP this
 * is a harmless no-op: ScreenSpace parents the *visible* document under the
 * camera, so moving the (invisible) object3D changes nothing.
 *
 * Pass the player's head and an offset in head-local metres (−z is forward,
 * +x right, +y up). `addComponent(Follower, hudFollow(this.player.head, [...]))`.
 */

import { FollowBehavior, type Object3D } from '@iwsdk/core';

/** Shared follow tuning for every HUD panel (lazy, comfortable, faces the player). */
export function hudFollow(target: Object3D, offset: [number, number, number]) {
  return {
    target,
    offsetPosition: offset,
    // FaceTarget (not PivotY) so vertical offsets are preserved — PivotY flattens
    // every panel to eye height, which would stack the whole HUD in one line.
    behavior: FollowBehavior.FaceTarget,
    speed: 5, // lerp toward the target spot
    tolerance: 0.25, // metres of slack before catching up
    maxAngle: 14, // degrees of head turn before it re-centres
  };
}
