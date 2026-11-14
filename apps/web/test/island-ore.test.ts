import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, Raycaster, Vector3, type InstancedMesh, type MeshBasicNodeMaterial } from 'three/webgpu';
import { IslandOre, ORE_WET, islandOreTemplate } from '../src/world/island-ore.ts';
import { islandModel } from '../src/world/models.ts';

const reserve = { oreCapacity: 240, oreRemaining: 240 };
afterEach(() => vi.restoreAllMocks());

function mineral(seed = 2, turns = 0) {
  const terrain = islandModel(seed, turns, true, true);
  const ore = new IslandOre(`e_${seed * 4 + turns + 1}`, terrain, seed, turns);
  return { terrain, ore, dispose: () => { ore.dispose(); terrain.dispose(); } };
}

function mass(mesh: InstancedMesh): number {
  const matrix = new Matrix4();
  let total = 0;
  for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, matrix); total += Math.abs(matrix.determinant()); }
  return total;
}

describe('finite island mineral art', () => {
  it('merges fixed mineral ribs into only ore-bearing island rock, under the turf lip and outside the cap', () => {
    for (let seed = 0; seed < 4; seed++) {
      const bare = islandModel(seed, 1, true), ore = islandModel(seed, 1, true, true);
      const veins = (g: typeof ore) => {
        const part = g.getAttribute('part'), p = g.getAttribute('position'), out: Vector3[] = [];
        for (let i = 0; i < part.count; i++) if (part.getX(i) === 20) out.push(new Vector3().fromBufferAttribute(p, i));
        return out;
      };
      expect(veins(bare)).toHaveLength(0);
      const ribs = veins(ore);
      expect(ribs.length).toBeGreaterThan(0);
      for (const v of ribs) expect(v.y).toBeLessThan(0);
      // rib tips stand proud of the cap's 2.4-tile rim, where the play camera sees them past the turf lip
      expect(Math.max(...ribs.map(v => Math.hypot(v.x, v.z)))).toBeGreaterThan(2.4);
    }
  });

  it.each([0, 1, 2, 3])('embeds downward crystals in the actual turned rock rather than putting heaps on the cap (turn %s)', turns => {
    const f = mineral(2, turns);
    f.ore.observe(reserve);
    expect(f.ore.mesh.count).toBeGreaterThan(6);
    // nothing reaches the turf: the cap's lowest rim sits at -0.14
    expect(f.ore.mesh.boundingBox!.max.y).toBeLessThan(-0.15);
    const rock = new Mesh(f.terrain, new MeshBasicMaterial({ side: DoubleSide }));
    const matrix = new Matrix4(), base = new Vector3(), tip = new Vector3(), direction = new Vector3();
    const caster = new Raycaster();
    for (let i = 0; i < f.ore.mesh.count; i++) {
      f.ore.mesh.getMatrixAt(i, matrix);
      base.setFromMatrixPosition(matrix);
      tip.set(0, 1, 0).applyMatrix4(matrix);
      expect(tip.y).toBeLessThan(base.y - 0.2);
      direction.subVectors(base, tip).normalize();
      caster.set(tip, direction);
      caster.far = base.distanceTo(tip) + 0.2;
      const contact = caster.intersectObject(rock, false)[0];
      expect(contact, `shard ${i} must emerge from the drawn rock`).toBeDefined();
      expect(contact!.point.distanceTo(base)).toBeLessThan(0.2);
    }
    rock.material.dispose();
    f.dispose();
  });

  it.each([0, 1, 2, 3])('leans every shard of every cluster outward and down within its cone (turn %s)', turns => {
    for (let seed = 0; seed < 6; seed++) {
      const f = mineral(seed, turns);
      f.ore.observe(reserve);
      const matrix = new Matrix4(), base = new Vector3(), axis = new Vector3();
      let worst = 0;
      for (let i = 0; i < f.ore.mesh.count; i++) {
        f.ore.mesh.getMatrixAt(i, matrix);
        base.setFromMatrixPosition(matrix);
        axis.set(0, 1, 0).transformDirection(matrix);
        // Outward heading 0.8 plus a tangent lean of at most 0.6: <= 37 degrees off the rock's horizontal normal, which
        // itself faces away from the island axis. Shards built from stale triangle scratch point anywhere.
        const radial = Math.atan2(base.z, base.x), heading = Math.atan2(axis.z, axis.x);
        const off = Math.abs(Math.atan2(Math.sin(heading - radial), Math.cos(heading - radial)));
        worst = Math.max(worst, off);
        expect(axis.y, `shard ${i} points down`).toBeLessThan(-0.4);
        expect(axis.y).toBeGreaterThan(-0.9);
      }
      expect(worst, `seed ${seed}`).toBeLessThan(Math.PI * 0.4);
      f.dispose();
    }
  });

  it('darkens crystals in a storm through a per-island instance tint that shares the template program', () => {
    const f = mineral();
    const template = islandOreTemplate();
    try {
      f.ore.observe(reserve);
      expect(template.instanceColor).not.toBeNull();
      expect(f.ore.mesh.material).toBe(template.material);
      const tint = () => Array.from(f.ore.mesh.instanceColor!.array.subarray(0, 3));
      const version = f.ore.mesh.instanceColor!.version;
      expect(tint()).toEqual([1, 1, 1]);
      f.ore.weather(1);
      expect(tint()).toEqual([Math.fround(ORE_WET.r), Math.fround(ORE_WET.g), Math.fround(ORE_WET.b)]);
      f.ore.weather(1);
      expect(f.ore.mesh.instanceColor!.version).toBe(version + 1); // unchanged storm: no re-upload
      f.ore.weather(0);
      expect(tint()).toEqual([1, 1, 1]);
    } finally { template.dispose(); f.dispose(); }
  });

  it('reduces visible crystal abundance and mass with disclosed reserves without rebuilding geometry or frame storage', () => {
    const f = mineral();
    f.ore.observe(reserve);
    const fullCount = f.ore.mesh.count, fullMass = mass(f.ore.mesh);
    const geometry = f.ore.mesh.geometry, material = f.ore.mesh.material, storage = f.ore.mesh.instanceMatrix.array;
    f.ore.observe({ ...reserve, oreRemaining: 60 });
    expect(f.ore.mesh.count).toBeGreaterThan(0);
    expect(f.ore.mesh.count).toBeLessThan(fullCount);
    expect(mass(f.ore.mesh)).toBeLessThan(fullMass / 2);
    expect(f.ore.reserve.value.toArray()).toEqual([0.25, 1]);
    const version = f.ore.mesh.instanceMatrix.version;
    f.ore.observe({ ...reserve, oreRemaining: 60 });
    expect(f.ore.mesh.instanceMatrix.version).toBe(version);
    expect(f.ore.mesh.instanceMatrix.array).toBe(storage);
    expect(f.ore.mesh.geometry).toBe(geometry);
    expect(f.ore.mesh.material).toBe(material);
    f.dispose();
  });

  it('does not turn a public initial capacity or previously rich sighting into live ore after sight is lost', () => {
    const unseen = mineral(), previouslyRich = mineral();
    previouslyRich.ore.observe(reserve);
    unseen.ore.observe({ oreCapacity: 240 });
    previouslyRich.ore.observe({ oreCapacity: 240 });
    for (const f of [unseen, previouslyRich]) {
      expect(f.ore.mesh.count).toBe(0);
      expect(f.ore.mesh.visible).toBe(false);
      expect(f.ore.mesh.boundingBox!.isEmpty()).toBe(true);
      expect(f.ore.reserve.value.toArray()).toEqual([0, 0]);
    }
    unseen.dispose(); previouslyRich.dispose();
  });

  it('remembers legitimately observed exhaustion through unknown/captured/rebuilt views, but not a new island lifecycle', () => {
    const spent = mineral(), unknown = mineral();
    spent.ore.observe({ ...reserve, oreRemaining: 0 });
    spent.ore.observe({ oreCapacity: 240 });
    unknown.ore.observe({ oreCapacity: 240 });
    expect(spent.ore.mesh.count).toBe(0);
    expect(spent.ore.reserve.value.toArray()).toEqual([0, 1]);
    expect(unknown.ore.reserve.value.toArray()).toEqual([0, 0]);
    // Initial-capacity reuse is not a refill. Only the owning match/viewer reset constructs a fresh controller.
    spent.ore.observe(reserve);
    expect(spent.ore.mesh.count).toBe(0);
    expect(spent.ore.reserve.value.toArray()).toEqual([0, 1]);
    spent.dispose(); unknown.dispose();
    const fresh = mineral();
    fresh.ore.observe(reserve);
    expect(fresh.ore.mesh.count).toBeGreaterThan(0);
    fresh.dispose();
  });

  it('shows disclosed observer/enemy ore without an ownership guess and removes it when the disclosure disappears', () => {
    const f = mineral();
    const observed = { ...reserve, side: 'se', id: 'e_9' };
    f.ore.observe(observed);
    expect(f.ore.mesh.count).toBeGreaterThan(0);
    f.ore.observe({ oreCapacity: observed.oreCapacity });
    expect(f.ore.mesh.count).toBe(0);
    f.dispose();
  });

  it('shares the small mineral kit and its warm-up material, disposing only each island’s owned instances', () => {
    const a = mineral(0), b = mineral(1), template = islandOreTemplate();
    a.ore.observe(reserve); b.ore.observe(reserve);
    expect(a.ore.mesh.geometry).toBe(b.ore.mesh.geometry);
    expect(a.ore.mesh.material).toBe(b.ore.mesh.material);
    expect(template.geometry).toBe(a.ore.mesh.geometry);
    expect(template.material).toBe(a.ore.mesh.material);
    expect(template.count).toBe(0);
    const root = new Group();
    root.add(a.ore.mesh, b.ore.mesh);
    const instances = vi.spyOn(a.ore.mesh, 'dispose');
    const geometry = vi.spyOn(a.ore.mesh.geometry, 'dispose');
    const material = vi.spyOn(a.ore.mesh.material as MeshBasicNodeMaterial, 'dispose');
    a.dispose();
    expect(instances).toHaveBeenCalledOnce();
    expect(geometry).not.toHaveBeenCalled();
    expect(material).not.toHaveBeenCalled();
    expect(root.children).toEqual([b.ore.mesh]);
    expect(b.ore.mesh.count).toBeGreaterThan(0);
    template.dispose(); b.dispose();
  });
});
