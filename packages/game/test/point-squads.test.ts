/**
 * Contested point squads (bots/posts.ts pointOrders) where cliffs cut the point's capture disc: a ridges map whose
 * centre point sits on a diagonal cliff pinch, so each army reaches only a sliver of the disc from its own side, and
 * the slots the simulation spreads round the point land outside it. Both armies are driven by the bot's point-squad
 * orders on the real simulation, at the bot cadence, on point-mirrored ground, checked twin against twin every tick.
 */
import { describe, expect, it } from 'vitest';
import { SURFACE, toTicks, unpackTerrain, type ArmyId } from '../src/rules/contract.ts';
import { createGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { Ctx } from '../src/bots/context.ts';
import { BOT_PERIOD } from '../src/bots/play.ts';
import { pointOrders, type PointMember } from '../src/bots/posts.ts';
import { TIERS } from '../src/bots/tuning.ts';
import type { Ent } from '../src/sim/ent.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const TEAMS = ['nw', 'se'] as const;
const foeOf = (team: ArmyId): ArmyId => (team === 'nw' ? 'se' : 'nw');
const tier = TIERS.veteran;

/**
 * A featured bot match's map (ridges, map seed 2032499895) with every start unit gone: per army a squad of three
 * troopers west of the pinch in its own frame, and optionally a hostile tank holding ground beside the squad's way in.
 * Spawned army by army in the same order, so twins share their per-army serials (the simulation's tie-breaks between
 * equals) as a match's mirrored production gives them; every tick is checked twin against twin.
 */
function pinch(tank: boolean) {
  const g = createGame({ seed: 7, options: { terrain: 'ridges', map: { seed: 2032499895 } } });
  const s = g.sim;
  const size = s.size;
  const at = (x: number, y: number): number => s.terrain[Math.floor(y) * size + Math.floor(x)]!;
  // The two cells diagonal to the centre on the main diagonal are cliff, the other two open ground.
  expect([at(23.5, 23.5), at(24.5, 24.5), at(23.5, 24.5), at(24.5, 23.5)]).toEqual([SURFACE.cliff, SURFACE.cliff, SURFACE.ground, SURFACE.ground]);
  for (const e of s.ents) if (e.unit) e.hp = 0;
  g.step();
  const centre = s.posts.find((p) => p.x === size / 2 && p.y === size / 2)!;
  /** A `kind` of `owner` at (x, y) in `frame`'s frame (nw's is the world's; se's is turned half a turn). */
  const put = (owner: ArmyId, frame: ArmyId, kind: 'trooper' | 'tank', x: number, y: number): Ent => {
    const e = s.spawnUnit(slotOfArmyId(owner, 2), kind, 'surface');
    [e.x, e.y] = frame === 'nw' ? [x, y] : [size - x, size - y];
    return e;
  };
  const squads = new Map<ArmyId, Ent[]>();
  const tanks = new Map<ArmyId, Ent>();
  for (const team of TEAMS) squads.set(team, [put(team, team, 'trooper', 10.5, 24.5), put(team, team, 'trooper', 11.5, 24.5), put(team, team, 'trooper', 10.5, 25.5)]);
  if (tank) for (const team of TEAMS) {
    const t = put(foeOf(team), team, 'tank', 16.5, 29);
    t.stance = 'hold';
    tanks.set(team, t);
  }
  for (const [k, e] of squads.get('nw')!.entries()) expect(e.seq).toBe(squads.get('se')![k]!.seq);
  if (tank) expect(tanks.get('nw')!.seq).toBe(tanks.get('se')!.seq);
  const memory = new Map<ArmyId, Map<string, PointMember>>(TEAMS.map((team) => [team, new Map()]));
  /** Orders per squad member (by its army's own names: twins share them), and each tick's positions of nw's squad. */
  const orders = new Map<ArmyId, Map<string, number>>(TEAMS.map((team) => [team, new Map()]));
  const track: [number, number][][] = [];
  /** Play the bots' point-squad orders until tick `until`. */
  const run = (until: number): void => {
    while (s.tick < until) {
      if (s.tick % BOT_PERIOD === 0) {
        const decided = TEAMS.map((team) => {
          const seat = { team, role: 'surface' } as const;
          const data = g.matchData(seat);
          const c = new Ctx(g.observe(seat, 0), data, unpackTerrain(data.terrain, size));
          const out: AgentCommandIntent[] = [];
          pointOrders(c, tier, c.own.filter((e) => e.kind === 'trooper'), out, memory.get(team)!, false, new Set());
          return out;
        });
        expect(decided[1]!.map((i) => i.kind)).toEqual(decided[0]!.map((i) => i.kind));
        // One simultaneous round, as the host applies a decision round.
        s.round(() => TEAMS.forEach((team, k) => {
          for (const intent of decided[k]!) {
            expect(g.apply({ team, role: 'surface' }, intent)).toEqual({ ok: true });
            const counts = orders.get(team)!;
            if (intent.kind === 'attack' || intent.kind === 'move') for (const u of intent.units) counts.set(u, (counts.get(u) ?? 0) + 1);
          }
        }));
      }
      g.step();
      for (const [k, e] of squads.get('nw')!.entries()) {
        const twin = squads.get('se')![k]!;
        expect([e.x + twin.x, e.y + twin.y, e.hp, e.state]).toEqual([size, size, twin.hp, twin.state]);
      }
      if (tank) expect(tanks.get('nw')!.hp).toBe(tanks.get('se')!.hp);
      track.push(squads.get('nw')!.map((e) => [e.x, e.y]));
    }
  };
  return { g, s, centre, squads, tanks, orders, track, run };
}

describe('point squads at a cliff pinch', () => {
  it('settle: each member walks to a seat on its side of the point once and stays, never pacing back and forth (mirrored)', () => {
    const { g, s, centre, squads, orders, track, run } = pinch(false);
    run(tier.pointAt + toTicks(60));
    for (const team of TEAMS) {
      // One walk onto a seat each, not an order every decision (sent the point order again every 0.5 s, the spare
      // members paced the canyon floor for the whole match, never settling).
      for (const e of squads.get(team)!) expect(orders.get(team)!.get(g.entityId(team, e.id))).toBe(1);
      // The seats on its own side of the pinch inside the capture radius hold the whole squad.
      for (const e of squads.get(team)!) expect(Math.hypot(e.x - centre.x, e.y - centre.y)).toBeLessThanOrEqual(s.econ.postCaptureRadius);
    }
    // Everyone came to rest: nobody moved over the last 20 seconds.
    const late = track.slice(-toTicks(20));
    for (const frame of late) expect(frame).toEqual(late[0]);
  });

  it('a squad that meets a hostile tank on its way fights it through: no order cuts the fight short (mirrored)', () => {
    const { g, squads, tanks, orders, run } = pinch(true);
    run(tier.pointAt + toTicks(30));
    for (const team of TEAMS) {
      for (const e of squads.get(team)!) expect(orders.get(team)!.get(g.entityId(team, e.id)) ?? 0).toBeLessThanOrEqual(2);
      expect(tanks.get(team)!.hp).toBeLessThan(tanks.get(team)!.maxHp);
    }
  });
});
