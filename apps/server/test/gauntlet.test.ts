import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { json } from './helpers.ts';
import { agentCommander, closeDatabase, headers, linkedProfile, policyCommander, startRanked, type RankedServer } from './ranked-fixture.ts';

let r: RankedServer | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
afterAll(() => closeDatabase());

const gauntlet = (base: string, secret: string, commanderId: string) =>
  fetch(`${base}/api/ladder/gauntlet`, { method: 'POST', headers: headers(secret), body: JSON.stringify({ commanderId }) });

describe('policy-only gauntlet', () => {
  it('refuses live agents, runs a frozen policy version through the series service once per day, never rating it', { timeout: 90_000 }, async () => {
    r = await startRanked();
    const owner = await linkedProfile(r, 8001);
    const live = await agentCommander(r, owner.secret, 'Live');
    expect(await json(await gauntlet(r.base, owner.secret, live))).toEqual({ error: 'policy_only' });
    const policy = await policyCommander(r, owner.secret, 'Frozen');
    const started = await gauntlet(r.base, owner.secret, policy);
    expect(started.status).toBe(201);
    const { runId } = await json<{ runId: string }>(started);
    const [run] = await r.storage.query<{ series_id: string; artifact: string; result: { levels: { level: string }[] } }>('SELECT series_id, artifact, result FROM ac_gauntlet_runs WHERE id = $1', [runId]);
    expect(run!.result.levels.map((l) => l.level)).toEqual(['novice']);
    expect(run!.artifact).toMatch(/^[0-9a-f]{64}$/);
    // The series exists under the gauntlet track and its matches log `queue: gauntlet`.
    const series = await json<{ spec: { track: string; scenarios: unknown[]; permutations: unknown[] } }>(await fetch(`${r.base}/api/arena/series/${run!.series_id}`, { headers: headers(owner.secret) }));
    expect(series.spec).toMatchObject({ track: 'gauntlet' });
    expect(series.spec.scenarios.length * series.spec.permutations.length).toBe(6);
    // One run per segment and policy version per 24 h.
    expect(await json(await gauntlet(r.base, owner.secret, policy))).toEqual({ error: 'gauntlet_limit' });
    expect(await r.storage.query('SELECT 1 FROM ac_ratings')).toHaveLength(0);
  });
});
