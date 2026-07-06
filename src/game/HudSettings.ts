/**
 * HudSettings.ts — one shared switch for the persistent dashboards.
 *
 * The always-on HUDs (score, inventory, objective tracker, settlement needs,
 * narrator callouts) are useful but, especially in a headset, they can crowd
 * the view. This module-level singleton (the same hand-rolled emitter pattern
 * as GameState/ColonyScore) holds a single `visible` flag those systems all
 * consult, so the player can tuck the whole dashboard layer away and bring it
 * back with one action:
 *
 *   - the "HUD" tab on the season banner (works on desktop AND in VR),
 *   - the H key on desktop,
 *   - the X (left) or B (right) controller button in VR.
 *
 * Each HUD system combines this flag with its own condition (phase, arrival
 * state) and re-applies visibility when the flag flips. The season banner
 * itself stays visible — it is the navigation bar and hosts the toggle.
 */

type Listener = (visible: boolean) => void;

class HudSettings {
  private _visible = true;
  private listeners = new Set<Listener>();

  /** Whether the dashboard layer should currently be shown. */
  get visible(): boolean {
    return this._visible;
  }

  /** Flip the dashboards on/off and notify every subscribed HUD system. */
  toggle(): void {
    this._visible = !this._visible;
    for (const cb of [...this.listeners]) cb(this._visible);
  }

  /** Subscribe to visibility flips. Returns an unsubscribe function. */
  onChanged(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

export const hudSettings = new HudSettings();
