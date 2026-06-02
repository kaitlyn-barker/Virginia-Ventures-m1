/**
 * Settlement.ts — the static environment for the 1620s colonial Virginia
 * settlement. This is the web equivalent of the Unity "ColonialSurvival" scene.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPORTANT: EVERYTHING HERE IS A PLACEHOLDER BUILT FROM THREE.JS PRIMITIVES.
 * ─────────────────────────────────────────────────────────────────────────
 * There are currently NO building or prop GLB/GLTF models in public/gltf/
 * (only the starter's robot, plant, and desk-room demo assets). So every
 * structure and prop below is assembled from boxes, cylinders, cones, etc.
 *
 * Each builder function is self-contained and tagged `PLACEHOLDER`. When you
 * drop real models into public/gltf/, swap the body of the matching builder
 * for an AssetManager.getGLTF(...) clone — the placement coordinates and the
 * facing/scale logic can stay exactly the same.
 *
 * IWSDK rules followed here:
 *  - Three.js types imported from '@iwsdk/core' (never from 'three').
 *  - Entities created via world.createTransformEntity(), never scene.add().
 *  - Ground gets LocomotionEnvironment(STATIC) so the player can walk on it.
 *  - Meshes cast/receive shadows; a sun light + shadow map make them visible.
 * ─────────────────────────────────────────────────────────────────────────
 */

import {
  AmbientLight,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EnvironmentType,
  Group,
  HemisphereLight,
  LocomotionEnvironment,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PCFSoftShadowMap,
  PlaneGeometry,
  type World,
} from '@iwsdk/core';

/* ───────────────────────────── color palette ─────────────────────────────
 * Earthy, period-appropriate tones. Kept in one place so the placeholder
 * settlement reads as a cohesive whole and is easy to retune.
 */
export const COLORS = {
  grass: 0x6b7a3a, // earthy green ground
  dirt: 0x7a5c3e, // brown dirt path
  logWall: 0x6e4b2a, // dark timber
  plankWall: 0x8a6b43, // lighter sawn planks
  roofThatch: 0x9b7d3f, // straw/thatch roof
  roofShingle: 0x4a3b2a, // dark wood shingles
  chimney: 0x7d7468, // grey stone
  wood: 0x5b3f25, // generic wood (posts, barrels, carts)
  woodLight: 0x8a6334, // lighter wood (crates, fences)
  cloth: 0xc9b48a, // awning canvas
  metal: 0x3a3a3a, // dark iron (lantern frames, tools)
  flame: 0xffb24d, // lantern / firepit glow
  rope: 0xb59b6a, // rope coils
  stone: 0x8a857c, // well / firepit ring stone
} as const;

/**
 * Small helper: make a Mesh with shadows enabled. Every solid object in the
 * settlement should both cast and receive shadows, so we set both flags here.
 */
export function solid(
  geometry: ConstructorParameters<typeof Mesh>[0],
  color: number,
  opts: { flatShading?: boolean; roughness?: number; doubleSided?: boolean } = {},
): Mesh {
  const mat = new MeshStandardMaterial({
    color: new Color(color),
    roughness: opts.roughness ?? 0.9,
    flatShading: opts.flatShading ?? false,
    // Only set `side` when double-sided is requested; passing `undefined`
    // triggers a noisy Three.js warning.
    ...(opts.doubleSided ? { side: DoubleSide } : {}),
  });
  const mesh = new Mesh(geometry, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Yaw a group so its "front" (local +Z) faces a target point on the ground.
 * Used to make every building face inward toward the central market/path.
 * Forward +Z rotated by yaw θ about Y becomes (sinθ, 0, cosθ), so the yaw that
 * points +Z at (dx, dz) is atan2(dx, dz).
 */
function faceTowards(
  obj: Object3D,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): void {
  obj.rotation.y = Math.atan2(toX - fromX, toZ - fromZ);
}

// =============================================================================
// LIGHTING — a sun + sky fill, with shadows enabled on the renderer.
// (Required so the "cast/receive shadows" checklist item is actually visible.)
// =============================================================================
function setupLighting(world: World): void {
  // Turn on shadow mapping for the whole scene. Soft (PCF) shadows look better
  // for an outdoor village than hard-edged ones.
  world.renderer.shadowMap.enabled = true;
  world.renderer.shadowMap.type = PCFSoftShadowMap;

  // A light blue daytime sky behind everything (otherwise the void is black).
  world.scene.background = new Color(0x9fc4e8);

  // The "sun": a directional light that casts the settlement's shadows.
  const sun = new DirectionalLight(0xfff2d6, 2.2);
  sun.position.set(12, 18, 8);
  sun.castShadow = true;
  // Frame the shadow camera around the whole village so nothing is clipped.
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 70;
  sun.shadow.camera.left = -25;
  sun.shadow.camera.right = 25;
  sun.shadow.camera.top = 25;
  sun.shadow.camera.bottom = -25;
  sun.shadow.bias = -0.0004; // reduce shadow acne on flat surfaces
  world.createTransformEntity(sun);
  // The directional light aims at its target object; default target is origin
  // (the market center), which is exactly where we want the sun pointed.

  // Sky/ground hemisphere fill so shadowed sides aren't pitch black.
  const sky = new HemisphereLight(0xbcd4f0, 0x4a5a2e, 0.7);
  world.createTransformEntity(sky);

  // A touch of flat ambient to lift the overall exposure.
  world.createTransformEntity(new AmbientLight(0xffffff, 0.25));
}

// =============================================================================
// STEP 1 — GROUND & WALKABLE SURFACE
// =============================================================================
function buildGround(world: World): void {
  // A generous plane for a small village. 40x40m leaves an open central market
  // area and room for the farm plots / future dock.
  const ground = solid(new PlaneGeometry(40, 40), COLORS.grass, {
    roughness: 1,
  });
  ground.rotation.x = -Math.PI / 2; // lay the plane flat (XZ)
  ground.castShadow = false; // ground only RECEIVES shadows
  ground.receiveShadow = true;

  // LocomotionEnvironment(STATIC) is what makes this surface walkable so the
  // player doesn't fall through the world (see CLAUDE.md feature table).
  world
    .createTransformEntity(ground)
    .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC });

  // ── Dirt paths (thin planes laid just above the grass) ──────────────────
  // Main north-south path running through the market center, plus a short
  // east-west spur connecting the two homes to the market.
  const mainPath = solid(new PlaneGeometry(3.5, 34), COLORS.dirt, {
    roughness: 1,
  });
  mainPath.rotation.x = -Math.PI / 2;
  mainPath.position.set(0, 0.02, 0); // 2cm above grass to avoid z-fighting
  mainPath.castShadow = false;
  world.createTransformEntity(mainPath);

  const crossPath = solid(new PlaneGeometry(20, 3), COLORS.dirt, {
    roughness: 1,
  });
  crossPath.rotation.x = -Math.PI / 2;
  crossPath.position.set(0, 0.02, 7);
  crossPath.castShadow = false;
  world.createTransformEntity(crossPath);
}

// =============================================================================
// STEP 2 — BUILDING BUILDERS (all PLACEHOLDER primitive assemblies)
// =============================================================================

/**
 * PLACEHOLDER — Small log cabin (Building 1, the player's home).
 * A simple box body with a pitched (gabled) roof. "Front" faces local +Z.
 */
function makeCabin(): Group {
  const g = new Group();
  const w = 3,
    h = 2.4,
    d = 3;

  const body = solid(new BoxGeometry(w, h, d), COLORS.logWall);
  body.position.y = h / 2;
  g.add(body);

  // Pitched roof: a 4-sided cone reads as a simple gable/hip roof.
  const roof = solid(new ConeGeometry(w * 0.95, 1.3, 4), COLORS.roofThatch, {
    flatShading: true,
  });
  roof.rotation.y = Math.PI / 4; // align the 4 faces with the square walls
  roof.position.y = h + 0.65;
  g.add(roof);

  // Door (dark recess) on the +Z front face.
  const door = solid(new BoxGeometry(0.7, 1.4, 0.1), COLORS.wood);
  door.position.set(0, 0.7, d / 2 + 0.01);
  g.add(door);

  return g;
}

/**
 * PLACEHOLDER — Larger, more established house with a stone chimney
 * (Building 2, Thomas's home). Bigger footprint + shingle roof + chimney.
 */
function makeHouse(): Group {
  const g = new Group();
  const w = 4,
    h = 3,
    d = 4;

  const body = solid(new BoxGeometry(w, h, d), COLORS.plankWall);
  body.position.y = h / 2;
  g.add(body);

  const roof = solid(new ConeGeometry(w * 0.95, 1.7, 4), COLORS.roofShingle, {
    flatShading: true,
  });
  roof.rotation.y = Math.PI / 4;
  roof.position.y = h + 0.85;
  g.add(roof);

  // Stone chimney on the side.
  const chimney = solid(new BoxGeometry(0.7, 2.2, 0.7), COLORS.chimney);
  chimney.position.set(w / 2 - 0.5, h + 0.4, -d / 4);
  g.add(chimney);

  const door = solid(new BoxGeometry(0.8, 1.6, 0.1), COLORS.wood);
  door.position.set(0, 0.8, d / 2 + 0.01);
  g.add(door);

  // Two simple windows flanking the door.
  for (const x of [-1.1, 1.1]) {
    const win = solid(new BoxGeometry(0.6, 0.6, 0.08), COLORS.cloth);
    win.position.set(x, 1.6, d / 2 + 0.01);
    g.add(win);
  }

  return g;
}

/**
 * PLACEHOLDER — Open market / trading-post stall (Building 3).
 * Four corner posts holding a cloth awning over a wooden counter — an open
 * structure for the settlement center.
 */
function makeMarketStall(): Group {
  const g = new Group();
  const w = 3.6,
    d = 3.2,
    postH = 2.2;

  // Four corner posts.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = solid(
        new CylinderGeometry(0.08, 0.08, postH, 8),
        COLORS.wood,
      );
      post.position.set((sx * w) / 2, postH / 2, (sz * d) / 2);
      g.add(post);
    }
  }

  // Sloped cloth awning (a thin box tilted slightly for runoff).
  const awning = solid(new BoxGeometry(w + 0.6, 0.08, d + 0.6), COLORS.cloth, {
    roughness: 1,
    doubleSided: true,
  });
  awning.position.set(0, postH + 0.15, 0);
  awning.rotation.x = -0.12;
  g.add(awning);

  // Wooden sales counter along the front (+Z) edge.
  const counter = solid(new BoxGeometry(w, 0.9, 0.6), COLORS.plankWall);
  counter.position.set(0, 0.45, d / 2 - 0.2);
  g.add(counter);

  return g;
}

/**
 * PLACEHOLDER — Community / storage barn (Building 4).
 * The largest structure: a long box body with a tall gambrel-ish roof, placed
 * near the (future) dock area.
 */
function makeBarn(): Group {
  const g = new Group();
  const w = 6,
    h = 4,
    d = 8;

  const body = solid(new BoxGeometry(w, h, d), COLORS.logWall);
  body.position.y = h / 2;
  g.add(body);

  // Long roof ridge: a 3-sided prism (triangular cross-section) along Z.
  const roof = solid(new CylinderGeometry(w * 0.62, w * 0.62, d, 3), COLORS.roofShingle, {
    flatShading: true,
  });
  roof.rotation.z = Math.PI / 6; // point one flat face down to seat on walls
  roof.rotation.x = Math.PI / 2; // run the ridge along Z (length of barn)
  roof.position.y = h + 0.9;
  g.add(roof);

  // Big barn doors on the +Z front.
  const doors = solid(new BoxGeometry(2.4, 2.8, 0.12), COLORS.wood);
  doors.position.set(0, 1.4, d / 2 + 0.01);
  g.add(doors);

  return g;
}

// =============================================================================
// STEP 3 — PROP BUILDERS (all PLACEHOLDER primitive assemblies)
// =============================================================================

/** PLACEHOLDER — a single wooden barrel. */
export function makeBarrel(): Mesh {
  return solid(new CylinderGeometry(0.32, 0.28, 0.8, 12), COLORS.wood);
}

/** PLACEHOLDER — a stacked woodpile. `rows`/`logs` control its size. */
function makeWoodpile(rows = 2, logs = 4): Group {
  const g = new Group();
  const r = 0.12,
    len = 1.6;
  for (let row = 0; row < rows; row++) {
    for (let i = 0; i < logs; i++) {
      const log = solid(new CylinderGeometry(r, r, len, 8), COLORS.wood);
      log.rotation.z = Math.PI / 2; // lay logs horizontally
      log.position.set(0, r + row * (r * 2), -((logs - 1) * r) + i * (r * 2.05));
      g.add(log);
    }
  }
  return g;
}

/** PLACEHOLDER — a small crate. */
export function makeCrate(size = 0.6): Mesh {
  return solid(new BoxGeometry(size, size, size), COLORS.woodLight, {
    flatShading: true,
  });
}

/** PLACEHOLDER — a post-mounted lantern (glowing box on a short pole). */
export function makeLantern(): Group {
  const g = new Group();
  const pole = solid(new CylinderGeometry(0.04, 0.04, 1.4, 6), COLORS.metal);
  pole.position.y = 0.7;
  g.add(pole);
  const light = new Mesh(
    new BoxGeometry(0.18, 0.24, 0.18),
    new MeshStandardMaterial({
      color: new Color(COLORS.flame),
      emissive: new Color(COLORS.flame),
      emissiveIntensity: 0.8,
    }),
  );
  light.position.y = 1.45;
  g.add(light);
  return g;
}

/** PLACEHOLDER — a low garden / paddock fence ring of `count` posts+rails. */
function makeFence(width = 3, depth = 2.5): Group {
  const g = new Group();
  const postH = 0.7;
  const corners: [number, number][] = [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ];
  // Posts at each corner + midpoints.
  for (const [x, z] of corners) {
    const post = solid(new BoxGeometry(0.1, postH, 0.1), COLORS.woodLight);
    post.position.set(x, postH / 2, z);
    g.add(post);
  }
  // Rails: two long sides (skip the front so it reads as a gated plot).
  const sideRail = () =>
    solid(new BoxGeometry(0.06, 0.08, depth), COLORS.woodLight);
  const backRail = solid(new BoxGeometry(width, 0.08, 0.06), COLORS.woodLight);
  const left = sideRail();
  left.position.set(-width / 2, postH * 0.7, 0);
  const right = sideRail();
  right.position.set(width / 2, postH * 0.7, 0);
  backRail.position.set(0, postH * 0.7, -depth / 2);
  g.add(left, right, backRail);
  return g;
}

/** PLACEHOLDER — a wheelbarrow / hand cart (box bin on a wheel + handles). */
export function makeCart(): Group {
  const g = new Group();
  const bin = solid(new BoxGeometry(1.1, 0.5, 0.7), COLORS.wood);
  bin.position.set(0, 0.55, 0);
  g.add(bin);
  const wheel = solid(new CylinderGeometry(0.3, 0.3, 0.12, 12), COLORS.metal);
  wheel.rotation.x = Math.PI / 2;
  wheel.position.set(0, 0.3, 0.55);
  g.add(wheel);
  for (const sx of [-0.4, 0.4]) {
    const handle = solid(new CylinderGeometry(0.04, 0.04, 1.0, 6), COLORS.wood);
    handle.rotation.x = Math.PI / 2.3;
    handle.position.set(sx, 0.6, -0.6);
    g.add(handle);
  }
  return g;
}

/** PLACEHOLDER — leaning tools (a couple of angled poles). */
function makeTools(): Group {
  const g = new Group();
  for (const [x, tilt, color] of [
    [-0.1, 0.2, COLORS.wood],
    [0.12, -0.15, COLORS.metal],
  ] as const) {
    const handle = solid(new CylinderGeometry(0.04, 0.04, 1.6, 6), color);
    handle.position.set(x, 0.8, 0);
    handle.rotation.z = tilt;
    g.add(handle);
  }
  return g;
}

/** PLACEHOLDER — a chicken coop (small hutch box with a sloped lid). */
function makeChickenCoop(): Group {
  const g = new Group();
  const body = solid(new BoxGeometry(1.4, 0.9, 1.0), COLORS.woodLight);
  body.position.y = 0.45;
  g.add(body);
  const lid = solid(new BoxGeometry(1.5, 0.08, 1.1), COLORS.roofShingle);
  lid.position.set(0, 0.95, 0);
  lid.rotation.x = -0.12;
  g.add(lid);
  return g;
}

/** PLACEHOLDER — a signpost (post + angled board). */
export function makeSignpost(): Group {
  const g = new Group();
  const post = solid(new CylinderGeometry(0.07, 0.07, 2.0, 8), COLORS.wood);
  post.position.y = 1.0;
  g.add(post);
  const board = solid(new BoxGeometry(1.0, 0.4, 0.06), COLORS.woodLight);
  board.position.set(0.3, 1.7, 0);
  g.add(board);
  return g;
}

/** PLACEHOLDER — a coil of rope (a flat torus would need TorusGeometry; use a short fat cylinder). */
export function makeRopeCoil(): Mesh {
  const coil = solid(new CylinderGeometry(0.35, 0.4, 0.18, 14), COLORS.rope);
  return coil;
}

/** PLACEHOLDER — a loading platform (low wooden deck). */
function makeLoadingPlatform(): Mesh {
  const deck = solid(new BoxGeometry(3, 0.3, 2), COLORS.plankWall);
  return deck;
}

/** PLACEHOLDER — a covered well in the village center (ring + posts + roof). */
function makeWell(): Group {
  const g = new Group();
  const ring = solid(new CylinderGeometry(0.7, 0.7, 0.8, 16), COLORS.stone);
  ring.position.y = 0.4;
  g.add(ring);
  for (const sx of [-0.6, 0.6]) {
    const post = solid(new CylinderGeometry(0.06, 0.06, 1.8, 6), COLORS.wood);
    post.position.set(sx, 0.9, 0);
    g.add(post);
  }
  const roof = solid(new ConeGeometry(1.0, 0.7, 4), COLORS.roofThatch, {
    flatShading: true,
  });
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 2.1;
  g.add(roof);
  return g;
}

/** PLACEHOLDER — a single hitching post. */
function makeHitchingPost(): Mesh {
  const post = solid(new CylinderGeometry(0.07, 0.07, 1.1, 8), COLORS.wood);
  return post;
}

/** PLACEHOLDER — a fire pit with a stone ring and log seating. */
function makeFirePit(): Group {
  const g = new Group();
  // Stone ring (several small stones around a circle).
  const stoneCount = 10;
  for (let i = 0; i < stoneCount; i++) {
    const a = (i / stoneCount) * Math.PI * 2;
    const stone = solid(new BoxGeometry(0.25, 0.2, 0.25), COLORS.stone, {
      flatShading: true,
    });
    stone.position.set(Math.cos(a) * 0.7, 0.1, Math.sin(a) * 0.7);
    stone.rotation.y = a;
    g.add(stone);
  }
  // Glowing embers in the middle.
  const embers = new Mesh(
    new ConeGeometry(0.3, 0.4, 8),
    new MeshStandardMaterial({
      color: new Color(COLORS.flame),
      emissive: new Color(COLORS.flame),
      emissiveIntensity: 1.0,
    }),
  );
  embers.position.y = 0.2;
  g.add(embers);
  // Two log seats.
  for (const [x, z, rot] of [
    [1.3, 0, Math.PI / 2],
    [-1.3, 0, Math.PI / 2],
  ] as const) {
    const log = solid(new CylinderGeometry(0.18, 0.18, 1.4, 8), COLORS.wood);
    log.rotation.z = Math.PI / 2;
    log.rotation.y = rot;
    log.position.set(x, 0.18, z);
    g.add(log);
  }
  return g;
}

// =============================================================================
// PLACEMENT — lay out buildings + props around the central market.
// =============================================================================

/**
 * Place a pre-built Group/Mesh in the world at (x, z) on the ground (y from the
 * object's own geometry, base at 0), optionally facing the market center, at a
 * uniform scale. Returns the created entity in case the caller wants it.
 */
export function place(
  world: World,
  obj: Object3D,
  x: number,
  z: number,
  opts: { faceCenter?: boolean; scale?: number; yaw?: number } = {},
): void {
  if (opts.scale) obj.scale.setScalar(opts.scale);
  obj.position.set(x, 0, z);
  if (opts.faceCenter) faceTowards(obj, x, z, 0, 0);
  if (opts.yaw !== undefined) obj.rotation.y = opts.yaw;
  world.createTransformEntity(obj);
}

export function buildSettlement(world: World): void {
  setupLighting(world);
  buildGround(world);

  // ── BUILDINGS (all flush on the ground at y=0, scaled consistently, facing
  //    inward toward the central market at the origin) ─────────────────────

  // Building 1 — Player's home: smallest cabin, SW plot near the farm area.
  place(world, makeCabin(), -7, 7, { faceCenter: true });

  // Building 2 — Thomas's home: larger house w/ chimney, SE plot across path.
  place(world, makeHouse(), 7, 7, { faceCenter: true });

  // Building 3 — Market / trading post: open stall in the settlement center.
  place(world, makeMarketStall(), 0, 0, { faceCenter: false });

  // Building 4 — Community / storage barn: north end near the future dock.
  place(world, makeBarn(), -6, -8, { faceCenter: true });

  // Optional small structures for realism.
  place(world, makeWell(), 0, 4, {}); // covered well in the center
  place(world, makeChickenCoop(), 9.5, 8.5, { yaw: -0.6 }); // by Thomas's home

  // ── PROPS around the PLAYER'S HOME (-7, 7) ───────────────────────────────
  place(world, makeWoodpile(2, 4), -9, 6, { yaw: 0.3 });
  place(world, makeBarrel(), -8.6, 8.2); // water barrel
  place(world, makeFence(3, 2.5), -7, 9.5); // small garden plot behind home
  place(world, makeLantern(), -5.7, 8.0); // lantern by the door

  // ── PROPS around THOMAS'S HOME (7, 7) ────────────────────────────────────
  place(world, makeWoodpile(3, 5), 9.2, 6, { yaw: -0.3 }); // larger woodpile
  place(world, makeCart(), 8.6, 8.4, { yaw: 1.2 }); // hand cart
  place(world, makeTools(), 5.6, 8.6, { yaw: 0.4 }); // tools against wall

  // ── PROPS in the MARKET area (center) ────────────────────────────────────
  place(world, makeCrate(0.6), 1.2, 0.6, { yaw: 0.4 });
  place(world, makeCrate(0.5), 1.6, 1.0, { yaw: -0.3 });
  place(world, makeBarrel(), -1.3, 0.8);
  place(world, makeBarrel(), -1.5, 0.2);
  place(world, makeLantern(), 1.9, -1.7); // hanging-style lantern post
  place(world, makeLantern(), -1.9, -1.7);
  place(world, makeSignpost(), 2.4, 2.6, { yaw: -0.5 });

  // ── PROPS around the STORAGE BARN (-6, -8), facing toward the dock path ──
  place(world, makeBarrel(), -3.4, -6.6);
  place(world, makeBarrel(), -3.0, -7.0);
  place(world, makeCrate(0.7), -3.6, -7.6, { yaw: 0.2 });
  place(world, makeRopeCoil(), -3.2, -8.2);
  place(world, makeLoadingPlatform(), -2.4, -9.2, { yaw: 0 }); // toward dock

  // ── GENERAL: hitching posts along the main path + a fire pit gathering ───
  for (const z of [10, 5, -2]) {
    place(world, makeHitchingPost(), 2.2, z);
    place(world, makeHitchingPost(), -2.2, z);
  }
  place(world, makeFirePit(), -3.5, 3); // communal fire pit with log seating
}
