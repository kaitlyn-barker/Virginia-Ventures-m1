/**
 * hudFollow.ts — keep a panel in front of the player's head in immersive XR.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────
 * IWSDK's ScreenSpace component head-locks a panel under the camera on DESKTOP
 * (CSS top/left/width). But the instant an XR session starts, ScreenSpaceUISystem
 * returns the panel to WORLD space at its entity Transform — which for these HUDs
 * was never positioned, so the panel lands at the world origin (or a desktop-
 * calibrated spot) and the player never sees it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY NOT THE BUILT-IN `Follower` COMPONENT
 * ─────────────────────────────────────────────────────────────────────────
 * This file used to hand out configs for the SDK's Follower. Its update runs
 * `position.lerp(target, delta * speed)` with the factor UNCLAMPED — on any
 * frame longer than `1/speed` seconds the panel overshoots its target, and a
 * run of slow frames (session start, level swap, the software-rendered
 * emulator) compounds the overshoot until panels are hundreds of metres away.
 * This system is the same idea with the lerp factor clamped to 1, plus two
 * HUD-specific improvements: offsets are applied relative to the head's YAW
 * only (looking up/down doesn't drag the whole dashboard with it), and panels
 * stay upright, yaw-billboarded to face the player.
 *
 * On DESKTOP this is a harmless no-op visually: ScreenSpace parents the
 * *visible* document under the camera, so moving the (invisible) object3D
 * changes nothing.
 *
 * Usage: `.addComponent(HudAnchor, { offset: [x, y, z] })` — head-local
 * metres, −z forward, +x right, +y up. Register HudAnchorSystem at a LATE
 * priority so it reads the final head pose of the frame (after locomotion and
 * the cinematics have written the rig).
 */

import {
  Quaternion,
  Types,
  Vector3,
  createComponent,
  createSystem,
} from '@iwsdk/core';

/** Anchors a panel at a fixed head-relative offset while in XR. */
export const HudAnchor = createComponent('HudAnchor', {
  /** Offset from the head in head-YAW-local metres (−z is forward). */
  offset: { type: Types.Vec3, default: [0, 0, -2] },
  /** Chase speed (per second) once the panel leaves its dead zone. */
  speed: { type: Types.Float32, default: 5 },
  /** Metres of drift allowed before the panel starts catching up. */
  tolerance: { type: Types.Float32, default: 0.25 },
});

export class HudAnchorSystem extends createSystem({
  anchored: { required: [HudAnchor] },
}) {
  // Scratch — allocate once (VR frame-budget rule).
  private headPos!: Vector3;
  private headQuat!: Quaternion;
  private headFwd!: Vector3;
  private desired!: Vector3;

  /** Entities currently chasing their anchor point (index → true). */
  private chasing!: Set<number>;

  init() {
    this.headPos = new Vector3();
    this.headQuat = new Quaternion();
    this.headFwd = new Vector3();
    this.desired = new Vector3();
    this.chasing = new Set();
  }

  update(delta: number) {
    const head = this.player.head;
    head.getWorldPosition(this.headPos);

    // The head's facing direction (local −Z through the world quaternion —
    // NOT getWorldDirection, whose sign flips between Camera and Object3D),
    // flattened to the ground plane → a pure yaw frame for the offsets.
    // (Full head orientation would swing the entire dashboard up/down with
    // every glance at the floor.)
    head.getWorldQuaternion(this.headQuat);
    this.headFwd.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.headFwd.y = 0;
    // Looking straight up/down leaves no horizontal component; keep the last
    // stable yaw by skipping this frame rather than snapping to a fallback.
    if (this.headFwd.lengthSq() < 1e-6) return;
    this.headFwd.normalize();
    const yaw = Math.atan2(-this.headFwd.x, -this.headFwd.z);

    for (const entity of this.queries.anchored.entities) {
      const obj = entity.object3D;
      if (!obj) continue;

      const offset = entity.getVectorView(HudAnchor, 'offset') as Float32Array;
      this.desired
        .set(offset[0], offset[1], offset[2])
        .applyAxisAngle(UP, yaw)
        .add(this.headPos);

      // Lazy, dead-zoned follow: start chasing only once the panel has
      // drifted `tolerance` metres from its spot; settle and stop again when
      // it's effectively home. This keeps HUDs steady while the player looks
      // around, without swimming on every small head movement.
      const dist = obj.position.distanceTo(this.desired);
      if (dist > entity.getValue(HudAnchor, 'tolerance')!) {
        this.chasing.add(entity.index);
      }
      if (this.chasing.has(entity.index)) {
        // THE CLAMP — `min(1, …)` is what the SDK Follower is missing: a slow
        // frame saturates at "arrive exactly" instead of overshooting.
        const t = Math.min(1, delta * entity.getValue(HudAnchor, 'speed')!);
        obj.position.lerp(this.desired, t);
        if (obj.position.distanceTo(this.desired) < 0.02) {
          this.chasing.delete(entity.index);
        }
      }

      // Stay upright, front (+Z) yaw-billboarded toward the player.
      obj.rotation.set(
        0,
        Math.atan2(this.headPos.x - obj.position.x, this.headPos.z - obj.position.z),
        0,
      );
    }
  }
}

/** World up — module-level so update() never allocates. */
const UP = new Vector3(0, 1, 0);
