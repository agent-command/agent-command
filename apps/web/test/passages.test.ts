import { afterEach, describe, expect, it } from 'vitest';
import { InstancedBufferGeometry, Mesh, type InterleavedBufferAttribute } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { CELL, DEFAULT_RULES, type Entity } from '@agent-command/game/contract';
import { Entities } from '../src/world/entities.ts';
import { fadeValue, focusValue } from '../src/world/fade.ts';
import { model, stateVisualChannel } from '../src/world/models.ts';
import { passageMask, passageOccupied, passagePose, Presentations } from '../src/world/passages.ts';

/** Default-size knowledge grids; the large-map edge test below builds its own. */
const size = DEFAULT_RULES.map.size;
const gate: Entity = { id: 'e_900', kind: 'bulkhead', plane: 'depths', side: 'nw', x: 20.5, y: 20.5, hp: 100, maxHp: 100, state: 'active' };
const runner: Entity = { id: 'e_901', kind: 'trooper', plane: 'depths', side: 'nw', x: 19.85, y: 20.5, hp: 80, maxHp: 80, state: 'moving', tx: 22.5, ty: 20.5 };
const cells = (mask: number) => {
  const out = Array(size * size).fill(CELL.rock);
  out[20 * size + 20] = CELL.tunnel;
  for (const [bit, dx, dy] of [[1, 1, 0], [2, 0, 1], [4, -1, 0], [8, 0, -1]]) if (mask & bit!) out[(20 + dy!) * size + 20 + dx!] = CELL.tunnel;
  return out;
};
const view = (mask: number, entities: Entity[] = [gate]) => ({ ...createGame({ seed: 11 }).view('nw'), entities, memory: [], depths: cells(mask), fx: [] });
const initialFade = { ...fadeValue }, initialFocus = { ...focusValue };
afterEach(() => { Object.assign(fadeValue, initialFade); Object.assign(focusValue, initialFocus); });

describe('knowledge-derived bulkhead presentation', () => {
  it('spans straight passages, bisects all four bends, and encloses all junction sides', () => {
    for (let mask = 0; mask < 16; mask++) {
      const state = { work: 0, target: 0, fill: 0, yaw: 0 };
      expect(passageMask(cells(mask), gate.x, gate.y, size)).toBe(mask);
      passagePose(mask, state);
      const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]].filter((_, i) => mask & (1 << i));
      if (directions.length >= 3) expect(state.fill).toBe(1);
      else if (directions.length === 2) {
        expect(state.fill).toBe(mask === 5 || mask === 10 ? 0 : 0.5);
        const dx = directions[0]![0]! - directions[1]![0]!, dy = directions[0]![1]! - directions[1]![1]!;
        expect(Math.abs(Math.cos(state.yaw) * dx + Math.sin(state.yaw) * dy)).toBeCloseTo(Math.hypot(dx, dy));
      }
    }
    expect(passageMask(Array(size * size).fill(CELL.unknown), 20.5, 20.5, size)).toBe(0);
    expect(passageMask(Array(size * size).fill(CELL.tunnel), 0.5, 0.5, size)).toBe(3);
    // 288 for the gate and leaves, plus 16 for the two seal-dust puffs
    expect(model('bulkhead').getAttribute('position').count / 3).toBe(304);
  });

  it.each([64, 80])('indexes known neighbours at the large-map edge on S%s', (size) => {
    const cells = Array<number>(size * size).fill(CELL.unknown);
    cells[(size - 1) * size + size - 2] = CELL.tunnel;
    cells[(size - 2) * size + size - 1] = CELL.tunnel;
    expect(passageMask(cells, size - 0.5, size - 0.5, size)).toBe(12);
    cells[(size - 1) * size] = CELL.tunnel;
    expect(passageMask(cells, size - 0.5, size - 0.5, size)).toBe(12);
  });

  it('opens only for own incoming or occupying units, not nearby units facing away or enemies', () => {
    const v = view(5, [gate, runner]);
    expect(passageOccupied(gate, v, new Map(), false)).toBe(true);
    expect(passageOccupied(gate, { ...v, entities: [gate, { ...runner, tx: 18 }] }, new Map(), false)).toBe(false);
    expect(passageOccupied(gate, { ...v, entities: [gate, { ...runner, state: 'idle' }] }, new Map(), false)).toBe(false);
    expect(passageOccupied(gate, { ...v, entities: [gate, { ...runner, x: 20.5, state: 'idle' }] }, new Map(), false)).toBe(true);
    expect(passageOccupied({ ...gate, side: 'se' }, v, new Map(), true)).toBe(false);
    expect(passageOccupied(gate, { ...v, entities: [gate, { ...runner, side: 'se' }] }, new Map(), true)).toBe(false);
    expect(passageOccupied(gate, { ...v, entities: [gate, { ...runner, x: 21.25 }] }, new Map(), true)).toBe(false);
    const automatic = { ...runner, tx: undefined, ty: undefined, state: 'hauling' as const };
    expect(passageOccupied(gate, { ...v, entities: [gate, automatic] }, new Map([[runner.id, { n: 2, sx: [19.7, 19.85], sy: [20.5, 20.5] }]]), false)).toBe(true);
  });

  it('re-derives layouts, closes after passage, snaps with reduced motion, and never animates memories', () => {
    const p = new Presentations(), tracks = new Map();
    const v = view(5, [gate, runner]);
    p.ingest(v, tracks); p.frame(0.09, false);
    expect(p.get(gate.id)!.work).toBeCloseTo(0.5);
    p.frame(0.09, false); expect(p.get(gate.id)!.work).toBe(1);
    p.ingest({ ...v, depths: cells(3), entities: [gate] }, tracks);
    expect(p.get(gate.id)!.fill).toBe(0.5);
    p.frame(0.09, false); expect(p.get(gate.id)!.work).toBeCloseTo(0.5);
    p.frame(0.01, true); expect(p.get(gate.id)!.work).toBe(0);
    p.ingest({ ...v, depths: cells(15) }, tracks); p.frame(0.001, true);
    expect(p.get(gate.id)!.fill).toBe(1); expect(p.get(gate.id)!.work).toBe(1);
    p.ingest({ ...v, entities: [], memory: [{ id: gate.id, kind: gate.kind, plane: gate.plane, side: 'se', x: gate.x, y: gate.y, seen: 1 }] }, tracks);
    expect(p.get(gate.id)!.work).toBe(0); expect(p.get(gate.id)!.target).toBe(0);
  });

  it('lays a lava bridge along its run, live or remembered, and never animates it for the traffic crossing', () => {
    const span: Entity = { ...gate, id: 'e_902', kind: 'lava_bridge' };
    const p = new Presentations(), tracks = new Map();
    p.ingest(view(5, [span, runner]), tracks); p.frame(1, false);
    expect(p.get(span.id)).toMatchObject({ yaw: 0, work: 0, target: 0, fill: 0 });
    p.ingest(view(10, [span]), tracks);
    expect(p.get(span.id)!.yaw).toBeCloseTo(Math.PI / 2);
    p.ingest({ ...view(10, []), memory: [{ id: span.id, kind: span.kind, plane: span.plane, side: 'se', x: span.x, y: span.y, seen: 1 }] }, tracks);
    expect(p.get(span.id)!.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('opens a Warden for traffic, never for itself, and closes without packing or replacing its deploy channel', () => {
    const warden: Entity = { ...gate, kind: 'warden', state: 'walled' };
    const p = new Presentations(), tracks = new Map();
    p.ingest(view(5, [warden]), tracks); p.frame(1, false);
    expect(p.get(warden.id)!.work).toBe(0);
    p.ingest(view(5, [warden, runner]), tracks); p.frame(0.09, false);
    expect(stateVisualChannel(warden, 'fill', 40, 0, 0, p.get(warden.id))).toBeCloseTo(0.5);
    expect(stateVisualChannel(warden, 'work', 40, 0, 0, p.get(warden.id))).toBe(1);
    p.frame(0.09, false);
    p.ingest(view(5, [warden, { ...runner, x: 20.5 }]), tracks);
    expect(p.get(warden.id)!.target).toBe(1);
    p.ingest(view(5, [warden, { ...runner, x: 21.3 }]), tracks); p.frame(0.09, false);
    expect(p.get(warden.id)!.work).toBeCloseTo(0.5);
    p.frame(0.09, false); expect(p.get(warden.id)!.work).toBe(0);
    p.ingest(view(5, [warden, runner]), tracks); p.frame(0.001, true);
    expect(p.get(warden.id)!.work).toBe(1);
    p.ingest(view(5, [warden]), tracks); p.frame(0.001, true);
    expect(p.get(warden.id)!.work).toBe(0);
    p.ingest(view(5, [{ ...warden, side: 'se' }, runner]), tracks); p.frame(1, false);
    expect(p.get(warden.id)!.work).toBe(0);
    p.ingest({ ...view(5), entities: [], memory: [{ ...warden, seen: 1 }] }, tracks);
    expect(p.get(warden.id)!.work).toBe(0);
    p.ingest(view(5, []), tracks); expect(p.get(warden.id)).toBeUndefined();
  });

  it('does not let idle or rooted Wardens hold each other open, but still opens for a walking Warden', () => {
    const a: Entity = { ...gate, kind: 'warden', state: 'walled' };
    const b: Entity = { ...a, id: 'e_902' };
    const p = new Presentations(), tracks = new Map();
    for (const state of ['idle', 'walling', 'walled', 'unwalling'] as const) {
      p.ingest(view(5, [a, { ...b, state }]), tracks); p.frame(1, false);
      expect(p.get(a.id)!.work).toBe(0);
      expect(p.get(b.id)!.work).toBe(0);
    }
    p.ingest(view(5, [a, { ...runner, kind: 'warden' }]), tracks); p.frame(1, false);
    expect(p.get(a.id)!.work).toBe(1);
    p.ingest(view(5, [a, b]), tracks); p.frame(1, false);
    expect(p.get(a.id)!.work).toBe(0);
    expect(p.get(b.id)!.work).toBe(0);
  });

  it('uploads Warden opening independently of deployment and preserves its combat heading', () => {
    fadeValue.depths = focusValue.depths = 1;
    const warden: Entity = { ...gate, kind: 'warden', state: 'walled' };
    const units = new Entities(false, undefined, 48), selected = new Set<string>();
    const v = view(5, [warden]);
    units.ingest(v, 1000);
    const track = units.tracks.get(warden.id)!;
    track.heading = track.goal = 0.7;
    units.frame(1000, 1, selected, undefined, 'nw', 'depths', 26);
    units.ingest({ ...v, tick: 1, entities: [warden, runner] }, 1100);
    expect(track.heading).toBe(0.7);
    units.frame(1300, 1.3, selected, undefined, 'nw', 'depths', 26);
    const mesh = units.root.children.find(m => m instanceof Mesh && m.geometry instanceof InstancedBufferGeometry &&
      m.geometry.instanceCount === 1 && m.geometry.getAttribute('position').count === model('warden').getAttribute('position').count) as Mesh;
    const drive = mesh.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
    expect(drive.getY(0)).toBe(1);
    expect(drive.getW(0)).toBe(1);
    units.ingest({ ...v, tick: 2 }, 1400);
    units.frame(1600, 1.6, selected, undefined, 'nw', 'depths', 26);
    expect(drive.getY(0)).toBe(1);
    expect(drive.getW(0)).toBe(0);
  });

  it('uploads the same rig channels for live and remembered poses, retaining hit shudder and sparse idle uploads', () => {
    fadeValue.depths = focusValue.depths = 1;
    const v = view(3), units = new Entities(false, undefined, 48), selected = new Set<string>();
    units.ingest(v, 1000); units.frame(1000, 1, selected, undefined, 'nw', 'depths', 26);
    const mesh = units.root.children.find(m => m instanceof Mesh && m.geometry instanceof InstancedBufferGeometry && m.geometry.instanceCount === 1 && m.geometry.getAttribute('position').count === model('bulkhead').getAttribute('position').count) as Mesh;
    const drive = mesh.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
    const pose = mesh.geometry.getAttribute('unitPose') as InterleavedBufferAttribute;
    expect(pose.getW(0)).toBeCloseTo(Math.PI / 4);
    expect(drive.getW(0)).toBeCloseTo(0.5, 2);
    const version = drive.data.version;
    units.frame(1050, 1.05, selected, undefined, 'nw', 'depths', 26);
    expect(drive.data.version).toBe(version);
    units.ingest({ ...v, tick: 1, entities: [{ ...gate, hp: 90 }, runner] }, 1100);
    expect(units.tracks.get(gate.id)!.hitAt).toBeGreaterThan(0);
    units.frame(1200, 1.2, selected, undefined, 'nw', 'depths', 26);
    expect(drive.getY(0)).toBeGreaterThan(0);
    units.ingest({ ...v, tick: 2, entities: [], memory: [{ id: gate.id, kind: gate.kind, plane: gate.plane, side: 'se', x: gate.x, y: gate.y, seen: 1 }] }, 1250);
    units.frame(1300, 1.3, selected, undefined, 'nw', 'depths', 26);
    const ghost = units.root.getObjectByName('remembered-bulkhead') as Mesh;
    const ghostDrive = ghost.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
    expect(ghostDrive.getY(0)).toBe(0);
    expect(ghostDrive.getW(0)).toBe(0.5);
    expect((ghost.geometry.getAttribute('unitPose') as InterleavedBufferAttribute).getW(0)).toBeCloseTo(Math.PI / 4);
  });
});
