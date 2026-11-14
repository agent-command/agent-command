import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { surfaceHash } from 'playerthree';
import type { ResultsEnvelope, ResultsSummary, SeriesSpec } from 'playerthree/arena';
import { manifest, PLANES } from '@agent-command/game';
import { lobbyMode, MAPS } from '@agent-command/game/lobby';
import { resolveArenaMatch } from '@agent-command/game/arena';
import type { GameServer } from '../src/app.ts';
import { start, freshIp, json, until } from './helpers.ts';

let server: GameServer;
let base: string;
let auth: string;
let stranger: string;
const root = mkdtempSync(join(tmpdir(), 'ac-arena-'));
const web = join(root, 'web');
const map = MAPS.find(entry => entry.tags.includes('generated') && entry.layouts.some(layout => layout.id === 'duel' && layout.supported))!;
const ENTRANTS = ['left', 'right', 'third', 'fourth'];
/** Owners submit frozen identities: the canonical resolver fills rules hash, map seed and map identity. */
function spec(delayMs = 0, layoutId = 'duel'): SeriesSpec {
  // Each side is an army on its corner; its alliance is its (distinct) colour.
  const sides = lobbyMode(map.id, layoutId)!.sides.map((side, index) => ({ id: side.id, spawnSlot: side.id, alliance: side.alliance, seats: PLANES.map(role => ({ role, occupant: { kind: 'bot' as const, level: index ? 'idle' : 'standard', options: { aggression: 0.4, economyReserve: 0.6 } } })) }));
  const template = resolveArenaMatch({ format: 'playerthree.match', version: 1, game: manifest.id, gameVersion: manifest.version, surfaceHash: surfaceHash(manifest), rulesHash: '', seed: 42,
    map: { id: map.id, identity: '', seed: 42, layout: layoutId }, options: { spire: { timeCap: 60 } }, sides,
    bindings: sides.flatMap((side, index) => PLANES.map(role => ({ seat: { team: side.id, role }, entrantId: ENTRANTS[index]! }))),
    observerPolicy: { allowOmniscient: true, minDelayMs: delayMs }, rules: { ranked: false, coaching: 'off', practiceReasons: [] } });
  const labels = ['<script>alert(1)</script> & left', 'Right $& bot', 'Third bot', 'Fourth bot'];
  // A duel plays both orders; a four-army series here plays the lineup once (the rotation group is arena-lobby's).
  const orders = sides.length === 2 ? [[0, 1], [1, 0]] : [sides.map((_, index) => index)];
  return { format: 'playerthree.series', version: 1, game: manifest.id, gameVersion: manifest.version, surfaceHash: surfaceHash(manifest), track: 'bots',
    entrants: sides.map((_, index) => ({ id: ENTRANTS[index]!, label: labels[index]!, kind: 'bot' as const, aiPlayer: true as const })),
    template,
    scenarios: [{ id: 'seed-42', seed: 42, map: template.map, options: {} }],
    permutations: orders.map((order, index) => ({ id: index ? 'swapped' : 'original', sideEntrants: sides.map((side, slot) => ({ team: side.id, entrantId: ENTRANTS[order[slot]!]! })) })),
    repetitions: 1, execution: { concurrency: 1, speed: 20, clock: 'accelerated', maxTicks: 1300, maxWallMs: 60000, maxInfraRetries: 0, state: 'reset_each_match' },
    budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null },
    // Elo rates exactly two lineups; four-army series use TrueSkill.
    rating: sides.length === 2 ? { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 } : { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: 0.1 },
    telemetry: { sampleEveryTicks: 20, includeCommentary: false } };
}
async function request(path: string, body?: unknown, authorization = auth, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-forwarded-for': freshIp(), ...(authorization ? { authorization } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create(value = spec()) {
  const response = await request('/api/arena/series', value); expect(response.status).toBe(201);
  return json<{ id: string; revision: number }>(response);
}
beforeAll(async () => {
  mkdirSync(web); writeFileSync(join(web, 'index.html'), readFileSync(new URL('../../web/index.html', import.meta.url)));
  ({ server, base } = await start({ dataDir: join(root, 'data'), webDist: web, simSpeed: 1, endGraceMs: 1000, maxMatchMs: 60000 }));
  const first = await json<{ secret: string }>(await request('/api/profile', {}, '')); auth = `Bearer ${first.secret}`;
  const second = await json<{ secret: string }>(await request('/api/profile', {}, '')); stranger = `Bearer ${second.secret}`;
});
afterAll(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });

describe('canonical profile-owned arena service', () => {
  it('rejects owner spoofing, unknown fields, non-profile credentials and cross-origin mutations', async () => {
    expect((await request('/api/arena/series', spec(), '')).status).toBe(401);
    expect((await request('/api/arena/series', { ...spec(), owner: 'someone-else' })).status).toBe(400);
    expect((await request('/api/arena/series', spec(), auth, { Origin: 'https://attacker.invalid' })).status).toBe(403);
    const created = await create();
    expect((await request(`/api/arena/series/${created.id}`, undefined, stranger)).status).toBe(404);
    expect((await request(`/api/arena/series/${created.id}/start`, { token: 'not-profile-auth' })).status).toBe(400);
    expect((await request(`/api/arena/series/${created.id}/abort`, {})).status).toBe(204);
  });
  it('executes paired real matches, pins all attempts, records metrics and serves actual durable replays', async () => {
    const created = await create(); expect((await request(`/api/arena/series/${created.id}/start`, {})).status).toBe(204);
    // Two 1200-tick (60 s time cap) matches at speed 20 need ~6 s idle but over 20 s each on a loaded shared machine;
    // the wall budget only bounds a stuck match.
    const final = await until(async () => { const result = await json<ResultsSummary>(await request(`/api/arena/series/${created.id}`)); return result.state === 'completed' ? result : undefined; }, 110000);
    expect(final.tables.schedule).toHaveLength(2); expect(final.tables.matches).toHaveLength(2);
    expect(final.tables.matches.every(match => match.acceptedAttempt)).toBe(true);
    // Ranks come from the match: the two-army result ranks win 1, loss 2, and a draw shares rank 1.
    for (const match of final.tables.matches) expect(match.outcomes.map(row => [row.team, row.rank])).toEqual(match.outcomes.map(row => [row.team, row.outcome === 'loss' ? 2 : 1]));
    expect(final.tables.matches.every(match => /^sha256:[a-f0-9]{64}$/.test(match.spec.rulesHash) && /^sha256:[a-f0-9]{64}$/.test(match.spec.map.identity))).toBe(true);
    expect(final.tables.matches[0]!.spec.bindings[0]!.entrantId).not.toBe(final.tables.matches[1]!.spec.bindings[0]!.entrantId);
    expect(final.tables.metrics.some(metric => metric.metric === 'economy.stock.alloy' && metric.scope === 'side')).toBe(true);
    expect(final.tables.events.some(event => event.kind === 'host.lifecycle')).toBe(true);
    expect(final.tables.seats).toHaveLength(16);
    const artifacts = final.tables.artifacts.filter(ref => ref.availability === 'available' && ref.kind === 'replay');
    expect(artifacts).toHaveLength(2);
    const replays = await Promise.all(artifacts.map(async ref => {
      const replay = await request(`/api/arena/series/${created.id}/artifacts/${ref.id}`);
      expect(replay.status).toBe(200);
      return json<{ format: string; version: number; seed: number }>(replay);
    }));
    for (const replay of replays) expect(replay).toMatchObject({ format: 'playerthree.replay', version: 2 });
    // The public scenario seed (42, also the public map seed) never seeds the hidden world; the side swap of one
    // scenario still plays the same secret world.
    expect(replays[0]!.seed).not.toBe(42); expect(replays[0]!.seed).toBe(replays[1]!.seed);
    const exported = await json<ResultsEnvelope>(await request(`/api/arena/series/${created.id}/export.json?revision=${final.revision}`));
    expect(exported.tables.matches).toEqual(final.tables.matches); expect(final.format).toBe('playerthree.results.summary'); expect(exported.format).toBe('playerthree.results');
    expect((await request(`/api/arena/series/${created.id}/export.csv`)).headers.get('content-type')).toBe('application/zip');
  }, 120000);
  it('runs a four-army FFA match and records every army with its rank in the outcome rows', async () => {
    const created = await create(spec(0, 'ffa')); expect((await request(`/api/arena/series/${created.id}/start`, {})).status).toBe(204);
    const final = await until(async () => { const result = await json<ResultsSummary>(await request(`/api/arena/series/${created.id}`)); return result.state === 'completed' ? result : undefined; }, 110000);
    const [match] = final.tables.matches;
    expect(match!.acceptedAttempt).toBe(true);
    expect(match!.outcomes.map(row => row.team)).toEqual(['nw', 'ne', 'se', 'sw']);
    // Competition ranking from the match: winners (or the tied leaders of a draw) are 1, every loser is below them.
    for (const row of match!.outcomes) {
      expect(row.rank).toBeGreaterThanOrEqual(1); expect(row.rank).toBeLessThanOrEqual(4);
      expect(row.rank === 1).toBe(row.outcome !== 'loss');
    }
    expect(final.tables.seats).toHaveLength(16);
  }, 120000);
  it('shares the exact sanitized preview, hydrates local app shell, renders a real PNG and uniformly revokes routes', async () => {
    const created = await create();
    const preview = await json<ResultsSummary>(await request(`/api/arena/series/${created.id}/share/preview`, { commentary: false }));
    const share = await json<{ token: string }>(await request(`/api/arena/series/${created.id}/share`, { commentary: false }));
    const url = `/arena/share/${share.token}`;
    const publicResult = await json<ResultsSummary>(await request(`${url}/data`, undefined, ''));
    expect(publicResult).toEqual(preview);
    const page = await request(url, undefined, ''); const html = await page.text();
    expect(html).toContain('property="og:title"'); expect(html).toContain('summary_large_image');
    expect(html).toContain('src="/src/main.ts"'); expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(html).toContain('Right $&amp; bot');
    expect(page.headers.get('cache-control')).toBe('private, no-store'); expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    for (const tag of ['og:title', 'og:description', 'og:image', 'twitter:title', 'twitter:image', 'robots']) {
      expect(html.match(new RegExp(`(?:name|property)="${tag}"`, 'g')), tag).toHaveLength(1);
    }
    expect(html).toContain(`content="${url}/image.png"`);
    expect(html).toContain('content="image/png"');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('application/ld+json');
    expect(html).not.toContain('3D browser RTS with AI commanders');
    expect(html).not.toContain('/social/');
    const image = await request(`${url}/image.png`, undefined, '');
    expect(image.status).toBe(200); expect(await sharp(Buffer.from(await image.arrayBuffer())).metadata()).toMatchObject({ width: 1200, height: 630, format: 'png' });
    const events = await fetch(`${base}${url}/events`, { signal: AbortSignal.timeout(4000), headers: { 'x-forwarded-for': freshIp() } });
    const reader = events.body!.getReader(); expect((await reader.read()).done).toBe(false);
    expect((await request(`/api/arena/series/${created.id}/share/revoke`, {})).status).toBe(204);
    await until(async () => (await reader.read()).done, 3000);
    for (const suffix of ['', '/data', '/events', '/export.json', '/export.csv', '/image.png', '/artifacts/missing']) expect((await request(`${url}${suffix}`, undefined, '')).status).toBe(404);
    expect((await request(`/api/arena/series/${created.id}/abort`, {})).status).toBe(204);
  });
  it('withholds public active matches, bootstrap, outcome, exports and replay during the same 180-second wall delay', async () => {
    const value = spec(180000); value.permutations = value.permutations.slice(0, 1); value.execution.maxTicks = 20;
    const created = await create(value);
    const share = await json<{ token: string }>(await request(`/api/arena/series/${created.id}/share`, { commentary: false }));
    await request(`/api/arena/series/${created.id}/start`, {});
    const owner = await until(async () => { const r = await json<ResultsSummary>(await request(`/api/arena/series/${created.id}`)); return r.tables.matches.length ? r : undefined; });
    const basePath = `/arena/share/${share.token}`;
    const response = await request(`${basePath}/data`, undefined, ''); const shared = await json<ResultsSummary>(response);
    expect(shared.tables.matches).toEqual([]); expect(shared.activeMatches).toEqual([]); expect(shared.completedAt).toBeNull(); expect(shared.state).not.toBe('completed');
    expect(response.headers.get('x-arena-delay-ms')).toBe('180000'); expect(response.headers.get('x-arena-playback')).toBe('buffering');
    const exported = await json<ResultsEnvelope>(await request(`${basePath}/export.json`, undefined, '')); expect(exported.tables.matches).toEqual([]);
    expect((await request(`${basePath}/artifacts/${owner.tables.artifacts[0]!.id}`, undefined, '')).status).toBe(404);
    expect((await request(`${basePath}/matches/${owner.tables.matches[0]!.matchId}/observer`, undefined, '')).status).toBe(404);
  });
});
