import { describe, expect, it } from 'vitest';
import { AdditiveBlending, NormalBlending, InstancedMesh, Mesh, PerspectiveCamera } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { CELL, SURFACE, type Entity, type View } from '@agent-command/game/contract';
import { configureLens, createLens, type Lens } from '../src/tools/lens.ts';
import {
  DEPTHS_LEVEL, HOLO_FRIENDLY, HOLO_GHOST, HOLO_HOVER, HOLO_ORE, HOLO_THREAT, HoloLens, SHAPE_ISLAND, SHAPE_STRUCTURE, SHAPE_UNIT, SURFACE_LEVEL,
  fillGlyphs, fillTint, glyphBuffers, holoFalloff, type GlyphBuffers, type HoloFocus,
} from '../src/world/holo.ts';
import type { Track } from '../src/world/entities.ts';
import { AIM_Y } from '../src/world/common.ts';
import { Overlay } from '../src/overlay.ts';
import type { World } from '../src/world/world.ts';

const ent = (id: string, kind: Entity['kind'], side: Entity['side'], plane: Entity['plane'], x: number, y: number, extra: Partial<Entity> = {}): Entity =>
  ({ id, kind, side, plane, x, y, state: 'idle', hp: 50, maxHp: 100, ...extra }) as Entity;
function view(entities: Entity[], memory: View['memory'] = []): View {
  return { ...createGame({ seed: 3 }).view('nw'), entities, memory };
}
const focus = (x = 20, y = 20, radius = 6): HoloFocus => ({ x, y, radius, x2: x, y2: y, two: false });
const none = () => 0;
const glyph = (b: GlyphBuffers, i: number) => ({
  x: b.a[i * 4]!, z: b.a[i * 4 + 1]!, hw: b.a[i * 4 + 2]!, hd: b.a[i * 4 + 3]!, hp: b.b[i * 4 + 3]!, shape: b.c[i * 4]!, flags: b.c[i * 4 + 1]!,
});

describe('holo falloff', () => {
  it('is full at the focus, eases out with no rim and is gone at the reach', () => {
    expect(holoFalloff(0, 6)).toBe(1);
    let last = 1;
    for (let d = 0.5; d <= 6; d += 0.5) {
      const k = holoFalloff(d, 6);
      expect(k).toBeLessThan(last);
      last = k;
    }
    expect(holoFalloff(6, 6)).toBe(0);
    expect(holoFalloff(5.9, 6)).toBeLessThan(0.01);
    expect(holoFalloff(1, 0)).toBe(0);
  });
});

describe('holo silhouettes are the team view only', () => {
  it('draws listed entities of the layer plane inside the region: units, structures by footprint, islands as decks', () => {
    const v = view([
      ent('t', 'tank', 'se', 'surface', 21, 20), ent('s', 'turret', 'se', 'surface', 19, 21), ent('far', 'tank', 'se', 'surface', 40, 40),
      ent('i', 'island', 'nw', 'sky', 20, 22), ent('b', 'interceptor', 'se', 'sky', 20, 19),
      ent('hangared', 'tank', 'nw', 'surface', 20, 20, { state: 'hangared' }),
      ent('launching', 'tank', 'nw', 'surface', 20, 20, { state: 'launching' }),
      ent('falling', 'tank', 'nw', 'surface', 20, 20, { state: 'falling' }),
    ]);
    const out = glyphBuffers();
    fillGlyphs(out, v, new Map(), 'surface', focus(), 48, 2.5, none);
    expect(out.count).toBe(2);
    expect(glyph(out, 0)).toMatchObject({ x: 21 - 24, z: 20 - 24, shape: SHAPE_UNIT, hp: 0.5 });
    expect(glyph(out, 1)).toMatchObject({ shape: SHAPE_STRUCTURE, hw: 0.5, hd: 0.5 });
    fillGlyphs(out, v, new Map(), 'sky', focus(), 48, 2.5, none);
    expect(out.count).toBe(2);
    expect(glyph(out, 0)).toMatchObject({ shape: SHAPE_ISLAND, hw: 2.5, hp: -1 });
  });

  it('marks ore islands in the same Lens glyph and displays a reserve arc only while that value is disclosed', () => {
    const island = ent('e_1', 'island', 'neutral', 'sky', 20, 20, { oreCapacity: 240, oreRemaining: 60, elevation: -8 });
    const v = view([island]), out = glyphBuffers();
    v.islands = [{ id: island.id, cx: 24, cy: 24, r: 10, phase: 0, speed: 0.01, oreCapacity: 240 }];
    fillGlyphs(out, v, new Map(), 'sky', focus(), 48, 2.5, none);
    expect(out.count).toBe(1);
    expect(glyph(out, 0)).toMatchObject({ shape: SHAPE_ISLAND, hp: 0.25, flags: HOLO_ORE });
    expect(glyph(out, 0).flags & HOLO_HOVER).toBe(0);
    expect(out.c[3]).toBeLessThan(0);
    delete island.oreRemaining;
    fillGlyphs(out, v, new Map(), 'sky', focus(), 48, 2.5, () => HOLO_HOVER);
    expect(glyph(out, 0)).toMatchObject({ hp: -1, flags: HOLO_ORE | HOLO_HOVER });
    island.oreRemaining = 0;
    fillGlyphs(out, v, new Map(), 'sky', focus(), 48, 2.5, none);
    expect(glyph(out, 0)).toMatchObject({ hp: 0, flags: HOLO_ORE });
    fillGlyphs(out, v, new Map(), 'surface', focus(), 48, 2.5, none);
    expect(out.count).toBe(0);
    v.entities = [];
    fillGlyphs(out, v, new Map(), 'sky', focus(), 48, 2.5, none);
    expect(out.count).toBe(0);
  });

  it('follows interpolated tracks, shows last-seen structures as ghosts, and never a remembered one still in sight', () => {
    const tank = ent('t', 'tank', 'se', 'surface', 21, 20);
    const v = view([tank], [
      { id: 'old', kind: 'headframe', side: 'se', plane: 'surface', x: 22, y: 22, seen: 10 },
      { id: 't', kind: 'tank', side: 'se', plane: 'surface', x: 21, y: 20, seen: 10 },
      { id: 'live', kind: 'turret', side: 'se', plane: 'surface', x: 19, y: 19, seen: 10 },
    ]);
    const tracks = new Map<string, Track>([['t', { e: tank, rx: 21.5, ry: 20.25, visible: true } as Track], ['live', { visible: true } as Track]]);
    const out = glyphBuffers();
    fillGlyphs(out, v, tracks, 'surface', focus(), 48, 2.5, none);
    expect(out.count).toBe(2);
    expect(glyph(out, 0)).toMatchObject({ x: 21.5 - 24, z: 20.25 - 24 });
    expect(glyph(out, 1).flags & HOLO_GHOST).toBe(HOLO_GHOST);
    expect(glyph(out, 1).shape).toBe(SHAPE_STRUCTURE);
  });

  it('carries threat and friendly-fire flags and caps the instance buffer', () => {
    const v = view(Array.from({ length: 10 }, (_, i) => ent(`u${i}`, 'trooper', i % 2 ? 'nw' : 'se', 'surface', 20 + i * 0.1, 20)));
    const out = glyphBuffers(4);
    fillGlyphs(out, v, new Map(), 'surface', focus(), 48, 2.5, (id) => (id === 'u0' ? HOLO_THREAT : id === 'u1' ? HOLO_FRIENDLY : 0));
    expect(out.count).toBe(4);
    expect(glyph(out, 0).flags).toBe(HOLO_THREAT);
    expect(glyph(out, 1).flags).toBe(HOLO_FRIENDLY);
  });

  it('includes the second focus (an aimed rock) in the region', () => {
    const v = view([ent('t', 'tank', 'se', 'surface', 35, 35)]);
    const out = glyphBuffers();
    fillGlyphs(out, v, new Map(), 'surface', focus(), 48, 2.5, none);
    expect(out.count).toBe(0);
    fillGlyphs(out, v, new Map(), 'surface', { ...focus(), two: true, x2: 34, y2: 34 }, 48, 2.5, none);
    expect(out.count).toBe(1);
  });
});

describe('holo terrain tints', () => {
  it('encodes level, edge code, canopy and unknown cells per plane', () => {
    const out = new Uint8Array(4 * 4);
    fillTint(out, [SURFACE.water, SURFACE.cliff, SURFACE.forest, SURFACE.ground], SURFACE_LEVEL, 'surface');
    expect(out[0]).toBeLessThan(out[4]!);
    expect(out[1]).not.toBe(out[5]);
    expect(out[8 + 2]).toBe(255);
    expect(out[3]).toBe(0);
    fillTint(out, [CELL.unknown, CELL.tunnel, CELL.rock, CELL.ore], DEPTHS_LEVEL, 'depths');
    expect(out[3]).toBe(255);
    expect(out[4 + 3]).toBe(0);
    expect(out[4]).toBeGreaterThan(out[8]!);
  });

  it('retains canopy and feature identity at high elevation instead of using a missing-code tint', () => {
    const codes = [SURFACE.highForest, SURFACE.highFord, SURFACE.highFault, SURFACE.highWater];
    const out = new Uint8Array(codes.length * 4);
    fillTint(out, codes, SURFACE_LEVEL, 'surface');
    expect(out[2]).toBe(255);
    for (let i = 0; i < codes.length; i++) {
      expect(out[i * 4]).toBe(Math.round(SURFACE_LEVEL[codes[i]!]! * 255));
      expect(out[i * 4 + 1]).toBe((codes[i]! * 23) & 255);
      expect(out[i * 4 + 3]).toBe(0);
    }
  });
});

describe('holo lens layers', () => {
  function shown(lens: Lens, focusPlane: Lens['source'], v = view([])) {
    const holo = new HoloLens(48);
    holo.show(lens);
    holo.frame(v, new Map(), focusPlane, 0, 1000);
    for (const t of [1100, 1200, 1300]) holo.frame(v, new Map(), focusPlane, 0, t);
    const fields = holo.root.children.filter((o): o is Mesh => o instanceof Mesh && !(o instanceof InstancedMesh));
    return { holo, fields, visible: fields.filter((f) => f.visible) };
  }
  const lensFor = (source: Lens['source'], target: Lens['target']): Lens => {
    const lens = createLens(48);
    configureLens(lens, { units: [], spire: false }, source, { plane: target, radius: 6, cursor: true });
    Object.assign(lens, { x: 20, y: 20 });
    const cam = new PerspectiveCamera(50, 1.6, 0.1, 900);
    cam.position.set(0, AIM_Y[source] + 30, 20);
    cam.lookAt(0, AIM_Y[source], 0);
    lens.update(cam, { left: 0, top: 0, width: 1600, height: 1000 });
    return lens;
  };

  it('stacks the Sky over the Surface for Orbit, each compressed onto the viewing plane, the deeper one lower', () => {
    const lens = lensFor('orbit', 'surface');
    const { holo, visible } = shown(lens, 'orbit');
    expect(holo.scope).toBe(lens);
    expect(holo.openness).toBe(1);
    expect(visible).toHaveLength(2);
    expect(visible[0]!.position.y).toBeCloseTo(lens.layerY('sky'), 8);
    expect(visible[1]!.position.y).toBeCloseTo(lens.layerY('surface'), 8);
    expect(visible[1]!.position.y).toBeLessThan(visible[0]!.position.y);
  });

  it('blends the pooled holo before sharp entity batches without per-frame update-range objects', () => {
    const lens = lensFor('sky', 'surface');
    const v = view([ent('t', 'tank', 'se', 'surface', 20, 20)]);
    const { holo, visible } = shown(lens, 'sky', v);
    expect(holo.root.renderOrder).toBe(35);
    const field = visible[0]!;
    const glyphs = holo.root.children.find((o) => o instanceof InstancedMesh && o.visible) as InstancedMesh;
    expect(field.material).toMatchObject({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    expect(glyphs.material).toMatchObject({ transparent: true, depthWrite: false, blending: NormalBlending });
    const children = [...holo.root.children];
    for (const now of [1400, 1500]) holo.frame(v, new Map(), 'sky', 0, now);
    expect(holo.root.children).toEqual(children);
    expect(glyphs.count).toBe(1);
  });

  it('does not mark strike paths invalid using the drop-only reach', () => {
    const lens = lensFor('sky', 'surface');
    Object.assign(lens.drop, { active: true, kind: 'strike', count: 1, x: 20, y: 20, reach: 0 });
    lens.drop.from.set([21, 21]);
    const strokes: string[] = [];
    const ctx = {
      strokeStyle: '', beginPath() {}, moveTo() {}, lineTo() {}, setLineDash() {}, fill() {},
      stroke() { strokes.push(this.strokeStyle); },
    };
    const renderer = Object.create(Overlay.prototype) as Overlay;
    Object.assign(renderer, { ctx, ink: 'ink', halo: 'halo' });
    const world = { entities: { tracks: new Map() } } as unknown as World;
    renderer['dropScope'](world, lens, 0.5);
    const strike = strokes[1];
    strokes.length = 0;
    lens.drop.kind = 'drop';
    renderer['dropScope'](world, lens, 0.5);
    expect(strokes[1]).not.toBe(strike);
    strokes.length = 0;
    lens.drop.reach = 5;
    renderer['dropScope'](world, lens, 0.5);
    expect(strokes[1]).toBe(strike);
  });

  it('draws one layer for a bomber or a flak look-up, and nothing for another plane in view or a closed lens', () => {
    expect(shown(lensFor('sky', 'surface'), 'sky').visible).toHaveLength(1);
    const up = shown(lensFor('surface', 'sky'), 'surface');
    expect(up.visible).toHaveLength(1);
    expect(up.visible[0]!.position.y).toBeGreaterThan(AIM_Y.surface);
    expect(shown(lensFor('sky', 'surface'), 'orbit').holo.scope).toBeUndefined();
    const closed = lensFor('sky', 'surface');
    closed.active = false;
    expect(shown(closed, 'sky').holo.root.visible).toBe(false);
  });
});
