import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, PLANE_Y, SURFACE, withSurfaceElevation } from '@agent-command/game/contract';
import { Matrix4, Mesh, Vector3, type InstancedMesh } from 'three/webgpu';
import { SurfaceLayer, TerrainField } from '../src/world/terrain.ts';

const field = new TerrainField(DEFAULT_RULES.map.size);
const groundAt = field.groundAt;
const setHeights = field.setHeights.bind(field);

function terrain(cells: Record<number, number>): Uint8Array {
  const codes = new Uint8Array(field.size * field.size);
  for (const [c, code] of Object.entries(cells)) codes[Number(c)] = code;
  return codes;
}
const at = (x: number, y: number) => groundAt(x + 0.5, y + 0.5);
/** Height at a point on open ground of the same field (the field has a gentle swell, so compare like with like). */
function flat(x: number, y: number): number {
  setHeights(terrain({}), new Map());
  return groundAt(x, y);
}

describe('surface heightfield (units, effects and decals stand on it)', () => {
  it('raises plateaus, sinks fords to the water line and holes into pits, chasms deepest', () => {
    const base = [flat(10.5, 10.5), flat(5.5, 20.5), flat(30.5, 30.5), flat(40.5, 8.5)];
    const chasm = 30 * field.size + 30;
    const crater = 8 * field.size + 40;
    setHeights(
      terrain({ [10 * field.size + 10]: SURFACE.high, [20 * field.size + 5]: SURFACE.ford, [chasm]: SURFACE.high }),
      new Map([
        [chasm, 'chasm'],
        [crater, 'crater'],
      ]),
    );
    expect(at(10, 10) - base[0]!).toBeGreaterThan(0.6);
    expect(at(5, 20)).toBeLessThan(base[1]!);
    expect(at(5, 20)).toBeGreaterThan(-0.2); // wading at the water line, not on the river bed
    expect(at(30, 30) - base[2]!).toBeLessThan(-2.5);
    expect(at(40, 8) - base[3]!).toBeLessThan(-0.8);
    expect(at(30, 30)).toBeLessThan(at(40, 8));
  });

  it('is continuous across a plateau edge and unchanged a cell away from it', () => {
    const away = flat(9.5, 10.5);
    setHeights(terrain({ [10 * field.size + 10]: SURFACE.high }), new Map());
    expect(Math.abs(groundAt(10.001, 10.5) - groundAt(9.999, 10.5))).toBeLessThan(0.01);
    expect(groundAt(9.5, 10.5)).toBeCloseTo(away, 5);
    expect(groundAt(9.9, 10.5)).toBeGreaterThan(groundAt(9.6, 10.5));
  });

  it('stands crags that wall a plateau above it, lone crags above the ground', () => {
    setHeights(terrain({ [5 * field.size + 5]: SURFACE.high, [5 * field.size + 6]: SURFACE.cliff, [40 * field.size + 40]: SURFACE.cliff }), new Map());
    expect(at(6, 5)).toBeGreaterThan(at(5, 5));
    expect(at(40, 40)).toBeGreaterThan(at(2, 2) + 0.8);
  });

  it('raises lode rock from the level it stands on, plateau tops included', () => {
    const cells: Record<number, number> = {};
    for (let y = 15; y <= 25; y++) for (let x = 15; x <= 25; x++) cells[y * field.size + x] = SURFACE.high;
    const lodes = [{ x: 20, y: 20, rich: false, open: false, loads: 80 }, { x: 10, y: 10, rich: false, open: false, loads: 80 }];
    setHeights(terrain(cells), new Map(), lodes);
    const plateau = at(17, 17), ground = at(6, 6);
    expect(plateau - ground).toBeGreaterThan(0.6);
    // Same mound above its own level, so a plateau lode stands clear of the plateau top.
    expect(at(20, 20) - plateau).toBeGreaterThan(0.3);
    expect(Math.abs((at(20, 20) - plateau) - (at(10, 10) - ground))).toBeLessThan(0.15);
  });

  it.each([SURFACE.forest, SURFACE.fault, SURFACE.ford, SURFACE.water])('retains explicit elevation under feature %i without consulting neighbours', feature => {
    const f = new TerrainField(16);
    const codes = new Uint8Array(16 * 16);
    codes[8 * 16 + 8] = withSurfaceElevation(feature, true);
    codes[4 * 16 + 4] = feature;
    f.setHeights(codes, new Map());
    const bed = feature === SURFACE.ford ? -0.42 : feature === SURFACE.water ? -1.1 : 0;
    expect(f.field.level[8 * 16 + 8]).toBeCloseTo(0.8 + bed);
    expect(f.field.level[4 * 16 + 4]).toBeCloseTo(bed);
    expect(f.field.cls[8 * 16 + 8]).toBe(f.field.cls[4 * 16 + 4]);
    if (feature === SURFACE.ford) expect(f.groundAt(8.5, 8.5)).toBeCloseTo(0.68);
    f.setHeights(codes, new Map([[8 * 16 + 8, 'chasm'], [4 * 16 + 4, 'crater']]));
    expect(f.groundAt(8.5, 8.5)).toBeLessThan(-2.5);
    expect(f.groundAt(4.5, 4.5)).toBeLessThan(-0.8);
  });
});

describe.each([48, 64, 80])('map-sized Surface field (%i)', size => {
  it('owns all cells and samples through the far edge without sharing another field', () => {
    const a = new TerrainField(size), b = new TerrainField(size);
    const codes = new Uint8Array(size * size);
    const i = (size - 2) * size + size - 2;
    codes[i] = SURFACE.high;
    a.setHeights(codes, new Map());
    expect(a.terrainCodes).toHaveLength(size * size);
    expect(a.field.level).toHaveLength(size * size);
    expect(a.field.h).toHaveLength((size * 4 + 1) ** 2);
    expect(a.groundAt(size - 1.5, size - 1.5)).toBeGreaterThan(0.6);
    expect(Number.isFinite(a.groundAt(size, size))).toBe(true);
    expect(b.terrainCodes[i]).toBe(SURFACE.ground);
    expect(b.field.h.every(v => v === 0)).toBe(true);
    expect(a.terrainCodes).not.toBe(b.terrainCodes);
  });

  it('keeps deep water below the ford support line instead of raising a cliff', () => {
    const field = new TerrainField(size);
    const codes = new Uint8Array(size * size);
    const x = size - 3, y = size - 3;
    codes[y * size + x] = SURFACE.water;
    field.setHeights(codes, new Map());
    expect(field.groundAt(x + 0.5, y + 0.5)).toBeLessThan(-0.7);
    expect(field.field.level[y * size + x]).toBeCloseTo(-1.1);
  });
});

describe('surface feature geometry follows authoritative terrain', () => {
  it('seats low/high trees and every crack edge on the field, excluding real openings', async () => {
    const size = 16, layer = new SurfaceLayer(size);
    const codes = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 8; x < size; x++) codes[y * size + x] = SURFACE.high;
    codes[4 * size + 4] = SURFACE.forest;
    codes[4 * size + 11] = SURFACE.highForest;
    const cells = Array.from({ length: 10 }, (_, n) => ({ x: n + 3, y: 8 }));
    for (const c of cells) codes[c.y * size + c.x] = withSurfaceElevation(SURFACE.fault, c.x >= 8);
    layer.setTerrain({ codes, faults: [{ cells }], posts: [] });
    await layer.ready();
    const trees = layer.canopyRoot.children[0] as InstancedMesh;
    expect(trees.count).toBe(6);
    const matrix = new Matrix4(), position = new Vector3();
    for (let i = 0; i < trees.count; i++) {
      trees.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      expect(position.y - PLANE_Y.surface).toBeCloseTo(layer.field.field.heightAt(position.x + size / 2, position.z + size / 2) - 0.02, 5);
    }
    const crack = layer.group.getObjectByName('surface-faults') as Mesh;
    const points = crack.geometry.getAttribute('position');
    let low = 0, high = 0, slope = 0;
    for (let i = 0; i < points.count; i++) {
      const x = points.getX(i) + size / 2, y = points.getZ(i) + size / 2;
      const height = points.getY(i) - PLANE_Y.surface;
      expect(height).toBeCloseTo(layer.field.field.heightAt(x, y) + 0.035, 5);
      if (x < 7) low++;
      else if (x > 9) high++;
      else slope++;
    }
    expect(Math.min(low, high, slope)).toBeGreaterThan(0);
    layer.update([{ x: 8, y: 8, kind: 'chasm' }, { x: 11, y: 4, kind: 'crater' }]);
    await layer.ready();
    expect(trees.count).toBe(3);
    const cut = (layer.group.getObjectByName('surface-faults') as Mesh).geometry.getAttribute('position');
    for (let i = 0; i < cut.count; i++) {
      const x = cut.getX(i) + size / 2, y = cut.getZ(i) + size / 2;
      expect(Math.floor(x) === 8 && Math.floor(y) === 8).toBe(false);
    }
  });

  it('keeps low/high water and ford bodies planar, with no sheet across a removed cell, and moves the coast to it', async () => {
    const size = 16, layer = new SurfaceLayer(size);
    const codes = new Uint8Array(size * size);
    for (const high of [false, true]) {
      const start = high ? 10 : 2;
      for (let y = 3; y < 7; y++) for (let x = start; x < start + 4; x++) {
        codes[y * size + x] = withSurfaceElevation(x === start ? SURFACE.ford : SURFACE.water, high);
      }
    }
    layer.setTerrain({ codes, faults: [], posts: [] });
    await layer.ready();
    const texel = (x: number) => Math.floor(x * layer.shore.res);
    // open water mid-body before the crater: it lies a cell from the bank
    expect(layer.shore.distanceAt(texel(11.5), texel(4.5))).toBeGreaterThan(0.4);
    layer.update([{ x: 11, y: 4, kind: 'crater' }]);
    await layer.ready();
    const points = (layer.group.getObjectByName('surface-water') as Mesh).geometry.getAttribute('position');
    const sheets = new Set<number>();
    for (let i = 0; i < points.count; i += 3) {
      const x = (points.getX(i) + points.getX(i + 1) + points.getX(i + 2)) / 3 + size / 2;
      const y = (points.getZ(i) + points.getZ(i + 1) + points.getZ(i + 2)) / 3 + size / 2;
      // each sheet stays flat at its own water level: the low body's quads reach x ≤ 7, the high body's x ≥ 9
      for (let k = i; k < i + 3; k++) expect(points.getY(k) - PLANE_Y.surface).toBeCloseTo(x < 8 ? -0.16 : 0.64, 5);
      sheets.add(x < 8 ? 0 : 1);
      expect(Math.floor(x) === 11 && Math.floor(y) === 4).toBe(false);
    }
    expect(sheets.size).toBe(2);
    for (const high of [false, true]) expect(layer.field.groundAt(high ? 10.5 : 2.5, 4.5)).toBeCloseTo(high ? 0.68 : -0.12);
    expect(layer.field.groundAt(11.5, 4.5)).toBeLessThan(-0.8);
    // the crater is coast now: dry inside, and the water beside it is foam-close to the new edge
    expect(layer.shore.distanceAt(texel(11.5), texel(4.5))).toBeLessThan(0);
    expect(layer.shore.distanceAt(texel(12.1), texel(4.5))).toBeLessThan(0.2);
    expect(layer.shore.distanceAt(texel(12.1), texel(4.5))).toBeGreaterThan(0);
  });
});
