import { describe, expect, it } from 'vitest';
import { type BufferAttribute, Color } from 'three/webgpu';
import { SURFACE, type Entity } from '@agent-command/game/contract';
import { SelectionContours, contourEligible, contourLayer, selectionEntrance, writeContourSupport } from '../src/world/selection-contours.ts';
import { TerrainField } from '../src/world/terrain.ts';
import { FieldMesh } from '../src/world/fieldmesh.ts';

const unit: Entity = { id: 'selected', kind: 'tank', side: 'nw', plane: 'surface', x: 4, y: 4, hp: 100, maxHp: 100, state: 'idle' };

describe('selected toon contour membership', () => {
  it('immediately excludes lost visibility, death, cloak and deselection', () => {
    const selected = new Set([unit.id]);
    expect(contourEligible(unit, selected, true)).toBe(true);
    expect(contourEligible(unit, selected, false)).toBe(false);
    expect(contourEligible({ ...unit, hp: 0 }, selected, true)).toBe(false);
    expect(contourEligible({ ...unit, cloaked: true }, selected, true)).toBe(false);
    selected.clear();
    expect(contourEligible(unit, selected, true)).toBe(false);
    selected.add(unit.id);
    expect(contourEligible(unit, selected, true)).toBe(true);
  });
  it('leaves structures, islands, rocks and unavailable units on their ordinary marker path', () => {
    const selected = new Set([unit.id]);
    for (const kind of ['turret', 'spire', 'island', 'asteroid', 'core'] as const)
      expect(contourEligible({ ...unit, kind }, selected, true)).toBe(false);
    for (const state of ['falling', 'hangared', 'launching'] as const)
      expect(contourEligible({ ...unit, state }, selected, true)).toBe(false);
    expect(contourEligible({ ...unit, side: 'neutral' }, selected, true)).toBe(false);
  });
  it('never pools armies, planes, plateau decks or moored heights', () => {
    const surface = contourLayer(unit, 0, false);
    expect(contourLayer({ ...unit, side: 'se' }, 0, false)).not.toBe(surface);
    expect(contourLayer(unit, 0, true)).not.toBe(surface);
    const sky = { ...unit, plane: 'sky' as const };
    expect(contourLayer(sky, 0, false)).not.toBe(surface);
    expect(contourLayer(sky, -8, false)).not.toBe(contourLayer(sky, 0, false));
    expect(contourLayer(sky, -7.99, false)).toBe(contourLayer(sky, -8, false));
  });
  it('eases selection entrance in real seconds, freezes at zero elapsed time and honors reduced motion', () => {
    expect(selectionEntrance(0, 0, false)).toBe(0);
    expect(selectionEntrance(0, 0.075, false)).toBeCloseTo(0.5);
    expect(selectionEntrance(0.5, 0.075, false)).toBe(1);
    expect(selectionEntrance(0, 0, true)).toBe(1);
  });
  it('does not retain an entrance or contribution after a missing frame or match reset', () => {
    const terrain = new TerrainField(8), mesh = new FieldMesh(terrain.field, -4);
    const contours = new SelectionContours(terrain);
    contours.bindTerrain(mesh.geometry);
    const tint = new Color('#3aa8ff');
    try {
      contours.begin(0.15, false);
      expect(contours.add(unit, 4, 4, 0.04, 0.8, 0, tint, 1)).toBe(0);
      contours.publish();
      contours.reserve(2048); // additional visible units must not restart an existing selection entrance
      contours.begin(0.01, false);
      expect(contours.add(unit, 4, 4, 0.04, 0.8, 0, tint, 1)).toBe(0);
      contours.publish();
      contours.begin(0.01, false);
      contours.publish(); // deselected/hidden/dead sources are not submitted
      contours.begin(0.01, false);
      expect(contours.add(unit, 4, 4, 0.04, 0.8, 0, tint, 1)).toBeGreaterThan(0.98);
      contours.publish();
      contours.reset();
      contours.begin(0, false);
      expect(contours.add(unit, 4, 4, 0.04, 0.8, 0, tint, 1)).toBe(1);
    } finally { contours.dispose(); mesh.geometry.dispose(); }
  });
  it('uploads records only when they change and ground support only after a terrain upload', () => {
    const terrain = new TerrainField(8), mesh = new FieldMesh(terrain.field, -4);
    const contours = new SelectionContours(terrain);
    contours.bindTerrain(mesh.geometry);
    const internals = contours as unknown as { records: { version: number }; ground: { version: number } };
    const tint = new Color('#3aa8ff');
    const frame = (x: number) => { contours.begin(0.2, true); contours.add(unit, x, 4, 0.04, 0.8, 0, tint, 1); contours.publish(); };
    try {
      frame(4);
      const records = internals.records.version, ground = internals.ground.version;
      frame(4);
      frame(4);
      expect(internals.records.version).toBe(records);
      expect(internals.ground.version).toBe(ground);
      frame(4.25); // same bins, moved source: records only
      expect(internals.records.version).toBe(records + 1);
      expect(internals.ground.version).toBe(ground);
      mesh.upload({ i0: 16, i1: 16, j0: 16, j1: 16 });
      frame(4.25);
      expect(internals.ground.version).toBe(ground + 1);
      expect(internals.records.version).toBe(records + 1);
    } finally { contours.dispose(); mesh.geometry.dispose(); }
  });
  it('follows drawn terrain through partial bake uploads, cliffs and real bridge support', () => {
    const terrain = new TerrainField(8), mesh = new FieldMesh(terrain.field, -4);
    const drawn = { position: mesh.geometry.getAttribute('position') as BufferAttribute, index: mesh.geometry.index! };
    const data = new Float32Array(4);
    const ix = 16, iz = 16, cell = 4 * 8 + 4, n = terrain.field.n, q = iz * n + ix;
    const sample = () => writeContourSupport(data, 0, terrain, drawn, ix, iz);
    try {
      terrain.field.h.fill(0);
      terrain.field.h[q] = 1.35;
      terrain.field.h[q + 1] = 3;
      mesh.upload();
      sample();
      expect(data[0]).toBeCloseTo(1.35);
      expect(data[1]).toBeCloseTo(1.35); // ordinary slope is not clipped by source height
      expect(data[2]).toBe(0);
      expect(data[3]).toBe(1); // drawn AD diagonal
      terrain.field.h[q] = -3.2; // newer bake exists, but this band has NOT uploaded
      sample();
      expect(data[1]).toBeCloseTo(1.35);
      expect(data[3]).toBe(1);
      mesh.upload({ i0: ix, i1: ix, j0: iz, j1: iz });
      sample();
      expect(data[1]).toBeCloseTo(-3.2);
      expect(data[3]).toBe(0); // now the actual draw has switched to BC
      terrain.terrainCodes[cell] = SURFACE.cliff;
      sample();
      expect(data[2]).toBe(2);
      terrain.terrainCodes[cell] = SURFACE.ground;
      terrain.opened[cell] = 1;
      sample();
      expect(data[0]).toBeCloseTo(-3.2);
      expect(data[1]).toBeCloseTo(0.06); // actual bridge top, not a general-purpose lift
      expect(data[2]).toBe(0);
    } finally { mesh.geometry.dispose(); }
  });
});
