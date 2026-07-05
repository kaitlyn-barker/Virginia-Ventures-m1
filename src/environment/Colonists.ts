/**
 * Colonists.ts — the colonist NPCs for the 1620s colonial Virginia settlement.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPORTANT: THESE ARE PLACEHOLDER LOW-POLY HUMANOIDS (no character GLBs).
 * ─────────────────────────────────────────────────────────────────────────
 * There are NO rigged character models in public/gltf/ (only the starter
 * robot/plant/desk), and Meta's asset library returned only static objects
 * (porcelain dolls, clothing items) — none rigged or animated. So each colonist
 * here is assembled from Three.js primitives (boxes/cylinders/spheres).
 *
 * Consequence for STEP 3 (idle animation): primitives carry NO animation clips,
 * so there is nothing to play. Per the brief ("if a model has no idle clip,
 * leave it static and flag it"), every NPC is STATIC. They are modelled in a
 * relaxed standing pose — arms hang slightly out at the sides, NOT a T-pose.
 *
 * What IS honoured fully:
 *  - Per-NPC clothing tints applied to clothing regions only (each clothing
 *    part is its own mesh/material — skin is always separate, never tinted).
 *  - Matte materials (high roughness, no emissive) — never neon/glowing.
 *  - Varied skin tones for diversity.
 *  - Role-based size variation (James broader, Captain taller, children short).
 *  - Period-appropriate silhouettes (shirts/breeches, long dresses + aprons,
 *    bonnets, wide-brim/tricorn/straw hats, a long coat for the Captain).
 *
 * Swap-in path: when you add rigged colonist GLBs, replace makeColonist() with
 * AssetManager.getGLTF(...) clones and play their idle clips; the placement
 * table at the bottom can stay as-is.
 * ─────────────────────────────────────────────────────────────────────────
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Object3D,
  SphereGeometry,
  type World,
} from '@iwsdk/core';

// Reuse the settlement's shadow-enabled, matte mesh helper.
import { solid } from './Settlement.js';

// P2.3 "cheap life": tag most colonists so IdleMotionSystem gives them a subtle
// idle sway/bob. Script-driven figures (Captain, Smuggler) opt out.
import { AmbientSway } from '../systems/IdleMotionSystem.js';

// ── Palettes ────────────────────────────────────────────────────────────────
// Skin tones (varied for diversity; Captain & Anne lighter, Thomas & James more
// tanned, per the brief). Never tinted by clothing colours.
const SKIN = {
  light: 0xe7c6a3,
  medium: 0xc89a6e,
  tan: 0xa9794d,
  dark: 0x8a5e38,
} as const;

const HAIR = {
  brown: 0x4a3526,
  grey: 0x9a958c,
  black: 0x2a2420,
  sandy: 0x8a6a3f,
} as const;

// Clothing colours straight from the brief (matte; applied to cloth only).
const C = {
  offWhite: 0xd4c9a8,
  warmBrown: 0x6b4f3a,
  darkLeather: 0x3d2b1f,
  sage: 0x7a8b6f,
  cream: 0xe8dcc8,
  charcoal: 0x4a4a4a,
  burgundy: 0x6b3a3a,
  forest: 0x3a5a3a,
  navy: 0x1b2a4a,
  darkGold: 0x8b7332,
  fadedTan: 0xb8a88a,
  headCream: 0xe0d5c0,
  grayBlue: 0x6b7b8a,
  fadedSage: 0x7a8b6f,
  sailorNavy: 0x2e3a4a,
  fadedBrown: 0x6b5b4a,
  smuggler: 0x2e2419,
} as const;

// Prop materials (held items). Brown is the default per the brief; gray for
// metal tool blades/heads, green for herb foliage, cream for the scroll.
const PROP = {
  brown: 0x6b4f3a, // default wood / leather / basket weave
  darkBrown: 0x3d2b1f, // smuggler's pouch, book leather
  gray: 0x8a857c, // hoe blade, hammer head, trowel scoop (iron)
  green: 0x3f6a2c, // herbs in the basket
  cream: 0xe8dcc8, // rolled scroll / document
} as const;

// Small matte part helper (flat-shaded for a crisp low-poly look by default).
function part(
  geo: ConstructorParameters<typeof import('@iwsdk/core').Mesh>[0],
  color: number,
  flat = true,
) {
  return solid(geo, color, { flatShading: flat });
}

type HatType = 'wide' | 'tricorn' | 'straw' | 'bonnet' | 'cap' | 'low';

/**
 * A held prop, parented to a colonist's hand mesh (the primitive equivalent of
 * a hand bone — there is no rigged skeleton here). `build` returns a Group whose
 * local origin is the grip point. `pos`/`rot` place that grip relative to the
 * hand centre. Note: model "front" is local +Z, so the colonist's anatomical
 * RIGHT hand sits on −X (sx = −1) and the LEFT hand on +X (sx = +1).
 */
interface PropSpec {
  build: () => Object3D;
  hand: 'left' | 'right';
  pos?: [number, number, number];
  rot?: [number, number, number];
}

interface ColonistOpts {
  name?: string; // optional label on the Group (and "<name>-prop" on the prop)
  prop?: PropSpec;
  skin: number;
  shirt: number; // torso colour when no coat/dress
  legs?: number; // breeches colour (ignored if `dress` set)
  belt?: number;
  apron?: number; // front panel (blacksmith/herbalist)
  vest?: number; // bodice/vest overlay (Anne)
  coat?: number; // long coat (Captain)
  trim?: number; // coat collar + button strips
  boots?: number;
  dress?: number; // long flared dress (female)
  headwrap?: number;
  hair?: number;
  hat?: { type: HatType; color: number };
  broad?: boolean; // wider torso/limbs (James)
  beard?: number; // optional beard colour (lower face)
  armTilt?: number; // (kept for compatibility; arms are vertical Minecraft-style)
}

/**
 * Build one relaxed-standing colonist from primitives. Feet rest at local y=0
 * so the group can be dropped straight onto the ground (or dock/deck via a y
 * offset), and uniform scaling keeps the feet grounded.
 */
function makeColonist(o: ColonistOpts): Group {
  const g = new Group();
  if (o.name) g.name = o.name;
  const bw = o.broad ? 1.16 : 1; // body-width factor
  const hipY = 0.85;

  // ── Lower body: a blocky skirt, or two box breeches legs (+ optional boots) ─
  if (o.dress !== undefined) {
    // Blocky skirt (Minecraft-style box, not a smooth cone).
    const skirt = part(new BoxGeometry(0.5, hipY + 0.05, 0.3), o.dress);
    skirt.position.y = (hipY + 0.05) / 2;
    g.add(skirt);
  } else {
    const legColor = o.legs ?? o.shirt;
    for (const sx of [-1, 1]) {
      const leg = part(new BoxGeometry(0.19 * bw, hipY, 0.2), legColor);
      leg.position.set(sx * 0.11, hipY / 2, 0);
      g.add(leg);
      if (o.boots !== undefined) {
        const boot = part(new BoxGeometry(0.17 * bw, 0.22, 0.26), o.boots);
        boot.position.set(sx * 0.1, 0.11, 0.03);
        g.add(boot);
      }
    }
  }

  // ── Torso ────────────────────────────────────────────────────────────────
  const torsoColor = o.dress ?? o.coat ?? o.shirt;
  const torsoH = 0.56;
  const torsoY = hipY + torsoH / 2; // 1.13
  const torso = part(new BoxGeometry(0.42 * bw, torsoH, 0.24), torsoColor);
  torso.position.y = torsoY;
  g.add(torso);
  const torsoTopY = hipY + torsoH; // 1.41

  // ── Long coat (Captain) — hangs from chest to mid-thigh, with trim ───────
  if (o.coat !== undefined) {
    const coat = part(new BoxGeometry(0.46 * bw, 1.0, 0.27), o.coat);
    coat.position.y = 0.9;
    g.add(coat);
    if (o.trim !== undefined) {
      const collar = part(new BoxGeometry(0.22, 0.1, 0.29), o.trim);
      collar.position.y = torsoTopY - 0.03;
      g.add(collar);
      for (const sx of [-0.06, 0.06]) {
        const strip = part(new BoxGeometry(0.03, 0.75, 0.02), o.trim);
        strip.position.set(sx, torsoY - 0.05, 0.145);
        g.add(strip);
      }
    }
  }

  // ── Apron (front panel) ──────────────────────────────────────────────────
  if (o.apron !== undefined) {
    const apron = part(new BoxGeometry(0.3 * bw, 0.72, 0.06), o.apron);
    apron.position.set(0, hipY + 0.06, 0.13);
    g.add(apron);
  }

  // ── Vest / bodice overlay ────────────────────────────────────────────────
  if (o.vest !== undefined) {
    const vest = part(new BoxGeometry(0.44 * bw, 0.5, 0.27), o.vest);
    vest.position.y = torsoY + 0.02;
    g.add(vest);
  }

  // ── Belt ─────────────────────────────────────────────────────────────────
  if (o.belt !== undefined) {
    const belt = part(new BoxGeometry(0.45 * bw, 0.1, 0.26), o.belt);
    belt.position.y = hipY + 0.02;
    g.add(belt);
  }

  // ── Arms: blocky sleeves with a skin "hand" band at the wrist (Minecraft
  //    style). Vertical at the sides — never a T-pose. ──────────────────────
  const sleeveColor = o.coat ?? o.shirt;
  const armW = 0.19 * bw;
  const armX = 0.21 * bw + armW / 2 - 0.02;
  const sleeveLen = 0.44;
  let rightHand: Object3D | undefined; // sx = −1 (colonist's anatomical right)
  let leftHand: Object3D | undefined; //  sx = +1 (colonist's anatomical left)
  for (const sx of [-1, 1]) {
    const sleeve = part(new BoxGeometry(armW, sleeveLen, 0.2), sleeveColor);
    sleeve.position.set(sx * armX, torsoTopY - sleeveLen / 2, 0);
    g.add(sleeve);
    const hand = part(new BoxGeometry(armW, 0.12, 0.2), o.skin);
    hand.position.set(sx * armX, torsoTopY - sleeveLen - 0.06, 0);
    g.add(hand);
    if (sx === -1) rightHand = hand;
    else leftHand = hand;
  }

  // ── Head: a blocky cube + a painted face ─────────────────────────────────
  const headSize = 0.42;
  const headHalf = headSize / 2;
  const headY = torsoTopY + headHalf + 0.02;
  const head = part(new BoxGeometry(headSize, headSize, headSize), o.skin);
  head.position.y = headY;
  g.add(head);
  buildFace(g, headY, headHalf, o);

  // Hair as box shells on top + back (skipped when a hat covers the head).
  if (o.hair !== undefined && !o.hat) {
    const hairTop = part(
      new BoxGeometry(headSize + 0.03, 0.12, headSize + 0.03),
      o.hair,
    );
    hairTop.position.y = headY + headHalf - 0.04;
    g.add(hairTop);
    const hairBack = part(
      new BoxGeometry(headSize + 0.03, headSize * 0.7, 0.06),
      o.hair,
    );
    hairBack.position.set(0, headY + 0.05, -headHalf - 0.005);
    g.add(hairBack);
  }

  if (o.headwrap !== undefined) {
    const wrap = part(
      new BoxGeometry(headSize + 0.04, 0.14, headSize + 0.04),
      o.headwrap,
    );
    wrap.position.y = headY + headHalf - 0.05;
    g.add(wrap);
  }

  if (o.hat) addHat(g, o.hat, headY);

  // ── Held prop: parent to the chosen hand mesh so it tracks that hand (it
  //    would follow an idle animation too, were these models rigged). ────────
  if (o.prop) {
    const target = o.prop.hand === 'right' ? rightHand : leftHand;
    if (target) {
      const prop = o.prop.build();
      prop.name = `${o.name ?? 'colonist'}-prop`;
      if (o.prop.pos) prop.position.set(...o.prop.pos);
      if (o.prop.rot) prop.rotation.set(...o.prop.rot);
      target.add(prop);
    }
  }

  return g;
}

/**
 * Paint a simple blocky face on the head's front (+Z) face: white eyes with
 * dark pupils, eyebrows, a small protruding nose, a mouth, and an optional
 * beard. Everything is a thin box sitting just proud of the head surface.
 */
function buildFace(g: Group, headY: number, headHalf: number, o: ColonistOpts) {
  const z = headHalf + 0.001; // flush against the front face
  const browColor = o.hair ?? 0x3a2a1c;
  for (const sx of [-1, 1]) {
    const eyeX = sx * 0.085;
    // White sclera (modest, realistic proportions on the 0.42 head).
    const sclera = part(new BoxGeometry(0.062, 0.05, 0.02), 0xf2efe6);
    sclera.position.set(eyeX, headY + 0.045, z);
    g.add(sclera);
    // Dark pupil, nudged slightly forward + outward.
    const pupil = part(new BoxGeometry(0.028, 0.034, 0.02), 0x2a2018);
    pupil.position.set(eyeX + sx * 0.008, headY + 0.045, z + 0.012);
    g.add(pupil);
    // Eyebrow.
    const brow = part(new BoxGeometry(0.078, 0.02, 0.02), browColor);
    brow.position.set(eyeX, headY + 0.096, z);
    g.add(brow);
  }
  // Nose (skin, protruding).
  const nose = part(new BoxGeometry(0.05, 0.07, 0.05), o.skin);
  nose.position.set(0, headY - 0.01, z + 0.01);
  g.add(nose);
  // Mouth.
  const mouth = part(new BoxGeometry(0.12, 0.025, 0.02), 0x5a3d30);
  mouth.position.set(0, headY - 0.1, z);
  g.add(mouth);
  // Optional beard across the lower face/chin.
  if (o.beard !== undefined) {
    const beard = part(new BoxGeometry(0.36, 0.18, 0.07), o.beard);
    beard.position.set(0, headY - 0.13, headHalf - 0.025);
    g.add(beard);
  }
}

/** Add a blocky, Minecraft-style period hat at the given head height. */
function addHat(g: Group, hat: { type: HatType; color: number }, headY: number) {
  const c = hat.color;
  const top = headY + 0.21; // ≈ top of the head cube
  if (hat.type === 'wide' || hat.type === 'straw' || hat.type === 'low') {
    const brim = part(new BoxGeometry(0.62, 0.04, 0.62), c);
    const crown = part(new BoxGeometry(0.34, 0.18, 0.34), c);
    // 'low' = pulled down over the brow (smuggler), shadowing the face.
    const y = hat.type === 'low' ? headY + 0.11 : top - 0.01;
    brim.position.y = y;
    crown.position.y = y + 0.1;
    g.add(brim, crown);
  } else if (hat.type === 'tricorn') {
    const brim = part(new BoxGeometry(0.56, 0.05, 0.5), c);
    brim.position.y = top;
    brim.rotation.y = Math.PI / 4; // angled square → tricorn-ish silhouette
    const crown = part(new BoxGeometry(0.3, 0.16, 0.3), c);
    crown.position.y = top + 0.09;
    g.add(brim, crown);
  } else if (hat.type === 'bonnet') {
    // Box shell hugging the top/back/sides, set back so the face stays visible.
    const shell = part(new BoxGeometry(0.48, 0.36, 0.46), c);
    shell.position.set(0, headY + 0.05, -0.05);
    g.add(shell);
  } else if (hat.type === 'cap') {
    const cap = part(new BoxGeometry(0.46, 0.16, 0.46), c);
    cap.position.y = top - 0.05;
    g.add(cap);
  }
}

// ── Prop builders ─────────────────────────────────────────────────────────
// Each returns a Group whose local origin is the GRIP point (where the hand
// closes around it). Real-world sizes per the brief (metres). Tools stand up
// from the grip along +Y; the blade/head sits at the far end.

/** Thomas — hoe: thin ~0.8 m brown handle + a flattened gray blade up top. */
function makeHoe(): Group {
  const g = new Group();
  const handleLen = 0.8;
  const handle = part(new CylinderGeometry(0.016, 0.018, handleLen, 8), PROP.brown);
  // Grip near the lower quarter: handle runs from −0.15 to +0.65 about origin.
  handle.position.y = handleLen / 2 - 0.15;
  g.add(handle);
  const topY = 0.65;
  const blade = part(new BoxGeometry(0.12, 0.15, 0.03), PROP.gray);
  // Blade hangs forward of the handle top, angled like a hoe head.
  blade.position.set(0, topY - 0.06, 0.06);
  blade.rotation.x = Math.PI / 2.6;
  g.add(blade);
  return g;
}

/** Martha / Elizabeth — herb basket: short wide brown cylinder + green bits. */
function makeBasket(): Group {
  const g = new Group();
  const r = 0.1;
  const h = 0.15;
  // Open-topped weave: side wall (double-sided so the inside reads) + a floor.
  const wall = part(new CylinderGeometry(r, r * 0.85, h, 12, 1, true), PROP.brown);
  wall.position.y = h / 2;
  g.add(wall);
  const floor = part(new CylinderGeometry(r * 0.85, r * 0.85, 0.015, 12), PROP.brown);
  floor.position.y = 0.0075;
  g.add(floor);
  // A few green herb bunches poking out of the top.
  for (const [hx, hz] of [[-0.03, 0.02], [0.04, -0.01], [0.0, -0.04]] as const) {
    const herb = part(new BoxGeometry(0.05, 0.07, 0.05), PROP.green);
    herb.position.set(hx, h + 0.02, hz);
    g.add(herb);
  }
  return g;
}

/** James — hammer/mallet: ~0.4 m brown handle + a gray cube head. */
function makeHammer(): Group {
  const g = new Group();
  const handleLen = 0.4;
  const handle = part(new CylinderGeometry(0.013, 0.015, handleLen, 8), PROP.brown);
  handle.position.y = handleLen / 2 - 0.1; // grip low, head up top
  g.add(handle);
  const head = part(new BoxGeometry(0.08, 0.06, 0.05), PROP.gray);
  head.position.y = handleLen - 0.1; // 0.3
  g.add(head);
  return g;
}

/** Anne — book/ledger: palm-sized flattened cube, brown leather, lies flat. */
function makeBook(): Group {
  const g = new Group();
  // Width 0.15 (x), thickness 0.03 (y → flat), length 0.20 (z).
  const cover = part(new BoxGeometry(0.15, 0.03, 0.2), PROP.darkBrown);
  g.add(cover);
  // Thin cream page block, just proud of the leather on top.
  const pages = part(new BoxGeometry(0.13, 0.018, 0.18), PROP.cream);
  pages.position.y = 0.018;
  g.add(pages);
  return g;
}

/** Captain Whitmore — scroll/document: small tapered cream tube. */
function makeScroll(): Group {
  const g = new Group();
  const len = 0.25;
  // Neutral orientation: axis along +Y. The placement spec tilts it into the
  // palm. Slight taper so it reads as a rolled document.
  const scroll = part(new CylinderGeometry(0.028, 0.032, len, 10), PROP.cream);
  g.add(scroll);
  return g;
}

/** Elizabeth — trowel: short brown handle + a small flattened gray scoop. */
function makeTrowel(): Group {
  const g = new Group();
  const handleLen = 0.12;
  const handle = part(new CylinderGeometry(0.012, 0.014, handleLen, 8), PROP.brown);
  handle.position.y = handleLen / 2 - 0.06;
  g.add(handle);
  // Scoop extends up/forward from the handle top (~0.13 long → 0.25 total).
  const scoop = part(new BoxGeometry(0.05, 0.01, 0.13), PROP.gray);
  scoop.position.set(0, handleLen - 0.06 + 0.05, 0.04);
  scoop.rotation.x = Math.PI / 7;
  g.add(scoop);
  return g;
}

/** Henry the cooper — a small barrel: a stout wooden cylinder with two darker
 *  iron hoops. Held low at the side like a finished piece of his work. */
function makeBarrel(): Group {
  const g = new Group();
  const h = 0.22;
  const body = part(new CylinderGeometry(0.11, 0.11, h, 14), PROP.brown);
  body.position.y = h / 2;
  g.add(body);
  // Two iron hoops (thin darker rings near the top and bottom of the staves).
  for (const hy of [0.05, h - 0.05]) {
    const hoop = part(new CylinderGeometry(0.115, 0.115, 0.025, 14), PROP.gray);
    hoop.position.y = hy;
    g.add(hoop);
  }
  return g;
}

/** Smuggler — pouch/sack: a squished dark-brown sphere with a tied neck. */
function makePouch(): Group {
  const g = new Group();
  const body = part(new SphereGeometry(0.04, 12, 10), PROP.darkBrown, false);
  body.scale.set(1.0, 1.25, 0.75); // ≈ 0.08 × 0.10 × 0.06
  g.add(body);
  const neck = part(new CylinderGeometry(0.012, 0.018, 0.03, 8), PROP.darkBrown);
  neck.position.y = 0.05;
  g.add(neck);
  return g;
}

// ── Placement helper ─────────────────────────────────────────────────────────
function placeNpc(
  world: World,
  g: Object3D,
  x: number,
  z: number,
  opts: {
    y?: number;
    yaw?: number;
    face?: 'center';
    scale?: [number, number, number] | number;
    /** Opt out of the idle sway (script-driven figures move themselves). */
    sway?: boolean;
  } = {},
): void {
  if (opts.scale !== undefined) {
    if (Array.isArray(opts.scale)) g.scale.set(...opts.scale);
    else g.scale.setScalar(opts.scale);
  }
  g.position.set(x, opts.y ?? 0, z);
  // Model "front" is local +Z; face the market centre (origin) if requested.
  if (opts.face === 'center') g.rotation.y = Math.atan2(-x, -z);
  else if (opts.yaw !== undefined) g.rotation.y = opts.yaw;
  const entity = world.createTransformEntity(g);
  // Give everyone a subtle idle sway unless they're script-driven (opts.sway
  // === false). AmbientSway is registered before buildColonists() in index.ts.
  if (opts.sway !== false) entity.addComponent(AmbientSway);
}

// =============================================================================
// PLACE & ASSIGN ROLES — positions reference the existing settlement layout:
// homes at ±(7,7), market stall (0,0), well (0,4), barn (-6,-8), dock on x=0
// (z -19…-33), ship deck ≈ (x∈[-5,5], y 0.5, z≈-35.6).
// =============================================================================
export function buildColonists(world: World): void {
  // ── THOMAS — neighbouring farmer, working-class. At his farm (his home is
  //    the larger house at +(7,7)), across the dirt path from the player. ────
  placeNpc(
    world,
    makeColonist({
      name: 'Thomas',
      skin: SKIN.tan,
      shirt: C.offWhite,
      legs: C.warmBrown,
      belt: C.darkLeather,
      hair: HAIR.brown,
      beard: HAIR.brown,
      hat: { type: 'wide', color: C.warmBrown },
      prop: { build: makeHoe, hand: 'right', pos: [0.0, 0.02, 0.06] },
    }),
    5.5,
    5.5,
    { face: 'center' },
  );

  // ── MARTHA — herbalist at the market: long dress + apron + bonnet. ───────
  placeNpc(
    world,
    makeColonist({
      name: 'Martha',
      skin: SKIN.medium,
      shirt: C.sage,
      dress: C.sage,
      apron: C.cream,
      hat: { type: 'bonnet', color: C.cream },
      armTilt: 0.1,
      prop: { build: makeBasket, hand: 'left', pos: [-0.03, -0.06, 0.08] },
    }),
    1.7,
    1.5,
    { face: 'center' },
  );

  // ── JAMES — blacksmith at the market: charcoal shirt, heavy leather apron,
  //    broader build. Scaled (1.08, 1.05, 1.1) per STEP 4. ──────────────────
  placeNpc(
    world,
    makeColonist({
      name: 'James',
      skin: SKIN.tan,
      shirt: C.charcoal,
      legs: C.darkLeather,
      apron: C.darkLeather,
      belt: C.darkLeather,
      hair: HAIR.black,
      beard: HAIR.black,
      broad: true,
      prop: { build: makeHammer, hand: 'right', pos: [0.0, 0.0, 0.05] },
    }),
    -1.9,
    1.1,
    { face: 'center', scale: [1.08, 1.05, 1.1] },
  );

  // ── ANNE — general trader at the market: vest/bodice over a blouse. ──────
  placeNpc(
    world,
    makeColonist({
      name: 'Anne',
      skin: SKIN.light,
      shirt: C.cream,
      dress: C.burgundy,
      vest: C.forest,
      hair: HAIR.brown,
      armTilt: 0.12,
      prop: { build: makeBook, hand: 'left', pos: [-0.03, 0.05, 0.06] },
    }),
    1.9,
    -1.2,
    { face: 'center' },
  );

  // ── HENRY — the cooper (barrel-maker) at the market edge. Leather apron +
  //    cap, a finished barrel at his side. He trades only for finished "trade
  //    goods," never crops — the deliberate wants-mismatch (see MarketSystem). ─
  placeNpc(
    world,
    makeColonist({
      name: 'Henry',
      skin: SKIN.medium,
      shirt: C.fadedBrown,
      legs: C.warmBrown,
      apron: C.darkLeather,
      belt: C.darkLeather,
      hair: HAIR.brown,
      hat: { type: 'cap', color: C.fadedBrown },
      prop: { build: makeBarrel, hand: 'left', pos: [-0.05, -0.2, 0.06] },
    }),
    4.0,
    -0.6,
    { face: 'center' },
  );

  // ── CAPTAIN WHITMORE — Royal Trading Company: navy coat + gold trim,
  //    tricorn, boots; the most formal figure. Scaled (1.0,1.03,1.0). ───────
  placeNpc(
    world,
    makeColonist({
      name: 'Captain Whitmore',
      skin: SKIN.light,
      shirt: C.offWhite,
      legs: C.navy,
      coat: C.navy,
      trim: C.darkGold,
      boots: C.darkLeather,
      hat: { type: 'tricorn', color: C.navy },
      hair: HAIR.grey,
      armTilt: 0.08,
      // Scroll in the LEFT hand; the right hand stays empty (per the brief).
      prop: { build: makeScroll, hand: 'left', pos: [-0.02, 0.03, 0.05], rot: [Math.PI / 2.2, 0, 0] },
    }),
    -1.7,
    -1.6,
    // Script-driven in Fall (walks down the gangplank) — no idle sway.
    { face: 'center', scale: [1.0, 1.03, 1.0], sway: false },
  );

  // ── ELIZABETH — farmer (Summer), outdoorsy: simple dress + straw hat. At
  //    the farm plot beside the player's home (-7, 7). ──────────────────────
  placeNpc(
    world,
    makeColonist({
      name: 'Elizabeth',
      skin: SKIN.medium,
      shirt: C.fadedTan,
      dress: C.fadedTan,
      headwrap: C.headCream,
      hat: { type: 'straw', color: 0xd9c27a },
      armTilt: 0.12,
      prop: { build: makeTrowel, hand: 'left', pos: [-0.02, 0.0, 0.06] },
    }),
    -8.5,
    8.5,
    { yaw: 0.6 },
  );

  // ── CHILDREN — two near Elizabeth's farm, one at the market. Plain clothes,
  //    short (uniform scale 0.6 keeps feet grounded). ────────────────────────
  placeNpc(
    world,
    makeColonist({ skin: SKIN.medium, shirt: C.offWhite, legs: C.warmBrown, hair: HAIR.sandy }),
    -9.6,
    7.0,
    { yaw: 0.9, scale: 0.6 },
  );
  placeNpc(
    world,
    makeColonist({ skin: SKIN.light, shirt: C.fadedTan, dress: C.fadedSage, hair: HAIR.brown }),
    -6.9,
    9.3,
    { yaw: -1.2, scale: 0.6 },
  );
  placeNpc(
    world,
    makeColonist({ skin: SKIN.medium, shirt: C.grayBlue, legs: C.warmBrown, hair: HAIR.brown }),
    0.7,
    2.7,
    { face: 'center', scale: 0.6 },
  );

  // ── BACKGROUND SETTLERS — mix of male/female, varied muted colours. ──────
  const settlers: Array<[number, number, ColonistOpts, number]> = [
    [1.2, 4.6, { skin: SKIN.light, shirt: C.offWhite, legs: C.warmBrown, hair: HAIR.brown, hat: { type: 'wide', color: C.fadedTan } }, -0.4],
    [-2.6, 3.4, { skin: SKIN.tan, shirt: C.fadedTan, dress: C.fadedTan, headwrap: C.headCream }, 2.2],
    [-4.5, -6.2, { skin: SKIN.medium, shirt: C.grayBlue, legs: C.warmBrown, belt: C.darkLeather, hair: HAIR.black }, 1.0],
    [1.8, -12, { skin: SKIN.dark, shirt: C.warmBrown, legs: C.darkLeather, hair: HAIR.black, hat: { type: 'wide', color: C.warmBrown } }, 0.2],
    [8.6, 7.8, { skin: SKIN.medium, shirt: C.fadedSage, dress: C.fadedSage, hat: { type: 'bonnet', color: C.cream } }, -2.0],
  ];
  for (const [x, z, opts, yaw] of settlers) {
    placeNpc(world, makeColonist(opts), x, z, { yaw });
  }

  // ── SAILORS — seafaring look (loose shirts, vests, caps), on the ship deck
  //    (deck top ≈ y 0.5) plus one working on the dock (dock top y 0). ──────
  placeNpc(
    world,
    makeColonist({ skin: SKIN.tan, shirt: C.offWhite, vest: C.sailorNavy, legs: C.fadedBrown, hat: { type: 'cap', color: C.sailorNavy } }),
    2.2,
    -35.0,
    { y: 0.5, yaw: 2.4 },
  );
  placeNpc(
    world,
    makeColonist({ skin: SKIN.medium, shirt: C.offWhite, vest: C.fadedBrown, legs: C.fadedBrown, hair: HAIR.brown, hat: { type: 'cap', color: C.fadedBrown } }),
    -1.6,
    -36.3,
    { y: 0.5, yaw: 1.0 },
  );
  placeNpc(
    world,
    makeColonist({ skin: SKIN.tan, shirt: C.offWhite, vest: C.sailorNavy, legs: C.fadedBrown, hat: { type: 'cap', color: C.sailorNavy } }),
    1.0,
    -28.0,
    { y: 0, yaw: -2.6 }, // on the dock, facing the ship
  );

  // ── SMUGGLER (Fall) — visually distinct, disheveled, darkest of all, set
  //    apart near the shoreline away from the group; hat pulled low. ────────
  placeNpc(
    world,
    makeColonist({
      name: 'Smuggler',
      skin: SKIN.tan,
      shirt: C.smuggler,
      legs: C.smuggler,
      vest: C.smuggler,
      belt: C.darkLeather,
      hat: { type: 'low', color: C.smuggler },
      armTilt: 0.05,
      prop: { build: makePouch, hand: 'left', pos: [-0.02, -0.02, 0.05] },
    }),
    4.5,
    -19.0,
    // Script-driven in Fall (retreats into hiding) — no idle sway.
    { yaw: -1.8, sway: false },
  );
}
