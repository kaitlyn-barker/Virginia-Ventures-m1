/**
 * NpcNameTagSystem.ts — proximity name tags + highlight for the colony NPCs.
 *
 * Within 8 units of an NPC, a small billboarded tag floats above their head
 * showing their name + role ("Thomas" / "Farmer"). Within 4 units it gains a
 * gold border, adds a "Select to talk" / "Select to trade" line, and the NPC
 * itself gets a soft warm glow — so it's obvious who you can walk up to and
 * interact with.
 *
 * Purely additive navigation/affordance polish: it READS the NPC transforms and
 * the player camera, shows world-space tag panels, and toggles a glow on the
 * NPC meshes. It adds no interactivity and touches no gameplay — the existing
 * NpcPromptSystem + each owner system still drive the actual talk/trade.
 *
 * One tag PanelUI is created per NPC the first time it's discovered; meshes and
 * billboard follow the environment/MarketSystem patterns.
 */

import {
  createSystem,
  Mesh,
  MeshStandardMaterial,
  PanelDocument,
  PanelUI,
  Transform,
  UIKit,
  UIKitDocument,
  Vector3,
  eq,
  type Entity,
} from '@iwsdk/core';

import { gameState } from '../game/GameState.js';

const TAG_CONFIG = './ui/npc-nametag.json';

/** Distance (world units) for the tag to appear / for the "near" highlight. */
const SHOW_DIST = 8;
const NEAR_DIST = 4;

/** Height above the NPC origin the tag floats. */
const TAG_HEIGHT = 2.5;

const BORDER_IDLE = '#1b140d';
const BORDER_NEAR = '#c79a4b';
const GLOW = 0x6a4e12; // soft warm emissive added when near

/** NPC name → display role + how the player acts on them. */
const NPCS: Record<string, { role: string; verb: 'talk' | 'trade' | 'both' }> = {
  Thomas: { role: 'Farmer', verb: 'both' },
  Elizabeth: { role: 'Gardener', verb: 'both' },
  Martha: { role: 'Herbalist', verb: 'trade' },
  James: { role: 'Blacksmith', verb: 'trade' },
  Anne: { role: 'Trader', verb: 'trade' },
  'Captain Whitmore': { role: 'Royal Captain', verb: 'talk' },
  Smuggler: { role: 'Smuggler', verb: 'talk' },
};

/** Everything we track for one NPC's tag. */
interface TagRecord {
  name: string;
  npc: Entity;
  tag: Entity;
  doc?: UIKitDocument;
  /** Cached NPC mesh materials + their original emissive, for the glow toggle. */
  mats: { mat: MeshStandardMaterial; emissive: number }[];
  near: boolean; // current highlight state (avoids re-writing each frame)
  shown: boolean; // current visibility (avoids re-writing each frame)
}

export class NpcNameTagSystem extends createSystem({
  npcCandidates: { required: [Transform] },
  tagPanels: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', TAG_CONFIG)],
  },
}) {
  private records: TagRecord[] = [];
  private tagged = new Set<string>();
  private camPos = new Vector3();
  private npcPos = new Vector3();

  init() {
    // Discover the named NPCs and build a tag for each (now and as they appear).
    this.cleanupFuncs.push(
      this.queries.npcCandidates.subscribe(
        'qualify',
        (entity) => this.tryTag(entity),
        true,
      ),
    );

    // Capture each tag panel's document when it loads, matching by entity ref.
    this.cleanupFuncs.push(
      this.queries.tagPanels.subscribe(
        'qualify',
        (entity) => {
          const rec = this.records.find((r) => r.tag === entity);
          if (rec) {
            rec.doc = PanelDocument.data.document[entity.index] as
              | UIKitDocument
              | undefined;
            this.paintStatic(rec);
            this.applyVisible(rec, false);
          }
        },
        true,
      ),
    );
  }

  /** Tag a known NPC: build its floating panel + cache its glow materials. */
  private tryTag(entity: Entity): void {
    const name = entity.object3D?.name ?? '';
    if (!NPCS[name] || this.tagged.has(name)) return;
    this.tagged.add(name);

    const tag = this.world.createTransformEntity().addComponent(PanelUI, {
      config: TAG_CONFIG,
      maxWidth: 0.55,
      maxHeight: 0.32,
    });
    tag.object3D!.visible = false;

    const mats: TagRecord['mats'] = [];
    entity.object3D?.traverse((o) => {
      const mesh = o as Mesh;
      const mat = mesh.material as MeshStandardMaterial | undefined;
      if (mesh.isMesh && mat && mat.isMeshStandardMaterial && mat.emissive) {
        mats.push({ mat, emissive: mat.emissive.getHex() });
      }
    });

    this.records.push({ name, npc: entity, tag, mats, near: false, shown: false });
  }

  update(): void {
    this.world.camera.getWorldPosition(this.camPos);

    for (const rec of this.records) {
      const obj = rec.npc.object3D;
      if (!obj) continue;
      obj.getWorldPosition(this.npcPos);
      const dist = this.camPos.distanceTo(this.npcPos);

      const show = dist <= SHOW_DIST;
      if (show !== rec.shown) this.applyVisible(rec, show);
      if (!show) {
        if (rec.near) this.applyNear(rec, false);
        continue;
      }

      // Position above the NPC's head + billboard (yaw) toward the camera.
      const tagObj = rec.tag.object3D!;
      tagObj.position.set(this.npcPos.x, this.npcPos.y + TAG_HEIGHT, this.npcPos.z);
      tagObj.rotation.set(
        0,
        Math.atan2(this.camPos.x - this.npcPos.x, this.camPos.z - this.npcPos.z),
        0,
      );

      const near = dist <= NEAR_DIST;
      if (near !== rec.near) this.applyNear(rec, near);
    }
  }

  // ─────────────────────────────── rendering ─────────────────────────────────

  /** Write the (static) name + role + action text once the doc is ready. */
  private paintStatic(rec: TagRecord): void {
    const info = NPCS[rec.name];
    this.text(rec, 'tag-name')?.setProperties({ text: rec.name });
    this.text(rec, 'tag-role')?.setProperties({ text: info.role });
    this.text(rec, 'tag-action')?.setProperties({ text: this.actionText(info.verb) });
  }

  private applyVisible(rec: TagRecord, show: boolean): void {
    rec.shown = show;
    if (rec.tag.object3D) rec.tag.object3D.visible = show;
    this.container(rec, 'tag-root')?.setProperties({ display: show ? 'flex' : 'none' });
  }

  /** Toggle the near-highlight: gold border, the action line, and NPC glow. */
  private applyNear(rec: TagRecord, near: boolean): void {
    rec.near = near;
    this.container(rec, 'tag-root')?.setProperties({
      borderColor: near ? BORDER_NEAR : BORDER_IDLE,
    });
    this.text(rec, 'tag-action')?.setProperties({ display: near ? 'flex' : 'none' });
    // The action verb can change with the phase (farmers talk in Spring, trade
    // in Summer), so refresh it as we enter the near state.
    if (near) {
      this.text(rec, 'tag-action')?.setProperties({
        text: this.actionText(NPCS[rec.name].verb),
      });
    }
    for (const m of rec.mats) {
      m.mat.emissive.setHex(near ? GLOW : m.emissive);
    }
  }

  private actionText(verb: 'talk' | 'trade' | 'both'): string {
    if (verb === 'trade') return 'Select to trade';
    if (verb === 'talk') return 'Select to talk';
    return gameState.currentPhase === 'Summer' ? 'Select to trade' : 'Select to talk';
  }

  private text(rec: TagRecord, id: string): UIKit.Text | undefined {
    return (rec.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(rec: TagRecord, id: string): UIKit.Container | undefined {
    return (rec.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }
}
