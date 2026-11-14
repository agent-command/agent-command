/** Island capture: structure-carrying islands take longer and drain their structure; contests freeze. */
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { DEFAULT_RULES, islandAt, observationSchema, type ArmyId, type IslandStructure, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2);
const RED = slotOfArmyId('se', 2);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

/**
 * Spires and islands only, no weather. Each army holds one island of the innermost ring (the two are point mirrors)
 * carrying `kind`; returns the island blue holds first.
 */
function arena(kind?: IslandStructure, options: object = {}) {
  const g = createGame({ seed: 5, options: { sky: { stormSets: 0 }, ...options } });
  const s = g.sim;
  for (const e of s.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.step();
  const islands = s.ents.filter((e) => e.kind === 'island');
  const inner = Math.min(...islands.map((i) => i.orbitR));
  const pair = islands.filter((i) => i.orbitR === inner).sort((a, b) => a.id - b.id);
  const [mine, theirs] = pair as [Ent, Ent];
  const slots: Ent[] = [];
  for (const [isl, army] of [[mine, BLUE], [theirs, RED]] as const) {
    s.setSide(isl, army);
    if (!kind) continue;
    const slot = s.add(kind, army, 'sky', isl.x, isl.y);
    slot.link = isl.id;
    isl.link = slot.id;
    slots.push(slot);
  }
  return { g, s, mine, theirs, slots };
}

/** `kind` units of `army` ordered to capture `isl`, standing on it (deep hulls: Spire fire must not matter). */
function capturers(g: AgentCommandGame, army: ArmyId, kind: UnitKind, isl: Ent, n = 1): Ent[] {
  const units = Array.from({ length: n }, () => g.sim.spawnUnit(slotOfArmyId(army, 2), kind, 'sky'));
  for (const u of units) {
    u.x = isl.x;
    u.y = isl.y;
    u.hp = 50_000;
  }
  expect(g.apply({ team: army, role: 'sky' }, { kind: 'capture', units: units.map((u) => g.entityId(army, u.id)), island: g.entityId(army, isl.id) })).toEqual({ ok: true });
  return units;
}

describe('island capture', () => {
  it('one interceptor no longer deletes a 400-HP Aerie in captureTime: the capture takes captureStructureTime (mirrored)', () => {
    const { g, s, mine, theirs, slots } = arena('aerie');
    const [blueAerie, redAerie] = slots as [Ent, Ent];
    expect(blueAerie.maxHp).toBe(400);
    // Blue takes Red's island while Red takes Blue's: every tick the two captures are exact mirrors.
    capturers(g, 'nw', 'interceptor', theirs);
    capturers(g, 'se', 'interceptor', mine);
    for (let t = 0; t < s.econ.captureTicks + 1; t++) {
      g.step();
      expect(blueAerie.hp).toBe(redAerie.hp);
      expect(mine.progress).toBe(theirs.progress);
    }
    expect(theirs.side).toBe(RED);
    expect(redAerie.dead).toBe(false);
    expect(redAerie.hp).toBeGreaterThan(0);
    expect(theirs.state).toBe('capturing');
    steps(g, s.econ.captureStructureTicks - s.econ.captureTicks - 1);
    expect(theirs.side).toBe(BLUE);
    expect(mine.side).toBe(RED);
    expect(redAerie.hp).toBe(0);
    g.step();
    expect(redAerie.dead).toBe(true);
    expect(blueAerie.dead).toBe(true);
    expect(redAerie.lastHitCause).toBe('capture');
  });

  it('drains the structure at maxHp / captureStructureTime per second while the claim advances', () => {
    const { g, s, theirs, slots } = arena('relay');
    const relay = slots[1]!;
    // Bombers cannot shoot the Sky: the capture alone drains it.
    capturers(g, 'nw', 'bomber', theirs);
    const ticks = Math.floor(s.econ.captureStructureTicks / 2);
    steps(g, ticks);
    expect(relay.hp).toBeCloseTo(relay.maxHp * (1 - ticks / s.econ.captureStructureTicks), 6);
    expect(theirs.progress).toBeCloseTo(ticks / s.econ.captureStructureTicks, 6);
    expect(theirs.side).toBe(RED);
    steps(g, s.econ.captureStructureTicks - ticks);
    expect(theirs.side).toBe(BLUE);
  });

  it('a damaged structure falls sooner, and the island then goes at captureTime', () => {
    const { g, s, theirs, slots } = arena('relay');
    const relay = slots[1]!;
    relay.hp = relay.maxHp / 4;
    capturers(g, 'nw', 'bomber', theirs);
    const fall = Math.ceil(s.econ.captureStructureTicks / 4);
    expect(fall).toBeLessThan(s.econ.captureTicks);
    steps(g, fall + 1);
    expect(relay.dead).toBe(true);
    expect(theirs.side).toBe(RED);
    steps(g, s.econ.captureTicks - fall - 2);
    expect(theirs.side).toBe(RED);
    g.step();
    expect(theirs.side).toBe(BLUE);
  });

  it('empty islands and structures still under construction keep captureTime', () => {
    for (const building of [false, true]) {
      const { g, s, theirs, slots } = arena(building ? 'aerie' : undefined);
      if (building) slots[1]!.built = false;
      capturers(g, 'nw', 'bomber', theirs);
      steps(g, s.econ.captureTicks - 1);
      expect(theirs.side).toBe(RED);
      g.step();
      expect(theirs.side).toBe(BLUE);
      if (building) expect(slots[1]!.hp).toBe(0);
    }
  });

  it('the capturer has landed: it sees the slot structure that paces its capture, even inside a storm', () => {
    const { g, s, theirs, slots } = arena('relay');
    const relay = slots[1]!;
    // A Red seeded storm covers the island (and the relay on it) but not a Blue bomber on the island's far side.
    const seeder = s.add('storm_seeder', RED, 'sky', theirs.x + s.econ.seederRadius - 1.5, theirs.y);
    seeder.activeUntil = s.tick + s.econ.seederDuration;
    const bomber = s.spawnUnit(BLUE, 'bomber', 'sky');
    // Just outside the capture radius first, then on the island.
    let reach = s.econ.captureRadius + 0.5;
    const place = () => {
      bomber.x = theirs.x - reach;
      bomber.y = theirs.y;
    };
    place();
    g.step();
    place();
    expect(theirs.capT).toBe(0);
    expect(s.stormAt(relay.x, relay.y)).toBe(true);
    expect(s.stormAt(bomber.x, bomber.y)).toBe(false);
    expect(s.sees(BLUE, relay)).toBe(false);
    reach = s.econ.captureRadius - 0.5;
    place();
    for (let t = 0; t < 3; t++) {
      g.step();
      place();
    }
    expect(theirs.capSide).toBe(BLUE);
    expect(s.sees(BLUE, relay)).toBe(true);
    const obs = g.observe({ team: 'nw', role: 'sky' }, 0);
    expect(obs.entities.find((e) => e.id === g.entityId('nw', theirs.id))).toMatchObject({ state: 'capturing', link: g.entityId('nw', relay.id), progress: expect.any(Number) });
    expect(obs.entities.some((e) => e.id === g.entityId('nw', relay.id))).toBe(true);
  });

  it('hostile alliances on an island together freeze the capture and the drain (contested)', () => {
    const { g, s, theirs, slots } = arena('relay');
    const relay = slots[1]!;
    capturers(g, 'nw', 'bomber', theirs);
    steps(g, s.econ.captureTicks);
    const progress = theirs.progress;
    const hp = relay.hp;
    const [guard] = capturers(g, 'se', 'bomber', theirs);
    steps(g, s.econ.captureStructureTicks);
    expect(theirs.state).toBe('contested');
    expect(theirs.side).toBe(RED);
    expect(theirs.progress).toBe(progress);
    expect(relay.hp).toBe(hp);
    // The defender leaves: the capture resumes where it stopped.
    guard!.hp = 0;
    steps(g, 2);
    expect(theirs.state).toBe('capturing');
    expect(theirs.progress).toBeGreaterThan(progress);
  });
});

describe('island_contested alert', () => {
  const skyAlerts = (g: AgentCommandGame, team: ArmyId) => {
    const obs = g.observe({ team, role: 'sky' }, 0);
    expect(validate(observationSchema, obs).ok).toBe(true);
    expect(g.view(team).alerts).toEqual(obs.alerts);
    return obs.alerts.filter((a) => a.plane === 'sky');
  };

  it('warns the holder of an island being taken, first, and nobody else', () => {
    const { g, s, theirs } = arena();
    capturers(g, 'nw', 'bomber', theirs);
    steps(g, VISION_EVERY);
    expect(s.sees(RED, s.ents.find((e) => e.kind === 'bomber')!)).toBe(false);
    // Red's own island reports its state and progress from anywhere: the alert needs no vision of the capturer.
    const [first] = skyAlerts(g, 'se');
    expect(first).toEqual({ plane: 'sky', kind: 'island_contested', x: expect.any(Number), y: expect.any(Number) });
    expect(first).toMatchObject({ x: Math.floor(theirs.x) + 0.5, y: Math.floor(theirs.y) + 0.5 });
    // The capturer is not warned about its own capture.
    expect(skyAlerts(g, 'nw').some((a) => a.kind === 'island_contested')).toBe(false);
  });

  it('reveals nothing about a hidden capture of an island the team does not hold (twin worlds)', () => {
    const sees = (withRed: boolean) => {
      const { g, s } = arena();
      const neutral = s.ents.filter((e) => e.kind === 'island' && e.side !== BLUE && e.side !== RED)
        .sort((a, b) => Math.hypot(b.x - 4, b.y - 4) - Math.hypot(a.x - 4, a.y - 4))[0]!;
      if (withRed) capturers(g, 'se', 'bomber', neutral);
      steps(g, VISION_EVERY * 2);
      expect(s.seesCell(BLUE, 'sky', Math.floor(neutral.y) * s.size + Math.floor(neutral.x))).toBe(false);
      if (withRed) expect(neutral.state).toBe('capturing');
      const obs = g.observe({ team: 'nw', role: 'sky' }, 0);
      return { alerts: obs.alerts, island: obs.entities.find((e) => e.id === g.entityId('nw', neutral.id)) };
    };
    expect(sees(true)).toEqual(sees(false));
  });
});

describe('ordinary island clearance', () => {
  it('keeps public circular paths and island clearance without mooring', () => {
    const { g, s } = arena();
    const paths = g.observe({ team: 'nw', role: 'sky' }, 0).islands;
    const islands = s.ents.filter(e => e.kind === 'island');
    for (let tick = 0; tick < 120; tick++) {
      g.step();
      for (let i = 0; i < islands.length; i++) {
        const island = islands[i]!;
        const path = paths.find(p => p.id === g.entityId('nw', island.id))!;
        expect(islandAt(path, s.tick).x).toBeCloseTo(island.x, 3);
        for (let j = i + 1; j < islands.length; j++) {
          expect(Math.hypot(island.x - islands[j]!.x, island.y - islands[j]!.y)).toBeGreaterThanOrEqual(DEFAULT_RULES.map.islandClearance - 0.002);
        }
      }
    }
  });
});
