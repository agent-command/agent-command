import { describe, expect, it } from 'vitest';
import { CELL, ECON, SURFACE } from '../src/rules/contract.ts';
import { FlowFields, LineOfSight, costField, depthsCosts, descend, descendSurface, designationAlternative, designationField, flowField, flowFieldTo, hullLineClear, lineClear, revealDepths, searchDepths, type Barrier } from '../src/nav/nav.ts';

import { rotCell, rotX, rotY } from '../src/util/teams.ts';
const sizes = [80, 48, 64] as const;
const costs = depthsCosts(ECON);

function depths(size: number) {
  const n = size * size;
  const cells = new Uint8Array(n).fill(CELL.bedrock);
  const start = (size - 2) * size + size - 7;
  const goal = (size - 5) * size + size - 2;
  const path: number[] = [];
  for (let x = size - 7; x <= size - 2; x++) cells[(size - 2) * size + x] = CELL.tunnel;
  for (let y = size - 5; y <= size - 2; y++) cells[y * size + size - 2] = CELL.tunnel;
  for (let x = size - 6; x <= size - 2; x++) path.push((size - 2) * size + x);
  for (let y = size - 3; y >= size - 5; y--) path.push(y * size + size - 2);
  cells[goal] = CELL.rock;
  const tags = new Uint8Array(n);
  tags[goal] = 2;
  const bar: Barrier = { gate: new Uint8Array(n), mask: 1, keep: null };
  return { size, n, cells, start, goal, path, tags, bar };
}

function surface(size: number) {
  const n = size * size;
  const blocked = new Uint8Array(n);
  const cost = new Float32Array(n).fill(1);
  // An asymmetric obstacle and non-uniform costs exercise diagonal tie ordering and corner rules.
  for (let y = size - 10; y < size - 3; y++) blocked[y * size + size - 6] = 1;
  for (let x = size - 10; x < size - 5; x++) cost[(size - 5) * size + x] = 2;
  const start = (size - 8) * size + size - 10;
  const goal = (size - 3) * size + size - 3;
  return { size, n, blocked, cost, start, goal, flows: new FlowFields(blocked, cost, 4, size) };
}

describe('per-operation navigation geometry', () => {
  it('interleaves depths searches, fields and floods without changing retained maps', () => {
    const maps = sizes.map(depths);
    const fields = maps.map((m) => new Float64Array(m.n));
    for (const index of [0, 1, 2, 0, 2, 1]) {
      const m = maps[index]!;
      const field = fields[index]!;
      const { size, cells, start, goal, path, tags, bar } = m;
      expect(searchDepths(cells, start, (c) => c === goal, costs.dig, false, Infinity, 0, null, bar, size)).toEqual(path);
      costField(cells, tags, 2, costs.dig, field, 0, null, bar, size);
      expect(descend(cells, field, tags, 2, start, costs.dig, 0, null, bar, size)).toEqual(path);
      const mirroredCells = cells.slice().reverse();
      const mirroredTags = tags.slice().reverse();
      const mirroredField = new Float64Array(m.n);
      const mirror = (c: number) => m.n - 1 - c;
      expect(searchDepths(mirroredCells, mirror(start), (c) => c === mirror(goal), costs.dig, false, Infinity, 2, null, bar, size)).toEqual(path.map(mirror));
      costField(mirroredCells, mirroredTags, 2, costs.dig, mirroredField, 2, null, bar, size);
      expect(mirroredField).toEqual(field.slice().reverse());
      expect(descend(mirroredCells, mirroredField, mirroredTags, 2, mirror(start), costs.dig, 2, null, bar, size)).toEqual(path.map(mirror));
      const visible = new Uint8Array(m.n);
      const mirroredVisible = new Uint8Array(m.n);
      revealDepths(cells, start, 5, visible, null, 0, size, 1);
      revealDepths(mirroredCells, mirror(start), 5, mirroredVisible, null, 0, size, 1);
      expect(visible[start]).toBe(1);
      expect(visible[0]).toBe(0);
      expect(mirroredVisible).toEqual(visible.slice().reverse());
      const gated = new Uint8Array(m.n);
      gated[path[0]!] = 1;
      const stopped = new Uint8Array(m.n);
      revealDepths(cells, start, 5, stopped, gated, 1, size, 1);
      expect(stopped[path[2]!]).toBe(0);
    }
  });

  it('mirrors four-neighbour tie breaks at every size', () => {
    for (const size of sizes) {
      const n = size * size;
      const cells = new Uint8Array(n).fill(CELL.tunnel);
      const start = (size - 6) * size + size - 6;
      const goal = (size - 3) * size + size - 3;
      const mirror = (c: number) => n - 1 - c;
      const path = searchDepths(cells, start, (c) => c === goal, costs.walk, false, Infinity, 0, null, null, size);
      expect(path).not.toBeNull();
      expect(searchDepths(cells, mirror(start), (c) => c === mirror(goal), costs.walk, false, Infinity, 2, null, null, size)).toEqual(path!.map(mirror));
      const tags = new Uint8Array(n);
      tags[goal] = 1;
      const field = new Float64Array(n);
      costField(cells, tags, 1, costs.walk, field, 0, null, null, size);
      const downhill = descend(cells, field, tags, 1, start, costs.walk, 0, null, null, size);
      expect(downhill).not.toBeNull();
      const mirroredTags = tags.slice().reverse();
      const mirroredField = new Float64Array(n);
      costField(cells, mirroredTags, 1, costs.walk, mirroredField, 2, null, null, size);
      expect(descend(cells, mirroredField, mirroredTags, 1, mirror(start), costs.walk, 2, null, null, size)).toEqual(downhill!.map(mirror));
    }
  });

  it('keeps designation ownership and alternative paths bounded to the active map', () => {
    const maps = sizes.map(depths);
    const out = new Float64Array(80 * 80).fill(-7);
    const owner = new Int32Array(80 * 80).fill(-7);
    const next = new Int32Array(80 * 80).fill(-7);
    const via = new Int32Array(80 * 80).fill(-7);
    for (const index of [1, 2, 0, 1]) {
      const m = maps[index]!;
      out.fill(-7);
      owner.fill(-7);
      next.fill(-7);
      via.fill(-7);
      designationField(m.cells, m.tags, costs.dig, out, owner, next, via, 0, m.bar, undefined, Infinity, 1, m.size);
      expect(owner[m.start]).toBe(m.goal);
      expect(via[m.goal]).toBe(m.goal);
      expect(next[m.start]).toBe(m.path[0]);
      expect(designationAlternative(m.cells, m.tags, costs.dig, m.start, 0, m.bar, new Uint8Array(m.n), 1, 1, -1, -1, m.size)).toEqual(m.path);
      if (m.n < out.length) {
        expect(out[m.n]).toBe(-7);
        expect(owner[m.n]).toBe(-7);
        expect(next[m.n]).toBe(-7);
        expect(via[m.n]).toBe(-7);
      }
      const reserved = new Uint8Array(m.n);
      reserved[m.goal] = 1;
      expect(designationAlternative(m.cells, m.tags, costs.dig, m.start, 0, m.bar, reserved, 1, 1, m.goal, -1, m.size)).toEqual(m.path);
    }
  });

  it('retains independent surface caches and exactly mirrored eight-neighbour descents', () => {
    const maps = sizes.map(surface);
    const retained = maps.map((m) => m.flows.get(m.goal, 0, 0, 0));
    const snapshots = retained.map((f) => f.slice());
    for (const index of [2, 1, 0, 1, 2, 0]) {
      const m = maps[index]!;
      const field = m.flows.get(m.goal, 0, 0, 1);
      expect(field).toBe(retained[index]);
      expect(field).toEqual(snapshots[index]);
      expect(field.length).toBe(m.n);
      const mirroredBlocked = m.blocked.slice().reverse();
      const mirroredCost = m.cost.slice().reverse();
      const mirror = (c: number) => m.n - 1 - c;
      const mirrored = new Float64Array(m.n);
      flowField(mirroredBlocked, mirroredCost, mirror(m.goal), mirrored, 2, m.size);
      expect(mirrored).toEqual(field.slice().reverse());
      let c = m.start;
      let steps = 0;
      while (c !== m.goal && steps < m.n) {
        const next = descendSurface(m.blocked, m.cost, field, c, 0, m.size);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(descendSurface(mirroredBlocked, mirroredCost, mirrored, mirror(c), 2, m.size)).toBe(mirror(next));
        expect(field[next]!).toBeLessThan(field[c]!);
        c = next;
        steps++;
      }
      expect(c).toBe(m.goal);
      const goals = [m.goal, m.goal - 1];
      const setField = m.flows.getSet(0, 0, 1, 2, () => goals);
      const direct = new Float64Array(m.n);
      flowFieldTo(m.blocked, m.cost, goals, direct, 0, m.size);
      expect(setField).toEqual(direct);
    }
    for (const m of maps) {
      m.blocked[m.goal - m.size] = 1;
      const direct = new Float64Array(m.n);
      flowField(m.blocked, m.cost, m.goal, direct, 0, m.size);
      expect(m.flows.get(m.goal, 0, 1, 3)).toEqual(direct);
    }
  });

  it('never treats adjacent rows as neighbouring depths or surface cells', () => {
    for (const size of sizes) {
      const n = size * size;
      const start = size - 1, goal = size;
      const cells = new Uint8Array(n).fill(CELL.bedrock);
      cells[start] = cells[goal] = CELL.tunnel;
      expect(searchDepths(cells, start, (c) => c === goal, costs.walk, false, Infinity, 0, null, null, size)).toBeNull();
      const blocked = new Uint8Array(n).fill(1);
      blocked[start] = blocked[goal] = 0;
      const cost = new Float32Array(n).fill(1);
      const field = new Float64Array(n);
      flowField(blocked, cost, goal, field, 0, size);
      expect(field[start]).toBe(Infinity);
      expect(descendSurface(blocked, cost, field, start, 0, size)).toBe(-1);
      // A diagonal alone cannot cut between two blocked cardinal neighbours.
      const diagonal = start + size - 1;
      blocked[diagonal] = 0;
      flowField(blocked, cost, diagonal, field, 0, size);
      expect(field[start]).toBe(Infinity);
    }
  });

  it('keeps LOS masks, long traces, row stamps and smoothed lines independent across sizes', () => {
    const maps = sizes.map((size) => {
      const n = size * size;
      const opaque = new Uint8Array(n);
      const y = size - 3;
      const from = y * size + size - 10;
      const wall = from + 3;
      opaque[wall] = 1;
      // Also exercise the integer border rule at a diagonal crossing.
      const diagonalFrom = (size - 9) * size + size - 9;
      opaque[diagonalFrom + 1] = 1;
      return { size, n, opaque, from, wall, diagonalFrom, los: new LineOfSight(opaque, size) };
    });
    for (const index of [0, 2, 1, 0, 1, 2]) {
      const m = maps[index]!;
      const { size, n, from, wall, los } = m;
      expect(los.visible(from, wall)).toBe(true); // Endpoints do not occlude themselves.
      expect(los.visible(from, from + 6)).toBe(false);
      expect(los.visible(from + 6, from)).toBe(false);
      expect(los.visible(from, from - 15)).toBe(true); // Outside the cached window.
      expect(los.visible(from - 15, from + 6)).toBe(false);
      expect(los.visible(m.diagonalFrom, m.diagonalFrom + size + 1)).toBe(false);
      const terrain = new Uint8Array(n);
      terrain[from + 1] = SURFACE.high;
      const visible = new Uint8Array(n);
      los.stamp(visible, terrain, from, from, from + 6, 1);
      expect(Array.from(visible.slice(from, from + 7))).toEqual([1, 0, 1, 1, 0, 0, 0]);
      const x = from % size + 0.5, y = Math.floor(from / size) + 0.5;
      expect(lineClear(m.opaque, x, y, x + 6, y, 0, size)).toBe(false);
      expect(lineClear(m.opaque, x, y, x + 2, y, 0, size)).toBe(true);
      const mirrored = m.opaque.slice().reverse();
      expect(lineClear(mirrored, size - x, size - y, size - x - 6, size - y, 2, size)).toBe(false);
      expect(lineClear(mirrored, size - x, size - y, size - x - 2, size - y, 2, size)).toBe(true);
      const mirroredLos = new LineOfSight(mirrored, size);
      expect(mirroredLos.visible(n - 1 - from, n - 1 - (from + 6))).toBe(false);
    }
  });

  it('uses explicit size 48 consistently in direct fields and cached fields', () => {
    const m = surface(48);
    const field = new Float64Array(m.n);
    flowField(m.blocked, m.cost, m.goal, field, 0, 48);
    expect(new FlowFields(m.blocked, m.cost, 64, 48).get(m.goal, 0, 0, 0)).toEqual(field);
    const from = (48 - 8) * 48 + 48 - 8;
    const los = new LineOfSight(m.blocked, 48);
    expect(los.visible(from, from + 1)).toBe(true);
    expect(los.visible(from, from + 4)).toBe(false);
  });

  it('sees past no cliff its sightline enters, however short the clip, exactly mirrored under every quarter turn', () => {
    const size = 16;
    const n = size * size;
    /** Oracle: the centre-to-centre segment has positive length inside an opaque cell, or runs through one's corner. */
    const blocked = (opaque: Uint8Array, from: number, to: number): boolean => {
      const ax = (from % size) + 0.5, ay = Math.floor(from / size) + 0.5, bx = (to % size) + 0.5, by = Math.floor(to / size) + 0.5;
      for (let cy = Math.floor(Math.min(ay, by)); cy <= Math.floor(Math.max(ay, by)); cy++) for (let cx = Math.floor(Math.min(ax, bx)); cx <= Math.floor(Math.max(ax, bx)); cx++) {
        const c = cy * size + cx;
        if (!opaque[c] || c === from || c === to) continue;
        let t0 = 0, t1 = 1;
        for (const [p, q] of [[ax - bx, ax - cx], [bx - ax, cx + 1 - ax], [ay - by, ay - cy], [by - ay, cy + 1 - ay]] as const) {
          if (p === 0) { if (q <= 0) t1 = -1; continue; }
          if (p < 0) t0 = Math.max(t0, q / p); else t1 = Math.min(t1, q / p);
        }
        if (t1 > t0) return true;
        for (const [vx, vy] of [[cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1]] as const) {
          const along = (vx - ax) * (bx - ax) + (vy - ay) * (by - ay);
          if ((vx - ax) * (by - ay) === (vy - ay) * (bx - ax) && along > 0 && along < (bx - ax) ** 2 + (by - ay) ** 2) return true;
        }
      }
      return false;
    };
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let trial = 0; trial < 3; trial++) {
      const opaque = new Uint8Array(n);
      for (let c = 0; c < n; c++) opaque[c] = random() < 0.2 ? 1 : 0;
      // A diagonal cliff line: its joints are where sampling along the segment used to see through.
      for (let i = 2; i < 12; i++) opaque[i * size + i + 2] = 1;
      const los = new LineOfSight(opaque, size);
      const turned = new Uint8Array(n);
      for (let c = 0; c < n; c++) turned[rotCell(1, c, size)] = opaque[c]!;
      const turnedLos = new LineOfSight(turned, size);
      for (let from = 0; from < n; from++) for (let to = 0; to < n; to++) {
        const seen = los.visible(from, to);
        expect(seen, `${from} → ${to}`).toBe(!blocked(opaque, from, to));
        expect(turnedLos.visible(rotCell(1, from, size), rotCell(1, to, size))).toBe(seen);
      }
    }
  });

  it('Depths sight never passes a corner pinched shut by rock or a hostile gate', () => {
    const size = 16;
    const n = size * size;
    const at = (x: number, y: number) => y * size + x;
    for (const pinch of ['rock', 'gate'] as const) {
      const cells = new Uint8Array(n).fill(CELL.rock);
      for (const c of [at(4, 8), at(5, 8), at(6, 8), at(7, 9)]) cells[c] = CELL.tunnel;
      const gate = new Uint8Array(n);
      if (pinch === 'gate') {
        cells[at(7, 8)] = CELL.tunnel;
        gate[at(7, 8)] = 1;
      }
      const seen = new Uint8Array(n);
      revealDepths(cells, at(4, 8), 6, seen, gate, 1, size, 1);
      expect(seen[at(7, 9)], `${pinch}: the pocket past the corner`).toBe(0);
      expect(seen[at(7, 7)], `${pinch}: the rock corner itself is wall you see`).toBe(1);
      const mirrored = new Uint8Array(n);
      revealDepths(cells.slice().reverse(), n - 1 - at(4, 8), 6, mirrored, gate.slice().reverse(), 1, size, 1);
      expect(mirrored).toEqual(seen.slice().reverse());
      cells[at(7, 8)] = CELL.tunnel;
      const open = new Uint8Array(n);
      revealDepths(cells, at(4, 8), 6, open, null, 1, size, 1);
      expect(open[at(7, 9)], `${pinch} opened: the pocket`).toBe(1);
    }
  });
});

describe('hull-safe surface routing', () => {
  it('rejects swept diagonal corners and preserves exact disc tangency', () => {
    const size = 16;
    const blocked = new Uint8Array(size * size);
    blocked[6 * size + 6] = 1;
    expect(hullLineClear(blocked, 5.5, 6.5, 5.5, 6.5, 0.4, 0, size)).toBe(true);
    expect(hullLineClear(blocked, 6.5, 5.5, 6.5, 5.5, 0.4, 0, size)).toBe(true);
    expect(hullLineClear(blocked, 5.5, 6.5, 6.5, 5.5, 0.4, 0, size)).toBe(false);
    expect(hullLineClear(blocked, 5.5, 4, 5.5, 9, 0.5, 0, size)).toBe(true);
    expect(hullLineClear(blocked, 5.5, 4, 5.5, 9, 0.6, 0, size)).toBe(false);
    const flows = new FlowFields(blocked, new Float32Array(size * size).fill(1), 4, size);
    const from = 6 * size + 5, goal = 5 * size + 6;
    const field = flows.get(goal, 0, 0, 0, 0.4);
    expect(flows.descend(field, from, 0, 0, 0, 0.4)).not.toBe(goal);
  });

  it('decides an exact tangency alike for rotated twins: a 3-4-5 sweep past a cell corner (C4)', () => {
    const size = 48;
    const blocked = new Uint8Array(size * size);
    // Corner (15, 11) of cell (15, 11) lies exactly 0.5 from the sweeps below: offset (−2.5, 2.5) · unit normal
    // (0.6, 0.8). Swept in world coordinates, rounding made it a hit for some quarter turns only (a C4 flak lookahead).
    for (let k = 0; k < 4; k++) blocked[rotCell(k, 11 * size + 15, size)] = 1;
    for (const [x0, y0, x1, y1] of [[17.5, 8.5, 9.5, 14.5], [17.5, 8.5, 13.5, 11.5], [9.5, 14.5, 17.5, 8.5]] as const) {
      for (let k = 0; k < 4; k++) {
        expect(hullLineClear(blocked, rotX(k, x0, y0, size), rotY(k, x0, y0, size), rotX(k, x1, y1, size), rotY(k, x1, y1, size), 0.5, k, size, true), `frame ${k}`).toBe(true);
      }
    }
  });

  it('shares radius fields, keeps small hulls in a one-tile passage, and invalidates both radii', () => {
    const size = 16, n = size * size;
    const blocked = new Uint8Array(n);
    for (let y = 0; y < size; y++) if (y !== 8) blocked[y * size + 8] = 1;
    const flows = new FlowFields(blocked, new Float32Array(n).fill(1), 4, size);
    const start = 8 * size + 4, goal = 8 * size + 12;
    const small = flows.get(goal, 0, 0, 0, 0.4);
    const large = flows.get(goal, 0, 0, 0, 0.6);
    expect(small[start]).toBe(8);
    expect(large[start]).toBe(Infinity);
    expect(flows.get(goal, 0, 0, 1, 0.4)).toBe(small);
    expect(flows.get(goal, 0, 0, 1, 0.6)).toBe(large);
    // Fractional radii and frames are separate keys, not an arithmetic radius*4+frame packing.
    expect(flows.get(goal, 1, 0, 1, 0.35)[start]).toBeLessThan(Infinity);
    expect(flows.get(goal, 0, 0, 1, 0.6)).toBe(large);
    blocked[8 * size + 8] = 1;
    expect(flows.get(goal, 0, 1, 2, 0.4)[start]).toBe(Infinity);
    expect(flows.descend(small, start, 0, 1, 2, 0.4)).toBe(-1);
    blocked[8 * size + 8] = blocked[9 * size + 8] = 0;
    expect(flows.get(goal, 0, 2, 3, 0.4)[start]).toBeLessThan(Infinity);
    expect(flows.get(goal, 0, 2, 3, 0.6)[start]).toBeLessThan(Infinity);
    // A blocked goal is not a route seed for a hull, including multi-goal firing fields.
    expect(flows.get(7 * size + 8, 0, 2, 3, 0.6)[start]).toBe(Infinity);
    expect(flows.getSet(1, 0, 2, 3, () => [7 * size + 8], 0.6)[start]).toBe(Infinity);
  });

  it('prices shifted representatives by physical distance and descends coincident points without cycles (C4)', () => {
    const size = 16, n = size * size;
    let path: number[] = [];
    for (let frame = 0; frame < 4; frame++) {
      const blocked = new Uint8Array(n).fill(1);
      for (let y = 3; y <= 12; y++) for (let x = 8; x <= 9; x++) blocked[rotCell(frame, y * size + x, size)] = 0;
      const flows = new FlowFields(blocked, new Float32Array(n).fill(1), 4, size);
      const goal = rotCell(frame, 10 * size + 8, size);
      const a = rotCell(frame, 6 * size + 8, size), b = rotCell(frame, 6 * size + 9, size);
      const field = flows.get(goal, frame, 0, 0, 0.6);
      const geometry = flows.geometry(0.6, frame, 0, 0);
      expect([geometry.x[a], geometry.y[a]]).toEqual([geometry.x[b], geometry.y[b]]);
      // The two graph nodes are one physical spot, four tiles from the goal, not two different potentials.
      expect(field[a]).toBe(4);
      expect(field[b]).toBe(field[a]);
      const actual: number[] = [];
      let c = b;
      while (c !== goal && actual.length < n) {
        expect(actual).not.toContain(c);
        actual.push(c);
        const next = flows.descend(field, c, frame, 0, 0, 0.6);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(field[next]).toBeLessThanOrEqual(field[c]!);
        expect(hullLineClear(blocked, geometry.x[c]!, geometry.y[c]!, geometry.x[next]!, geometry.y[next]!, 0.6, frame, size)).toBe(true);
        c = next;
      }
      expect(c).toBe(goal);
      if (frame === 0) path = actual;
      else expect(actual).toEqual(path.map((cell) => rotCell(frame, cell, size)));
    }
  });

  it('clones cached successor aliases and replaces them across bounded cache eviction', () => {
    const size = 16, n = size * size;
    const blocked = new Uint8Array(n);
    const flows = new FlowFields(blocked, new Float32Array(n).fill(1), 1, size);
    const from = 6 * size + 6, goal = 10 * size + 10;
    const original = flows.get(goal, 0, 0, 0, 0.6);
    const copy: FlowFields = Object.setPrototypeOf(structuredClone(flows), FlowFields.prototype);
    const retained = copy.get(goal, 0, 0, 1, 0.6);
    expect(retained).not.toBe(original);
    expect(copy.descend(retained, from, 0, 0, 1, 0.6)).toBe(flows.descend(original, from, 0, 0, 1, 0.6));
    // Evict a field within a topology, then the topology itself (radius/frame); no stale successor survives.
    copy.get(from, 0, 0, 2, 0.6);
    copy.get(goal, 1, 0, 3, 0.4);
    const rebuilt = copy.get(goal, 0, 0, 4, 0.6);
    expect(rebuilt).not.toBe(retained);
    expect(rebuilt).toEqual(original);
    expect(copy.descend(rebuilt, from, 0, 0, 4, 0.6)).toBe(flows.descend(original, from, 0, 0, 1, 0.6));
  });

  it('connects boundary positions without deepening existing overlaps and rotates the chosen path exactly', () => {
    const size = 24, n = size * size;
    const base = new Uint8Array(n);
    for (let y = 3; y < 6; y++) for (let x = 9; x < 12; x++) base[y * size + x] = 1;
    for (let y = 6; y < 8; y++) for (let x = 6; x < 8; x++) base[y * size + x] = 1;
    let path: number[] = [];
    for (let frame = 0; frame < 4; frame++) {
      const blocked = new Uint8Array(n);
      for (let c = 0; c < n; c++) blocked[rotCell(frame, c, size)] = base[c]!;
      const flows = new FlowFields(blocked, new Float32Array(n).fill(1), 4, size);
      const goal = rotCell(frame, 18 * size + 7, size);
      const field = flows.get(goal, frame, 0, 0, 0.6);
      const geometry = flows.geometry(0.6, frame, 0, 0);
      const x = rotX(frame, 8.4, 5.5527867191, size), y = rotY(frame, 8.4, 5.5527867191, size);
      let c = flows.anchor(x, y, frame, 0, 0, 0.6, field, true);
      expect(c).toBeGreaterThanOrEqual(0);
      const actual: number[] = [];
      for (let step = 0; step < n && c !== goal; step++) {
        actual.push(c);
        const next = flows.descend(field, c, frame, 0, 0, 0.6);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(hullLineClear(blocked, geometry.x[c]!, geometry.y[c]!, geometry.x[next]!, geometry.y[next]!, 0.6, frame, size)).toBe(true);
        c = next;
      }
      expect(c).toBe(goal);
      if (frame === 0) path = actual;
      else expect(actual).toEqual(path.map((cell) => rotCell(frame, cell, size)));
    }
    expect(hullLineClear(base, 8.4000001885, 5.5527867191, 7.5, 4.5, 0.6, 0, size, true)).toBe(true);
    expect(hullLineClear(base, 8.4000001885, 5.5527867191, 8.5, 8.5, 0.6, 0, size, true)).toBe(false);
    const flows = new FlowFields(base, new Float32Array(n).fill(1), 4, size);
    // The exact goal is legal even though its floored cell centre is too close to the Headframe.
    expect(flows.anchor(8.3, 4.5, 0, 0, 0, 0.6)).toBeGreaterThanOrEqual(0);
    expect(flows.anchor(8.5, 4.5, 0, 0, 0, 0.6)).toBe(-1);
  });
});
