import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { CELL, DEFAULT_RULES, SURFACE, observationSchema, toTicks, type RockResourceType, type RockSize } from '../src/rules/contract.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { cellOf } from '../src/util/grid.ts';
import { type Ent } from '../src/sim/ent.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

const steps = (g: AgentCommandGame, n: number): void => { for (let i = 0; i < n; i++) g.step(); };
// Impacts land on the map centre: keep the Mother Lode (it stays solid under a crater) out of these maps.
const game = () => createGame({ seed: 31, options: { terrain: 'open', map: { params: { motherLode: { enabled: false } } }, spire: { dmg: 0 }, orbit: { maxAsteroids: 0 } } });
function rock(g: AgentCommandGame, size: RockSize = 'medium', resourceType: RockResourceType = 'metal', x = 24, y = 24, volatile = false): Ent {
  const a = g.sim.add('asteroid', NEUTRAL, 'orbit', x, y);
  a.rockSize = size;
  a.resourceType = resourceType;
  a.volatile = volatile;
  const yieldValue = g.sim.rocks[size].dockYield[resourceType];
  a.resourceRemaining = yieldValue.alloy + yieldValue.energy;
  a.hp = a.maxHp = g.sim.rocks[size].hp;
  a.state = 'drifting';
  return a;
}
function impact(g: AgentCommandGame, a: Ent, x = 24, y = 24, by: 'nw' | 'se' = 'nw'): void {
  expect(g.sim.dropPayload(a, slotOfArmyId(by, 2), x, y)).toBe(true);
  g.sim.tick = a.impactTick - 1;
  g.step();
}

describe('rock sizes and shared payloads', () => {
  it.each([
    ['pebble', 60, 0.9, 30, 120, 1.5, 4],
    ['medium', 300, 0.5, 150, 600, 3, 8],
    ['large', 800, 0.3, 400, 1500, 4.5, 12],
  ] as const)('%s uses the complete design row', (size, hp, tow, dock, damage, radius, seconds) => {
    const g = game();
    const a = rock(g, size);
    const row = g.sim.rocks[size];
    expect([row.hp, row.tow, row.dockYield.metal.alloy, row.drops.metal.impact.damage, row.drops.metal.impact.radius, row.drops.metal.warning]).toEqual([hp, tow, dock, damage, radius, toTicks(seconds)]);
    const tug = g.sim.add('tug', BLUE, 'orbit', 15, 15);
    tug.link = a.id; a.link = tug.id; a.state = 'towed';
    expect(g.sim.baseSpeed(tug)).toBe(g.sim.stats.tug.speed / 20 * tow);
    g.sim.deorbit(tug, a, 20, 20);
    expect(a.impactTick).toBe(g.tick + toTicks(seconds));
    expect(a.plane).toBe('sky');
  });

  it('credits docking only at a live own Orbit segment', () => {
    const g = game();
    const s = g.sim;
    const tug = s.add('tug', BLUE, 'orbit', s.spireAt[RED]!.x, s.spireAt[RED]!.y);
    const a = rock(g, 'large'); a.link = tug.id; tug.link = a.id; a.state = 'towed';
    g.step();
    expect(a.dead).toBe(false);
    tug.x = s.spireAt[BLUE]!.x; tug.y = s.spireAt[BLUE]!.y;
    s.armies[BLUE]!.spire.orbit.hp = 0;
    g.step();
    expect(a.dead).toBe(false);
    // A different live game docks once and never double-credits.
    const live = game();
    const t = live.sim.add('tug', BLUE, 'orbit', live.sim.spireAt[BLUE]!.x, live.sim.spireAt[BLUE]!.y);
    const r = rock(live, 'large'); r.link = t.id; t.link = r.id; r.state = 'towed';
    const mined = live.sim.armies[BLUE]!.stats.alloyMined;
    live.step();
    expect(r.dead).toBe(true);
    expect(t.link).toBe(0);
    expect(live.sim.armies[BLUE]!.stats.alloyMined - mined).toBe(400);
    live.step();
    expect(live.sim.armies[BLUE]!.stats.alloyMined - mined).toBe(400);
  });

  it('mirrors seeded size, resource type, volatility and drift', () => {
    const g = createGame({ seed: 5, options: { orbit: { pebbleChance: 1, metalChance: 1, iceChance: 0, volatileChance: 1 } } });
    g.sim.tick = g.sim.nextAsteroidSpawn() - 1;
    g.step();
    const [a, b] = g.sim.ents.filter((e) => e.kind === 'asteroid');
    expect(a!.rockSize).toBe('pebble'); expect(a!.resourceType).toBe('metal'); expect(a!.volatile).toBe(true);
    expect(b!.rockSize).toBe(a!.rockSize); expect(b!.resourceType).toBe(a!.resourceType); expect(b!.volatile).toBe(a!.volatile);
    expect(a!.x + b!.x).toBe(g.sim.size); expect(a!.y + b!.y).toBe(g.sim.size);
    expect(a!.vx).toBe(-b!.vx); expect(a!.vy).toBe(-b!.vy);
    expect(b!.resourceRemaining).toBe(a!.resourceRemaining);
  });
});

describe('resource visibility', () => {
  it('publishes warnings without leaking unseen resources, then reveals with scan vision', () => {
    const g = game();
    const a = rock(g, 'pebble', 'metal');
    // Unseen: Red has no name for it and its view holds no rock (maxAsteroids 0: this is the only one).
    expect(g.sim.aliasOf(RED, a.id)).toBe(0);
    expect(g.view('se').entities.some((e) => e.kind === 'asteroid')).toBe(false);
    g.sim.dropPayload(a, BLUE, 23, 23);
    g.sim.computeVision(); // the falling rock is public: Red names it at the next vision refresh
    const id = g.entityId('se', a.id);
    const hidden = g.view('se').entities.find((e) => e.id === id)!;
    expect(hidden.rockSize).toBe('pebble');
    expect(hidden.resourceType).toBeUndefined();
    expect(hidden.volatile).toBeUndefined();
    expect(hidden.resourceRemaining).toBeUndefined();
    g.sim.scan(RED, a.x, a.y);
    expect(g.view('se').entities.find((e) => e.id === id)!.resourceType).toBe('metal');
    g.sim.armies[RED]!.scans.length = 0;
    steps(g, VISION_EVERY);
    expect(g.view('se').entities.find((e) => e.id === id)!.resourceType).toBeUndefined();
    expect(validate(observationSchema, g.observe({ team: 'se', role: 'surface' }, 0)).ok).toBe(true);
  });

  it('does not expose caches, underground shares or scorch through fog', () => {
    const g = game();
    impact(g, rock(g, 'medium', 'metal'));
    expect(g.view('se').oreCaches).toEqual([]);
    g.sim.scan(RED, 24, 24);
    const cache = g.view('se').oreCaches[0]!;
    expect(cache.below).toBeDefined();
    expect(cache.alloy + cache.below!.alloy).toBe(300);
    const volatile = game();
    impact(volatile, rock(volatile, 'pebble', 'metal', 24, 24, true));
    expect(volatile.view('se').scorches).toEqual([]);
    volatile.sim.scan(RED, 24, 24);
    expect(volatile.view('se').scorches).toHaveLength(1);
  });
});

describe('ore cache salvage race', () => {
  it('moves all ore off structures, cliffs and crater holes onto the nearest open ground', () => {
    const g = game();
    const s = g.sim;
    const a = rock(g, 'medium', 'metal');
    s.add('shaft', RED, 'surface', 26, 24);
    const cliff = cellOf(22.5, 24.5, g.sim.size); s.terrain[cliff] = SURFACE.cliff; s.block[cliff] = 1;
    impact(g, a);
    const c = s.oreCaches[0]!;
    expect(c.alloy + c.belowAlloy).toBe(300);
    expect(c.alloy + c.belowAlloy).toBeGreaterThan(s.rocks.medium.dockYield.metal.alloy);
    const at = cellOf(c.x, c.y, g.sim.size);
    expect(s.block[at]).toBe(0); expect(s.structureOver(at)).toBe(false);
    expect(s.holes[at]).toBe(0); expect(s.terrain[at]).not.toBe(SURFACE.cliff);
    const distance = (c.x - 24) ** 2 + (c.y - 24) ** 2;
    for (let i = 0; i < g.sim.size * g.sim.size; i++) if (!s.block[i] && !s.structureOver(i)) {
      expect((i % g.sim.size + 0.5 - 24) ** 2 + (Math.floor(i / g.sim.size) + 0.5 - 24) ** 2).toBeGreaterThanOrEqual(distance);
    }
  });

  it('collects one load per interval; contests and ownership changes reset progress', () => {
    const g = game();
    impact(g, rock(g, 'pebble', 'metal'));
    const c = g.sim.oreCaches[0]!;
    const blue = g.sim.add('flak', BLUE, 'surface', c.x, c.y);
    const red = g.sim.add('flak', RED, 'surface', c.x, c.y);
    blue.stance = red.stance = 'hold';
    const mined = g.sim.armies[BLUE]!.stats.alloyMined;
    steps(g, g.sim.econ.oreCacheTicks + 1);
    expect(c.alloy).toBe(60); expect(c.surfaceTicks).toBe(0);
    red.x = 40; red.y = 40;
    steps(g, g.sim.econ.oreCacheTicks - 1);
    expect(c.alloy).toBe(60);
    g.step();
    expect(c.alloy).toBe(30);
    expect(g.sim.armies[BLUE]!.stats.alloyMined - mined).toBe(30);
    red.x = c.x; red.y = c.y;
    g.step(); expect(c.surfaceTicks).toBe(0);
    blue.x = 5; blue.y = 5;
    steps(g, g.sim.econ.oreCacheTicks);
    expect(g.sim.armies[RED]!.stats.alloyMined).toBe(30);
    expect(g.sim.oreCaches).toHaveLength(0);
  });

  it('reserves an underground share only for an open crater and lets diggers mine it', () => {
    const g = game();
    impact(g, rock(g, 'medium', 'metal'));
    const c = g.sim.oreCaches[0]!;
    expect(c.belowAlloy).toBe(75);
    expect(g.sim.cells[cellOf(c.belowX, c.belowY, g.sim.size)]).toBe(CELL.tunnel);
    const digger = g.sim.add('digger', BLUE, 'depths', c.belowX, c.belowY);
    digger.stance = 'hold';
    steps(g, g.sim.econ.oreCacheTicks);
    expect(c.belowAlloy).toBe(45); expect(c.alloy).toBe(225);
    const pebble = game(); impact(pebble, rock(pebble, 'pebble', 'metal'));
    expect(pebble.sim.oreCaches[0]!.belowAlloy).toBe(0);
  });

  it('keeps every load while no Surface ground is open, then places it when space opens', () => {
    const g = game();
    g.sim.block.fill(1);
    impact(g, rock(g, 'pebble', 'metal'));
    const c = g.sim.oreCaches[0]!;
    expect(c.placed).toBe(false);
    expect(c.alloy).toBe(60);
    g.sim.block[cellOf(28.5, 24.5, g.sim.size)] = 0;
    g.step();
    expect(c.placed).toBe(true);
    expect([c.x, c.y, c.alloy]).toEqual([28.5, 24.5, 60]);
  });

  it('lets non-mining Depths troops contest the underground digger share', () => {
    const g = game();
    impact(g, rock(g, 'medium', 'metal'));
    const c = g.sim.oreCaches[0]!;
    const blue = g.sim.add('digger', BLUE, 'depths', c.belowX, c.belowY);
    const red = g.sim.add('flak', RED, 'depths', c.belowX, c.belowY);
    blue.stance = red.stance = 'hold';
    steps(g, g.sim.econ.oreCacheTicks);
    expect(c.belowAlloy).toBe(75);
    red.hp = 0;
    steps(g, g.sim.econ.oreCacheTicks);
    expect(c.belowAlloy).toBe(45);
  });

  it('places mirrored impacts and underground shares in exact point symmetry', () => {
    const g = game();
    const a = rock(g, 'medium', 'metal', 15, 20);
    const b = rock(g, 'medium', 'metal', g.sim.size - 15, g.sim.size - 20);
    g.sim.dropPayload(a, BLUE, 15, 20); g.sim.dropPayload(b, RED, g.sim.size - 15, g.sim.size - 20);
    g.sim.tick = a.impactTick - 1; g.step();
    const [left, right] = g.sim.oreCaches;
    expect(left!.x + right!.x).toBe(g.sim.size); expect(left!.y + right!.y).toBe(g.sim.size);
    expect(left!.belowX + right!.belowX).toBe(g.sim.size); expect(left!.belowY + right!.belowY).toBe(g.sim.size);
    expect(left!.alloy).toBe(right!.alloy); expect(left!.belowAlloy).toBe(right!.belowAlloy);
  });

  it('volatile payloads increase blast, scorch units, expire, and leave no ore', () => {
    const g = game();
    const a = rock(g, 'pebble', 'metal', 24, 24, true);
    const target = g.sim.add('turret', RED, 'surface', 26.5, 24.5);
    const hp = target.hp;
    impact(g, a);
    expect(target.hp).toBe(hp - 180);
    expect(g.sim.oreCaches).toHaveLength(0);
    const unit = g.sim.add('flak', BLUE, 'surface', 24, 24);
    const before = unit.hp; g.step();
    expect(unit.hp).toBeCloseTo(before - 8 / 20);
    g.sim.tick = g.sim.scorches[0]!.until - 1; g.step();
    expect(g.sim.scorches).toHaveLength(0);
  });

  it('keeps clones isolated and hashes resources, caches, collection and scorch deterministically', () => {
    const g = game(); impact(g, rock(g, 'medium', 'metal'));
    const c = g.sim.oreCaches[0]!;
    g.sim.add('flak', BLUE, 'surface', c.x, c.y);
    const twin = g.clone();
    expect(twin.stateHash()).toBe(g.stateHash());
    for (let i = 0; i < 80; i++) { g.step(); twin.step(); expect(twin.stateHash()).toBe(g.stateHash()); }
    const before = g.stateHash(); twin.sim.oreCaches[0]!.alloy++;
    expect(twin.stateHash()).not.toBe(before); expect(g.stateHash()).toBe(before);
    const v = rock(g, 'large', 'metal', 24, 24, true); const hash = g.stateHash(); v.volatile = false;
    expect(g.stateHash()).not.toBe(hash);
    const scorching = game(); impact(scorching, rock(scorching, 'pebble', 'metal', 24, 24, true));
    const scorchTwin = scorching.clone();
    expect(scorchTwin.stateHash()).toBe(scorching.stateHash());
    scorchTwin.sim.scorches[0]!.until++;
    expect(scorchTwin.stateHash()).not.toBe(scorching.stateHash());
  });
});

describe('holes near the map edge clip to the map', () => {
  const mapSize = DEFAULT_RULES.map.size;
  const mirrorCell = (c: number): number => mapSize * mapSize - 1 - c;
  /** In-bounds cells within `r` of (x, y), cliffs excluded: the crater an interior impact of that radius would open. */
  const footprint = (g: AgentCommandGame, x: number, y: number, r: number): number[] => {
    const out: number[] = [];
    for (let c = 0; c < mapSize * mapSize; c++) {
      const dx = c % mapSize + 0.5 - x;
      const dy = Math.floor(c / mapSize) + 0.5 - y;
      if (dx * dx + dy * dy <= r * r && g.sim.terrain[c] !== SURFACE.cliff) out.push(c);
    }
    return out;
  };
  const holes = (g: AgentCommandGame): number[] => {
    const out: number[] = [];
    for (let c = 0; c < mapSize * mapSize; c++) if (g.sim.holes[c]) out.push(c);
    return out;
  };

  // Corner and edge landing points in blue's frame; red drops on the point-mirrored spot.
  for (const [x, y, size] of [[0.3, 0.3, 'medium'], [0.5, 0.5, 'large'], [0.5, 24, 'medium'], [24, 0.4, 'large'], [1.2, 30, 'medium']] as const) {
    it(`an impact at ${x},${y} (${size}) opens its in-bounds cells, mirrored for both teams`, () => {
      const craters: Record<'nw' | 'se', number[]> = { nw: [], se: [] };
      for (const team of ['nw', 'se'] as const) {
        const g = game();
        const at = team === 'nw' ? { x, y } : { x: mapSize - x, y: mapSize - y };
        const bedrock = new Set<number>();
        for (let c = 0; c < mapSize * mapSize; c++) if (g.sim.cells[c] === CELL.bedrock) bedrock.add(c);
        impact(g, rock(g, size), at.x, at.y, team);
        const expected = footprint(g, at.x, at.y, g.sim.rocks[size].drops.metal.impact.crater);
        const opened = holes(g);
        expect(opened.length, `${team} crater cells`).toBeGreaterThan(0);
        expect(opened).toEqual(expected);
        // The rim is bedrock: the crater shows on the Surface but cuts no portal there; inner cells open as usual.
        for (const c of opened) expect(g.sim.cells[c], `cell ${c % mapSize},${Math.floor(c / mapSize)}`).toBe(bedrock.has(c) ? CELL.bedrock : CELL.tunnel);
        expect(opened.some((c) => bedrock.has(c))).toBe(true);
        craters[team] = opened;
      }
      expect(craters.se.map(mirrorCell).sort((a, b) => a - b)).toEqual(craters.nw);
    });
  }

  it('a collapse beside the rim opens its in-bounds sinkhole, mirrored for both teams', () => {
    const sinkholes: Record<'nw' | 'se', number[]> = { nw: [], se: [] };
    for (const team of ['nw', 'se'] as const) {
      const g = game();
      const c = team === 'nw' ? cellOf(1.5, 30.5, mapSize) : mirrorCell(cellOf(1.5, 30.5, mapSize));
      g.sim.cells[c] = CELL.tunnel;
      g.sim.plantCharge(slotOfArmyId(team, 2), c);
      steps(g, g.sim.econ.undermineTicks + 1);
      const opened = holes(g);
      expect(opened).toEqual(footprint(g, c % mapSize + 0.5, Math.floor(c / mapSize) + 0.5, g.sim.econ.collapseRadius));
      expect(opened.some((n) => n % mapSize === 0 || n % mapSize === mapSize - 1)).toBe(true);
      sinkholes[team] = opened;
    }
    expect(sinkholes.se.map(mirrorCell).sort((a, b) => a - b)).toEqual(sinkholes.nw);
  });

  it('a volatile impact in the corner scorches what stands there, mirrored for both teams', () => {
    const burnt: number[] = [];
    for (const team of ['nw', 'se'] as const) {
      const g = game();
      const at = team === 'nw' ? { x: 0.5, y: 0.5 } : { x: mapSize - 0.5, y: mapSize - 0.5 };
      impact(g, rock(g, 'medium', 'metal', 24, 24, true), at.x, at.y, team);
      expect(holes(g).length).toBeGreaterThan(0);
      const unit = g.sim.add('flak', team === 'nw' ? RED : BLUE, 'surface', team === 'nw' ? 1.2 : mapSize - 1.2, team === 'nw' ? 2.5 : mapSize - 2.5);
      const before = unit.hp;
      g.step();
      burnt.push(before - unit.hp);
    }
    expect(burnt[0]).toBeGreaterThan(0);
    expect(burnt[1]).toBe(burnt[0]);
  });
});
