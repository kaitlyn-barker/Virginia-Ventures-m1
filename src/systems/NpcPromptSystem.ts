/**
 * NpcPromptSystem.ts — the "Select to talk / Select to trade" hover affordance.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS ADDS (and what it deliberately does NOT touch)
 * ─────────────────────────────────────────────────────────────────────────
 * The colony's NPCs are already targetable by the built-in pointer: each owning
 * system (ThomasAdviceSystem, MarketSystem, FarmVisitSystem, …) adds the
 * `RayInteractable` tag to its NPC while that NPC is interactive in the current
 * phase, and the engine's InputSystem raycasts the mouse/touch pointer (browser
 * + IWER emulator) and the XR controller ray against those tags, adding the
 * transient `Hovered` / `Pressed` tags. Selecting an NPC already opens its
 * dialogue/trade panel via each system's `[…, Pressed]` query.
 *
 * The one missing piece for playability was a *prompt* telling the player they
 * can act on what they're pointing at. This system supplies exactly that, and
 * nothing more:
 *
 *   - It watches the built-in `Hovered` tag (read-only — never added/removed by
 *     us; the engine owns it).
 *   - When a hovered entity is one of the known colony NPCs, it shows a small
 *     top-center "Select to talk" / "Select to trade" hint.
 *   - When the pointer leaves, it hides the hint.
 *
 * It adds no components to NPCs, changes no interactivity, and alters no
 * gameplay/scoring. Because `Hovered` is only ever applied to entities that
 * carry `RayInteractable`, an NPC can only show the prompt while it is actually
 * interactive this phase — so the hint never lies.
 *
 * Note on the Captain & the Smuggler: in Fall those two are driven by the
 * scripted ship sequence (TradeShipArrival / SmugglingChoice present their
 * panels automatically), not by point-and-select, so they are intentionally not
 * given `RayInteractable` and will not show this prompt. Forcing them to be
 * manually selectable would change the Fall flow, which is out of scope.
 */

import {
  Hovered,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  UIKit,
  UIKitDocument,
  createSystem,
  eq,
  type Entity,
} from '@iwsdk/core';

import { HudAnchor } from '../ui/hudFollow.js';
import { gameState } from '../game/GameState.js';
import { relayoutScreenSpacePanels } from '../ui-relayout.js';

const PROMPT_CONFIG = './ui/npc-prompt.json';

/**
 * The colony's interactive NPCs, keyed by their Object3D name (set in
 * environment/Colonists.ts). The value is how the player acts on them:
 *  - 'talk'  → opens a dialogue panel (advice / tutorial)
 *  - 'trade' → opens a barter/trade panel
 *  - 'both'  → talks in Spring, trades in Summer (the neighbouring farmers)
 */
const NPC_VERBS: Record<string, 'talk' | 'trade' | 'both'> = {
  Thomas: 'both', // Spring: farming advice · Summer: farm-visit trade
  Elizabeth: 'both', // Spring: tutorial chat · Summer: farm-visit trade
  Martha: 'trade', // Summer market herbalist
  James: 'trade', // Summer market blacksmith
  Anne: 'trade', // Summer market general trader
  Henry: 'trade', // Summer market cooper (finished-goods-only, wants-mismatch)
  'Captain Whitmore': 'talk', // (script-driven in Fall — see header note)
  Smuggler: 'talk', // (script-driven in Fall — see header note)
};

export class NpcPromptSystem extends createSystem({
  // Every entity the pointer is currently hovering. The engine maintains this
  // set; we only read it. NPCs, UI panels, seed bags, etc. all pass through
  // here — we filter to NPC names below.
  hovered: { required: [Hovered] },
  // Our prompt panel, matched once its UIKit document has loaded.
  promptPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', PROMPT_CONFIG)],
  },
}) {
  private promptEntity?: Entity;
  private promptDoc?: UIKitDocument;
  /** The text currently shown, to avoid re-touching the DOM every hover frame. */
  private shownText = '';
  /** Whether the prompt is currently visible. */
  private visible = false;

  init() {
    // Top-center hint card (a world-space panel in XR). Hidden until a hover.
    this.promptEntity = this.world
      .createTransformEntity()
      .addComponent(PanelUI, { config: PROMPT_CONFIG, maxWidth: 0.5, maxHeight: 0.14 })
      .addComponent(ScreenSpace, {
        // Fixed px width (matched to the panel's 30-unit natural width) keeps the
        // font sane; ~240px wide, nudged just left of center so it reads as a
        // top-center hint on a typical viewport.
        top: '13%',
        left: 'calc(50vw - 120px)',
        width: '240px',
        height: 'auto',
      })
      // XR: keep the hint upper-center in front of the headset, mirroring its
      // top-center desktop spot (its Transform is never positioned otherwise).
      .addComponent(HudAnchor, { offset: [0, 0.45, -1.6] });
    this.promptEntity.object3D!.visible = false;

    this.cleanupFuncs.push(
      this.queries.promptPanel.subscribe(
        'qualify',
        (entity) => {
          this.promptDoc = PanelDocument.data.document[
            entity.index
          ] as UIKitDocument | undefined;
          // Force the starting hidden state directly. We can't go through
          // setVisible() here: its `visible === this.visible` guard (which keeps
          // update() from re-writing the DOM every frame) would skip the write,
          // and the panel's CSS default is `display: flex` — so without this the
          // prompt would show until the first hover toggle. ScreenSpaceUISystem
          // re-asserts object3D.visible each frame, so display:none on the
          // content root is what actually hides it.
          (this.promptDoc?.getElementById('prompt-root') as UIKit.Container | null)
            ?.setProperties({ display: 'none' });
          this.visible = false;
        },
        true,
      ),
    );

    // When a hover STARTS on an NPC, show the right prompt. We resolve the verb
    // and visibility in update() each frame instead of only on the qualify edge,
    // because the appropriate verb can depend on the current phase and the
    // hovered set is tiny (usually 0–1 entries) so this is cheap.
  }

  update() {
    // Find the first hovered entity that is a known, named NPC. The hovered set
    // is normally empty or a single entry, so this loop is trivially cheap.
    let verb: string | undefined;
    for (const entity of this.queries.hovered.entities) {
      const name = entity.object3D?.name;
      if (!name) continue;
      const kind = NPC_VERBS[name];
      if (!kind) continue; // not an NPC (UI panel, seed bag, farm cell, …)
      verb = this.verbText(kind);
      break;
    }

    if (verb) {
      this.setText(verb);
      this.setVisible(true);
    } else {
      this.setVisible(false);
    }
  }

  /** Resolve a verb 'kind' to the player-facing prompt text for this phase. */
  private verbText(kind: 'talk' | 'trade' | 'both'): string {
    if (kind === 'trade') return 'Click to trade';
    if (kind === 'talk') return 'Click to talk';
    // 'both' — the neighbouring farmers: advice in Spring, barter in Summer.
    return gameState.currentPhase === 'Summer'
      ? 'Click to trade'
      : 'Click to talk';
  }

  private setText(value: string): void {
    if (value === this.shownText) return;
    this.shownText = value;
    (this.promptDoc?.getElementById('prompt-text') as UIKit.Text | null)
      ?.setProperties({ text: value });
  }

  private setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (this.promptEntity?.object3D)
      this.promptEntity.object3D.visible = visible;
    (this.promptDoc?.getElementById('prompt-root') as UIKit.Container | null)
      ?.setProperties({ display: visible ? 'flex' : 'none' });
    if (visible) relayoutScreenSpacePanels(this.promptDoc);
  }
}
