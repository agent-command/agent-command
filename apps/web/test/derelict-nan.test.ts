import { describe, expect, it } from 'vitest';
import { Mesh, type BufferGeometry } from 'three/webgpu';
import { AgentCommandGame } from '@agent-command/game';
import type { DerelictGeometry, MatchOptions } from '@agent-command/game/contract';
import { buildPreviewView } from '../src/preview-map.ts';
import { DerelictRuin } from '../src/world/derelict.ts';

/** Every vertex of every mesh under the ruin is a finite number (three's NaN bounding-sphere warning never fires). */
function finite(ruin: DerelictRuin): { meshes: number; bad: number } {
  let meshes = 0;
  let bad = 0;
  ruin.group.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const geo = o.geometry as BufferGeometry;
    const pos = geo.getAttribute('position');
    // placeholders carry an empty position attribute: only meshes with vertices were built
    if (!pos?.count) return;
    meshes++;
    for (const v of pos.array as Float32Array) if (!Number.isFinite(v)) bad++;
  });
  return { meshes, bad };
}

async function build(g: DerelictGeometry | undefined, seed: number, size: number): Promise<DerelictRuin> {
  const ruin = new DerelictRuin(size);
  ruin.set(g, seed);
  await ruin.ready();
  return ruin;
}

const duel = (options: MatchOptions) => new AgentCommandGame(7, options).view('nw').match!;

describe('derelict layer never builds NaN geometry', () => {
  it.each([
    ['backdrop preview', () => buildPreviewView({})],
    ['four-army preview', () => buildPreviewView({ map: { params: { slots: 4 } } })],
  ] as const)('%s', async (_name, view) => {
    const match = view().match!;
    const ruin = await build(match.derelict, match.mapSeed, match.rules.map.size);
    const { meshes, bad } = finite(ruin);
    expect(meshes).toBeGreaterThan(5);
    expect(bad).toBe(0);
  });

  it.each([
    ['duel', {}],
    ['four-army L80', { map: { params: { size: 80, slots: 4 } } }],
  ] as const)('%s match', async (_name, options) => {
    const match = duel(options as MatchOptions);
    const ruin = await build(match.derelict, match.mapSeed, match.rules.map.size);
    const { meshes, bad } = finite(ruin);
    expect(meshes).toBeGreaterThan(5);
    expect(bad).toBe(0);
  });

  it('builds nothing with the ruin off, or from geometry with missing or non-finite sizes', async () => {
    const off = duel({ orbit: { derelictEnabled: false } });
    expect(off.derelict).toBeUndefined();
    expect(finite(await build(undefined, 0, 48)).meshes).toBe(0);
    const g = duel({}).derelict!;
    // e.g. match data from an older server: no NaN radii reach three; the ruin just stays hidden.
    const broken = { ...g, ringInner: undefined } as unknown as DerelictGeometry;
    const ruin = await build(broken, 0, 48);
    expect(ruin.group.visible).toBe(false);
    expect(finite(ruin).bad).toBe(0);
  });
});
