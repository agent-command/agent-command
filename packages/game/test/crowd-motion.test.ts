/**
 * Large hulls in crowds and round the derelict ruin (user reports: Bastions and other large units get stuck, clump and
 * jitter in place; units moving round the very edge of the hull jerk around). Scripted scenarios (crowd-scenarios.ts)
 * run once per army of a C2 and a C4 map: every army's trajectory must be the exact rotation of the first's, and every
 * scenario must arrive in time, settle, keep hulls apart, not rock in place and not weave or jerk along the ruin.
 */
import { describe, expect, it } from 'vitest';
import { hullLineClear } from '../src/nav/nav.ts';
import { SURFACE, toTicks } from '../src/rules/contract.ts';
import { CHAMBER, derelictLayer, gatesOpen, throughAperture, WALL_CLEAR, wallBlocks } from '../src/rules/derelict.ts';
import { SEP_DEADBAND } from '../src/sim/constants.ts';
import { canonX, canonY, rotCell, rotX, rotY } from '../src/util/teams.ts';
import { arenaGame, fmt, runScenario, SCENARIOS } from './crowd-scenarios.ts';

/** Seconds (after its order) by which every unit of the scenario has arrived; before the fixes most never did. */
const ARRIVE: Record<string, number> = {
  'bastions: 6 to one point': 14,
  'bastions: 6 single orders, one point': 22,
  'bastions: two waves, one point': 36,
  'mixed wedge past the derelict hull': 40,
  'fleet circling the hull': 50,
  'ships through the breaches': 22,
  'bastions attack beside a parked fleet': 35,
  // A full 1.2-tile tank hull makes this a single-file passage, not the old centre-only two-lane shortcut.
  // Require arrival within the scenario's bounded runtime instead of pinning its obsolete 18-second trajectory.
  'tanks + flak into a crowded rally': 24,
};
/**
 * Weaving: turns that swing back against the last real turn, per unit second. Following the hull's circle or a
 * breach's axis is smooth now (0.1-0.4/s); jerking along the wall was 1.4-2.9/s round the hull and 0.4/s through
 * the breaches.
 */
const WIGGLE: Record<string, number> = { 'mixed wedge past the derelict hull': 0.3, 'fleet circling the hull': 0.5, 'ships through the breaches': 0.3 };
const WIGGLE_ANY = 0.6;
/** Mean heading change per travelling tick (rad) going round the hull: 0.024-0.034 when it jerked, 0.004-0.007 smooth. */
const TURN_ROUND: Record<string, number> = { 'mixed wedge past the derelict hull': 0.012, 'fleet circling the hull': 0.012 };
/** Mean per-axis step sign flips per unit second, and the worst single unit's while it moves. */
const FLIPS = 0.35;
const FLIPS_WORST = 1.2;
/** Steps per unit second turning back on the last one (rocking in place). */
const REVERSALS = 0.06;
/** Longest a pair may stay overlapped deeper than 0.1 tiles (seconds). */
const OVERLAP_HOLD = 0.5;

describe('crowd motion: large hulls and tanks arrive, settle and never rock, weave or jerk', () => {
  for (const s of SCENARIOS) {
    for (const sides of [2, 4] as const) {
      it(`${s.name} (${sides === 2 ? 'C2' : 'C4'}, every army)`, () => {
        const trail: number[][] = [];
        const runs = Array.from({ length: sides }, (_, army) => {
          const previous = new Map<number, [number, number]>();
          const goals = new Map<number, [number, number]>();
          const choke = s.name === 'tanks: 8 through a 2-tile choke';
          return runScenario({
            ...s,
            build(c) {
              const units = s.build(c);
              for (const e of units) {
                previous.set(e.id, [e.x, e.y]);
                if (e.order.k === 'move') goals.set(e.id, [e.order.x, e.order.y]);
              }
              return units;
            },
          }, sides, army, (tick, units, sim) => {
            if (!choke) return;
            const positions: number[] = [];
            for (const e of units) {
              const p = previous.get(e.id)!;
              expect(hullLineClear(sim.block, p[0], p[1], e.x, e.y, e.radius, e.frame, sim.size), `hull sweep tick ${tick}`).toBe(true);
              previous.set(e.id, [e.x, e.y]);
              const x = canonX(e.frame, e.x, e.y, sim.size), y = canonY(e.frame, e.x, e.y, sim.size);
              positions.push(x, y);
              // A queue at the entrance is not arrival: no destination replacement before the whole hull exits.
              if (y - e.radius <= sim.size / 2) {
                expect(e.order.k, `queued order tick ${tick}`).toBe('move');
                if (e.order.k === 'move') expect([e.order.x, e.order.y]).toEqual(goals.get(e.id));
              }
            }
            if (army === 0) trail.push(positions);
            else expect(positions, `trajectory rotation tick ${tick}`).toEqual(trail[tick - 1]);
          });
        });
        const m = runs[0]!;
        const label = `${s.name}: ${fmt(m)}`;
        for (let army = 1; army < sides; army++) expect(runs[army]!.finals, `${label} (army ${army} mirror)`).toEqual(m.finals);
        expect(m.stuck, label).toBe(0);
        expect(m.restless, label).toBe(0);
        expect(m.arrive, label).toBeLessThanOrEqual(ARRIVE[s.name] ?? s.seconds);
        // Single-file queueing entails tiny lateral corrections while progressing forward. Per-axis sign counts
        // treat those as full reversals, so their old two-lane trajectory pins are not physical choke criteria.
        // Keep actual heading reversals/weaving, eventual settling, swept clearance and every-tick symmetry.
        if (s.name !== 'tanks: 8 through a 2-tile choke') {
          expect(m.flips, label).toBeLessThan(FLIPS);
          expect(m.flipsMax, label).toBeLessThan(FLIPS_WORST);
        }
        expect(m.reversals, label).toBeLessThan(REVERSALS);
        expect(m.wiggle, label).toBeLessThan(WIGGLE[s.name] ?? WIGGLE_ANY);
        expect(m.turn, label).toBeLessThan(TURN_ROUND[s.name] ?? Infinity);
        expect(m.overlapHold, label).toBeLessThan(OVERLAP_HOLD);
        expect(m.overlapEnd, label).toBeLessThanOrEqual(SEP_DEADBAND + 1e-9);
      }, 120_000);
    }
  }
});

// An already overlapping hull cannot slide farther into a corner merely because its centre stays outside it.
describe('cliff contact preserves full hulls and exact rotations (C4)', () => {
  it('does not deepen the historical diagonal cliff overlap in any army frame', () => {
    const g = arenaGame(4, false);
    const sim = g.sim;
    const size = sim.size;
    sim.terrain.fill(SURFACE.ground);
    sim.block.fill(0);
    const tanks = sim.allArmies.map((army) => {
      const k = sim.armyFrame[army]!;
      // The centre is outside the cliff, but the full .6-radius hull already overlaps it.
      const cliff = rotCell(k, 21 * size + 21, size);
      sim.terrain[cliff] = SURFACE.cliff;
      sim.block[cliff] = 1;
      // Two idle bodies overlapping along the diagonal: separation pushes the tank (+, +) into the cliff corner.
      const tank = sim.add('tank', army, 'surface', rotX(k, 20.9375, 20.9375, size), rotY(k, 20.9375, 20.9375, size));
      const flak = sim.add('flak', army, 'surface', rotX(k, 20.5, 20.5, size), rotY(k, 20.5, 20.5, size));
      tank.stance = flak.stance = 'hold';
      return tank;
    });
    for (const a of sim.allArmies) sim.refreshSurfaceFootprints(a);
    const start = [canonX(sim.armyFrame[0]!, tanks[0]!.x, tanks[0]!.y, size), canonY(sim.armyFrame[0]!, tanks[0]!.x, tanks[0]!.y, size)];
    for (let i = 0; i < 4; i++) g.step();
    const at = tanks.map((t) => [canonX(t.frame, t.x, t.y, size), canonY(t.frame, t.x, t.y, size)]);
    expect(at[0]).toEqual(start);
    for (const p of at) expect(p).toEqual(at[0]);
  });

  it('actually slides tangentially along a cliff face in every army frame', () => {
    const g = arenaGame(4, false);
    const sim = g.sim;
    const size = sim.size;
    sim.terrain.fill(SURFACE.ground);
    sim.block.fill(0);
    const tanks = sim.allArmies.map((army) => {
      const k = sim.armyFrame[army]!;
      const cliff = rotCell(k, 21 * size + 21, size);
      sim.terrain[cliff] = SURFACE.cliff;
      sim.block[cliff] = 1;
      // A legal hull beside the vertical face; the diagonal push must lose its inward x component, not its y.
      const tank = sim.add('tank', army, 'surface', rotX(k, 20.375, 21.5, size), rotY(k, 20.375, 21.5, size));
      const flak = sim.add('flak', army, 'surface', rotX(k, 19.9375, 21.0625, size), rotY(k, 19.9375, 21.0625, size));
      tank.stance = flak.stance = 'hold';
      expect(hullLineClear(sim.block, tank.x, tank.y, tank.x, tank.y, tank.radius, tank.frame, size)).toBe(true);
      return tank;
    });
    for (const a of sim.allArmies) sim.refreshSurfaceFootprints(a);
    g.step();
    const at = tanks.map((t) => {
      const x = rotX(t.frame, 20.375, 21.5, size), y = rotY(t.frame, 20.375, 21.5, size);
      expect(hullLineClear(sim.block, x, y, t.x, t.y, t.radius, t.frame, size)).toBe(true);
      return [canonX(t.frame, t.x, t.y, size), canonY(t.frame, t.x, t.y, size)];
    });
    expect(at[0]![0]).toBe(20.375);
    expect(at[0]![1]).toBeGreaterThan(21.5);
    for (const p of at) expect(p).toEqual(at[0]);
  });
});

/**
 * The derelict holds its gates open 40 s a cycle. A corridor ship sent outside past an open gate was flown
 * straight whenever its line only dipped into the gate's mouth (the wall test checks the ring's middle circle): it
 * clipped the gate's side and slid into the chamber, where the sealing ring then held it ('ships through the breaches').
 */
describe('derelict routing past an open gate (C2 and C4)', () => {
  for (const sides of [2, 4] as const) {
    it(`a corridor ship bound outside whose straight path clips an open gate's side goes by a breach, never into the chamber (C${sides}, every army)`, () => {
      let trail: number[] | undefined;
      for (let army = 0; army < sides; army++) {
        const g = arenaGame(sides, true);
        const sim = g.sim;
        const d = sim.derelict!;
        const k = sim.armyFrame[army]!;
        const size = sim.size;
        // Army frame from the ruin's centre: the corridor's middle, 0.4 of the north gate's half-width off its axis, bound
        // for the slot the breaches scenario gave its middle lancer outside the east breach.
        const ux = -0.4 * d.gateWidth / 2, uy = -(d.ringOuter + d.hullInner) / 2;
        const tx = d.hullOuter + 2.85, ty = 0.5;
        const x0 = rotX(k, d.x + ux, d.y + uy, size), y0 = rotY(k, d.x + ux, d.y + uy, size);
        const x = rotX(k, d.x + tx, d.y + ty, size), y = rotY(k, d.x + tx, d.y + ty, size);
        const e = sim.add('lancer', army, 'orbit', x0, y0);
        e.stance = 'hold';
        // Its straight path crosses no wall's middle circle outside an opening, yet leaves the gate's mouth by the side.
        expect(gatesOpen(d, sim.tick)).toBe(true);
        expect(wallBlocks(d, true, x0 - d.x, y0 - d.y, x - d.x, y - d.y, e.radius + WALL_CLEAR)).toBe(false);
        expect(throughAperture(d.gates, d.gateWidth / 2, d.ringInner, d.ringOuter, e.radius, x0 - d.x, y0 - d.y, x - d.x, y - d.y)).toBe(false);
        const team = sim.armyIds[army]!;
        expect(g.apply({ team, role: 'orbit' }, { kind: 'move', units: [g.entityId(team, e.id)], x, y, mode: 'move' })).toEqual({ ok: true });
        const path: number[] = [];
        for (let t = 1; t <= toTicks(20); t++) {
          g.step();
          // Open all the way: nothing but the route keeps it out of the chamber.
          expect(gatesOpen(d, sim.tick)).toBe(true);
          expect(derelictLayer(d, Math.hypot(e.x - d.x, e.y - d.y)), `chamber tick ${t}`).not.toBe(CHAMBER);
          path.push(canonX(k, e.x, e.y, size), canonY(k, e.x, e.y, size));
        }
        expect(e.order.k).toBe('none');
        if (army === 0) trail = path;
        else expect(path, `army ${army} rotation`).toEqual(trail);
      }
    });
  }
});
