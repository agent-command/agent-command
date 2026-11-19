import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { commanderPublicId, verifyCommanderLog } from 'playerthree/results';
import { definition, PLANES } from '@agent-command/game';
import { LADDER, ratingKey, segmentId, type RatedMatchRecord } from '../src/ladder.ts';
import { json } from './helpers.ts';
import { closeDatabase, headers, linkedProfile, policyCommander, startRanked, type RankedServer } from './ranked-fixture.ts';

let r: RankedServer | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
afterAll(() => closeDatabase());

const game = definition.manifest.id;
const setCard = (base: string, secret: string, commanderId: string, open: boolean, discloseModel = false) =>
  fetch(`${base}/api/ladder/cards`, { method: 'POST', headers: headers(secret), body: JSON.stringify({ commanderId, public: open, discloseModel }) });

/** A rated duel played on the official host to the rated minimum length: real entries, verdicts and ratings. */
async function ratedDuel(r: RankedServer, a: { id: string; commander: string }, b: { id: string; commander: string }, rulesHash: string, season: string): Promise<string> {
  const map = { id: 'crossfire', identity: null, seed: 0, size: 48, layout: 'duel' };
  const match = r.server.host.createMatch({
    realtime: false, teams: ['nw', 'se'], alliances: { blue: ['nw'], red: ['se'] },
    assignments: [...PLANES.map((role) => ({ team: 'nw', role, owner: a.id, kind: 'policy' as const, commander: { id: a.commander } })), ...PLANES.map((role) => ({ team: 'se', role, owner: b.id, kind: 'policy' as const, commander: { id: b.commander } }))],
    log: { mode: 'duel_1v1', queue: 'rated_policy_1v1', rulesHash, customRules: false, map },
  });
  const record: RatedMatchRecord = { matchId: match.id, pool: 'policy_1v1', season, createdAt: Date.now(), rulesHash, map: { map: 'crossfire', layout: 'duel' }, mapSeed: 0,
    armies: [{ id: 'nw', alliance: 'blue' }, { id: 'se', alliance: 'red' }],
    sides: [{ team: 'nw', owner: a.id, cluster: a.id, eligible: true, commanders: [a.commander] }, { team: 'se', owner: b.id, cluster: b.id, eligible: true, commanders: [b.commander] }], repeat: 1 };
  await r.storage.query("INSERT INTO ac_rated_matches (match_id, pool, created_at, record) VALUES ($1, 'policy_1v1', now(), $2::jsonb)", [match.id, JSON.stringify(record)]);
  await match.step(LADDER.minTicks + 20);
  match.end({ nw: 'win', se: 'loss' });
  await r.server.host.commanderLog.flush();
  await r.server.ranked.settled();
  match.dispose();
  return match.id;
}

describe('public commander cards and the leaderboard', () => {
  it('show only opted-in commanders, gate opponent names on their opt-in and keep owners out of the page', { timeout: 180_000 }, async () => {
    r = await startRanked();
    const aliceProfile = await linkedProfile(r, 7001);
    const bobProfile = await linkedProfile(r, 7002);
    const alice = { id: aliceProfile.id, commander: await policyCommander(r, aliceProfile.secret, 'Alice Prime') };
    const bob = { id: bobProfile.id, commander: await policyCommander(r, bobProfile.secret, 'Bob Hidden') };
    const board = await json<{ season: string }>(await fetch(`${r.base}/api/ladder/leaderboard?pool=policy_1v1`));
    const rulesHash = 'sha256:standard-test';
    const matchId = await ratedDuel(r, alice, bob, rulesHash, board.season);
    const [aliceEntry] = (await r.server.host.commanderLog.match(matchId)).filter((row) => row.commanderId === alice.commander);
    expect(aliceEntry!.entry.verdict).toMatchObject({ rated: true, pool: 'policy_1v1' });
    expect(r.server.ranked.ratings().size).toBe(2);
    // The incremental update at commit equals a nightly recompute from the log.
    expect(await r.server.ranked.recompute()).toEqual({ changed: false });

    expect((await setCard(r.base, aliceProfile.secret, alice.commander, true)).status).toBe(200);
    expect((await setCard(r.base, bobProfile.secret, bob.commander, false)).status).toBe(200);
    const alicePublic = commanderPublicId(game, alice.commander);
    const bobPublic = commanderPublicId(game, bob.commander);

    const page = await fetch(`${r.base}/commanders/${alicePublic}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Alice Prime');
    expect(html).toContain('Private commander');
    expect(html).not.toContain('Bob Hidden');
    for (const tier of ['Verified by the host', 'Declared by owner', 'Self-reported']) expect(html).toContain(tier);
    // Hydration JSON and markup carry no owner ids, private commander ids or tokens; tooltips are data-tip, never title=.
    for (const secret of [aliceProfile.id, bobProfile.id, alice.commander, bob.commander, aliceProfile.secret]) expect(html).not.toContain(secret);
    expect(html.replace(/<title>[^<]*<\/title>/, '')).not.toMatch(/\stitle=/);
    expect(html).toContain('data-tip=');
    expect((await fetch(`${r.base}/commanders/${bobPublic}`)).status).toBe(404);

    // Bob opts in: Alice's card names him.
    await setCard(r.base, bobProfile.secret, bob.commander, true);
    expect(await (await fetch(`${r.base}/commanders/${alicePublic}`)).text()).toContain('Bob Hidden');

    // The signed public log verifies with the published keys and holds no sealed parts.
    const download = await json<{ entries: Parameters<typeof verifyCommanderLog>[0]; keys: Parameters<typeof verifyCommanderLog>[1] }>(await fetch(`${r.base}/commanders/${alicePublic}/log.json`));
    expect(verifyCommanderLog(download.entries, download.keys)).toEqual({ ok: true, entries: 1 });
    expect(JSON.stringify(download)).not.toContain(aliceProfile.id);

    // Leaderboard: opted-in, non-provisional, active rows only.
    const ratings = r.server.ranked.ratings();
    for (const [commander, owner] of [[alice.commander, alicePublic], [bob.commander, bobPublic]] as const) {
      const key = ratingKey('policy_1v1', board.season, segmentId(commander, 'policy_1v1', {}));
      const row = ratings.get(key)!;
      ratings.set(key, { ...row, publicId: owner, games: 12, sigma: 2, opponents: ['a', 'b', 'c', 'd', 'e'], lastPlayed: Date.now() });
    }
    await setCard(r.base, bobProfile.secret, bob.commander, false);
    const rows = (await json<{ rows: { publicId: string; name: string }[] }>(await fetch(`${r.base}/api/ladder/leaderboard?pool=policy_1v1&season=${board.season}`))).rows;
    expect(rows.map((row) => row.publicId)).toEqual([alicePublic]);
    const listed = await (await fetch(`${r.base}/leaderboard?pool=policy_1v1&season=${board.season}`)).text();
    expect(listed).toContain('Alice Prime');
    expect(listed).not.toContain('Bob Hidden');
    // Provisional commanders stay off the board.
    const aliceKey = ratingKey('policy_1v1', board.season, segmentId(alice.commander, 'policy_1v1', {}));
    ratings.set(aliceKey, { ...ratings.get(aliceKey)!, games: 9 });
    expect((await json<{ rows: unknown[] }>(await fetch(`${r.base}/api/ladder/leaderboard?pool=policy_1v1&season=${board.season}`))).rows).toEqual([]);

    // The sitemap lists opted-in cards only.
    const sitemap = await (await fetch(`${r.base}/sitemap.xml`)).text();
    expect(sitemap).toContain(`/commanders/${alicePublic}`);
    expect(sitemap).toContain('/leaderboard');
    expect(sitemap).not.toContain(bobPublic);

    // A review void reaches the ladder through a recompute.
    const before = r.server.ranked.ratings().size;
    for (const { entry } of await r.server.host.commanderLog.match(matchId)) await r.server.host.commanderLog.amend(entry.entryId, { ...entry.verdict, rated: false, weight: 0, reasons: ['voided_review'] }, 'review');
    expect(before).toBe(2);
    expect(await r.server.ranked.recompute()).toEqual({ changed: true });
    expect(r.server.ranked.ratings().size).toBe(0);
  });
});
