// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { ResultsSummary } from 'playerthree/arena';
const network = vi.hoisted(() => ({ request: vi.fn(), stream: vi.fn(), download: vi.fn(async () => {}), artifact: vi.fn() }));
vi.mock('../src/arena-net.ts', () => ({ arenaRequest: network.request, streamArena: network.stream, downloadArena: network.download, downloadArenaArtifact: network.artifact }));
import { mountArenaResults } from '../src/arena.ts';

function results(): ResultsSummary {
  return {
    format: 'playerthree.results.summary', version: 1, seriesId: 'series', revision: 2, state: 'running', createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:01:00Z', completedAt: null, comparisonHash: 'comparison',
    activeMatches: [],
    spec: { format: 'playerthree.series', version: 1, game: 'command', gameVersion: 'build', surfaceHash: 'surface', track: 'bots', entrants: [{ id: 'a', label: 'Alpha', kind: 'bot', aiPlayer: true }], template: { format: 'playerthree.match', version: 1, game: 'command', gameVersion: 'build', surfaceHash: 'surface', rulesHash: 'resolved-sha256', seed: 1, map: { id: 'map', identity: 'map-v1', seed: 1, layout: 'duel' }, options: { rules: { match: { maxTicks: 1000 } } }, sides: [], bindings: [], observerPolicy: { allowOmniscient: true, minDelayMs: 180000 }, rules: { ranked: false, coaching: 'off', practiceReasons: ['custom rules'] } }, scenarios: [], permutations: [], repetitions: 1, execution: { concurrency: 1, speed: 1, clock: 'realtime', maxTicks: 1000, maxWallMs: 1000, maxInfraRetries: 1, state: 'reset_each_match' }, budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null }, rating: { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: .1 }, telemetry: { sampleEveryTicks: 20, includeCommentary: false } },
    tables: { entrants: [{ entrantId: 'a', label: 'Alpha', kind: 'bot', aiPlayer: true, provider: null, model: null, selfReported: false, harness: null, harnessVerified: false, scaffoldVersion: null, artifactHash: null, botVersion: null, botLevel: null, botOptions: null, stateResetSource: null }], schedule: [], matches: [], seats: [], metrics: [], causes: [], intents: [], decisions: [], usage: [], events: [], artifacts: [], standings: [{ entrantId: 'a', wins: 1, losses: 0, draws: 1, games: 2, winRate: .5, scoreRate: .75, rating: null, mu: 26, sigma: 7, conservativeRating: 5, provisional: true, averageSimulatedMs: 120000, averageWallMs: 130000, ratingImplementation: 'ts-trueskill/5.1.0', ratingParameters: { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: .1, conservativeMultiplier: 3, minDelta: null }, confidence: { method: 'seed_block_bootstrap', version: 1, seed: 1, replicates: 1000, blocks: 1, level: .95, winRate: [0, 1], scoreRate: [0, 1], independent: true } }] },
    summaries: { latency: [], usage: [] }, accounting: { provenance: 'shared_projection', recordedBytes: 0, chunks: [], tables: { entrants: { rows: 1, bytes: 0 }, schedule: { rows: 0, bytes: 0 }, matches: { rows: 0, bytes: 0 }, seats: { rows: 0, bytes: 0 }, metrics: { rows: 0, bytes: 0 }, causes: { rows: 0, bytes: 0 }, intents: { rows: 0, bytes: 0 }, decisions: { rows: 0, bytes: 0 }, usage: { rows: 0, bytes: 0 }, events: { rows: 0, bytes: 0 }, artifacts: { rows: 0, bytes: 0 }, standings: { rows: 1, bytes: 0 } } },
    completeness: { scheduleComplete: false, rawComplete: true, missing: [] }, retention: { expiresAt: '2000-02-01T00:00:00Z', bytes: 0, maxBytes: 100000 }, disclosure: { audience: 'shared', commentary: false },
    sampling: { limit: 2000, tables: { entrants: { rows: 1, included: 1, method: 'complete' }, schedule: { rows: 0, included: 0, method: 'complete' }, matches: { rows: 0, included: 0, method: 'complete' }, standings: { rows: 0, included: 0, method: 'complete' }, seats: { rows: 0, included: 0, method: 'complete' }, metrics: { rows: 0, included: 0, method: 'complete' }, causes: { rows: 0, included: 0, method: 'complete' }, intents: { rows: 0, included: 0, method: 'complete' }, decisions: { rows: 0, included: 0, method: 'complete' }, usage: { rows: 0, included: 0, method: 'complete' }, events: { rows: 0, included: 0, method: 'complete' }, artifacts: { rows: 0, included: 0, method: 'complete' } } },
  };
}

function prepare(result: ResultsSummary) {
  network.request.mockImplementation(async (_access, _suffix, _body, _signal, delivery) => { delivery?.({ delayMs: 180000, playback: 'buffering' }); return result; });
  network.stream.mockImplementation(async (_access, _revision, signal: AbortSignal) => {
    const gate = Promise.withResolvers<void>(); signal.addEventListener('abort', () => gate.resolve(), { once: true }); await gate.promise;
  });
}

afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

it('renders real standings/uncertainty and a delayed public read-only projection without sharing controls', async () => {
  prepare(results()); const root = document.createElement('div'); document.body.append(root);
  const panel = mountArenaResults(root, { access: { kind: 'share', token: 'share' }, onExit: vi.fn() });
  await vi.waitFor(() => expect(root.textContent).toContain('TrueSkill μ / σ / conservative'));
  expect(root.textContent).toContain('Alpha'); expect(root.textContent).toContain('26.00 / 7.00 / 5.00');
  expect(root.textContent).toContain('50.0%'); expect(root.textContent).toContain('75.0%'); expect(root.textContent).toContain('Provisional');
  expect(root.textContent).toContain('Delayed 180 s · Buffering');
  expect(root.textContent).toContain('resolved-sha256'); expect(root.textContent).toContain('Custom / unranked');
  expect(root.textContent).toContain('Cost: Not reported'); expect(root.textContent).toContain('Replay unavailable');
  expect(root.querySelector('[aria-label="Share / preview"]')).toBeNull();
  expect(root.querySelector('[aria-label="Revoke all share links"]')).toBeNull();
  expect(root.querySelector('[title]')).toBeNull();
  root.querySelector<HTMLButtonElement>('[aria-label="Download JSON"]')!.click();
  expect(network.download).toHaveBeenCalledWith({ kind: 'share', token: 'share' }, 'json', 2);
  panel.dispose();
});

it('updates the same result screen on every committed revision', async () => {
  prepare(results()); const root = document.createElement('div');
  const panel = mountArenaResults(root, { access: { kind: 'owner', seriesId: 'series', credential: () => 'secret' }, onExit: vi.fn() });
  await vi.waitFor(() => expect(network.stream).toHaveBeenCalled());
  const receive = network.stream.mock.calls[0]![3] as (result: ResultsSummary) => void;
  const next = results(); next.revision = 3; next.tables.standings = [{ ...next.tables.standings[0]!, wins: 2, games: 3 }]; receive(next);
  expect(root.querySelector('[role=status]')!.textContent).toContain('revision 3');
  expect(root.querySelector('[aria-label="Share / preview"]')).not.toBeNull();
  receive({ ...next, revision: 1 }); expect(root.querySelector('[role=status]')!.textContent).toContain('revision 3');
  panel.dispose();
});

it('keeps latency sources and usage coverage separate using canonical server summaries', async () => {
  const result = results();
  result.summaries.latency = [
    { entrantId: 'a', source: 'provider', samples: 4, p50Ms: 300, p95Ms: 900, method: 'nearest_rank/1' },
    { entrantId: 'a', source: 'host_gap', samples: 2, p50Ms: 1000, p95Ms: 2000, method: 'nearest_rank/1' },
  ];
  result.summaries.usage = [
    { entrantId: 'a', phase: 'authoring', reporter: 'reported', currency: 'USD', samples: 1, coverage: 'partial', inputTokens: 100, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costAmount: '0.00123456789' },
    { entrantId: 'a', phase: 'inference', reporter: null, currency: null, samples: 0, coverage: 'unknown', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costAmount: null },
  ];
  prepare(result); const root = document.createElement('div');
  const panel = mountArenaResults(root, { access: { kind: 'share', token: 'share' }, onExit: vi.fn() });
  await vi.waitFor(() => expect(root.textContent).toContain('provider decision latency: 300.0 ms p50 / 900.0 ms p95'));
  expect(root.textContent).toContain('Host inter-call gap (not think time): 1,000.0 ms p50 / 2,000.0 ms p95');
  expect(root.textContent).toContain('authoring / reported'); expect(root.textContent).toContain('1 / partial');
  expect(root.textContent).toContain('100 / Not reported'); expect(root.textContent).toContain('0.00123456789 USD');
  expect(root.textContent).toContain('inference / Not reported'); expect(root.textContent).toContain('0 / unknown');
  expect(root.textContent).not.toContain('inference / null');
  expect(root.textContent).toContain('Partial reporting is not a full bill');
  panel.dispose();
});

it('labels sampled live tables honestly and points to the full raw download', async () => {
  const base = results();
  const result: ResultsSummary = { ...base, sampling: { ...base.sampling, tables: { ...base.sampling.tables,
    metrics: { rows: 90000, included: 2000, method: 'stride_per_series' }, events: { rows: 4100, included: 2000, method: 'sorted_prefix' } } } };
  prepare(result); const root = document.createElement('div');
  const panel = mountArenaResults(root, { access: { kind: 'share', token: 'share' }, onExit: vi.fn() });
  await vi.waitFor(() => expect(root.querySelector('[role=note].arena-sampling')).not.toBeNull());
  const note = root.querySelector('[role=note].arena-sampling')!.textContent!;
  expect(note).toContain('metrics 2,000 of 90,000 evenly spaced per series');
  expect(note).toContain('events 2,000 of 4,100 in canonical order');
  expect(note).toContain('Download JSON or CSV for every recorded row');
  panel.dispose();
});

it('changes only owner-authorized commentary categories and keeps sharing a second opt-in', async () => {
  const result = results(); result.disclosure.audience = 'owner'; prepare(result);
  network.request.mockImplementation(async (_access, suffix, body) => {
    if (suffix === '/commentary/consent') return body === undefined ? { consents: [{ entrantId: 'a', summaries: false, chat: false }] } : undefined;
    return result;
  });
  const root = document.createElement('div'); document.body.append(root);
  const access = { kind: 'owner' as const, seriesId: 'series', credential: () => 'secret' };
  const panel = mountArenaResults(root, { access, onExit: vi.fn() });
  await vi.waitFor(() => expect(root.querySelector('[aria-label="Agent disclosure"]')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('[aria-label="Agent disclosure"]')!.click();
  await vi.waitFor(() => expect(root.querySelectorAll('dialog input[type=checkbox]')).toHaveLength(2));
  const categories = root.querySelectorAll<HTMLInputElement>('dialog input[type=checkbox]');
  expect(categories[0]!.checked).toBe(false); expect(categories[1]!.checked).toBe(false);
  categories[0]!.checked = true;
  root.querySelector<HTMLButtonElement>('[aria-label="Save disclosure · Alpha"]')!.click();
  await vi.waitFor(() => expect(network.request).toHaveBeenCalledWith(access, '/commentary/consent', { entrantId: 'a', summaries: true, chat: false }, expect.any(AbortSignal)));
  expect(root.textContent).toContain('Previously downloaded or cached copies cannot be recalled');
  expect(network.request.mock.calls.some((call) => call[1] === '/share')).toBe(false);
  panel.dispose();
});

it('opens Watch only for an actual revisioned active match after server observer admission', async () => {
  const result = results();
  result.activeMatches = [{ matchId: 'real-host-match', attemptId: 'attempt-1', trialId: 'trial-1', attemptNumber: 1, startedAt: result.createdAt, releaseAt: 0, spec: result.spec.template }];
  prepare(result);
  const grant = { kind: 'omniscient' as const, teams: ['nw', 'se'], delayMs: 180000 };
  network.request.mockImplementation(async (_access, suffix) => suffix === '/matches/real-host-match/observer' ? { grant } : result);
  const root = document.createElement('div'); const observe = vi.fn();
  const access = { kind: 'owner' as const, seriesId: 'series', credential: () => 'secret' };
  const panel = mountArenaResults(root, { access, onExit: vi.fn(), onObserve: observe });
  await vi.waitFor(() => expect(root.querySelector('.arena-active-matches button')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('.arena-active-matches button')!.click();
  await vi.waitFor(() => expect(observe).toHaveBeenCalledWith({ access, matchId: 'real-host-match', grant, label: 'map · seed 1 · attempt 1' }));
  expect(network.request).toHaveBeenCalledWith(access, '/matches/real-host-match/observer', undefined, expect.any(AbortSignal));
  expect(root.textContent).toContain('real-host-match');
  panel.dispose();
});
