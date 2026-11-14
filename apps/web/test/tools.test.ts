import { describe, expect, it, vi } from 'vitest';
import { createGame } from '@agent-command/game';
import { canHitPlane, CELL, PLANES, STATS, TICK_RATE, type Entity, type Plane, type QueueEntryOut, type UnitKind, type View } from '@agent-command/game/contract';
import type { ControlHost } from '../src/controls.ts';
import type { Overlay } from '../src/overlay.ts';
import { TOOL_META, type ToolId } from '../src/tools/catalog.ts';
import { eligible, getTool, PLANE_TOOLS, resolvePointer, ToolSession, type Armed, type ToolContext, type ToolPointer } from '../src/tools/index.ts';
import type { Track } from '../src/world/entities.ts';
import type { World } from '../src/world/world.ts';
import { configureLens, createLens } from '../src/tools/lens.ts';
import { canFireContact, canTarget, configureContacts, createContacts, pickContact } from '../src/tools/contacts.ts';
import { movementOrders } from '../src/tools/orders.ts';

import { TerrainField } from '../src/world/terrain.ts';
const pointer: ToolPointer = { x: 8.25, y: 9.75, button: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };
function unit(kind: UnitKind, id: string = kind, x = 2, y = 3, plane: Plane = 'depths'): Entity {
  return { id, kind, side: 'nw', plane, x, y, state: 'idle' } as Entity;
}
function harness(plane: Plane = 'depths', units: Entity[] = [], mode?: Armed, size: 48 | 64 | 80 = 48) {
  const view = createGame({ seed: 1, options: { map: { params: { size } }, depths: { designateCells: 256 } } }).view('nw');
  Object.assign(view, { entities: [], memory: [], queue: [], lodes: [], vision: Object.fromEntries(PLANES.map((p) => [p, Array<number>(Math.ceil(size * size / 30)).fill(1073741823)])), research: { completed: [] }, depths: Array<number>(size * size).fill(CELL.tunnel), holes: [], pockets: [] });
  const world = {
    size,
    layers: { surface: { field: new TerrainField(size) } },
    rig: { focus: plane, edge: { x: 0, y: 0 }, camera: { position: { x: 0, y: 60, z: 0 } } },
    pickTile: vi.fn((x: number, y: number, _plane?: Plane) => ({ x, y })),
    groundPoint: vi.fn((x: number, y: number, _plane?: Plane) => ({ x, y })),
    project: vi.fn((x: number, _y: number, z: number) => ({ x: x + size / 2, y: z + size / 2, behind: false })),
    pickEntity: vi.fn((_x: number, _y: number, _radius?: number): Track | undefined => undefined),
    designations: { showPreview: vi.fn() }, pointAway: vi.fn(),
    entities: { tracks: new Map<string, Track>() }, lens: { show: vi.fn() },
    orbitAbilities: { aim: vi.fn() },
  };
  const host = {
    view: () => view, act: vi.fn<ControlHost['act']>(async () => true), canQueue: () => true,
    toast: vi.fn(), goTo: vi.fn(), jumpTo: vi.fn(), toggleCommander: vi.fn(), pickDirective: vi.fn(), changed: vi.fn(), hint: vi.fn(),
  } satisfies ControlHost;
  const overlay = { pings: [], preview: undefined, drag: undefined } as unknown as Overlay;
  const c: ToolContext = { world: world as unknown as World, overlay, host, selection: { units, spire: false }, state: {}, mode, select: vi.fn(), box: vi.fn(), cancel: vi.fn() };
  return { c, world, host, view, overlay, session: (id: ToolId) => {
    const session = new ToolSession(getTool(id), () => c);
    const lens = session.state.lens!;
    // Lifecycle tests isolate peek/ability geometry; lens-mapping covers its orthographic transform.
    vi.spyOn(lens, 'update').mockImplementation(() => {});
    vi.spyOn(lens, 'point').mockImplementation((x, y) => ({ x, y }));
    vi.spyOn(lens, 'project').mockImplementation((x, y, z) => world.project(x, y, z));
    return session;
  } };
}

describe('large-map tool coordinates', () => {
  it.each([64, 80] as const)('keeps full-range orders and designation paths on S%s', (size) => {
    const actor = unit('digger', 'edge', size - 5.5, size - 5.5);
    const h = harness('depths', [actor], undefined, size);
    const p = { ...pointer, x: size - 3.25, y: size - 3.5 };
    expect(getTool('move').commit(h.c, p)).toMatchObject([{ x: p.x, y: p.y }]);
    expect(getTool('fortify').commit(h.c, p)).toMatchObject([{ x: size - 4, y: size - 4 }]);
    const cell = (size - 4) * size + size - 4;
    h.view.depths[cell] = CELL.rock;
    const session = h.session('default');
    session.start({ ...p, button: 2 });
    session.move({ ...p, x: p.x + 1, button: 2 });
    session.end({ ...p, x: p.x + 1, button: 2 });
    expect(h.host.act).toHaveBeenCalledWith('depths', expect.arrayContaining([
      expect.objectContaining({ kind: 'designate', rect: { x0: size - 4, y0: size - 4, x1: size - 3, y1: size - 4 } }),
      expect.objectContaining({ kind: 'dig', x: size - 4, y: size - 4 }),
    ]));
  });
});

describe('plane tool registry', () => {
  it('offers explicit mining and whole-rock towing without trusting stale tracks', () => {
    const tug = unit('tug', 'tug', 20, 20, 'orbit');
    const h = harness('orbit', [tug]);
    const rock: Entity = { id: 'rock', kind: 'asteroid', side: 'neutral', plane: 'orbit', x: 25, y: 25, hp: 100, maxHp: 100, state: 'drifting', resourceType: 'ice', resourceRemaining: 50, volatile: true };
    h.world.pickEntity.mockReturnValue({ e: rock } as Track);
    const mine = getTool('mine_asteroid'), tow = getTool('grapple');
    expect(mine.card?.(h.c.selection, h.view)).toBe(true);
    expect(tow.card?.(h.c.selection, h.view)).toBe(true);
    expect(mine.commit(h.c, pointer)).toEqual([]);
    h.view.entities.push(rock);
    expect(mine.commit(h.c, { ...pointer, shiftKey: true })).toEqual([{ kind: 'mine_asteroid', units: ['tug'], asteroid: 'rock', queue: true }]);
    expect(tow.commit(h.c, pointer)).toEqual([{ kind: 'grapple', units: ['tug'], asteroid: 'rock' }]);
    rock.resourceType = 'slag';
    expect(mine.commit(h.c, pointer)).toEqual([]);
    expect(tow.commit(h.c, pointer)).toHaveLength(1);
    rock.resourceType = 'metal';
    rock.resourceRemaining = 0;
    expect(mine.commit(h.c, pointer)).toEqual([]);
  });
  it('implements each catalog entry once and constrains every entry to its declared planes', () => {
    expect(PLANE_TOOLS.map((tool) => tool.id)).toEqual(TOOL_META.map((tool) => tool.id));
    expect(new Set(PLANE_TOOLS.map((tool) => tool.id)).size).toBe(PLANE_TOOLS.length);
    const h = harness('depths', [unit('digger'), unit('trooper'), unit('sapper'), unit('tug')]);
    for (const tool of PLANE_TOOLS) {
      expect(typeof tool.commit).toBe('function');
      for (const plane of PLANES)
        expect(eligible(tool, plane, h.c.selection, h.view)).toBe(tool.planes.includes(plane) && tool.applies(h.c.selection, h.view));
    }
  });

  it('dispatches researched, ready Ascent through the Sky tool and respects its energy cost', () => {
    const ready = unit('interceptor', 'ready', 20, 20, 'sky');
    const cooling = { ...ready, id: 'cooling', transitReady: 101 };
    const h = harness('sky', [ready, cooling]);
    Object.assign(h.view, { tick: 100, res: { ...h.view.res, energy: 50, freeEnergy: 50 }, research: { available: ['ascent_thrusters'], inProgress: [], completed: [], seen: [] } });
    expect(getTool('ascend').immediate).toBe(true);
    expect(getTool('ascend').commit(h.c, pointer)).toEqual([]);
    h.view.research.completed = ['ascent_thrusters'];
    h.view.res.energy = h.view.res.freeEnergy = 24;
    expect(getTool('ascend').commit(h.c, pointer)).toEqual([]);
    h.view.res.energy = h.view.res.freeEnergy = 25;
    h.session('ascend').click(pointer);
    expect(h.host.act).toHaveBeenCalledWith('sky', [{ kind: 'ascend', units: ['ready'] }]);
  });

  it('aims the free Sun lance in Orbit and submits only ready sunlit Lancers', () => {
    const h = harness('orbit');
    const a = h.view.sun.angle;
    const ready = unit('lancer', 'ready', h.world.size / 2 + Math.cos(a) * 8, h.world.size / 2 + Math.sin(a) * 8, 'orbit');
    const night = unit('lancer', 'night', h.world.size / 2 - Math.sin(a) * 8, h.world.size / 2 + Math.cos(a) * 8, 'orbit');
    h.c.selection.units = [ready, night, { ...ready, id: 'cooling', abilityReady: h.view.tick + 100 }];
    h.view.res.energy = h.view.res.freeEnergy = h.view.match!.rules.orbit.lanceEnergy;
    const tool = getTool('sun_lance');
    expect(tool.readiness?.(h.c.selection, h.view)).toMatchObject({ enabled: true, status: '1/3 ready' });
    expect(tool.commit(h.c, pointer)).toEqual([{ kind: 'sun_lance', units: ['ready'], x: pointer.x, y: pointer.y }]);
    tool.preview!(h.c, pointer);
    expect(h.world.orbitAbilities.aim).toHaveBeenCalledWith(pointer.x, pointer.y, h.c.selection.units);
    tool.reset!(h.c);
    expect(h.world.orbitAbilities.aim).toHaveBeenLastCalledWith();
    h.view.res.energy--;
    h.view.res.freeEnergy--;
    expect(tool.commit(h.c, pointer)).toEqual([]);
    h.c.selection.units = [night];
    expect(tool.readiness?.(h.c.selection, h.view)?.status).toBe('Requires sunlight');
    expect(tool.commit(h.c, pointer)).toEqual([]);
  });

  it('gates Aegis behind its research, current shield, cooldown and shared energy', () => {
    const bastion = { ...unit('bastion', 'escort', 20, 20, 'orbit'), shield: 80 };
    const h = harness('orbit', [bastion]);
    const tool = getTool('aegis');
    expect(tool.immediate).toBe(true);
    expect(tool.readiness?.(h.c.selection, h.view)?.status).toBe('Research Aegis Projectors');
    expect(tool.commit(h.c, pointer)).toEqual([]);
    h.view.research.completed = ['aegis_projectors'];
    h.view.res.energy = h.view.res.freeEnergy = h.view.match!.rules.orbit.aegisEnergy;
    expect(tool.commit(h.c, pointer)).toEqual([{ kind: 'aegis', units: ['escort'] }]);
    bastion.shield = 0;
    expect(tool.readiness?.(h.c.selection, h.view)?.status).toBe('Requires shield');
    expect(tool.commit(h.c, pointer)).toEqual([]);
    bastion.shield = 80;
    h.c.selection.units = [{ ...bastion, abilityReady: h.view.tick + 40 }];
    expect(tool.readiness?.(h.c.selection, h.view)?.status).toBe('Cooldown 2s');
    expect(tool.commit(h.c, pointer)).toEqual([]);
  });

  it('affords Orbit abilities from the free bank plus only the Orbit lane’s own earmark', () => {
    const bastion = { ...unit('bastion', 'escort', 20, 20, 'orbit'), shield: 80 };
    const h = harness('orbit', [bastion]);
    h.view.research.completed = ['aegis_projectors'];
    const orbit = h.view.match!.rules.orbit;
    const price = Math.max(orbit.scanCost, orbit.aegisEnergy);
    // A rich bank, all of it earmarked: only a hold in the acting seat's own lane is spendable.
    Object.assign(h.view.res, { energy: 10 * price, freeEnergy: 0, scanReadyAt: 0 });
    const hold = (plane: Plane, extra: Partial<QueueEntryOut> = {}): QueueEntryOut => ({
      id: `q_${plane}`, item: 'lancer', plane, by: plane, byCtl: 'human', alloy: 0, energy: price,
      heldAlloy: 0, heldEnergy: price, recovery: false, paid: false, next: true, status: 'waiting', progress: 0, ...extra,
    });
    const ready = () => (['scan', 'aegis'] as const).map((id) => getTool(id).readiness!(h.c.selection, h.view).enabled);
    for (const queue of [[hold('surface')], [hold('orbit', { recovery: true })], [hold('orbit', { paid: true })]]) {
      h.view.queue = queue;
      expect(ready()).toEqual([false, false]);
      expect(getTool('aegis').commit(h.c, pointer)).toEqual([]);
    }
    h.view.queue = [hold('surface'), hold('orbit')];
    expect(ready()).toEqual([true, true]);
    expect(getTool('aegis').commit(h.c, pointer)).toEqual([{ kind: 'aegis', units: ['escort'] }]);
  });

  it('targets Orbit enemies with ascended interceptors instead of issuing a move', () => {
    const e: Entity = { ...unit('interceptor', 'raider', 20, 20, 'orbit'), transit: { to: 'orbit', at: 0, until: 500, return: 'sky' } };
    const h = harness('orbit', [e]);
    h.view.tick = 100;
    const target = { e: { ...unit('solar', 'enemy', 22, 20, 'orbit'), side: 'se' }, rx: 22, ry: 20 } as Track;
    h.view.entities.push(target.e);
    h.world.pickEntity.mockReturnValue(target);
    expect(getTool('default').commit(h.c, { ...pointer, button: 2 })).toEqual([{ kind: 'attack', units: ['raider'], target: 'enemy' }]);
  });

  it('keeps subgroup card visibility separate from whole-selection keyboard applicability', () => {
    const h = harness('depths', [unit('digger'), unit('trooper')]);
    h.c.selection.activeKind = 'trooper';
    expect(getTool('mine').card?.(h.c.selection, h.view)).toBe(false);
    expect(eligible(getTool('mine'), 'depths', h.c.selection, h.view)).toBe(true);
    expect(getTool('breach').card?.(h.c.selection, h.view)).toBe(true);
    h.c.selection.units = [];
    expect(getTool('designate').card?.(h.c.selection, h.view)).toBe(true);
    expect(getTool('rally').card?.(h.c.selection, h.view)).toBe(false);
    h.c.selection.spire = true;
    expect(getTool('rally').card?.(h.c.selection, h.view)).toBe(true);
  });

  it('deploys and packs only the units the order changes (Wardens, troopers, tanks, flak), and throws a flare from the nearest ready Warden in range', () => {
    const warden = (id: string, x: number, y: number, extra: Partial<Entity> = {}): Entity => ({ ...unit('warden', id, x, y), hp: 160, maxHp: 160, ...extra });
    const h = harness('depths', [warden('down', 2, 3), warden('up', 4, 3, { state: 'walled' }), warden('rising', 5, 3, { state: 'walling' }), unit('digger')]);
    expect(getTool('deploy').immediate).toBe(true);
    expect(getTool('deploy').commit(h.c, pointer)).toEqual([{ kind: 'deploy', units: ['down'], on: true }]);
    expect(getTool('pack').commit(h.c, pointer)).toEqual([{ kind: 'deploy', units: ['up', 'rising'], on: false }]);
    expect(getTool('deploy').readiness!(h.c.selection, h.view)).toMatchObject({ enabled: true, status: '1/3 ready' });
    expect(getTool('pack').readiness!(h.c.selection, h.view)).toMatchObject({ enabled: true, status: '2/3 deployed' });
    for (const id of ['deploy', 'pack', 'flare'] as const) {
      expect(getTool(id).role?.(h.c)).toBe('depths');
      expect(getTool(id).card?.(h.c.selection, h.view)).toBe(true);
    }
    const s = harness('surface', [
      { ...unit('tank', 'tk', 2, 3, 'surface'), hp: 300 }, { ...unit('trooper', 'tr', 3, 3, 'surface'), hp: 100, state: 'dug_in' },
      { ...unit('flak', 'fl', 4, 3, 'surface'), hp: 150, state: 'emplacing' },
    ]);
    expect(getTool('deploy').role?.(s.c)).toBe('surface');
    expect(getTool('deploy').commit(s.c, pointer)).toEqual([{ kind: 'deploy', units: ['tk'], on: true }]);
    expect(getTool('pack').commit(s.c, pointer)).toEqual([{ kind: 'deploy', units: ['tr', 'fl'], on: false }]);
    const range = h.view.match!.rules.depths.flareRange;
    // The cell at (8, 9): 'up' and 'rising' are within range; 'rising' is the nearest ready one.
    h.c.selection.units = [warden('far', 8.5 + range + 1, 9.5), warden('up', 6, 9.5), warden('rising', 7.5, 9.5)];
    expect(getTool('flare').commit(h.c, pointer)).toEqual([{ kind: 'flare', unit: 'rising', x: 8.5, y: 9.5 }]);
    h.c.selection.units[2]!.abilityReady = h.view.tick + 40;
    expect(getTool('flare').commit(h.c, pointer)).toEqual([{ kind: 'flare', unit: 'up', x: 8.5, y: 9.5 }]);
    h.view.depths[9 * h.world.size + 8] = CELL.rock;
    expect(getTool('flare').commit(h.c, pointer)).toEqual([]);
    expect(h.host.toast).toHaveBeenLastCalledWith('Throw flares onto a known open tunnel cell');
    h.view.depths[9 * h.world.size + 8] = CELL.tunnel;
    h.c.selection.units = [warden('far', 8.5 + range + 1, 9.5)];
    expect(getTool('flare').commit(h.c, pointer)).toEqual([]);
    expect(h.host.toast).toHaveBeenLastCalledWith(`No ready Warden within ${range} tiles`);
  });

  it.each([['fortify', 'digger'], ['fortify', 'warden'], ['undermine', 'sapper'], ['breach', 'trooper'], ['rail', 'digger']] as const)('%s commits the selected unit kind (%s) at a snapped cell with Shift queueing', (kind, actor) => {
    const h = harness('depths', [unit(actor), unit('tank')]);
    expect(getTool(kind).commit(h.c, { ...pointer, shiftKey: true })).toEqual([{ kind, units: [actor], x: 8, y: 9, queue: true }]);
    expect(h.overlay.pings).toHaveLength(1);
    expect(getTool(kind).role?.(h.c)).toBe('depths');
  });

  it('sends backfill to the nearest digger and queues bulkheads from the human seat with that builder', async () => {
    const h = harness('depths', [unit('digger', 'far'), unit('digger', 'near', 8.5, 9.5)]);
    expect(getTool('bridge').commit(h.c, pointer)).toEqual([{ kind: 'bridge', units: ['near'], x: 8, y: 9 }]);
    h.session('bulkhead').click(pointer);
    expect(h.host.act).toHaveBeenCalledWith('depths', [{ kind: 'queue_add', item: 'bulkhead', x: 8, y: 9, digger: 'near' }]);
    await Promise.resolve();
    expect(h.host.toast).toHaveBeenCalledWith('Bulkhead queued', 'ok');
  });

  it('prices Backfill from the match rules and names only the hole kinds it allows', () => {
    const h = harness('depths', [unit('digger')]);
    const tool = getTool('bridge');
    expect(tool.label).toBe('Backfill');
    // lava lakes are on by default: this match turns them off and the team knows no lake cells
    const base = h.view.match!.rules;
    const rules = { ...base, map: { ...base.map, lavaLakes: { ...base.map.lavaLakes, enabled: false } } };
    const dry = { ...h.view, match: { ...h.view.match!, rules } } as View;
    const ready = tool.readiness!(h.c.selection, dry);
    expect(ready).toMatchObject({ enabled: true, cost: { alloy: rules.depths.bridgeCost } });
    // no lakes this match: the tool's own label
    expect(ready.label).toBeUndefined();
    expect(ready.description).toContain(`Fills sinkholes, craters, chasms, breaches · ${rules.depths.bridgeCost} alloy and ${rules.depths.bridgeTime}s per cell`);
    const only = (backfillKinds: number) => ({ ...dry, match: { ...dry.match!, rules: { ...rules, depths: { ...rules.depths, backfillKinds } } } }) as View;
    expect(tool.readiness!(h.c.selection, only(0b0101)).description).toContain('Fills sinkholes, chasms ·');
    expect(tool.readiness!(h.c.selection, only(0))).toMatchObject({ enabled: false, status: 'No backfill this match' });
  });

  it('bridges a known lava-lake cell with every selected digger, Ctrl+right-click too, and prices it when the match has lakes', () => {
    const h = harness('depths', [unit('digger', 'far'), unit('digger', 'near', 8.5, 9.5)]);
    const size = h.world.size;
    h.view.depths[9 * size + 8] = CELL.lake;
    const bridge = [{ kind: 'bridge', units: ['far', 'near'], x: 8, y: 9 }];
    expect(getTool('bridge').commit(h.c, pointer)).toEqual(bridge);
    const p = { ...pointer, ctrlKey: true, button: 2 };
    getTool('default').preview!(h.c, p);
    expect(h.overlay.preview?.label).toContain('Bridge this lava');
    expect(getTool('default').commit(h.c, p)).toEqual(bridge);
    // farther than lavaBridgeSpan from dry ground (team knowledge): no contextual bridge
    const rules = h.view.match!.rules;
    const reach = rules.depths.lavaBridgeSpan + 1;
    for (let y = 9 - reach; y <= 9 + reach; y++) for (let x = 8 - reach; x <= 8 + reach; x++) h.view.depths[y * size + x] = CELL.lake;
    expect(getTool('default').commit(h.c, p)).toEqual([]);
    // a plain right-click there says why instead of walking the diggers into the lava
    expect(getTool('default').commit(h.c, { ...pointer, button: 2 })).toEqual([]);
    expect(h.host.toast).toHaveBeenLastCalledWith(`Too far out to bridge · lava bridges reach ${rules.depths.lavaBridgeSpan} cells from dry ground or a bridge`);
    const lakes = { ...h.view, match: { ...h.view.match!, rules: { ...rules, map: { ...rules.map, lavaLakes: { ...rules.map.lavaLakes, enabled: true } }, depths: { ...rules.depths, backfillKinds: 0 } } } } as View;
    const ready = getTool('bridge').readiness!(h.c.selection, lakes);
    expect(ready).toMatchObject({ enabled: true, cost: { alloy: rules.depths.lavaBridgeCost }, label: 'Bridge lava' });
    expect(ready.description).toContain(`up to ${rules.depths.lavaBridgeSpan} cells out · ${rules.depths.lavaBridgeCost} alloy and ${rules.depths.lavaBridgeTime}s per cell`);
    // holes and lakes both: the card names both jobs
    expect(getTool('bridge').readiness!(h.c.selection, { ...lakes, match: { ...lakes.match!, rules: { ...lakes.match!.rules, depths: rules.depths } } } as View).label).toBe('Backfill / bridge');
  });

  it('queues taps only beside known sealed pockets, with an optional selected digger', () => {
    const h = harness('depths', [unit('digger', 'crew')]);
    h.view.depths[9 * h.world.size + 8] = CELL.rock;
    expect(getTool('geothermal').commit(h.c, pointer)).toEqual([]);
    h.view.pockets.push({ x: 9, y: 9, id: 1 });
    expect(getTool('geothermal').commit(h.c, pointer)).toEqual([{ kind: 'queue_add', item: 'geothermal', x: 8, y: 9, digger: 'crew' }]);
    h.c.selection.units = [];
    expect(getTool('geothermal').commit(h.c, pointer)).toEqual([{ kind: 'queue_add', item: 'geothermal', x: 8, y: 9 }]);
    h.view.depths[9 * h.world.size + 8] = CELL.unknown;
    expect(getTool('geothermal').commit(h.c, pointer)).toEqual([]);
    h.view.depths[9 * h.world.size + 8] = CELL.rock;
    h.view.pockets = [{ x: 9, y: 10, id: 1 }];
    expect(getTool('geothermal').commit(h.c, pointer)).toEqual([]);
  });

  it('shares the Depths contextual priority between preview and commit', () => {
    const h = harness('depths', [unit('digger'), unit('trooper'), unit('sapper')]);
    const p = { ...pointer, ctrlKey: true, button: 2, shiftKey: true };
    const tool = getTool('default');
    tool.preview!(h.c, p);
    expect(h.overlay.preview?.label).toContain('Breach');
    expect(tool.commit(h.c, p)).toEqual([{ kind: 'breach', units: ['trooper'], x: 8, y: 9, queue: true }]);
    h.view.holes.push({ x: 8, y: 9, kind: 'chasm' } as View['holes'][number]);
    tool.preview!(h.c, p);
    expect(h.overlay.preview?.label).toContain('Backfill this chasm');
    expect(tool.commit(h.c, p)[0]?.kind).toBe('bridge');
    // every hole kind the match allows (rules.depths.backfillKinds), not only chasms
    h.view.holes[0]!.kind = 'sinkhole';
    tool.preview!(h.c, p);
    expect(h.overlay.preview?.label).toContain('Backfill this sinkhole');
    expect(tool.commit(h.c, p)[0]?.kind).toBe('bridge');
    const match = h.view.match!;
    // a match without sinkhole backfill: the sapper's order wins on that hole
    h.view.match = { ...match, rules: { ...match.rules, depths: { ...match.rules.depths, backfillKinds: 0b1110 } } };
    expect(tool.commit(h.c, p)[0]?.kind).toBe('undermine');
    h.view.match = match;
    h.view.holes.length = 0;
    h.c.selection.units = [unit('sapper'), unit('digger')];
    expect(tool.commit(h.c, p)[0]?.kind).toBe('undermine');
    h.c.selection.units = [unit('digger')];
    expect(tool.commit(h.c, p)[0]?.kind).toBe('rail');
    h.view.depths[9 * h.world.size + 8] = CELL.rock;
    expect(tool.commit(h.c, p)).toEqual([]);
    expect(h.host.toast).toHaveBeenCalledWith('No special order here for this selection');
  });

  it('preserves contextual digging and default plain movement with Alt bypass', () => {
    const h = harness('depths', [unit('digger'), unit('trooper')]);
    h.view.depths[9 * h.world.size + 8] = CELL.unknown;
    expect(getTool('default').commit(h.c, { ...pointer, shiftKey: true })).toEqual([
      { kind: 'dig', units: ['digger'], x: 8, y: 9, queue: true },
      { kind: 'move', units: ['trooper'], x: 8.25, y: 9.75, mode: 'move', queue: true },
    ]);
    expect(getTool('default').commit(h.c, { ...pointer, altKey: true })).toEqual([
      { kind: 'move', units: ['digger', 'trooper'], x: 8.25, y: 9.75, mode: 'move' },
    ]);
  });

  it('preserves default click/box selection and right-click Spire rally', () => {
    const h = harness();
    const s = h.session('default');
    s.start(pointer);
    s.end(pointer);
    expect(h.c.select).toHaveBeenCalledWith(pointer.x, pointer.y, false, false);
    s.start(pointer);
    s.move({ ...pointer, x: 20, y: 30 });
    s.end({ ...pointer, x: 20, y: 30, shiftKey: true });
    expect(h.c.box).toHaveBeenCalledWith(8.25, 9.75, 20, 30, true);
    h.c.selection.spire = true;
    s.click({ ...pointer, button: 2 });
    expect(h.host.act).toHaveBeenCalledWith('depths', [{ kind: 'rally', x: 8.25, y: 9.75 }]);
  });

  it('activates only when the inclusive right-drag box reaches two cells, and keeps activation sticky', () => {
    const h = harness();
    const s = h.session('default');
    const p = { ...pointer, x: 8.1, y: 9.1, button: 2 };
    s.move(p);
    s.start(p);
    s.move({ ...p, x: 8.9, y: 9.9, button: -1 });
    expect(s.capturesDrag).toBe(false);
    expect(h.world.designations.showPreview).not.toHaveBeenCalled();
    s.move({ ...p, x: 9, button: -1 });
    expect(s.capturesDrag).toBe(true);
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 8, y0: 9, x1: 9, y1: 9 }, 1, true);
    s.move(p);
    s.end(p);
    expect(h.host.act).toHaveBeenCalledWith('depths', [{ kind: 'designate', rect: { x0: 8, y0: 9, x1: 8, y1: 9 }, priority: 1 }]);
    expect(s.capturesDrag).toBe(false);
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith();
    expect(h.c.select).not.toHaveBeenCalled();
    expect(h.c.box).not.toHaveBeenCalled();
  });

  it('uses release coordinates even without pointermove and applies live urgent/clear modifiers', () => {
    const h = harness('depths', [unit('digger')]);
    const s = h.session('default');
    const p = { ...pointer, button: 2 };
    s.start(p);
    s.move({ ...p, x: 10 });
    s.modifiers({ ...p, shiftKey: true });
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 8, y0: 9, x1: 10, y1: 9 }, 2, true);
    s.modifiers({ ...p, shiftKey: true, altKey: true });
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 8, y0: 9, x1: 10, y1: 9 }, 0, true);
    s.end({ ...p, x: 10, shiftKey: true, altKey: true });
    expect(h.host.act).toHaveBeenLastCalledWith('depths', [{ kind: 'designate', rect: { x0: 8, y0: 9, x1: 10, y1: 9 }, priority: 0 }]);
    s.start(p);
    s.end({ ...p, y: 10, shiftKey: true });
    expect(h.host.act).toHaveBeenLastCalledWith('depths', [{ kind: 'designate', rect: { x0: 8, y0: 9, x1: 8, y1: 10 }, priority: 2 }]);
  });

  it('sends designation before immediate selected digger orders and leaves mixed-selection peers alone', () => {
    const h = harness('depths', [unit('trooper'), unit('digger', 'left', 7.5, 9.5), unit('digger', 'right', 11.5, 9.5), unit('sapper')]);
    h.view.depths[9 * h.world.size + 8] = CELL.unknown;
    h.view.depths[9 * h.world.size + 9] = CELL.bedrock;
    h.view.depths[9 * h.world.size + 10] = CELL.fortified;
    const s = h.session('default');
    const p = { ...pointer, button: 2, shiftKey: true };
    s.start(p);
    s.end({ ...p, x: 10.9 });
    expect(h.host.act).toHaveBeenCalledWith('depths', [
      { kind: 'designate', rect: { x0: 8, y0: 9, x1: 10, y1: 9 }, priority: 2 },
      { kind: 'dig', units: ['left'], x: 8, y: 9 },
      { kind: 'dig', units: ['right'], x: 10, y: 9 },
    ]);
  });

  it('prefers a reachable frontier over a closer wall behind rock, then falls back to tunnelling', () => {
    const h = harness('depths', [unit('digger', 'crew', 4.5, 4.5)]);
    h.view.depths.fill(CELL.bedrock);
    for (let x = 4; x <= 9; x++) h.view.depths[4 * h.world.size + x] = CELL.tunnel;
    h.view.depths[5 * h.world.size + 4] = CELL.rock;
    h.view.depths[6 * h.world.size + 4] = CELL.ore;
    h.view.depths[5 * h.world.size + 9] = CELL.tunnel;
    h.view.depths[6 * h.world.size + 9] = CELL.unknown;
    const s = h.session('default');
    const p = { ...pointer, button: 2, x: 4, y: 6 };
    s.start(p);
    s.end({ ...p, x: 9 });
    expect(h.host.act.mock.calls[0]?.[1][1]).toEqual({ kind: 'dig', units: ['crew'], x: 9, y: 6 });
    h.view.depths[5 * h.world.size + 9] = CELL.bedrock;
    s.start(p);
    s.end({ ...p, x: 9 });
    expect(h.host.act.mock.calls[1]?.[1][1]).toEqual({ kind: 'dig', units: ['crew'], x: 4, y: 6 });
  });

  it('does not explicitly dig known open, bedrock, inaccessible or unknown rim cells', () => {
    const h = harness('depths', [unit('digger', 'crew', 4.5, 4.5)]);
    h.view.depths.fill(CELL.bedrock);
    h.view.depths[4 * h.world.size + 4] = CELL.tunnel;
    h.view.depths[9 * h.world.size + 8] = CELL.unknown;
    h.view.depths[9 * h.world.size + 9] = CELL.tunnel;
    h.view.depths[9 * h.world.size + 10] = CELL.rail;
    const s = h.session('default');
    const p = { ...pointer, button: 2 };
    s.start(p);
    s.end({ ...p, x: 11 });
    expect(h.host.act.mock.calls[0]?.[1]).toHaveLength(1);
    h.view.depths.fill(CELL.tunnel);
    h.view.depths[9 * h.world.size] = CELL.unknown;
    s.start({ ...p, x: 0 });
    s.end({ ...p, x: 1 });
    expect(h.host.act.mock.calls[1]?.[1]).toHaveLength(1);
  });

  it('groups diggers targeting the same frontier and never searches terrain during preview', () => {
    const h = harness('depths', [unit('digger', 'a', 7.5, 9.5), unit('digger', 'b', 7.5, 9.5)]);
    h.view.depths[9 * h.world.size + 8] = CELL.rock;
    const original = h.view.depths;
    const terrainRead = vi.fn();
    h.view.depths = new Proxy(original, { get(target, key, receiver) { terrainRead(key); return Reflect.get(target, key, receiver); } });
    const s = h.session('default');
    const p = { ...pointer, button: 2 };
    s.start(p);
    s.move({ ...p, x: 9 });
    s.preview();
    s.modifiers({ ...p, shiftKey: true });
    expect(terrainRead).not.toHaveBeenCalled();
    s.end({ ...p, x: 9 });
    expect(h.host.act.mock.calls[0]?.[1][1]).toEqual({ kind: 'dig', units: ['a', 'b'], x: 8, y: 9 });
  });

  it.each(['surface', 'sky', 'orbit'] as const)('consumes genuine right-drags on %s without contextual orders or previews', (plane) => {
    const h = harness(plane, [unit('trooper', 'crew', 2, 3, plane)]);
    h.c.selection.spire = true;
    const s = h.session('default');
    const p = { ...pointer, button: 2 };
    s.start(p);
    s.move({ ...p, x: 10 });
    s.end(p);
    expect(h.host.act).not.toHaveBeenCalled();
    expect(h.world.designations.showPreview.mock.calls.every((args) => args.length === 0)).toBe(true);
    s.start(p);
    s.end(p);
    expect(h.host.act).toHaveBeenCalledWith(plane, [{ kind: 'move', units: ['crew'], x: 8.25, y: 9.75, mode: 'move' }]);
  });

  it('keeps same-cell jitter a contextual dig click and lets Alt override Ctrl to pure move', () => {
    const h = harness('depths', [unit('digger'), unit('trooper')]);
    h.view.depths[9 * h.world.size + 8] = CELL.rock;
    const s = h.session('default');
    const p = { ...pointer, button: 2 };
    s.start(p);
    s.move({ ...p, x: 8.9 });
    s.end({ ...p, x: 8.9, shiftKey: true });
    expect(h.host.act).toHaveBeenLastCalledWith('depths', [
      { kind: 'dig', units: ['digger'], x: 8, y: 9, queue: true },
      { kind: 'move', units: ['trooper'], x: 8.9, y: 9.75, mode: 'move', queue: true },
    ]);
    s.start({ ...p, altKey: true, ctrlKey: true });
    s.end({ ...p, altKey: true, ctrlKey: true });
    expect(h.host.act).toHaveBeenLastCalledWith('depths', [{ kind: 'move', units: ['digger', 'trooper'], x: 8.25, y: 9.75, mode: 'move' }]);
  });

  it('rejects oversized right-drag boxes before issuing explicit dig orders and clears the preview', () => {
    const h = harness('depths', [unit('digger')]);
    h.view.match!.rules.depths.designateCells = 2;
    const s = h.session('default');
    const p = { ...pointer, button: 2 };
    s.start(p);
    s.move({ ...p, x: 10 });
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 8, y0: 9, x1: 10, y1: 9 }, 1, false);
    s.end({ ...p, x: 10 });
    expect(h.host.act).not.toHaveBeenCalled();
    expect(h.host.toast).toHaveBeenCalledWith('Dig box exceeds 2 cells; choose a smaller box');
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith();
  });

  it.each(['amove', 'move', 'patrol'] as const)('preserves explicit %s orders and Shift retention', async (kind) => {
    const h = harness('surface', [unit('trooper', 'trooper', 2, 3, 'surface')]);
    const s = h.session(kind);
    s.click({ ...pointer, shiftKey: true });
    expect(h.host.act).toHaveBeenCalledWith('surface', [{ kind: kind === 'patrol' ? 'patrol' : 'move', units: ['trooper'], x: 8.25, y: 9.75, ...(kind === 'patrol' ? {} : { mode: kind === 'amove' ? 'fight' : 'move' }), queue: true }]);
    await Promise.resolve();
    expect(h.c.cancel).not.toHaveBeenCalled();
    s.click(pointer);
    await Promise.resolve();
    expect(h.c.cancel).toHaveBeenCalledOnce();
  });

  it('attack-move attacks eligible units and moves the rest, while plain move ignores the enemy', () => {
    const h = harness('surface', [unit('trooper', 'trooper', 2, 3, 'surface'), unit('digger')]);
    h.world.pickEntity.mockReturnValue({ e: { id: 'enemy', side: 'se', kind: 'trooper', plane: 'surface', x: 10, y: 12 }, rx: 10, ry: 12 } as Track);
    expect(getTool('amove').commit(h.c, pointer)).toEqual([
      { kind: 'attack', units: ['trooper'], target: 'enemy' },
      { kind: 'move', units: ['digger'], x: 10, y: 12, mode: 'move' },
    ]);
    expect(getTool('move').commit(h.c, pointer)[0]).toMatchObject({ kind: 'move', units: ['trooper', 'digger'], x: 8.25, y: 9.75 });
  });

  it('keeps the selected Orbit formation on moves issued for ships unable to attack a visible enemy', () => {
    const h = harness('orbit', [unit('lancer', 'beam', 2, 3, 'orbit'), unit('tug', 'tow', 2, 3, 'orbit'), unit('solar', 'array', 2, 3, 'orbit')]);
    h.c.selection.formation = 'escort';
    const enemy = { e: { ...unit('lancer', 'enemy', 10, 12, 'orbit'), side: 'se' }, rx: 10, ry: 12 } as Track;
    h.view.entities.push(enemy.e);
    h.world.pickEntity.mockReturnValue(enemy);
    for (const tool of ['default', 'amove'] as const) {
      h.session(tool).click({ ...pointer, button: tool === 'default' ? 2 : 0, shiftKey: true });
      expect(h.host.act).toHaveBeenLastCalledWith('orbit', [
        { kind: 'attack', units: ['beam'], target: 'enemy', queue: true },
        { kind: 'move', units: ['tow', 'array'], x: 10, y: 12, mode: 'move', formation: 'escort', escort: 'tow', queue: true },
      ]);
    }
  });

  it('preserves formation separately for fighter and civilian ground movement groups', () => {
    const units = [unit('lancer', 'beam1', 2, 3, 'orbit'), unit('lancer', 'beam2', 2, 3, 'orbit'), unit('solar', 'array', 2, 3, 'orbit'), unit('tug', 'tow', 2, 3, 'orbit')];
    const h = harness('orbit', units);
    h.c.selection.formation = 'escort';
    expect(movementOrders(h.c, { ...pointer, shiftKey: true }, units, 8.25, 9.75, undefined, 'fight')).toEqual([
      { kind: 'move', units: ['beam1', 'beam2'], x: 8.25, y: 9.75, mode: 'fight', formation: 'escort', escort: 'beam1', queue: true },
      { kind: 'move', units: ['array', 'tow'], x: 8.25, y: 9.75, mode: 'move', formation: 'escort', escort: 'array', queue: true },
    ]);
  });

  it('never uses unselected ships or ships omitted by the intent size limit as escort anchors', () => {
    const h = harness('orbit', Array.from({ length: 64 }, (_, i) => unit('lancer', `beam${i}`, 2, 3, 'orbit')));
    h.c.selection.units.push(unit('solar', 'omitted', 2, 3, 'orbit'));
    h.view.entities.push(unit('tug', 'unselected', 2, 3, 'orbit'));
    h.c.selection.formation = 'escort';
    h.session('move').click(pointer);
    expect(h.host.act).toHaveBeenCalledWith('orbit', [{
      kind: 'move', units: Array.from({ length: 64 }, (_, i) => `beam${i}`), x: 8.25, y: 9.75, mode: 'move', formation: 'escort', escort: 'beam0',
    }]);
  });

  it('picks islands for relay queues and contextual island orders (resolved to capture server-side), and asteroids for grapple', () => {
    const h = harness('sky', [unit('interceptor')]);
    const island = { e: { id: 'island', kind: 'island', side: 'neutral', plane: 'sky', x: 8, y: 9 }, rx: 8, ry: 9 } as Track;
    h.view.entities.push(island.e);
    h.world.pickEntity.mockReturnValue(island);
    expect(getTool('relay').commit(h.c, pointer)).toEqual([{ kind: 'queue_add', item: 'relay', island: 'island' }]);
    expect(h.world.pickEntity).toHaveBeenLastCalledWith(pointer.x, pointer.y, 40);
    expect(getTool('default').commit(h.c, pointer)).toEqual([{ kind: 'attack', units: ['interceptor'], target: 'island' }]);
    h.world.pickEntity.mockReturnValue(undefined);
    expect(getTool('relay').commit(h.c, pointer)).toEqual([]);
    expect(h.host.toast).toHaveBeenCalledWith('Pick an island');
    h.world.rig.focus = 'orbit';
    h.c.selection.units = [unit('tug')];
    const rock = { e: { id: 'rock', kind: 'asteroid', side: 'neutral', plane: 'orbit', state: 'drifting', x: 8, y: 9 }, rx: 8, ry: 9 } as Track;
    h.view.entities.push(rock.e);
    h.world.pickEntity.mockReturnValue(rock);
    expect(getTool('default').commit(h.c, { ...pointer, shiftKey: true })).toEqual([{ kind: 'grapple', units: ['tug'], asteroid: 'rock', queue: true }]);
  });

  it('keeps relay footprint ghosts centred on drifting islands and rejects known occupied slots', () => {
    const h = harness('sky');
    const island = { e: { id: 'island', kind: 'island', side: 'nw', plane: 'sky' }, rx: 8.23, ry: 9.67, wy: 12 } as Track;
    h.world.pickEntity.mockReturnValue(island);
    const session = h.session('relay');
    session.preview(pointer);
    expect(h.overlay.preview).toMatchObject({ x: 8.23, y: 9.67, height: 12.15, footprint: { w: 1, h: 1, cells: [{ x: 7.73, y: 9.17, valid: true }] } });
    const retained = h.overlay.preview?.footprint?.cells[0];
    island.rx += 0.25;
    session.frame();
    expect(h.overlay.preview?.x).toBe(8.48);
    expect(h.overlay.preview?.footprint?.cells[0]).toBe(retained);
    h.view.entities.push({ id: 'relay', kind: 'relay', plane: 'sky', link: 'island' } as Entity);
    session.frame();
    expect(h.overlay.preview?.footprint?.cells[0]?.valid).toBe(false);
    h.world.pickEntity.mockReturnValue(undefined);
    session.frame();
    expect(h.overlay.preview).toBeUndefined();
  });

  it.each(['aerie', 'storm_seeder', 'stormcatcher'] as const)('queues %s at the picked island rather than ground coordinates', (structure) => {
    const h = harness('sky', [], { kind: 'build', structure });
    h.world.pickEntity.mockReturnValue({ e: { id: 'island', kind: 'island', side: 'nw', plane: 'sky' }, rx: 8, ry: 9 } as Track);
    expect(getTool('build').commit(h.c, pointer)).toEqual([{ kind: 'queue_add', item: structure, island: 'island' }]);
    getTool('build').preview!(h.c, pointer);
    expect(h.overlay.preview).toMatchObject({ x: 8, y: 9, plane: 'sky', footprint: { w: 1, h: 1, cells: [{ x: 7.5, y: 8.5, valid: true }] } });
    h.world.pickEntity.mockReturnValue(undefined);
    expect(getTool('build').commit(h.c, pointer)).toEqual([]);
  });

  it.each(['nw', 'se', 'neutral'] as const)('moors a visible %s island with one explicitly selected Surface tower', (side) => {
    const tower = { id: 'tower', kind: 'mooring_tower', side: 'nw', plane: 'surface', x: 14, y: 24, state: 'idle' } as Entity;
    const h = harness('surface', [tower]);
    const island = { id: 'island', kind: 'island', side, plane: 'sky', x: 14, y: 24, state: 'drifting' } as Entity;
    h.view.entities.push(tower, island);
    h.view.islands = [{ id: island.id, cx: 24, cy: 24, r: 10, phase: 0, speed: 0.01 }];
    h.view.res.energy = h.view.res.freeEnergy = 1000;
    h.world.pickEntity.mockReturnValue({ e: island, rx: 14, ry: 24, wy: 12 } as Track);
    const tool = getTool('moor');
    expect(tool.planes).toEqual(['surface']);
    expect(tool.commit(h.c, pointer)).toEqual([{ kind: 'moor', tower: tower.id, island: island.id }]);
    island.mooringState = 'raising';
    expect(tool.commit(h.c, pointer)).toEqual([]);
    delete island.mooringState;
    tower.mooringTarget = island.id;
    tower.mooringState = 'waiting';
    expect(tool.readiness!(h.c.selection, h.view).enabled).toBe(false);
    expect(getTool('unmoor').commit(h.c, pointer)).toEqual([{ kind: 'unmoor', tower: tower.id }]);
    delete tower.mooringTarget; delete tower.mooringState;
    tower.mooringGrace = 20;
    expect(tool.readiness!(h.c.selection, h.view).enabled).toBe(false);
    expect(getTool('unmoor').commit(h.c, pointer)).toEqual([{ kind: 'unmoor', tower: tower.id }]);
    h.c.selection.units.push({ ...tower, id: 'tower2' });
    expect(tool.commit(h.c, pointer)).toEqual([]);
    h.c.selection.units = [{ ...tower, side: 'se' }];
    expect(getTool('unmoor').commit(h.c, pointer)).toEqual([]);
  });

  it('applies the match island-building ground immunity to Lens contacts without shielding Gun Platforms', () => {
    const flak = unit('flak', 'flak', 14, 24, 'surface'), h = harness('surface', [flak]);
    const rules = h.view.match!.rules;
    rules.sky.groundHitsIslandStructures = false;
    const target = { ...flak, id: 'extractor', kind: 'ore_extractor', side: 'se', plane: 'sky' } as Entity;
    expect(canFireContact(flak, target, h.view)).toBe(false);
    rules.sky.groundHitsIslandStructures = true;
    expect(canFireContact(flak, target, h.view)).toBe(true);
    rules.sky.groundHitsIslandStructures = false;
    expect(canFireContact(flak, { ...target, kind: 'gun_platform' }, h.view)).toBe(true);
  });

  it('previews an extractor only on an owned disclosed deposit with a free secondary slot', () => {
    const island: Entity = { id: 'e_1', kind: 'island', side: 'nw', plane: 'sky', x: 14, y: 24, hp: 1, maxHp: 1, state: 'drifting', elevation: -8, oreCapacity: 120, oreRemaining: 100 };
    const relay: Entity = { ...island, id: 'relay', kind: 'relay', link: island.id, state: 'idle' };
    const h = harness('sky', [], { kind: 'build', structure: 'ore_extractor' });
    h.view.entities = [island, relay];
    h.view.islands = [{ id: island.id, cx: 24, cy: 24, r: 10, phase: 0, speed: 0.01, oreCapacity: 120 }];
    const track = { e: island, rx: 14, ry: 24, wy: 14.9 } as Track;
    h.world.entities.tracks.set(island.id, track);
    h.world.pickEntity.mockReturnValue({ ...track, e: relay });
    const tool = getTool('build');
    tool.preview!(h.c, pointer);
    expect(h.overlay.preview?.footprint?.cells.every((cell) => cell.valid)).toBe(true);
    expect(h.overlay.preview?.height).toBeCloseTo(track.wy + 0.15);
    expect(tool.commit(h.c, pointer)).toEqual([{ kind: 'queue_add', item: 'ore_extractor', island: island.id }]);
    for (const kind of ['gun_platform', 'island_mortar', 'ore_extractor'] as const) {
      h.view.entities.push({ ...relay, id: 'occupied', kind });
      tool.preview!(h.c, pointer);
      expect(h.overlay.preview?.footprint?.cells.every((cell) => !cell.valid)).toBe(true);
      h.view.entities.pop();
    }
    h.view.queue.push({ id: 'q_1', item: 'island_mortar', island: island.id, plane: 'sky', by: 'sky', byCtl: 'human', alloy: 0, energy: 0, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: false, next: true, status: 'waiting', progress: 0 });
    tool.preview!(h.c, pointer);
    expect(h.overlay.preview?.footprint?.cells.every((cell) => !cell.valid)).toBe(true);
    h.view.queue.length = 0;
    for (const remaining of [undefined, 0]) {
      if (remaining === undefined) delete island.oreRemaining;
      else island.oreRemaining = remaining;
      tool.preview!(h.c, pointer);
      expect(h.overlay.preview?.footprint?.cells.every((cell) => !cell.valid)).toBe(true);
    }
    island.oreRemaining = 20;
    island.oreCapacity = 0;
    tool.preview!(h.c, pointer);
    expect(h.overlay.preview?.footprint?.cells.every((cell) => !cell.valid)).toBe(true);
    island.oreCapacity = 120;
    island.side = 'se';
    tool.preview!(h.c, pointer);
    expect(h.overlay.preview?.footprint?.cells.every((cell) => !cell.valid)).toBe(true);
    island.side = 'nw';
    tool.preview!(h.c, pointer);
    expect(h.overlay.preview?.footprint?.cells.every((cell) => cell.valid)).toBe(true);
  });

  it('builds a mortar in the secondary slot beside a main island structure and aims through the existing Surface Lens', () => {
    const mortar = { id: 'mortar', kind: 'island_mortar', side: 'nw', plane: 'sky', x: 14, y: 24, state: 'idle', elevation: -8 } as Entity;
    const h = harness('sky', [mortar], { kind: 'build', structure: 'island_mortar' });
    const island = { ...mortar, id: 'island', kind: 'island' } as Entity;
    const relay = { ...mortar, id: 'relay', kind: 'relay', link: island.id } as Entity;
    const track = { e: island, rx: 14, ry: 24, wy: 14.9 } as Track;
    h.view.entities.push(island, relay);
    h.world.pickEntity.mockReturnValue(track);
    getTool('build').preview!(h.c, pointer);
    expect(h.overlay.preview?.footprint?.cells.every((cell) => cell.valid)).toBe(true);
    expect(getTool('build').commit(h.c, pointer)).toEqual([{ kind: 'queue_add', item: 'island_mortar', island: island.id }]);
    // No disclosed hardpoint on a hostile island does not make its slot available to us.
    island.side = 'se';
    getTool('build').preview!(h.c, pointer);
    expect(h.overlay.preview?.footprint?.cells.every((cell) => !cell.valid)).toBe(true);
    island.side = 'nw';
    h.world.entities.tracks.set(island.id, track);
    h.world.pickEntity.mockReturnValue({ ...track, e: relay });
    expect(getTool('build').commit(h.c, pointer)).toEqual([{ kind: 'queue_add', item: 'island_mortar', island: island.id }]);
    h.view.entities.push({ ...mortar, link: island.id });
    getTool('build').preview!(h.c, pointer);
    expect(h.overlay.preview?.footprint?.cells.every((cell) => !cell.valid)).toBe(true);
    const enemy = { ...unit('trooper', 'enemy', 16, 24, 'surface'), side: 'se' } as Entity;
    h.view.entities.push(enemy);
    h.world.pickEntity.mockReturnValue({ e: enemy, rx: enemy.x, ry: enemy.y, wy: 0.2 } as Track);
    const tool = getTool('bombard');
    expect(typeof tool.aim === 'function' ? tool.aim(h.c) : tool.aim).toMatchObject({ plane: 'surface' });
    expect(tool.commit(h.c, pointer)).toEqual([{ kind: 'attack', units: [mortar.id], target: enemy.id }]);
    enemy.x = 40;
    expect(tool.commit(h.c, pointer)).toEqual([]);
    expect(getTool('stop').commit(h.c, pointer)).toEqual([{ kind: 'stop', units: [mortar.id] }]);
  });

  it('emplaces the selected Gunship nearest an own island with a free hardpoint, hidden when the rules switch it off', () => {
    const gun = unit('gunship', 'gun', 8, 9.5, 'sky'), far = unit('gunship', 'far', 30, 30, 'sky');
    const h = harness('sky', [far, gun]);
    const tool = getTool('emplace');
    const sky = h.view.match!.rules.sky;
    const isle = h.view.islands[0]!;
    const island = { id: isle.id, kind: 'island', side: 'nw', plane: 'sky', x: 8, y: 9, state: 'drifting' } as Entity;
    h.view.entities.push(island, gun, far);
    const own = { e: island, rx: 8, ry: 9, wy: 12 } as Track;
    h.world.pickEntity.mockReturnValue(own);
    const selection = { units: [far, gun], spire: false };
    expect(tool.planes).toEqual(['sky']);
    expect(tool.card!(selection, h.view)).toBe(true);
    expect(tool.card!({ ...selection, units: [unit('interceptor', 'i', 8, 9, 'sky')] }, h.view)).toBe(false);
    expect(tool.readiness!(selection, h.view)).toMatchObject({ enabled: true, status: 'Ready' });
    expect(tool.commit(h.c, pointer)).toEqual([{ kind: 'emplace', unit: 'gun', island: isle.id }]);
    tool.preview!(h.c, pointer);
    expect(h.overlay.preview).toMatchObject({ x: 8, y: 9, plane: 'sky', radius: sky.captureRadius, label: 'Emplace Gun Platform' });
    // too far from the island
    gun.x = 8 + sky.captureRadius + 0.5;
    expect(tool.commit(h.c, pointer)).toEqual([]);
    expect(h.host.toast).toHaveBeenLastCalledWith(`Move a Gunship within ${sky.captureRadius} tiles first`);
    expect(tool.readiness!(selection, h.view)).toMatchObject({ enabled: false });
    gun.x = 8;
    // the public hardpoint is taken, or the island is not ours
    isle.hardpoint = { kind: 'gun_platform', side: 'se' };
    expect(tool.commit(h.c, pointer)).toEqual([]);
    expect(h.host.toast).toHaveBeenLastCalledWith('Its hardpoint is taken');
    delete isle.hardpoint;
    island.side = 'se';
    expect(tool.commit(h.c, pointer)).toEqual([]);
    expect(h.host.toast).toHaveBeenLastCalledWith('Pick an island you hold');
    island.side = 'nw';
    for (const off of [{ gunshipEmplaceEnabled: false }, { islandHardpoints: 0 }]) {
      Object.assign(sky, off);
      expect(tool.card!(selection, h.view)).toBe(false);
      expect(tool.applies(selection, h.view)).toBe(false);
      Object.assign(sky, { gunshipEmplaceEnabled: true, islandHardpoints: 1 });
    }
  });

  it('hangars aircraft at an own Aerie and preserves Alt movement and enemy attacks', () => {
    const h = harness('sky', [unit('interceptor', 'air', 8, 9, 'sky')]);
    const target = { e: { id: 'aerie', kind: 'aerie', side: 'nw', plane: 'sky', x: 8, y: 9 }, rx: 8, ry: 9 } as Track;
    h.view.entities.push(target.e);
    h.world.pickEntity.mockReturnValue(target);
    expect(getTool('default').commit(h.c, pointer)).toEqual([{ kind: 'hangar', units: ['air'], target: 'aerie' }]);
    expect(getTool('default').commit(h.c, { ...pointer, altKey: true })[0]?.kind).toBe('move');
    target.e.side = 'se';
    expect(getTool('default').commit(h.c, pointer)[0]?.kind).toBe('attack');
  });

  it('separates Orbit projection from Surface deorbit targeting, and scans from every plane', () => {
    const h = harness('orbit', [unit('tug')]);
    expect(resolvePointer(h.c, pointer, { target: 'surface' })).toMatchObject({ projection: 'orbit', plane: 'surface', tile: { x: 8.25, y: 9.75 } });
    expect(getTool('deorbit').commit(h.c, pointer)).toEqual([{ kind: 'deorbit', units: ['tug'], x: 8.25, y: 9.75 }]);
    getTool('deorbit').preview!(h.c, pointer);
    expect(h.world.pickTile).toHaveBeenLastCalledWith(pointer.x, pointer.y, 'orbit');
    expect(h.overlay.preview?.plane).toBe('surface');
    for (const plane of PLANES) {
      h.world.rig.focus = plane;
      expect(getTool('scan').commit(h.c, pointer)).toEqual([{ kind: 'scan', x: 8.25, y: 9.75 }]);
      expect(getTool('scan').role?.(h.c)).toBe('orbit');
    }
  });

  it('preserves structure queueing and commander focus callbacks without synthetic intents', () => {
    const h = harness('surface', [], { kind: 'build', structure: 'turret' });
    expect(getTool('build').commit(h.c, pointer)).toEqual([{ kind: 'queue_add', item: 'turret', x: 8, y: 9 }]);
    getTool('build').preview!(h.c, pointer);
    expect(h.overlay.preview).toMatchObject({ x: 8.5, y: 9.5, footprint: { x: 8, y: 9, w: 1, h: 1 } });
    h.c.mode = { kind: 'build', structure: 'shaft' };
    expect(getTool('build').commit(h.c, pointer)).toEqual([{ kind: 'queue_add', item: 'shaft', x: 8, y: 9 }]);
    getTool('build').preview!(h.c, pointer);
    expect(h.overlay.preview).toMatchObject({ x: 9, y: 10, footprint: { x: 8, y: 9, w: 2, h: 2 } });
    h.view.lodes = [{ x: 9, y: 10, rich: false, loads: 80, open: false }];
    h.c.mode = { kind: 'build', structure: 'headframe' };
    expect(getTool('build').commit(h.c, pointer)).toEqual([{ kind: 'queue_add', item: 'headframe', x: 8, y: 9 }]);
    getTool('build').preview!(h.c, pointer);
    expect(h.overlay.preview).toMatchObject({ x: 9.5, y: 10.5, footprint: { x: 8, y: 9, w: 3, h: 3 } });
    h.c.mode = { kind: 'pick', role: 'orbit' };
    expect(getTool('pick').commit(h.c, pointer)).toEqual([]);
    expect(h.host.pickDirective).toHaveBeenCalledWith('orbit', 8.25, 9.75);
    expect(h.c.cancel).toHaveBeenCalledOnce();
    expect(h.host.act).not.toHaveBeenCalled();
  });

  it('keeps failed orders armed and never dispatches tools on an ineligible plane', async () => {
    const h = harness('depths', [unit('digger')]);
    h.host.act.mockResolvedValue(false);
    const s = h.session('rail');
    s.click(pointer);
    await Promise.resolve();
    expect(h.c.cancel).not.toHaveBeenCalled();
    h.host.act.mockClear();
    h.world.rig.focus = 'surface';
    s.click(pointer);
    expect(h.host.act).not.toHaveBeenCalled();
  });

  it('migrates immediate stop, hold, mine and transfer without arming a pointer mode', () => {
    const h = harness('depths', [unit('digger'), unit('trooper')]);
    for (const id of ['stop', 'hold', 'mine', 'transfer'] as const) expect(getTool(id).immediate).toBe(true);
    expect(getTool('stop').commit(h.c, pointer)).toEqual([{ kind: 'stop', units: ['digger', 'trooper'] }]);
    expect(getTool('hold').commit(h.c, pointer)).toEqual([{ kind: 'stance', stance: 'hold', units: ['digger', 'trooper'] }]);
    expect(getTool('mine').commit(h.c, { ...pointer, shiftKey: true })).toEqual([{ kind: 'mine', units: ['digger'], queue: true }]);
    expect(getTool('transfer').commit(h.c, { ...pointer, shiftKey: true })).toEqual([{ kind: 'transfer', units: ['trooper'], to: 'surface', queue: true }]);
    h.world.rig.focus = 'surface';
    expect(getTool('transfer').commit(h.c, pointer)[0]?.to).toBe('depths');
  });
});

describe('right-drag known terrain boundaries', () => {
  it('does not route through a discovered lode pocket, but can explicitly target its ore', () => {
    const h = harness('depths', [unit('digger', 'crew', 4.5, 4.5)]);
    h.view.depths.fill(CELL.bedrock);
    h.view.depths[4 * h.world.size + 4] = CELL.tunnel;
    h.view.depths[4 * h.world.size + 5] = CELL.ore;
    h.view.depths[4 * h.world.size + 6] = CELL.rock;
    h.view.lodes = [{ x: 5, y: 5, rich: false, loads: 100, open: true }];
    const s = h.session('default');
    const p = { ...pointer, button: 2, x: 6, y: 4 };
    s.start(p);
    s.end({ ...p, y: 5 });
    expect(h.host.act.mock.calls[0]?.[1]).toHaveLength(1);
    s.start({ ...p, x: 5 });
    s.end({ ...p, x: 5, y: 5 });
    expect(h.host.act.mock.calls[1]?.[1][1]).toEqual({ kind: 'dig', units: ['crew'], x: 5, y: 4 });
  });

  it('avoids enemy bulkheads when choosing a walking frontier', () => {
    const h = harness('depths', [unit('digger', 'crew', 4.5, 4.5)]);
    h.view.depths.fill(CELL.bedrock);
    for (let x = 4; x <= 9; x++) h.view.depths[4 * h.world.size + x] = CELL.tunnel;
    h.view.depths[5 * h.world.size + 4] = CELL.tunnel;
    h.view.depths[6 * h.world.size + 4] = CELL.rock;
    h.view.depths[5 * h.world.size + 9] = CELL.tunnel;
    h.view.depths[6 * h.world.size + 9] = CELL.rock;
    h.view.entities = [{ id: 'gate', kind: 'bulkhead', side: 'se', plane: 'depths', x: 4.5, y: 5.5 } as Entity];
    const s = h.session('default');
    const p = { ...pointer, button: 2, x: 4, y: 6 };
    s.start(p);
    s.end({ ...p, x: 9 });
    expect(h.host.act.mock.calls[0]?.[1][1]).toEqual({ kind: 'dig', units: ['crew'], x: 9, y: 6 });
  });

  it('cancels a committed gesture whose release misses the ground instead of issuing a context order', () => {
    const h = harness('depths', [unit('digger')]);
    const s = h.session('default');
    const p = { ...pointer, button: 2 };
    s.start(p);
    s.move({ ...p, x: 10 });
    h.world.groundPoint.mockReturnValue({ x: NaN, y: NaN });
    s.end({ ...p, x: 10 });
    expect(h.host.act).not.toHaveBeenCalled();
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith();
  });
});

describe('cross-plane contacts and explicit ability scopes', () => {
  it.each(Object.keys(STATS) as (keyof typeof STATS)[])('only activates contacts for %s when its current weapon reaches another plane', (kind) => {
    const e = { ...unit('tank'), kind, plane: STATS[kind].plane } as Entity;
    const contacts = createContacts();
    configureContacts(contacts, { units: [e], spire: false }, e.plane);
    const planes = PLANES.filter((plane) => plane !== e.plane && canTarget(e, plane));
    expect(contacts.active).toBe(planes.length > 0);
    expect([...contacts.planes]).toEqual(planes);
    for (const plane of PLANES) expect(canTarget(e, plane)).toBe(!!STATS[kind].dmg && canHitPlane(kind, e.plane, plane));
  });

  it('does not confuse researched Ascent or transfer with weapon reach; explicit deorbit still aims below', () => {
    const h = harness('sky', [unit('interceptor', 'i', 8, 9, 'sky')]);
    h.view.research.completed = ['ascent_thrusters'];
    const contacts = createContacts();
    configureContacts(contacts, h.c.selection, 'sky');
    expect(contacts.active).toBe(false);
    const ascended = { ...h.c.selection.units[0]!, plane: 'orbit', transit: { to: 'orbit', at: 0, until: 500, return: 'sky' } } as Entity;
    expect(canTarget(ascended, 'orbit')).toBe(true);
    expect(canTarget(ascended, 'sky')).toBe(false);
    configureContacts(contacts, { units: [ascended], spire: false }, 'orbit');
    expect(contacts.active).toBe(false);
    for (const plane of ['surface', 'depths'] as const) {
      configureContacts(contacts, { units: [unit('trooper', 't', 8, 9, plane)], spire: false }, plane);
      expect(contacts.active).toBe(false);
    }
    const lens = createLens(48);
    const aim = getTool('deorbit').aim;
    configureLens(lens, { units: [], spire: false }, 'orbit', typeof aim === 'function' ? aim(h.c) : aim);
    expect(lens).toMatchObject({ active: true, target: 'surface', down: true });
  });

  it('aims an Orbit drop through a Surface scope on the cursor, framing the blast and forecasting the landing', async () => {
    const tug = { ...unit('tug', 'tug', 6, 9.75, 'orbit'), state: 'towing', link: 'rock' } as Entity;
    const rock = { id: 'rock', kind: 'asteroid', side: 'neutral', plane: 'orbit', x: 6, y: 9.75, state: 'towed', rockSize: 'large', volatile: true } as Entity;
    const h = harness('orbit', [tug]);
    h.view.entities.push(tug, rock);
    const rules = h.view.match!.rules.orbit;
    const session = h.session('deorbit');
    session.move(pointer);
    const lens = session.state.lens!;
    // Centred on the map point under the cursor (not the tug), reach 2.5 × the large rock's public blast.
    expect(lens).toMatchObject({ active: true, source: 'orbit', target: 'surface', down: true, x: pointer.x, y: pointer.y, radius: rules.largeImpactRadius * 2.5 });
    expect(lens.drop).toMatchObject({ active: true, x: pointer.x, y: pointer.y, radius: rules.largeImpactRadius, rock: 'large', count: 1, outOfReach: 0 });
    expect([...lens.drop.from.subarray(0, 2)]).toEqual([6, 9.75]);
    expect(h.world.lens.show).toHaveBeenLastCalledWith(lens);
    expect(h.overlay.preview).toBeUndefined();
    // Live: the tug drags the release point while the pointer rests.
    tug.x = rock.x = 5;
    session.frame();
    expect(lens.drop.active).toBe(true);
    expect(lens.drop.from[0]).toBe(5);
    session.click(pointer);
    expect(h.host.act).toHaveBeenLastCalledWith('orbit', [{ kind: 'deorbit', units: ['tug'], x: pointer.x, y: pointer.y }]);
    await Promise.resolve();
    // Alt bypasses the scope: the plain ring on the main view at the public radius.
    session.move({ ...pointer, altKey: true });
    expect(lens.active).toBe(false);
    expect(h.overlay.preview).toMatchObject({ plane: 'surface', radius: rules.largeImpactRadius, label: 'Impact zone' });
    session.leave();
    expect(lens.active).toBe(false);
  });

  it('opens no drop scope for a read-only spectator', () => {
    const tug = { ...unit('tug', 'tug', 6, 9.75, 'orbit'), state: 'towing', link: 'rock' } as Entity;
    const h = harness('orbit', [tug]);
    h.view.entities.push(tug, { id: 'rock', kind: 'asteroid', side: 'neutral', plane: 'orbit', x: 6, y: 9.75, state: 'towed', rockSize: 'medium' } as Entity);
    (h.host as ControlHost).readOnly = true;
    const session = h.session('deorbit');
    session.move(pointer);
    session.frame();
    expect(session.state.lens?.active).toBe(false);
    expect(session.state.lens?.drop.active).toBe(false);
    expect(h.world.lens.show).not.toHaveBeenCalledWith(session.state.lens);
  });

  it('never opens contacts or a scope from hover or contextual right-click over a known cross-plane enemy', () => {
    const h = harness('sky', [unit('bomber', 'b', 8, 9, 'sky')]);
    h.view.entities.push({ ...unit('tank', 'enemy', 8.25, 9.75, 'surface'), side: 'se' });
    const session = h.session('default');
    session.move(pointer);
    session.frame();
    expect(session.state.lens?.active).toBe(false);
    expect(h.overlay.contacts).toBeUndefined();
    session.click({ ...pointer, button: 2 });
    expect(session.state.lens?.active).toBe(false);
    expect(h.overlay.contacts).toBeUndefined();
    expect(h.host.act).toHaveBeenLastCalledWith('sky', [{ kind: 'move', units: ['b'], x: 8.25, y: 9.75, mode: 'move' }]);
  });

  it('explicit Cross-plane attack sends only capable units, queues with Shift, and rejects fogged entities', async () => {
    const h = harness('sky', [unit('bomber', 'b', 8, 9, 'sky'), unit('interceptor', 'i', 8, 9, 'sky')]);
    const target = { e: { ...unit('tank', 'enemy', 8.25, 9.75, 'surface'), side: 'se' }, rx: 8.25, ry: 9.75, wy: 0 } as Track;
    h.view.entities.push(target.e);
    h.world.entities.tracks.set('enemy', target);
    const session = h.session('lensAttack');
    session.move(pointer);
    expect(session.state.contacts).toMatchObject({ active: true, hovered: 'enemy' });
    expect(h.overlay.contacts).toBe(session.state.contacts);
    // The targeted plane as a view-only hologram, with the bomb's splash, friendly fire and the flak under the run.
    expect(session.state.lens).toMatchObject({ active: true, source: 'sky', target: 'surface', stack: ['surface'] });
    expect(session.state.lensViewOnly).toBe(true);
    expect(session.state.lens!.drop).toMatchObject({ active: true, kind: 'strike', bomb: true, count: 1, x: 8.25, y: 9.75, radius: STATS.bomber.splash, friendly: [], screens: 0 });
    h.view.entities.push({ ...unit('trooper', 'mine', 8.75, 9.75, 'surface') }, { ...unit('flak', 'flak', 12, 12, 'surface'), side: 'se' });
    session.move(pointer);
    expect(session.state.lens!.drop).toMatchObject({ friendly: ['mine'], threats: ['flak'], screens: 1 });
    h.view.entities.splice(-2);
    session.click({ ...pointer, shiftKey: true });
    expect(h.host.act).toHaveBeenCalledWith('sky', [{ kind: 'attack', units: ['b'], target: 'enemy', queue: true }]);
    await Promise.resolve();
    expect(h.c.cancel).not.toHaveBeenCalled();
    session.click({ ...pointer, button: 2 });
    expect(h.host.act).toHaveBeenCalledTimes(1);
    h.view.entities.length = 0;
    expect(pickContact(session.state.contacts!, h.view, h.c.world, pointer.x, pointer.y)).toBeUndefined();
    h.view.entities.push(target.e);
    session.click(pointer);
    await Promise.resolve();
    expect(h.c.cancel).toHaveBeenCalledOnce();
    session.leave();
    expect(session.state.contacts?.active).toBe(false);
    expect(h.overlay.contacts).toBeUndefined();
  });

  it('rejects out-of-reach contacts and empty ground without a scope-disc boundary', () => {
    const h = harness('sky', [unit('bomber', 'b', 8, 9, 'sky')]);
    const far = { e: { ...unit('tank', 'far', 50, 50, 'surface'), side: 'se' }, rx: 50, ry: 50, wy: 0 } as Track;
    h.view.entities.push(far.e);
    h.world.entities.tracks.set('far', far);
    const session = h.session('lensAttack');
    session.move({ ...pointer, x: 50, y: 50 });
    expect(session.state.contacts?.hovered).toBe('far');
    session.click({ ...pointer, x: 50, y: 50 });
    session.click({ ...pointer, x: 100, y: 100, shiftKey: true });
    expect(h.host.act).not.toHaveBeenCalled();
  });

  it.each([
    ['depths', false, 'surface'], ['surface', false, 'sky'], ['sky', false, 'surface'], ['orbit', false, 'surface'],
    ['surface', true, 'depths'], ['sky', true, 'orbit'],
  ] as const)('held peek works without units from %s (reverse %s) to %s and leaves orders on the source', (source, reverse, target) => {
    const h = harness(source);
    const session = h.session('default');
    session.move(pointer);
    session.peek(true, reverse);
    expect(session.state.lens).toMatchObject({ active: true, source, target });
    expect(session.state.lensViewOnly).toBe(true);
    h.c.state = session.state;
    expect(resolvePointer(h.c, pointer).plane).toBe(source);
    session.peek(false);
    expect(session.state.lens?.active).toBe(false);
  });

  it.each(Object.keys(STATS) as (keyof typeof STATS)[])('shows Cross-plane attack for %s exactly when a weapon can hit another plane', (kind) => {
    const e = { ...unit('tank'), kind, plane: STATS[kind].plane } as Entity;
    const h = harness(e.plane, [e]);
    const capable = PLANES.some((plane) => plane !== e.plane && canTarget(e, plane));
    expect(eligible(getTool('lensAttack'), e.plane, h.c.selection, h.view)).toBe(capable);
    expect(getTool('lensAttack').card?.(h.c.selection, h.view)).toBe(capable);
  });
});

describe('solar berth preview', () => {
  it('shows the berth outline, an output-tinted dot and a compact chip naming only the penalties that apply', () => {
    const array = unit('solar', 'moving', 6, 6, 'orbit');
    const h = harness('orbit', [array]);
    const home = h.view.match!.armies.find((a) => a.id === 'nw')!.spireAt;
    h.view.entities.push({ id: 'seg', kind: 'spire', side: 'nw', plane: 'orbit', x: home.x, y: home.y, state: 'idle' } as Entity, array);
    const rules = h.view.match!.rules;
    const at = { ...pointer, x: home.x + 4, y: home.y + 4 };
    const preview = () => { getTool('move').preview!(h.c, at); return h.overlay.preview!; };
    const brightness = (rgb: string) => rgb.match(/\d+/g)!.reduce((s, v) => s + Number(v), 0);
    const full = preview();
    expect(full).toMatchObject({ x: at.x, y: at.y, plane: 'orbit', berth: 2 * STATS.solar.radius, color: 'rgb(255,210,31)', label: `${rules.economy.solarRate.toFixed(1)}/s` });
    // Another own array beside the berth shades it (the moving one never counts): only the shade share is named.
    h.view.entities.push(unit('solar', 'other', at.x + 1, at.y, 'orbit'));
    const shaded = preview();
    expect(shaded.label).toBe(`${(rules.economy.solarRate * (1 - rules.orbit.solarShadePer)).toFixed(1)}/s · shade −${Math.round(rules.orbit.solarShadePer * 100)}%`);
    expect(brightness(shaded.color)).toBeLessThan(brightness(full.color));
    // Past the full range: the distance share is named too, and the dot dims further.
    at.x = at.y = home.x + rules.orbit.solarFarRange + 6;
    h.view.entities.pop();
    const far = preview();
    expect(far.label).toBe(`${(rules.economy.solarRate * rules.orbit.solarFarFactor).toFixed(1)}/s · distance −${Math.round((1 - rules.orbit.solarFarFactor) * 100)}%`);
    expect(brightness(far.color)).toBeLessThan(brightness(shaded.color));
  });
});
