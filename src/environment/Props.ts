/**
 * Props.ts — extra scenery for the settlement.
 *
 * Everything here is built from the SAME flat-shaded Three.js primitives and the
 * SAME earthy palette as the rest of the village — it reuses Settlement.ts's
 * `solid()` helper and `COLORS` table — so the props read as one cohesive,
 * blocky low-poly world. (An earlier version dropped in photoscanned GLB models;
 * they clashed badly with the hand-built art, so they were removed in favour of
 * these matching prefabs.)
 *
 * Each prefab is a small `Group` whose base sits at local y=0, so `place()` can
 * drop it straight on the ground at any (x, z).
 */

import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  World,
} from '@iwsdk/core';

import { COLORS, solid } from './Settlement.js';

// Conifer greens. The shared palette is deliberately earthy (its only green is
// the yellowish `grass`), so these two deeper greens give the foliage some depth
// while still sitting in the same family.
const PINE_DARK = 0x3c5528;
const PINE_MID = 0x4e6b34;

/** A faceted conifer: a short trunk under three stacked foliage cones (~2.9m). */
function makePineTree(): Group {
  const g = new Group();
  const trunk = solid(new CylinderGeometry(0.12, 0.18, 0.9, 6), COLORS.logWall, {
    flatShading: true,
  });
  trunk.position.y = 0.45;
  g.add(trunk);
  const tiers = [
    { y: 1.05, r: 0.95, h: 1.2, c: PINE_DARK },
    { y: 1.75, r: 0.72, h: 1.1, c: PINE_MID },
    { y: 2.4, r: 0.48, h: 1.0, c: PINE_MID },
  ];
  for (const t of tiers) {
    const cone = solid(new ConeGeometry(t.r, t.h, 7), t.c, { flatShading: true });
    cone.position.y = t.y;
    g.add(cone);
  }
  return g;
}

/** A wooden barrel: a staved cylinder banded with two iron hoops (~0.7m). */
function makeBarrel(): Group {
  const g = new Group();
  const body = solid(new CylinderGeometry(0.26, 0.26, 0.72, 9), COLORS.wood, {
    flatShading: true,
  });
  body.position.y = 0.36;
  g.add(body);
  for (const y of [0.16, 0.56]) {
    const hoop = solid(new CylinderGeometry(0.28, 0.28, 0.07, 9), COLORS.metal, {
      flatShading: true,
    });
    hoop.position.y = y;
    g.add(hoop);
  }
  return g;
}

/** A cargo crate: a plank box with a darker edge band (~0.6m). */
function makeCrate(): Group {
  const g = new Group();
  const s = 0.6;
  const box = solid(new BoxGeometry(s, s, s), COLORS.woodLight, { flatShading: true });
  box.position.y = s / 2;
  g.add(box);
  const band = solid(new BoxGeometry(s + 0.03, 0.07, s + 0.03), COLORS.wood);
  band.position.y = s / 2;
  g.add(band);
  return g;
}

/** A small chest: a box base, a lid, and a gold latch. */
function makeChest(): Group {
  const g = new Group();
  const w = 0.62;
  const d = 0.42;
  const baseH = 0.3;
  const base = solid(new BoxGeometry(w, baseH, d), COLORS.wood, { flatShading: true });
  base.position.y = baseH / 2;
  g.add(base);
  const lid = solid(new BoxGeometry(w, 0.15, d), COLORS.woodLight, { flatShading: true });
  lid.position.y = baseH + 0.075;
  g.add(lid);
  const latch = solid(new BoxGeometry(0.1, 0.16, 0.05), COLORS.flame);
  latch.position.set(0, baseH, d / 2 + 0.01);
  g.add(latch);
  return g;
}

/** A frontier log cabin — the SAME box-body + 4-sided-cone-roof + door recipe
 *  the Settlement.ts homes use, so it sits seamlessly among them. */
function makeCabin(): Group {
  const g = new Group();
  const w = 3;
  const d = 2.6;
  const h = 1.8;
  const body = solid(new BoxGeometry(w, h, d), COLORS.logWall, { flatShading: true });
  body.position.y = h / 2;
  g.add(body);
  const roof = solid(new ConeGeometry(w * 0.95, 1.3, 4), COLORS.roofShingle, {
    flatShading: true,
  });
  roof.rotation.y = Math.PI / 4; // align the 4 faces with the square walls
  roof.position.y = h + 0.65;
  g.add(roof);
  const door = solid(new BoxGeometry(0.7, 1.3, 0.1), COLORS.wood);
  door.position.set(0, 0.65, d / 2 + 0.01);
  g.add(door);
  return g;
}

/** A blocky trade ship for the river — dark hull, plank deck, mast + square
 *  sail — built in the same palette as the dock's boat (Waterfront.ts). Built
 *  with its waterline at local y≈0.1, so place it at the water surface. */
function makeShip(): Group {
  const g = new Group();
  const hull = solid(new BoxGeometry(2.2, 1.2, 5.4), COLORS.logWall, {
    flatShading: true,
  });
  hull.position.y = 0.6;
  g.add(hull);
  // A raised, tilted prow block at the bow.
  const prow = solid(new BoxGeometry(2.0, 1.1, 1.2), COLORS.logWall, {
    flatShading: true,
  });
  prow.position.set(0, 0.95, -3.0);
  prow.rotation.x = -0.3;
  g.add(prow);
  const deck = solid(new BoxGeometry(1.9, 0.14, 5.0), COLORS.plankWall);
  deck.position.y = 1.22;
  g.add(deck);
  const mast = solid(new CylinderGeometry(0.07, 0.1, 4.2, 6), COLORS.wood);
  mast.position.set(0, 3.2, 0.4);
  g.add(mast);
  const yard = solid(new CylinderGeometry(0.05, 0.05, 2.4, 6), COLORS.wood);
  yard.rotation.z = Math.PI / 2;
  yard.position.set(0, 4.0, 0.4);
  g.add(yard);
  const sail = solid(new BoxGeometry(0.06, 2.0, 2.2), COLORS.cloth, {
    doubleSided: true,
  });
  sail.position.set(0, 3.2, 0.4);
  g.add(sail);
  return g;
}

/** Drop a prefab on the ground at (x, z), optionally scaled + yaw-rotated. */
function place(
  world: World,
  make: () => Group,
  x: number,
  z: number,
  opts: { y?: number; scale?: number; rotY?: number } = {},
): void {
  const obj = make();
  if (opts.scale) obj.scale.setScalar(opts.scale);
  obj.position.set(x, opts.y ?? 0, z);
  if (opts.rotY) obj.rotation.y = opts.rotY;
  world.createTransformEntity(obj);
}

/** Populate the settlement with the matching prefab scenery. Call after the
 *  primitive settlement + waterfront + colonists are built. */
export function buildProps(world: World): void {
  // ── A pine treeline ringing the ~40x40m clearing ────────────────────────
  const TREES: [number, number][] = [
    [-18, -16], [-18, -8], [-18, 0], [-18, 9], [-18, 17],
    [18, -16], [18, -8], [18, 1], [18, 9], [18, 17],
    [-12, -18], [-4, -18.5], [5, -18], [13, -18.5],
    [-13, 18], [4, 18.5], [13, 18],
  ];
  TREES.forEach(([x, z], i) =>
    place(world, makePineTree, x, z, {
      scale: 0.92 + (i % 3) * 0.2,
      rotY: (i * 2.39) % (Math.PI * 2),
    }),
  );

  // ── Yard clutter: barrels + crates near the market and off the path ──────
  place(world, makeBarrel, 6.4, 3.0, { rotY: 0.3 });
  place(world, makeBarrel, 7.0, 3.5, { rotY: 1.2 });
  place(world, makeCrate, 7.2, 2.3, { rotY: 0.6 });
  place(world, makeCrate, -8.6, 4.2, { rotY: 2.1 });
  place(world, makeBarrel, -8.0, 4.7, { rotY: 0.2 });

  // ── A chest as colonial flavor on the eastern grass ──────────────────────
  place(world, makeChest, 9.0, 6.0, { rotY: -0.6 });

  // ── A trade ship anchored out on the river (water surface y=-0.5) ────────
  place(world, makeShip, -9, -42, { y: -0.55, rotY: 0.5 });

  // ── Two frontier cabins filling the open edges of the clearing ───────────
  place(world, makeCabin, -16.5, 5, { rotY: 1.2 });
  place(world, makeCabin, 16.5, 9, { rotY: -1.4 });
}
