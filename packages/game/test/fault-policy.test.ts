import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { intentSchema, validate } from 'playerthree';
import { createGame } from '../src/agent/adapter.ts';
import { CELL, type ArmyId, type MatchData, type Observation } from '../src/rules/contract.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { manifest } from '../src/agent/manifest.ts';
import { periodOf, starterScript, UNBOUNDED } from './starter-policies.ts';

const wire = intentSchema(manifest);
/**
 * The starter's fault defence on its own: every decision plans afresh (UNBOUNDED) and two faults are guarded at once
 * (knob faultGuards; the standard tier guards one). Its decisions are a period apart.
 */
const DEPTHS_STARTER = await starterScript('depths', { ...UNBOUNDED, faultGuards: 2 });
const PERIOD = periodOf('depths');
function fixture(team: ArmyId = 'nw') {
  const game = createGame({ seed: 91, options: { map: { params: { spireInset: 8, homeLodes: 0, contestedZones: [] } } } });
  const seat = { team, role: 'depths' } as const;
  const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: 47 - x, y: 47 - y };
  const cell = (x: number, y: number) => { const p = point(x, y); return p.y * 48 + p.x; };
  const snapshot = game.observe(seat, 0);
  const matchData = game.matchData(seat);
  const obs = { ...snapshot, depths: snapshot.depths! };
  obs.depths.fill(CELL.bedrock);
  // The solid 3×3 Spire root (7..9) sits inside a walkable loading apron ring (6..10), as world generation carves it.
  for (let y = 6; y <= 10; y++) for (let x = 6; x <= 10; x++) if (x < 7 || x > 9 || y < 7 || y > 9) obs.depths[cell(x, y)] = CELL.tunnel;
  obs.holes = []; obs.lodes = []; obs.cracks = []; obs.charges = []; obs.queue = [];
  const policy = runInNewContext(`${DEPTHS_STARTER}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
  let initialized = false;
  const decide = () => {
    // Cross the VM boundary like the real policy host before validating plain JSON objects.
    if (!initialized) {
      policy.init(matchData);
      initialized = true;
    }
    const intents = structuredClone(policy.think(obs));
    for (const intent of intents) {
      const result = validate(wire, intent);
      expect(result.ok ? true : result).toBe(true);
    }
    return intents;
  };
  const learn = () => {
    game.sim.cells.set(obs.depths);
    game.sim.armies[game.sim.armyIndex(team)]!.group.known.set(obs.depths);
  };
  return { game, seat, obs, matchData, point, cell, decide, learn };
}

// The Depths starter is the built-in bot: one guarder fortifies the guarded walls in turn and treats an unknown fault
// cell as a wall to dig beside (the sim refuses it if it is not rock); the retired light example sent one digger per
// wall, skipped walls under a teammate's urgent tag and unknown cells. These cases check the bot's rules.
describe('the Depths starter fault defence', () => {
  for (const team of ['nw', 'se'] as const) it(`${team}: fortifies the nearest home fault cells in turn with one digger, without restarting its job`, () => {
    const f = fixture(team);
    for (const [x, y] of [[11, 10], [10, 11]]) f.obs.depths[f.cell(x!, y!)] = CELL.tunnel;
    for (const [x, y] of [[12, 10], [18, 10], [10, 12], [16, 10]]) f.obs.depths[f.cell(x!, y!)] = CELL.rock;
    f.matchData.faults = [{ cells: [f.point(18, 10), f.point(12, 10)] }, { cells: [f.point(10, 12)] }, { cells: [f.point(16, 10)] }];
    f.learn();
    const fortifies = () => f.decide().filter((i) => i.kind === 'fortify');
    const orders = fortifies();
    expect(orders.map((i) => ({ x: i.x, y: i.y }))).toEqual([f.point(12, 10)]);
    expect(orders[0]!.units).toHaveLength(1);
    expect(f.game.apply(f.seat, orders[0]!).ok).toBe(true);
    // On its way to the wall, as the sim reports an accepted fortify: the job stands.
    const guarder = f.obs.entities.find((e) => e.id === orders[0]!.units[0])!;
    guarder.state = 'moving';
    f.obs.tick += PERIOD;
    expect(fortifies()).toEqual([]);
    // That wall done, the same digger takes the next nearest; the third fault (beyond knob faultGuards 2) stays as it is.
    f.obs.depths[f.cell(12, 10)] = CELL.fortified;
    guarder.state = 'idle';
    f.obs.tick += PERIOD;
    expect(fortifies()).toEqual([{ kind: 'fortify', units: [guarder.id], ...f.point(10, 12) }]);
    f.obs.depths[f.cell(10, 12)] = CELL.fortified;
    f.obs.tick += PERIOD;
    expect(fortifies()).toEqual([]);
  });

  it('tags access beside the protected wall, then explicitly fortifies it once reachable', () => {
    const f = fixture();
    f.obs.depths[f.cell(11, 10)] = CELL.tunnel;
    for (let x = 12; x <= 16; x++) f.obs.depths[f.cell(x, 10)] = CELL.rock;
    f.matchData.faults = [{ cells: [f.point(16, 10)] }];
    const first = f.decide();
    const tags = first.filter((i) => i.kind === 'designate').flatMap((i) => i.cells ?? []);
    expect(tags).toEqual([12, 13, 14, 15].map((x) => f.point(x, 10)));
    expect(first.some((i) => i.kind === 'fortify')).toBe(false);
    for (let x = 12; x < 16; x++) f.obs.depths[f.cell(x, 10)] = CELL.tunnel;
    f.obs.tick += PERIOD;
    expect(f.decide().filter((i) => i.kind === 'fortify').map((i) => ({ x: i.x, y: i.y }))).toEqual([f.point(16, 10)]);
  });

  for (const team of ['nw', 'se'] as const) it(`${team}: clears reused reachability and designation scratch buffers between calls`, () => {
    const f = fixture(team);
    const wall = f.cell(12, 10);
    f.obs.depths[f.cell(11, 10)] = CELL.tunnel;
    f.obs.depths[wall] = CELL.rock;
    f.matchData.faults = [{ cells: [f.point(12, 10)] }];
    expect(f.decide().filter((i) => i.kind === 'fortify').map((i) => ({ x: i.x, y: i.y }))).toEqual([f.point(12, 10)]);
    f.obs.depths[f.cell(11, 10)] = CELL.rock;
    f.obs.tick += PERIOD;
    const orders = f.decide();
    expect(orders.some((i) => i.kind === 'fortify')).toBe(false);
    expect(orders.filter((i) => i.kind === 'designate').flatMap((i) => i.cells ?? [])).toEqual([f.point(11, 10)]);
    f.obs.depths[f.cell(11, 10)] = CELL.tunnel;
    f.obs.tick += PERIOD;
    expect(f.decide().filter((i) => i.kind === 'fortify').map((i) => ({ x: i.x, y: i.y }))).toEqual([f.point(12, 10)]);
  });

  it('does not seal tunnels, mine ore, or fortify distant/enemy faults', () => {
    const f = fixture();
    const cells = [[11, 10, CELL.tunnel], [10, 11, CELL.ore], [26, 10, CELL.rock], [41, 41, CELL.rock]];
    f.matchData.faults = cells.map(([x, y, code]) => {
      f.obs.depths[f.cell(x!, y!)] = code!;
      return { cells: [f.point(x!, y!)] };
    });
    expect(f.decide().filter((i) => i.kind === 'fortify' || i.kind === 'designate')).toEqual([]);
  });

  it('respects the match fortify cost and available team budget', () => {
    const f = fixture();
    f.obs.depths[f.cell(11, 10)] = CELL.rock;
    f.matchData.faults = [{ cells: [f.point(11, 10)] }];
    f.matchData.rules.depths.fortifyCost = f.obs.res.alloy + 1;
    expect(f.decide().filter((i) => i.kind === 'fortify' || i.kind === 'designate')).toEqual([]);
  });
});
