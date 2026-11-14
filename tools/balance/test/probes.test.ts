/**
 * Every strategy probe loads in the PlayerThree JS sandbox and emits only schema-valid intents for its seat, in every
 * layout it plays, and the game accepts at least 80% of them: a probe whose orders bounce measures nothing.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { intentSchema, validate } from 'playerthree';
import { loadPolicy, type PolicyInstance } from 'playerthree/policy';
import { BOT_PERIOD, CELL, createBot, createGame, manifest, PLANES, toTicks, type AgentCommandIntent, type Plane } from '@agent-command/game';
import { PROBES, probeSource } from '../src/probes.ts';
import { LAYOUT_ARMIES, layoutArmies } from '../src/spec.ts';

const instances: PolicyInstance[] = [];
afterAll(() => {
  for (const i of instances) i.dispose();
});

describe('strategy probes', () => {
  for (const probe of PROBES) {
    for (const layout of probe.layouts) {
      // The probe drives the second slot's army (frame 2 in a duel, frame 1 in FFA): its frame maths are exercised.
      it(`${probe.id} plays a minute of ${layout} with valid intents`, async () => {
        const slots = LAYOUT_ARMIES[layout];
        const game = createGame({ seed: 5, options: slots === 2 ? {} : { map: { params: { slots } } } });
        const armies = layoutArmies(layout);
        expect(game.sim.armyIds).toEqual(armies);
        const army = armies[1]!;
        const seats = await Promise.all(
          Object.entries(probe.seats).map(async ([role, file]) => {
            const r = await loadPolicy('js', probeSource(file), manifest.control.policy, { seed: 1, matchData: game.matchData({ team: army, role: role as Plane }) });
            if (!r.ok) throw new Error(`${file}: ${r.error.code} ${r.error.message ?? ''}`);
            instances.push(r.instance);
            return { role: role as Plane, policy: r.instance };
          }),
        );
        const bots = armies.flatMap((team) =>
          PLANES.filter((role) => team !== army || !(role in probe.seats)).map((role) => ({ seat: { team, role }, bot: createBot(team, role, 'standard') })),
        );
        for (const { seat, bot } of bots) bot.init?.(game.matchData(seat));
        const wire = intentSchema(manifest);
        let emitted = 0;
        const rejected: Record<string, number> = {};
        while (game.tick < toTicks(60)) {
          if (game.tick % BOT_PERIOD === 0) {
            // Every seat observes the start-of-tick world before any intent lands (as PlayerThreeHost and playBotMatch do).
            const since = Math.max(0, game.tick - BOT_PERIOD);
            const botIntents = bots.map((b) => b.bot.think(game.observe(b.seat, since)));
            const calls = await Promise.all(seats.map((s) => s.policy.call(game.observe({ team: army, role: s.role }, since))));
            for (const [i, s] of seats.entries()) {
              const r = calls[i]!;
              if (!r.ok) throw new Error(`${probe.id} (${s.role}) at tick ${game.tick}: ${r.error.code} ${r.error.message ?? ''}`);
              for (const raw of r.value.intents) {
                expect(validate(wire, raw).ok).toBe(true);
                const intent = raw as AgentCommandIntent; // validated against the wire schema just above
                expect(manifest.intents[intent.kind].roles).toContain(s.role);
                const result = game.apply({ team: army, role: s.role }, intent, { source: 'policy' });
                if (!result.ok) rejected[`${intent.kind}:${result.code}`] = (rejected[`${intent.kind}:${result.code}`] ?? 0) + 1;
                emitted++;
              }
            }
            for (const [i, b] of bots.entries()) for (const intent of botIntents[i]!) game.apply(b.seat, intent, { source: 'bot' });
          }
          game.step();
        }
        expect(emitted).toBeGreaterThan(0);
        const bounced = Object.values(rejected).reduce((a, b) => a + b, 0);
        expect(bounced / emitted, `rejected ${bounced} of ${emitted}: ${JSON.stringify(rejected)}`).toBeLessThan(0.2);
      });
    }
  }
});

describe('sapper-swarm', () => {
  it('charges the nearest known tunnel cell in collapse reach of the focus Spire, and the collapse lands', async () => {
    const game = createGame({ seed: 5 });
    const { sim } = game;
    for (const e of sim.ents) if (e.unit) e.hp = 0;
    game.step();
    // se (frame 2) drives the probe against nw's Spire at (3.5, 3.5): a known tunnel along row 6 from x 12 to x 5.
    // Cell (6, 6) is the first one within collapseRadius + collapseStructureReach (2.5) of the footprint edge; (5, 6) is
    // nearer the Spire but farther along the tunnel.
    const known = sim.armies[1]!.group.known;
    for (let x = 5; x <= 12; x++) {
      sim.digCell(6 * sim.size + x, 1);
      known[6 * sim.size + x] = CELL.tunnel;
    }
    for (let i = 0; i < 2; i++) sim.add('sapper', 1, 'depths', 12.5, 6.5);
    const r = await loadPolicy('js', probeSource('sapper-swarm.js'), manifest.control.policy, { seed: 1, matchData: game.matchData({ team: 'se', role: 'depths' }) });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.message ?? ''}`);
    instances.push(r.instance);
    const spire = sim.armies[0]!.spire.surface;
    const hp = spire.hp;
    const charges: { x: number; y: number }[] = [];
    while (game.tick < toTicks(30) && spire.hp === hp) {
      if (game.tick % BOT_PERIOD === 0) {
        const call = await r.instance.call(game.observe({ team: 'se', role: 'depths' }, Math.max(0, game.tick - BOT_PERIOD)));
        if (!call.ok) throw new Error(call.error.code);
        for (const raw of call.value.intents) {
          const intent = raw as AgentCommandIntent;
          const result = game.apply({ team: 'se', role: 'depths' }, intent, { source: 'policy' });
          if (intent.kind === 'undermine') {
            expect(result.ok).toBe(true);
            charges.push({ x: intent.x, y: intent.y });
          }
        }
      }
      game.step();
    }
    expect(charges[0]).toEqual({ x: 6, y: 6 });
    expect(hp - spire.hp).toBe(sim.econ.collapseDamage);
  });
});
