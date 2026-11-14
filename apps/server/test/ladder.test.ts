import { describe, expect, it } from 'vitest';
import { effectiveVerdict, type CommanderLogEntry, type CommanderLogVerdict, type CommanderLogVerdictRow } from 'playerthree/results';
import type { CommanderLogContext } from 'playerthree/host';
import { PLANES } from '@agent-command/game';
import { binomialTail, decayed, integritySignals, LADDER, ladderPoints, LadderState, nextSeason, quarterOf, ratingKey, repeatWeight, segmentId, verdictFor, type RatedMatchRecord, type Season } from '../src/ladder.ts';

const T0 = Date.UTC(2000, 10, 2);
let ids = 0;

/** A signed-log entry of one army of a rated policy duel, every plane this commander's. */
function entry(team: 'nw' | 'se', over: Partial<CommanderLogEntry> = {}): CommanderLogEntry {
  const id = `c_${team}${'x'.repeat(17)}`;
  return {
    format: 'playerthree.commanderLog', version: 1, entryId: `e${++ids}`, seq: 1, prevDigest: null, digest: 'd'.repeat(64),
    game: 'agent-command', gameVersion: '1', surfaceHash: 's', matchId: 'm1', host: { origin: 'https://ladder.test', keyId: 'k_1', official: true },
    commander: id, kind: 'policy', sealed: 'f'.repeat(64), mode: 'duel_1v1', queue: 'rated_policy_1v1', rulesHash: 'sha256:std', customRules: false,
    map: { id: 'crossfire', identity: null, seed: 1, size: 48, layout: 'duel' }, seed: 9, selfPlay: false, team,
    seats: PLANES.map((role) => ({ team, role, fromTick: 0, toTick: 6000 })), planesControlled: 4, planesTotal: 4, planeShare: 1,
    lineup: PLANES.map((role) => ({ role, kind: 'policy' as const, sameOwner: true, commander: id })),
    opponents: [{ team: team === 'nw' ? 'se' : 'nw', rank: team === 'nw' ? 2 : 1, seats: PLANES.map((role) => ({ role, kind: 'policy' as const, commander: `c_${team === 'nw' ? 'se' : 'nw'}${'x'.repeat(17)}` })) }],
    control: [], ownerIntents: 0, ownerTells: 0, fallbackTicks: {}, absentPolicyTicks: {}, pausedMs: {}, acceptedIntents: { surface: 1000 },
    assist: 'none', fallbackShare: 0, policies: [{ role: 'surface', version: 1, runtime: 'js', surfaceHash: 's', artifactHash: 'a'.repeat(64) }], policySwitches: [],
    executionKind: 'policy', harness: null, outcome: team === 'nw' ? 'win' : 'loss', disposition: 'final', rank: team === 'nw' ? 1 : 2, terminalReason: 'game',
    ticks: 6000, simSeconds: 300, wallMs: 300_000, startedAt: T0, endedAt: T0 + 300_000, replayRef: { session: 'm1', digest: 'r'.repeat(64), kept: true },
    verdict: { rated: false, pool: null, segmentId: null, weight: 0, badges: [], reasons: [] }, sig: 'sig', ...over,
  };
}

function record(over: Partial<RatedMatchRecord> = {}): RatedMatchRecord {
  return { matchId: 'm1', pool: 'policy_1v1', season: '2000Q4', createdAt: T0, rulesHash: 'sha256:std', map: { map: 'crossfire', layout: 'duel' }, mapSeed: 1,
    armies: [{ id: 'nw', alliance: 'blue' }, { id: 'se', alliance: 'red' }],
    sides: [{ team: 'nw', owner: 'alice', cluster: 'alice', eligible: true, commanders: ['id-nw'] }, { team: 'se', owner: 'bob', cluster: 'bob', eligible: true, commanders: ['id-se'] }], repeat: 1, ...over };
}

const ctx = (e: CommanderLogEntry, declared: CommanderLogContext['declared'] = {}): CommanderLogContext => ({ commanderId: `id-${e.team}`, ownerRef: e.team === 'nw' ? 'alice' : 'bob', declared, entry: e });

/** Both entries of a rated duel, verdicts stamped as the host does. */
function duel(matchId: string, at: number, winner: 'nw' | 'se' | 'draw', over: { nw?: Partial<CommanderLogEntry>; se?: Partial<CommanderLogEntry>; record?: Partial<RatedMatchRecord>; declared?: CommanderLogContext['declared'] } = {}) {
  const rank = (team: 'nw' | 'se') => winner === 'draw' ? 1 : winner === team ? 1 : 2;
  const outcome = (team: 'nw' | 'se') => winner === 'draw' ? 'draw' as const : winner === team ? 'win' as const : 'loss' as const;
  const rec = record({ matchId, createdAt: at, ...over.record });
  return (['nw', 'se'] as const).map((team) => {
    const e = entry(team, { matchId, startedAt: at, endedAt: at + 300_000, rank: rank(team), outcome: outcome(team), ...over[team] });
    return { entry: e, verdict: verdictFor(ctx(e, over.declared), rec, true) };
  });
}

describe('verdicts (§7.1)', () => {
  const reasons = (v: CommanderLogVerdict) => v.reasons;
  it('rates a clean match and names every reason that voids one', () => {
    const base = entry('nw');
    expect(verdictFor(ctx(base), record(), true)).toMatchObject({ rated: true, pool: 'policy_1v1', weight: 1, reasons: [], badges: [] });
    const cases: [string, CommanderLogEntry, RatedMatchRecord | undefined, boolean][] = [
      ['unofficial_host', base, record(), false],
      ['lobby_match', entry('nw', { queue: null }), undefined, true],
      ['custom_rules', entry('nw', { customRules: true }), record(), true],
      ['custom_alliances', entry('nw', { mode: 'custom_alliances' }), record(), true],
      ['same_owner', entry('nw', { selfPlay: true }), record(), true],
      ['same_cluster', base, record({ sides: [{ team: 'nw', owner: 'alice', cluster: 'k', eligible: true, commanders: ['id-nw'] }, { team: 'se', owner: 'bob', cluster: 'k', eligible: true, commanders: ['id-se'] }] }), true],
      ['assisted', entry('nw', { assist: 'owner_chat' }), record(), true],
      ['interrupted', entry('nw', { disposition: 'interrupted', outcome: 'unknown' }), record(), true],
      ['aborted', entry('nw', { disposition: 'aborted', outcome: 'unknown', ticks: 0 }), record(), true],
      ['bot_opponent', entry('nw', { opponents: [{ team: 'se', rank: 2, seats: PLANES.map((role) => ({ role, kind: 'bot' as const, commander: null, botLevel: 'veteran' })) }] }), record(), true],
      ['human_seat', entry('nw', { lineup: PLANES.map((role) => ({ role, kind: role === 'surface' ? 'human' as const : 'policy' as const, sameOwner: true })) }), record(), true],
      ['mixed_kind', entry('nw', { opponents: [{ team: 'se', rank: 2, seats: PLANES.map((role) => ({ role, kind: 'agent' as const, commander: 'c_y' })) }] }), record(), true],
      ['repeat_pair', base, record({ repeat: LADDER.repeat.cap + 1 }), true],
      ['provisional_account', base, record({ sides: [{ team: 'nw', owner: 'alice', cluster: 'alice', eligible: false, commanders: ['id-nw'] }, record().sides[1]!] }), true],
    ];
    for (const [reason, e, rec, official] of cases) {
      const v = verdictFor(ctx(e), rec, official);
      expect(v.rated, reason).toBe(false);
      expect(reasons(v), reason).toContain(reason);
    }
    // The gauntlet is logged, never rated.
    expect(verdictFor(ctx(entry('nw', { queue: 'gauntlet' })), undefined, true)).toMatchObject({ rated: false, pool: null });
    // A later review void is a verdict row; the entry itself is never rewritten.
    const row: CommanderLogVerdictRow = { entryId: base.entryId, at: T0 + 1, verdict: { rated: false, pool: 'policy_1v1', segmentId: 's', weight: 0, badges: [], reasons: ['voided_review'] }, reason: 'review', keyId: 'k', sig: 's' };
    expect(effectiveVerdict({ ...base, verdict: verdictFor(ctx(base), record(), true) }, [row]).reasons).toEqual(['voided_review']);
  });

  it('keeps a fallback-heavy match rated with its badge and damps repeat pairs', () => {
    expect(verdictFor(ctx(entry('nw', { fallbackShare: 0.4 })), record(), true)).toMatchObject({ rated: true, badges: ['fallback_heavy'] });
    expect(verdictFor(ctx(entry('nw')), record({ repeat: 3 }), true).weight).toBe(repeatWeight(3));
    expect(repeatWeight(1)).toBe(1);
    expect(repeatWeight(3)).toBe(0.5);
  });

  it('flags an inactive side and an early leaver instead of voiding them', () => {
    expect(verdictFor(ctx(entry('nw', { acceptedIntents: { surface: 0 } })), record(), true)).toMatchObject({ rated: true, reasons: ['inactive_side'] });
    expect(verdictFor(ctx(entry('nw', { disposition: 'abandoned', outcome: 'loss', rank: 2, ticks: 100, acceptedIntents: { surface: 50 } })), record(), true)).toMatchObject({ rated: true, reasons: ['too_short'] });
    // Too short with nobody leaving early is void for everyone.
    const state = new LadderState();
    state.apply(duel('m1', T0, 'nw', { nw: { ticks: LADDER.minTicks - 1 }, se: { ticks: LADDER.minTicks - 1 } }), '2000Q4', new Map());
    expect(state.ratings.size).toBe(0);
  });
});

describe('ladder state', () => {
  const seasonOf = () => '2000Q4';
  const segment = (team: 'nw' | 'se', declared = {}) => segmentId(`id-${team}`, 'policy_1v1', declared);
  const rating = (state: LadderState, team: 'nw' | 'se', declared = {}) => state.ratings.get(ratingKey('policy_1v1', seasonOf(), segment(team, declared)))!;

  it('updates winners up and losers down; ladder points are 40 × (μ − 3σ), at least 0', () => {
    const state = new LadderState();
    state.apply(duel('m1', T0, 'nw'), seasonOf(), new Map());
    expect(rating(state, 'nw').mu).toBeGreaterThan(LADDER.mu);
    expect(rating(state, 'se').mu).toBeLessThan(LADDER.mu);
    expect(rating(state, 'nw')).toMatchObject({ games: 1, wins: 1, losses: 0 });
    expect(ladderPoints({ mu: 25, sigma: 25 / 3 })).toBe(0);
    expect(ladderPoints({ mu: 30, sigma: 2 })).toBe(960);
  });

  it('incremental application equals a recompute in (endedAt, matchId) order', () => {
    const matches = [duel('m1', T0, 'nw'), duel('m2', T0 + 1e6, 'se'), duel('m3', T0 + 2e6, 'draw'), duel('m4', T0 + 3e6, 'nw')];
    const incremental = new LadderState();
    // Entries of one match arrive in any order; matches are applied as each completes.
    for (const m of matches) incremental.apply([...m].reverse(), seasonOf(), new Map());
    const recompute = new LadderState();
    for (const m of [...matches].sort((a, b) => a[0]!.entry.endedAt - b[0]!.entry.endedAt)) recompute.apply(m, seasonOf(), new Map());
    expect(Object.fromEntries(recompute.ratings)).toEqual(Object.fromEntries(incremental.ratings));
  });

  it('a review void removes the match on recompute', () => {
    const m1 = duel('m1', T0, 'nw'), m2 = duel('m2', T0 + 1e6, 'nw');
    const full = new LadderState();
    for (const m of [m1, m2]) full.apply(m, seasonOf(), new Map());
    const voided = new LadderState();
    const rows: CommanderLogVerdictRow[] = m2.map((e) => ({ entryId: e.entry.entryId, at: T0 + 2e6, verdict: { ...e.verdict, rated: false, reasons: ['voided_review'] }, reason: 'review', keyId: 'k', sig: 's' }));
    for (const m of [m1, m2]) voided.apply(m.map((e) => ({ entry: e.entry, verdict: effectiveVerdict({ ...e.entry, verdict: e.verdict }, rows) })), seasonOf(), new Map());
    expect(rating(voided, 'nw').games).toBe(1);
    expect(rating(full, 'nw').games).toBe(2);
    expect(rating(voided, 'nw').mu).toBeLessThan(rating(full, 'nw').mu);
  });

  it('starts a new segment at μ₀/σ₀ when the declared metadata changes; renames are cosmetic', () => {
    const state = new LadderState();
    state.apply(duel('m1', T0, 'nw'), seasonOf(), new Map());
    state.apply(duel('m2', T0 + 1e6, 'nw', { declared: { model: 'next' } }), seasonOf(), new Map());
    const fresh = rating(state, 'nw', { model: 'next' });
    expect(fresh.games).toBe(1);
    expect(rating(state, 'nw').games).toBe(1);
    expect(segment('nw', { model: 'next' })).not.toBe(segment('nw'));
    expect(fresh.mu).toBeCloseTo(rating(state, 'nw').mu, 6);
  });

  it('a new policy version keeps μ and inflates σ² by 2²; inactivity adds 0.5² per full week up to σ₀', () => {
    const state = new LadderState();
    for (let i = 0; i < 6; i++) state.apply(duel(`m${i}`, T0 + i * 1e6, i % 2 ? 'se' : 'nw'), seasonOf(), new Map());
    const before = rating(state, 'nw');
    const bumped = new LadderState();
    for (const [key, value] of state.ratings) bumped.ratings.set(key, { ...value });
    const same = new LadderState();
    for (const [key, value] of state.ratings) same.ratings.set(key, { ...value });
    const next = (s: LadderState, artifact: string) => s.apply(duel('m9', T0 + 9e6, 'nw', { nw: { policies: [{ role: 'surface', version: 2, runtime: 'js', surfaceHash: 's', artifactHash: artifact }] } }), seasonOf(), new Map());
    next(bumped, 'b'.repeat(64));
    next(same, 'a'.repeat(64));
    const bumpedEvent = bumped.events.find((ev) => ev.matchId === 'm9' && ev.segmentId === segment('nw'))!;
    const sameEvent = same.events.find((ev) => ev.matchId === 'm9' && ev.segmentId === segment('nw'))!;
    expect(bumpedEvent.before.mu).toBe(before.mu);
    expect(bumpedEvent.before.sigma ** 2).toBeCloseTo(before.sigma ** 2 + 4, 9);
    expect(sameEvent.before.sigma).toBe(before.sigma);
    expect(decayed({ sigma: 3, lastPlayed: 0 }, 3 * LADDER.weekMs + 1)).toBeCloseTo(Math.sqrt(9 + 3 * 0.25), 12);
    expect(decayed({ sigma: 3, lastPlayed: 0 }, 6 * LADDER.weekMs - 1)).toBeCloseTo(Math.sqrt(9 + 5 * 0.25), 12);
    expect(decayed({ sigma: 8, lastPlayed: 0 }, 100 * LADDER.weekMs)).toBe(LADDER.sigma);
  });

  it('an abandon is a loss for the leaver; a short forfeit moves only the leaver; interrupted is void', () => {
    const abandon = new LadderState();
    abandon.apply(duel('m1', T0, 'nw', { se: { disposition: 'abandoned' } }), seasonOf(), new Map());
    expect(rating(abandon, 'se')).toMatchObject({ losses: 1 });
    expect(rating(abandon, 'se').mu).toBeLessThan(LADDER.mu);
    expect(rating(abandon, 'nw').mu).toBeGreaterThan(LADDER.mu);
    const early = new LadderState();
    early.apply(duel('m1', T0, 'nw', { se: { disposition: 'forfeit', ticks: 100, acceptedIntents: { surface: 50 } }, nw: { ticks: 100, acceptedIntents: { surface: 50 } } }), seasonOf(), new Map());
    expect(rating(early, 'se').mu).toBeLessThan(LADDER.mu);
    expect(rating(early, 'nw').mu).toBe(LADDER.mu);
    const interrupted = new LadderState();
    interrupted.apply(duel('m1', T0, 'nw', { nw: { disposition: 'interrupted', outcome: 'unknown', rank: null }, se: { disposition: 'interrupted', outcome: 'unknown', rank: null } }), seasonOf(), new Map());
    expect(interrupted.ratings.size).toBe(0);
  });

  it('an assisted army is void and its opponent keeps wins only; an inactive side loses alone', () => {
    const won = new LadderState();
    won.apply(duel('m1', T0, 'nw', { se: { assist: 'owner_intents' } }), seasonOf(), new Map());
    expect(rating(won, 'nw').mu).toBeGreaterThan(LADDER.mu);
    expect(won.ratings.has(ratingKey('policy_1v1', seasonOf(), segment('se')))).toBe(false);
    const lost = new LadderState();
    lost.apply(duel('m1', T0, 'se', { se: { assist: 'owner_intents' } }), seasonOf(), new Map());
    expect(rating(lost, 'nw').mu).toBe(LADDER.mu);
    const idle = new LadderState();
    idle.apply(duel('m1', T0, 'se', { se: { acceptedIntents: { surface: 0 } } }), seasonOf(), new Map());
    expect(rating(idle, 'se')).toMatchObject({ losses: 1 });
    expect(rating(idle, 'nw').mu).toBe(LADDER.mu);
  });

  it('opens a new season at a quarter boundary or a new build; the next season carries μ with σ ≥ 5', () => {
    const q = quarterOf(T0);
    const first = nextSeason([], T0, '1', 'sha256:std').current;
    expect(first).toMatchObject({ id: q.id, startsAt: q.start, endsAt: q.end });
    expect(nextSeason([first], T0 + 1e6, '1', 'sha256:std').current).toBe(first);
    const build = nextSeason([first], T0 + 2e6, '2', 'sha256:std');
    expect(build.current).toMatchObject({ id: `${q.id}.2`, startsAt: T0 + 2e6, gameVersion: '2' });
    expect(build.closed).toMatchObject({ id: q.id, endsAt: T0 + 2e6 });
    const rules = nextSeason([{ ...first, endsAt: T0 + 2e6, frozenAt: T0 + 2e6, digest: 'x' }, build.current], T0 + 3e6, '2', 'sha256:new');
    expect(rules.current.id).toBe(`${q.id}.3`);
    const quarter = nextSeason([build.current], q.end + 1, '2', 'sha256:std');
    expect(quarter.current.id).toBe(quarterOf(q.end + 1).id);
    const seasons: Season[] = [first, build.current];
    const state = new LadderState((pool, season, seg) => season === build.current.id ? state.ratings.get(ratingKey(pool, first.id, seg)) : undefined);
    for (let i = 0; i < 30; i++) state.apply(duel(`m${i}`, T0 + i * 1e5, i % 3 ? 'nw' : 'se'), first.id, new Map());
    const old = state.ratings.get(ratingKey('policy_1v1', first.id, segment('nw')))!;
    expect(old.sigma).toBeLessThan(LADDER.seasonSigmaFloor);
    state.apply(duel('n1', T0 + 3e6, 'nw'), build.current.id, new Map());
    const carried = state.events.find((ev) => ev.matchId === 'n1' && ev.segmentId === segment('nw'))!;
    expect(carried.before).toEqual({ mu: old.mu, sigma: LADDER.seasonSigmaFloor });
    expect(seasons).toHaveLength(2);
  });
});

describe('integrity signals', () => {
  it('flags early forfeits, idle losers, shared artifacts across sides and lopsided pairs', () => {
    const flags = integritySignals([
      entry('nw', { matchId: 'x1', disposition: 'forfeit', ticks: 100, outcome: 'loss' }),
      entry('se', { matchId: 'x1', acceptedIntents: {}, outcome: 'loss' }),
      entry('nw', { matchId: 'x2' }), entry('se', { matchId: 'x2' }),
    ], []);
    const kinds = new Set(flags.map((f) => f.kind));
    expect(kinds).toEqual(new Set(['early_forfeit', 'idle_loser', 'idle_policy', 'shared_artifact']));
    expect(binomialTail(10, 10)).toBeLessThan(0.01);
    expect(binomialTail(5, 10)).toBe(1);
    const pairs = integritySignals(Array.from({ length: 8 }, (_, i) => [entry('nw', { matchId: `p${i}`, policies: [] }), entry('se', { matchId: `p${i}`, policies: [] })]).flat(), []);
    expect(pairs.some((f) => f.kind === 'pair_imbalance')).toBe(true);
  });
});
