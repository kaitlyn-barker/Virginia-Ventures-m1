/**
 * DesktopLookSystem.ts — lets a desktop (non-XR) player TURN their view.
 *
 * Browser locomotion (features.locomotion.browserControls) gives WASD movement
 * but NO way to turn, so on desktop you can only ever face the spawn direction —
 * which makes it hard to reach or look at things off to the sides. This adds
 * keyboard turning: the ← / → arrow keys (and Q / E) smoothly yaw the player.
 *
 * We deliberately use the KEYBOARD, not mouse-look: this game is driven by mouse
 * CLICKS (clicking NPCs, buttons, plots), and pointer-lock mouse-look would
 * capture the cursor and break all of that. Arrow-key turning leaves the mouse
 * completely free to click.
 *
 * We rotate `world.player` (the rig the camera sits on), so movement stays
 * relative to where you're now facing, and the orientation carries into an XR
 * session seamlessly. Inside an XR session the headset / thumbstick own turning,
 * so this system stands down.
 */

import { createSystem } from '@iwsdk/core';

/** Turn rate in radians per second (~109°/s — brisk but not dizzying). */
const TURN_SPEED = 1.9;

export class DesktopLookSystem extends createSystem({}) {
  private turnLeft = false;
  private turnRight = false;

  private readonly onKeyDown = (e: KeyboardEvent): void => this.setKey(e, true);
  private readonly onKeyUp = (e: KeyboardEvent): void => this.setKey(e, false);

  init(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.cleanupFuncs.push(() => {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
    });
  }

  /** Track the turn keys. ArrowLeft/Q turn left; ArrowRight/E turn right. */
  private setKey(e: KeyboardEvent, down: boolean): void {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyQ':
        this.turnLeft = down;
        break;
      case 'ArrowRight':
      case 'KeyE':
        this.turnRight = down;
        break;
      default:
        return; // not a turn key — ignore (WASD etc. are handled by locomotion)
    }
    // These keys are ours; stop the page from also scrolling on the arrows.
    e.preventDefault();
  }

  update(delta: number): void {
    // In an XR session the headset / thumbstick own turning — stand down.
    if (this.renderer.xr.isPresenting) return;
    const dir = (this.turnLeft ? 1 : 0) - (this.turnRight ? 1 : 0);
    if (dir !== 0) {
      // +Y yaw turns the view left (forward −Z rotates toward −X), so a positive
      // `dir` (left key) adds +Y. Rotating the rig keeps movement view-relative.
      this.player.rotation.y += dir * TURN_SPEED * delta;
    }
  }
}
