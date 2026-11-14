import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { canHitPlane, footprint, PLANES, STATS, type Entity, type Plane } from '@agent-command/game/contract';
import { canFireContact, canTarget, configureContacts, contactFireCount, contactHeight, CONTACT_ICON_PX, CONTACT_PICK_PX, createContactProjection, createContacts, isContact, pickContact, projectContact, weaponReach } from '../src/tools/contacts.ts';
import { unitY } from '../src/world/common.ts';
import { groundAt, type TerrainField } from '../src/world/terrain.ts';
import type { Track } from '../src/world/entities.ts';

// A non-flat source field catches accidental projection onto native/constant target altitude.
vi.mock('../src/world/terrain.ts', () => ({ groundAt: (x: number, y: number) => x * 0.01 + y * 0.02 }));
const HALF = 24;
const terrain = { groundAt: (x: number, y: number) => x * 0.01 + y * 0.02 } as TerrainField;

function unit(kind: keyof typeof STATS, id = kind as string, x = 20, y = 20, plane: Plane = STATS[kind].plane): Entity {
  return { id, kind, side: 'nw', plane, x, y, state: 'idle' } as Entity;
}
function track(e: Entity): Track { return { e, rx: e.x, ry: e.y, wy: 999, visible: false } as Track; }
function harness(source: Plane = 'sky', units = [unit('bomber')], scale = 30) {
  const contacts = createContacts();
  const view = createGame({ seed: 11 }).view('nw');
  view.entities = [];
  view.memory = [];
  configureContacts(contacts, { units, spire: false }, source, view);
  const world = {
    size: 48,
    layers: { surface: { field: terrain } },
    project: vi.fn((x: number, _height: number, z: number) => ({ x: (x + HALF) * scale, y: (z + HALF) * scale, behind: false })),
    entities: { tracks: new Map<string, Track>() },
  };
  const add = (e: Entity, visible = true) => {
    const tr = track(e);
    world.entities.tracks.set(e.id, tr);
    if (visible) view.entities.push(e);
    return tr;
  };
  return { contacts, view, world, add };
}

describe('registry-driven cross-plane contacts', () => {
  it.each(Object.keys(STATS) as (keyof typeof STATS)[])('%s collects every eligible target plane, not one nearest plane', (kind) => {
    const e = unit(kind);
    const h = harness(e.plane, [e]);
    const planes = PLANES.filter((plane) => plane !== e.plane && !!STATS[kind].dmg && canHitPlane(kind, e.plane, plane));
    expect([...h.contacts.planes]).toEqual(planes);
    expect(h.contacts.active).toBe(planes.length > 0);
    for (const plane of PLANES) expect(canTarget(e, plane)).toBe(!!STATS[kind].dmg && canHitPlane(kind, e.plane, plane));
  });

  it('anchors all source units but excludes other planes and incapable weapons from reach', () => {
    const units = [unit('flak', 'f', 18, 20), unit('tank', 't', 26, 28), unit('bomber', 'b', 40, 40)];
    const h = harness('surface', units);
    expect(h.contacts).toMatchObject({ active: true, source: 'surface', x: 22, y: 24, radius: weaponReach(units[0]!, h.view) });
    h.contacts.hovered = 'old';
    configureContacts(h.contacts, { units: [], spire: false }, 'surface', h.view);
    expect(h.contacts.active).toBe(false);
    expect(h.contacts.planes.size).toBe(0);
    expect(h.contacts.hovered).toBeUndefined();
  });

  it('uses current transit weapon capability, not researched movement permissions', () => {
    const e = { ...unit('interceptor', 'ascended', 20, 20, 'orbit'), transit: { to: 'orbit', at: 0, until: 500, return: 'sky' } } as Entity;
    expect(canTarget(e, 'orbit')).toBe(true);
    expect(canTarget(e, 'sky')).toBe(false);
    expect(harness('orbit', [e]).contacts.active).toBe(false);
  });

  it('makes researched Lancers Lens sources: own Lancers reach Sky units within lensReach, never Sky structures', () => {
    const lancer = unit('lancer', 'lancer', 20, 20);
    const h = harness('orbit', [lancer]);
    expect(canTarget(lancer, 'sky', h.view)).toBe(false);
    expect(h.contacts.active).toBe(false);
    h.view.research.completed = ['lancer_lens'];
    configureContacts(h.contacts, { units: [lancer], spire: false }, 'orbit', h.view);
    const reach = h.view.match!.rules.orbit.lensReach;
    expect(canTarget(lancer, 'sky', h.view)).toBe(true);
    expect([...h.contacts.planes]).toEqual(['sky']);
    expect(h.contacts.radius).toBe(reach);
    expect(weaponReach(lancer, h.view, 'sky')).toBe(reach);
    const near = { ...unit('interceptor', 'near', 20 + reach - 0.1, 20), side: 'se' } as Entity;
    const far = { ...unit('interceptor', 'far', 20 + reach + 0.5, 20), side: 'se' } as Entity;
    const relay = { ...unit('relay', 'relay', 20.5, 20), side: 'se' } as Entity;
    expect(canFireContact(lancer, near, h.view)).toBe(true);
    expect(canFireContact(lancer, far, h.view)).toBe(false);
    expect(canFireContact(lancer, relay, h.view)).toBe(false);
    // An enemy Lancer is never treated as a Lens source: the view carries only its own army's research.
    expect(canTarget({ ...lancer, side: 'se' } as Entity, 'sky', h.view)).toBe(false);
  });

  it('counts only individually capable in-range source weapons, without a centroid-disc gate', () => {
    const left = unit('bomber', 'left', 5, 20), right = unit('bomber', 'right', 40, 20);
    const h = harness('sky', [left, right, unit('interceptor', 'incapable', 5, 20), unit('bomber', 'wrong-plane', 5, 20, 'surface')]);
    const target = { ...unit('tank', 'target', 5, 20), side: 'se' } as Entity;
    expect(contactFireCount(h.contacts, target, h.view)).toBe(1);
    expect(canFireContact(left, target, h.view)).toBe(true);
    expect(canFireContact(right, target, h.view)).toBe(false);
    target.x = left.x + weaponReach(left, h.view);
    expect(canFireContact(left, target, h.view)).toBe(true);
    target.x += 0.01;
    expect(canFireContact(left, target, h.view)).toBe(false);
  });

  it('measures actual weapon reach to structure footprint edges', () => {
    const bomber = unit('bomber');
    const h = harness('sky', [bomber]);
    const target = unit('turret', 'target', bomber.x + weaponReach(bomber, h.view) + footprint('turret')!.w / 2, bomber.y);
    expect(canFireContact(bomber, target, h.view)).toBe(true);
    target.x += 0.01;
    expect(canFireContact(bomber, target, h.view)).toBe(false);
  });

  it('uses match-rules weapon range instead of the registry default', () => {
    const bomber = unit('bomber');
    const view = createGame({ seed: 11, options: { stats: { bomber: { range: 7 } } } }).view('nw');
    const contacts = createContacts();
    configureContacts(contacts, { units: [bomber], spire: false }, 'sky', view);
    expect(weaponReach(bomber, view)).toBe(7);
    expect(contacts.radius).toBe(7);
    const target = unit('tank', 'target', 26, 20);
    expect(canFireContact(bomber, target)).toBe(false);
    expect(canFireContact(bomber, target, view)).toBe(true);
    expect(contactFireCount(contacts, target, view)).toBe(1);
  });

  it('filters current target-plane fog, friendly/neutral/same-plane bodies, and never memory', () => {
    const h = harness();
    const enemy = { ...unit('tank', 'enemy'), side: 'se' } as Entity;
    const tr = h.add(enemy, false);
    h.view.memory = [{ id: enemy.id, kind: 'turret', side: 'se', plane: 'surface', x: 20, y: 20, seen: 0 }];
    expect(pickContact(h.contacts, h.view, h.world, 600, 600)).toBeUndefined();
    h.view.entities.push(enemy);
    expect(pickContact(h.contacts, h.view, h.world, 600, 600)).toBe(tr);
    for (const e of [{ ...enemy, side: 'nw' }, { ...enemy, side: 'neutral' }, { ...enemy, plane: 'sky' }] as Entity[]) expect(isContact(h.contacts, h.view, e)).toBe(false);
    h.view.entities = [];
    expect(pickContact(h.contacts, h.view, h.world, 600, 600)).toBeUndefined();
  });
});

describe('main-camera registered contact drawing and picking', () => {
  it.each(PLANES)('projects map coordinates at %s source height, ignoring native height and visibility', (source) => {
    const h = harness(source);
    const tr = track(unit('tank', 'enemy', 23, 27));
    const out = createContactProjection();
    expect(projectContact(h.world, source, tr, out)).toBe(true);
    expect(out).toMatchObject({ x: 690, y: 810, behind: false });
    const height = unitY(source) + (source === 'surface' ? groundAt(23, 27, terrain) : 0) + 0.04;
    expect(contactHeight(source, 23, 27, terrain)).toBe(height);
    expect(h.world.project).toHaveBeenCalledWith(23 - HALF, height, 27 - HALF);
    expect(h.world.project.mock.calls.every((call) => call[1] === height)).toBe(true);
  });

  it.each([0, 0.7, Math.PI])('shares the exact main perspective projection at yaw %s, including red orientation', (yaw) => {
    const camera = new PerspectiveCamera(50, 1.6, 0.1, 500);
    camera.position.set(Math.sin(yaw) * 60, 60, Math.cos(yaw) * 60);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const world = { size: 48, layers: { surface: { field: terrain } }, project: (x: number, y: number, z: number) => {
      const v = new Vector3(x, y, z).project(camera);
      return { x: (v.x + 1) * 800, y: (1 - v.y) * 500, behind: v.z < -1 || v.z > 1 };
    } };
    const tr = track(unit('tank', 'target', HALF + 4, HALF + 2));
    const out = createContactProjection();
    expect(projectContact(world, 'surface', tr, out)).toBe(true);
    const expected = world.project(4, contactHeight('surface', tr.rx, tr.ry, terrain), 2);
    expect(out.x).toBeCloseTo(expected.x, 8);
    expect(out.y).toBeCloseTo(expected.y, 8);
    if (yaw === 0) expect(out.x).toBeGreaterThan(800);
    if (yaw === Math.PI) expect(out.x).toBeLessThan(800);
  });

  it.each([0.5, 2, 8])('uses a readable constant icon and exact 12px pick radius at scale %s', (scale) => {
    const h = harness('sky', [unit('bomber')], scale);
    const tr = h.add({ ...unit('tank', 'enemy'), side: 'se' } as Entity);
    const out = createContactProjection();
    projectContact(h.world, 'sky', tr, out);
    expect(CONTACT_ICON_PX).toBe(18);
    expect(CONTACT_PICK_PX).toBe(12);
    expect(out.icon).toBe(true);
    expect(pickContact(h.contacts, h.view, h.world, out.x + 12, out.y)).toBe(tr);
    expect(pickContact(h.contacts, h.view, h.world, out.x + 12.01, out.y)).toBeUndefined();
  });

  it('picks exact projected structure polygons rather than their screen bounding box', () => {
    const h = harness();
    h.world.project.mockImplementation((x, _height, z) => ({ x: 600 + (x - z) * 30, y: 600 + (x + z) * 15, behind: false }));
    const tr = h.add({ ...unit('turret', 'enemy', HALF, HALF), side: 'se' } as Entity);
    const out = createContactProjection();
    projectContact(h.world, 'sky', tr, out);
    expect(out.icon).toBe(false);
    expect(pickContact(h.contacts, h.view, h.world, out.x, out.y)).toBe(tr);
    const xs = [out.quad[0]!, out.quad[2]!, out.quad[4]!, out.quad[6]!];
    const ys = [out.quad[1]!, out.quad[3]!, out.quad[5]!, out.quad[7]!];
    expect(pickContact(h.contacts, h.view, h.world, Math.min(...xs), Math.min(...ys))).toBeUndefined();
    expect(pickContact(h.contacts, h.view, h.world, Math.max(...xs) + 4, out.y)).toBe(tr);
    expect(pickContact(h.contacts, h.view, h.world, Math.max(...xs) + 4.01, out.y)).toBeUndefined();
  });

  it('keeps out-of-range contacts pickable, chooses the nearest, and rejects empty ground or behind-camera bodies', () => {
    const h = harness();
    const far = h.add({ ...unit('tank', 'far', 50, 50), side: 'se' } as Entity);
    h.add({ ...unit('tank', 'nearby', 51, 50), side: 'se' } as Entity);
    expect(contactFireCount(h.contacts, far.e, h.view)).toBe(0);
    expect(pickContact(h.contacts, h.view, h.world, 1500, 1500)).toBe(far);
    expect(pickContact(h.contacts, h.view, h.world, 0, 0)).toBeUndefined();
    h.world.project.mockReturnValue({ x: 1500, y: 1500, behind: true });
    expect(projectContact(h.world, 'sky', far, createContactProjection())).toBe(false);
    expect(pickContact(h.contacts, h.view, h.world, 1500, 1500)).toBeUndefined();
  });
});
