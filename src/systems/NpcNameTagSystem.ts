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
  Color,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PanelDocument,
  PanelUI,
  RayInteractable,
  RingGeometry,
  Transform,
  UIKit,
  UIKitDocument,
  Vector3,
  createSystem,
  eq,
  type Entity,
} from '@iwsdk/core';

import { gameState } from '../game/GameState.js';

const TAG_CONFIG = './ui/npc-nametag.json';

/** Distance (world units) for the tag to appear / for the "near" highlight. */
const SHOW_DIST = 8;
const NEAR_DIST = 4;
// An NPC you can click RIGHT NOW advertises itself from across the play area, so
// on desktop you can spot it and aim at it without walking right up first.
const FAR_DIST = 20;

/** Height above the NPC origin the tag floats. */
const TAG_HEIGHT = 2.5;

const BORDER_IDLE = '#1b140d';
const BORDER_NEAR = '#c79a4b';
const GLOW = 0x6a4e12; // soft warm emissive added when near
const GLOW_STRONG = 0xb8862a; // brighter gold while the NPC is clickable now
const RING_COLOR = 0xf6cf6a; // gold "interact here" ground ring

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
  ring?: Mesh; // gold "interact here" ground ring (shown only while clickable)
  near: boolean; // current highlight state (avoids re-writing each frame)
  shown: boolean; // current visibility (avoids re-writing each frame)
  interactive: boolean; // current clickable state (avoids re-writing each frame)
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

    // A generous, invisible click cylinder around the NPC so the mouse/ray hits
    // them easily from a distance (the modeled figure is thin). It is raycast
    // (visible) but fully transparent, so it never shows — it only enlarges the
    // hit target. Added as a child so it's part of the NPC's RayInteractable.
    const hitbox = new Mesh(
      new CylinderGeometry(0.65, 0.65, 2.1, 8),
      new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hitbox.position.y = 1.05;
    hitbox.name = `${name}-hitbox`;
    entity.object3D?.add(hitbox);

    // A gold "interact here" ring on the ground, shown only while the NPC is
    // clickable — a big, flat, unmissable marker for young players.
    const ring = new Mesh(
      new RingGeometry(0.6, 0.85, 28),
      new MeshBasicMaterial({
        color: new Color(RING_COLOR),
        transparent: true,
        opacity: 0.85,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2; // lay it flat on the ground
    ring.position.y = 0.06;
    ring.visible = false;
    entity.object3D?.add(ring);

    this.records.push({
      name,
      npc: entity,
      tag,
      mats,
      ring,
      near: false,
      shown: false,
      interactive: false,
    });
  }

  update(_delta: number, time: number): void {
    this.world.camera.getWorldPosition(this.camPos);

    for (const rec of this.records) {
      const obj = rec.npc.object3D;
      if (!obj) continue;

      // "Interactive" = clickable in the current phase (its owner system has
      // added RayInteractable). Clickable NPCs advertise from across the map and
      // get the ground ring; others fall back to the short-range proximity tag.
      const interactive = rec.npc.hasComponent(RayInteractable);
      if (interactive !== rec.interactive) this.applyInteractive(rec, interactive);

      obj.getWorldPosition(this.npcPos);
      const dist = this.camPos.distanceTo(this.npcPos);

      const show = dist <= (interactive ? FAR_DIST : SHOW_DIST);
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

      // Pulse the ground ring so a clickable NPC catches the eye.
      if (rec.ring && rec.ring.visible) {
        const s = 1 + 0.12 * Math.sin(time * 3);
        rec.ring.scale.set(s, s, s);
      }

      // A clickable NPC always shows its action verb + glow; a non-interactive
      // one only does so up close (the old proximity behavior).
      const near = interactive || dist <= NEAR_DIST;
      if (near !== rec.near) this.applyNear(rec, near);
    }
  }

  /** Toggle the "clickable now" affordance: show/hide the gold ground ring. */
  private applyInteractive(rec: TagRecord, interactive: boolean): void {
    rec.interactive = interactive;
    if (rec.ring) rec.ring.visible = interactive;
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
    const glow = rec.interactive ? GLOW_STRONG : GLOW;
    for (const m of rec.mats) {
      m.mat.emissive.setHex(near ? glow : m.emissive);
    }
  }

  private actionText(verb: 'talk' | 'trade' | 'both'): string {
    if (verb === 'trade') return 'Click to trade';
    if (verb === 'talk') return 'Click to talk';
    return gameState.currentPhase === 'Summer' ? 'Click to trade' : 'Click to talk';
  }

  private text(rec: TagRecord, id: string): UIKit.Text | undefined {
    return (rec.doc?.getElementById(id) as UIKit.Text | null) ?? undefined;
  }

  private container(rec: TagRecord, id: string): UIKit.Container | undefined {
    return (rec.doc?.getElementById(id) as UIKit.Container | null) ?? undefined;
  }
}
