/**
 * The Surface build radius (DESIGN §6): shafts, turrets and Headframes go only where the team's own live, completed
 * Spire, Shafts and Headframes project radius, never in the enemy Spire's no-build zone. Every case runs for both
 * teams on mirrored sites and the two results must match.
 */
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { CELL, DEFAULT_RULES, STRUCTURE_SPACING, SURFACE, buildSiteError, matchDataSchema, type ArmyId } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import { applyIntent, type ApplyResult } from '../src/agent/intents.ts';
import { matchData } from '../src/agent/present.ts';
import { slotOfArmyId } from '../src/util/teams.ts';
import type { Sim } from '../src/sim/sim.ts';

/** Gives `team` Surface vision of cell `c`. */
const see = (s: Sim, team: ArmyId, c: number): void => {
  s.vis[1]![c]! |= s.armies[slotOfArmyId(team, 2)]!.group.bit;
};

const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

/** Only the Spires and islands as sources (home posts start neutral): tests lay out their own sites and sources. Default S48, Spire inset 3. */
function arena(seed = 9): AgentCommandGame {
  const g = createGame({ seed, options: { terrain: 'open', surface: { homePostsOwned: false } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  steps(g, VISION_EVERY);
  return g;
}

/** Blue's point (x, y), or red's point mirror. */
const at = (g: AgentCommandGame, team: ArmyId, x: number, y: number): { x: number; y: number } =>
  team === 'nw' ? { x, y } : { x: g.sim.size - x, y: g.sim.size - y };

/** A clear, visible 1×1 turret site with blue min anchor (x, y) (red: its mirror); returns the team's anchor. */
function turretSite(g: AgentCommandGame, team: ArmyId, x: number, y: number): { x: number; y: number } {
  const s = g.sim;
  const a = team === 'nw' ? { x, y } : { x: s.size - 1 - x, y: s.size - 1 - y };
  for (let cy = a.y - STRUCTURE_SPACING; cy <= a.y + STRUCTURE_SPACING; cy++) {
    for (let cx = a.x - STRUCTURE_SPACING; cx <= a.x + STRUCTURE_SPACING; cx++) {
      const c = cy * s.size + cx;
      s.terrain[c] = SURFACE.ground;
      s.cells[c] = CELL.rock;
      s.holes[c] = s.block[c] = 0;
      see(s, team, c);
    }
  }
  return a;
}

const turret = (g: AgentCommandGame, team: ArmyId, a: { x: number; y: number }): ApplyResult =>
  applyIntent(g.sim, slotOfArmyId(team, 2), 'surface', { kind: 'queue_add', item: 'turret', x: a.x, y: a.y });

/** A completed own structure at the blue point (x, y) (red: its mirror), standing outside the queue. */
function source(g: AgentCommandGame, team: ArmyId, kind: 'shaft' | 'turret' | 'headframe', x: number, y: number): Ent {
  const p = at(g, team, x, y);
  return g.sim.add(kind, slotOfArmyId(team, 2), 'surface', p.x, p.y);
}

/** Run `scenario` for both teams; the mirrored results must be identical. */
function mirrored<T>(scenario: (team: ArmyId) => T): T {
  const blue = scenario('nw');
  expect(scenario('se')).toEqual(blue);
  return blue;
}

describe('build radius placement', () => {
  it('accepts sites inside the Spire radius (boundary included) and refuses those beyond it', () => {
    const out = mirrored((team) => {
      const g = arena();
      // Blue Spire centre (3.5, 3.5), default radius 12: centres (11.5, 11.5) at 11.3, (15.5, 3.5) at exactly 12,
      // (12.5, 12.5) at 12.7.
      return [[11, 11], [15, 3], [12, 12]].map(([x, y]) => turret(g, team, turretSite(g, team, x!, y!)));
    });
    expect(out).toEqual([{ ok: true }, { ok: true }, { ok: false, code: 'out_of_radius' }]);
  });

  it('follows the match rule for the Spire radius', () => {
    mirrored((team) => {
      const g = createGame({ seed: 9, options: { terrain: 'open', surface: { buildRadiusSpire: 9, homePostsOwned: false } } });
      for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
      steps(g, VISION_EVERY);
      expect(turret(g, team, turretSite(g, team, 11, 11))).toEqual({ ok: false, code: 'out_of_radius' });
      expect(turret(g, team, turretSite(g, team, 9, 9))).toEqual({ ok: true });
    });
  });

  it('never builds inside the enemy Spire no-build zone, even inside an own radius', () => {
    const out = mirrored((team) => {
      const g = arena();
      // An own completed Shaft deep in enemy territory: its radius (7) covers both sites. Red Spire footprint edge at
      // 43: (36.5, 36.5) is 9.2 from it, (38.5, 38.5) only 6.4 (inside the default 8-tile zone).
      source(g, team, 'shaft', 34, 34);
      return [[36, 36], [38, 38]].map(([x, y]) => turret(g, team, turretSite(g, team, x!, y!)));
    });
    expect(out).toEqual([{ ok: true }, { ok: false, code: 'no_build_zone' }]);
  });

  it('extends the radius from a completed forward Headframe, not while it is still under construction', () => {
    mirrored((team) => {
      const g = arena();
      // The rich flank lode nearest blue's map corner (39.5, 8.5) zone; red uses its point mirror.
      const n = g.sim.size * g.sim.size;
      const blueLode = g.sim.lodes.find((l) => l.rich && l.c % g.sim.size > g.sim.size / 2)!;
      const lode = team === 'nw' ? blueLode : g.sim.lodes.find((l) => l.c === n - 1 - blueLode.c)!;
      const lx = lode.c % g.sim.size;
      const ly = Math.floor(lode.c / g.sim.size);
      // A turret 4 cells off the outcrop, on the side toward the map centre (blue frame).
      const blueX = (team === 'nw' ? lx : g.sim.size - 1 - lx) - 4;
      const blueY = team === 'nw' ? ly : g.sim.size - 1 - ly;
      const site = turretSite(g, team, blueX, blueY);
      expect(turret(g, team, site)).toEqual({ ok: false, code: 'out_of_radius' });
      const frame = g.sim.build(slotOfArmyId(team, 2), 'headframe', lx + 0.5, ly + 0.5, 'surface');
      expect(turret(g, team, site)).toEqual({ ok: false, code: 'out_of_radius' });
      frame.hp = frame.maxHp;
      frame.progress = 1 - 1e-9;
      g.step();
      expect(frame.built).toBe(true);
      expect(turret(g, team, site)).toEqual({ ok: true });
    });
  });

  it('places a Headframe on any known lode beyond the radius, but never in the enemy no-build zone', () => {
    mirrored((team) => {
      const g = arena();
      const n = g.sim.size * g.sim.size;
      const mine = (blue: (typeof g.sim.lodes)[number]) => (team === 'nw' ? blue : g.sim.lodes.find((l) => l.c === n - 1 - blue.c)!);
      const queue = (lode: (typeof g.sim.lodes)[number]) => {
        lode.known |= g.sim.armies[slotOfArmyId(team, 2)]!.group.bit;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) see(g.sim, team, lode.c + dy * g.sim.size + dx);
        return applyIntent(g.sim, slotOfArmyId(team, 2), 'surface', { kind: 'queue_add', item: 'headframe', x: lode.c % g.sim.size, y: Math.floor(lode.c / g.sim.size) });
      };
      // A rich flank lode some 36 tiles out: far beyond the Spire's radius, yet a lode needs none.
      const flank = mine(g.sim.lodes.find((l) => l.rich && l.c % g.sim.size > g.sim.size / 2)!);
      expect(queue(flank)).toEqual({ ok: true });
      // The enemy home lode nearest their Spire lies inside their no-build zone (home lodes are 6.5–10 from its centre).
      const red = g.sim.spireAt[slotOfArmyId('se', 2)]!;
      const near = g.sim.lodes.filter((l) => !l.rich).sort((a, b) => Math.hypot(a.c % g.sim.size + 0.5 - red.x, Math.floor(a.c / g.sim.size) + 0.5 - red.y)
        - Math.hypot(b.c % g.sim.size + 0.5 - red.x, Math.floor(b.c / g.sim.size) + 0.5 - red.y))[0]!;
      expect(queue(mine(near))).toEqual({ ok: false, code: 'no_build_zone' });
    });
  });

  it('does not let turrets project radius (no chain-creep)', () => {
    mirrored((team) => {
      const g = arena();
      source(g, team, 'turret', 14.5, 14.5);
      expect(turret(g, team, turretSite(g, team, 17, 17))).toEqual({ ok: false, code: 'out_of_radius' });
      source(g, team, 'shaft', 14, 14);
      expect(turret(g, team, turretSite(g, team, 17, 17))).toEqual({ ok: true });
    });
  });
});

describe('build radius in the queue', () => {
  it('cancels an unstarted site whose radius source dies, with nothing paid and a clear code', () => {
    const out = mirrored((team) => {
      const g = arena();
      const t = g.sim.armies[slotOfArmyId(team, 2)]!;
      const shaft = source(g, team, 'shaft', 14, 14);
      // No funds: the entry waits unpaid.
      t.alloy = 0;
      t.energy = 0;
      expect(turret(g, team, turretSite(g, team, 17, 17))).toEqual({ ok: true });
      g.step();
      expect(t.queue).toHaveLength(1);
      const alloy = t.alloy;
      shaft.hp = 0;
      g.step();
      expect(t.queue).toHaveLength(0);
      // Nothing was taken: the Spire trickle only adds.
      expect(t.alloy).toBeGreaterThanOrEqual(alloy);
      const ev = t.events.find((e) => e.kind === 'queue_cancelled')!;
      return { subject: ev.subject, code: ev.code, owner: ev.owner };
    });
    expect(out).toEqual({ subject: 'turret', code: 'out_of_radius', owner: 'surface' });
  });

  it('keeps building a site already under construction when its source dies', () => {
    mirrored((team) => {
      const g = arena();
      const t = g.sim.armies[slotOfArmyId(team, 2)]!;
      const shaft = source(g, team, 'shaft', 14, 14);
      expect(turret(g, team, turretSite(g, team, 17, 17))).toEqual({ ok: true });
      g.step();
      expect(t.queue[0]).toMatchObject({ item: 'turret', started: true });
      shaft.hp = 0;
      steps(g, 3);
      expect(t.queue[0]).toMatchObject({ item: 'turret', started: true });
      expect(t.events.some((e) => e.kind === 'queue_cancelled')).toBe(false);
    });
  });
});

describe('build radius for agents', () => {
  it('publishes the radius sources and no-build zone in matchData from the match rules', () => {
    const g = createGame({ seed: 9, options: { surface: { buildRadiusShaft: 5, enemySpireNoBuild: 10 } } });
    const data = matchData(g.sim, 0);
    expect(validate(matchDataSchema, data).ok).toBe(true);
    expect(data.buildRadius).toEqual({
      sources: [{ kind: 'spire', radius: DEFAULT_RULES.surface.buildRadiusSpire }, { kind: 'shaft', radius: 5 }, { kind: 'headframe', radius: DEFAULT_RULES.surface.buildRadiusHeadframe }, { kind: 'post', radius: DEFAULT_RULES.surface.postBuildRadius }],
      contestedPost: DEFAULT_RULES.surface.contestedPostBuildRadius,
      enemySpireNoBuild: 10,
      exempt: ['headframe'],
    });
  });

  it('lets an agent reproduce the sim verdict from its own observed entities and matchData alone', () => {
    mirrored((team) => {
      const g = arena();
      source(g, team, 'headframe', 16.5, 16.5);
      source(g, team, 'turret', 20.5, 20.5);
      const data = matchData(g.sim, g.sim.armyIndex(team));
      const enemy = data.armies.find((a) => a.id !== team)!.spireAt;
      const rules = DEFAULT_RULES.surface;
      const own = g.sim.ents.filter((e) => !e.dead && e.side === slotOfArmyId(team, 2) && e.plane === 'surface' && e.structure && e.built);
      const verdicts: (string | null)[] = [];
      for (const [x, y] of [[11, 11], [20, 20], [23, 23], [30, 30]]) {
        const site = turretSite(g, team, x!, y!);
        const shared = buildSiteError('turret', own, [enemy], site.x + 0.5, site.y + 0.5, rules);
        expect(g.sim.buildSiteError(slotOfArmyId(team, 2), 'turret', site.x + 0.5, site.y + 0.5)).toBe(shared);
        verdicts.push(shared);
      }
      expect(verdicts).toEqual([null, null, 'out_of_radius', 'out_of_radius']);
    });
  });
});
