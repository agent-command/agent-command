// @module-tag timing — real shipped policy calls use the sandbox's normal per-call CPU budget.
import { describe, expect, it } from 'vitest';
import { intentSchema, resolveDetail, validate } from 'playerthree';
import { loadPolicy } from 'playerthree/policy';
import { createGame } from '../src/agent/adapter.ts';
import { manifest } from '../src/agent/manifest.ts';
import { FUNCTIONAL_LIMITS, periodOf, STARTER_POLICIES } from './starter-policies.ts';
import { BOT_PERIOD } from '../src/bots/play.ts';
import { SAPPER_WAVE_GAP } from '../src/bots/tuning.ts';
import { CELL, SURFACE, packTerrain, type Observation, type Plane } from '../src/rules/contract.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';

const seat = { team: 'nw', role: 'depths' } as const;

it('Surface sight is owner-scoped, bounded and only supplied with Surface detail', () => {
  const game = createGame({ seed: 3 });
  const onlyDepths = game.observe(seat, 0, ['depths']);
  expect(onlyDepths.surfaceVision).toBeUndefined();
  const ours = game.observe(seat, 0, ['depths', 'surface']);
  expect(ours.surfaceVision).toEqual(game.view('nw').vision.surface);
  expect(ours.surfaceVision).not.toEqual(game.view('se').vision.surface);
  expect(validate(manifest.observation, ours).ok).toBe(true);
});

describe('Depths remembered strikes in the shipped sandbox', () => {
  it.each(['headframe', 'shaft'] as const)('%s: survives captured posts, retains occluded targets and keeps mining/defending, then forgets a visibly empty site', async (kind) => {
    const game = createGame({ seed: 3 });
    const sim = game.sim;
    // One cadence step in: the first call (a step before the first checkpoint) then carries a real, non-negative tick.
    sim.tick = BOT_PERIOD;
    sim.terrain.fill(SURFACE.ground);
    sim.cells.fill(CELL.tunnel);
    sim.armies[0]!.group.known.fill(CELL.tunnel);
    // A high-ground Headframe and a scout initially on its plateau. Low ground beside it cannot see it.
    for (let y = 19; y <= 21; y++) for (let x = 27; x <= 31; x++) sim.terrain[y * sim.size + x] = SURFACE.high;
    const target = sim.build(1, kind, kind === 'shaft' ? 28 : 28.5, kind === 'shaft' ? 20 : 20.5, 'surface');
    target.built = true; target.progress = -1; target.state = 'active'; target.hp = target.maxHp;
    const scout = sim.spawnUnit(0, 'trooper', 'surface');
    scout.x = 30.5; scout.y = 20.5;
    const post = sim.ents.find((entity) => entity.kind === 'post')!;
    post.side = 0; post.x = 8.5; post.y = 28.5;
    const root = sim.armies[0]!.spire.depths;
    const defender = sim.spawnUnit(0, 'trooper', 'depths');
    defender.x = root.x + 2; defender.y = root.y;
    const intruder = sim.spawnUnit(1, 'digger', 'depths');
    intruder.x = root.x + 3; intruder.y = root.y;
    for (let i = 0; i < 6; i++) sim.spawnUnit(0, 'sapper', 'depths');
    sim.computeVision();
    const data = game.matchData(seat);
    // matchData carries the map's static terrain (packed once at match start); publish the fixture's plateau too, as the
    // bot judges a remembered site's line of sight by it (high ground is seen only from high ground).
    data.terrain = packTerrain(sim.terrain);
    // The default starter over an all-tunnel map, called at the host's cadence (every BOT_PERIOD ticks, the first call a
    // step before the first checkpoint): the call before each decision builds its worker-route fields (prepareAhead).
    const loaded = await loadPolicy('js', STARTER_POLICIES.depths, FUNCTIONAL_LIMITS, { seed: 1, matchData: data });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const policy = loaded.instance;
    try {
      const detail = resolveDetail(manifest, 'depths', policy.detail) as Plane[];
      expect(detail).toContain('surface');
      const observe = (): Observation => game.observe(seat, 0, detail);
      // Every cadence call up to `obs` (with its content): each decision the starter made there, in order.
      let next = -1;
      const think = async (obs: Observation): Promise<AgentCommandIntent[][]> => {
        const decisions: AgentCommandIntent[][] = [];
        for (let tick = next < 0 ? obs.tick - BOT_PERIOD : next; tick <= obs.tick; tick += BOT_PERIOD) {
          const result = await policy.call({ ...obs, tick });
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          expect(result.value.dropped).toBe(0);
          for (const intent of result.value.intents) expect(validate(intentSchema(manifest), intent).ok).toBe(true);
          if (result.value.intents.length) decisions.push(result.value.intents as AgentCommandIntent[]);
          next = tick + BOT_PERIOD;
        }
        return decisions;
      };
      // The bot spaces its sapper waves (SAPPER_WAVE_GAP undermine durations): each later phase spans one gap and one
      // decision period, so it holds a decision free to strike again; its latest decision still mines and defends.
      const phase = SAPPER_WAVE_GAP * sim.econ.undermineTicks + periodOf('depths');
      const progresses = (decisions: AgentCommandIntent[][]) => {
        const intents = decisions.at(-1) ?? [];
        expect(intents).toContainEqual({ kind: 'macro', action: 'auto_mine' });
        expect(intents.some((intent) => intent.kind === 'move' && intent.mode === 'fight' && intent.units.includes(game.entityId('nw', defender.id)))).toBe(true);
      };
      const seen = observe();
      expect(seen.entities.some((entity) => entity.id === game.entityId('nw', target.id))).toBe(true);
      const first = await think(seen);
      const strike = first.flat().find((intent) => intent.kind === 'undermine');
      expect(strike).toBeDefined();
      progresses(first);

      // A captured post still appears, but neither it nor the nearby low-ground scout can see the remembered site.
      scout.x = 25.5;
      sim.tick += phase;
      sim.computeVision();
      const hidden = observe();
      expect(hidden.entities.some((entity) => entity.kind === 'post' && entity.side === 'nw')).toBe(true);
      expect(hidden.entities.some((entity) => entity.id === game.entityId('nw', target.id))).toBe(false);
      const remembered = await think(hidden);
      expect(remembered.flat()).toContainEqual(strike);
      progresses(remembered);

      // No Surface detail means no proof of absence; retain memory rather than fabricate sight.
      sim.tick += phase;
      const unknown = observe();
      delete unknown.surfaceVision;
      expect((await think(unknown)).flat()).toContainEqual(strike);

      // An unobserved destruction is not an event. Moving the owned post into range reveals the empty plateau,
      // using its rule-defined unoccluded vision (posts intentionally have no rules.stats entry).
      target.dead = true;
      post.x = 24.5; post.y = 20.5;
      sim.tick += phase;
      sim.computeVision();
      const gone = observe();
      expect(gone.surfaceVision).toEqual(game.view('nw').vision.surface);
      const cleared = await think(gone);
      expect(cleared.flat().some((intent) => intent.kind === 'undermine')).toBe(false);
      progresses(cleared);
    } finally { policy.dispose(); }
  });
});
