/**
 * FarmSystem.ts — the Spring planting plot: a 4x4 grid of soil cells, the two
 * grabbable seed bags, and the "carry a bag over a cell and let go to plant it"
 * interaction.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT SPRING IS (and what this file builds)
 * ─────────────────────────────────────────────────────────────────────────
 * Spring is the ~7–8 minute segment where the student plants a small farm and
 * learns the corn-vs-tobacco tradeoff (corn feeds the colony, tobacco is the
 * cash crop). That decision is carried into Summer through PlayerInventory.
 *
 * This file builds the physical, hands-on part of that scene:
 *   1. A tidy 4x4 grid of 16 tilled-soil plot cells near the player's home.
 *   2. Two "infinite" grabbable seed bags (corn + tobacco) on a stump beside
 *      the grid, each labelled, each returning to its spot when released.
 *   3. Plant-on-release: while you hold a bag the cell beneath it lights up
 *      green; let go over a lit cell and that crop is planted there.
 *
 * It deliberately does NOT yet wire scoring, a confirm step, the harvest
 * hand-off to PlayerInventory, or Thomas's coaching — those come later.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IWSDK rules followed here
 * ─────────────────────────────────────────────────────────────────────────
 *  - Three.js types imported from '@iwsdk/core' (never from 'three').
 *  - Entities created via world.createTransformEntity(), never scene.add().
 *  - Grabbing uses the built-in GrabSystem (see the big comment on the bags).
 *  - No custom Raycaster: "is the bag over a cell?" is answered with a simple
 *    distance check, which is plenty for a flat grid (see hover detection).
 */

import {
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Grabbed,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OneHandGrabbable,
  PlaneGeometry,
  Quaternion,
  RayInteractable,
  Transform,
  Types,
  Vector3,
  createComponent,
  createSystem,
  type Entity,
} from '@iwsdk/core';

// PhaseObject tags an entity as belonging to a season group; PhaseSystem then
// shows it only in its phase (and hides it otherwise). Tagging the field +
// bags 'Spring' is what registers them in the Spring group (STEP 4).
import { PhaseObject } from './PhaseSystem.js';

// ─────────────────────────────────── components ──────────────────────────────

/**
 * THE FARMCELL CROP-STATE COMPONENT
 * ---------------------------------
 * In an ECS, a "component" is just a bag of data attached to an entity — here,
 * to one tile of the grid. `FarmCell` records two things about a tile:
 *
 *   • `index` — which of the 16 tiles this is (0–15, left-to-right, near-to-far).
 *   • `crop`  — an ENUM holding the tile's planting state. It is exactly one of
 *               'empty' | 'corn' | 'tobacco'. It starts 'empty' (bare soil);
 *               planting flips it to 'corn' or 'tobacco'; re-planting overwrites
 *               it. This single value is the source of truth for what a tile is
 *               "growing", and `refreshCellVisual()` reads it to decide which
 *               marker (if any) to show on the tile.
 *
 * Storing the state in a component (instead of a plain JS variable) means any
 * system can later query "all cells where crop == 'corn'" to, e.g., tally the
 * harvest — that's the seam the next milestone will use.
 */
export const FarmCell = createComponent('FarmCell', {
  index: { type: Types.Int32, default: 0 },
  crop: {
    type: Types.Enum,
    enum: { Empty: 'empty', Corn: 'corn', Tobacco: 'tobacco' },
    default: 'empty',
  },
});

/** Marks a seed bag and remembers which crop grabbing-and-planting it sows. */
export const SeedBag = createComponent('SeedBag', {
  crop: {
    type: Types.Enum,
    enum: { Corn: 'corn', Tobacco: 'tobacco' },
    default: 'corn',
  },
});

/** The two crops a cell can hold (mirrors the SeedBag/FarmCell enums). */
type Crop = 'corn' | 'tobacco';

// ─────────────────────────────────── layout ──────────────────────────────────

/**
 * Where the farm sits: the open grass just south of the player's home cabin
 * (built at (-7, 7) in Settlement.ts), in front of the small garden fence and
 * squarely in view as the player walks up from the southern spawn. The seed-bag
 * stump sits at the near (player-facing) edge so it's the first thing reached.
 */
const FARM_CENTER = { x: -7, z: 12 };
const CELL_SIZE = 0.8; // each plot tile is 0.8m square …
const CELL_GAP = 0.15; // … with a small gap between tiles
const CELL_PITCH = CELL_SIZE + CELL_GAP; // centre-to-centre spacing
const CELL_THICKNESS = 0.06; // a flat slab laid on the ground
const GRID = 4; // 4x4 → 16 cells

/** Colours (period-earthy, matching Settlement.ts's palette). */
const COLOR_SOIL = 0x5e4126; // tilled-soil brown (a tile's normal colour)
const COLOR_HIGHLIGHT = 0x8fce7a; // soft green "you'll plant here" highlight
const COLOR_CORN_CROP = 0x4f9a2f; // green corn stalk
const COLOR_TOBACCO_CROP = 0xc09a3c; // golden-brown tobacco leaves
const COLOR_CORN_SACK = 0xd8c48a; // light tan sack
const COLOR_TOBACCO_SACK = 0x4a3b2a; // dark hessian sack
const COLOR_STUMP = 0x6e4b2a; // log/stump wood

/** How fast a released bag eases back to its spot on the stump (per second). */
const RETURN_LERP = 8;

/**
 * How close (in metres, measured flat on the ground) a held bag must be to a
 * cell's centre to count as "hovering over" it. Cells sit CELL_PITCH (~0.95m)
 * apart, so we use a touch over half that pitch: this leaves NO dead zone
 * between tiles (the bag is always over *some* cell once it's above the grid),
 * while the nearest-cell-wins rule keeps the choice unambiguous when two are
 * in range. Forgiving aiming is the whole point — planting should feel easy.
 */
const PLANT_RADIUS = 0.6;

/** A bag's resting transform, captured at build time so we can return to it. */
interface BagHome {
  position: Vector3;
  quaternion: Quaternion;
}

export class FarmSystem extends createSystem({
  // Every seed bag (drives grab→hover→plant→return each frame).
  bags: { required: [SeedBag, Transform] },
  // All grid cells (queried so logic finds them by query, not a stored array).
  cells: { required: [FarmCell] },
}) {
  /** Each bag's home transform, keyed by entity index. Immutable after build —
   *  this is fixed layout data, not live entity tracking. */
  private bagHomes = new Map<number, BagHome>();

  /** The crop marker mesh currently shown on each planted cell (cell index →
   *  marker), so re-planting can swap it out. */
  private cropMarkers = new Map<number, Mesh>();

  /** Cells currently tinted green. Tracked so we can un-tint them when the bag
   *  moves away. Reused scratch set `hoverScratch` avoids per-frame allocation. */
  private highlighted = new Set<Entity>();
  private hoverScratch = new Set<Entity>();

  // Scratch vectors — allocate ONCE here, never inside update() (a new Vector3
  // every frame would create garbage and risk GC hitches in VR).
  private bagWorld!: Vector3;
  private cellWorld!: Vector3;

  init(): void {
    this.bagWorld = new Vector3();
    this.cellWorld = new Vector3();
    this.buildGrid();
    this.buildSeedBags();
  }

  // ───────────────────────────────── grid build ──────────────────────────────

  /** Lay out the 16 tilled-soil cells in a tidy 4x4 grid centred on FARM_CENTER. */
  private buildGrid(): void {
    const span = (GRID - 1) * CELL_PITCH; // distance between first/last centres
    const x0 = FARM_CENTER.x - span / 2;
    const z0 = FARM_CENTER.z - span / 2;

    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const index = row * GRID + col;

        const tile = new Mesh(
          new BoxGeometry(CELL_SIZE, CELL_THICKNESS, CELL_SIZE),
          new MeshStandardMaterial({ color: new Color(COLOR_SOIL), roughness: 1 }),
        );
        // Flat slabs only receive shadows (they don't cast meaningfully).
        tile.castShadow = false;
        tile.receiveShadow = true;
        tile.name = `FarmCell:${index}`;
        tile.position.set(
          x0 + col * CELL_PITCH,
          CELL_THICKNESS / 2, // rest the slab on the ground (top just above grass)
          z0 + row * CELL_PITCH,
        );

        this.world
          .createTransformEntity(tile)
          .addComponent(FarmCell, { index, crop: 'empty' })
          // Part of the Spring group: shown/active only during Spring.
          .addComponent(PhaseObject, { phase: 'Spring' });
        // No marker yet — the cell starts as bare soil ('empty').
      }
    }
  }

  /**
   * Make a cell's appearance match its `crop`: clear any old marker, then (if
   * planted) drop the matching crop marker on top of the tile. This is the one
   * place crop visuals live, so planting only has to set the enum + call this.
   */
  private refreshCellVisual(entity: Entity): void {
    // Remove a previous marker first (handles overwriting corn → tobacco etc.).
    const existing = this.cropMarkers.get(entity.index);
    if (existing) {
      existing.removeFromParent();
      existing.geometry.dispose();
      (existing.material as MeshStandardMaterial).dispose();
      this.cropMarkers.delete(entity.index);
    }

    const crop = entity.getValue(FarmCell, 'crop');
    if (crop !== 'corn' && crop !== 'tobacco') return; // 'empty' → bare soil

    const marker = this.makeCropMarker(crop);
    // Add the marker as a child of the tile mesh, sitting on its top face.
    entity.object3D!.add(marker);
    this.cropMarkers.set(entity.index, marker);
  }

  /**
   * A simple placeholder crop marker (no model yet): corn is a tall, narrow
   * green stalk; tobacco is a shorter, broader golden-brown leafy bush — clearly
   * distinct by colour, height, and width.
   */
  private makeCropMarker(crop: Crop): Mesh {
    const isCorn = crop === 'corn';
    const height = isCorn ? 0.55 : 0.3;
    const radius = isCorn ? 0.12 : 0.22;
    const color = isCorn ? COLOR_CORN_CROP : COLOR_TOBACCO_CROP;

    const marker = new Mesh(
      new ConeGeometry(radius, height, isCorn ? 8 : 7),
      new MeshStandardMaterial({ color: new Color(color), roughness: 0.85, flatShading: true }),
    );
    marker.castShadow = true;
    // Tile top is at local y = +CELL_THICKNESS/2; seat the cone's base there.
    marker.position.y = CELL_THICKNESS / 2 + height / 2;
    marker.name = `Crop:${crop}`;
    return marker;
  }

  // ───────────────────────────────── seed bags ───────────────────────────────

  /** Build the stump and the two grabbable, labelled, infinite seed bags. */
  private buildSeedBags(): void {
    // A low stump at the near (south) edge of the grid acts as the seed table.
    const stumpX = FARM_CENTER.x;
    const stumpZ = FARM_CENTER.z + ((GRID - 1) * CELL_PITCH) / 2 + 1.4;
    const stumpTopY = 0.7;

    const stump = new Mesh(
      new CylinderGeometry(0.55, 0.62, stumpTopY, 14),
      new MeshStandardMaterial({ color: new Color(COLOR_STUMP), roughness: 0.95 }),
    );
    stump.castShadow = true;
    stump.receiveShadow = true;
    stump.position.set(stumpX, stumpTopY / 2, stumpZ);
    stump.name = 'SeedStump';
    this.world
      .createTransformEntity(stump)
      // Spring-group scenery (hidden outside Spring).
      .addComponent(PhaseObject, { phase: 'Spring' });

    // Two bags side by side on top of the stump, facing the approaching player.
    this.buildSeedBag('corn', COLOR_CORN_SACK, 'Corn Seeds', stumpX - 0.26, stumpZ, stumpTopY);
    this.buildSeedBag('tobacco', COLOR_TOBACCO_SACK, 'Tobacco Seeds', stumpX + 0.26, stumpZ, stumpTopY);
  }

  /**
   * HOW THE GRAB SYSTEM WORKS HERE
   * ------------------------------
   * We don't write any grab code ourselves — IWSDK's built-in GrabSystem does
   * it. Adding the `OneHandGrabbable` component is the whole opt-in: the
   * GrabSystem then watches the controllers, and when one is near this object
   * and the player squeezes the GRIP button, it attaches the object to that
   * hand and moves it for us. While held, the object also carries a transient
   * `Grabbed` tag (which we check below to know it's in hand). We also add
   * `RayInteractable` so the pointer ray shows hover feedback on the bag.
   *
   * "Infinite" + "returns to the stump": grabbing never consumes the bag, and
   * because `OneHandGrabbable` has no built-in snap-back (only DistanceGrabbable
   * does), we ease a released bag home ourselves in update().
   */
  private buildSeedBag(
    crop: Crop,
    color: number,
    label: string,
    x: number,
    z: number,
    baseY: number,
  ): void {
    const group = new Group();
    group.name = `SeedBag:${crop}`;

    const sackMat = new MeshStandardMaterial({ color: new Color(color), roughness: 1 });

    // Sack body: a slightly tapered cylinder (wider at the bottom).
    const body = new Mesh(new CylinderGeometry(0.13, 0.17, 0.26, 12), sackMat);
    body.position.y = 0.13;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Cinched neck: a narrow stub of the same cloth tied at the top.
    const neck = new Mesh(new CylinderGeometry(0.07, 0.11, 0.1, 12), sackMat);
    neck.position.y = 0.3;
    neck.castShadow = true;
    group.add(neck);

    // Floating label above the sack, billboard-flat toward the player (+Z home).
    const labelMesh = this.makeLabel(label);
    labelMesh.position.set(0, 0.62, 0);
    group.add(labelMesh);

    group.position.set(x, baseY, z);

    const entity = this.world
      .createTransformEntity(group)
      .addComponent(SeedBag, { crop })
      // Built-in grab: proximity one-hand grip, free move + rotate.
      .addComponent(OneHandGrabbable, { translate: true, rotate: true })
      // Pointer/ray hover feedback (InputSystem drives Hovered/Pressed).
      .addComponent(RayInteractable)
      // Part of the Spring group: shown/grabbable only during Spring.
      .addComponent(PhaseObject, { phase: 'Spring' });

    // Remember where it rests so we can ease it back when released.
    this.bagHomes.set(entity.index, {
      position: group.position.clone(),
      quaternion: group.quaternion.clone(),
    });
  }

  /**
   * A small unlit text plane built from a canvas texture — readable as a label
   * without pulling in the full PanelUI stack for a one-line caption.
   */
  private makeLabel(text: string): Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    // Rounded parchment chip background.
    ctx.fillStyle = 'rgba(35, 24, 14, 0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f0e3c2';
    ctx.font = 'bold 34px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new CanvasTexture(canvas);
    const mat = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: DoubleSide,
    });
    // 4:1 canvas → a 0.4 x 0.1 plane keeps the text crisp and unstretched.
    const mesh = new Mesh(new PlaneGeometry(0.4, 0.1), mat);
    mesh.name = 'SeedBagLabel';
    return mesh;
  }

  // ──────────────────── per-frame: hover, plant, return home ──────────────────

  /**
   * Runs every frame. For each seed bag:
   *   • If it's HELD, find the cell under it and PLANT it right away — "paint to
   *     plant". Dragging a held bag across the grid fills every cell it passes
   *     over, so the whole field can be sown in one grab instead of a separate
   *     grab-carry-release trip per cell. The hovered cell also glows green.
   *   • If it's NOT held, ease the (reusable) bag back to its spot on the stump.
   * Finally we update the green highlights to match exactly the cells currently
   * being hovered.
   *
   * Why plant-on-hover (not plant-on-release): releasing the bag was the only
   * way to plant before, which meant 16 grabs to fill 16 cells. Painting while
   * held is dramatically easier and still lets the player overwrite mistakes by
   * simply dragging the *other* bag over a cell.
   */
  update(delta: number): void {
    const desired = this.hoverScratch;
    desired.clear();

    for (const bag of this.queries.bags.entities) {
      const obj = bag.object3D;
      if (!obj) continue;

      // The `Grabbed` tag is added by the GrabSystem while the bag is in hand.
      const held = bag.hasComponent(Grabbed);

      if (held) {
        // HOVER DETECTION BY DISTANCE
        // ---------------------------
        // No raycasting needed for a flat grid: take the bag's world position,
        // and find the nearest cell whose centre is within PLANT_RADIUS on the
        // ground plane (we ignore the Y/height difference, so holding the bag
        // high above a tile still counts as hovering it).
        obj.getWorldPosition(this.bagWorld);
        const cell = this.findCellUnder(this.bagWorld);
        if (cell) {
          desired.add(cell); // this cell should glow green this frame
          // PAINT-TO-PLANT: sow the hovered cell immediately. plantCell guards
          // against re-sowing a cell that already holds this crop, so dragging
          // the bag over one tile does NOT rebuild its marker mesh every frame.
          this.plantCell(cell, bag.getValue(SeedBag, 'crop') as Crop);
        }
      } else {
        // NOT held → ease the reusable bag back to its spot on the stump.
        this.returnHome(bag, obj, delta);
      }
    }

    this.applyHighlights(desired);
  }

  /** Nearest cell within PLANT_RADIUS of `point` on the ground (XZ), or none. */
  private findCellUnder(point: Vector3): Entity | undefined {
    let nearest: Entity | undefined;
    let nearestDist = PLANT_RADIUS;
    for (const cell of this.queries.cells.entities) {
      cell.object3D!.getWorldPosition(this.cellWorld);
      // Horizontal (ground-plane) distance only.
      const dx = this.cellWorld.x - point.x;
      const dz = this.cellWorld.z - point.z;
      const dist = Math.hypot(dx, dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = cell;
      }
    }
    return nearest;
  }

  /**
   * Set a cell's crop state and refresh its marker. Overwrites any prior crop.
   * Called every frame while a bag hovers a cell, so it early-outs when the crop
   * is unchanged — otherwise refreshCellVisual() would dispose and rebuild the
   * marker mesh ~90× a second, churning GPU resources and risking VR hitches.
   */
  private plantCell(cell: Entity, crop: Crop): void {
    if (cell.getValue(FarmCell, 'crop') === crop) return;
    cell.setValue(FarmCell, 'crop', crop);
    this.refreshCellVisual(cell);
  }

  /** Tint exactly the cells in `desired` green; restore all others to soil. */
  private applyHighlights(desired: Set<Entity>): void {
    // Un-tint cells that are no longer hovered.
    for (const cell of this.highlighted) {
      if (!desired.has(cell)) this.setCellTint(cell, COLOR_SOIL);
    }
    // Tint newly-hovered cells.
    for (const cell of desired) {
      if (!this.highlighted.has(cell)) this.setCellTint(cell, COLOR_HIGHLIGHT);
    }
    // Remember the new highlighted set for next frame's diff.
    this.highlighted.clear();
    for (const cell of desired) this.highlighted.add(cell);
  }

  /** Recolour a cell tile (its own material instance, so siblings are unaffected). */
  private setCellTint(cell: Entity, color: number): void {
    const mat = (cell.object3D as Mesh | undefined)?.material as
      | MeshStandardMaterial
      | undefined;
    mat?.color.set(color);
  }

  /**
   * Ease a released bag back to its spot on the stump. Frame-rate-independent
   * lerp/slerp; snap once it's effectively home so it settles cleanly.
   */
  private returnHome(bag: Entity, obj: NonNullable<Entity['object3D']>, delta: number): void {
    const home = this.bagHomes.get(bag.index);
    if (!home) return;

    const settled =
      obj.position.distanceTo(home.position) < 0.001 &&
      obj.quaternion.angleTo(home.quaternion) < 0.001;
    if (settled) return;

    const t = Math.min(1, delta * RETURN_LERP);
    obj.position.lerp(home.position, t);
    obj.quaternion.slerp(home.quaternion, t);
    if (obj.position.distanceTo(home.position) < 0.01) {
      obj.position.copy(home.position);
      obj.quaternion.copy(home.quaternion);
    }
  }
}
