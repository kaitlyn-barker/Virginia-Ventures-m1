/**
 * SettingsSystem.ts — the in-VR Comfort & Settings panel (P1 accessibility).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * A classroom of 5th graders in headsets needs comfort controls a kid (or the
 * teacher) can reach without touching code. IWSDK's LocomotionSystem already
 * supports teleport, smooth-slide, and snap/smooth turning — this system just
 * surfaces those as friendly buttons and flips the engine config live:
 *
 *   • Moving   → Teleport (comfort: no continuous motion) vs. Free Move (slide).
 *                Teleport is the default; both always allow the teleport arc,
 *                "Free Move" additionally enables thumbstick sliding in XR.
 *   • Turning  → Snap (discrete 45° steps, comfort default) vs. Smooth.
 *   • Sound    → mutes every procedural cue (sfx.setMuted) + the ambient bed.
 *   • Narrator → toggles on-screen narrator callouts (read by other systems).
 *   • Text     → S/M/L world-space panel scale (readability in the headset).
 *
 * The choices live in the gameSettings singleton (persisted to localStorage), so
 * a kid who switches to teleport mid-lesson keeps it across a tab reload.
 *
 * DESKTOP NOTE: on the flat browser we never disable sliding, so WASD keeps
 * working regardless of the "Moving" choice — teleport-only comfort is an XR
 * concern (there's no vection on a monitor). We re-apply whenever the player
 * enters/leaves an immersive session.
 */

import {
  createSystem,
  RayInteractable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  Follower,
  UIKit,
  UIKitDocument,
  LocomotionSystem,
  TurningMethod,
  VisibilityState,
  eq,
  type Entity,
} from '@iwsdk/core';

import { gameSettings } from '../game/GameSettings.js';
import { gameState } from '../game/GameState.js';
import { SeasonBanner } from './SeasonBannerSystem.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';
import { hudFollow } from '../ui/hudFollow.js';
import { sfx } from '../audio/Sfx.js';

const PANEL_CONFIG = './ui/settings.json';

/** Option-button ids grouped by setting, for painting the active highlight. */
const GROUPS = {
  loco: ['set-loco-teleport', 'set-loco-free'],
  turn: ['set-turn-snap', 'set-turn-smooth'],
  sound: ['set-sound-on', 'set-sound-off'],
  narr: ['set-narr-on', 'set-narr-off'],
  text: ['set-text-S', 'set-text-M', 'set-text-L'],
} as const;

const ACTIVE_BG = '#d4af37'; // gold accent (matches HUD)
const ACTIVE_TEXT = '#241a12';
const IDLE_BG = '#3a2e22';
const IDLE_TEXT = '#cbb78f';

export class SettingsSystem extends createSystem({
  settingsPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PANEL_CONFIG)],
  },
  banner: { required: [SeasonBanner, PanelDocument] },
}) {
  private doc?: UIKitDocument;
  private panelEntity?: Entity;
  private open = false;
  /** The thumbstick slide speed to restore for "Free Move" (captured at init). */
  private freeSlideSpeed = 5;
  /** True while the player is in an immersive XR session (not the flat browser). */
  private immersive = false;

  init() {
    // Remember the engine's default slide speed so "Free Move" restores it
    // exactly (rather than hard-coding a number that could drift from the SDK).
    const loco = this.world.getSystem(LocomotionSystem);
    if (loco) this.freeSlideSpeed = loco.config.slidingSpeed.value || 5;

    // Centered dark HUD card, hidden until the banner's Settings tab opens it.
    this.panelEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: PANEL_CONFIG,
        maxWidth: 1.5,
        maxHeight: 1.5,
      })
      .addComponent(RayInteractable)
      .addComponent(ScreenSpace, {
        top: '10%',
        left: '30vw',
        width: '40vw',
        height: '80%',
        // Sit at 0.19 — in front of the HUDs (0.26) and default popups (0.2) so
        // its buttons win the pointer when open, but a hair BEHIND the Royal
        // Decree's Continue (0.18). This centered panel overlaps the decree's
        // region, and even while hidden it must never tie the decree at 0.18 and
        // risk stealing its click; keeping the decree the sole owner of 0.18
        // restores the pre-Settings behavior.
        zOffset: 0.19,
      })
      // XR: keep the card in front of the headset (no-op on desktop ScreenSpace).
      .addComponent(Follower, hudFollow(this.world.player.head, [0, 0, -1.4]));
    this.panelEntity.object3D!.visible = false;

    // Wire the panel's buttons + paint the initial highlights once it loads.
    this.cleanupFuncs.push(
      this.queries.settingsPanel.subscribe(
        'qualify',
        (entity) => {
          this.doc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          this.wirePanel();
          this.refresh();
          this.setVisible(false);
        },
        true,
      ),
    );

    // Wire the "Settings" tab on the season banner to open/close this panel.
    this.cleanupFuncs.push(
      this.queries.banner.subscribe(
        'qualify',
        (entity) => {
          const doc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          (doc?.getElementById('settings-open') as UIKit.Text | null)
            ?.addEventListener('click', () => this.toggle());
        },
        true,
      ),
    );

    // Track immersive vs. flat so "Moving" only gates sliding inside XR.
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        this.immersive = state !== VisibilityState.NonImmersive;
        this.applyLocomotion();
      }),
    );

    // Auto-close on any phase change: a settings panel left open would otherwise
    // linger (centered) over the next scene — including modals like the Royal
    // Decree — and could compete for the pointer. Closing it here keeps the
    // decree/dialog the sole interactive layer at its depth.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged(() => {
        if (this.open) this.setVisible(false);
      }),
    );

    // Apply persisted settings on boot, and re-apply + repaint on every change.
    // subscribe() fires immediately with the current snapshot, so this is also
    // where the saved teleport/snap/mute choices get pushed into the engine.
    this.cleanupFuncs.push(
      gameSettings.subscribe(() => {
        sfx.setMuted(gameSettings.current.muted);
        this.applyLocomotion();
        this.applyTextScale();
        this.refresh();
      }),
    );
  }

  // ──────────────────────────────── open / close ─────────────────────────────

  private toggle(): void {
    this.open = !this.open;
    sfx.click();
    this.setVisible(this.open);
    if (this.open) this.refresh();
  }

  private setVisible(visible: boolean): void {
    this.open = visible;
    if (this.panelEntity?.object3D)
      this.panelEntity.object3D.visible = visible;
    this.container('settings-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    if (visible) {
      this.applyTextScale();
      relayoutScreenSpacePanels(this.doc);
    }
  }

  // ──────────────────────────────── wiring ───────────────────────────────────

  private wirePanel(): void {
    this.onClick('set-loco-teleport', () =>
      gameSettings.setLocomotionMode('teleport'),
    );
    this.onClick('set-loco-free', () =>
      gameSettings.setLocomotionMode('free'),
    );
    this.onClick('set-turn-snap', () => gameSettings.setTurnMode('snap'));
    this.onClick('set-turn-smooth', () => gameSettings.setTurnMode('smooth'));
    this.onClick('set-sound-on', () => gameSettings.setMuted(false));
    this.onClick('set-sound-off', () => gameSettings.setMuted(true));
    this.onClick('set-narr-on', () => gameSettings.setNarration(true));
    this.onClick('set-narr-off', () => gameSettings.setNarration(false));
    this.onClick('set-text-S', () => gameSettings.setTextSize('S'));
    this.onClick('set-text-M', () => gameSettings.setTextSize('M'));
    this.onClick('set-text-L', () => gameSettings.setTextSize('L'));
    this.onClick('settings-close', () => {
      sfx.click();
      this.setVisible(false);
    });
  }

  /** Attach a click handler that plays the UI click and runs `fn`. */
  private onClick(id: string, fn: () => void): void {
    (this.doc?.getElementById(id) as UIKit.Text | null)?.addEventListener(
      'click',
      () => {
        sfx.click();
        fn();
      },
    );
  }

  // ──────────────────────────────── apply ────────────────────────────────────

  /** Push the current movement/turn settings into the live locomotion engine. */
  private applyLocomotion(): void {
    const loco = this.world.getSystem(LocomotionSystem);
    if (!loco) return;
    const s = gameSettings.current;
    loco.config.turningMethod.value =
      s.turnMode === 'snap' ? TurningMethod.SnapTurn : TurningMethod.SmoothTurn;
    // Teleport-only comfort disables continuous sliding — but ONLY in an
    // immersive session. On the flat browser we always keep sliding so the
    // WASD keys still move the player.
    const allowSlide = !this.immersive || s.locomotionMode === 'free';
    loco.config.slidingSpeed.value = allowSlide ? this.freeSlideSpeed : 0;
  }

  /** Scale the settings card by the chosen text size (world-space / XR effect). */
  private applyTextScale(): void {
    const obj = this.panelEntity?.object3D;
    if (obj) obj.scale.setScalar(gameSettings.textScale());
  }

  // ──────────────────────────────── highlight ────────────────────────────────

  /** Repaint every option group so the active choice reads as selected (gold). */
  private refresh(): void {
    if (!this.doc) return;
    const s = gameSettings.current;
    this.paint(GROUPS.loco, `set-loco-${s.locomotionMode}`);
    this.paint(GROUPS.turn, `set-turn-${s.turnMode}`);
    this.paint(GROUPS.sound, s.muted ? 'set-sound-off' : 'set-sound-on');
    this.paint(GROUPS.narr, s.narration ? 'set-narr-on' : 'set-narr-off');
    this.paint(GROUPS.text, `set-text-${s.textSize}`);
  }

  private paint(ids: readonly string[], activeId: string): void {
    for (const id of ids) {
      const btn = this.doc?.getElementById(id) as UIKit.Text | null;
      if (!btn) continue;
      const active = id === activeId;
      btn.setProperties({
        backgroundColor: active ? ACTIVE_BG : IDLE_BG,
        color: active ? ACTIVE_TEXT : IDLE_TEXT,
      });
    }
  }

  // ──────────────────────────────── doc helpers ──────────────────────────────

  private container(id: string): UIKit.Container | undefined {
    return (this.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }
}
