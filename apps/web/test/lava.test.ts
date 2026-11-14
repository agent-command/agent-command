/**
 * Lava in the Depths: a magma cell is a sealed pocket only when the team located it as one (the sim's knowledge, never
 * a distance guess), every other one is live lava, the Mother Lode's ring lava is public; the eruption and its fuse.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Matrix4, type InstancedMesh } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { CELL, type View } from '@agent-command/game/contract';
import { Combat } from '../src/world/combat.ts';
import { DepthsLayer, dormantCells } from '../src/world/depths.ts';
import { applyFade } from '../src/world/fade.ts';
import { Telegraphs } from '../src/world/telegraphs.ts';
import { TerrainField } from '../src/world/terrain.ts';

const at = (tick: number) => tick * 50;
afterEach(() => applyFade(1));

function snapshot(): View {
  const view = createGame({ seed: 7 }).view('nw');
  return { ...view, tick: 100, entities: [], memory: [], fx: [], impacts: [], tremors: [], charges: [], cracks: [], rally: [], oreCaches: [], scorches: [] };
}

describe('live lava or a sealed pocket', () => {
  it('a known magma cell is a dormant pocket only where the team located one, however far from any flood it lies', () => {
    const size = 48;
    const cells = new Array<number>(size * size).fill(CELL.rock);
    const live = [5 * size + 5, 40 * size + 40];
    const sealed = [20 * size + 20, 20 * size + 21];
    for (const c of [...live, ...sealed]) cells[c] = CELL.magma;
    // (30, 30): a pocket remembered from a scan that the team has since seen breached and cooled: nothing to draw
    const out = dormantCells(cells, [{ x: 20, y: 20 }, { x: 21, y: 20 }, { x: 30, y: 30 }], size, new Uint8Array(size * size));
    expect([...live, ...sealed].map((c) => out[c])).toEqual([0, 0, 1, 1]);
    expect(out[30 * size + 30]).toBe(0);
  });

  it('the Depths layer draws every magma cell not located as a pocket as live lava; lava in the Mother Lode ring is public', () => {
    const view = snapshot();
    const size = view.match!.rules.map.size;
    const depths = [...view.depths];
    const lode = depths.indexOf(CELL.lode);
    expect(lode).toBeGreaterThan(0);
    // a ring cell of the lode, a flood cell far from any `magma_cools` origin, a located pocket
    const ring = lode - size;
    const far = 6 * size + 6;
    const pocket = 10 * size + 30;
    for (const c of [ring, far, pocket]) depths[c] = CELL.magma;
    const layer = new DepthsLayer(size);
    layer.update({ depths, pockets: [{ x: pocket % size, y: Math.floor(pocket / size), id: 1 }], schedule: [] }, at, view.match!.rules);
    const lava = [...layer.lavaCells.subarray(0, layer.lavaCount)];
    expect([...lava].sort((a, b) => a - b)).toEqual([ring, far].sort((a, b) => a - b));
    expect(layer.lavaPublic[lava.indexOf(ring)]).toBe(1);
    expect(layer.lavaPublic[lava.indexOf(far)]).toBe(0);
    // Seen breached: the pocket's cell is open tunnel now, the list forgets it, nothing is left of it.
    depths[pocket] = CELL.tunnel;
    layer.update({ depths, pockets: [], schedule: [] }, at, view.match!.rules);
    expect(layer.lavaCount).toBe(2);
  });
});

describe('permanent lava lakes, lava bridges and green rich ore', () => {
  const size = 48;
  const mesh = (layer: DepthsLayer, name: string): InstancedMesh => layer.group.children.find((c) => c.name === name) as InstancedMesh;
  /** Rock all round; a tunnel shore at x 9 with a lake out to x 12 on row 20, and the knowledge grid's index of (x, y). */
  function shore() {
    const depths = new Array<number>(size * size).fill(CELL.rock);
    const at = (x: number, y: number) => y * size + x;
    depths[at(9, 20)] = CELL.tunnel;
    for (const x of [10, 11, 12]) depths[at(x, 20)] = CELL.lake;
    return { depths, at };
  }

  it('a lake is live lava that never cools; a bridge is a deck over the same lava, gone as soon as it falls', () => {
    const { depths, at } = shore();
    depths[at(10, 20)] = depths[at(11, 20)] = CELL.bridge;
    // a north-south bridge elsewhere: its deck turns with its run
    depths[at(30, 29)] = CELL.tunnel;
    depths[at(30, 30)] = CELL.bridge;
    depths[at(30, 31)] = CELL.lake;
    const layer = new DepthsLayer(size);
    // a flood's cooling stamp right on the lake must not crust it toward cooling
    layer.update({ depths, schedule: [{ kind: 'magma_cools', tick: 40, x: 11.5, y: 20.5 }] as View['schedule'] }, (t) => t * 50);
    const lava = [...layer.lavaCells.subarray(0, layer.lavaCount)].sort((a, b) => a - b);
    expect(lava).toEqual([at(10, 20), at(11, 20), at(12, 20), at(30, 30), at(30, 31)].sort((a, b) => a - b));
    // test seam: the lava sheet's per-instance timing (x flood start, y cooling time) is private renderer state
    const timing = (layer as unknown as { lavaT: { array: Float32Array } }).lavaT;
    const lt = timing.array;
    for (let i = 0; i < layer.lavaCount; i++) {
      expect(lt[i * 4 + 1]).toBeGreaterThan(1e6);
      expect(layer.lavaPublic[i]).toBe(0);
    }
    const decks = mesh(layer, 'lava-bridge-decks');
    expect(decks.count).toBe(3);
    const cos = [0, 1, 2].map((i) => { const m = new Matrix4(); decks.getMatrixAt(i, m); return Math.abs(m.elements[0]!); }).sort((a, b) => a - b);
    expect(cos[0]).toBeCloseTo(0);
    expect(cos[2]).toBeCloseTo(1);
    // the outer span falls (combat or a charge): its cell reads lake again and leaves no deck behind
    depths[at(11, 20)] = CELL.lake;
    layer.update({ depths, schedule: [] }, (t) => t * 50);
    expect(decks.count).toBe(2);
    expect(layer.lavaCount).toBe(5);
  });

  it('green rich ore stands as its own emerald crystal cluster, never as teal ore crystals', () => {
    const { depths, at } = shore();
    depths[at(20, 9)] = CELL.rich;
    depths[at(20, 10)] = CELL.rich;
    depths[at(24, 9)] = CELL.ore;
    const layer = new DepthsLayer(size);
    layer.update({ depths, schedule: [] }, (t) => t * 50);
    const rich = mesh(layer, 'rich-ore-crystals');
    const ore = mesh(layer, 'ore-crystals');
    expect(rich.count).toBeGreaterThan(ore.count);
    expect(rich.count % 2).toBe(0);
    // dug out: the cell is tunnel and its crystals go, the ore's stay
    const before = ore.count;
    depths[at(20, 9)] = depths[at(20, 10)] = CELL.tunnel;
    layer.update({ depths, schedule: [] }, (t) => t * 50);
    expect(rich.count).toBe(0);
    expect(ore.count).toBe(before);
  });
});

describe('the Mother Lode erupts', () => {
  it('a lode_vent effect throws a flash, a fountain and a spray of embers and rock, and shakes the camera', () => {
    const view = snapshot();
    const size = view.match!.rules.map.size;
    const combat = new Combat(undefined, size, new TerrainField(size));
    const telegraphs = new Telegraphs(combat, size, new TerrainField(size));
    telegraphs.focus = 'depths';
    telegraphs.ingest({ ...view, fx: [{ tick: 100, kind: 'lode_vent', plane: 'depths', x: size / 2 - 0.5, y: size / 2 - 0.5 }] }, at, 5000);
    expect(combat.sparks.n).toBeGreaterThanOrEqual(60);
    expect(combat.debris.n).toBeGreaterThan(0);
    telegraphs.frame(5100, 'nw');
    expect(combat.shake).toBeGreaterThan(0);
  });

  it('while its fuse burns, one countdown stamp covers each cluster of lode cells we know, as wide as the blast', () => {
    applyFade(1);
    const view = snapshot();
    const rules = view.match!.rules;
    const size = rules.map.size;
    const telegraphs = new Telegraphs(new Combat(undefined, size, new TerrainField(size)), size, new TerrainField(size));
    const stamps = telegraphs.root.children[2] as InstancedMesh;
    telegraphs.ingest(view, at, 5000);
    telegraphs.frame(5000, 'nw');
    expect(stamps.count).toBe(0);
    telegraphs.ingest({ ...view, motherLode: { pressure: 90, rate: 2, state: 'critical', ventAt: 260, x: size / 2 - 0.5, y: size / 2 - 0.5 } }, at, 5000);
    telegraphs.frame(5000, 'nw');
    expect(stamps.count).toBe(1);
    const m = stamps.instanceMatrix.array;
    // the centre 2×2 lode: centred on the map centre, radius = the cluster's half-diagonal + ring + blast reach + half a cell
    expect([m[12], m[14]]).toEqual([0, 0]);
    expect(m[0]).toBeCloseTo(Math.SQRT1_2 + rules.map.motherLode.ringWidth + rules.depths.lodeVentBlastReach + 0.5, 5);
  });
});
