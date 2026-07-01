/**
 * ArrivalCinematic.ts — ARRIVAL: "Welcome to the colony." (orientation tour)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS BEAT DOES
 * ─────────────────────────────────────────────────────────────────────────
 * The game opens on the welcome panel ("Virginia Ventures, 1620"). When the
 * student presses "Enter the Colony", this system takes over and plays a short
 * cinematic that INTRODUCES AND ORIENTS them to the settlement before they have
 * to do anything — the same treatment the Fall "Trade Ship" beat gets, applied
 * to the very start of the experience.
 *
 *   A 5-SHOT CAMERA TOUR (browser): we glide the camera across the colony,
 *   one landmark per shot, each a tweened move —
 *     1) the harbor + the ship that carried them across the Atlantic,
 *     2) the heart of the colony (market + common well),
 *     3) the ring of neighbors' homes,
 *     4) the open fields they'll plant in Spring,
 *     5) a settle back to the player's standing vantage, ready to begin.
 *   A TITLE-CARD CAPTION names each landmark and sets the scene, then we fire
 *   arrivalSequence.emitCinematicComplete() and hand control to the player.
 *
 * This is the direct sibling of TradeShipArrival (the Fall ship cinematic): same
 * keyframed-Shot structure, same browser/XR gate, same rig-pin trick. The only
 * differences are that nothing in the world has to move (there's no NPC walk —
 * it's a pure camera tour of static scenery) and the trigger is the welcome
 * button (arrivalSequence.onEnterColony) rather than a phase change, because the
 * game is ALREADY in 'Arrival' on boot and no phase flip occurs on the press.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BROWSER vs XR
 * ─────────────────────────────────────────────────────────────────────────
 * A scripted camera move only makes sense in flat browser mode, where
 * `world.camera` IS the viewer. In an immersive XR session the headset owns the
 * camera and we must never fight it — so when presenting in XR we skip the
 * camera work (and the rig pin) and just play the title-card captions as a
 * world-space panel while the player stands and looks around for themselves.
 *
 * To keep the browser camera math simple we PIN the player rig to the origin
 * for the duration of the tour (the camera is local to the rig, so rig-at-origin
 * means camera-local == world). Pinning each frame from this late-priority
 * system also neutralises locomotion input during the cutscene. We release the
 * lock the instant the tour ends, leaving the camera exactly at the player's
 * default standing vantage so there's no jump when control returns.
 */

import {
  Vector3,
  createSystem,
  RayInteractable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  UIKit,
  UIKitDocument,
  eq,
  type Entity,
} from '@iwsdk/core';

import { arrivalSequence } from '../game/ArrivalSequence.js';
import { gameState } from '../game/GameState.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';
import { sfx } from '../audio/Sfx.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';

const CAPTION_CONFIG = './ui/arrival-intro.json';

/**
 * The tour timeline, in seconds since "Enter the Colony" was pressed. Each entry
 * is a tweened camera move (a Shot). Captions follow the active shot.
 */
const SHOT_A_END = 5; // the harbor + the ship
const SHOT_B_END = 10; // market + common well (the colony's heart)
const SHOT_C_END = 14.5; // the neighbors' homes
const SHOT_D_END = 19; // the open fields (Spring planting)
const SHOT_E_END = 23.5; // settle to the player's standing vantage
const END = SHOT_E_END; // hand control back here

/** One keyframed shot: dolly the camera from `fromPos` to `toPos` while the
 *  look-at target slides from `fromLook` to `toLook`, over [t0, t1]. */
interface Shot {
  t0: number;
  t1: number;
  fromPos: [number, number, number];
  toPos: [number, number, number];
  fromLook: [number, number, number];
  toLook: [number, number, number];
}

/**
 * The five shots. Coordinates are world-space; because we pin the rig to the
 * origin they are also the camera's local space. Settlement layout (from
 * Settlement.ts / Colonists.ts): market (0,0), well (0,4), homes at ±(7,7),
 * barn (-6,-8), dock on x=0 (z -19…-33), ship deck ≈ (x∈[-5,5], y0.5, z≈-35.6).
 * The player's default standing vantage is (0, 2.2, 15) looking north (−Z).
 */
const SHOTS: Shot[] = [
  // Shot A — the harbor: elevated by the dock, looking north out at the moored
  // ship across the water (the vessel that carried them here), gentle push-in.
  {
    t0: 0,
    t1: SHOT_A_END,
    fromPos: [7, 5.5, -6],
    toPos: [5, 4.6, -10],
    fromLook: [0, 2.4, -30],
    toLook: [0, 2, -33],
  },
  // Shot B — the colony's heart: swing south of the dock to overlook the market
  // stall and the common well, looking south down toward them.
  {
    t0: SHOT_A_END,
    t1: SHOT_B_END,
    fromPos: [5, 4.4, -7],
    toPos: [3.4, 3.8, -3],
    fromLook: [0, 1.4, 1],
    toLook: [0, 1.1, 4],
  },
  // Shot C — the neighbors' homes: from above the path, pan the look-target
  // across the two homes flanking the village green (cabin −7,7 → house 7,7).
  {
    t0: SHOT_B_END,
    t1: SHOT_C_END,
    fromPos: [0, 3.6, 14],
    toPos: [0, 3.3, 12],
    fromLook: [-7, 1.5, 7],
    toLook: [7, 1.5, 7],
  },
  // Shot D — the fields: drift toward the open ground beyond the homes (where
  // the Spring farm grid will be), looking out to the northwest.
  {
    t0: SHOT_C_END,
    t1: SHOT_D_END,
    fromPos: [6, 4, 11],
    toPos: [4, 3.6, 9],
    fromLook: [-7, 1, 9],
    toLook: [-8.5, 1, 8.5],
  },
  // Settle — ease to the player's exact default standing vantage so there's no
  // camera jump when the lock releases and locomotion takes over.
  {
    t0: SHOT_D_END,
    t1: SHOT_E_END,
    fromPos: [4, 3.6, 9],
    toPos: [0, 2.2, 15],
    fromLook: [-8.5, 1, 8.5],
    toLook: [0, 1.6, 0],
  },
];

/** Title-card caption per shot (parallel to SHOTS). Plain hyphens only — the
 *  UIKit MSDF font lacks an em-dash glyph (renders as a box). */
interface Caption {
  title: string;
  body: string;
}
const CAPTIONS: Caption[] = [
  {
    title: 'A New World',
    body: 'After a long voyage across the Atlantic, your ship reaches the shores of Virginia. The year is 1620 - welcome to your new home.',
  },
  {
    title: 'The Heart of the Colony',
    body: 'At its center lie the market and the common well, where settlers gather to trade their goods and draw their water.',
  },
  {
    title: 'Your Neighbors',
    body: 'Homes ring the village green. Your neighbors have already cleared the land and raised their houses - you are not alone out here.',
  },
  {
    title: 'The Fields',
    body: "Open ground waits beyond the homes. Come Spring, you'll plant your crops here to feed the colony through the year.",
  },
  {
    title: 'Your Venture Begins',
    body: "Four seasons lie ahead - plant, trade, and keep the Crown's favor. Every choice has its cost. Choose \"Spring\" below when you're ready to begin.",
  },
];

export class ArrivalCinematic extends createSystem({
  // Our title-card caption panel, matched once its UIKit document loads.
  captionPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', CAPTION_CONFIG)],
  },
}) {
  /** The caption panel + its loaded document. */
  private captionEntity?: Entity;
  private captionDoc?: UIKitDocument;

  /** True from "Enter the Colony" until the tour finishes; gates the per-frame work. */
  private running = false;
  /** Seconds since the tour began (drives the whole timeline). */
  private clock = 0;
  /** Guards the one-shot complete emit. */
  private completeEmitted = false;
  /** Which caption shot is currently shown (avoids re-setting text every frame; -1 = none). */
  private shownShot = -1;

  // Scratch vectors — allocate once, never per frame (VR frame-budget rule).
  private camPos!: Vector3;
  private camLook!: Vector3;
  private fromV!: Vector3;
  private toV!: Vector3;

  init() {
    this.camPos = new Vector3();
    this.camLook = new Vector3();
    this.fromV = new Vector3();
    this.toV = new Vector3();

    // Lower-center title card (becomes a world-space panel in XR). Sits above the
    // season banner. Hidden until the tour starts.
    this.captionEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: CAPTION_CONFIG, maxWidth: 1.6, maxHeight: 1.1 })
      .addComponent(RayInteractable)
      .addComponent(ScreenSpace, {
        // Tall enough that the title + body + the "Skip Tour" button all get
        // real estate (the panel is contain-scaled, so more box = bigger button).
        bottom: '16%',
        left: '15vw',
        width: '70vw',
        height: '34%',
      });
    this.captionEntity.object3D!.visible = false;

    // Grab the caption document when it loads; keep it hidden.
    this.cleanupFuncs.push(
      this.queries.captionPanel.subscribe(
        'qualify',
        (entity) => {
          this.captionDoc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          // Wire the "Skip Tour" button so an impatient player can jump in.
          (this.captionDoc?.getElementById('intro-skip') as UIKit.Text | null)
            ?.addEventListener('click', () => this.skip());
          this.setCaptionVisible(false);
        },
        true,
      ),
    );

    // Trigger: the welcome panel's "Enter the Colony" button (via PanelSystem).
    this.cleanupFuncs.push(
      arrivalSequence.onEnterColony(() => this.startTour()),
    );

    // Robust keyboard skip (Space / Esc): a bulletproof fallback that doesn't
    // depend on raycasting the moving caption card, so an impatient desktop
    // player can always get into the colony.
    const onSkipKey = (e: KeyboardEvent): void => {
      if (this.running && (e.code === 'Space' || e.code === 'Escape')) {
        e.preventDefault();
        this.skip();
      }
    };
    window.addEventListener('keydown', onSkipKey);
    this.cleanupFuncs.push(() =>
      window.removeEventListener('keydown', onSkipKey),
    );
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Skip the orientation tour (the "Skip Tour" caption button) — jump straight
   *  to the end so an impatient player gets into the colony immediately. */
  private skip(): void {
    if (!this.running) return;
    sfx.click();
    // Same finish path the tour reaches naturally; `browser` mirrors update().
    this.finish(!this.renderer.xr.isPresenting);
  }

  private startTour(): void {
    if (this.running) return; // ignore re-presses while the tour plays
    this.clock = 0;
    this.running = true;
    this.completeEmitted = false;
    this.shownShot = -1;
    this.setCaptionVisible(false);
    console.log('[Arrival] Entering the colony - orientation tour begins.');
  }

  // ──────────────────────────────── per frame ────────────────────────────────

  update(delta: number) {
    if (!this.running) return;

    // "Flat" = not inside an immersive XR session. We drive the camera/rig only
    // here; in a real headset session the device owns the camera and we leave it
    // alone. `renderer.xr.isPresenting` is the reliable signal — it is false in
    // flat browser AND in the IWER emulator preview (whose visibilityState still
    // reports "visible", so that flag can't be used here).
    const browser = !this.renderer.xr.isPresenting;

    // Pin the rig to the origin so (a) the camera math stays in world space and
    // (b) locomotion can't move the player mid-tour. Browser only — in XR the
    // headset owns the rig and we must not yank it.
    if (browser) {
      this.player.position.set(0, 0, 0);
      this.player.quaternion.identity();
    }

    this.clock += delta;
    const t = this.clock;

    if (t >= END) {
      this.finish(browser);
      return;
    }

    // ── Camera (browser only) ─────────────────────────────────────────────
    if (browser) {
      const idx = this.shotIndexAt(t);
      const shot = SHOTS[idx];
      const p = clamp01((t - shot.t0) / (shot.t1 - shot.t0));
      this.lerpArr(shot.fromPos, shot.toPos, p, this.camPos);
      this.lerpArr(shot.fromLook, shot.toLook, p, this.camLook);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
    }

    // ── Title-card caption ────────────────────────────────────────────────
    // A short beat at the very start with no caption, then one card per shot.
    if (t < 0.6) {
      this.showCaption(-1);
    } else {
      this.showCaption(this.shotIndexAt(t));
    }
  }

  /** Wrap up: hide the caption, drop the rig lock, hand control back. */
  private finish(browser: boolean): void {
    this.running = false;
    this.showCaption(-1);
    if (browser) {
      // Leave the camera exactly at the player's standing vantage (= the settle
      // shot's end pose) so locomotion picks up seamlessly.
      this.camera.position.set(0, 2.2, 15);
      this.camLook.set(0, 1.6, 0);
      this.camera.lookAt(this.camLook);
    }
    if (!this.completeEmitted) {
      this.completeEmitted = true;
      console.log('[Arrival] Orientation tour complete - control returned to the player.');
      objectiveTracker.completeSubTask('arrival-watch');
      arrivalSequence.emitCinematicComplete();
      // The orientation tour is the end of the Arrival intro, so carry the
      // player into Spring — which unlocks the Spring tab in the locked progress
      // tracker. (The Spring banner tab used to make this jump; with locked
      // progression the cinematic itself leads into the first season.)
      if (gameState.currentPhase === 'Arrival') gameState.advancePhase();
    }
  }

  // ──────────────────────────────── helpers ──────────────────────────────────

  /** Index of the shot whose window contains `t` (clamped to the last shot). */
  private shotIndexAt(t: number): number {
    for (let i = 0; i < SHOTS.length; i++) {
      if (t >= SHOTS[i].t0 && t < SHOTS[i].t1) return i;
    }
    return SHOTS.length - 1;
  }

  /** Show the caption for shot `idx` (title + body); idx < 0 hides it. Only
   *  re-touches the DOM when the shot actually changes. */
  private showCaption(idx: number): void {
    if (idx === this.shownShot) return;
    this.shownShot = idx;
    if (idx < 0) {
      this.setCaptionVisible(false);
      return;
    }
    const cap = CAPTIONS[idx];
    this.setText('intro-title', cap.title);
    this.setText('intro-body', cap.body);
    this.setCaptionVisible(true);
  }

  private setCaptionVisible(visible: boolean): void {
    if (this.captionEntity?.object3D)
      this.captionEntity.object3D.visible = visible;
    this.container('intro-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    // NB: pass NO document here. The caption is shown once per shot and carries
    // the interactive "Skip Tour" button; the per-panel detach refit would keep
    // briefly removing it from the scene graph and make the button unclickable.
    // The caption is small + fixed, so the lightweight nudge is enough.
    if (visible) relayoutScreenSpacePanels();
  }

  private text(id: string): UIKit.Text | undefined {
    return (this.captionDoc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(id: string): UIKit.Container | undefined {
    return (
      (this.captionDoc?.getElementById(id) as UIKit.Container | null) ?? undefined
    );
  }

  private setText(id: string, value: string): void {
    this.text(id)?.setProperties({ text: value });
  }

  /** Lerp two [x,y,z] tuples into `out` (no allocation). */
  private lerpArr(
    a: [number, number, number],
    b: [number, number, number],
    p: number,
    out: Vector3,
  ): void {
    this.fromV.set(a[0], a[1], a[2]);
    this.toV.set(b[0], b[1], b[2]);
    out.copy(this.fromV).lerp(this.toV, p);
  }
}

/** Clamp to [0,1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
