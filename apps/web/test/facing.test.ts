import { describe, expect, it } from 'vitest';
import { InstancedBufferGeometry, Mesh, type InterleavedBufferAttribute } from 'three/webgpu';
import { diff } from 'playerthree/delta';
import { applyView, type ViewMessage, type ViewState } from 'playerthree/protocol';
import { createGame } from '@agent-command/game';
import type { Entity, View } from '@agent-command/game/contract';
import { Entities, workHeading } from '../src/world/entities.ts';

const noSelection = new Set<string>();
const delta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

function fixture(kind: 'solar' | 'interceptor') {
  const view = createGame({ seed: 7 }).view('nw');
  const base = view.entities.find(e => e.kind === kind)!;
  const units = new Entities(false, undefined, 48);
  return {
    units, base,
    snapshot(tick: number, x: number, y: number, state: Entity['state'] = 'moving') {
      units.ingest({ ...view, tick, entities: [{ ...base, heading: undefined, state, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }] }, 1000 + tick * 50);
    },
    frame(ms: number) {
      units.frame(1000 + ms, ms / 1000, noSelection, undefined, 'nw', base.plane, 26);
      return units.tracks.get(base.id)!;
    },
  };
}

describe('rendered unit facing', () => {
  it.each([30, 60])('does not amplify rounded straight-line positions into yaw shake at %i fps', fps => {
    const f = fixture('solar');
    let nextTick = 0;
    let min = Infinity;
    let max = -Infinity;
    let largestStep = 0;
    let previous = 0;
    const direction = Math.atan2(0.43, 1.17);
    for (let frame = 0; frame <= 10 * fps; frame++) {
      const ms = frame * 1000 / fps;
      while (nextTick * 50 <= ms + 1e-6) {
        const seconds = nextTick / 20;
        f.snapshot(nextTick++, 12 + seconds * 1.17, 12 + seconds * 0.43);
      }
      const heading = f.frame(ms).heading;
      if (ms > 2000) {
        const error = delta(direction, heading);
        min = Math.min(min, error);
        max = Math.max(max, error);
        largestStep = Math.max(largestStep, Math.abs(delta(previous, heading)));
      }
      previous = heading;
    }
    expect((max - min) * 180 / Math.PI).toBeLessThan(1.2);
    expect(largestStep * 180 / Math.PI).toBeLessThan(0.4);
  });

  it.each(['interceptor', 'solar'] as const)('keeps idle %s orientation fixed despite position corrections', kind => {
    const f = fixture(kind);
    let initial: number[] | undefined;
    let heading: number | undefined;
    for (let frame = 0; frame <= 600; frame++) {
      if (frame % 3 === 0) {
        const correction = (frame / 3) % 2 ? 0.02 : 0;
        f.snapshot(frame / 3, 12 + correction, 12 - correction, 'idle');
      }
      const tr = f.frame(frame * 1000 / 60);
      heading ??= tr.heading;
      expect(tr.heading).toBe(heading);
      // Inspect the actual instance record the vertex rig transforms with: yaw, bank (roll) and pitch.
      const mesh = f.units.root.children.find(child => child instanceof Mesh && child.geometry instanceof InstancedBufferGeometry && child.geometry.instanceCount === 1 && child.renderOrder === 40) as Mesh;
      const pose = mesh.geometry.getAttribute('unitPose') as InterleavedBufferAttribute;
      const form = mesh.geometry.getAttribute('unitForm') as InterleavedBufferAttribute;
      const attitude = [pose.getW(0), form.getZ(0), form.getW(0)];
      initial ??= attitude;
      for (let i = 0; i < 3; i++) expect(Math.abs(attitude[i]! - initial[i]!)).toBeLessThan(0.001);
    }
  });

  it('still follows a real turn promptly and takes the short path across the angle wrap', () => {
    const f = fixture('solar');
    const before = Math.PI - 0.05;
    const after = -Math.PI + 0.15;
    let x = 24;
    let y = 24;
    let previous = 0;
    let largestStep = 0;
    for (let frame = 0; frame <= 360; frame++) {
      if (frame % 3 === 0) {
        const direction = frame < 180 ? before : after;
        x += Math.cos(direction) * 0.1;
        y += Math.sin(direction) * 0.1;
        f.snapshot(frame / 3, x, y);
      }
      const heading = f.frame(frame * 1000 / 60).heading;
      if (frame > 180) largestStep = Math.max(largestStep, Math.abs(delta(previous, heading)));
      if (frame === 240) expect(Math.abs(delta(heading, after))).toBeLessThan(0.03);
      previous = heading;
    }
    expect(largestStep).toBeLessThan(0.05);
  });

  it.each(['tank', 'flak', 'turret'] as const)('keeps %s hull facing independent of authoritative turret aim and shot recoil', kind => {
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    const e: Entity = {
      id: 'e_100', kind, side: 'nw', plane: 'surface', state: 'attacking',
      x: 12, y: 12, hp: 100, maxHp: 100, heading: 0, aim: Math.PI / 2,
    };
    units.ingest({ ...view, tick: 0, entities: [e] }, 1000);
    units.frame(1000, 1, noSelection, undefined, 'nw', 'surface', 26);
    const mesh = units.root.children.find(child => child instanceof Mesh && child.geometry instanceof InstancedBufferGeometry && child.geometry.instanceCount === 1 && child.renderOrder === 40) as Mesh;
    const pose = mesh.geometry.getAttribute('unitPose') as InterleavedBufferAttribute;
    const drive = mesh.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
    const track = units.tracks.get(e.id)!;
    expect(track.heading).toBe(0);
    expect(pose.getW(0)).toBeCloseTo(0);
    expect(drive.getW(0)).toBeCloseTo(-Math.PI / 2);

    units.fire({ tick: 1, kind: 'shot', plane: e.plane, x: e.x, y: e.y }, 1050, []);
    units.frame(1050, 1.05, noSelection, undefined, 'nw', 'surface', 26);
    expect(track.fireAt).toBe(1050);
    expect(track.goal).toBe(0);
    expect(track.heading).toBe(0);
    expect(drive.getW(0)).toBeCloseTo(-Math.PI / 2);

    // Mobile hulls turn under the mount; a cell-aligned turret foundation never rotates.
    units.ingest({ ...view, tick: 1, entities: [{ ...e, heading: Math.PI / 2 }] }, 1050);
    units.frame(1100, 1.1, noSelection, undefined, 'nw', 'surface', 26);
    if (kind === 'turret') expect(track.heading).toBe(0);
    else {
      expect(track.heading).toBeGreaterThan(0);
      expect(track.heading).toBeLessThan(Math.PI / 2);
    }
    expect(pose.getW(0)).toBeCloseTo(-track.heading);
    expect(pose.getW(0) + drive.getW(0)).toBeCloseTo(-Math.PI / 2);

    // Absent aim smoothly parks the mount forward; it never borrows private target coordinates.
    units.ingest({ ...view, tick: 2, entities: [{ ...e, aim: undefined, tx: 12, ty: 20 }] }, 1100);
    const previousYaw = Math.abs(drive.getW(0));
    units.frame(1150, 1.15, noSelection, undefined, 'nw', 'surface', 26);
    expect(Math.abs(drive.getW(0))).toBeLessThan(previousYaw);
    for (let frame = 1; frame <= 24; frame++)
      units.frame(1150 + frame * 50, 1.15 + frame * 0.05, noSelection, undefined, 'nw', 'surface', 26);
    expect(drive.getW(0)).toBeCloseTo(0, 2);
    expect(track.goal).toBe(0);
  });

  it('encodes turret yaw by the shortest angle across the wrap', () => {
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    const e: Entity = {
      id: 'e_100', kind: 'tank', side: 'se', plane: 'surface', state: 'attacking',
      x: 12, y: 12, hp: 100, maxHp: 100, heading: Math.PI - 0.05, aim: -Math.PI + 0.15,
    };
    units.ingest({ ...view, tick: 0, entities: [e] }, 1000);
    units.frame(1000, 1, noSelection, undefined, 'nw', 'surface', 26);
    const mesh = units.root.children.find(child => child instanceof Mesh && child.geometry instanceof InstancedBufferGeometry && child.geometry.instanceCount === 1 && child.renderOrder === 40) as Mesh;
    const drive = mesh.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
    expect(drive.getW(0)).toBeCloseTo(-0.2);
    expect(units.tracks.get(e.id)!.heading).toBe(e.heading);
  });

  it.each([
    ['solar', 0], ['tug', 0.08], ['lancer', 0.08], ['interceptor', 0.3],
  ] as const)('banks coasting Orbit %s from public heading and visible motion within its class limit', (kind, limit) => {
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    const e: Entity = { id: 'e_900', kind, plane: 'orbit', side: 'nw', x: 12, y: 12, hp: 100, maxHp: 100, state: 'idle', heading: 0 };
    let peak = 0;
    for (let frame = 0; frame <= 180; frame++) {
      const heading = Math.max(0, (frame - 60) / 60) * 1.5;
      if (frame % 3 === 0) {
        e.x += Math.cos(heading) * 0.1;
        e.y += Math.sin(heading) * 0.1;
        units.ingest({ ...view, tick: frame / 3, entities: [{ ...e, heading }] }, 1000 + frame * 1000 / 60);
      }
      units.frame(1000 + frame * 1000 / 60, frame / 60, noSelection, undefined, 'nw', 'orbit', 26);
      const tr = units.tracks.get(e.id)!;
      expect(tr.goal).toBeCloseTo(tr.e.heading!);
      const mesh = units.root.children.find(child => child instanceof Mesh && child.geometry instanceof InstancedBufferGeometry && child.geometry.instanceCount === 1 && child.renderOrder === 40) as Mesh;
      const form = mesh.geometry.getAttribute('unitForm') as InterleavedBufferAttribute;
      peak = Math.max(peak, form.getZ(0));
      expect(Math.abs(form.getZ(0))).toBeLessThanOrEqual(limit + 0.001);
    }
    expect(units.tracks.get(e.id)!.speed).toBeGreaterThan(1);
    if (limit === 0) expect(peak).toBe(0);
    else expect(peak).toBeGreaterThan(0.02);
  });

  it('does not turn idle Sky position corrections into Orbit-style coasting', () => {
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    const e: Entity = { id: 'e_900', kind: 'interceptor', plane: 'sky', side: 'nw', x: 12, y: 12, hp: 100, maxHp: 100, state: 'idle', heading: 0 };
    for (let tick = 0; tick < 20; tick++) {
      units.ingest({ ...view, tick, entities: [{ ...e, x: e.x + tick * 0.1 }] }, 1000 + tick * 50);
      units.frame(1000 + tick * 50, tick / 20, noSelection, undefined, 'nw', 'sky', 26);
      expect(units.tracks.get(e.id)!.speed).toBe(0);
    }
  });
});

describe('render clock arrival batches', () => {
  it('keeps motion, facing and gait on the same clock for identical deltas delivered normally or in bursts', () => {
    const base = createGame({ seed: 7 }).view('nw');
    const mover: Entity = { id: 'e_900', kind: 'trooper', side: 'nw', plane: 'surface', state: 'moving', x: 12, y: 12, hp: 100, maxHp: 100 };
    // No heading is sent for travelling infantry: its rendered facing and gait must follow public position samples.
    const views = Array.from({ length: 81 }, (_, tick): View => ({
      ...base, tick, entities: [{ ...mover, x: 12 + Math.min(tick, 40) / 10, y: 12 + Math.max(0, tick - 40) / 10 }],
    }));
    const messages: ViewMessage[] = views.map((view, index) => index === 0
      ? { op: 'view', team: 'nw', version: 1, view }
      : { op: 'view', team: 'nw', version: index + 1, delta: diff(views[index - 1], view)! });
    for (const { fps, batch } of [{ fps: 60, batch: 1 }, { fps: 60, batch: 10 }, { fps: 4, batch: 5 }]) {
      const units = new Entities(false, undefined, 48);
      let state: ViewState | undefined;
      let next = 0;
      for (let frame = 0; frame <= 4 * fps; frame++) {
        const ms = frame * 1000 / fps;
        let arrived = false;
        while (next < messages.length && Math.ceil(next / batch) * batch * 50 <= ms + 1e-6) {
          state = applyView(state, messages[next]!);
          expect(state).toBeDefined();
          const decoded = state!.view as View;
          expect(decoded.entities).toEqual(views[next]!.entities);
          units.ingest(decoded, 1000 + ms);
          next++;
          arrived = true;
        }
        units.frame(1000 + ms, ms / 1000, noSelection, undefined, 'nw', 'surface', 26);
        expect(units.tickTime(81, 1000 + ms) - units.tickTime(80, 1000 + ms)).toBeCloseTo(50, 6);
        const track = units.tracks.get(mover.id)!;
        if (arrived && ms >= 750 && ms <= 1500) {
          expect(track.speed).toBeGreaterThan(1);
          expect(track.odo).toBeGreaterThan(0);
        }
      }
      expect(next).toBe(messages.length);
      const track = units.tracks.get(mover.id)!;
      expect(track.speed).toBeGreaterThan(1);
      expect(Math.abs(delta(track.heading, Math.PI / 2))).toBeLessThan(0.2);
      const mesh = units.root.children.find(child => child instanceof Mesh && child.geometry instanceof InstancedBufferGeometry && child.geometry.instanceCount === 1 && child.renderOrder === 40) as Mesh;
      const pose = mesh.geometry.getAttribute('unitPose') as InterleavedBufferAttribute;
      const drive = mesh.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
      expect(pose.getW(0)).toBeCloseTo(-track.heading);
      expect(Math.abs(drive.getX(0) - track.speed)).toBeLessThanOrEqual(0.011);
    }
  });

  it.each([10, 150])('still estimates a real %i ms tick rather than assuming the nominal simulation rate', period => {
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    for (let tick = 0; tick <= 60; tick++) {
      const now = 1000 + tick * period;
      units.ingest({ ...view, tick, entities: [] }, now);
      units.frame(now, now / 1000, noSelection, undefined, 'nw', 'surface', 26);
    }
    expect(units.tickTime(61, 10000) - units.tickTime(60, 10000)).toBeCloseTo(period, 0);
  });

  it('uses arrival time, ignores frames without new ticks, and resets the sample anchor on replay or reconnect', () => {
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    const receive = (tick: number, now: number) => units.ingest({ ...view, tick, entities: [] }, now);
    const frame = (now: number) => units.frame(now, now / 1000, noSelection, undefined, 'nw', 'surface', 26);
    const period = () => units.tickTime(101, 10000) - units.tickTime(100, 10000);
    receive(100, 1000);
    frame(1016);
    frame(1033);
    receive(101, 1050);
    frame(1100);
    expect(period()).toBeCloseTo(50, 6);
    receive(101, 1110); // A same-tick keyframe is not another rate sample.
    frame(1116);
    receive(102, 1150);
    frame(1166);
    expect(period()).toBeCloseTo(55, 6); // 0.9 * 50 + 0.1 * the actual 100 ms between new ticks.
    receive(0, 5000); // A rewind resets the view and its timing history.
    frame(5000);
    receive(5, 5250);
    frame(5250);
    expect(period()).toBeCloseTo(50, 6);
    units.reset();
    receive(1000, 10000);
    frame(10000);
    receive(1005, 10250);
    frame(10250);
    expect(period()).toBeCloseTo(50, 6);
  });
});

const workStates = [
  ['digger', 'digging'], ['digger', 'mining'], ['digger', 'fortifying'],
  ['digger', 'laying'], ['digger', 'bridging'], ['digger', 'constructing'],
  ['sapper', 'undermining'], ['tug', 'grappling'], ['tug', 'towing'],
  ['interceptor', 'capturing'], ['trooper', 'attacking'],
] as const satisfies readonly (readonly [Entity['kind'], Entity['state']])[];

function worker(overrides: Partial<Entity> = {}): Entity {
  return { id: 'e_900', kind: 'digger', side: 'nw', plane: 'depths', x: 12, y: 12, hp: 100, maxHp: 100, state: 'digging', ...overrides };
}

describe('work-facing target selection', () => {
  const empty = new Map<string, { e: Entity }>();

  it.each(workStates)('%s %s faces its current work point, not its final destination', (kind, state) => {
    const e = worker({ kind, state, work: { x: 12, y: 14 }, tx: 20, ty: 12 });
    expect(workHeading(e, 'nw', empty)).toBeCloseTo(Math.PI / 2);
  });

  it.each(workStates.filter(([, state]) => state !== 'towing'))('%s %s supports an own exposed destination when no work point exists', (kind, state) => {
    expect(workHeading(worker({ kind, state, tx: 10, ty: 12 }), 'nw', empty)).toBeCloseTo(Math.PI);
  });

  it.each(workStates)('%s %s cannot use an enemy private work point or destination', (kind, state) => {
    expect(workHeading(worker({ kind, state, side: 'se', work: { x: 12, y: 14 }, tx: 20, ty: 12 }), 'nw', empty)).toBeUndefined();
  });

  it.each(['grappling', 'towing', 'capturing'] as const)('%s uses only an exposed linked target', state => {
    const target = worker({ id: 'e_901', kind: state === 'capturing' ? 'island' : 'asteroid', x: 12, y: 10 });
    const targets = new Map([[target.id, { e: target }]]);
    const e = worker({ kind: state === 'capturing' ? 'interceptor' : 'tug', state, link: target.id, tx: 20, ty: 12 });
    expect(workHeading(e, 'nw', targets)).toBeCloseTo(-Math.PI / 2);
    expect(workHeading({ ...e, side: 'se' }, 'nw', targets)).toBeCloseTo(-Math.PI / 2);
    expect(workHeading({ ...e, side: 'se' }, 'nw', empty)).toBeUndefined();
    expect(workHeading({ ...e, work: { x: 14, y: 12 } }, 'nw', targets)).toBe(0);
    expect(workHeading({ ...e, work: { x: 12, y: 12 } }, 'nw', targets)).toBeCloseTo(-Math.PI / 2);
  });

  it.each(workStates)('%s %s holds its last heading at a coincident work point', (kind, state) => {
    expect(workHeading(worker({ kind, state, work: { x: 12, y: 12 }, tx: 20, ty: 12 }), 'nw', empty)).toBeUndefined();
  });

  it.each(['tank', 'turret', 'flak', 'spire'] as const)('does not redirect an attacking %s hull with its mount target', kind => {
    expect(workHeading(worker({ kind, state: 'attacking', work: { x: 12, y: 14 } }), 'nw', empty)).toBeUndefined();
  });

  it.each(['idle', 'moving', 'hauling'] as const)('does not turn an ordinary %s worker toward a route destination', state => {
    expect(workHeading(worker({ state, tx: 20, ty: 12 }), 'nw', empty)).toBeUndefined();
  });

  it('does not turn a constructing structure as if it were its builder', () => {
    expect(workHeading(worker({ kind: 'bulkhead', state: 'constructing', work: { x: 12, y: 14 } }), 'nw', empty)).toBeUndefined();
  });

  it.each(['towing', 'moving'] as const)('faces along the tow bearing with a coincident linked rock behind it while %s', state => {
    const rock = worker({ id: 'e_901', kind: 'asteroid', state: 'towed' });
    const targets = new Map([[rock.id, { e: rock, rx: -100, ry: 100 }]]);
    const tug = worker({ kind: 'tug', state, link: rock.id, work: { x: 12, y: 12 }, tx: 20, ty: 12 });
    expect(workHeading(tug, 'nw', targets, 0.4)).toBeCloseTo(0.4);
    expect(workHeading({ ...tug, side: 'se' }, 'nw', targets, 0.4)).toBeCloseTo(0.4);
    expect(workHeading(tug, 'nw', empty, 0.4)).toBeUndefined();
    expect(workHeading({ ...tug, work: undefined }, 'nw', empty, 0.4)).toBeUndefined();
  });
});

describe('damped work-facing rendering', () => {
  it.each(workStates)('%s %s slews toward its task instead of snapping', (kind, state) => {
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    const e = worker({ kind, state, work: { x: 12, y: 14 } });
    units.ingest({ ...view, tick: 0, entities: [e] }, 1000);
    const tr = units.tracks.get(e.id)!;
    tr.heading = tr.goal = 0;
    units.frame(1000, 0, noSelection, undefined, 'nw', e.plane, 26);
    expect(tr.heading).toBe(0);
    units.frame(1000 + 1000 / 60, 1 / 60, noSelection, undefined, 'nw', e.plane, 26);
    expect(tr.heading).toBeGreaterThan(0);
    expect(tr.heading).toBeLessThanOrEqual(7 / 60 + 1e-9);
    for (let frame = 2; frame <= 120; frame++)
      units.frame(1000 + frame * 1000 / 60, frame / 60, noSelection, undefined, 'nw', e.plane, 26);
    expect(Math.abs(delta(tr.heading, Math.PI / 2))).toBeLessThan(0.001);
  });

  it.each([false, true])('keeps towing stable with asteroid-first insertion %s', asteroidFirst => {
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    const tug = worker({ kind: 'tug', plane: 'orbit', state: 'moving', link: 'e_901', work: { x: 12, y: 12 } });
    const rock = worker({ id: 'e_901', kind: 'asteroid', plane: 'orbit', state: 'towed', link: tug.id });
    units.ingest({ ...view, tick: 0, entities: asteroidFirst ? [rock, tug] : [tug, rock] }, 1000);
    const tr = units.tracks.get(tug.id)!;
    tr.heading = tr.goal = tr.towHeading = 0;
    for (let frame = 0; frame <= 240; frame++) {
      units.frame(1000 + frame * 1000 / 60, frame / 60, noSelection, undefined, 'nw', 'orbit', 26);
      const asteroid = units.tracks.get(rock.id)!;
      expect(asteroid.rx).toBeCloseTo(tr.rx - 2.6);
      expect(asteroid.ry).toBeCloseTo(tr.ry);
      expect(tr.towHeading).toBe(0);
      if (frame >= 120) expect(Math.abs(delta(tr.heading, 0))).toBeLessThan(0.001);
    }
  });

  it('retains last travel heading when an enemy work target is absent', () => {
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    const e = worker({ side: 'se', state: 'mining' });
    units.ingest({ ...view, tick: 0, entities: [e] }, 1000);
    const tr = units.tracks.get(e.id)!;
    tr.heading = tr.goal = 1.2;
    for (let frame = 0; frame <= 60; frame++) {
      units.frame(1000 + frame * 1000 / 60, frame / 60, noSelection, undefined, 'nw', e.plane, 26);
      expect(tr.heading).toBe(1.2);
    }
  });
});
