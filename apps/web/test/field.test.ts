import { describe, expect, it } from 'vitest';
import type { BufferAttribute } from 'three/webgpu';
import { DEFAULT_RULES } from '@agent-command/game/contract';
import { HeightField, type FieldSpec } from '../src/world/field.ts';
import { FieldBuilder } from '../src/world/fieldjobs.ts';

// The Depths spec: rock cut 1.25, bedrock 1.45, floors 0, flooded magma −0.2; bit 1 = rock (rough), bit 2 = open.
const SPEC: FieldSpec = { size: DEFAULT_RULES.map.size, res: 4, blur: 0.28, sharp: 0.2, rough: 0.06, swell: 0, levels: [-0.2, 0, 1.25, 1.45], sun: false };

describe('windowed heightfield rebuilds (digs, holes)', () => {
  it('patches a dig in a window that matches a full rebuild, leaving the rest of the field alone', () => {
    let changes = 0;
    const b = new FieldBuilder(new HeightField(SPEC), -0.7, () => changes++);
    b.level.fill(1.25);
    b.cls.fill(2);
    b.full(); // no Worker under Node: builds in place
    expect(changes).toBe(1);
    const before = b.field.h.slice();

    const cx = 20;
    const cy = 30;
    b.level[cy * SPEC.size + cx] = 0;
    b.cls[cy * SPEC.size + cx] = 4;
    expect(b.patch()).toBe(true);
    expect(changes).toBe(2);
    expect(b.field.heightAt(cx + 0.5, cy + 0.5)).toBeCloseTo(0, 1);
    expect(b.field.heightAt(cx + 3.5, cy + 0.5)).toBeGreaterThan(1.1);

    const n = b.field.n;
    const res = SPEC.res;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        if (Math.max(Math.abs(i / res - (cx + 0.5)), Math.abs(j / res - (cy + 0.5))) < 4) continue;
        expect(b.field.h[j * n + i]).toBe(before[j * n + i]);
      }

    const ref = new HeightField(SPEC);
    ref.level.set(b.level);
    ref.cls.set(b.cls);
    ref.build(ref.full());
    let worst = 0;
    for (let k = 0; k < n * n; k++) worst = Math.max(worst, Math.abs(ref.h[k]! - b.field.h[k]!), Math.abs(ref.ao[k]! - b.field.ao[k]!));
    expect(worst).toBeLessThan(1e-5);

    expect(b.patch()).toBe(false); // nothing left to do
    expect(changes).toBe(2);
  });

  it.each(['full then patch', 'separate patches', 'disjoint windows'] as const)('preserves every terrain change before rendering: %s', (sequence) => {
    const b = new FieldBuilder(new HeightField(SPEC), -0.7, () => {});
    b.level.fill(sequence === 'full then patch' ? 0 : 1.25);
    b.cls.fill(sequence === 'full then patch' ? 4 : 2);
    b.full();
    const attributes = [...Object.values(b.mesh.geometry.attributes), b.mesh.geometry.index!] as BufferAttribute[];
    // Last drawn buffers; Three consumes and clears pending ranges at upload time, not at terrain rebuild time.
    const drawn = attributes.map((a) => {
      a.clearUpdateRanges();
      return a.array.slice();
    });
    if (sequence === 'full then patch') {
      b.level.fill(1.25);
      b.cls.fill(2);
      b.full();
    } else {
      b.level[10 * SPEC.size + 10] = 0;
      b.cls[10 * SPEC.size + 10] = 4;
      if (sequence === 'separate patches') b.patch();
    }
    b.level[38 * SPEC.size + 38] = 0;
    b.cls[38 * SPEC.size + 38] = 4;
    b.patch();
    for (const [i, a] of attributes.entries()) {
      const gpu = drawn[i]!;
      if (!a.updateRanges.length) gpu.set(a.array);
      else for (const { start, count } of a.updateRanges) gpu.set(a.array.subarray(start, start + count), start);
      let missing = 0;
      for (let k = 0; k < gpu.length; k++) if (gpu[k] !== a.array[k]) missing++;
      expect(missing, `attribute ${i}: stale values after the next draw`).toBe(0);
    }
  });

  it('keeps the diorama skirt exactly on the map edge, where the edge section material takes over', () => {
    // `mapEdge()` selects fragments with max(|x|, |z|) at size / 2: every skirt face lies there, every grid face inside.
    const b = new FieldBuilder(new HeightField(SPEC), -0.7, () => {});
    b.full();
    const g = b.mesh.geometry;
    const pos = g.attributes.position!.array;
    const idx = g.index!.array;
    const gridEnd = (b.field.n - 1) * (b.field.n - 1) * 6;
    for (let k = 0; k < idx.length; k += 3) {
      let x = 0, z = 0;
      for (let t = 0; t < 3; t++) { x += pos[idx[k + t]! * 3]! / 3; z += pos[idx[k + t]! * 3 + 2]! / 3; }
      const edge = Math.max(Math.abs(x), Math.abs(z));
      if (k >= gridEnd) expect(edge).toBeCloseTo(SPEC.size / 2, 5);
      else expect(edge).toBeLessThan(SPEC.size / 2 - 0.05);
    }
  });
});
