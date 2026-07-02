import { AssetManifest, SessionMode, World } from "@iwsdk/core";

import { RayInteractable, PanelUI, ScreenSpace, Follower } from "@iwsdk/core";

import { PanelSystem } from "./panel.js";

// Season state machine: toggles per-phase objects and drives the banner.
import { PhaseSystem, PhaseObject } from "./systems/PhaseSystem.js";
import {
  SeasonBannerSystem,
  SeasonBanner,
} from "./systems/SeasonBannerSystem.js";
// Summer (Barter & Trade): generates settlement needs, drives the needs HUD,
// and applies Food Supply penalties for needs left unmet at season's end.
import { NeedsSystem } from "./systems/NeedsSystem.js";
// Tradeable-goods inventory + its bottom-left HUD readout. Seeded from Spring
// planting; spent during Summer trading.
import { InventoryHudSystem } from "./systems/InventoryHudSystem.js";
// Persistent quest-style objective tracker (right side): per-phase objective +
// sub-task checklist that fills/pulses/dings as the player completes each step.
import { ObjectiveTrackerSystem } from "./systems/ObjectiveTrackerSystem.js";
// Game-style score HUD (top-left): three tweened stat bars + live prosperity
// grade. Reads colonyScore; pure view.
import { ScoreHudSystem } from "./systems/ScoreHudSystem.js";
// 3D navigation waypoint: a bobbing gold diamond (or off-view arrow) over the
// next target per phase/progress. Pure navigation aid; reads camera + progress.
import { WaypointSystem } from "./systems/WaypointSystem.js";
// Cinematic chapter-card between phases. Registers as gameState's transition
// runner so the new phase activates only after the card finishes.
import { PhaseTransitionSystem } from "./systems/PhaseTransitionSystem.js";
// Proximity NPC name tags + highlight (8u tag, 4u "Select to talk" + glow).
import { NpcNameTagSystem } from "./systems/NpcNameTagSystem.js";
// Summer market: 3 trader stalls + the world-space barter panel.
import { MarketSystem, TradeStall } from "./systems/MarketSystem.js";
// Summer neighbouring farms (Thomas, Elizabeth) — reuse the market trade panel.
import { FarmVisitSystem, FarmPlot } from "./systems/FarmVisitSystem.js";
// Spring planting: the 4x4 farm grid + grabbable corn/tobacco seed bags.
import { FarmSystem, FarmCell, SeedBag } from "./systems/FarmSystem.js";
// Spring: Thomas's branching farming-advice dialogue (corn vs tobacco lesson).
import {
  ThomasAdviceSystem,
  SpringAdvisor,
} from "./systems/ThomasAdviceSystem.js";
// Spring planting HUD: live crop tally + Confirm Planting (applies the
// corn/tobacco tradeoff, hands the split to Summer, advances the phase).
import { SpringPlantingSystem } from "./systems/SpringPlantingSystem.js";
// Spring tutorial/coaching: outline modal, dismissible tips, character scripts.
import {
  SpringTutorialSystem,
  SpringNeighbor,
} from "./systems/SpringTutorialSystem.js";
// End-of-Summer recap + transition to Fall.
import { SummerRecap } from "./systems/SummerRecap.js";
// Summer tutorial: outline, dismissible tips, and per-character dialogue scripts.
import { SummerTutorialSystem } from "./systems/SummerTutorialSystem.js";
// Arrival (intro): the orientation cinematic — a guided camera tour of the
// colony, played when the student presses "Enter the Colony" on the welcome
// panel. Modeled on the Fall ship-arrival cinematic below.
import { ArrivalCinematic } from "./systems/ArrivalCinematic.js";
// Fall (The Trade Ship) — Step 1: ship-arrival cinematic + Captain dialogue.
import { TradeShipArrival } from "./systems/TradeShipArrival.js";
// Fall — Step 2: the Royal Decree (mercantilism rules) modal.
import { RoyalDecreeSystem } from "./systems/RoyalDecreeSystem.js";
// Fall — Step 3: trading with the Royal Trading Company (tax + import/export gap).
import { ShipTrading } from "./systems/ShipTrading.js";
// Fall — Step 4: the smuggling choice (Dutch buyer vs. Crown loyalty).
import { SmugglingChoice } from "./systems/SmugglingChoice.js";
// Fall — Step 5: the ship departs, the Captain's farewell, and the Fall recap.
import { TradeShipDeparture } from "./systems/TradeShipDeparture.js";
// Winter (Consequences) — reads the three final scores on entry, shifts the
// scene lighting warm→cold, and toggles its own score-driven prop groups
// (settlers / buildings / atmosphere). Reads scores, never writes.
import { WinterScene, WinterProp } from "./systems/WinterScene.js";
// Winter, Part B — the Results Dashboard (world-space year-end summary panel).
import { ResultsDashboard } from "./systems/ResultsDashboard.js";
// Winter, Part C — the Reflection sequence (personalized end-of-year questions).
import { Reflection } from "./systems/Reflection.js";
// "Select to talk/trade" hover affordance shown when the built-in pointer is
// over an interactive NPC. Read-only; adds the prompt, never changes gameplay.
import { NpcPromptSystem } from "./systems/NpcPromptSystem.js";
// Desktop-only view turning: ← → (and Q/E) yaw the player so a mouse-and-
// keyboard player can look around. XR uses the headset/thumbstick instead.
import { DesktopLookSystem } from "./systems/DesktopLookSystem.js";
// TEMP: placeholder per-phase markers so the state machine is testable today.
import { buildPhaseScaffold } from "./systems/phase-scaffold.js";

// Core game architecture (built before any scene content). These are
// module-level singletons — see the files for the Unity→web explanation.
import { gameState } from "./game/GameState.js";
import { colonyScore } from "./game/ColonyScore.js";
import { playerInventory } from "./game/PlayerInventory.js";

// Static colonial-Virginia settlement environment (the web equivalent of the
// Unity "ColonialSurvival" scene). Built from placeholder Three.js primitives.
import { buildSettlement } from "./environment/Settlement.js";

// Waterfront along the north edge: river, sloped bank, dock, moored ship, and
// the paths connecting the dock to the settlement.
import { buildWaterfront } from "./environment/Waterfront.js";

// Colonist NPCs (placeholder low-poly humanoids — no rigged character GLBs
// exist yet, so these are static and tinted per role).
import { buildColonists } from "./environment/Colonists.js";

// Extra scenery (trees, barrels, crates, chest, ship, cabins) built from the
// same flat-shaded primitives + palette as the rest of the village.
import { buildProps } from "./environment/Props.js";

// Keeps a persistent HUD/ScreenSpace panel in front of the headset in XR (a
// no-op on desktop, where ScreenSpace head-locks it under the camera).
import { hudFollow } from "./ui/hudFollow.js";

// Lets UI systems force screen-space panels to re-fit their layout after their
// content settles (needs the live World; registered once below).
import { initRelayout } from "./ui-relayout.js";

// No external assets are needed yet — the settlement is built entirely from
// Three.js primitives. Real building/prop GLBs will be added to this manifest
// later when they exist in public/gltf/. The welcome panel loads its UI config
// directly via PanelUI (./ui/welcome.json), not through this manifest.
// No external assets: every prop is built from Three.js primitives (the
// settlement, waterfront, colonists, and environment/Props.ts all share the same
// flat-shaded `solid()` helper + palette), so the manifest stays empty.
const assets: AssetManifest = {};

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  assets,
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: "always",
    // Request hand tracking and WebXR Layers as OPTIONAL (flag = true), not
    // required. On a real Meta Quest both are supported and still get granted,
    // so we lose nothing — but marking them `{ required: true }` makes the
    // runtime REJECT the whole session ("one or more required features are not
    // supported") on any device/runtime that can't grant them (e.g. the IWER
    // emulator can't provide `layers`). Optional flags keep the VR session
    // launching everywhere while using the features wherever available.
    features: { handTracking: true, layers: true },
  },
  features: {
    // `browserControls: true` opts into the built-in first-person browser
    // bindings (WASD to move, Space to jump, browser gamepad). Without it,
    // locomotion only responds to XR thumbsticks — so in the flat browser /
    // IWER emulator the player couldn't walk at all. In a real headset the XR
    // thumbstick still drives locomotion as before; this only ADDS keyboard/
    // gamepad movement for the non-immersive case. Mouse-look is owned by the
    // IWER emulator overlay (and is a no-op in plain flat mode), so there is no
    // pointer-lock code to write here. The ground already carries
    // LocomotionEnvironment (see environment/Settlement.ts), so the player has a
    // walkable surface and won't fall through the world.
    locomotion: { useWorker: true, browserControls: true },
    grabbing: true,
    physics: true,
    sceneUnderstanding: false,
    environmentRaycast: false,
  },
}).then((world) => {
  const { camera } = world;

  // Give the screen-space relayout helper a handle to the live world so panels
  // (e.g. the Summer "Done Trading" HUD) can re-fit once their content settles.
  initRelayout(world);

  // Initial browser vantage: stand at the south end of the main path, looking
  // north up the path toward the market and barn. Camera faces -Z by default.
  camera.position.set(0, 2.2, 15);
  camera.rotateX(-0.12); // slight downward tilt to take in the village

  // ── Build the static settlement (ground, buildings, props, lighting) ─────
  buildSettlement(world);

  // ── Build the north-edge waterfront (river, dock, ship, dock paths) ──────
  buildWaterfront(world);

  // ── Populate the settlement with colonist NPCs ───────────────────────────
  buildColonists(world);

  // ── Layer the modeled 3D art props over the primitive village ────────────
  buildProps(world);

  // Welcome panel: the intro popup shown first on load ("Virginia Ventures,
  // 1620"). Shown full-screen in browser via ScreenSpace, and as a world-space
  // panel in XR. PanelSystem wires its buttons; "Enter the Colony" hides it and
  // starts the arrival cinematic.
  const panelEntity = world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: "./ui/welcome.json",
      maxHeight: 0.65,
      maxWidth: 1.3,
    })
    // RayInteractable so the buttons are clickable by both the desktop pointer
    // and the XR ray. ScreenSpace centers the title card on desktop (it used to
    // be pinned top-left, covering the live settlement) and renders it world-
    // space in XR. Tagged PhaseObject:Arrival so PhaseSystem auto-hides it the
    // moment the player leaves the intro (and re-shows it on an Arrival revisit).
    .addComponent(RayInteractable)
    .addComponent(ScreenSpace, {
      top: "12%",
      left: "20vw",
      width: "60vw",
      height: "64%",
    })
    .addComponent(PhaseObject, { phase: "Arrival" })
    // In immersive XR, ScreenSpace returns the panel to world space at its
    // Transform (calibrated for the desktop camera), so it would sit behind the
    // XR spawn. Follower keeps it in front of the headset (no-op on desktop).
    .addComponent(Follower, hudFollow(world.player.head, [0, 0, -1.6]));
  panelEntity.object3D!.position.set(0, 1.6, 8);

  world.registerSystem(PanelSystem);

  // ── Season state machine + banner ────────────────────────────────────────
  // Register the custom components BEFORE the systems that query them and
  // before any entity adds them (the World needs to know each component's
  // layout first). The built-in PanelUI/PanelDocument are already registered.
  world.registerComponent(PhaseObject);
  world.registerComponent(SeasonBanner);
  world.registerComponent(TradeStall);
  world.registerComponent(FarmPlot);
  world.registerComponent(FarmCell);
  world.registerComponent(SeedBag);
  world.registerComponent(SpringAdvisor);
  world.registerComponent(SpringNeighbor);
  // Winter (Consequences) prop tag — its score-driven entity collection.
  world.registerComponent(WinterProp);

  // NeedsSystem is registered BEFORE PhaseSystem on purpose: both listen to
  // gameState.onPhaseChanged, and listeners fire in subscription order. Running
  // NeedsSystem first means its end-of-Summer Food Supply penalties are applied
  // to colonyScore BEFORE PhaseSystem records the end-of-Summer snapshot, so the
  // snapshot reflects them. It also creates its own HUD panel in init().
  world.registerSystem(NeedsSystem);

  // Always-on tradeable-goods HUD (bottom-left). Reflects playerInventory.
  world.registerSystem(InventoryHudSystem);

  // Always-on objective tracker (right side). Reads the shared objectiveTracker
  // singleton; gameplay systems report finished steps into it. Pure view.
  world.registerSystem(ObjectiveTrackerSystem);

  // Always-on score HUD (top-left). Reads colonyScore; reveals on enter-colony.
  world.registerSystem(ScoreHudSystem);

  // 3D navigation waypoint. Registered at a LATE priority so it reads the final
  // camera pose each frame (after LocomotionSystem and the cutscene cameras
  // have written it) and billboards/points correctly.
  world.registerSystem(WaypointSystem, { priority: 45 });

  // Chapter-card phase transitions. Registers gameState's transition runner.
  world.registerSystem(PhaseTransitionSystem);

  // Proximity NPC name tags + highlight. Reads camera + NPC transforms; additive.
  world.registerSystem(NpcNameTagSystem, { priority: 45 });

  // Summer market: tags the trader NPCs interactive and runs the barter UI.
  world.registerSystem(MarketSystem);

  // Summer farm visits: Thomas & Elizabeth, reusing the market trade panel.
  world.registerSystem(FarmVisitSystem);

  // Spring planting: builds the 4x4 plot grid + grabbable seed bags.
  world.registerSystem(FarmSystem);

  // Spring: Thomas's farming-advice dialogue. Registered AFTER FarmVisitSystem
  // so that, when entering Spring, this system's "make Thomas selectable" runs
  // last and wins over FarmVisitSystem's "not Summer → remove" for that one
  // shared RayInteractable tag on Thomas.
  world.registerSystem(ThomasAdviceSystem);

  // Spring planting HUD + confirm. Registered after FarmSystem so its FarmCell
  // queries pick up the already-built 4x4 grid.
  world.registerSystem(SpringPlantingSystem);

  // Spring tutorial/coaching: outline, dismissible tips, character scripts.
  // Registered after FarmVisitSystem so its "make Elizabeth selectable in
  // Spring" wins over FarmVisit's "not Summer -> remove" for her shared tag.
  world.registerSystem(SpringTutorialSystem);

  // End-of-Summer recap (triggers on 2+ visits or a soft timer) → advances to Fall.
  world.registerSystem(SummerRecap);

  // Summer tutorial/coaching: outline on entry, dismissible tips, NPC scripts.
  world.registerSystem(SummerTutorialSystem);

  // Arrival orientation cinematic. Like the Fall cinematics below, it drives the
  // browser camera/rig each frame, so it's registered at a LATE priority to run
  // after LocomotionSystem (priority -5) and win that per-frame write — that's
  // how it pins the player rig and glides the cutscene camera across the colony
  // without locomotion fighting it. Triggered by the welcome button, not a phase
  // change (the game is already in 'Arrival' on boot).
  world.registerSystem(ArrivalCinematic, { priority: 39 });

  // Fall (The Trade Ship), Step 1: the ship-arrival cinematic + Captain
  // dialogue. Registered at a LATE priority so its per-frame camera/rig writes
  // run after LocomotionSystem (priority -5) and win — that's how it pins the
  // player rig and drives the cutscene camera without locomotion fighting it.
  world.registerSystem(TradeShipArrival, { priority: 40 });

  // Fall, Step 2: the Royal Decree modal. Presents itself when Step 1 emits
  // arrivalComplete (via fallSequence), so registration order is irrelevant.
  world.registerSystem(RoyalDecreeSystem);

  // Fall, Step 3: the Royal Trading Company ship-trade panel (opens on
  // decreeAccepted). Step 4: the smuggling choice (opens on tradingComplete).
  // Both are emitter-driven, so registration order is irrelevant.
  world.registerSystem(ShipTrading);
  world.registerSystem(SmugglingChoice);

  // Fall, Step 5: departure + recap. Like TradeShipArrival it drives the browser
  // camera/rig during its pull-out, so it runs at a late priority (after
  // LocomotionSystem) to win the per-frame camera write.
  world.registerSystem(TradeShipDeparture, { priority: 41 });

  // Winter (Consequences): on entering Winter, reads the three final scores and
  // tweens the scene's sun from warm to a cold winter light. Emitter-driven, so
  // registration order is irrelevant.
  world.registerSystem(WinterScene);

  // Winter, Part B: the Results Dashboard. WinterScene Step 8 calls
  // openDashboard() to show it; emitter-driven, so registration order is moot.
  world.registerSystem(ResultsDashboard);

  // Winter, Part C: the Reflection sequence. The dashboard's "Reflect" button
  // calls startReflection(); emitter-driven, so registration order is moot.
  world.registerSystem(Reflection);

  // "Select to talk/trade" hover prompt. Watches the engine's Hovered tag and
  // shows a small hint over any NPC that is interactive in the current phase.
  // Purely additive — it reads state and never alters interactivity or scoring.
  world.registerSystem(NpcPromptSystem);

  // Desktop view turning (← → / Q E). Registered at the default priority so the
  // cinematics (which pin the rig at a late priority during cutscenes) still win
  // while they play; the rest of the time this rotates the player freely.
  world.registerSystem(DesktopLookSystem);

  // PhaseSystem subscribes to phase changes and toggles per-phase objects.
  // SeasonBannerSystem updates + animates the on-screen season banner.
  world.registerSystem(PhaseSystem);
  world.registerSystem(SeasonBannerSystem);

  // The persistent season selector banner. ScreenSpace pins it to the bottom-
  // center of the screen in the browser (and to a world-space HUD in XR), so it
  // shows up on entry and stays put through every phase. Interactable lets its
  // tab buttons receive pointer/ray clicks. SeasonBannerSystem wires the tabs
  // and keeps the active-season highlight in sync.
  world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: "./ui/season-banner.json",
      maxWidth: 1.7,
      maxHeight: 0.3,
    })
    .addComponent(RayInteractable)
    .addComponent(ScreenSpace, {
      bottom: "16px",
      left: "8vw",
      width: "84vw",
      height: "7vh",
      // Persistent HUD nav bar: sit slightly farther than the default popup
      // depth (0.2) so dialogues/decree/recap popups render in front of it.
      zOffset: 0.26,
    })
    .addComponent(SeasonBanner)
    // XR: keep the season nav bar low and in front of the headset.
    .addComponent(Follower, hudFollow(world.player.head, [0, -0.5, -1.7]));

  // TEMP scaffolding: five placeholder markers (one per phase) so you can watch
  // the state machine enable exactly one group at a time. Remove this once the
  // real per-phase content (ArrivalSequence, market, ship, …) is tagged.
  // DEV-only, gated exactly like DebugMenuSystem below so the placeholder cubes
  // never appear in a shipped build (Rollup strips the call when DEV === false).
  if (import.meta.env.DEV) buildPhaseScaffold(world);

  // ── Core game architecture wiring (Step 3) ──────────────────────────────
  // Confirm the shared game state initializes in the 'Arrival' phase. Because
  // GameState is a module-level singleton, importing it above already ran its
  // initializer — currentPhase is 'Arrival' before this line executes.
  // ── DEV-only diagnostics ────────────────────────────────────────────────
  // Phase logger + window singletons for console-driven verification. Gated on
  // import.meta.env.DEV so production ships clean: no console spam, and no
  // global `game`/`score`/`inventory` handles leaking onto window.
  if (import.meta.env.DEV) {
    console.log(`[Game] Initialized in phase: ${gameState.currentPhase}`);
    gameState.onPhaseChanged((oldPhase, newPhase) => {
      console.log(`=== PHASE TRANSITION: ${oldPhase} -> ${newPhase} ===`);
    });
    (window as unknown as Record<string, unknown>).game = gameState;
    (window as unknown as Record<string, unknown>).score = colonyScore;
    (window as unknown as Record<string, unknown>).inventory = playerInventory;
  }

  // ── DEV-ONLY test menu (Step 4) ──────────────────────────────────────────
  // The web equivalent of `#if UNITY_EDITOR`. In `vite dev` (and the IWER
  // emulator) `import.meta.env.DEV` is `true`, so the menu loads and registers.
  // In `vite build` it is replaced by the literal `false`, so this whole block
  // — INCLUDING the dynamic import — is dead code that Rollup strips from the
  // production bundle. The debug menu code, its UI, and its key toggle simply do
  // not exist in a shipped build. Dynamic import (not a top-level one) is what
  // lets the bundler drop the module entirely.
  if (import.meta.env.DEV) {
    void import("./systems/DebugMenuSystem.js").then(({ DebugMenuSystem }) => {
      world.registerSystem(DebugMenuSystem);
    });
  }

  // Screen-space panels compute their layout once, the first frame they enter
  // screen space — which can be before UIKit has finished laying out wrapped
  // text, leaving them mis-sized and clipped. ScreenSpaceUISystem only
  // recomputes on a window 'resize', so nudge one a few times after load to
  // force a re-layout against the settled natural sizes.
  for (const ms of [250, 750, 1500]) {
    setTimeout(() => window.dispatchEvent(new Event("resize")), ms);
  }
});
