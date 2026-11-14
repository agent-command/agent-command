import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, OctahedronGeometry, type ComputeNode, type Renderer } from 'three/webgpu';
import { PLANE_Y, TICK_RATE, type View } from '@agent-command/game/contract';
import { Combat } from '../src/world/combat.ts';
import { applyFade } from '../src/world/fade.ts';
import { CpuParticles, GpuParticles, createParticles, dispatchParticles, type ParticlePool } from '../src/world/gpu-particles.ts';
import { COOL_S, ScorchFire, ScorchMarks, scorchHeat } from '../src/world/scorch.ts';
import { TerrainField } from '../src/world/terrain.ts';

const opts = (cap: number) => ({ cap, geo: new OctahedronGeometry(1, 0), additive: true, lit: false });
const RED = new Color('#ff0000');

/** A burst like an explosion's: varied velocities, lives and floors, from one deterministic recipe. */
function burst(pool: ParticlePool, n: number, seed = 0): void {
  for (let i = 0; i < n; i++) {
    const k = i + seed;
    // lives off the 1/60 s frame grid, so no death lands exactly on a frame boundary
    pool.spawn(k % 4, k * 0.5, 2 + (k % 3), -k, Math.cos(k) * 2, 1 + (k % 5), Math.sin(k) * 2, 0.31 + (k % 7) * 0.1, 0.2, 0.02, RED, 1, k % 2 ? 6 : 0, k % 3 ? 1.2 : 0, k % 4 ? 0 : -1e9);
  }
}

/** One frame of a GPU pool: bank the step, then ready the kernels as `dispatchParticles` would. */
function frame(pool: ParticlePool, dt: number): boolean {
  pool.update(dt);
  return pool.commit();
}

const count = (kernel: ComputeNode | undefined) => kernel!.count as number;

afterEach(() => applyFade(1));

describe('shared particle pools', () => {
  it('picks compute on WebGPU and the CPU pool otherwise, behind the same API', () => {
    const gpu = createParticles(opts(64), true);
    const cpu = createParticles(opts(64), false);
    expect(gpu).toBeInstanceOf(GpuParticles);
    expect(gpu.kernels).toHaveLength(2);
    expect(cpu).toBeInstanceOf(CpuParticles);
    expect(cpu.kernels).toHaveLength(0);
    // an offline Combat (tests, lookdev on WebGL2) runs the CPU pools and dispatches nothing
    const combat = new Combat(undefined, 48);
    const renderer = { compute: vi.fn() } as unknown as Renderer;
    burst(combat.sparks, 10);
    combat.frame(1000, 1 / 60, 100, 0);
    combat.dispatch(renderer);
    expect(combat.sparks).toBeInstanceOf(CpuParticles);
    expect(renderer.compute).not.toHaveBeenCalled();
  });

  it('keeps the same live count as the CPU pool through spawns and deaths', () => {
    const gpu = new GpuParticles(opts(256));
    const cpu = new CpuParticles(opts(256));
    for (let f = 0; f < 90; f++) {
      if (f % 15 === 0) {
        burst(gpu, 12, f);
        burst(cpu, 12, f);
      }
      gpu.update(1 / 60);
      gpu.commit();
      cpu.update(1 / 60);
      expect(gpu.n).toBe(cpu.n);
    }
    // everything has died: no kernel work and no draw
    for (let f = 0; f < 60; f++) frame(gpu, 1 / 60);
    expect(gpu.n).toBe(0);
    expect(frame(gpu, 1 / 60)).toBe(false);
    expect(gpu.mesh.count).toBe(0);
  });

  it('stages spawns deterministically, in the slot layout the spawn kernel copies', () => {
    const a = new GpuParticles(opts(64));
    const b = new GpuParticles(opts(64));
    burst(a, 20);
    burst(b, 20);
    expect(Array.from(a.stage.array)).toEqual(Array.from(b.stage.array));
    a.spawn(1, 3, 4, 5, 0.5, 1.5, -0.5, 0.8, 0.3, 0.05, RED, 0.9, 6, 1.2, 0.25);
    const o = 20 * 20;
    const stage = Array.from(a.stage.array.slice(o, o + 20));
    expect(stage.slice(0, 16)).toEqual([3, 4, 5, 0, 0.5, 1.5, -0.5, Math.fround(0.8), 6, Math.fround(1.2), 0.25, 0, 1, 0, 0, Math.fround(0.9)]);
    expect(stage.slice(16, 19)).toEqual([Math.fround(0.3), Math.fround(0.05), 1]);
  });

  it('copies staged spawns into the ring and integrates only the used slots, wrapping over the oldest', () => {
    const pool = new GpuParticles(opts(8));
    const [spawn, update] = pool.kernels;
    burst(pool, 5);
    expect(frame(pool, 0.016)).toBe(true);
    expect(count(spawn)).toBe(5);
    expect(count(update)).toBe(5);
    expect(pool.mesh.count).toBe(5);
    burst(pool, 6, 5);
    frame(pool, 0.016);
    // 11 spawns into 8 slots: the three oldest were overwritten
    expect(count(spawn)).toBe(6);
    expect(count(update)).toBe(8);
    expect(pool.n).toBeLessThanOrEqual(8);
    // a frame without spawns copies nothing
    frame(pool, 0.016);
    expect(count(spawn)).toBe(0);
    // more spawns than one frame can stage are dropped, like a full CPU pool drops them
    const small = new GpuParticles(opts(64), undefined, 4);
    burst(small, 10);
    expect(small.n).toBe(4);
    pool.clear();
    expect(pool.n).toBe(0);
    expect(frame(pool, 0.016)).toBe(false);
  });

  it('banks skipped frames into the next dispatch and dispatches all pools in one call', () => {
    const sparks = new GpuParticles(opts(64));
    const smoke = new GpuParticles(opts(64));
    const pools = [sparks, smoke];
    const kernels = pools.flatMap((p) => p.kernels);
    const renderer = { compute: vi.fn() } as unknown as Renderer;
    dispatchParticles(renderer, pools, kernels);
    expect(renderer.compute).not.toHaveBeenCalled();
    smoke.spawn(1, 0, 0, 0, 0, 1, 0, 1, 0.2, 0.1, RED, 1);
    sparks.update(0.02);
    smoke.update(0.02);
    sparks.update(0.02);
    smoke.update(0.02);
    dispatchParticles(renderer, pools, kernels);
    expect(renderer.compute).toHaveBeenCalledTimes(1);
    expect(renderer.compute).toHaveBeenCalledWith(kernels);
    // the two banked steps were integrated as one (0.04 s): the particle's second ends between 0.92 s and 1.04 s
    for (let f = 0; f < 22; f++) frame(smoke, 0.04);
    expect(smoke.n).toBe(1);
    for (let f = 0; f < 3; f++) frame(smoke, 0.04);
    expect(smoke.n).toBe(0);
  });

  it('integrates gravity, drag and the floor on the CPU pool exactly like the compute step', () => {
    const pool = new CpuParticles(opts(4));
    pool.spawn(1, 0, 1, 0, 2, 3, 0, 5, 0.2, 0.2, RED, 1, 9, 0.5, 0.25);
    let x = 0, y = 1, vx = 2, vy = 3;
    for (let f = 0; f < 60; f++) {
      const dt = 1 / 30;
      pool.update(dt);
      const d = Math.max(0, 1 - 0.5 * dt);
      vx *= d;
      vy = (vy - 9 * dt) * d;
      x += vx * dt;
      y = Math.max(0.25, y + vy * dt);
      const m = pool.mesh.instanceMatrix.array;
      expect(m[12]).toBeCloseTo(x, 4);
      expect(m[13]).toBeCloseTo(y, 4);
    }
    expect(y).toBe(0.25);
  });
});

describe('burning ground', () => {
  const size = 48;
  const terrain = new TerrainField(size);

  /** Records every spawn instead of simulating it. */
  function recorder(): ParticlePool & { log: number[][] } {
    const log: number[][] = [];
    return {
      log, mesh: new CpuParticles(opts(1)).mesh, n: 0, kernels: [],
      spawn: (plane, x, y, z, vx, vy, vz, life, s0, s1, _c, a0) => { log.push([plane, x, y, z, vx, vy, vz, life, s0, s1, a0]); },
      update: () => undefined, commit: () => false, clear: () => undefined,
    };
  }

  function run(scorches: NonNullable<View['scorches']>, ticks: number[], dt = 1 / 30) {
    const fire = new ScorchFire(size, terrain);
    const sparks = recorder();
    const smoke = recorder();
    for (const tick of ticks) fire.frame(scorches, tick, dt, sparks, smoke);
    return { sparks: sparks.log, smoke: smoke.log };
  }

  const zone = { x: 20, y: 22, radius: 4.5, until: 400 };
  const frames = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i * (TICK_RATE / 30));

  it('spawns flames, embers and smoke inside the zone on the Surface, deterministically', () => {
    const a = run([zone], frames(100, 60));
    const b = run([zone], frames(100, 60));
    expect(a).toEqual(b);
    expect(a.sparks.length).toBeGreaterThan(20);
    expect(a.smoke.length).toBeGreaterThan(2);
    for (const [plane, x, y, z] of [...a.sparks, ...a.smoke]) {
      expect(plane).toBe(1);
      expect(Math.hypot(x! - (zone.x - size / 2), z! - (zone.y - size / 2))).toBeLessThanOrEqual(zone.radius);
      expect(y).toBeGreaterThan(PLANE_Y.surface - 4);
    }
  });

  it('dies down over the last seconds and stops at expiry, or while the Surface is hidden', () => {
    const early = run([zone], frames(100, 60)).sparks.length;
    const late = run([zone], frames(zone.until - 2 * TICK_RATE, 30)).sparks.length;
    const gone = run([zone], frames(zone.until, 30)).sparks.length;
    expect(late).toBeLessThan(early / 2);
    expect(gone).toBe(0);
    expect(scorchHeat(0, 10)).toBe(0);
    expect(scorchHeat(COOL_S * 0.5, 10)).toBeLessThan(scorchHeat(COOL_S, 10));
    expect(scorchHeat(10, 10)).toBe(1);
    applyFade(3);
    expect(run([zone], frames(100, 60)).sparks).toHaveLength(0);
  });

  it('marks every current zone once and drops expired ones', () => {
    const marks = new ScorchMarks(size, terrain);
    const view = { tick: 100, scorches: [zone, { x: 30, y: 30, radius: 1.5, until: 90 }] } as unknown as View;
    marks.update(view, (tick) => tick / TICK_RATE);
    expect(marks.mesh.count).toBe(1);
    const m = marks.mesh.instanceMatrix.array;
    expect([m[12], m[14]]).toEqual([zone.x - size / 2, zone.y - size / 2]);
    marks.update({ ...view, scorches: [] }, (tick) => tick / TICK_RATE);
    expect(marks.mesh.count).toBe(0);
  });
});
