/**
 * WaypointSystem.ts — the floating navigation marker that points the player to
 * the next thing to do.
 *
 * A gold diamond bobs and sparkles over the current target, with a small
 * parchment name tag under it ("Thomas", "Market", "Farm Plot", "Trade Ship").
 * When the target is off to the side or behind the player, the diamond is
 * replaced by a world-space 3D arrow floating in front of the camera that
 * points the way — the VR-correct version of a screen-edge arrow. The marker
 * hides once the player is within 3 units of the target.
 *
 * It is purely a navigation aid: it READS phase + progress (objectiveTracker
 * from Part 1, springProgress/summerProgress, the Fall sequence) and the player
 * camera, and never changes gameplay. The target rules per phase:
 *   Arrival — the supply crates, once the orientation cinematic has finished.
 *   Spring  — Thomas → the farm plot → the Confirm panel (by progress).
 *   Summer  — nearest stall → nearest unvisited stall/farm → town center (2+ visits).
 *   Fall    — the ship → the dock trading spot after the decree → none.
 *   Winter  — none (the results dashboard is full-screen).
 *
 * Mesh + billboard patterns follow the environment builders and MarketSystem.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  ConeGeometry,
  createSystem,
  CylinderGeometry,
  eq,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PanelDocument,
  PanelUI,
  Points,
  PointsMaterial,
  Quaternion,
  UIKit,
  UIKitDocument,
  Vector3,
  type Entity,
} from '@iwsdk/core';

import { gameState } from '../game/GameState.js';
import { objectiveTracker } from '../game/ObjectiveTracker.js';
import { summerProgress } from '../game/SummerProgress.js';
import { arrivalSequence } from '../game/ArrivalSequence.js';

const LABEL_CONFIG = './ui/waypoint-label.json';

// ── Target world positions (the settlement is static, so these are fixed) ─────
const SUPPLIES = new Vector3(1.4, 0.3, 0.8); // crates/barrels cluster near origin
const THOMAS = new Vector3(5.5, 0, 5.5);
const FARM_PLOT = new Vector3(-7, 0, 12); // 4x4 grid center (FARM_CENTER)
const CONFIRM = new Vector3(-7, 2.2, 9.6); // the Confirm Planting panel
const TOWN_CENTER = new Vector3(0, 0, 0); // market / settlement heart
const SHIP = new Vector3(0, -0.5, -35.6); // moored trade ship
const SHIP_TRADE = new Vector3(-7, 0, -15); // dock spot where the Captain stands

/** Market stalls (the three traders) for "nearest stall". */
const STALLS: { id: string; pos: Vector3 }[] = [
  { id: 'Martha', pos: new Vector3(1.7, 0, 1.5) },
  { id: 'James', pos: new Vector3(-1.9, 0, 1.1) },
  { id: 'Anne', pos: new Vector3(1.9, 0, -1.2) },
];

/** Stalls + neighbor farms — every Summer trade location, for "nearest unvisited". */
const TRADE_SPOTS: { id: string; pos: Vector3 }[] = [
  ...STALLS,
  { id: 'Thomas', pos: THOMAS },
  { id: 'Elizabeth', pos: new Vector3(-8.5, 0, 8.5) },
];

/** Friendly labels (the trade ids double as names; map the generic ones). */
const SPOT_LABEL: Record<string, string> = {
  Martha: 'Market',
  James: 'Market',
  Anne: 'Market',
  Thomas: 'Thomas',
  Elizabeth: 'Farm',
};

// ── Tunables ──────────────────────────────────────────────────────────────
const HOVER = 2.2; // default height of the diamond above its target
const BOB_AMP = 0.3; // sinusoidal bob amplitude
const BOB_PERIOD = 1.0; // seconds per bob cycle
const HIDE_DIST = 3.0; // hide the marker within this distance of the target
const ON_VIEW_DOT = 0.5; // cos(~60°): target within this cone counts as on-screen
const ARROW_DIST = 2.6; // how far in front of the camera the off-view arrow sits
const GOLD = 0xffcf57;

interface Target {
  pos: Vector3;
  label: string;
  hover?: number;
}

export class WaypointSystem extends createSystem({
  label: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', LABEL_CONFIG)],
  },
}) {
  // World objects (created in init, animated in update).
  private markerGroup!: Group;
  private diamond!: Mesh;
  private sparkle!: Points;
  private sparkleMat!: PointsMaterial;
  private arrowGroup!: Group;
  private labelEntity?: Entity;
  private labelDoc?: UIKitDocument;
  private lastLabel = '';

  /** Arrival's marker only appears once the orientation cinematic is done. */
  private cinematicDone = false;

  /** Elapsed clock for bob / spin / sparkle. */
  private clock = 0;

  // Per-frame scratch (allocated once — no garbage in update()).
  private camPos = new Vector3();
  private camDir = new Vector3();
  private markerPos = new Vector3();
  private toTarget = new Vector3();
  private tmp = new Vector3();
  private quat = new Quaternion();
  private readonly UP = new Vector3(0, 1, 0);

  init() {
    // ── The bobbing diamond + its sparkle, as one group ─────────────────────
    this.markerGroup = new Group();
    const mat = new MeshStandardMaterial({
      color: GOLD,
      emissive: GOLD,
      emissiveIntensity: 0.85,
      metalness: 0.4,
      roughness: 0.35,
    });
    mat.depthTest = false; // show through walls — it's a navigation aid
    this.diamond = new Mesh(new OctahedronGeometry(0.28), mat);
    this.diamond.castShadow = false;
    this.diamond.renderOrder = 999;
    this.markerGroup.add(this.diamond);

    this.sparkle = this.makeSparkle();
    this.markerGroup.add(this.sparkle);

    this.markerGroup.visible = false;
    this.world.createTransformEntity(this.markerGroup);

    // ── The off-view arrow (shaft + cone tip), pointing along +Y ────────────
    this.arrowGroup = this.makeArrow();
    this.arrowGroup.visible = false;
    this.world.createTransformEntity(this.arrowGroup);

    // ── The floating name tag (world-space PanelUI, billboarded each frame) ──
    this.labelEntity = this.world.createTransformEntity().addComponent(PanelUI, {
      config: LABEL_CONFIG,
      maxWidth: 0.62,
      maxHeight: 0.2,
    });
    this.labelEntity.object3D!.visible = false;

    this.cleanupFuncs.push(
      this.queries.label.subscribe(
        'qualify',
        (entity) => {
          this.labelDoc = PanelDocument.data.document[entity.index] as
            | UIKitDocument
            | undefined;
        },
        true,
      ),
    );

    // Arrival's supply marker waits for the orientation tour to finish.
    this.cleanupFuncs.push(
      arrivalSequence.onCinematicComplete(() => {
        this.cinematicDone = true;
      }),
    );
  }

  update(delta: number): void {
    this.clock += delta;

    const target = this.getTarget();
    if (!target) {
      this.hideAll();
      return;
    }

    // Where the diamond hovers, and how far the player is from the target.
    const hover = target.hover ?? HOVER;
    const bob = BOB_AMP * Math.sin((this.clock / BOB_PERIOD) * Math.PI * 2);
    this.markerPos.set(target.pos.x, target.pos.y + hover + bob, target.pos.z);

    this.world.camera.getWorldPosition(this.camPos);
    const dist = this.camPos.distanceTo(target.pos);
    if (dist < HIDE_DIST) {
      this.hideAll();
      return;
    }

    // On-screen? (target within a cone around the camera's forward axis)
    this.world.camera.getWorldDirection(this.camDir);
    this.toTarget.copy(this.markerPos).sub(this.camPos).normalize();
    const onView = this.camDir.dot(this.toTarget) > ON_VIEW_DOT;

    if (onView) {
      this.showDiamond(target);
    } else {
      this.showArrow(target);
    }
  }

  // ─────────────────────────────── targeting ─────────────────────────────────

  private getTarget(): Target | null {
    switch (gameState.currentPhase) {
      case 'Arrival':
        return this.cinematicDone
          ? { pos: SUPPLIES, label: 'Supplies', hover: 1.6 }
          : null;

      case 'Spring':
        if (!objectiveTracker.isComplete('spring-thomas'))
          return { pos: THOMAS, label: 'Thomas' };
        if (!objectiveTracker.isComplete('spring-plant'))
          return { pos: FARM_PLOT, label: 'Farm Plot', hover: 2.6 };
        if (!objectiveTracker.isComplete('spring-confirm'))
          return { pos: CONFIRM, label: 'Confirm Planting', hover: 1.0 };
        return null;

      case 'Summer': {
        const visited = summerProgress.getVisitedCount();
        if (visited === 0) return this.nearest(STALLS);
        if (visited < 2) {
          const seen = summerProgress.getVisited();
          const open = TRADE_SPOTS.filter((s) => !seen.includes(s.id));
          return open.length ? this.nearest(open) : { pos: TOWN_CENTER, label: 'Town Center' };
        }
        return { pos: TOWN_CENTER, label: 'Town Center' };
      }

      case 'Fall':
        if (!objectiveTracker.isComplete('fall-decree'))
          return { pos: SHIP, label: 'Trade Ship', hover: 4 };
        if (!objectiveTracker.isComplete('fall-shiptrade'))
          return { pos: SHIP_TRADE, label: 'Ship Trade', hover: 2.4 };
        return null; // smuggler comes to the player

      default:
        return null; // Winter — full-screen dashboard, no waypoint
    }
  }

  /** The nearest spot to the player from a list, labelled for display. */
  private nearest(spots: { id: string; pos: Vector3 }[]): Target {
    this.world.camera.getWorldPosition(this.camPos);
    let best = spots[0];
    let bestD = Infinity;
    for (const s of spots) {
      const d = this.camPos.distanceTo(s.pos);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return { pos: best.pos, label: SPOT_LABEL[best.id] ?? best.id };
  }

  // ─────────────────────────────── rendering ─────────────────────────────────

  private showDiamond(target: Target): void {
    this.arrowGroup.visible = false;

    this.markerGroup.visible = true;
    this.markerGroup.position.copy(this.markerPos);
    this.diamond.rotation.y += 0.018; // slow spin for life
    // Twinkle: oscillate the sparkle opacity and rotate it gently.
    this.sparkleMat.opacity = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(this.clock * 4));
    this.sparkle.rotation.y += 0.01;

    // Name tag under the diamond, billboarded (yaw) to face the camera.
    const label = this.labelEntity!;
    label.object3D!.visible = true;
    label.object3D!.position.set(
      this.markerPos.x,
      this.markerPos.y - 0.6,
      this.markerPos.z,
    );
    const yaw = Math.atan2(
      this.camPos.x - this.markerPos.x,
      this.camPos.z - this.markerPos.z,
    );
    label.object3D!.rotation.set(0, yaw, 0);
    this.setLabelText(target.label);
  }

  private showArrow(target: Target): void {
    this.markerGroup.visible = false;
    if (this.labelEntity?.object3D) this.labelEntity.object3D.visible = false;

    // Float the arrow a short way in front of the camera, nudged down a touch.
    this.tmp.copy(this.camDir).multiplyScalar(ARROW_DIST);
    this.tmp.add(this.camPos);
    this.tmp.y -= 0.35;
    this.arrowGroup.visible = true;
    this.arrowGroup.position.copy(this.tmp);

    // Point the arrow's +Y axis from itself toward the target, with a gentle
    // attention pulse on scale.
    this.toTarget.copy(target.pos).sub(this.tmp).normalize();
    this.quat.setFromUnitVectors(this.UP, this.toTarget);
    this.arrowGroup.quaternion.copy(this.quat);
    const s = 1 + 0.12 * (0.5 + 0.5 * Math.sin(this.clock * 5));
    this.arrowGroup.scale.setScalar(s);
  }

  private hideAll(): void {
    this.markerGroup.visible = false;
    this.arrowGroup.visible = false;
    if (this.labelEntity?.object3D) this.labelEntity.object3D.visible = false;
  }

  private setLabelText(text: string): void {
    if (text === this.lastLabel) return;
    // Don't cache until the doc is actually ready and the write lands, otherwise
    // an early call (before the panel loads) would mark it done and never retry.
    const el = this.labelDoc?.getElementById('wp-label-text') as UIKit.Text | null;
    if (!el) return;
    el.setProperties({ text });
    this.lastLabel = text;
  }

  // ─────────────────────────────── builders ──────────────────────────────────

  /** A small additive Points cloud that twinkles around the diamond. */
  private makeSparkle(): Points {
    const n = 14;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // Random points in a small sphere shell around the diamond.
      const r = 0.32 + Math.random() * 0.18;
      const a = Math.random() * Math.PI * 2;
      const b = Math.acos(2 * Math.random() - 1);
      arr[i * 3] = r * Math.sin(b) * Math.cos(a);
      arr[i * 3 + 1] = r * Math.cos(b);
      arr[i * 3 + 2] = r * Math.sin(b) * Math.sin(a);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(arr, 3));
    this.sparkleMat = new PointsMaterial({
      color: 0xfff0b0,
      size: 0.07,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      blending: AdditiveBlending,
    });
    const pts = new Points(geo, this.sparkleMat);
    pts.renderOrder = 999;
    return pts;
  }

  /** A stubby 3D arrow (shaft + cone) pointing along +Y. */
  private makeArrow(): Group {
    const g = new Group();
    const mat = new MeshStandardMaterial({
      color: GOLD,
      emissive: GOLD,
      emissiveIntensity: 0.85,
      metalness: 0.4,
      roughness: 0.35,
    });
    mat.depthTest = false;
    const shaft = new Mesh(new CylinderGeometry(0.045, 0.045, 0.36, 12), mat);
    shaft.position.y = 0.18;
    shaft.renderOrder = 999;
    shaft.castShadow = false;
    const tip = new Mesh(new ConeGeometry(0.14, 0.26, 16), mat);
    tip.position.y = 0.49;
    tip.renderOrder = 999;
    tip.castShadow = false;
    g.add(shaft, tip);
    return g;
  }
}
