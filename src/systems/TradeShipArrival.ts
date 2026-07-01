/**
 * TradeShipArrival.ts — Fall, STEP 1: "The Trade Ship arrives."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS BEAT DOES
 * ─────────────────────────────────────────────────────────────────────────
 * The instant the game enters the Fall phase, an English trading vessel makes
 * its entrance and Captain Whitmore comes ashore to address the colony. We
 * deliver that as a short cinematic, then hand off to the Royal Decree (Step 2).
 *
 *   1) A 3-SHOT CAMERA SEQUENCE (browser): a wide of the river + ship, a closer
 *      shot of the deck/sailors, then a medium on the gangplank as the Captain
 *      descends — each a tweened camera move.
 *   2) THE CAPTAIN WALKS down the gangplank to a speaking spot on the dock path
 *      (we reposition the existing 'Captain Whitmore' NPC — these placeholder
 *      colonists carry no animation clips, so there is no walk clip to play; we
 *      just glide him along the path, as the brief allows).
 *   3) HIS DIALOGUE plays as two subtitle lines, then we fire
 *      fallSequence.emitArrivalComplete() so RoyalDecreeSystem can take over.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A CAMERA SEQUENCE INSTEAD OF SAILING THE SHIP
 * ─────────────────────────────────────────────────────────────────────────
 * The brief offers a choice: animate the docked ship out and back, OR "if it
 * can't be moved, play a camera sequence instead." The ship in Waterfront.ts is
 * an unnamed primitive Group, and — crucially — the gangplank, the moored
 * bollards, and the sailors standing on its deck are SEPARATE static entities
 * positioned around the docked ship. Sliding the ship away would strand the
 * gangplank in mid-air and leave the sailors floating where the deck used to be.
 * The camera sequence gives the same "a ship has arrived" beat without that
 * desync, so that is the path taken here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BROWSER vs XR
 * ─────────────────────────────────────────────────────────────────────────
 * A scripted camera move only makes sense in flat browser mode, where
 * `world.camera` IS the viewer. In an immersive XR session the headset owns the
 * camera and we must never fight it — so when not in NonImmersive mode we skip
 * the camera work (and the player-rig pinning) entirely and still run the
 * Captain walk + dialogue + decree, which appear as world-space panels.
 *
 * To make the browser camera math simple, we PIN the player rig to the origin
 * for the duration of the cinematic (the camera is local to the rig, so
 * rig-at-origin means camera-local == world). Pinning each frame from this
 * late-priority system also neutralises any locomotion input during the
 * cutscene — the player can't wander off mid-cinematic. We hold that lock for
 * the whole Fall set-piece (arrival → decree → ship trading → smuggler) and
 * release it only when smuggling resolves (Step 4 → 5).
 */

import {
  Vector3,
  createSystem,
  RayInteractable,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  Transform,
  UIKit,
  UIKitDocument,
  eq,
  type Entity,
} from '@iwsdk/core';

import { gameState } from '../game/GameState.js';
import { fallSequence } from '../game/FallSequence.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';

const CAPTION_CONFIG = './ui/captain-dialogue.json';

/** The Captain NPC's name on its Object3D (set in environment/Colonists.ts). */
const CAPTAIN_NAME = 'Captain Whitmore';

/** Where the Captain ends up to address the colony (on the dock path, facing
 *  south/+Z toward the player). Model "front" is local +Z, so yaw 0 faces +Z.
 *  Exported so SmugglingChoice (Step 4) can walk him BACK up the gangplank from
 *  exactly here. */
export const CAPTAIN_SPOT = new Vector3(0, 0, -15);

/** Top of the gangplank on the ship's deck, where the Captain starts (and
 *  returns to in Step 4). The ship deck sits at world y≈0.5 (SHIP_DECK_WORLD_Y)
 *  at x=0, just north of the dock. */
export const CAPTAIN_GANGPLANK_TOP = new Vector3(0, 0.5, -33.4);

/**
 * The cinematic timeline, in seconds since Fall began. Each SHOT is a tweened
 * camera move; HANDOFF eases the camera from the gangplank into the
 * face-to-face dialogue framing. Dialogue then plays as two subtitle lines.
 */
const SHOT_A_END = 3; // wide of the river + ship
const SHOT_B_END = 6; // close on the deck / sailors
const SHOT_C_END = 9; // medium on the gangplank (Captain descends)
const HANDOFF_END = 10.5; // settle into the dialogue view
const LINE_1_END = 16; // Captain's greeting
const PAUSE_END = 17.5; // the "[pause]" beat
const LINE_2_END = 22; // "...let me be clear about the Crown's rules..."

/** The Captain walks during this window (covers shot C + the handoff). */
const WALK_START = SHOT_C_END - 3; // 6
const WALK_END = HANDOFF_END; // 10.5

/** Captain's two arrival lines (verbatim from the brief). */
const LINE_1 =
  'Greetings, colonists! I am Captain Whitmore of the Royal Trading Company. I bring goods from England and will purchase your exports.';
const LINE_2 = "However, let me be clear about the Crown's rules...";

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
 * The three shots + the handoff move. Coordinates are world-space; because we
 * pin the rig to the origin, they are also the camera's local space. The ship
 * is centered at x=0, z≈-35.6, deck up to the mast at y≈5.5; the gangplank/dock
 * deep end is around z=-33.
 */
const SHOTS: Shot[] = [
  // Shot A — wide establishing from the east bank, elevated, gentle push-in.
  {
    t0: 0,
    t1: SHOT_A_END,
    fromPos: [13, 5, -15],
    toPos: [11, 4.4, -17],
    fromLook: [0, 2, -34],
    toLook: [0, 1.6, -34],
  },
  // Shot B — closer on the deck and the working sailors.
  {
    t0: SHOT_A_END,
    t1: SHOT_B_END,
    fromPos: [6.5, 2.8, -28],
    toPos: [5.4, 2.5, -29.5],
    fromLook: [0, 1.2, -35.2],
    toLook: [0, 1, -35.4],
  },
  // Shot C — medium on the gangplank; the look-target drifts south (+z) to
  // follow the Captain as he descends toward the dock.
  {
    t0: SHOT_B_END,
    t1: SHOT_C_END,
    fromPos: [4.2, 1.9, -26],
    toPos: [3.4, 1.6, -27.5],
    fromLook: [0, 0.7, -31.5],
    toLook: [0, 0.3, -29],
  },
  // Handoff — swing around to the face-to-face dialogue view on the dock path.
  {
    t0: SHOT_C_END,
    t1: HANDOFF_END,
    fromPos: [3.4, 1.6, -27.5],
    toPos: [0, 1.7, -7],
    fromLook: [0, 0.3, -29],
    toLook: [0, 1, -15],
  },
];

/** The resting dialogue framing (= the handoff's end pose), held through the
 *  Captain's dialogue and the whole decree until control returns to the player. */
const DIALOGUE_POS: [number, number, number] = [0, 1.7, -7];
const DIALOGUE_LOOK: [number, number, number] = [0, 1, -15];

export class TradeShipArrival extends createSystem({
  // The Captain is static scenery built in Colonists.ts; we find it by name
  // (same approach MarketSystem uses to tag the trader NPCs).
  npcCandidates: { required: [Transform] },
  // Our subtitle caption panel, matched once its UIKit document loads.
  captionPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', CAPTION_CONFIG)],
  },
}) {
  /** The Captain NPC entity (a single cached handle — not an entity array). */
  private captain?: Entity;

  /** The caption panel + its loaded document. */
  private captionEntity?: Entity;
  private captionDoc?: UIKitDocument;

  /** True from Fall entry until the cinematic + dialogue finish. */
  private cinematicRunning = false;
  /** True from Fall entry until decreeAccepted — while set, we hold the view. */
  private holdView = false;
  /** Seconds since the Fall sequence began (drives the whole timeline). */
  private clock = 0;
  /** Guards the one-shot emit of arrivalComplete. */
  private arrivalEmitted = false;
  /** Which caption line is currently shown (avoids re-setting text every frame). */
  private shownLine = 0;

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

    // Bottom-center subtitle caption (becomes a world-space panel in XR). Hidden
    // until the Captain speaks.
    this.captionEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: CAPTION_CONFIG, maxWidth: 1.6, maxHeight: 0.8 })
      .addComponent(RayInteractable)
      .addComponent(ScreenSpace, {
        bottom: '20%',
        left: '15vw',
        width: '70vw',
        height: '20%',
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
          this.setCaptionVisible(false);
        },
        true,
      ),
    );

    // Find the Captain NPC by name (replays for NPCs already built at boot).
    this.cleanupFuncs.push(
      this.queries.npcCandidates.subscribe(
        'qualify',
        (entity) => {
          if (!this.captain && entity.object3D?.name === CAPTAIN_NAME) {
            this.captain = entity;
          }
        },
        true,
      ),
    );

    // Drive the whole beat off the shared phase emitter.
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((oldPhase, newPhase) => {
        if (newPhase === 'Fall') this.startArrival();
        else if (oldPhase === 'Fall') this.endArrival();
      }),
    );
    if (gameState.currentPhase === 'Fall') this.startArrival();

    // Hold the cinematic camera/rig lock through the WHOLE Fall set-piece —
    // arrival, decree, ship trading, and the smuggler beat all play against this
    // same held dock framing. Control returns to the player only once smuggling
    // resolves (Step 4 → 5), so the Step-4 world action (the Captain walking back
    // up the gangplank, the Smuggler approaching) stays in shot.
    this.cleanupFuncs.push(
      fallSequence.onSmugglingComplete(() => {
        this.holdView = false;
      }),
    );
  }

  // ───────────────────────────── phase lifecycle ─────────────────────────────

  private startArrival(): void {
    // Locked-tracker revisit: if the player has already finished Fall and is
    // just looking back, don't replay the arrival cinematic or re-fire the
    // trade-ship sequence — leave the static dock scene under player control.
    if (gameState.hasCompletedPhase('Fall')) {
      this.cinematicRunning = false;
      this.holdView = false;
      this.setCaptionVisible(false);
      return;
    }
    this.clock = 0;
    this.cinematicRunning = true;
    this.holdView = true;
    this.arrivalEmitted = false;
    this.shownLine = 0;

    // Move the Captain to the top of the gangplank, facing the dock (+Z), ready
    // to descend. If he wasn't found, the cinematic still runs (camera only).
    if (this.captain?.object3D) {
      this.captain.object3D.position.copy(CAPTAIN_GANGPLANK_TOP);
      this.captain.object3D.rotation.set(0, 0, 0);
    }

    this.setCaptionVisible(false);
    console.log('[Fall] Trade ship arriving - Captain Whitmore comes ashore.');
  }

  private endArrival(): void {
    this.cinematicRunning = false;
    this.holdView = false;
    this.setCaptionVisible(false);
  }

  // ──────────────────────────────── per frame ────────────────────────────────

  update(delta: number) {
    if (!this.holdView) return;

    // "Flat" = not inside an immersive XR session. We drive the camera/rig only
    // here; in a real headset session the device owns the camera and we leave it
    // alone. `renderer.xr.isPresenting` is the reliable signal for this — it is
    // false in flat browser AND in the IWER emulator preview (which still
    // reports a "visible" visibilityState, so that flag can't be used here).
    const browser = !this.renderer.xr.isPresenting;

    // Pin the rig to the origin so (a) the camera math stays in world space and
    // (b) locomotion can't move the player during the scripted sequence. Only in
    // browser mode — in XR the headset owns the rig and we must not yank it.
    if (browser) {
      this.player.position.set(0, 0, 0);
      this.player.quaternion.identity();
    }

    if (this.cinematicRunning) {
      this.clock += delta;
      this.driveCinematic(browser);
    } else if (browser) {
      // Cinematic done, decree still up: hold the dialogue framing steady.
      this.applyCamera(DIALOGUE_POS, DIALOGUE_LOOK);
    }
  }

  /** Advance the camera, the Captain's walk, and the subtitle for `this.clock`. */
  private driveCinematic(browser: boolean): void {
    const t = this.clock;

    // ── Camera (browser only) ─────────────────────────────────────────────
    if (browser) {
      const shot = this.shotAt(t);
      if (shot) {
        const p = clamp01((t - shot.t0) / (shot.t1 - shot.t0));
        this.lerpArr(shot.fromPos, shot.toPos, p, this.camPos);
        this.lerpArr(shot.fromLook, shot.toLook, p, this.camLook);
        this.camera.position.copy(this.camPos);
        this.camera.lookAt(this.camLook);
      } else {
        this.applyCamera(DIALOGUE_POS, DIALOGUE_LOOK);
      }
    }

    // ── Captain walk (gangplank → speaking spot) ─────────────────────────
    this.updateCaptainWalk(t);

    // ── Subtitle dialogue ────────────────────────────────────────────────
    if (t < LINE_1_END && t >= HANDOFF_END) {
      this.showLine(1, LINE_1);
    } else if (t >= LINE_1_END && t < PAUSE_END) {
      this.showLine(0, ''); // the [pause] — caption hidden
    } else if (t >= PAUSE_END && t < LINE_2_END) {
      this.showLine(2, LINE_2);
    } else if (t >= LINE_2_END) {
      // Dialogue complete → hand off to the Royal Decree (Step 2). The view lock
      // stays on (holdView) so the decree plays against the held dock framing.
      this.setCaptionVisible(false);
      this.cinematicRunning = false;
      if (!this.arrivalEmitted) {
        this.arrivalEmitted = true;
        console.log('[Fall] Captain arrival dialogue complete - presenting the Royal Decree.');
        fallSequence.emitArrivalComplete();
      }
    }
  }

  /** Glide the Captain along his path for the current time. */
  private updateCaptainWalk(t: number): void {
    const obj = this.captain?.object3D;
    if (!obj) return;

    if (t <= WALK_START) {
      obj.position.copy(CAPTAIN_GANGPLANK_TOP);
      return;
    }
    const p = clamp01((t - WALK_START) / (WALK_END - WALK_START));
    // Straight march south along z; the first half-metre is the gangplank, where
    // he also steps down from the deck (y 0.5 → 0).
    const z = lerp(CAPTAIN_GANGPLANK_TOP.z, CAPTAIN_SPOT.z, p);
    const descent = clamp01((z - CAPTAIN_GANGPLANK_TOP.z) / 0.5); // 0 at deck → 1 by z=-32.9
    const y = CAPTAIN_GANGPLANK_TOP.y * (1 - descent);
    obj.position.set(0, y, z);
    obj.rotation.set(0, 0, 0); // keep facing +Z (his direction of travel = the player)
  }

  // ──────────────────────────────── helpers ──────────────────────────────────

  /** The shot whose window contains time `t`, or undefined once past HANDOFF. */
  private shotAt(t: number): Shot | undefined {
    for (const s of SHOTS) if (t >= s.t0 && t < s.t1) return s;
    return undefined;
  }

  private applyCamera(
    pos: [number, number, number],
    look: [number, number, number],
  ): void {
    this.camera.position.set(pos[0], pos[1], pos[2]);
    this.camLook.set(look[0], look[1], look[2]);
    this.camera.lookAt(this.camLook);
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

  /** Show subtitle `line` (1 or 2) with `body`; line 0 hides the caption. Only
   *  re-touches the DOM when the line actually changes. */
  private showLine(line: number, body: string): void {
    if (line === this.shownLine) return;
    this.shownLine = line;
    if (line === 0) {
      this.setCaptionVisible(false);
      return;
    }
    this.setText('cap-body', body);
    this.setCaptionVisible(true);
  }

  private setCaptionVisible(visible: boolean): void {
    if (this.captionEntity?.object3D)
      this.captionEntity.object3D.visible = visible;
    this.container('cap-root')?.setProperties({
      display: visible ? 'flex' : 'none',
    });
    if (visible) relayoutScreenSpacePanels(this.captionDoc);
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
}

/** Clamp to [0,1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Scalar linear interpolation. */
function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}
