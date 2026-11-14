/**
 * Observation scope (planes as sections): a seat's own plane in full, the others summarised; fog-safe summaries; the
 * example policies under their declared detail.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveDetail, validate } from 'playerthree';
import { loadPolicy } from 'playerthree/policy';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { manifest } from '../src/agent/manifest.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { CELL, PLANES, observationSchema, type Observation, type Plane } from '../src/rules/contract.ts';

/** A reproducible mid-match duel: standard bots on both sides, five game minutes in. */
const MID_MATCH_TICKS = 6000;
/** Wall-time allowance for playing the mid-match duel under a loaded test run. */
const SETUP_TIMEOUT_MS = 120_000;
let mid: AgentCommandGame;
beforeAll(() => {
  mid = playBotMatch({ seed: 7, maxTicks: MID_MATCH_TICKS, levels: { nw: 'standard', se: 'standard' } }).game;
}, SETUP_TIMEOUT_MS);
const bytes = (obs: unknown): number => Buffer.byteLength(JSON.stringify(obs));

describe('observation scope', () => {
  it('renders the role plane in full and summarises the others; detail adds planes, all renders every plane', () => {
    for (const role of PLANES) {
      const seat = { team: 'nw' as const, role };
      const scoped = mid.observe(seat, 0, [role]);
      expect(validate(observationSchema, scoped).ok, role).toBe(true);
      expect(scoped.detail).toEqual([role]);
      expect(scoped.planes.map((p) => p.plane)).toEqual(PLANES.filter((p) => p !== role));
      expect(scoped.entities.every((e) => e.plane === role), role).toBe(true);
      expect(scoped.depths !== undefined, role).toBe(role === 'depths');
      expect(scoped.weather !== undefined, role).toBe(role === 'sky');
      const all = mid.observe(seat, 0);
      expect(all.detail).toEqual([...PLANES]);
      expect(all.planes).toEqual([]);
      // Scoping keeps every alert: they come from the army's knowledge on every plane.
      expect(scoped.alerts).toEqual(all.alerts);
      const wider = mid.observe(seat, 0, PLANES.filter((p) => p === role || p === 'surface'));
      expect(wider.planes.some((p) => p.plane === 'surface')).toBe(false);
    }
  });

  it('cuts the default mid-match Depths and Surface observations to at most half of the full one', () => {
    for (const role of ['depths', 'surface'] as const) {
      const seat = { team: 'nw' as const, role };
      const scoped = bytes(mid.observe(seat, 0, resolveDetail(manifest, role, undefined) as Plane[]));
      const all = bytes(mid.observe(seat, 0));
      expect(scoped, `${role}: ${scoped} of ${all} bytes`).toBeLessThanOrEqual(all / 2);
    }
  });

  it('summaries count only what the army sees: hostile counts match the visible entities of the full observation', () => {
    for (const role of PLANES) {
      const seat = { team: 'se' as const, role };
      const all = mid.observe(seat, 0);
      const scoped = mid.observe(seat, 0, [role]);
      for (const summary of scoped.planes) {
        const visible = all.entities.filter((e) => e.plane === summary.plane);
        for (const row of summary.counts) {
          expect(row.hostile ?? 0, `${role} ${summary.plane} ${row.kind}`).toBe(visible.filter((e) => e.kind === row.kind && e.side !== 'se' && e.side !== 'neutral').length);
          expect(row.own ?? 0).toBe(visible.filter((e) => e.kind === row.kind && e.side === 'se').length);
        }
      }
    }
  });

  it('summaries reveal nothing hidden: unseen enemy forces on any plane leave every scoped observation unchanged', () => {
    const real = mid.clone();
    const twin = real.clone();
    const se = twin.sim.armyIndex('se');
    const nw = twin.sim.armyIndex('nw');
    const home = twin.sim.armies[se]!.spire.surface;
    const hidden = PLANES.map((plane) => twin.sim.add(plane === 'depths' ? 'digger' : plane === 'surface' ? 'tank' : plane === 'sky' ? 'interceptor' : 'skiff', se, plane, home.x, home.y));
    for (const e of hidden) expect(twin.sim.sees(nw, e)).toBe(false);
    for (const role of PLANES) {
      const seat = { team: 'nw' as const, role };
      expect(twin.observe(seat, 0, [role]), role).toEqual(real.observe(seat, 0, [role]));
    }
  });

  it('keeps every example policy working under its declared detail', async () => {
    for (const role of PLANES) {
      const loaded = await loadPolicy('js', STARTER_POLICIES[role], manifest.control.policy, { seed: 1, matchData: mid.matchData({ team: 'nw', role }) });
      if (!loaded.ok) throw new Error(`${role}: ${JSON.stringify(loaded.error)}`);
      try {
        const detail = resolveDetail(manifest, role, loaded.instance.detail) as Plane[] | null;
        expect(detail, role).not.toBeNull();
        expect(detail).toContain(role);
        const obs: Observation = mid.observe({ team: 'nw', role }, MID_MATCH_TICKS - 1, detail!);
        const out = await loaded.instance.call(obs);
        expect(out.ok ? undefined : out.error, role).toBeUndefined();
      } finally {
        loaded.instance.dispose();
      }
    }
  });

  it('sends the depths grid whole on a first observation and as changes since the consumer\'s tick after it', () => {
    // Establish a real terrain transition rather than depending on bot economy still changing this late in a match.
    const game = createGame({ seed: 7 });
    const seat = { team: 'nw' as const, role: 'depths' as const };
    const army = game.sim.armyIndex('nw');
    const cell = game.sim.armies[army]!.group.known.findIndex(code => code === CELL.rock);
    expect(cell).toBeGreaterThanOrEqual(0);
    game.step();
    const since = game.tick;
    const earlier = game.observe(seat, 0, ['depths']).depths!;
    game.step();
    game.sim.digCell(cell, army);
    game.sim.computeVision();
    const now = game.observe(seat, 0, ['depths']);
    const changed = game.observe(seat, since, ['depths']);
    expect(changed.depths).toBeUndefined();
    expect(changed.depthsChanges!.length).toBeGreaterThan(0);
    // Applying the changes to the grid the consumer kept at its `since` reproduces today's grid exactly.
    const grid = [...earlier];
    for (let i = 0; i < changed.depthsChanges!.length; i += 2) grid[changed.depthsChanges![i]!] = changed.depthsChanges![i + 1]!;
    expect(grid).toEqual(now.depths);
    // Every plane (game code, an explicit "all") always carries the whole grid.
    expect(game.observe(seat, since).depths).toEqual(now.depths);
  }, SETUP_TIMEOUT_MS);

  it('cuts a four-army observe loop (since two seconds ago) for Depths and Surface to at most half of every plane', () => {
    const ffa = playBotMatch({ seed: 5, maxTicks: MID_MATCH_TICKS, options: { map: { name: 'four_corners' } }, levels: { nw: 'standard', ne: 'standard', se: 'standard', sw: 'standard' } }).game;
    const since = ffa.tick - 2 * 20;
    for (const role of ['depths', 'surface'] as const) {
      const seat = { team: 'nw' as const, role };
      const scoped = bytes(ffa.observe(seat, since, resolveDetail(manifest, role, undefined) as Plane[]));
      const all = bytes(ffa.observe(seat, since));
      expect(scoped, `${role}: ${scoped} of ${all} bytes`).toBeLessThanOrEqual(all / 2);
    }
  }, SETUP_TIMEOUT_MS);
});
