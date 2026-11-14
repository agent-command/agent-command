import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Vector3 } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { PLANE_Y, type Entity } from '@agent-command/game/contract';
import { OrbitAbilityFx } from '../src/world/orbit-ability-fx.ts';
import { Combat } from '../src/world/combat.ts';
import { applyFade } from '../src/world/fade.ts';
import { Entities, type Track } from '../src/world/entities.ts';
import { coreTip } from '../src/rock-panel.ts';

function ship(id: string, kind: Entity['kind'], x = 10, y = 10): Entity {
  return { id, kind, side: 'nw', plane: 'orbit', x, y, hp: 100, maxHp: 100, state: 'idle' };
}
function track(e: Entity): Track {
  return { e, rx: e.x, ry: e.y, wy: PLANE_Y.orbit, visible: true, heading: 0, speed: 3 } as Track;
}
function setup() {
  applyFade(3);
  const view = createGame({ seed: 1 }).view('nw');
  view.tick = 100;
  view.entities = [];
  view.fx = [];
  const fx = new OrbitAbilityFx(48);
  const combat = new Combat(undefined, 48);
  const ingest = () => { fx.ingest(view, at); combat.ingest(view, at); };
  const update = (now: number, tracks: ReadonlyMap<string, Track>) => {
    combat.tracks = tracks;
    combat.frame(now, 1 / 60, PLANE_Y.orbit + 20, now / 50);
    fx.update(now, tracks, PLANE_Y.orbit + 20);
  };
  const mesh = (name: string) => fx.root.getObjectByName(name) as InstancedMesh;
  return { view, fx, combat, mesh, ingest, update };
}
const at = (tick: number) => tick * 50;

describe('pooled Orbit ability visuals', () => {
  it('retains travelling lances on join, deduplicates snapshot tails and reuses the weapon projectile buffers', () => {
    const { view, combat, mesh, ingest, update } = setup();
    view.fx = [{ kind: 'lance', plane: 'orbit', tick: 95, x: 10, y: 10, tx: 22, ty: 10, arrive: 120 }];
    ingest();
    const bolts = combat.shots.bodies;
    const buffer = bolts.instanceMatrix.array;
    update(5000, new Map());
    expect(bolts.count).toBe(1);
    expect(mesh('orbit-ability-lines').count).toBe(0);
    const m = new Matrix4();
    bolts.getMatrixAt(0, m);
    expect(new Vector3().setFromMatrixPosition(m).x).toBeCloseTo(12.4 - 0.13 - 24);
    ingest();
    update(5500, new Map());
    expect(combat.shots.n).toBe(1);
    expect(bolts.count).toBe(1);
    expect(bolts.instanceMatrix.array).toBe(buffer);
    update(6500, new Map());
    expect(bolts.count).toBe(0);
  });

  it('uses shared local impact pools without constructing an unseen shooter trajectory', () => {
    const { view, combat, mesh, ingest, update } = setup();
    view.fx = [{ kind: 'lance_hit', plane: 'orbit', tick: 100, x: 20, y: 15 }];
    ingest();
    update(5100, new Map());
    expect(combat.shots.n).toBe(0);
    expect(combat.rings.mesh.count).toBe(1);
    expect(combat.sparks.mesh.count).toBeGreaterThan(0);
    expect(mesh('orbit-ability-lines').count).toBe(0);
  });

  it('renders charge, covering shield domes and cloak shimmer only from current visible tracks', () => {
    const { view, fx, combat, mesh, ingest, update } = setup();
    const lancer = { ...ship('lancer', 'lancer'), lance: { x: 22, y: 10, at: 140 } };
    const bastion = { ...ship('bastion', 'bastion', 20, 20), aegis: { until: 220, pool: 120 } };
    const ally = ship('ally', 'tug', 21, 20);
    const enemy = { ...ship('enemy', 'tug', 20, 21), side: 'se' as const };
    const cloak = { ...ship('cloak', 'skiff', 30, 30), cloaked: true as const };
    const entities = [lancer, bastion, ally, enemy, cloak];
    const tracks = new Map(entities.map((e) => [e.id, track(e)]));
    ingest();
    update(5050, tracks);
    expect(mesh('orbit-ability-lines').count).toBe(1);
    expect(combat.orbitShields.mesh.count).toBe(1);
    // Charge ring, full Aegis footprint, Bastion coverage and nearby allied tug; never the enemy tug.
    expect(mesh('orbit-ability-rings').count).toBe(4);
    expect(mesh('orbit-cloak-shimmer').count).toBe(1);
    tracks.delete('cloak');
    tracks.get('lancer')!.visible = false;
    tracks.get('bastion')!.visible = false;
    update(5100, tracks);
    expect(mesh('orbit-cloak-shimmer').count).toBe(0);
    expect(combat.orbitShields.mesh.count).toBe(0);
    expect(mesh('orbit-ability-lines').count).toBe(0);
    fx.reset();
    for (const child of fx.root.children) expect((child as InstancedMesh).count).toBe(0);
  });

  it('shows a surviving vent as steam, not a terminal explosion, and deduplicates the FX tail', () => {
    const { view, combat, ingest, update } = setup();
    view.fx = [{ kind: 'core_vent', subject: 'core', plane: 'orbit', tick: 100, x: 10, y: 10, radius: 3 }];
    ingest();
    update(5000, new Map());
    expect(combat.smoke.n).toBeGreaterThan(0);
    expect(combat.debris.n + combat.sparks.n).toBe(0);
    expect(combat.shake).toBe(0);
    const smoke = combat.smoke.n;
    ingest();
    update(5050, new Map());
    expect(combat.smoke.n).toBe(smoke);
    view.tick = 102;
    view.fx = [{ kind: 'volatile_detonation', subject: 'core', plane: 'orbit', tick: 102, x: 10, y: 10, radius: 4 }];
    ingest();
    update(5100, new Map());
    expect(combat.debris.n + combat.sparks.n).toBeGreaterThan(0);
  });

  it('removes a consumed carried core from actual entity tracks while retaining a vented or released core', () => {
    const { view } = setup();
    const units = new Entities(false, undefined, 48);
    const tug: Entity = { ...ship('tug', 'tug'), state: 'towing', link: 'core', heading: 0 };
    const core: Entity = { ...ship('core', 'core'), side: 'neutral', state: 'towed', link: tug.id, heat: 80, heatRate: 1 };
    view.entities = [tug, core];
    units.ingest(view, 5000);
    units.frame(5000, 5, new Set(), undefined, 'nw', 'orbit', 26);
    const payload = units.tracks.get(core.id)!;
    expect(Math.hypot(payload.rx - units.tracks.get(tug.id)!.rx, payload.ry - units.tracks.get(tug.id)!.ry)).toBeCloseTo(2.6);
    view.tick++;
    view.entities = [tug, { ...core, heat: 25, vents: 1 }];
    view.fx = [{ kind: 'core_vent', subject: 'core', plane: 'orbit', tick: view.tick, x: 10, y: 10 }];
    units.ingest(view, 5050);
    expect(units.tracks.get(core.id)!.e.link).toBe(tug.id);
    view.tick++;
    view.entities = [{ ...tug, link: undefined, state: 'idle' }, { ...core, link: undefined, state: 'idle' }];
    units.ingest(view, 5100);
    expect(units.tracks.get(core.id)!.e.state).toBe('idle');
    view.tick++;
    view.entities = [{ ...tug, link: undefined, state: 'idle' }];
    view.fx = [{ kind: 'volatile_detonation', subject: 'core', plane: 'orbit', tick: view.tick, x: 10, y: 10 }];
    units.ingest(view, 5150);
    units.frame(5150, 5.15, new Set(), undefined, 'nw', 'orbit', 26);
    expect(units.tracks.has(core.id)).toBe(false);
    expect(units.tracks.get(tug.id)!.e.link).toBeUndefined();
    units.ingest(view, 5200);
    expect(units.tracks.has(core.id)).toBe(false);
  });

  it('shows only an observed, nonfalling core heat deadline', () => {
    const { view } = setup();
    const core: Entity = { ...ship('core', 'core'), heat: 80, heatRate: 0.6, state: 'towed' };
    expect(coreTip(core, view.match!.rules).title).toContain('~34s to meltdown');
    expect(coreTip({ ...core, heat: undefined }, view.match!.rules).title).not.toContain('to meltdown');
    expect(coreTip({ ...core, heatRate: -5 }, view.match!.rules).title).not.toContain('to meltdown');
    expect(coreTip({ ...core, state: 'falling' }, view.match!.rules).title).not.toContain('to meltdown');
  });
});
