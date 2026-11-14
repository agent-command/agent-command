import { describe, expect, it } from 'vitest';
import { InstancedBufferGeometry, InstancedMesh, Mesh, type InterleavedBufferAttribute } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { DEFAULT_RULES, DEPLOY_SPECS, KINDS, STATS, isStatKind, type Entity, type Kind } from '@agent-command/game/contract';
import { diggerCarryMax } from '@agent-command/game/economy';
import { Entities } from '../src/world/entities.ts';
import { applyFade } from '../src/world/fade.ts';
import { BASTION_PART, BASTION_PD, BREACHER, HARDPOINT_PAD, SOLAR, SOLAR_FILL, SOLAR_PART, WARDEN, depthsDropoffModel, footprintModelScale, model, packSolar, PART, RIG, STATE_VISUALS, stateVisualChannel } from '../src/world/models.ts';
import { REC, REC_ATTRS, STRIDE } from '../src/world/rig.ts';

const digger: Entity = { id: 'e_100', kind: 'digger', side: 'nw', plane: 'depths', x: 12, y: 12, hp: 80, maxHp: 80, state: 'idle' };

describe('declarative model state', () => {
  it('normalizes alloy carry using the same rules formula as the simulation', () => {
    expect(diggerCarryMax(DEFAULT_RULES)).toBe(DEFAULT_RULES.economy.diggerLoads * DEFAULT_RULES.economy.oreLoad);
    const rules = { ...DEFAULT_RULES, economy: { ...DEFAULT_RULES.economy, oreLoad: 25 } };
    const max = diggerCarryMax(rules);
    expect(max).toBe(100);
    for (const [carry, fill] of [[0, 0], [50, 0.5], [100, 1], [200, 1], [-5, 0]]) {
      expect(stateVisualChannel({ ...digger, carry }, 'fill', max)).toBe(fill);
    }
    expect(stateVisualChannel(digger, 'fill', max)).toBe(0);
    expect(stateVisualChannel(digger, 'fill', 0)).toBe(0);
  });

  it('maps observed work and link state without inventing unseen cargo', () => {
    expect(stateVisualChannel({ ...digger, state: 'mining' }, 'work', 40)).toBe(1);
    expect(stateVisualChannel({ ...digger, state: 'hauling' }, 'work', 40)).toBe(0);
    expect(stateVisualChannel({ ...digger, kind: 'headframe', state: 'active' }, 'work', 40)).toBe(0);
    expect(stateVisualChannel({ ...digger, kind: 'headframe', state: 'active' }, 'work', 40, 0.75)).toBe(0.75);
    expect(stateVisualChannel({ ...digger, kind: 'headframe', state: 'constructing' }, 'work', 40)).toBe(0);
    expect(stateVisualChannel({ ...digger, kind: 'tug', link: 'e_101' }, 'fill', 40)).toBe(1);
    expect(stateVisualChannel({ ...digger, kind: 'tug' }, 'fill', 40)).toBe(0);
  });

  it('fits the extractor to the secondary pad and drives its auger and dust only from paid mining state', () => {
    const extractor: Entity = { ...digger, kind: 'ore_extractor', plane: 'sky' };
    expect(stateVisualChannel({ ...extractor, state: 'mining' }, 'work', 0)).toBe(1);
    for (const state of ['idle', 'constructing'] as const) expect(stateVisualChannel({ ...extractor, state }, 'work', 0)).toBe(0);
    expect(RIG.ore_extractor.rotor?.idle).toBe(0);
    expect(RIG.ore_extractor.rotor?.work).toBeGreaterThan(0);
    const geometry = model('ore_extractor'), p = geometry.getAttribute('position'), scale = footprintModelScale('ore_extractor', geometry);
    const parts = new Set(geometry.getAttribute('part').array);
    for (const part of [PART.rotor, PART.flame, PART.dust]) expect(parts.has(part)).toBe(true);
    expect(STATE_VISUALS.ore_extractor?.parts?.some((part) => part.part === PART.dust && part.channel === 'work' && part.visible && part.drift)).toBe(true);
    for (let i = 0; i < p.count; i++) expect(Math.hypot(p.getX(i), p.getZ(i)) * scale).toBeLessThanOrEqual(HARDPOINT_PAD.fit + 1e-6);
  });

  it('swings the Warden riot shield into its wall with the deploy progress, not at once, and back while packing', () => {
    // Regression: a `state` source made the channel 0 or 1, so the shield snapped into the wall.
    const warden: Entity = { ...digger, kind: 'warden', hp: 160, maxHp: 160 };
    expect(STATE_VISUALS.warden?.channels.work).toEqual({ source: 'deploy' });
    const [walling, walled, unwalling] = DEPLOY_SPECS.walled.states;
    for (const progress of [0.1, 0.5, 0.9]) {
      const raising = stateVisualChannel({ ...warden, state: walling, progress }, 'work', 40);
      expect(raising).toBeCloseTo(progress, 9);
      expect(raising).toBeGreaterThan(0);
      expect(raising).toBeLessThan(1);
      expect(stateVisualChannel({ ...warden, state: unwalling, progress }, 'work', 40)).toBeCloseTo(1 - progress, 9);
    }
    expect(stateVisualChannel({ ...warden, state: walled }, 'work', 40)).toBe(1);
    for (const state of ['idle', 'moving', 'attacking'] as const) expect(stateVisualChannel({ ...warden, state }, 'work', 40)).toBe(0);
    const tags = new Set(model('warden').getAttribute('part').array);
    for (const part of [PART.panel, PART.barrel, PART.left, PART.right]) expect(tags.has(part)).toBe(true);
    // In order: the shield turns square from its carry angle, slides across, plants, then widens; the body dips as
    // it lands, and every step completes by the end of the deploy.
    const parts = STATE_VISUALS.warden!.parts!;
    const shield = parts.filter((p) => p.part === PART.panel);
    expect(shield[0]!.turn).toMatchObject({ axis: 'y', angle: -WARDEN.shield.carry });
    const moved = shield.reduce((sum, p) => sum.map((v, i) => v + (p.translate?.[i] ?? 0)), [0, 0, 0]);
    expect(moved[1]).toBeCloseTo(-WARDEN.shield.y, 9);
    expect(WARDEN.shield.z + moved[2]!).toBeCloseTo(0, 9);
    expect(shield.at(-1)!.stretch![2]).toBeGreaterThan(1.4);
    expect(parts.some((p) => p.part === PART.body && p.bump && (p.translate?.[1] ?? 0) < 0)).toBe(true);
    for (const p of parts) expect((p.ease ?? p.bump ?? [0, 1])[1]).toBeLessThanOrEqual(1);
    expect(RIG.warden.panel).toBeUndefined();
  });

  it('walks the Warden on long boots that step out past its torso, swung from the true hip', () => {
    // Regression: stubby legs under a low, broad torso and a shield to the ground hid the walk from the game camera.
    const geo = model('warden'), p = geo.getAttribute('position'), part = geo.getAttribute('part');
    let torsoFront = -Infinity, torsoBottom = Infinity, toe = -Infinity, shieldBottom = Infinity;
    for (let i = 0; i < p.count; i++) {
      const kind = part.getX(i);
      if (kind === PART.left) {
        // the forward-swung foot: the gait's ±0.55 rad about the hip
        const x = p.getX(i), y = p.getY(i) - RIG.warden.gait!.hip!;
        toe = Math.max(toe, x * Math.cos(0.55) - y * Math.sin(0.55));
      } else if (kind === PART.body) {
        torsoFront = Math.max(torsoFront, p.getY(i) < 0.3 ? p.getX(i) : -Infinity);
        torsoBottom = Math.min(torsoBottom, p.getY(i));
      } else if (kind === PART.panel) shieldBottom = Math.min(shieldBottom, p.getY(i));
    }
    expect(RIG.warden.gait).toMatchObject({ kind: 'legs', hip: WARDEN.hip });
    expect(torsoBottom).toBeGreaterThanOrEqual(0.18);
    expect(torsoBottom).toBeLessThan(WARDEN.hip);
    expect(toe - torsoFront).toBeGreaterThan(0.08);
    // carried clear of the boots, so the legs show under it too
    expect(shieldBottom).toBeGreaterThanOrEqual(0.15);
  });

  it('grows the deploy kit with transition progress: foxhole sandbags, siege legs and raised barrel, emplacement berm', () => {
    const cases = [['trooper', 'digging_in', 'dug_in', 'digging_out'], ['tank', 'sieging', 'sieged', 'unsieging'], ['flak', 'emplacing', 'emplaced', 'unemplacing']] as const;
    for (const [kind, deploying, deployed, packing] of cases) {
      const e: Entity = { ...digger, kind, plane: 'surface', hp: 100, maxHp: 100 };
      expect(stateVisualChannel({ ...e, state: deploying, progress: 0.25 }, 'work', 40), kind).toBe(0.25);
      expect(stateVisualChannel({ ...e, state: deployed }, 'work', 40), kind).toBe(1);
      expect(stateVisualChannel({ ...e, state: packing, progress: 0.25 }, 'work', 40), kind).toBe(0.75);
      for (const state of ['idle', 'moving', 'attacking'] as const) expect(stateVisualChannel({ ...e, state }, 'work', 40), kind).toBe(0);
      expect(new Set(model(kind).getAttribute('part').array).has(PART.stance), kind).toBe(true);
      expect(STATE_VISUALS[kind]?.parts?.some((p) => p.part === PART.stance && p.channel === 'work' && p.visible), kind).toBe(true);
    }
    expect(STATE_VISUALS.tank?.parts?.some((p) => p.part === PART.barrel && p.channel === 'work' && (p.translate?.[1] ?? 0) > 0)).toBe(true);
    expect(RIG.trooper.squat).toBeGreaterThan(0);
  });

  it('binds table behaviours to existing tagged parts and stays within the kit budget', () => {
    for (const [kind, visual] of Object.entries(STATE_VISUALS)) {
      const tags = new Set(model(kind as Kind).getAttribute('part').array);
      if (kind === 'headframe' || kind === 'shaft') for (const tag of depthsDropoffModel(kind).getAttribute('part').array) tags.add(tag);
      for (const part of visual.parts ?? []) {
        expect(tags.has(part.part)).toBe(true);
        expect(visual.channels[part.channel]).toBeDefined();
      }
    }
    expect(model('digger').getAttribute('position').count / 3).toBeLessThanOrEqual(160);
    expect(REC.fill).toBe(19);
    expect(STRIDE).toBe(20);
    expect(REC_ATTRS.length * 4).toBe(STRIDE);
  });

  it('reserves the existing fill channel and fixed local pivots for independent turret yaw', () => {
    for (const kind of KINDS) {
      if (!isStatKind(kind) || STATS[kind].mount?.kind !== 'turret') continue;
      const rig = RIG[kind];
      const visual = STATE_VISUALS[kind];
      const tags = new Set(model(kind).getAttribute('part').array);
      if (kind === 'bastion') {
        expect(rig.top).toBeUndefined();
        expect(BASTION_PD.z).toBeGreaterThan(0);
        expect(tags.has(BASTION_PART.top)).toBe(true);
        expect(tags.has(BASTION_PART.barrel)).toBe(true);
        expect(tags.has(BASTION_PART.emitter)).toBe(true);
      } else expect(rig.top).toBeDefined();
      expect(tags.has(PART.top)).toBe(true);
      expect(tags.has(PART.barrel), `${kind}: the drawn barrel must follow its recoil and turret mount`).toBe(true);
      expect(tags.has(PART.body)).toBe(true);
      expect(visual?.channels.fill).toBeUndefined();
      expect(visual?.parts?.some(part => part.channel === 'fill') ?? false).toBe(false);
      expect(rig.rotor?.cycle).not.toBe('fill');
    }
  });

  it('builds the star-atlas dart and shoulder-gun escort from the rigged kit within their budgets', () => {
    const skiff = model('skiff'), bastion = model('bastion');
    skiff.computeBoundingBox();
    bastion.computeBoundingBox();
    expect(bastion.boundingBox!.max.z - bastion.boundingBox!.min.z)
      .toBeGreaterThan((skiff.boundingBox!.max.z - skiff.boundingBox!.min.z) * 1.5);
    expect(skiff.getAttribute('position').count / 3).toBeLessThanOrEqual(160);
    // Capital escort adds two separately pivoted blisters, four engine banks and the emitter ring.
    expect(bastion.getAttribute('position').count / 3).toBeLessThanOrEqual(900);
    for (const kind of ['skiff', 'bastion'] as const) {
      expect(new Set(model(kind).getAttribute('accent').array)).toEqual(new Set([0, 1]));
      expect(new Set(model(kind).getAttribute('part').array).has(PART.flame)).toBe(true);
      expect(RIG[kind].flame!.x).toBeLessThan(0);
    }
  });

  it('builds the Breacher and the Drill Yard from the rigged kit within their budgets, with tagged moving parts', () => {
    // heavy infantry shares the Warden's armored-tier budget; the yard the structure budget (foundation included)
    expect(model('breacher').getAttribute('position').count / 3).toBeLessThanOrEqual(260);
    expect(model('drill_yard').getAttribute('position').count / 3).toBeLessThanOrEqual(320);
    for (const kind of ['breacher', 'drill_yard'] as const) expect(new Set(model(kind).getAttribute('accent').array)).toEqual(new Set([0, 1]));
    // Breacher: legs, a recoiling flamer and a pilot light that rides it, centred on the drawn pilot
    for (const part of [PART.left, PART.right, PART.barrel, PART.flame]) expect(model('breacher').getAttribute('part').array).toContain(part);
    expect(RIG.breacher.pilot).toMatchObject(BREACHER.pilot);
    expect(RIG.breacher.recoil!.dist).toBeGreaterThan(0);
    expect(RIG.breacher.flame).toBeUndefined();
    const breacher = model('breacher');
    breacher.computeBoundingBox();
    expect(breacher.boundingBox!.max.x).toBeCloseTo(BREACHER.nozzle.x, 6);
    // wider than a trooper's body (its foxhole is the stance kit: scrape, sandbag courses, dirt; hidden until dug in)
    const p = model('trooper').getAttribute('position'), part = model('trooper').getAttribute('part');
    const kit = new Set<number>([PART.stance, PART.stance2, PART.pit, PART.dust]);
    let trooperZ = 0;
    for (let i = 0; i < p.count; i++) if (!kit.has(part.getX(i))) trooperZ = Math.max(trooperZ, Math.abs(p.getZ(i)));
    expect(breacher.boundingBox!.max.z).toBeGreaterThan(trooperZ * 1.5);
    // Drill Yard: the hoist swings, the beacon paddle spins and its lamp lights, the chimney puffs, only while converting
    for (const part of [PART.tool, PART.rotor, PART.flame, PART.cargo]) expect(model('drill_yard').getAttribute('part').array).toContain(part);
    expect(RIG.drill_yard.swing!.amp).toBeGreaterThan(0);
    expect(RIG.drill_yard.rotor).toMatchObject({ idle: 0 });
    const yard: Entity = { ...digger, kind: 'drill_yard', plane: 'surface', hp: 500, maxHp: 500 };
    expect(stateVisualChannel({ ...yard, state: 'active', progress: 0.3 }, 'work', 40)).toBe(1);
    expect(stateVisualChannel(yard, 'work', 40)).toBe(0);
    const visual = STATE_VISUALS.drill_yard!.parts!;
    expect(visual.some((v) => v.part === PART.flame && v.visible)).toBe(true);
    expect(visual.some((v) => v.part === PART.cargo && v.drift && v.drift.rise > 0)).toBe(true);
  });

  it('uploads only the changed instance when carry changes and retains rules across deltas', () => {
    const view = createGame({ seed: 11, options: { economy: { oreLoad: 25 } } }).view('nw');
    const units = new Entities(false, undefined, 48);
    const entities = [digger, { ...digger, id: 'e_101', x: 14 }];
    const selected = new Set<string>();
    units.ingest({ ...view, tick: 0, entities }, 1000);
    units.frame(1000, 1, selected, undefined, 'nw', 'depths', 30);
    const mesh = units.root.children.find(m => m instanceof Mesh && m.geometry instanceof InstancedBufferGeometry && m.geometry.instanceCount === 2) as Mesh;
    const drive = mesh.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
    const buffer = drive.data;
    const initial = buffer.version;
    buffer.clearUpdateRanges();
    units.frame(1050, 1.05, selected, undefined, 'nw', 'depths', 30);
    expect(buffer.version).toBe(initial);
    expect(buffer.updateRanges).toEqual([]);
    units.ingest({ ...view, match: undefined, tick: 1, entities: [digger, { ...entities[1]!, carry: 50 }] }, 1050);
    units.frame(1100, 1.1, selected, undefined, 'nw', 'depths', 30);
    expect(drive.getW(0)).toBe(0);
    expect(drive.getW(1)).toBeCloseTo(0.5, 2);
    expect(buffer.version).toBe(initial + 1);
    expect(buffer.updateRanges).toEqual([{ start: STRIDE, count: STRIDE }]);
    buffer.clearUpdateRanges();
    units.frame(1150, 1.15, selected, undefined, 'nw', 'depths', 30);
    expect(buffer.version).toBe(initial + 1);
    expect(buffer.updateRanges).toEqual([]);
  });
});

/** JS mirror of `solarStatus` (rig.ts): the packed solar fill's fields. */
function unpackSolar(fill: number) {
  const { fold: F, charge: C, light: L } = SOLAR_FILL;
  const n = Math.round(fill), c = Math.floor(n / F), l = Math.floor(c / C), code = c % C;
  return { fold: (n % F) / (F - 1), anchored: code > 0, charge: Math.max(code - 1, 0) / (C - 2), light: (l % L) / (L - 1), damaged: Math.floor(l / L) === 1 };
}

describe('solar array look', () => {
  const hp = STATS.solar.hp;
  const array: Entity = { id: 'e_200', kind: 'solar', side: 'nw', plane: 'orbit', x: 34, y: 34, hp, maxHp: hp, state: 'unfurled', ramp: 0 };
  const start = DEFAULT_RULES.orbit.solarRampStart;

  it('builds reflective glass, not emissive cells: an iron trim and a collector light carry the output, within the light-unit budget', () => {
    // Regression: the cells glowed with the ramp, so a whole array read as a lamp.
    const geo = model('solar');
    expect(geo.getAttribute('position').count / 3).toBeLessThanOrEqual(160);
    expect(Array.from(geo.getAttribute('glow').array).every((v) => v === 0)).toBe(true);
    expect(new Set(geo.getAttribute('accent').array)).toEqual(new Set([0, 1]));
    const p = geo.getAttribute('position'), part = geo.getAttribute('part');
    const box = (id: number) => {
      const b = { x: 0, top: -Infinity, z0: Infinity, z1: 0 };
      for (let i = 0; i < p.count; i++) if (part.getX(i) === id) {
        b.x = Math.max(b.x, Math.abs(p.getX(i)));
        b.top = Math.max(b.top, p.getY(i));
        b.z0 = Math.min(b.z0, Math.abs(p.getZ(i)));
        b.z1 = Math.max(b.z1, Math.abs(p.getZ(i)));
      }
      return b;
    };
    const glass = box(PART.panel), trim = box(SOLAR_PART.trim);
    expect(glass.z0).toBeCloseTo(SOLAR.root, 6);
    expect(glass.z1).toBeCloseTo(SOLAR.tip, 6);
    // the frame's rim shows round the glass from above: wider and longer than it, below its top
    expect(trim.x).toBeGreaterThan(glass.x);
    expect(trim.z1).toBeGreaterThan(glass.z1);
    expect(trim.top).toBeLessThan(glass.top);
    expect(box(SOLAR_PART.node).top).toBeGreaterThan(glass.top);
    expect(RIG.solar.panel).toEqual({ y: 0, fold: { root: SOLAR.root, folded: SOLAR.folded, stack: SOLAR.stack } });
  });

  it('packs fold, ramp gauge, light and damage exactly; the gauge lights only once anchored', () => {
    for (const progress of [0.25, 0.75]) {
      const anchoring = unpackSolar(packSolar({ ...array, state: 'unfurling', progress }, start, 1));
      expect(anchoring.fold).toBeCloseTo(progress, 2);
      expect(anchoring.anchored).toBe(false);
      const packing = unpackSolar(packSolar({ ...array, state: 'furling', progress }, start, 1));
      expect(packing.fold).toBeCloseTo(1 - progress, 2);
      expect(packing.anchored).toBe(false);
    }
    expect(unpackSolar(packSolar({ ...array, state: 'idle', ramp: 1 }, start, 1))).toMatchObject({ fold: 0, anchored: false });
    expect(unpackSolar(packSolar({ ...array, state: 'moving', ramp: 1 }, start, 1))).toMatchObject({ fold: 0, anchored: false });
    // the gauge fills to the ramp multiplier: rampStart when just anchored, 1 when fully ramped
    for (const ramp of [0, 0.5, 1]) {
      const s = unpackSolar(packSolar({ ...array, ramp }, start, 1));
      expect(s).toMatchObject({ fold: 1, anchored: true, light: 1, damaged: false });
      expect(s.charge).toBeCloseTo(start + (1 - start) * ramp, 1);
    }
    expect(unpackSolar(packSolar({ ...array, ramp: 1 }, start, 1)).charge).toBe(1);
    expect(unpackSolar(packSolar(array, 0, 1))).toMatchObject({ anchored: true, charge: 0 });
    expect(unpackSolar(packSolar(array, start, 0)).light).toBe(0);
    expect(unpackSolar(packSolar(array, start, 0.5)).light).toBeCloseTo(0.5, 1);
    expect(unpackSolar(packSolar({ ...array, hp: Math.floor(hp * 0.5) }, start, 1)).damaged).toBe(true);
    expect(unpackSolar(packSolar({ ...array, hp: hp - 1 }, start, 1)).damaged).toBe(false);
    const most = packSolar({ ...array, ramp: 1, hp: 1 }, 1, 1);
    expect(Number.isInteger(most) && most < 2 ** 24).toBe(true);
    expect(Math.fround(most)).toBe(most);
  });

  it('writes the status into the instance fill: day on a lit bearing, night off it, with no upload while steady', () => {
    applyFade(3);
    try {
      const view = createGame({ seed: 7 }).view('nw');
      const size = view.match!.rules.map.size;
      const e = { ...array, x: size / 2 + 10, y: size / 2 + 10, ramp: 1 };
      const units = new Entities(false, undefined, size);
      const selected = new Set<string>();
      units.ingest({ ...view, tick: 0, entities: [e] }, 1000);
      // the array's bearing from the centre is π/4: a wedge centred there lights it; a quarter turn later it is night
      units.frame(1000, 1, selected, undefined, 'nw', 'orbit', 26, Math.PI / 4);
      const mesh = units.root.children.find(m => m instanceof Mesh && m.geometry instanceof InstancedBufferGeometry && m.geometry.instanceCount === 1) as Mesh;
      const drive = mesh.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
      expect(unpackSolar(drive.getW(0))).toMatchObject({ fold: 1, anchored: true, charge: 1, light: 1, damaged: false });
      const buffer = drive.data;
      buffer.clearUpdateRanges();
      const version = buffer.version;
      units.frame(1050, 1.05, selected, undefined, 'nw', 'orbit', 26, Math.PI / 4);
      expect(buffer.version).toBe(version);
      units.frame(1100, 1.1, selected, undefined, 'nw', 'orbit', 26, Math.PI / 4 + Math.PI / 2);
      expect(unpackSolar(drive.getW(0))).toMatchObject({ anchored: true, light: 0 });
    } finally { applyFade(1); }
  });
});

describe('fog-safe shield hit ellipses', () => {
  const base = createGame({ seed: 11 }).view('nw');
  const ship: Entity = { id: 'bastion', kind: 'bastion', side: 'se', plane: 'orbit', x: 20, y: 20, hp: 240, maxHp: 240, shield: 140, maxShield: 140, state: 'idle', heading: 0 };
  const selected = new Set<string>();
  const pool = (units: Entities) => units.root.getObjectByName('shield-hit-ellipses') as InstancedMesh;

  it('schedules two hollow ellipses for shield loss, including depletion, but not hull-only hits or first sight', () => {
    applyFade(3);
    try {
      const units = new Entities(false, undefined, 48);
      units.ingest({ ...base, tick: 0, entities: [ship] }, 1000);
      units.frame(1000, 1, selected, undefined, 'nw', 'orbit', 26);
      expect(pool(units).count).toBe(0);
      units.ingest({ ...base, tick: 1, entities: [{ ...ship, hp: 230 }] }, 1050);
      units.frame(1200, 1.2, selected, undefined, 'nw', 'orbit', 26);
      expect(pool(units).count).toBe(0);
      units.ingest({ ...base, tick: 5, entities: [{ ...ship, hp: 230, shield: 0 }] }, 1250);
      const at = units.tracks.get(ship.id)!.shieldAt;
      units.frame(at - 1, at / 1000, selected, undefined, 'nw', 'orbit', 26);
      expect(pool(units).count).toBe(0);
      units.frame(at, at / 1000, selected, undefined, 'nw', 'orbit', 26);
      expect(pool(units).count).toBe(2);
      expect(Array.from(pool(units).instanceMatrix.array.slice(0, 32)).every(Number.isFinite)).toBe(true);
      units.frame(at + 651, (at + 651) / 1000, selected, undefined, 'nw', 'orbit', 26);
      expect(pool(units).count).toBe(0);
    } finally { applyFade(1); }
  });

  it('drops hits when their unit leaves the fog-filtered view and never shows them in the Sky', () => {
    applyFade(3);
    try {
      const units = new Entities(false, undefined, 48);
      units.ingest({ ...base, tick: 0, entities: [ship] }, 1000);
      units.ingest({ ...base, tick: 1, entities: [{ ...ship, shield: 120 }] }, 1050);
      units.ingest({ ...base, tick: 2, entities: [] }, 1100);
      units.frame(1300, 1.3, selected, undefined, 'nw', 'orbit', 26);
      expect(pool(units).count).toBe(0);
      const interceptor: Entity = { ...ship, id: 'interceptor', kind: 'interceptor', plane: 'sky', shield: 25, maxShield: 25 };
      units.ingest({ ...base, tick: 3, entities: [interceptor] }, 1150);
      units.ingest({ ...base, tick: 4, entities: [{ ...interceptor, shield: 0 }] }, 1200);
      units.frame(1400, 1.4, selected, undefined, 'nw', 'sky', 26);
      expect(pool(units).count).toBe(0);
    } finally { applyFade(1); }
  });

  it('caps simultaneous hit geometry in the existing instanced-pool style', () => {
    applyFade(3);
    try {
      const units = new Entities(false, undefined, 48);
      const ships = Array.from({ length: 300 }, (_, i) => ({ ...ship, id: `b_${i}` }));
      units.ingest({ ...base, tick: 0, entities: ships }, 1000);
      units.ingest({ ...base, tick: 1, entities: ships.map((e) => ({ ...e, shield: 0 })) }, 1050);
      const at = units.tracks.get('b_0')!.shieldAt;
      units.frame(at, at / 1000, selected, undefined, 'nw', 'orbit', 26);
      expect(pool(units).count).toBe(512);
    } finally { applyFade(1); }
  });
});
