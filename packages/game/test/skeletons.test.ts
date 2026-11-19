/**
 * The skeletons (skill `policies/skeleton/<plane>.js`), built as `policy_deploy {from}` builds them, run the economy
 * only: Depths keeps its digging crew mining, Orbit fills five solar arrays and keeps two tugs, Surface and Sky give no
 * orders, and nothing they ask for is an army, an attack or research.
 */
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { buildStarter, parseStarterRef, starterCatalog } from 'playerthree/policy';
import { createGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { manifest, SKELETONS, STRATEGY_SKILL } from '../src/agent/manifest.ts';
import { PLANES, type MatchData, type Observation } from '../src/rules/contract.ts';

const catalog = starterCatalog(manifest);

it('skeletons build without knobs and run the economy only', async () => {
  const game = createGame({ seed: 21 });
  const drivers = await Promise.all(PLANES.map(async (role) => {
    expect(catalog.get(SKELETONS[role])?.knobs).toBeNull();
    const built = await buildStarter(parseStarterRef(catalog, SKELETONS[role], undefined, role), [STRATEGY_SKILL]);
    if (!built.ok) throw new Error(`${role} skeleton does not build: ${built.message}`);
    const api = runInNewContext(`${built.code}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
    api.init(game.matchData({ team: 'nw', role }));
    return { seat: { team: 'nw', role } as const, api };
  }));
  const asked = new Set<string>();
  const army = game.sim.armies[0]!;
  const alive = (kind: string) => game.sim.ents.filter((e) => !e.dead && e.side === 0 && e.kind === kind).length;
  const initial = { trooper: alive('trooper'), tank: alive('tank'), interceptor: alive('interceptor') };
  for (let tick = 0; tick < 20 * 60 * 4; tick++) {
    if (game.tick % 10 === 0) {
      const decisions = drivers.map(({ seat, api }) => structuredClone(api.think(game.observe(seat, Math.max(0, game.tick - 10)))));
      game.sim.round(() => drivers.forEach(({ seat }, i) => {
        for (const intent of decisions[i]!) {
          asked.add(`${seat.role} ${intent.kind} ${'item' in intent ? intent.item : 'action' in intent ? intent.action : ''}`);
          expect(game.apply(seat, intent, { source: 'policy' }), JSON.stringify(intent)).toMatchObject({ ok: true });
        }
      }));
    }
    game.step();
  }
  expect([...asked].sort()).toEqual(['depths macro auto_mine', 'depths queue_add digger', 'orbit macro auto_mine', 'orbit macro spread_arrays', 'orbit queue_add solar', 'orbit queue_add tug']);
  expect(alive('digger')).toBe(8);
  expect(alive('solar')).toBe(5);
  expect(alive('tug')).toBe(2);
  expect(army.stats.alloyMined).toBeGreaterThan(0);
  // No army of its own: the starting units only.
  expect({ trooper: alive('trooper'), tank: alive('tank'), interceptor: alive('interceptor') }).toEqual(initial);
}, 30_000);
