/**
 * WinterScene.ts — Winter ("Consequences") phase entry.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BEGINNER NOTE (Unity → web mental model)
 * ─────────────────────────────────────────────────────────────────────────
 * A "system" here is the web equivalent of a Unity script (a MonoBehaviour)
 * that runs every frame. The World calls this system's `update(delta)` once per
 * rendered frame — exactly like Unity's `Update()`, and `delta` is Unity's
 * `Time.deltaTime` (seconds since the last frame).
 *
 * `init()` is the web equivalent of Unity's `Awake()`: the World calls it ONCE,
 * right after the system is registered and before the first `update()`. All
 * one-time setup (subscribing to events, building entities) goes there.
 *
 * This system replaces the Unity `WinterScene.cs` MonoBehaviour. Winter is the
 * payoff phase: it READS the three final ColonyScore pillars (food, wealth,
 * reputation) and dresses the world to match. It must NEVER change the scores,
 * the scoring math, or any earlier-phase object — it only reacts to the final
 * scores with winter-specific visuals: a cold lighting shift (Step 3) plus
 * three score-driven entity groups it OWNS and toggles (Steps 4–6).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW THE CONSEQUENCE VISUALS ARE TOGGLED (reusing PhaseSystem's pattern)
 * ─────────────────────────────────────────────────────────────────────────
 * PhaseSystem tags each per-phase object with a `PhaseObject` component, then
 * QUERIES for them and runs a two-pass "disable everything, then enable what
 * belongs" toggle. We mirror that exactly: every Winter prop carries a
 * `WinterProp` tag naming its GROUP (settlers / buildings / atmosphere) and the
 * score BANDS it should be visible in. `applyConsequences()` does the same
 * two-pass toggle, driven by the final scores. The base settlement / colonists
 * are left untouched — Winter layers its own consequence tableau on top.
 *
 * (PhaseSystem's enable step also toggles `RayInteractable` so objects become
 * clickable; our Winter props are purely visual scenery, so we use just the
 * VISIBILITY half of that same pattern — the subset that applies here.)
 */

import {
  AudioUtils,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Types,
  createComponent,
  createSystem,
  type Entity,
  type Object3D,
} from '@iwsdk/core';

import { gameState } from '../game/GameState.js';
import { colonyScore } from '../game/ColonyScore.js';
import { narrator } from '../game/Narrator.js';
// Reuse the settlement's shadow-enabled matte mesh helper + shared palette so
// the Winter props read as the same world (never raw/neon materials).
import { COLORS, solid } from '../environment/Settlement.js';
// Part B handoff: opening the Winter Results Dashboard (was a placeholder log).
import { openDashboard } from './ResultsDashboard.js';

// ─────────────────────────────────────────────────────────────────────────
// SCORE BANDS — the same three thresholds used for every Winter consequence.
// Each pillar is 0–100. We bucket it into one of three bands:
//
//     LOW  = value < 40          (struggling)
//     MID  = 40 ≤ value ≤ 69     (getting by)
//     HIGH = value ≥ 70          (thriving)
// ─────────────────────────────────────────────────────────────────────────
const BAND_LOW_CEILING = 40; // anything BELOW this is LOW
const BAND_HIGH_FLOOR = 70; // anything AT or ABOVE this is HIGH
// (MID is everything in between: 40–69.)

type ScoreBand = 'LOW' | 'MID' | 'HIGH';

/** Bucket a 0–100 pillar value into its LOW / MID / HIGH band. */
function bandOf(value: number): ScoreBand {
  if (value < BAND_LOW_CEILING) return 'LOW'; // < 40
  if (value < BAND_HIGH_FLOOR) return 'MID'; // 40–69
  return 'HIGH'; // ≥ 70
}

// ─────────────────────────────────────────────────────────────────────────
// WINTER LIGHTING TARGET — where the "sun" tweens TO when Winter begins.
// The settlement's sun starts warm (0xfff2d6, intensity 2.2 — see Settlement
// .ts). Winter eases it toward a pale, cool blue-white at a slightly lower
// intensity, the way a cold overcast day flattens the light.
// ─────────────────────────────────────────────────────────────────────────
const WINTER_LIGHT_COLOR = new Color(0xcdddf2); // soft blue-white
const WINTER_LIGHT_INTENSITY = 1.5; // dimmer than the warm 2.2 summer sun
const LIGHT_TWEEN_SECONDS = 3; // how long the warm → cold shift takes

// ─────────────────────────────────────────────────────────────────────────
// WINTER PROP PALETTE — winter-specific tints layered on the shared COLORS.
// ─────────────────────────────────────────────────────────────────────────
const WINTER = {
  cloakBlue: 0x4a5568, // muted blue-grey winter cloak
  cloakBrown: 0x5a4232, // brown cloak variant
  skin: 0xc89a6e,
  snow: 0xdfe8f2, // pale snow dusting
  flame: 0xffb24d, // warm campfire glow
  windowGlow: 0xffd27a, // lit storehouse windows
  bannerRed: 0x9b2d2d, // Crown banner field
  bannerGold: 0xd9b44a, // Crown banner cross + finial
  grain: 0xd9c27a, // food: heaped grain
  bread: 0xc28a4a, // food: loaves
} as const;

// ─────────────────────────────────────────────────────────────────────────
// SNOW (Step 7) — a lightweight drifting-snow field over the settlement.
// We use a single THREE.Points cloud (one draw call, N tiny quads) rather than
// a heavyweight particle system — cheap enough for the Quest browser. Each
// flake falls and sways; when it drops below the ground we recycle it back to
// the top. All per-frame work mutates pre-allocated arrays (no GC churn).
// ─────────────────────────────────────────────────────────────────────────
const SNOW_COUNT = 700; // flakes — modest so it stays light on a headset
const SNOW_AREA = 44; // x/z spread (metres) — covers the village footprint
const SNOW_TOP_Y = 14; // flakes spawn/recycle at this height
const SNOW_BOTTOM_Y = 0; // ground level — a flake below this recycles to the top
const SNOW_SWAY = 0.25; // horizontal drift amount (gentle side-to-side)

// ─────────────────────────────────────────────────────────────────────────
// RESULTS DASHBOARD HANDOFF (Step 8) — after the winter visuals settle, open
// the Part B Results Dashboard. We wait a few seconds so the student can look
// around the changed settlement first. (Real call wired in Part B.)
// ─────────────────────────────────────────────────────────────────────────
const DASHBOARD_DELAY_SECONDS = 5.5;

// ─────────────────────────────────────────────────────────────────────────
// WinterProp — the "which consequence group + which bands?" tag.
//
// The Winter equivalent of PhaseSystem's `PhaseObject`. Attach it to any prop
// Winter owns:
//     entity.addComponent(WinterProp, { group: 'buildings', bands: 'HIGH' });
//
// Fields:
//  - `group`  which pillar drives this prop's visibility:
//             'settlers'   → foodSupply band
//             'buildings'  → tradeWealth band
//             'atmosphere' → crownReputation band
//  - `bands`  a comma-separated list of the bands the prop is VISIBLE in, e.g.
//             'HIGH' or 'HIGH,MID' or 'LOW'. If the prop's group-band is in this
//             list, it shows; otherwise it stays hidden.
// ─────────────────────────────────────────────────────────────────────────
export const WinterProp = createComponent('WinterProp', {
  group: { type: Types.String, default: 'settlers' },
  bands: { type: Types.String, default: '' },
});

type WinterGroup = 'settlers' | 'buildings' | 'atmosphere';

export class WinterScene extends createSystem({
  // Query EVERY Winter prop, exactly as PhaseSystem queries PhaseObjects. The
  // live set is the registered "entity collection" the brief asks for — no
  // manual entity array kept in the system.
  winterProps: { required: [WinterProp] },
}) {
  /**
   * One-shot guard. `setupWinter()` must run EXACTLY once per session. Without
   * this, a stray second 'Winter' phase event (e.g. a console `setPhase` jump
   * after a reset) would re-trigger the whole entry sequence.
   */
  private hasRun = false;

  /** True once the Winter props have been built (so we build them only once). */
  private propsBuilt = false;

  /** The scene's main directional light ("the sun"), cached at Winter entry. */
  private sun?: DirectionalLight;

  // ── Lighting-tween state (a "tween"/Lerp blends warm → cold over time) ──
  private tweening = false;
  private tweenElapsed = 0; // seconds into the tween so far
  private readonly fromColor = new Color(); // the light's warm color at entry
  private readonly toColor = new Color(WINTER_LIGHT_COLOR); // the cold target
  private fromIntensity = 0; // the light's intensity at entry
  private readonly toIntensity = WINTER_LIGHT_INTENSITY; // the cold target

  // ── The three final score bands, resolved once in setupWinter() ──────────
  private foodBand: ScoreBand = 'MID';
  private wealthBand: ScoreBand = 'MID';
  private reputationBand: ScoreBand = 'MID';

  // ── Snow field (Step 7) ──────────────────────────────────────────────────
  private snow?: Points; // the Points cloud (one object, SNOW_COUNT flakes)
  private snowPositions?: Float32Array; // live xyz buffer we mutate each frame
  private snowSpeeds?: Float32Array; // per-flake fall speed (m/s)
  private snowPhase?: Float32Array; // per-flake sway phase offset
  private snowActive = false; // true once Winter starts → animate the flakes

  // ── Results-dashboard handoff (Step 8) ───────────────────────────────────
  private dashboardCountdown = 0; // seconds left before the dashboard opens
  private dashboardOpened = false; // one-shot guard for the handoff

  init() {
    // Build the Winter prop tableau up front, all hidden. They reveal only when
    // setupWinter() runs, so they never show during earlier phases.
    this.buildWinterProps();

    // Build the (hidden) snow field too; it starts falling only in Winter.
    this.buildSnow();

    // init() IS our Awake(): subscribe to the shared phase-changed emitter once.
    // gameState.onPhaseChanged hands us (oldPhase, newPhase); we run the Winter
    // entry the moment the new phase is 'Winter'. The returned unsubscribe goes
    // into cleanupFuncs so it's torn down with the system (web version of `-=`).
    this.cleanupFuncs.push(
      gameState.onPhaseChanged((_oldPhase, newPhase) => {
        if (newPhase === 'Winter') this.setupWinter();
      }),
    );

    // Edge case: if the game is ALREADY in Winter when this system inits (e.g. a
    // console jump straight to Winter), no event will fire — run setup now.
    if (gameState.currentPhase === 'Winter') this.setupWinter();
  }

  /**
   * setupWinter — the one-time Winter entry routine.
   *
   * Reads the three final scores, bands them, shifts the lighting, and toggles
   * the consequence props to match. Guarded by `hasRun` so it never fires twice.
   */
  private setupWinter(): void {
    if (this.hasRun) return; // already set up — do nothing.
    this.hasRun = true;

    // ── STEP 2: read the three FINAL scores (each 0–100) ──────────────────
    // getScoreSnapshot() returns a defensive copy, so these are a stable
    // reading of where the colony ended up — we only READ, never write.
    const { foodSupply, tradeWealth, crownReputation } =
      colonyScore.getScoreSnapshot();

    // Band each pillar:  LOW < 40   •   MID 40–69   •   HIGH ≥ 70
    this.foodBand = bandOf(foodSupply);
    this.wealthBand = bandOf(tradeWealth);
    this.reputationBand = bandOf(crownReputation);

    console.log(
      `[Winter] Consequences — ` +
        `food=${foodSupply} (${this.foodBand}), ` +
        `wealth=${tradeWealth} (${this.wealthBand}), ` +
        `reputation=${crownReputation} (${this.reputationBand})`,
    );

    // NARRATOR (P2.4): point the player at WHY the winter village looks the way
    // it does — tie the visible scene to their weakest (or strongest) pillar in
    // plain words, so the environmental storytelling reads as consequence.
    this.sayWinterConsequence(foodSupply, tradeWealth, crownReputation);

    // ── STEP 3: begin the warm → cold lighting tween ──────────────────────
    this.beginLightShift();

    // ── STEPS 4–6: show the consequence props that match the final bands ──
    this.applyConsequences();

    // ── STEP 7: start the snow falling over the now-wintry settlement ─────
    if (this.snow) this.snow.visible = true;
    this.snowActive = true;

    // ── STEP 8: ambient winter wind + a delayed handoff to the dashboard ──
    this.playWinterWind();
    this.dashboardCountdown = DASHBOARD_DELAY_SECONDS;
    this.dashboardOpened = false;
  }

  /**
   * Speak one plain-words line tying the winter scene to the player's scores.
   * Leads with the WEAKEST pillar (the hardship the player can see around them)
   * when any pillar is low; otherwise it celebrates a colony that thrived. Never
   * uses curriculum jargon — just makes the cause-and-effect legible.
   */
  private sayWinterConsequence(
    food: number,
    wealth: number,
    crown: number,
  ): void {
    const lowest = Math.min(food, wealth, crown);
    if (lowest >= 40) {
      narrator.say(
        'Your colony made it through the year in good shape — well-fed, prosperous, and in the Crown\'s favor. Look around: the settlement is thriving.',
        'neutral',
      );
      return;
    }
    if (lowest === food) {
      narrator.say(
        'Look around — the winter is hard here. Low food stores mean hungry, struggling settlers. The choices that traded food away are showing now.',
        'food',
      );
    } else if (lowest === wealth) {
      narrator.say(
        'Look around — the settlement looks poor and bare. Low trade wealth left little to build or repair with this winter.',
        'wealth',
      );
    } else {
      narrator.say(
        'Look around — the mood is uneasy. Low standing with the Crown left the colony without England\'s support and protection this winter.',
        'crown',
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // STEP 8 — SOUND + RESULTS-DASHBOARD HANDOFF
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Play a one-shot "winter wind" ambience when Winter starts.
   *
   * PLACEHOLDER: there's no /audio/winter_wind.mp3 in public/audio yet (only
   * chime.mp3). We still issue the AudioUtils call — that's the "fallback":
   * the wiring is in place, and if the file is missing the loader just fails
   * quietly (it never throws synchronously, but we guard anyway). Drop the real
   * file in public/audio/ later and the sound starts working with no code change.
   */
  private playWinterWind(): void {
    try {
      AudioUtils.createOneShot(this.world, './audio/winter_wind.mp3', {
        volume: 0.4,
        positional: false, // ambient bed, not tied to a spot in the world
      });
    } catch (err) {
      console.warn('[Winter] winter_wind unavailable (placeholder):', err);
    }
    console.log('[Winter] SOUND: winter_wind (placeholder)');
  }

  /**
   * Count down after Winter begins; once the visuals have settled, open the
   * Results Dashboard. For now that's a console.log placeholder — Part B swaps
   * in the real dashboard-open call here. The `dashboardOpened` flag makes this
   * fire exactly once.
   */
  private updateDashboardHandoff(delta: number): void {
    if (this.dashboardOpened || this.dashboardCountdown <= 0) return;
    this.dashboardCountdown -= delta;
    if (this.dashboardCountdown <= 0) {
      this.dashboardOpened = true;
      // The visuals have settled — open the Winter Results Dashboard (Part B).
      // (This replaced the earlier "OPEN RESULTS DASHBOARD" placeholder log.)
      openDashboard();
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // STEPS 4–6 — TOGGLE THE CONSEQUENCE GROUPS (mirrors PhaseSystem two-pass)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * applyConsequences — the Winter equivalent of PhaseSystem.activatePhase().
   * FIRST hide every Winter prop, THEN reveal only the ones whose group-band is
   * listed in their `bands`. Two clean passes means we never special-case prior
   * state — we always start from a known all-hidden baseline.
   */
  private applyConsequences(): void {
    // Pass A — hide EVERYTHING Winter owns.
    for (const entity of this.queries.winterProps.entities) {
      this.setPropVisible(entity, false);
    }
    // Pass B — reveal the props whose group's final band is in their band list.
    for (const entity of this.queries.winterProps.entities) {
      const group = (entity.getValue(WinterProp, 'group') ??
        'settlers') as WinterGroup;
      const bands = entity.getValue(WinterProp, 'bands') ?? '';
      if (bands.split(',').includes(this.bandForGroup(group))) {
        this.setPropVisible(entity, true);
      }
    }

    console.log(
      `[Winter] Tableau set — settlers:${this.foodBand}, ` +
        `buildings:${this.wealthBand}, atmosphere:${this.reputationBand}`,
    );
  }

  /** Which pillar band drives a given prop group's visibility. */
  private bandForGroup(group: WinterGroup): ScoreBand {
    switch (group) {
      case 'settlers':
        return this.foodBand; // STEP 4 — settlers react to FOOD SUPPLY
      case 'buildings':
        return this.wealthBand; // STEP 5 — buildings react to TRADE WEALTH
      case 'atmosphere':
        return this.reputationBand; // STEP 6 — atmosphere reacts to REPUTATION
    }
  }

  /**
   * Show/hide a Winter prop. These are visual scenery (no interactivity), so we
   * toggle just the object's `visible` flag — the visibility half of
   * PhaseSystem's enable/disable pattern (we don't touch RayInteractable).
   */
  private setPropVisible(entity: Entity, visible: boolean): void {
    if (entity.object3D) entity.object3D.visible = visible;
  }

  /**
   * buildWinterProps — author every consequence prop ONCE, all hidden, each
   * tagged with its group + the bands it appears in. This is the registered
   * "entity collection" the brief asks for: a query (winterProps) over a shared
   * tag, grouped by the `group` field.
   *
   * NOTE on settler "animations": the colonists in this project are placeholder
   * primitives with NO animation clips (see Colonists.ts), so there is no
   * "warm idle" vs "huddle" CLIP to swap. We express the pose difference with
   * geometry instead — an upright figure for HIGH/MID, a hunched bundle for LOW.
   * When rigged colonist GLBs land, this is where you'd cross-fade the matching
   * AnimationAction rather than swapping meshes.
   */
  private buildWinterProps(): void {
    if (this.propsBuilt) return;
    this.propsBuilt = true;

    // The settlers gather around a winter campfire on the open east side of the
    // green (clear of the base communal firepit at -3.5,3). They face the fire.
    const FIRE_X = 3.5;
    const FIRE_Z = 4;

    // Helper: place + tag + hide one prop in a single line (mirrors the
    // settlement's `place`, but also attaches the WinterProp tag).
    const add = (
      obj: Object3D,
      group: WinterGroup,
      bands: string,
      x: number,
      z: number,
      opts: { yaw?: number; faceFire?: boolean; y?: number; scale?: number } = {},
    ): void => {
      if (opts.scale) obj.scale.setScalar(opts.scale);
      obj.position.set(x, opts.y ?? 0, z);
      if (opts.faceFire) obj.rotation.y = Math.atan2(FIRE_X - x, FIRE_Z - z);
      else if (opts.yaw !== undefined) obj.rotation.y = opts.yaw;
      const entity = this.world
        .createTransformEntity(obj)
        .addComponent(WinterProp, { group, bands });
      entity.object3D!.visible = false; // start hidden; revealed in Winter only
    };

    // ── STEP 4 — SETTLERS (foodSupply) ───────────────────────────────────
    // HIGH: 3 upright settlers + warm fire + 3 food baskets (well-fed, warm).
    // MID:  2 upright settlers + 1 food basket, no fire (getting by).
    // LOW:  2 huddled settlers, no food, no fire (cold and hungry).
    add(makeWinterCampfire(), 'settlers', 'HIGH', FIRE_X, FIRE_Z);
    add(makeWinterSettler('upright', WINTER.cloakBlue), 'settlers', 'HIGH,MID', 2.6, 4.0, { faceFire: true });
    add(makeWinterSettler('upright', WINTER.cloakBrown), 'settlers', 'HIGH,MID', 4.4, 4.0, { faceFire: true });
    add(makeWinterSettler('upright', WINTER.cloakBlue), 'settlers', 'HIGH', 3.5, 5.2, { faceFire: true });
    add(makeWinterSettler('huddle', WINTER.cloakBrown), 'settlers', 'LOW', 2.9, 4.3, { faceFire: true });
    add(makeWinterSettler('huddle', WINTER.cloakBlue), 'settlers', 'LOW', 4.1, 4.3, { faceFire: true });
    add(makeFoodBasket(), 'settlers', 'HIGH', 2.9, 3.1, { yaw: 0.3 });
    add(makeFoodBasket(), 'settlers', 'HIGH', 4.1, 3.1, { yaw: -0.4 });
    add(makeFoodBasket(), 'settlers', 'HIGH,MID', 3.5, 5.7, { yaw: 0.2 }); // the one basket MID keeps

    // ── STEP 5 — BUILDINGS (tradeWealth) ──────────────────────────────────
    // HIGH: a finished storehouse with lit windows (wealth built something new).
    // MID:  base settlement only (storehouse hidden — nothing extra).
    // LOW:  base settlement, AND a winter comfort prop (bench) is HIDDEN so the
    //       gathering looks sparse. The bench shows in HIGH/MID, not LOW.
    add(makeStorehouse(), 'buildings', 'HIGH', 7.5, -5, { yaw: Math.atan2(0 - 7.5, 0 - -5) });
    add(makeBench(), 'buildings', 'HIGH,MID', 5.4, 4.6, { faceFire: true });

    // ── STEP 6 — ATMOSPHERE (crownReputation) ─────────────────────────────
    // HIGH: a Crown banner flies by the green (calm, the Crown is pleased).
    // MID:  no banner, neutral (nothing extra).
    // LOW:  no banner, AND a neglected cue — a broken/unrepaired fence section.
    add(makeCrownBanner(), 'atmosphere', 'HIGH', 2.5, 6.6, { yaw: 0 });
    add(makeBrokenFence(), 'atmosphere', 'LOW', -3.3, -1.0, { yaw: 0.3 });
  }

  // ════════════════════════════════════════════════════════════════════════
  // STEP 3 — LIGHTING TWEEN
  // ════════════════════════════════════════════════════════════════════════

  /**
   * beginLightShift — capture the current (warm) light as the tween START and
   * arm `update()` to interpolate toward the cold Winter target.
   */
  private beginLightShift(): void {
    // Find the scene's main directional light. It's created in Settlement.ts via
    // `world.createTransformEntity(sun)` with NO name, so we can't look it up by
    // name — instead we walk the scene graph and grab the first DirectionalLight.
    if (!this.sun) {
      this.world.scene.traverse((obj: Object3D) => {
        if (!this.sun && (obj as DirectionalLight).isDirectionalLight) {
          this.sun = obj as DirectionalLight;
        }
      });
    }

    if (!this.sun) {
      console.warn(
        '[Winter] No directional light found — skipping the lighting shift.',
      );
      return;
    }

    // Snapshot the light's CURRENT warm look as the tween's starting point. The
    // end point is the cold Winter target defined above. update() blends between
    // them over LIGHT_TWEEN_SECONDS.
    this.fromColor.copy(this.sun.color);
    this.fromIntensity = this.sun.intensity;
    this.tweenElapsed = 0;
    this.tweening = true;
  }

  /**
   * update() runs every frame (Unity's Update). It drives three independent
   * bits of Winter motion, each a no-op until Winter actually starts:
   *   1) the warm → cold light tween,
   *   2) the falling snow,
   *   3) the countdown that hands off to the Results Dashboard.
   * `time` is total seconds since start (used for the snow's sway).
   */
  update(delta: number, time: number) {
    this.updateLightTween(delta);
    this.updateSnow(delta, time);
    this.updateDashboardHandoff(delta);
  }

  /** STEP 3 tween: blend the sun warm → cold over LIGHT_TWEEN_SECONDS. */
  private updateLightTween(delta: number): void {
    // A "tween" (from Lerp = Linear intERPolation) smoothly blends from a START
    // value to an END value over time instead of snapping there instantly. This
    // is the web equivalent of the Unity `Color.Lerp` / material-color blend.
    //
    // Each frame we add the elapsed time, turn it into a progress fraction
    // t = 0→1, and set the light to a mix that's `t` of the way from warm to
    // cold. When t reaches 1 we've arrived, so we stop running.
    if (!this.tweening || !this.sun) return;

    this.tweenElapsed += delta;
    const t = Math.min(this.tweenElapsed / LIGHT_TWEEN_SECONDS, 1); // clamp to ≤ 1

    // Color.lerpColors writes (fromColor blended toColor by t) into the light —
    // this is the actual Lerp doing the warm → cold color shift.
    this.sun.color.lerpColors(this.fromColor, this.toColor, t);
    // Scalar lerp for the intensity:  from + (to − from) * t.
    this.sun.intensity =
      this.fromIntensity + (this.toIntensity - this.fromIntensity) * t;

    if (t >= 1) this.tweening = false; // reached the cold Winter light — done.
  }

  // ════════════════════════════════════════════════════════════════════════
  // STEP 7 — FALLING SNOW
  // ════════════════════════════════════════════════════════════════════════

  /**
   * buildSnow — author the snow Points cloud ONCE, hidden. We seed every flake
   * at a random spot in a tall box over the village so that, the moment it's
   * revealed, it already looks like steady snowfall (not a wall starting up top).
   */
  private buildSnow(): void {
    if (this.snow) return;

    // Pre-allocate the per-flake buffers we'll mutate every frame (no per-frame
    // allocation = no GC pauses, which matters at 72–90 fps in a headset).
    const positions = new Float32Array(SNOW_COUNT * 3);
    const speeds = new Float32Array(SNOW_COUNT);
    const phase = new Float32Array(SNOW_COUNT);

    for (let i = 0; i < SNOW_COUNT; i++) {
      // x/z spread evenly across the SNOW_AREA box, centered on the village.
      positions[i * 3 + 0] = (Math.random() - 0.5) * SNOW_AREA;
      positions[i * 3 + 1] = Math.random() * SNOW_TOP_Y; // y spread top→bottom
      positions[i * 3 + 2] = (Math.random() - 0.5) * SNOW_AREA;
      speeds[i] = 0.5 + Math.random() * 0.8; // fall 0.5–1.3 m/s (varied)
      phase[i] = Math.random() * Math.PI * 2; // each flake sways out of sync
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    const material = new PointsMaterial({
      color: new Color(WINTER.snow),
      size: 0.12, // small flakes
      sizeAttenuation: true, // distant flakes look smaller
      transparent: true,
      opacity: 0.85,
      depthWrite: false, // don't let flakes occlude each other oddly
    });

    const points = new Points(geometry, material);
    points.frustumCulled = false; // the cloud spans the whole village; never cull
    points.visible = false; // hidden until Winter begins

    // Parent to the world (scene root), NOT the headset, so it reads as world
    // snow the player can look around within — per the brief.
    this.world.createTransformEntity(points);

    this.snow = points;
    this.snowPositions = positions;
    this.snowSpeeds = speeds;
    this.snowPhase = phase;
  }

  /** Animate the flakes: fall + gentle sway, recycling any that reach the ground. */
  private updateSnow(delta: number, time: number): void {
    if (
      !this.snowActive ||
      !this.snow ||
      !this.snowPositions ||
      !this.snowSpeeds ||
      !this.snowPhase
    ) {
      return;
    }

    const pos = this.snowPositions;
    for (let i = 0; i < SNOW_COUNT; i++) {
      const ix = i * 3;
      // Fall straight down at this flake's speed.
      pos[ix + 1] -= this.snowSpeeds[i] * delta;
      // Gentle horizontal sway (a bounded side-to-side drift, out of phase per flake).
      pos[ix] += Math.sin(time * 0.6 + this.snowPhase[i]) * SNOW_SWAY * delta;

      // Recycle: once below the ground, send it back to the top at a new x/z.
      if (pos[ix + 1] < SNOW_BOTTOM_Y) {
        pos[ix] = (Math.random() - 0.5) * SNOW_AREA;
        pos[ix + 1] = SNOW_TOP_Y;
        pos[ix + 2] = (Math.random() - 0.5) * SNOW_AREA;
      }
    }
    // Tell Three the position buffer changed so the GPU re-uploads it.
    this.snow.geometry.attributes.position.needsUpdate = true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WINTER PROP BUILDERS — placeholder primitive assemblies, same style as the
// settlement (matte `solid()` meshes, blocky low-poly silhouettes).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A bundled-up winter settler. `pose` picks the silhouette (see the note in
 * buildWinterProps about why pose ≠ animation clip here):
 *  - 'upright' — standing, hooded cloak, snow on the shoulders ("warm idle").
 *  - 'huddle'  — hunched into a crouched bundle, knees drawn up ("huddle").
 */
function makeWinterSettler(pose: 'upright' | 'huddle', cloak: number): Group {
  const g = new Group();
  const skin = WINTER.skin;

  if (pose === 'upright') {
    // Two box legs.
    for (const sx of [-1, 1]) {
      const leg = solid(new BoxGeometry(0.16, 0.75, 0.18), COLORS.wood, { flatShading: true });
      leg.position.set(sx * 0.1, 0.375, 0);
      g.add(leg);
    }
    // Cloaked torso (a tall box that reads as a hanging cloak).
    const torso = solid(new BoxGeometry(0.5, 0.9, 0.32), cloak, { flatShading: true });
    torso.position.y = 1.2;
    g.add(torso);
    // Snow dusting across the shoulders.
    const shoulders = solid(new BoxGeometry(0.52, 0.05, 0.34), WINTER.snow, { flatShading: true });
    shoulders.position.y = 1.66;
    g.add(shoulders);
    // Head + hood.
    const head = solid(new BoxGeometry(0.32, 0.32, 0.32), skin, { flatShading: true });
    head.position.y = 1.83;
    g.add(head);
    const hood = solid(new BoxGeometry(0.4, 0.22, 0.42), cloak, { flatShading: true });
    hood.position.set(0, 1.96, -0.04);
    g.add(hood);
  } else {
    // Huddled bundle: a forward-tilted body mass.
    const body = solid(new BoxGeometry(0.62, 0.7, 0.5), cloak, { flatShading: true });
    body.position.y = 0.5;
    body.rotation.x = 0.32;
    g.add(body);
    // Knees drawn up in front.
    const knees = solid(new BoxGeometry(0.58, 0.32, 0.34), cloak, { flatShading: true });
    knees.position.set(0, 0.34, 0.32);
    g.add(knees);
    // Head tucked low and forward.
    const head = solid(new BoxGeometry(0.3, 0.3, 0.3), skin, { flatShading: true });
    head.position.set(0, 0.82, 0.26);
    g.add(head);
    const hood = solid(new BoxGeometry(0.38, 0.24, 0.4), cloak, { flatShading: true });
    hood.position.set(0, 0.9, 0.18);
    g.add(hood);
    // Snow settled on the hunched back.
    const snow = solid(new BoxGeometry(0.64, 0.05, 0.5), WINTER.snow, { flatShading: true });
    snow.position.set(0, 0.84, -0.04);
    snow.rotation.x = 0.32;
    g.add(snow);
  }
  return g;
}

/** A small warm campfire: stone ring + logs + an emissive flame cone. */
function makeWinterCampfire(): Group {
  const g = new Group();
  const stones = 8;
  for (let i = 0; i < stones; i++) {
    const a = (i / stones) * Math.PI * 2;
    const stone = solid(new BoxGeometry(0.2, 0.16, 0.2), COLORS.stone, { flatShading: true });
    stone.position.set(Math.cos(a) * 0.5, 0.08, Math.sin(a) * 0.5);
    stone.rotation.y = a;
    g.add(stone);
  }
  // Two crossed logs.
  for (const rot of [0.4, Math.PI / 2 + 0.2]) {
    const log = solid(new CylinderGeometry(0.07, 0.07, 0.8, 8), COLORS.wood);
    log.rotation.z = Math.PI / 2;
    log.rotation.y = rot;
    log.position.y = 0.12;
    g.add(log);
  }
  // Emissive flame (the only "glowing" element — like the settlement lanterns).
  const flame = new Mesh(
    new ConeGeometry(0.22, 0.5, 8),
    new MeshStandardMaterial({
      color: new Color(WINTER.flame),
      emissive: new Color(WINTER.flame),
      emissiveIntensity: 1.2,
    }),
  );
  flame.position.y = 0.34;
  g.add(flame);
  return g;
}

/** A basket heaped with food (grain + loaves) — the HIGH/MID "food props". */
function makeFoodBasket(): Group {
  const g = new Group();
  const r = 0.22;
  const wall = solid(new CylinderGeometry(r, r * 0.82, 0.3, 12, 1, true), COLORS.wood, { doubleSided: true });
  wall.position.y = 0.15;
  g.add(wall);
  const floor = solid(new CylinderGeometry(r * 0.82, r * 0.82, 0.03, 12), COLORS.wood);
  floor.position.y = 0.02;
  g.add(floor);
  // Heaped grain + a few loaves poking out.
  const mound = solid(new BoxGeometry(0.34, 0.12, 0.34), WINTER.grain, { flatShading: true });
  mound.position.y = 0.34;
  g.add(mound);
  for (const [x, z] of [[-0.08, 0.05], [0.07, -0.04], [0.0, 0.09]] as const) {
    const loaf = solid(new BoxGeometry(0.12, 0.08, 0.16), WINTER.bread, { flatShading: true });
    loaf.position.set(x, 0.42, z);
    g.add(loaf);
  }
  return g;
}

/** The "new building": a plank storehouse with a snow-capped roof + lit windows. */
function makeStorehouse(): Group {
  const g = new Group();
  const w = 3.2,
    h = 2.6,
    d = 2.8;
  const body = solid(new BoxGeometry(w, h, d), COLORS.plankWall);
  body.position.y = h / 2;
  g.add(body);
  const roof = solid(new ConeGeometry(w * 0.95, 1.2, 4), COLORS.roofShingle, { flatShading: true });
  roof.rotation.y = Math.PI / 4;
  roof.position.y = h + 0.6;
  g.add(roof);
  // Snow capping the roof.
  const snow = solid(new ConeGeometry(w * 0.78, 0.5, 4), WINTER.snow, { flatShading: true });
  snow.rotation.y = Math.PI / 4;
  snow.position.y = h + 0.95;
  g.add(snow);
  // Door on the +Z front.
  const door = solid(new BoxGeometry(0.8, 1.5, 0.1), COLORS.wood);
  door.position.set(0, 0.75, d / 2 + 0.01);
  g.add(door);
  // Two LIT windows (emissive warm glow) flanking the door.
  for (const x of [-0.95, 0.95]) {
    const win = new Mesh(
      new BoxGeometry(0.55, 0.6, 0.08),
      new MeshStandardMaterial({
        color: new Color(WINTER.windowGlow),
        emissive: new Color(WINTER.windowGlow),
        emissiveIntensity: 0.9,
      }),
    );
    win.position.set(x, 1.5, d / 2 + 0.02);
    g.add(win);
  }
  return g;
}

/** A simple winter comfort bench (seat + legs + back). */
function makeBench(): Group {
  const g = new Group();
  const seat = solid(new BoxGeometry(1.4, 0.12, 0.4), COLORS.wood, { flatShading: true });
  seat.position.y = 0.45;
  g.add(seat);
  for (const sx of [-0.6, 0.6]) {
    const leg = solid(new BoxGeometry(0.12, 0.45, 0.36), COLORS.wood);
    leg.position.set(sx, 0.225, 0);
    g.add(leg);
  }
  const back = solid(new BoxGeometry(1.4, 0.4, 0.1), COLORS.wood, { flatShading: true });
  back.position.set(0, 0.7, -0.15);
  g.add(back);
  return g;
}

/** A Crown banner: tall pole + a red flag with a gold cross + a finial. */
function makeCrownBanner(): Group {
  const g = new Group();
  const pole = solid(new CylinderGeometry(0.06, 0.06, 3.0, 8), COLORS.wood);
  pole.position.y = 1.5;
  g.add(pole);
  // Red flag field, hanging off the pole's +X side.
  const flag = solid(new BoxGeometry(1.2, 0.8, 0.04), WINTER.bannerRed, { doubleSided: true, flatShading: true });
  flag.position.set(0.66, 2.4, 0);
  g.add(flag);
  // Gold cross (a vertical + horizontal bar, proud of the flag).
  const vbar = solid(new BoxGeometry(0.14, 0.8, 0.05), WINTER.bannerGold);
  vbar.position.set(0.66, 2.4, 0.01);
  g.add(vbar);
  const hbar = solid(new BoxGeometry(1.2, 0.16, 0.05), WINTER.bannerGold);
  hbar.position.set(0.66, 2.4, 0.01);
  g.add(hbar);
  // Finial at the top of the pole.
  const finial = solid(new BoxGeometry(0.12, 0.12, 0.12), WINTER.bannerGold, { flatShading: true });
  finial.position.y = 3.05;
  g.add(finial);
  return g;
}

/** A neglected, unrepaired fence section: leaning + broken posts, a fallen rail. */
function makeBrokenFence(): Group {
  const g = new Group();
  // Upright post.
  const p1 = solid(new BoxGeometry(0.1, 0.7, 0.1), COLORS.woodLight);
  p1.position.set(-0.6, 0.35, 0);
  g.add(p1);
  // Leaning post.
  const p2 = solid(new BoxGeometry(0.1, 0.6, 0.1), COLORS.woodLight);
  p2.position.set(0, 0.3, 0);
  p2.rotation.z = 0.45;
  g.add(p2);
  // Broken-off stub.
  const p3 = solid(new BoxGeometry(0.1, 0.28, 0.1), COLORS.woodLight);
  p3.position.set(0.6, 0.14, 0);
  g.add(p3);
  // A sagging top rail between the upright and leaning posts.
  const top = solid(new BoxGeometry(0.72, 0.06, 0.06), COLORS.woodLight);
  top.position.set(-0.3, 0.52, 0);
  top.rotation.z = -0.22;
  g.add(top);
  // A rail that has fallen to the ground.
  const fallen = solid(new BoxGeometry(1.3, 0.07, 0.07), COLORS.woodLight);
  fallen.position.set(0.25, 0.05, 0.26);
  fallen.rotation.set(0, 0.2, 0.04);
  g.add(fallen);
  return g;
}
