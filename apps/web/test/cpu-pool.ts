import { CpuParticles, type ParticlePool } from '../src/world/gpu-particles.ts';

/** An offline `Combat` runs the CPU particle pools: their instance matrices hold the integrated particles. */
export function cpuPool(pool: ParticlePool): CpuParticles {
  if (!(pool instanceof CpuParticles)) throw new Error('expected the CPU particle pool');
  return pool;
}
