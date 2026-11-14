import { afterEach, describe, expect, it } from 'vitest';
import { Mesh, PointsNodeMaterial, Raycaster, Sprite } from 'three/webgpu';
import { PlaneBackdrop } from '../src/world/backdrop.ts';
import { applyFade, FADE } from '../src/world/fade.ts';
import { NO_LINES } from '../src/world/materials.ts';

afterEach(() => applyFade(1));

type Attr = { value: { array: Float32Array; itemSize: number; count: number } };

function parts(backdrop: PlaneBackdrop) {
  const dome = backdrop.group.children[0] as Mesh;
  const stars = backdrop.group.children[1] as Sprite;
  const material = stars.material as PointsNodeMaterial;
  const attr = (node: unknown) => (node as Attr).value;
  return { dome, stars, material, positions: attr(material.positionNode), sizes: attr(material.sizeNode) };
}

describe('off-map plane backdrop', () => {
  it('bounds geometry and draws, reuses the dome, and never participates in picking or depth/ink', () => {
    const a = new PlaneBackdrop();
    const b = new PlaneBackdrop();
    const { dome, stars, material } = parts(a);
    expect(dome.geometry).toBe(parts(b).dome.geometry);
    expect(dome.geometry.getAttribute('position').count).toBe(561);
    expect(dome.geometry.index!.count / 3).toBe(960);
    // One instanced draw for every star; point primitives would rasterise at a fixed 1px.
    expect(a.group.children).toHaveLength(2);
    expect(stars.isSprite).toBe(true);
    expect(stars.count).toBe(1600 + 360 + 48);
    expect(new Raycaster().intersectObject(a.group, true)).toEqual([]);
    for (const m of [dome.material as Mesh['material'] & { depthWrite: boolean }, material]) {
      expect(m.depthWrite).toBe(false);
      expect(m).toHaveProperty('mrtNode', NO_LINES);
    }
    expect(material).toMatchObject({ sizeAttenuation: false, opacityNode: FADE.orbit.focus });
    expect(dome.material).toHaveProperty('transparent', false);
    expect(dome.material).toHaveProperty('depthTest', false);
  });

  it('gives fixed stars a deterministic size/brightness/depth hierarchy without a clock', () => {
    const { positions, sizes } = parts(new PlaneBackdrop());
    const other = parts(new PlaneBackdrop());
    expect(positions.array).toEqual(other.positions.array);
    expect(sizes.array).toEqual(other.sizes.array);
    const tiers = [[1600, 0.9, 530], [360, 1.5, 460], [48, 2.2, 390]] as const;
    let i = 0;
    for (const [count, size, radius] of tiers) for (let j = 0; j < count; j++, i++) {
      expect(sizes.array[i]).toBeCloseTo(size, 5);
      const [x, y, z] = positions.array.subarray(i * 3, i * 3 + 3);
      const r = Math.hypot(x!, y!, z!);
      expect(r).toBeGreaterThanOrEqual(radius - 0.001);
      expect(r).toBeLessThan(radius + 30.001);
    }
    expect(i).toBe(sizes.array.length);
  });

  it('culls the unused star draw and retains its buffers through dives and reset-style focus changes', () => {
    const backdrop = new PlaneBackdrop();
    const { stars, positions } = parts(backdrop);
    const buffer = positions.array;
    for (const level of [0, 1, 2, 2.5, 3, 1, 3, 0]) {
      applyFade(level);
      backdrop.frame();
      expect(stars.visible).toBe(FADE.orbit.focus.value > 0);
      expect(parts(backdrop).positions.array).toBe(buffer);
      expect(backdrop.group.visible).toBe(true);
    }
  });
});
