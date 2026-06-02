/**
 * Waterfront.ts — the river, dock, ship, and connecting paths for the north
 * edge of the colonial Virginia settlement.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * GEOGRAPHY (why the water is where it is)
 * ─────────────────────────────────────────────────────────────────────────
 * The settlement runs south→north: homes at the south (z≈+7), market at the
 * center (z=0), and the storage barn at the north end (z≈-8). The ground plane
 * ends at z=-20. The waterfront therefore sits along the NORTH edge (-Z), past
 * the barn — the edge farthest from the homes — so goods flow barn → dock →
 * ship. The shoreline runs east–west (along X); the dock runs north–south
 * (along Z), perpendicular to it.
 *
 * Heights (everything keyed off these):
 *   - Ground top surface ...... y =  0.0
 *   - Dock walking surface ..... y =  0.0   (flush with land at the shore)
 *   - Water surface ............ y = -0.5   (0.5 below ground → bank slopes down,
 *                                            dock sits 0.5 above the water)
 *   - Ship deck ................ y = +0.5   (kept low so the gangplank stays
 *                                            under 30° without clipping the hull)
 *
 * Like the rest of the settlement, every model here is a PLACEHOLDER built from
 * Three.js primitives (there are no dock/ship/water GLBs in public/gltf/). Each
 * builder is tagged PLACEHOLDER so you can swap in real models later while
 * keeping the placement maths below unchanged.
 * ─────────────────────────────────────────────────────────────────────────
 */

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  TorusGeometry,
  type World,
} from '@iwsdk/core';

// Reuse the settlement's shared palette, shadow-enabled mesh helper, the
// generic `place()` placer (for group props with proper bases), and several
// prop builders. Exported from Settlement.ts; nothing there moves.
import {
  COLORS,
  makeBarrel,
  makeCart,
  makeCrate,
  makeLantern,
  makeRopeCoil,
  makeSignpost,
  place,
  solid,
} from './Settlement.js';

// ── Waterfront-specific key heights / shoreline geometry ────────────────────
const WATER_Y = -0.5; // water surface height (below ground top at y=0)
const DOCK_TOP_Y = 0.0; // dock walking surface (flush with land)
const SHORE_Z = -20; // ground's north edge (land/water boundary)
const WATERLINE_Z = -22; // where the sloped bank toe meets the water

// Waterfront colours not in the shared palette.
const WF_COLORS = {
  water: 0x2a6b6b, // teal-blue river
  sand: 0x9c8154, // muddy sand bank
  rock: 0x6f6a63, // grey shore rock
  reed: 0x6d7e3a, // green reeds/cattails
} as const;

/**
 * Place a bare mesh/group with an explicit base height. `place()` from
 * Settlement always sets y=0, which sinks centre-origin boxes/cylinders halfway
 * through the surface — so dock/path props (crates, barrels, rope) use this
 * instead, passing y = surface + halfHeight so they rest ON the surface.
 */
function placeOn(
  world: World,
  obj: Object3D,
  x: number,
  y: number,
  z: number,
  yaw = 0,
): void {
  obj.position.set(x, y, z);
  if (yaw) obj.rotation.y = yaw;
  world.createTransformEntity(obj);
}

// =============================================================================
// STEP 1 — WATER, BANK, AND SHORE DETAIL
// =============================================================================
function buildWater(world: World): void {
  // ── The river surface ───────────────────────────────────────────────────
  // A long, wide plane running east–west along the whole north edge and well
  // beyond it, so the far bank is out of sight. Transparent teal with high
  // reflectivity (low roughness, some metalness) to read as water.
  // NOTE: no ripple normal-map is applied — there's no water normal texture in
  // assets/. Drop one in and assign `mat.normalMap` here for animated ripples.
  const waterMat = new MeshStandardMaterial({
    color: new Color(WF_COLORS.water),
    transparent: true,
    opacity: 0.75,
    roughness: 0.12, // smooth → reflective
    metalness: 0.6,
  });
  const water = new Mesh(new PlaneGeometry(400, 58), waterMat);
  water.rotation.x = -Math.PI / 2; // lay flat
  // Centre at z=-51 so the near edge sits at z=-22 (the bank toe) and the river
  // extends north to z=-80.
  water.position.set(0, WATER_Y, -51);
  water.receiveShadow = false; // transparent water receiving shadows looks odd
  water.castShadow = false;
  world.createTransformEntity(water);

  // ── Sloped sand/mud bank ────────────────────────────────────────────────
  // A strip bridging land (z=-20, y=0) down to the waterline (z=-22, y=-0.5).
  // Built as a thin box tilted about X so it visibly slopes into the water.
  const bankRun = 3.5; // length of the slope (along Z)
  const drop = -WATER_Y; // 0.5 vertical drop
  const tilt = Math.atan2(drop, bankRun); // slope angle
  const bank = solid(new BoxGeometry(400, 0.2, bankRun), WF_COLORS.sand, {
    roughness: 1,
  });
  bank.castShadow = false;
  // Tilt so the north (water) edge dips down; centre it between shore & water.
  bank.rotation.x = -tilt;
  bank.position.set(0, WATER_Y / 2, (SHORE_Z + WATERLINE_Z) / 2);
  world.createTransformEntity(bank);

  // ── Shore rocks (a few scattered along the bank) ─────────────────────────
  // PLACEHOLDER — low-poly boulders from flat-shaded cones.
  const rockSpots: [number, number, number][] = [
    [-9, -21.2, 0.6],
    [-4.2, -21.6, 0.45],
    [5.5, -21.3, 0.7],
    [10, -21.7, 0.5],
    [2.8, -22.0, 0.4],
  ];
  for (const [x, z, r] of rockSpots) {
    const rock = solid(new ConeGeometry(r, r * 1.1, 5), WF_COLORS.rock, {
      flatShading: true,
    });
    rock.position.set(x, WATER_Y + r * 0.3, z);
    rock.rotation.y = x; // vary orientation
    world.createTransformEntity(rock);
  }

  // ── Reeds / cattails (thin clusters at the water's edge) ─────────────────
  // PLACEHOLDER — bunches of thin cylinders. Kept clear of the dock footprint.
  const reedSpots: [number, number][] = [
    [-12, -21.5],
    [8, -21.8],
    [13, -21.4],
  ];
  for (const [cx, cz] of reedSpots) {
    const clump = new Group();
    for (let i = 0; i < 6; i++) {
      const h = 0.9 + Math.random() * 0.5;
      const reed = solid(new CylinderGeometry(0.03, 0.05, h, 5), WF_COLORS.reed);
      reed.castShadow = false;
      reed.position.set(
        (Math.random() - 0.5) * 0.8,
        WATER_Y + h / 2,
        (Math.random() - 0.5) * 0.8,
      );
      reed.rotation.z = (Math.random() - 0.5) * 0.3;
      clump.add(reed);
    }
    clump.position.set(cx, 0, cz);
    world.createTransformEntity(clump);
  }

  // NOTE: no existing settlement vegetation overlaps the water — the only plant
  // model (plantSansevieria) was removed when the demo scene was replaced, so
  // there is nothing to clear here.
}

// =============================================================================
// STEP 3 — DOCK / PIER (PLACEHOLDER)
// =============================================================================
// Deck runs along Z: land end at z=-19 (resting on the bank), deep-water end at
// z=-33. Walking surface flush with the ground at y=0 (→ 0.5 above the water).
const DOCK_X = 0; // centred on the main path axis (clear sightline to market)
const DOCK_WIDTH = 4;
const DOCK_LAND_Z = -19;
const DOCK_DEEP_Z = -33;

function buildDock(world: World): void {
  const g = new Group();
  const length = DOCK_LAND_Z - DOCK_DEEP_Z; // 14 (positive)
  const thickness = 0.35;

  // Deck slab. Top surface sits at DOCK_TOP_Y (=0), so centre is half a
  // thickness below that.
  const deck = solid(new BoxGeometry(DOCK_WIDTH, thickness, length), COLORS.wood);
  deck.position.set(0, DOCK_TOP_Y - thickness / 2, (DOCK_LAND_Z + DOCK_DEEP_Z) / 2);
  g.add(deck);

  // Plank seams (thin lighter strips across the deck) for a bit of detail.
  for (let z = DOCK_DEEP_Z + 1; z < DOCK_LAND_Z; z += 1.4) {
    const plank = solid(new BoxGeometry(DOCK_WIDTH, 0.04, 0.08), COLORS.woodLight);
    plank.castShadow = false;
    plank.position.set(0, DOCK_TOP_Y + 0.01, z);
    g.add(plank);
  }

  // Pilings: pairs of posts driven from the deck down below the water surface.
  // Only over the water portion (the land end is supported by the bank).
  for (let z = WATERLINE_Z; z >= DOCK_DEEP_Z; z -= 4) {
    for (const sx of [-1, 1]) {
      const post = solid(new CylinderGeometry(0.16, 0.16, 2.4, 8), COLORS.wood);
      // Top just under the deck, extending down to y≈-2.
      post.position.set((sx * DOCK_WIDTH) / 2 - sx * 0.2, DOCK_TOP_Y - 1.2, z);
      g.add(post);
    }
  }

  // Two mooring bollards at the deep end (the ship ties off here).
  for (const sx of [-1, 1]) {
    const bollard = solid(new CylinderGeometry(0.12, 0.14, 0.6, 8), COLORS.wood);
    bollard.position.set(
      (sx * DOCK_WIDTH) / 2 - sx * 0.3,
      DOCK_TOP_Y + 0.3,
      DOCK_DEEP_Z + 0.6,
    );
    g.add(bollard);
  }

  g.position.set(DOCK_X, 0, 0);
  world.createTransformEntity(g);
}

// =============================================================================
// STEP 4 — SHIP (PLACEHOLDER) + GANGPLANK
// =============================================================================
// Ship is built in LOCAL coordinates with its waterline at local y=0 (so ~45%
// of the hull is below local y=0). The group is then placed at y=WATER_Y so the
// waterline lands exactly on the river surface. Long axis = local X = parallel
// to the shoreline (as if it sailed up and moored alongside).
const SHIP_BEAM = 3.2; // width across (Z)
const SHIP_Z = -35.6; // deep-water side; hull near face at z=-34 → 1.0 gap to dock
const SHIP_DECK_LOCAL_Y = 1.0; // deck height above the local waterline
const SHIP_DECK_WORLD_Y = WATER_Y + SHIP_DECK_LOCAL_Y; // = 0.5

function makeShip(): Group {
  const g = new Group();
  const len = 11; // bow-to-stern (X)
  const beam = SHIP_BEAM;
  const hullH = 1.8;

  // Hull: centred so ~45% sits below the local waterline (y=0).
  // bottom = -0.82, top = +0.98  → submerged fraction 0.82/1.8 ≈ 0.46.
  const hull = solid(new BoxGeometry(len, hullH, beam), COLORS.logWall, {
    flatShading: true,
  });
  hull.position.y = 0.08;
  g.add(hull);

  // A narrower keel strip under the hull for a less boxy silhouette.
  const keel = solid(new BoxGeometry(len * 0.8, 0.5, beam * 0.5), COLORS.logWall);
  keel.position.y = -0.95;
  g.add(keel);

  // Deck cap (top of the hull, where the gangplank lands).
  const deck = solid(new BoxGeometry(len - 0.4, 0.2, beam - 0.2), COLORS.plankWall);
  deck.position.y = SHIP_DECK_LOCAL_Y;
  g.add(deck);

  // Bulwarks (low rails). The NORTH side (away from the dock) is a full rail.
  // The SOUTH (dock-facing) side is split, leaving a boarding gap at x≈0 so the
  // gangplank can reach the deck without clipping through a rail.
  const railY = SHIP_DECK_LOCAL_Y + 0.3;
  const railZ = (beam - 0.2) / 2;
  const northRail = solid(new BoxGeometry(len - 0.4, 0.5, 0.15), COLORS.wood);
  northRail.position.set(0, railY, -railZ);
  g.add(northRail);
  for (const sx of [-1, 1]) {
    // Two south-side segments flanking a ~1.6-wide boarding gap.
    const seg = solid(new BoxGeometry((len - 0.4) / 2 - 0.8, 0.5, 0.15), COLORS.wood);
    seg.position.set(sx * ((len - 0.4) / 4 + 0.4), railY, railZ);
    g.add(seg);
  }

  // Stern cabin (raised box toward the -X end).
  const cabin = solid(new BoxGeometry(2.4, 1.2, beam - 0.4), COLORS.plankWall);
  cabin.position.set(-len / 2 + 1.4, SHIP_DECK_LOCAL_Y + 0.7, 0);
  g.add(cabin);

  // Mast + square sail + yard, amidships.
  const mast = solid(new CylinderGeometry(0.12, 0.14, 6, 8), COLORS.wood);
  mast.position.set(0.5, SHIP_DECK_LOCAL_Y + 3, 0);
  g.add(mast);
  const yard = solid(new CylinderGeometry(0.07, 0.07, beam + 0.6, 6), COLORS.wood);
  yard.rotation.x = Math.PI / 2; // run the spar across the beam (Z)
  yard.position.set(0.5, SHIP_DECK_LOCAL_Y + 4.6, 0);
  g.add(yard);
  const sail = solid(new BoxGeometry(0.08, 2.6, beam), COLORS.cloth, {
    roughness: 1,
    doubleSided: true,
  });
  sail.position.set(0.5, SHIP_DECK_LOCAL_Y + 3.3, 0);
  g.add(sail);

  // Bowsprit poking out the +X bow.
  const bowsprit = solid(new CylinderGeometry(0.08, 0.08, 2.2, 6), COLORS.wood);
  bowsprit.rotation.z = Math.PI / 2 - 0.25;
  bowsprit.position.set(len / 2 + 0.7, SHIP_DECK_LOCAL_Y + 0.5, 0);
  g.add(bowsprit);

  return g;
}

/**
 * PLACEHOLDER — gangplank bridging the dock's deep end to the ship's deck.
 * The ship's near hull face is 1.0 unit from the dock edge and the deck is 0.5
 * above the dock, so the plank rises 0.5 over a 1.0 run → ~26.6° (≤ 30°). It
 * reaches full deck height right at the hull face, so it never clips the hull.
 */
function buildGangplank(world: World): void {
  const run = 1.0; // horizontal span = the dock↔hull gap
  const rise = SHIP_DECK_WORLD_Y - DOCK_TOP_Y; // 0.5
  const length = Math.hypot(run, rise); // ≈ 1.118
  const angle = Math.atan2(rise, run); // ≈ 0.46 rad ≈ 26.6°

  const plank = solid(new BoxGeometry(0.8, 0.1, length), COLORS.woodLight);
  // +angle tilts the NORTH (-Z, ship) end UP and the SOUTH (dock) end down.
  plank.rotation.x = angle;
  plank.position.set(DOCK_X, DOCK_TOP_Y + rise / 2, DOCK_DEEP_Z - run / 2);
  world.createTransformEntity(plank);
}

/** PLACEHOLDER — a simple ship's anchor (ring + shank + curved flukes). */
function makeAnchor(): Group {
  const g = new Group();
  const shank = solid(new CylinderGeometry(0.06, 0.06, 1.2, 8), COLORS.metal);
  shank.position.y = 0.6;
  g.add(shank);
  const ring = solid(new TorusGeometry(0.16, 0.04, 6, 12), COLORS.metal);
  ring.position.y = 1.25;
  g.add(ring);
  // Curved arms (a half-torus at the base reads as the flukes).
  const arms = solid(new TorusGeometry(0.4, 0.06, 6, 12, Math.PI), COLORS.metal);
  arms.position.y = 0.1;
  g.add(arms);
  return g;
}

// =============================================================================
// STEP 5 — DOCK PROPS (placed ON the deck surface, y = 0 + half-height)
// =============================================================================
function buildDockProps(world: World): void {
  // Crates & barrels clustered on the LAND half (loading area, z ≈ -20…-24).
  placeOn(world, makeCrate(0.6), DOCK_X - 1.0, 0.3, -21, 0.3);
  placeOn(world, makeBarrel(), DOCK_X + 1.1, 0.4, -21.4);
  placeOn(world, makeBarrel(), DOCK_X + 0.9, 0.4, -22.2);
  placeOn(world, makeCrate(0.5), DOCK_X - 1.1, 0.25, -23, -0.2);

  // A 2-high crate stack near the gangplank (deep end, z ≈ -31).
  placeOn(world, makeCrate(0.7), DOCK_X - 1.0, 0.35, -31, 0.15); // lower (size 0.7)
  placeOn(world, makeCrate(0.55), DOCK_X - 1.0, 0.7 + 0.275, -31, -0.2); // on top

  // Rope coils near the mooring bollards at the deep end (coil height 0.18).
  placeOn(world, makeRopeCoil(), DOCK_X + 1.2, 0.09, -32.4);
  placeOn(world, makeRopeCoil(), DOCK_X - 1.3, 0.09, -32.6);

  // Anchor laid flat on the deck near the ship's bow side (z ≈ -30).
  const anchor = makeAnchor();
  anchor.rotation.x = Math.PI / 2; // lay it down on the deck
  placeOn(world, anchor, DOCK_X + 1.3, 0.07, -30, 0.5);
}

// =============================================================================
// STEP 6 — CONNECTING PATHS + PATH PROPS
// =============================================================================
function flatPath(
  world: World,
  width: number,
  length: number,
  x: number,
  z: number,
  yaw = 0,
): void {
  const path = solid(new PlaneGeometry(width, length), COLORS.dirt, {
    roughness: 1,
  });
  path.rotation.x = -Math.PI / 2;
  path.rotation.z = yaw; // (after the -90° X tilt, Z-rotation yaws the plane)
  path.position.set(x, 0.02, z); // 2cm above grass, like the village paths
  path.castShadow = false;
  world.createTransformEntity(path);
}

function buildPaths(world: World): void {
  // Main dock path: from the dock's land end (z=-19) south to where it meets
  // the settlement's existing main path (which runs z=-17…+17 to the market).
  // Same x=0 axis as both the dock and the market → a clear straight sightline.
  flatPath(world, 3.5, 9, 0, -15.5);

  // Secondary path: branches west off the main path at z=-8 to the storage
  // barn at (-6, -8). Laid along X, so we rotate the plane 90°.
  flatPath(world, 2.5, 6.5, -3.2, -8, Math.PI / 2);

  // ── Path props ───────────────────────────────────────────────────────────
  // 2–3 lantern posts lighting the way up from the dock (lanterns are groups
  // with their base at y=0, so `place()` is fine for them).
  place(world, makeLantern(), 2.2, -17);
  place(world, makeLantern(), -2.2, -13);
  place(world, makeLantern(), 2.2, -9);

  // Signpost at the fork where the barn path branches off.
  place(world, makeSignpost(), 1.4, -7.4, { yaw: -0.6 });

  // A few crates/barrels near the dock end of the path (resting on the ground).
  placeOn(world, makeBarrel(), 2.4, 0.4, -18.6);
  placeOn(world, makeCrate(0.5), -2.3, 0.25, -18.2, 0.4);

  // A parked cart where the path meets the settlement (cart base is at y=0).
  place(world, makeCart(), 2.6, -3.5, { yaw: 1.4 });
}

// =============================================================================
// ENTRY POINT
// =============================================================================
export function buildWaterfront(world: World): void {
  buildWater(world);
  buildDock(world);

  // Ship: place the prebuilt group so its local waterline sits on the river.
  const ship: Object3D = makeShip();
  ship.position.set(0, WATER_Y, SHIP_Z);
  // Long axis already along X (parallel to the shoreline) — no yaw needed.
  world.createTransformEntity(ship);

  buildGangplank(world);
  buildDockProps(world);
  buildPaths(world);
}
