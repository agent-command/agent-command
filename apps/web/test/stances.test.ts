import { describe, expect, it } from 'vitest';
import { InstancedMesh } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { DEPLOY_SPECS, type ArmyId, type Entity } from '@agent-command/game/contract';
import { Entities, orbitMuzzle, type Track } from '../src/world/entities.ts';
import { applyFade } from '../src/world/fade.ts';
import { FOXHOLE, PART, RIG, STATE_VISUALS, TANK_SIEGE, bumpWindow, easeWindow, model, stateVisualChannel, type StatePart } from '../src/world/models.ts';
import { TRENCH, trenchLinks } from '../src/world/trenches.ts';

const tris = (kind: 'tank' | 'trooper') => model(kind).getAttribute('position').count / 3;
const tank: Entity = { id: 'e_300', kind: 'tank', side: 'nw', plane: 'surface', x: 20, y: 20, hp: 300, maxHp: 300, state: 'idle' };
const trooper: Entity = { id: 'e_400', kind: 'trooper', side: 'nw', plane: 'surface', x: 20, y: 20, hp: 60, maxHp: 60, state: 'idle' };
const [sieging, sieged, unsieging] = DEPLOY_SPECS.siege.states;
const [diggingIn, dugIn, diggingOut] = DEPLOY_SPECS.dug_in.states;

/** The CPU value of a table entry's channel op at deploy progress `v` (rig.ts: ease, bump, else the raw channel). */
const op = (p: StatePart, v: number) => (p.ease ? easeWindow(p.ease, v) : p.bump ? bumpWindow(p.bump, v) : v);

/** Every vertex of `part` in `kind`'s model posed at progress `v` by the part's turn/translate/stretch/rise entries. */
function posed(kind: 'tank' | 'trooper', part: number, v: number): [number, number, number][] {
  const geo = model(kind), p = geo.getAttribute('position'), tags = geo.getAttribute('part');
  const out: [number, number, number][] = [];
  for (let i = 0; i < p.count; i++) {
    if (tags.getX(i) !== part) continue;
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    for (const s of STATE_VISUALS[kind]!.parts!) {
      if (s.part !== part || s.channel !== 'work') continue;
      const c = op(s, v);
      if (s.turn?.axis === 'x') {
        const a = s.turn.angle * c, dy = y - s.turn.pivot[1], dz = z - s.turn.pivot[2];
        y = s.turn.pivot[1] + dy * Math.cos(a) - dz * Math.sin(a);
        z = s.turn.pivot[2] + dy * Math.sin(a) + dz * Math.cos(a);
      }
      if (s.translate) { x += s.translate[0] * c; y += s.translate[1] * c; z += s.translate[2] * c; }
      if (s.stretch) { x *= 1 + (s.stretch[0] - 1) * c; y *= 1 + (s.stretch[1] - 1) * c; z *= 1 + (s.stretch[2] - 1) * c; }
      if (s.rise) y *= Math.max(c, 0.001);
    }
    out.push([x, y, z]);
  }
  return out;
}
const top = (vs: [number, number, number][]) => Math.max(...vs.map((v) => v[1]));
const bottom = (vs: [number, number, number][]) => Math.min(...vs.map((v) => v[1]));

describe('tank siege transformation', () => {
  it('follows the deploy progress both ways: sieging rises, packing runs it back', () => {
    for (const progress of [0.2, 0.6]) {
      expect(stateVisualChannel({ ...tank, state: sieging, progress }, 'work', 0)).toBeCloseTo(progress, 9);
      expect(stateVisualChannel({ ...tank, state: unsieging, progress }, 'work', 0)).toBeCloseTo(1 - progress, 9);
    }
    expect(stateVisualChannel({ ...tank, state: sieged }, 'work', 0)).toBe(1);
  });

  it('swings folded legs down and out onto planted pads outside the tracks, on both sides', () => {
    for (const part of [PART.stance, PART.stance2]) {
      const folded = posed('tank', part, 0), planted = posed('tank', part, 1);
      // folded up against the hull side, then on the ground beyond the tracks (outer edge 0.39)
      expect(bottom(folded)).toBeGreaterThanOrEqual(TANK_SIEGE.hinge.y - 0.05);
      expect(bottom(planted)).toBeLessThan(0.01);
      expect(bottom(planted)).toBeGreaterThan(-0.05);
      const side = part === PART.stance ? 1 : -1;
      expect(Math.max(...planted.map((v) => side * v[2]))).toBeGreaterThan(0.5);
      expect(Math.min(...planted.map((v) => side * v[2]))).toBeGreaterThan(0.3);
      // hidden while packed: the legs' visibility entry opens with the transformation
      expect(STATE_VISUALS.tank!.parts!.some((p) => p.part === part && p.visible && p.ease && p.ease[0] === 0)).toBe(true);
    }
  });

  it('settles the hull, runs the barrel out long and raised, then locks down with a thud and a dust burst', () => {
    const hull0 = top(posed('tank', PART.body, 0)), hull1 = top(posed('tank', PART.body, 1));
    expect(hull1).toBeCloseTo(hull0 - TANK_SIEGE.lower, 6);
    const barrel0 = posed('tank', PART.barrel, 0), barrel1 = posed('tank', PART.barrel, 1);
    expect(Math.max(...barrel1.map((v) => v[0]))).toBeGreaterThan(Math.max(...barrel0.map((v) => v[0])) * 1.3);
    // in sequence: the legs are down before the hull settles fully, the barrel runs out after, the thud and dust last
    const { legs, settle, extend, thud, dust } = TANK_SIEGE;
    expect(legs[1]).toBeLessThanOrEqual(settle[1]);
    expect(extend[0]).toBeGreaterThan(settle[0]);
    expect(thud[0]).toBeGreaterThanOrEqual(extend[1] - 0.02);
    expect(dust[1]).toBe(1);
    // the dust is gone once sieged (a bump), so a held siege shows no puffs
    expect(STATE_VISUALS.tank!.parts!.filter((p) => p.part === PART.dust).every((p) => p.bump && bumpWindow(p.bump, 1) < 1e-9)).toBe(true);
    expect(new Set(model('tank').getAttribute('part').array).has(PART.dust)).toBe(true);
  });

  it('fires from the sieged barrel tip and kicks back harder sieged', () => {
    const track = (e: Entity): Track => ({
      e, x: 20, y: 20, st: new Float64Array(8), sx: new Float32Array(8), sy: new Float32Array(8), sh: new Float32Array(8), elevation: 0, n: 1,
      heading: 0, goal: 0, aim: 0, mountPitch: 0, aimUntil: -Infinity, aimX: 0, aimY: 0, aimZ: 0, phase: 0, towHeading: 0, rx: 20, ry: 20, wy: 0,
      scale: 1, motionEpoch: 0, wakeSlot: -1, visible: true, fireAt: -1e9, hitAt: -1e9, shieldAt: -1e9,
      speed: 0, accel: 0, turn: 0, odo: 0, roll: 0, bank: 0, pitch: 0, dive: 0, diveFrom: 'surface',
    }) as unknown as Track;
    const out = new Float64Array(3);
    const mobile = track(tank), planted = track({ ...tank, state: sieged });
    orbitMuzzle(out, mobile, 0, 1000, 48);
    const free = Array.from(out);
    orbitMuzzle(out, planted, 0, 1000, 48);
    expect(out[0]! - free[0]!).toBeCloseTo(0.76 * (TANK_SIEGE.reach - 1), 6);
    expect(out[1]! - free[1]!).toBeCloseTo(TANK_SIEGE.raise - TANK_SIEGE.lower, 6);
    // a shot 50 ms ago: the sieged barrel recoils `recoil`× as far
    mobile.fireAt = planted.fireAt = 950;
    orbitMuzzle(out, mobile, 0, 1000, 48);
    const kickFree = free[0]! - out[0]!;
    orbitMuzzle(out, planted, 0, 1000, 48);
    const kickSieged = free[0]! + 0.76 * (TANK_SIEGE.reach - 1) - out[0]!;
    expect(RIG.tank.recoil!.deployed).toBe(TANK_SIEGE.recoil);
    // the barrel's 1.8× kick, diluted by the turret kick and hull jolt both share
    expect(kickSieged).toBeGreaterThan(kickFree * 1.4);
  });

  it('stays within the armored tier plus its deploy kit', () => {
    expect(tris('tank')).toBeLessThanOrEqual(320);
  });
});

describe('trooper foxhole', () => {
  it('opens a scrape, sinks the trooper and piles the lip in two courses, leaving helmet and rifle over it', () => {
    const parts = STATE_VISUALS.trooper!.parts!;
    const ring = parts.find((p) => p.part === PART.stance && p.rise)!, parapet = parts.find((p) => p.part === PART.stance2 && p.rise)!;
    expect(ring.ease![0]).toBeLessThan(parapet.ease![0]);
    expect(parapet.ease![1]).toBeLessThanOrEqual(1);
    // half way the ring course stands part-built and the parapet is not yet laid
    expect(top(posed('trooper', PART.stance, 0.4))).toBeLessThan(top(posed('trooper', PART.stance, 1)) - 0.01);
    expect(top(posed('trooper', PART.stance2, 0.4))).toBeLessThan(0.01);
    const lip = top(posed('trooper', PART.stance2, 1));
    expect(lip).toBeCloseTo(2 * FOXHOLE.bag, 6);
    // the crouch (RIG.trooper.squat on the hull, work 1) and the sink: the rifle and helmet still clear the lip
    const crouch = (y: number) => y * (1 - RIG.trooper.squat! * 0.4);
    const rifle = posed('trooper', PART.barrel, 1), body = posed('trooper', PART.body, 1);
    expect(Math.min(...rifle.map((v) => crouch(v[1])))).toBeGreaterThan(lip);
    expect(Math.max(...body.map((v) => crouch(v[1])))).toBeGreaterThan(lip + 0.15);
    expect(top(posed('trooper', PART.body, 1))).toBeCloseTo(top(posed('trooper', PART.body, 0)) - FOXHOLE.sink, 6);
  });

  it('kicks dirt only while digging in or out, and keeps the light-unit kit lean', () => {
    for (const [state, on] of [[diggingIn, 1], [diggingOut, 1], [dugIn, 0], ['idle', 0]] as const) expect(stateVisualChannel({ ...trooper, state }, 'fill', 0)).toBe(on);
    expect(STATE_VISUALS.trooper!.parts!.some((p) => p.part === PART.dust && p.channel === 'fill' && p.drift)).toBe(true);
    for (const part of [PART.pit, PART.stance, PART.stance2, PART.dust]) expect(new Set(model('trooper').getAttribute('part').array).has(part)).toBe(true);
    // the old six-bag ring was 216 triangles; the foxhole kit (scrape, two courses, dirt) fits in two more
    expect(tris('trooper')).toBeLessThanOrEqual(218);
  });
});

describe('trench lines', () => {
  const links = (pts: [number, number, number?, ArmyId?][]) => {
    const n = pts.length;
    const xs = new Float32Array(pts.map((p) => p[0])), zs = new Float32Array(pts.map((p) => p[1])), ys = new Float32Array(pts.map((p) => p[2] ?? 0));
    const out = new Int32Array(n * 4);
    const count = trenchLinks(xs, zs, ys, pts.map((p) => p[3] ?? 'nw'), n, TRENCH.join, TRENCH.step, new Int32Array(n * 2), out);
    return Array.from({ length: count }, (_, i) => `${out[i * 2]}-${out[i * 2 + 1]}`).sort();
  };

  it('chains a line of dug-in troopers once per neighbour pair, whatever the order', () => {
    expect(links([[0, 0], [1, 0], [2, 0], [3, 0]])).toEqual(['0-1', '1-2', '2-3']);
    expect(links([[3, 0], [1, 0], [0, 0], [2, 0]])).toEqual(['0-3', '1-2', '1-3']);
    // a tight squad of three closes into a triangle; no trooper links more than its two nearest
    expect(links([[0, 0], [1, 0], [0.5, 0.8]])).toEqual(['0-1', '0-2', '1-2']);
  });

  it('never joins armies, far troopers or a cliff step', () => {
    expect(links([[0, 0, 0, 'nw'], [1, 0, 0, 'se']])).toEqual([]);
    expect(links([[0, 0], [TRENCH.join + 0.1, 0]])).toEqual([]);
    expect(links([[0, 0, 0], [1, 0, TRENCH.step + 0.1]])).toEqual([]);
  });

  it('draws one segment between two dug-in neighbours, widening with the lesser dig-in progress', () => {
    applyFade(1);
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    const mesh = units.root.getObjectByName('trench-lines') as InstancedMesh;
    const frame = (b: Partial<Entity>, now: number) => {
      units.ingest({ ...view, tick: now / 50, entities: [{ ...trooper, state: dugIn }, { ...trooper, id: 'e_401', x: 21, ...b }] }, now);
      units.frame(now, now / 1000, new Set(), undefined, 'nw', 'surface', 30);
    };
    frame({ state: 'idle' }, 1000);
    expect(mesh.count).toBe(0);
    frame({ state: diggingIn, progress: 0.25 }, 1050);
    expect(mesh.count).toBe(1);
    const m = mesh.instanceMatrix.array;
    const width = Math.hypot(m[8]!, m[10]!);
    frame({ state: dugIn }, 1100);
    expect(Math.hypot(m[8]!, m[10]!)).toBeCloseTo(width * 4, 4);
    frame({ side: 'se', state: dugIn }, 1150);
    expect(mesh.count).toBe(0);
  });
});
