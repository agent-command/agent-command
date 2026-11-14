// @module-tag timing — every call runs under the sandbox's per-call time budget; serial timing set (pnpm test:timing).
/**
 * The strategy skill's example policies are real artifacts: they load in the PlayerThree sandbox, emit only
 * schema-valid intents, and (as SKILL.md promises) beat the novice opponent when they drive a whole team. Everything
 * is checked by what the policies do in a match, never by their source text.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { intentSchema, validate } from 'playerthree';
import { loadPolicy, type PolicyInstance } from 'playerthree/policy';
import { CELL, DEFAULT_RULES, HOLE_KINDS, SPIRE_CORNER, STATS, PLANES, SURFACE, isSurfaceHigh, surfaceFeature, packTerrain, unpackTerrain, toTicks, spirePositions, type ArmyId, type FullObservation, type MatchData, type MatchOptions, type Observation, type Plane } from '../src/rules/contract.ts';
import { createGame, definition, type AgentCommandGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import { manifest, STRATEGY_SKILL } from '../src/agent/manifest.ts';
import { DECIDE_FIRST, FUNCTIONAL_LIMITS, knobDefault, periodOf, STARTER_POLICIES, starterScript, UNBOUNDED } from './starter-policies.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { BOT_PERIOD } from '../src/bots/play.ts';
import { HOLE } from '../src/sim/constants.ts';
import { cellOf, cellOfEnt } from '../src/util/grid.ts';
import { sampleStorm } from '../src/planes/weather.ts';

/** A duel's armies: army 0 on the NW slot, army 1 on the SE slot (its point mirror). */
const DUEL = ['nw', 'se'] as const;
/** The sim army index of a duel army. */
const armyOf = (id: ArmyId): number => DUEL.indexOf(id as (typeof DUEL)[number]);
const BLUE = armyOf('nw'), RED = armyOf('se');

/** Spire centres under the default rules (every match here uses them). */
const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);

/** A built own Shaft of `team` at the mirror of (14.5, 14.5), its landing open beside tunnel: a usable portal. */
function readyShaft(g: AgentCommandGame, team: ArmyId): void {
  const s = g.sim;
  const army = armyOf(team);
  const at = (v: number): number => (team === 'se' ? s.size - v : v);
  const shaft = s.build(army, 'shaft', at(14.5), at(14.5), 'surface');
  shaft.built = true;
  shaft.progress = -1;
  shaft.state = 'active';
  shaft.hp = shaft.maxHp;
  const c = cellOfEnt(shaft, s.size);
  for (const n of [c - 1, c, c + 1]) s.cells[n] = s.armies[army]!.group.known[n] = CELL.tunnel;
}

// Behaviour, not cost: the functional budget (depths-starter-budget.test.ts and sky-starter.test.ts assert the real one).
const limits = FUNCTIONAL_LIMITS;
const wire = intentSchema(manifest);
const instances: PolicyInstance[] = [];
afterAll(() => {
  for (const i of instances) i.dispose();
});

/** `role`'s starter in the sandbox, with deploy `knobs` (omitted: its defaults). */
async function load(role: Plane, matchData?: MatchData, knobs?: Readonly<Record<string, unknown>>): Promise<PolicyInstance> {
  const source = knobs ? await starterScript(role, knobs) : STARTER_POLICIES[role];
  const r = await loadPolicy('js', source, limits, { seed: 1, ...(matchData ? { matchData } : {}) });
  if (!r.ok) throw new Error(`policy ${role} failed to load: ${r.error.code} ${r.error.message ?? ''}`);
  instances.push(r.instance);
  return r.instance;
}

/** One policy call: schema-valid intents for the seat's own plane, nothing dropped. */
async function decide(policy: PolicyInstance, role: Plane, obs: Observation): Promise<{ intents: AgentCommandIntent[]; logs: number; lines: unknown[]; cpuMs: number }> {
  const r = await policy.call(obs);
  // The budget is the sandbox thread's CPU time (limits.msPerCall); wall time on a loaded machine is information only.
  if (!r.ok) throw new Error(`policy ${role} failed at tick ${obs.tick} after ${r.cpuMs ?? '?'} ms CPU (${r.ms} ms wall, budget ${limits.msPerCall} ms CPU): ${r.error.code} ${r.error.message ?? ''}`);
  expect(r.value.dropped).toBe(0);
  for (const raw of r.value.intents) {
    const v = validate(wire, raw);
    expect(v.ok ? true : v).toBe(true);
    expect(manifest.intents[(raw as AgentCommandIntent).kind].roles).toContain(role);
  }
  return { intents: r.value.intents as AgentCommandIntent[], logs: r.value.logs.length, lines: r.value.logs, cpuMs: r.value.cpuMs };
}

describe('example policies (agent-command-strategy skill)', () => {
  it('every plane has an example policy that loads in the JS sandbox', async () => {
    for (const role of PLANES) {
      const matchData = createGame({ seed: 3 }).matchData({ team: 'nw', role });
      const p = await load(role, matchData);
      expect(p.dead).toBe(false);
    }
    expect(STRATEGY_SKILL.files['SKILL.md']).toMatch(/^---\nname: agent-command-strategy\n/);
  });

  it.each([
    { size: 48, terrain: 'chokepoint' },
    { size: 64, terrain: 'archipelago' },
    { size: 80, terrain: 'highlands' },
  ] as const)('$size $terrain: every sandbox policy retains public map dimensions across calls', async ({ size, terrain }) => {
    const game = createGame({ seed: 91, options: { terrain, map: { params: { size } } } });
    for (const role of PLANES) {
      const seat = { team: 'se', role } as const;
      const data = game.matchData(seat);
      const policy = await load(role, data);
      expect(data.rules.map.size).toBe(size);
      for (const tick of [0, toTicks(360)]) {
        game.sim.tick = tick;
        const obs = game.observe(seat, 0);
        const { intents } = await decide(policy, role, obs);
        for (const intent of intents) {
          if ('x' in intent && intent.x !== undefined) {
            expect(intent.x).toBeGreaterThanOrEqual(0);
            expect(intent.x).toBeLessThan(size);
          }
          if ('y' in intent && intent.y !== undefined) {
            expect(intent.y).toBeGreaterThanOrEqual(0);
            expect(intent.y).toBeLessThan(size);
          }
          if (intent.kind === 'designate' && intent.cells) for (const cell of intent.cells) {
            expect(cell.x).toBeGreaterThanOrEqual(0);
            expect(cell.y).toBeGreaterThanOrEqual(0);
            expect(cell.x).toBeLessThan(size);
            expect(cell.y).toBeLessThan(size);
          }
        }
      }
      game.sim.tick = 0;
    }
  });

  it.each(PLANES)('%s uses separately initialized match data and rejects missing initialization', async (role) => {
    const g = createGame({ seed: 3 });
    const seat = { team: 'nw', role } as const;
    const matchData = g.matchData(seat);
    const missing = await (await load(role)).call(g.observe(seat, 0));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain('match data initialization');
    const mismatch = g.observe(seat, 0);
    mismatch.rulesHash = (mismatch.rulesHash ^ 1) >>> 0;
    const rejected = await (await load(role, matchData)).call(mismatch);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.message).toContain('rules hash');
    const policy = await load(role, matchData);
    await decide(policy, role, g.observe(seat, 0));
    g.sim.tick = toTicks(10);
    const next = g.observe(seat, 0);
    expect(next).not.toHaveProperty('match');
    await decide(policy, role, next);
  });

  it('the Sky example builds bombers, researches, then ascends only surplus interceptors', async () => {
    const g = createGame({ seed: 3 });
    for (let i = 0; i < 7; i++) g.sim.spawnUnit(BLUE, 'interceptor', 'sky');
    for (let i = 0; i < 2; i++) g.sim.spawnUnit(BLUE, 'bomber', 'sky');
    const obs = g.observe({ team: 'nw', role: 'sky' }, 0);
    const matchData = g.matchData({ team: 'nw', role: 'sky' });
    obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 1000;
    obs.entities.filter((e) => e.kind === 'island').slice(0, 2).forEach((e) => { e.side = 'nw'; });
    obs.research = { available: ['ascent_thrusters'], inProgress: [], completed: [], seen: [] };
    const entities = obs.entities;
    obs.entities = entities.filter((e) => e.kind !== 'bomber');
    // The first desired aircraft is a durable lane commitment, not an optional surplus buy (policies.md, queue lanes).
    expect((await decide(await load('sky', matchData), 'sky', obs)).intents).toContainEqual({ kind: 'queue_add', item: 'bomber' });
    obs.entities = entities;
    expect((await decide(await load('sky', matchData), 'sky', obs)).intents).toContainEqual({ kind: 'research', upgrade: 'ascent_thrusters', ifAffordable: true });
    obs.research.available = [];
    obs.research.completed = ['ascent_thrusters'];
    const out = (await decide(await load('sky', matchData), 'sky', obs)).intents;
    const raid = out.find((i) => i.kind === 'ascend');
    expect(raid?.kind).toBe('ascend');
    if (raid?.kind !== 'ascend') return;
    expect(raid.units).toHaveLength(2);
    expect(out.filter((i) => i.kind === 'capture').every((i) => i.kind === 'capture' && i.units.every((id) => !raid.units.includes(id)))).toBe(true);
  });

  it('the Sky example moves idle air out of a passing storm for either team', async () => {
    // An announced drifting lifecycle grows over idle blue interceptors and their reflected red twins.
    const g = createGame({ seed: 3 });
    for (const e of g.sim.ents) if (e.kind !== 'spire') e.dead = true;
    for (const t of g.sim.armies) t.alloy = t.energy = 0;
    for (const c of g.sim.weather.data.storms.concat(g.sim.weather.data.forecast)) {
      c.start = 400;
      c.grown = 480;
      c.breaking = 5000;
      c.end = 6000;
      c.originX = 24;
      c.originY = 37;
      c.dx = 0.001;
      c.dy = 0;
      c.maxRadius = 4;
    }
    g.sim.tick = 300;
    const spots = [[24, 37], [25, 36.5], [23, 37.5]] as const;
    const air = { nw: spots.map(([x, y]) => g.sim.add('interceptor', BLUE, 'sky', x, y)), se: spots.map(([x, y]) => g.sim.add('interceptor', RED, 'sky', g.sim.size - x, g.sim.size - y)) };
    g.step();
    const seats = await Promise.all(DUEL.map(async (team) => ({ team, policy: await load('sky', g.matchData({ team, role: 'sky' })) })));
    while (g.tick < 300 + toTicks(60)) {
      if (g.tick % BOT_PERIOD === 0) {
        const decided = await Promise.all(seats.map(async (s) => {
          const obs = g.observe({ team: s.team, role: 'sky' }, 0);
          return (await decide(s.policy, 'sky', obs)).intents;
        }));
        seats.forEach((s, i) => { for (const intent of decided[i]!) expect(g.apply({ team: s.team, role: 'sky' }, intent).ok).toBe(true); });
      }
      g.step();
    }
    const lost = (team: 'nw' | 'se') => air[team].reduce((sum, e) => sum + e.maxHp - Math.max(0, e.hp), 0);
    expect(lost('nw')).toBeLessThan(360 / 20);
    expect(lost('se')).toBe(lost('nw'));
  });

  it.each([
    { name: 'not started at the lead', start: 200, grown: 240, breaking: 280, end: 320, maxRadius: 4, escapes: false },
    { name: 'zero radius at start', start: 180, grown: 220, breaking: 260, end: 300, maxRadius: 4, escapes: false },
    { name: 'growing forecast', start: 120, grown: 240, breaking: 280, end: 320, maxRadius: 4, escapes: true },
    { name: 'mature forecast', start: 120, grown: 160, breaking: 200, end: 240, maxRadius: 4, escapes: true },
    { name: 'breaking forecast', start: 120, grown: 160, breaking: 170, end: 190, maxRadius: 4, escapes: true },
    { name: 'expired at the lead', start: 120, grown: 140, breaking: 160, end: 180, maxRadius: 4, escapes: false },
    { name: 'disabled forecast', start: 120, grown: 160, breaking: 200, end: 240, maxRadius: 0, escapes: false },
  ])('the Sky sandbox plans around $name with exact reflected lifecycle geometry', async ({ escapes, name, ...life }) => {
    const g = createGame({ seed: 3 });
    const canonical = { x: 19.4 + 0.01 * Math.max(0, 180 - life.start), y: 20.6 - 0.01 * Math.max(0, 180 - life.start) };
    const moves = [];
    for (const team of DUEL) {
      const unit = g.sim.add('interceptor', armyOf(team), 'sky', team === 'se' ? g.sim.size - canonical.x : canonical.x, team === 'se' ? g.sim.size - canonical.y : canonical.y);
      const obs = g.observe({ team, role: 'sky' }, 0);
      const matchData = g.matchData({ team, role: 'sky' });
      obs.tick = 100;
      obs.entities = obs.entities.filter((e) => e.id === g.entityId(team, unit.id));
      obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 0;
      matchData.jets = [];
      obs.weather = { storms: [], forecast: [{ id: 0, x: 19.4, y: 20.6, radius: 0, strength: 0, stage: 'forecast', originX: 19.4, originY: 20.6, dx: 0.01, dy: -0.01, turns: 0, ...life }], seedWarnings: [], seeded: [], fog: [] };
      const cloud = obs.weather.forecast[0]!;
      obs.weather.forecast.push({ ...cloud, id: 1, x: g.sim.size - cloud.x, y: g.sim.size - cloud.y, turns: 2 });
      const out = (await decide(await load('sky', matchData), 'sky', obs)).intents;
      const move = out.find((i) => i.kind === 'move' && i.units.includes(g.entityId(team, unit.id)));
      expect(!!move, `${name}: ${team}`).toBe(escapes);
      if (move?.kind === 'move') {
        const sampled = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' as const };
        sampleStorm(obs.weather.forecast[0]!, 180, sampled, 0, g.sim.size);
        const x = team === 'se' ? g.sim.size - move.x : move.x, y = team === 'se' ? g.sim.size - move.y : move.y;
        expect(Math.hypot(x - sampled.x, y - sampled.y)).toBeGreaterThan(sampled.radius + 0.5);
        moves.push({ x, y });
      }
    }
    if (escapes) expect(moves[1]).toEqual(moves[0]);
  });

  it('the orbit policy obeys live asteroid-drop house rules without abandoning energy chores', async () => {
    const g = createGame({ seed: 3 });
    const seat = { team: 'nw', role: 'orbit' } as const;
    const matchData = g.matchData(seat);
    // Towing at a stand-off release point: outside the red Orbit segment's beam (which reaches from the footprint edge,
    // farthest on this diagonal), within deorbit range of the Spire.
    const stand = DEFAULT_SPIRES.se.x - (DEFAULT_RULES.spire.range + SPIRE_CORNER + STATS.tug.radius + DEFAULT_RULES.orbit.deorbitRange) / 2 / Math.SQRT2;
    for (let i = 0; i < 2; i++) {
      const tug = g.sim.spawnUnit(BLUE, 'tug', 'orbit');
      const rock = g.sim.add('asteroid', BLUE, 'orbit', stand, stand);
      // Volatile payloads remain enemy drops; nonvolatile economic rocks may be mined.
      rock.volatile = true;
      tug.x = tug.y = stand;
      tug.link = rock.id;
      rock.link = tug.id;
      rock.state = 'towed';
    }
    g.sim.scan(BLUE, stand, stand); // Composition is only disclosed inside the team's current vision.
    const policy = await load('orbit', matchData);
    g.setSeatInfo(seat, { controller: 'agent', mandate: { autonomy: 'autonomous', directive: { stance: 'support' }, whenAbsent: 'policy', limits: { asteroidDrops: false } } });
    const blocked = await decide(policy, 'orbit', g.observe(seat, 0));
    expect(blocked.intents.some((i) => i.kind === 'deorbit' || i.kind === 'grapple')).toBe(false);
    // Its arrays still go to their berths.
    const arrays = g.sim.ents.filter((e) => !e.dead && e.kind === 'solar' && e.side === BLUE).map((e) => g.entityId('nw', e.id));
    expect(blocked.intents.some((i) => i.kind === 'move' && i.units.some((u) => arrays.includes(u)))).toBe(true);
    // A live change: the same instance's next decision, one decision period later.
    g.setSeatInfo(seat, { controller: 'agent', mandate: { autonomy: 'autonomous', directive: { stance: 'support' }, whenAbsent: 'policy' } });
    g.sim.tick += periodOf('orbit');
    const allowed = await decide(policy, 'orbit', g.observe(seat, 0));
    expect(allowed.intents.some((i) => i.kind === 'deorbit')).toBe(true);
  });
  it('the orbit policy plans ore-rich landings with both teams’ Spire segments in sight', async () => {
    const g = createGame({ seed: 3, options: { terrain: 'open' } });
    const seat = { team: 'nw', role: 'orbit' } as const;
    const tug = g.sim.add('tug', BLUE, 'orbit', 13, 13);
    const rock = g.sim.add('asteroid', BLUE, 'orbit', 13, 13);
    rock.resourceType = 'metal';
    rock.volatile = false;
    rock.resourceRemaining = g.sim.rules.orbit.dockValue;
    rock.state = 'towed';
    rock.link = tug.id;
    tug.link = rock.id;
    g.sim.add('trooper', BLUE, 'surface', 13, 13);
    g.sim.scan(BLUE, 13, 13);
    g.sim.scan(BLUE, DEFAULT_SPIRES.se.x, DEFAULT_SPIRES.se.y);
    const obs = g.observe(seat, 0);
    expect(obs.entities.some((e) => e.kind === 'spire' && e.side === 'nw' && e.plane === 'surface')).toBe(true);
    expect(obs.entities.some((e) => e.kind === 'spire' && e.side === 'se' && e.plane === 'surface')).toBe(true);
    const out = (await decide(await load('orbit', g.matchData(seat)), 'orbit', obs)).intents;
    const landing = out.find((i) => i.kind === 'deorbit' || (i.kind === 'move' && i.units.includes(g.entityId('nw', tug.id))));
    expect(landing).toBeDefined();
    if (landing?.kind === 'deorbit' || landing?.kind === 'move') {
      expect(Math.hypot(landing.x - DEFAULT_SPIRES.nw.x, landing.y - DEFAULT_SPIRES.nw.y))
        .toBeLessThan(Math.hypot(landing.x - DEFAULT_SPIRES.se.x, landing.y - DEFAULT_SPIRES.se.y));
      expect(g.apply(seat, landing, { source: 'policy' })).toEqual({ ok: true });
    }
  });

  it('the depths policy obeys live collapse house rules even with a ready sapper wave', async () => {
    const g = createGame({ seed: 3 });
    const seat = { team: 'nw', role: 'depths' } as const;
    const matchData = g.matchData(seat);
    for (let i = 0; i < 3; i++) g.sim.spawnUnit(BLUE, 'sapper', 'depths');
    // Deployed at the host's policy cadence (every BOT_PERIOD ticks), so the call before each decision builds its
    // worker-route fields (prepareAhead) and no call carries both. The default starter (the standard tier) knows no
    // strike target here (no hostile structure seen, tunnelAt never, no fault cell in reach of the focus on this map);
    // the tunnelAt knob makes the focus's Spire, tunnelled from 240 s, its sapper wave's target.
    const policy = await load('depths', matchData, { tunnelAt: toTicks(240) });
    const obs = g.observe(seat, 0);
    obs.tick = toTicks(240);
    obs.depths!.fill(4); // a known tunnel connects the root to the enemy pocket
    const calls = async (span: number): Promise<AgentCommandIntent[]> => {
      const out: AgentCommandIntent[] = [];
      for (const end = obs.tick + span; obs.tick < end; obs.tick += BOT_PERIOD) out.push(...(await decide(policy, 'depths', obs)).intents);
      return out;
    };
    obs.mandate.limits = { collapses: false };
    const blocked = await calls(periodOf('depths') + BOT_PERIOD);
    // A decision (the sappers are fielded), just no undermine.
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.some((i) => i.kind === 'undermine')).toBe(false);
    // A live change: the same instance's next decision.
    obs.mandate.limits = { collapses: true };
    expect((await calls(periodOf('depths'))).some((i) => i.kind === 'undermine')).toBe(true);
  });

  it('depths bot and policy publish mirrored bounded corridors without overriding urgent tags or routine mining', async () => {
    for (const controller of ['bot', 'policy'] as const) for (const team of DUEL) {
      // This handcrafted corridor starts at the inset-8 root's open apron, independent of the default map recipe.
      const g = createGame({ seed: 3, options: { map: { params: { spireInset: 8 } } } });
      for (let i = 0; i < 8; i++) g.sim.spawnUnit(armyOf(team), 'digger', 'depths');
      const obs = g.observe({ team, role: 'depths' }, 0);
      const matchData = g.matchData({ team, role: 'depths' });
      const mirror = (c: number): number => team === 'nw' ? c : g.sim.size * g.sim.size - 1 - c;
      obs.tick = toTicks(240);
      obs.res.alloy = obs.res.freeAlloy = 0;
      matchData.faults = [];
      obs.lodes = [];
      obs.holes = [];
      obs.cracks = [];
      obs.depths!.fill(CELL.bedrock);
      for (let x = 10; x <= 37; x++) obs.depths![mirror(8 * g.sim.size + x)] = CELL.unknown;
      for (let y = 8; y <= 37; y++) obs.depths![mirror(y * g.sim.size + 37)] = CELL.rock;
      obs.depths![mirror(8 * g.sim.size + 10)] = CELL.tunnel;
      obs.depths![mirror(37 * g.sim.size + 37)] = CELL.tunnel;
      matchData.rules = { ...matchData.rules, depths: { ...matchData.rules.depths, designateCells: 3, designateMax: 10 } };
      for (const e of obs.entities) if (e.side === team && e.kind === 'digger') e.state = 'idle';
      const urgent = mirror(8 * g.sim.size + 11);
      obs.designations.urgent[Math.floor(urgent / 30)]! |= 1 << (urgent % 30);
      const teammateTags = [20, 21, 22].map((x) => mirror(12 * g.sim.size + x));
      for (const c of teammateTags) {
        obs.depths![c] = CELL.rock;
        obs.designations.normal[Math.floor(c / 30)]! |= 1 << (c % 30);
      }
      // The standard tier never tunnels toward the focus (tunnelAt never); the starter's knob tunnelAt turns it on.
      const policy = controller === 'policy' ? await load('depths', matchData, { ...UNBOUNDED, tunnelAt: toTicks(240) }) : null;
      const bot = definition.createBot({ team, role: 'depths' }, 'veteran');
      bot.init?.(matchData);
      const intents = policy ? (await decide(policy, 'depths', obs)).intents : bot.think(obs);
      const plans = intents.filter((i) => i.kind === 'designate');
      expect(plans).toHaveLength(2);
      expect(plans.every((i) => i.priority === 1 && i.cells?.length === 3)).toBe(true);
      const cells = plans.flatMap((i) => i.cells ?? []);
      expect(cells.map((p) => mirror(p.y * g.sim.size + p.x))).toEqual([12, 13, 14, 15, 16, 17].map((x) => 8 * g.sim.size + x));
      expect(intents.some((i) => i.kind === 'dig' || i.kind === 'mine')).toBe(false);
      expect(intents).toContainEqual({ kind: 'macro', action: 'auto_mine' });
      for (const p of cells) {
        const c = p.y * g.sim.size + p.x;
        obs.designations.normal[Math.floor(c / 30)]! |= 1 << (c % 30);
      }

      // Each later call is the next decision: one starter decision period on.
      const period = periodOf('depths');
      obs.tick += period;
      const again = policy ? (await decide(policy, 'depths', obs)).intents : bot.think(obs);
      expect(again.some((i) => i.kind === 'designate')).toBe(false);
      if (policy) {
        // A cached path is not a cached publication: teammates' live tags still set the available room.
        for (const c of teammateTags) obs.designations.normal[Math.floor(c / 30)]! &= ~(1 << (c % 30));
        obs.tick += period;
        const expanded = (await decide(policy, 'depths', obs)).intents.filter((i) => i.kind === 'designate').filter((i) => i.priority === 1);
        expect(expanded.flatMap((i) => i.cells ?? []).map((p) => mirror(p.y * g.sim.size + p.x))).toEqual([18, 19, 20].map((x) => 8 * g.sim.size + x));
        // An observed enemy gate changes routing without changing any terrain code.
        const gateCell = mirror(8 * g.sim.size + 16);
        obs.entities.push({
          ...obs.entities.find((e) => e.kind === 'spire')!, id: 'cache-gate', kind: 'bulkhead',
          side: team === 'nw' ? 'se' : 'nw', plane: 'depths',
          x: gateCell % g.sim.size + 0.5, y: Math.floor(gateCell / g.sim.size) + 0.5,
        });
        obs.tick += period;
        const blocked = (await decide(policy, 'depths', obs)).intents.filter((i) => i.kind === 'designate');
        expect(blocked.some((i) => i.priority > 0)).toBe(false);
        expect(blocked.flatMap((i) => i.cells ?? []).every((p) => p.y * g.sim.size + p.x !== urgent)).toBe(true);
        obs.entities = obs.entities.filter((e) => e.id !== 'cache-gate');
        obs.designations.normal.fill(0);
        for (let x = 9; x <= 15; x++) obs.depths![mirror(8 * g.sim.size + x)] = CELL.tunnel;
        // Gate memory is conservative: leaving the observation alone is not proof the gate fell. A scout
        // standing beside its cell and seeing it clear is.
        const scout = obs.entities.find((e) => e.side === team && e.kind === 'digger')!;
        const beside = mirror(8 * g.sim.size + 15);
        scout.x = beside % g.sim.size + 0.5; scout.y = Math.floor(beside / g.sim.size) + 0.5;
        obs.tick += period;
        const reopened = (await decide(policy, 'depths', obs)).intents.filter((i) => i.kind === 'designate').filter((i) => i.priority === 1);
        expect(reopened.flatMap((i) => i.cells ?? []).map((p) => mirror(p.y * g.sim.size + p.x))).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24].map((x) => 8 * g.sim.size + x));
      }
    }
  });

  it('depths bot and policy tag lode approaches without digging pocket ore, then keep explicit lode miners', async () => {
    for (const controller of ['bot', 'policy'] as const) {
      const g = createGame({ seed: 3, options: { map: { params: { spireInset: 8 } } } });
      g.sim.add('headframe', BLUE, 'surface', 18.5, 8.5);
      const obs = g.observe({ team: 'nw', role: 'depths' }, 0);
      const matchData = g.matchData({ team: 'nw', role: 'depths' });
      obs.res.alloy = obs.res.freeAlloy = 0;
      matchData.faults = [];
      obs.holes = [];
      obs.cracks = [];
      obs.lodes = [{ x: 18, y: 8, rich: false, open: true, loads: 80 }];
      obs.depths!.fill(CELL.bedrock);
      for (let x = 10; x <= 16; x++) obs.depths![8 * g.sim.size + x] = CELL.rock;
      obs.depths![8 * g.sim.size + 10] = CELL.tunnel;
      for (let y = 7; y <= 9; y++) for (let x = 17; x <= 19; x++) obs.depths![y * g.sim.size + x] = CELL.ore;
      obs.depths![8 * g.sim.size + 18] = CELL.tunnel;
      // Workers serve ore only from a known tunnel component that reaches a drop-off: the overwritten
      // observation's diggers stand at the root's loading cell, not in what it now calls bedrock.
      for (const e of obs.entities) if (e.side === 'nw' && e.kind === 'digger') { e.x = 10.5; e.y = 8.5; }
      const policy = controller === 'policy' ? await load('depths', matchData, UNBOUNDED) : null;
      const bot = definition.createBot({ team: 'nw', role: 'depths' }, 'standard');
      bot.init?.(matchData);
      const intents = policy ? (await decide(policy, 'depths', obs)).intents : bot.think(obs);
      const cells = intents.filter((i) => i.kind === 'designate').flatMap((i) => i.cells ?? []);
      expect(cells).toEqual(Array.from({ length: 6 }, (_, i) => ({ x: 11 + i, y: 8 })));
      expect(intents.some((i) => i.kind === 'mine')).toBe(false);
      for (const p of cells) obs.depths![p.y * g.sim.size + p.x] = CELL.tunnel;
      obs.tick += 40;
      const linked = policy ? (await decide(policy, 'depths', obs)).intents : bot.think(obs);
      expect(linked.some((i) => i.kind === 'mine' && i.x === 18.5 && i.y === 8.5)).toBe(true);
      expect(linked.some((i) => i.kind === 'designate' || i.kind === 'dig')).toBe(false);
    }
  });

  it('depths bot and policy gate only a cavern route that exists, urgently tagging access past an enemy gate first', async () => {
    for (const controller of ['bot', 'policy'] as const) {
      const g = createGame({ seed: 3, options: { map: { params: { spireInset: 8 } } } });
      const obs = g.observe({ team: 'nw', role: 'depths' }, 0);
      const matchData = g.matchData({ team: 'nw', role: 'depths' });
      obs.res.alloy = obs.res.freeAlloy = 1000;
      matchData.faults = [];
      obs.lodes = [];
      obs.holes = [];
      obs.cracks = [];
      obs.depths!.fill(CELL.bedrock);
      // The solid 3×3 root occupies cells 7–9; its reachable apron is cell 10, not the blocked root centre. Known
      // tunnel beyond rock is no route raiders walk: nothing to gate, nothing to tag for a gate.
      for (let x = 10; x <= 18; x++) obs.depths![8 * g.sim.size + x] = x === 10 || x >= 16 ? CELL.tunnel : CELL.rock;
      const policy = controller === 'policy' ? await load('depths', matchData, UNBOUNDED) : null;
      const bot = definition.createBot({ team: 'nw', role: 'depths' }, 'standard');
      bot.init?.(matchData);
      const think = async (): Promise<AgentCommandIntent[]> => policy ? (await decide(policy, 'depths', obs)).intents : bot.think(obs);
      const apart = await think();
      expect(apart.some((i) => i.kind === 'queue_add' && i.item === 'bulkhead')).toBe(false);
      expect(apart.some((i) => i.kind === 'designate' && i.priority === 2)).toBe(false);
      // The cavern is open from the root to x = 18, but an enemy bulkhead at (12, 8) stops our diggers (raiders walk
      // through their own gate). The 1-wide choke nearest the centre, (17, 8), is tagged for access around it first,
      // through the rock of row 7 (away from the centre, so the dug detour never becomes the tunnel nearest it).
      for (let x = 11; x <= 18; x++) {
        obs.depths![8 * g.sim.size + x] = CELL.tunnel;
        obs.depths![7 * g.sim.size + x] = CELL.rock;
      }
      obs.entities.push({
        ...obs.entities.find((e) => e.kind === 'spire')!, id: 'enemy-gate', kind: 'bulkhead', side: 'se', plane: 'depths', x: 12.5, y: 8.5,
      });
      obs.tick += toTicks(31);
      const intents = await think();
      const plans = intents.filter((i) => i.kind === 'designate' && i.priority === 2);
      expect(plans).toHaveLength(1);
      expect(intents.some((i) => i.kind === 'queue_add' && i.item === 'bulkhead')).toBe(false);
      for (const plan of plans) if (plan.kind === 'designate') for (const p of plan.cells ?? []) obs.depths![p.y * g.sim.size + p.x] = CELL.tunnel;
      obs.tick += toTicks(31);
      const linked = await think();
      expect(linked.flatMap((i) => i.kind === 'queue_add' && i.item === 'bulkhead' ? [{ x: i.x, y: i.y }] : [])).toEqual([{ x: 17, y: 8 }]);
      expect(linked.some((i) => i.kind === 'designate')).toBe(false);
    }
    // Two distant goals use different ore rules. The far single-cell sapper goal is searched goal-directed, so it no
    // longer spends the call's shared route work: the open-ended ore search also completes in the same call, reaching
    // beside the far ore. Both canonical paths are mirror-exact, and the next call republishes nothing.
    const plans: { x: number; y: number }[][] = [];
    for (const team of DUEL) {
      const g = createGame({ seed: 3, options: { map: { params: { spireInset: 8 } } } });
      for (let i = 0; i < 6; i++) g.sim.spawnUnit(armyOf(team), 'digger', 'depths');
      const obs = g.observe({ team, role: 'depths' }, 0);
      const matchData = g.matchData({ team, role: 'depths' });
      const mirror = (c: number): number => team === 'nw' ? c : g.sim.size * g.sim.size - 1 - c;
      obs.tick = toTicks(240);
      obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 0;
      matchData.faults = []; obs.lodes = []; obs.holes = []; obs.cracks = [];
      obs.depths!.fill(CELL.rock);
      obs.depths![mirror(8 * g.sim.size + 10)] = CELL.tunnel;
      obs.depths![mirror(46 * g.sim.size + 1)] = CELL.ore;
      const policy = await load('depths', matchData, UNBOUNDED);
      const tagged = (out: AgentCommandIntent[]) => out.flatMap((intent) => intent.kind === 'designate' && intent.priority > 0 ? intent.cells ?? [] : []);
      const first = tagged((await decide(policy, 'depths', obs)).intents).map((p) => {
        const c = p.y * g.sim.size + p.x;
        obs.designations.normal[Math.floor(c / 30)]! |= 1 << (c % 30);
        const canonical = mirror(c);
        return { x: canonical % g.sim.size, y: Math.floor(canonical / g.sim.size) };
      });
      expect(first.some((p) => Math.abs(p.x - 1) + Math.abs(p.y - 46) === 1)).toBe(true);
      obs.tick += periodOf('depths');
      expect(tagged((await decide(policy, 'depths', obs)).intents)).toEqual([]);
      plans.push(first);
    }
    expect(plans[1]).toEqual(plans[0]);
  });

  it('the surface hold finds vantage cells beyond a sparse forward rally area while scouting discovered lodes', async () => {
    for (const team of DUEL) {
      const g = createGame({ seed: 21 });
      const matchData = g.matchData({ team, role: 'surface' });
      const policy = await load('surface', matchData);
      const obs = g.observe({ team, role: 'surface' }, 0);
      const moves = (await decide(policy, 'surface', obs)).intents.filter((i) => i.kind === 'move');
      expect(moves.length).toBeGreaterThan(0);
      expect(moves.filter((move) => move.mode === 'fight').length).toBeGreaterThan(0);
      expect(moves.filter((move) => move.mode === 'move').length).toBeLessThanOrEqual(1);
      expect(new Set(moves.flatMap((move) => move.units)).size).toBe(moves.length);
      for (const move of moves) {
        expect(move.units).toHaveLength(1);
        if (move.mode === 'move') {
          expect(obs.lodes.some((lode) => move.x === lode.x + 0.5 && move.y === lode.y + 0.5)).toBe(true);
        } else {
          expect(move.mode).toBe('fight');
          const ground = g.sim.terrain[cellOf(move.x, move.y, g.sim.size)]!;
          expect(isSurfaceHigh(ground) || surfaceFeature(ground) === SURFACE.forest, `vantage terrain ${ground}`).toBe(true);
        }
        expect(g.apply({ team, role: 'surface' }, move)).toEqual({ ok: true });
      }
    }
  });

  it('the surface hold breaks equal-score vantage ties in mirrored order for red', async () => {
    // Four high cells equally close to the blue front (15, 15) and their mirrors around red's (33, 33); two units
    // take two of them, so the tie-break alone decides which: red's are blue's mirrored.
    const posts = async (team: ArmyId): Promise<string[]> => {
      const g = createGame({ seed: 21, options: { map: { params: { spireInset: 8 } } } });
      const obs = g.observe({ team, role: 'surface' }, 0);
      const matchData = g.matchData({ team, role: 'surface' });
      const m = (v: number): number => team === 'nw' ? v : g.sim.size - 1 - v;
      const terrain = unpackTerrain(matchData.terrain, matchData.rules.map.size);
      for (let c = 0; c < g.sim.size * g.sim.size; c++) if (terrain[c] === SURFACE.high) terrain[c] = SURFACE.ground;
      for (const [x, y] of [[14, 14], [15, 14], [14, 15], [15, 15]] as const) terrain[m(y) * g.sim.size + m(x)] = SURFACE.high;
      matchData.terrain = packTerrain(terrain);
      obs.holes = [];
      obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 0;
      const unit = obs.entities.find((e) => e.side === team && e.plane === 'surface' && e.kind === 'trooper')!;
      obs.entities = obs.entities.filter((e) => e.plane !== 'surface' || e.kind === 'spire');
      for (let i = 0; i < 2; i++) obs.entities.push({ ...unit, id: `e_${1000 + i}`, x: m(10 + i) + 0.5, y: m(10) + 0.5 });
      const moves = (await decide(await load('surface', matchData), 'surface', obs)).intents.filter((i) => i.kind === 'move');
      expect(moves).toHaveLength(2);
      // Blue's frame: red's targets mirrored back onto blue's side of the map.
      return moves.map((move) => move.kind === 'move' ? `${team === 'nw' ? move.x : g.sim.size - move.x},${team === 'nw' ? move.y : g.sim.size - move.y}` : '').sort();
    };
    const blue = await posts('nw');
    expect(new Set(blue).size).toBe(2);
    for (const post of blue) expect(['14.5,14.5', '15.5,14.5', '14.5,15.5', '15.5,15.5']).toContain(post);
    expect(await posts('se')).toEqual(blue);
  });

  describe.each(['built-in', 'starter'] as const)('%s Surface flank commander', (kind) => {
    const fixture = (team: ArmyId, nearby = 0): { obs: FullObservation; matchData: MatchData } => {
      const g = createGame({ seed: 21 });
      const obs = g.observe({ team, role: 'surface' }, 0);
      const matchData = g.matchData({ team, role: 'surface' });
      const unit = obs.entities.find((e) => e.side === team && e.plane === 'surface' && e.kind === 'trooper')!;
      const lode = team === 'nw' ? { x: 40, y: 8 } : { x: 7, y: 39 };
      obs.lodes = [{ ...lode, rich: true, open: false, loads: 150 }];
      const terrain = unpackTerrain(matchData.terrain, matchData.rules.map.size);
      // The outcrop and its one-cell apron stand on one level.
      for (let y = lode.y - 2; y <= lode.y + 2; y++) for (let x = lode.x - 2; x <= lode.x + 2; x++) terrain[y * g.sim.size + x] = SURFACE.ground;
      matchData.terrain = packTerrain(terrain);
      obs.holes = [];
      obs.entities = obs.entities.filter((e) => e.plane !== 'surface' || e.kind === 'spire');
      for (let i = 0; i < 10; i++) obs.entities.push({
        ...unit, id: `e_${1000 + i}`, x: i < nearby ? lode.x + 1.5 : 24,
        y: i < nearby ? lode.y + 0.5 : 24,
      });
      obs.tick = toTicks(60);
      obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 2000;
      return { obs, matchData };
    };
    const commander = async (team: ArmyId, matchData: MatchData): Promise<(obs: Observation) => Promise<AgentCommandIntent[]>> => {
      if (kind === 'built-in') {
        const bot = createBot(team, 'surface', 'standard');
        bot.init?.(matchData);
        return async (obs) => bot.think(obs);
      }
      const policy = await load('surface', matchData);
      return async (obs) => (await decide(policy, 'surface', obs)).intents;
    };
    const builds = (intents: AgentCommandIntent[]) => intents.filter((i) => i.kind === 'queue_add' && i.item === 'headframe');

    it('scouts the configured flank when outcrops have not been discovered, without queueing guessed sites', async () => {
      for (const team of DUEL) {
        const { obs, matchData } = fixture(team);
        obs.lodes = [];
        matchData.rules = { ...matchData.rules, map: { ...matchData.rules.map, contestedZones: [
          { kind: 'flanks', sets: 1, loads: 150, minRadius: 0, maxRadius: 9, maxSkew: 10 },
        ] } };
        const intents = await (await commander(team, matchData))(obs);
        expect(builds(intents)).toEqual([]);
        const flank = { x: 40.5, y: 8.5 };
        expect(intents.some((i) => i.kind === 'move' && i.mode === 'fight' && i.units.length >= 3 &&
          i.x === (team === 'nw' ? flank.x : matchData.rules.map.size - flank.x) && i.y === (team === 'nw' ? flank.y : matchData.rules.map.size - flank.y))).toBe(true);
      }
    });

    it.each([0, 1, 3])('requires a ground detachment at the actual outcrop before building (%i nearby)', async (nearby) => {
      for (const team of DUEL) {
        const { obs, matchData } = fixture(team, nearby);
        const lode = obs.lodes[0]!;
        const intents = await (await commander(team, matchData))(obs);
        expect(builds(intents)).toHaveLength(nearby >= 3 ? 1 : 0);
        // A held rich outcrop's Headframe is funded first in the Surface lane (planes/surface.md, `index: 0`).
        if (nearby >= 3) expect(builds(intents)[0]).toEqual({ kind: 'queue_add', item: 'headframe', x: lode.x, y: lode.y, index: 0 });
        expect(intents.some((i) => i.kind === 'move' && i.mode === 'fight' && i.units.length >= 3 &&
          i.x === lode.x + 0.5 && i.y === lode.y + 0.5)).toBe(true);
        expect(intents.some((i) => i.kind === 'move' && i.mode === 'move')).toBe(false);
      }
    });

    it('clears enemy fighters before building and does not count flak as a ground detachment', async () => {
      for (const flak of [false, true]) {
        const { obs, matchData } = fixture('nw', 3);
        const guards = obs.entities.filter((e) => e.kind === 'trooper').slice(0, 3);
        if (flak) for (const guard of guards) guard.kind = 'flak';
        else obs.entities.push({ ...guards[0]!, id: 'e_2000', side: 'se' });
        expect(builds(await (await commander('nw', matchData))(obs))).toEqual([]);
      }
    });

    it('guards a teammate’s queued flank Headframe without issuing a duplicate, even when resources run dry', async () => {
      const { obs, matchData } = fixture('nw', 3);
      const lode = obs.lodes[0]!;
      obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 0;
      obs.queue = [{ id: 'q_1', item: 'headframe', plane: 'surface', by: 'surface', byCtl: 'bot',
        x: lode.x + 0.5, y: lode.y + 0.5, alloy: matchData.rules.stats.headframe.alloy, energy: 0,
        heldAlloy: 0, heldEnergy: 0, recovery: false, paid: true, next: false, status: 'building', progress: 0.5, site: 'e_2000' }];
      const intents = await (await commander('nw', matchData))(obs);
      expect(builds(intents)).toEqual([]);
      expect(intents.some((i) => i.kind === 'move' && i.mode === 'fight' && i.units.length >= 3 &&
        i.x === lode.x + 0.5 && i.y === lode.y + 0.5)).toBe(true);
    });

    it('raids an enemy rich-lode Headframe well outside the centre', async () => {
      // Routing keeps destinations on open ground: the raid stops on the cell beside the Headframe's 3×3 footprint
      // nearest its centre (the footprint itself is not walkable), mirrored for red.
      const raids: string[] = [];
      for (const team of DUEL) {
        const { obs, matchData } = fixture(team);
        const size = matchData.rules.map.size;
        const lode = obs.lodes[0]!;
        const unit = obs.entities.find((e) => e.kind === 'trooper')!;
        obs.entities.push({ ...unit, id: 'e_2000', kind: 'headframe', side: team === 'nw' ? 'se' : 'nw',
          x: lode.x + 0.5, y: lode.y + 0.5 });
        const intents = await (await commander(team, matchData))(obs);
        expect(builds(intents)).toEqual([]);
        const raid = intents.find((i): i is Extract<AgentCommandIntent, { kind: 'move' }> =>
          i.kind === 'move' && i.mode === 'fight' && i.units.length >= 3);
        expect(raid).toBeDefined();
        expect(Math.max(Math.abs(Math.floor(raid!.x) - lode.x), Math.abs(Math.floor(raid!.y) - lode.y))).toBe(2);
        expect(Math.hypot(raid!.x - lode.x - 0.5, raid!.y - lode.y - 0.5)).toBe(2);
        raids.push(team === 'nw' ? `${raid!.x},${raid!.y}` : `${size - raid!.x},${size - raid!.y}`);
      }
      expect(raids[1]).toBe(raids[0]);
    });

    it('does not leave home to claim a contested lode under a defend mandate', async () => {
      const { obs, matchData } = fixture('nw');
      const lode = obs.lodes[0]!;
      obs.mandate.directive.stance = 'defend';
      const intents = await (await commander('nw', matchData))(obs);
      expect(builds(intents)).toEqual([]);
      expect(intents.some((i) => i.kind === 'move' && i.x === lode.x + 0.5 && i.y === lode.y + 0.5)).toBe(false);
    });

    it('builds on a plateau home outcrop before a nearer low-ground one, mirrored', async () => {
      for (const team of DUEL) {
        const { obs, matchData } = fixture(team);
        const size = matchData.rules.map.size;
        const m = (v: number): number => (team === 'nw' ? v : size - 1 - v);
        const low = { x: m(10), y: m(4) };
        const high = { x: m(4), y: m(12) };
        const terrain = unpackTerrain(matchData.terrain, size);
        for (const [l, level] of [[low, SURFACE.ground], [high, SURFACE.high]] as const) {
          for (let y = l.y - 2; y <= l.y + 2; y++) for (let x = l.x - 2; x <= l.x + 2; x++) terrain[y * size + x] = level;
        }
        matchData.terrain = packTerrain(terrain);
        obs.lodes = [low, high].map((l) => ({ ...l, rich: false, open: false, loads: 80 }));
        // An eye on each outcrop's apron, on its own level: only high ground sees the plateau top.
        const unit = obs.entities.find((e) => e.side === team && e.kind === 'trooper')!;
        for (const [i, l] of [low, high].entries()) obs.entities.push({ ...unit, id: `e_${3000 + i}`, x: l.x + 0.5, y: l.y + (team === 'nw' ? 2.5 : -1.5) });
        const intents = await (await commander(team, matchData))(obs);
        expect(builds(intents)).toEqual([{ kind: 'queue_add', item: 'headframe', x: high.x, y: high.y }]);
      }
    });
  });

  it('a team run entirely by the example policies beats the novice bots, with only schema-valid intents', async () => {
    const g = createGame({ seed: 21 });
    const policies = await Promise.all(PLANES.map(async (role) => ({ team: 'nw' as ArmyId, role, policy: await load(role, g.matchData({ team: 'nw', role })), since: 0 })));
    const bots = PLANES.map((role) => {
      const team = 'se' as const;
      const bot = definition.createBot({ team, role }, 'novice');
      bot.init?.(g.matchData({ team, role }));
      return { team, role, bot, since: 0 };
    });
    const codes: Record<string, number> = {};
    const rejected: Record<string, number> = {};
    const accepted: Partial<Record<AgentCommandIntent['kind'], number>> = {};
    let calls = 0;
    let logs = 0;
    let army = 0;
    let vantage = 0;
    // The Surface example's plan, from its own plan-change log lines ("home -> centre with …").
    let plan = 'home';
    const maxCpuMs: Partial<Record<Plane, number>> = {};
    while (g.outcome('nw') === 'running' && g.tick < toTicks(20 * 60)) {
      if (g.tick % BOT_PERIOD === 0) {
        // Simultaneous decisions: every seat of both teams observes the start-of-tick world, then all intents apply.
        const seen = [...policies, ...bots].map((s) => {
          const obs = g.observe({ team: s.team, role: s.role }, s.since);
          s.since = g.tick;
          return obs;
        });
        // One sandbox call at a time (each call has its own time budget).
        const decided: AgentCommandIntent[][] = [];
        for (const [i, s] of policies.entries()) {
          calls++;
          const d = await decide(s.policy, s.role, seen[i]!);
          logs += d.logs;
          if (s.role === 'surface') for (const line of d.lines) plan = /-> (\w+) with/.exec(String(line))?.[1] ?? plan;
          maxCpuMs[s.role] = Math.max(maxCpuMs[s.role] ?? 0, d.cpuMs);
          decided.push(d.intents);
        }
        bots.forEach((b, i) => decided.push(b.bot.think(seen[policies.length + i]!)));
        [...policies, ...bots].forEach((s, i) => {
          for (const intent of decided[i]!) {
            const ack = g.apply({ team: s.team, role: s.role }, intent);
            if (s.team !== 'nw') continue;
            const code = ack.ok ? 'ok' : ack.code;
            codes[code] = (codes[code] ?? 0) + 1;
            if (ack.ok) accepted[intent.kind] = (accepted[intent.kind] ?? 0) + 1;
            else {
              const key = `${s.role}:${intent.kind}:${ack.code}`;
              rejected[key] = (rejected[key] ?? 0) + 1;
            }
          }
        });
      }
      g.step();
      // Terrain-aware holds: while the army holds (home or centre), not while it marches on the enemy.
      if (plan !== 'attack') for (const e of g.sim.ents) {
        if (e.dead || e.side !== BLUE || e.plane !== 'surface' || (e.kind !== 'trooper' && e.kind !== 'tank' && e.kind !== 'flak')) continue;
        army++;
        const ground = g.sim.terrain[cellOf(e.x, e.y, g.sim.size)]!;
        if (isSurfaceHigh(ground) || surfaceFeature(ground) === SURFACE.forest) vantage++;
      }
    }
    console.log(`example policies vs novice: ${g.outcome('nw')} at tick ${g.tick}; ${calls} policy calls (max sandbox CPU ms per call ${JSON.stringify(maxCpuMs)}, budget ${limits.msPerCall}), ${logs} log lines, intent results ${JSON.stringify(codes)}, accepted ${JSON.stringify(accepted)}, holding army on vantage ${((100 * vantage) / army).toFixed(0)}%`);
    expect(g.outcome('nw')).toBe('win');
    expect(logs).toBeGreaterThan(0);
    const total = Object.values(codes).reduce((a, b) => a + b, 0);
    expect((codes.ok ?? 0) / total, JSON.stringify(rejected)).toBeGreaterThan(0.8);
    // The examples use rails, shared digging plans and terrain-aware holds; raid timing is checked separately. A
    // stronger economy (Headframes committed before cheaper buys) attacks sooner and longer, so vantage is measured
    // while holding, with a real holding phase behind it.
    expect(army).toBeGreaterThan(10_000);
    expect(accepted.rail).toBeGreaterThan(0);
    expect(accepted.designate).toBeGreaterThan(0);
    expect(vantage / army).toBeGreaterThan(0.15);
  }, 300_000);

  it('the surface starter sends an accepted first breach squad at its breachFrom for either team, its troopers given no other order', async () => {
    for (const team of DUEL) {
      const g = createGame({ seed: 21 });
      for (let i = 0; i < 5; i++) g.sim.spawnUnit(armyOf(team), 'trooper', 'surface');
      readyShaft(g, team);
      // A focused checkpoint at the starter's first-raid time (knob breachFrom): a fast default victory may precede it.
      g.sim.tick = knobDefault('surface', 'breachFrom');
      const matchData = g.matchData({ team, role: 'surface' });
      const policy = await load('surface', matchData);
      const decision = await decide(policy, 'surface', g.observe({ team, role: 'surface' }, 0));
      const raid = decision.intents.find((intent) => intent.kind === 'transfer');
      expect(raid).toMatchObject({ kind: 'transfer', to: 'depths' });
      if (!raid || raid.kind !== 'transfer') throw new Error('scheduled raid missing');
      expect(raid.units.length).toBeGreaterThanOrEqual(4);
      expect(decision.intents.filter((i) => i.kind === 'move').every((i) => i.kind === 'move' && i.units.every((id) => !raid.units.includes(id)))).toBe(true);
      expect(g.apply({ team, role: 'surface' }, raid)).toEqual({ ok: true });
    }
  });

  /** Three cells of hole `kind` across the lane 6 tiles out from `team`'s Spire, over cavern its depths seat reaches. */
  const holed = (team: ArmyId, kind: keyof typeof HOLE, options: MatchOptions = {}) => {
    const g: AgentCommandGame = createGame({ seed: 5, options });
    const p = DEFAULT_SPIRES[team];
    const m = team === 'nw' ? 1 : -1;
    const c = cellOf(p.x + m * 6, p.y + m * 6, g.sim.size);
    g.sim.openCells([c, c + 1, c - 1], HOLE[kind], team === 'nw' ? RED : BLUE);
    g.step();
    return { g, c };
  };

  it.each(['chasm', 'crater', 'sinkhole'] as const)('the depths policy backfills a %s that cuts the lanes near home', async (kind) => {
    for (const team of DUEL) {
      const { g, c } = holed(team, kind);
      const policy = await load('depths', g.matchData({ team, role: 'depths' }), DECIDE_FIRST);
      const { intents } = await decide(policy, 'depths', g.observe({ team, role: 'depths' }, 0));
      const fill = intents.find((i) => i.kind === 'bridge');
      expect(fill, team).toBeDefined();
      expect(g.apply({ team, role: 'depths' }, fill!)).toEqual({ ok: true });
      expect(fill && 'x' in fill ? Math.hypot(fill.x - (c % g.sim.size), fill.y - Math.floor(c / g.sim.size)) : Infinity).toBeLessThanOrEqual(1);
    }
  });

  it('the depths policy leaves holes alone when rules.depths.backfillKinds is 0 or excludes their kind', async () => {
    for (const team of DUEL) for (const [kind, backfillKinds] of [['chasm', 0], ['crater', 1 << HOLE_KINDS.indexOf('chasm')]] as const) {
      const { g } = holed(team, kind, { depths: { backfillKinds } });
      const policy = await load('depths', g.matchData({ team, role: 'depths' }), DECIDE_FIRST);
      const { intents } = await decide(policy, 'depths', g.observe({ team, role: 'depths' }, 0));
      expect(intents.filter((i) => i.kind === 'bridge'), `${team} ${kind}`).toEqual([]);
    }
  });

  it('the depths policy crews the Mother Lode cell on its side and researches Drill Bits once its diggers stand, never when switched off', async () => {
    for (const team of DUEL) for (const on of [true, false]) {
      const g = createGame({ seed: 5, options: on ? {} : { map: { params: { motherLode: { enabled: false } } }, research: { drillBitsEnabled: false } } });
      for (let i = 0; i < 6; i++) g.sim.spawnUnit(armyOf(team), 'digger', 'depths');
      const seat = { team, role: 'depths' } as const;
      const policy = await load('depths', g.matchData(seat), DECIDE_FIRST);
      const obs = g.observe(seat, 0);
      const { intents } = await decide(policy, 'depths', obs);
      const crew = intents.filter((i) => i.kind === 'mine' && i.x !== undefined && i.y !== undefined && obs.depths![Math.floor(i.y) * g.sim.size + Math.floor(i.x)] === CELL.lode);
      // A duel's centre 2×2: one cell nearer each Spire, two as near both (contested: the starter leaves them).
      expect(crew.length, `${team} ${on}`).toBe(on ? 1 : 0);
      const near = (i: AgentCommandIntent) => i.kind === 'mine' && Math.hypot(i.x! - DEFAULT_SPIRES[team].x, i.y! - DEFAULT_SPIRES[team].y) < Math.hypot(i.x! - DEFAULT_SPIRES[team === 'nw' ? 'se' : 'nw'].x, i.y! - DEFAULT_SPIRES[team === 'nw' ? 'se' : 'nw'].y);
      for (const order of crew) expect(near(order), team).toBe(true);
      for (const order of crew) expect(g.apply(seat, order, { source: 'policy' })).toEqual({ ok: true });
      expect(intents.filter((i) => i.kind === 'research'), `${team} ${on}`).toEqual(on ? [{ kind: 'research', upgrade: 'drill_bits', ifAffordable: true }] : []);
    }
  });

  it('the depths policy crews rules.depths.motherLodeCrewPerCell diggers on its lode cell', async () => {
    for (const team of DUEL) {
      const g = createGame({ seed: 5, options: { depths: { motherLodeCrewPerCell: 2 } } });
      for (let i = 0; i < 6; i++) g.sim.spawnUnit(armyOf(team), 'digger', 'depths');
      const seat = { team, role: 'depths' } as const;
      const policy = await load('depths', g.matchData(seat), DECIDE_FIRST);
      const obs = g.observe(seat, 0);
      const { intents } = await decide(policy, 'depths', obs);
      const crew = intents.filter((i) => i.kind === 'mine' && i.x !== undefined && i.y !== undefined && obs.depths![Math.floor(i.y) * g.sim.size + Math.floor(i.x)] === CELL.lode);
      // One cell on its side, two diggers on it.
      expect(crew.length, team).toBe(2);
      expect(new Set(crew.map((i) => i.kind === 'mine' && `${i.x},${i.y}`)).size, team).toBe(1);
      for (const order of crew) expect(g.apply(seat, order, { source: 'policy' })).toEqual({ ok: true });
    }
  });
});
