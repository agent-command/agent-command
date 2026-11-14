import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Accounts, clusters, networkPrefix } from '../src/accounts.ts';
import { closeDatabase, headers, linkedProfile, newProfile, startRanked, type RankedServer } from './ranked-fixture.ts';
import { json } from './helpers.ts';

let r: RankedServer | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
afterAll(() => closeDatabase());

describe('account clusters', () => {
  it('reduces addresses to their shared network (IPv4 /24, IPv6 /56)', () => {
    expect(networkPrefix('10.1.2.3')).toBe('v4:10.1.2');
    expect(networkPrefix('::ffff:10.1.2.200')).toBe('v4:10.1.2');
    expect(networkPrefix('2001:db8:aa:bbcc::1')).toBe('v6:2001:0db8:00aa:bb');
    expect(networkPrefix('2001:db8:aa:bbff:1::')).toBe('v6:2001:0db8:00aa:bb');
    expect(networkPrefix('not an ip')).toBeUndefined();
  });

  it('merges accounts transitively over any shared signal (union-find)', () => {
    const map = clusters([
      { profileId: 'c', key: 'ip:1' }, { profileId: 'a', key: 'ip:1' },
      { profileId: 'a', key: 'device:x' }, { profileId: 'd', key: 'device:x' },
      { profileId: 'e', key: 'artifact:z' }, { profileId: 'b', key: 'harness:h' },
    ]);
    expect(map.get('c')).toBe('a');
    expect(map.get('d')).toBe('a');
    expect(map.get('e')).toBe('e');
    expect(map.get('b')).toBe('b');
  });
});

describe('GitHub sign-in', () => {
  it('links through state, cookie and PKCE; gates rated play on account age; DTOs carry no subject, IP or cluster', { timeout: 60_000 }, async () => {
    r = await startRanked();
    const old = await linkedProfile(r, 1001, '10.9.9.1');
    const view = await json<Record<string, unknown>>(await fetch(`${r.base}/api/account`, { headers: headers(old.secret) }));
    expect(view).toEqual({ linked: true, login: 'user1001', eligible: true, eligibleAt: null, provider: 'github' });
    const text = JSON.stringify(view);
    // The provider subject (GitHub user id 1001), addresses, cluster ids and the profile id never leave the server.
    for (const secret of [':1001', '"1001"', 'subject', '10.9.9', 'v4:', 'cluster', old.id]) expect(text).not.toContain(secret);

    // A GitHub account younger than 30 days links, but rated play waits.
    const young = await linkedProfile(r, 1002, '10.9.8.1', new Date(Date.now() - 5 * 86_400_000).toISOString());
    const pending = await json<{ eligible: boolean; eligibleAt: number }>(await fetch(`${r.base}/api/account`, { headers: headers(young.secret) }));
    expect(pending.eligible).toBe(false);
    expect(pending.eligibleAt).toBeGreaterThan(Date.now() + 20 * 86_400_000);

    // One GitHub account belongs to one profile.
    await expect(linkedProfile(r, 1001)).rejects.toThrow(/409/);
    const unlinked = await newProfile(r.base);
    expect(await json(await fetch(`${r.base}/api/account`, { headers: headers(unlinked.secret) }))).toMatchObject({ linked: false, eligible: false });
  });

  it('refuses a callback without the matching state cookie, a replayed state or a cross-origin start', { timeout: 60_000 }, async () => {
    r = await startRanked();
    const profile = await newProfile(r.base);
    expect((await fetch(`${r.base}/api/auth/github/start`, { method: 'POST', headers: { ...headers(profile.secret), origin: 'https://evil.test' }, body: '{}' })).status).toBe(403);
    const start = await fetch(`${r.base}/api/auth/github/start`, { method: 'POST', headers: headers(profile.secret), body: '{}' });
    const state = new URL((await json<{ url: string }>(start)).url).searchParams.get('state')!;
    r.github.users.set('codeX', { id: 77, login: 'x', created_at: '2000-01-01T00:00:00Z' });
    // No cookie: the state alone cannot complete a sign-in (login CSRF).
    expect((await fetch(`${r.base}/api/auth/github/callback?code=codeX&state=${state}`, { redirect: 'manual' })).status).toBe(400);
    // The state was used up by that attempt.
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(`${r.base}/api/auth/github/callback?code=codeX&state=${state}`, { headers: { cookie }, redirect: 'manual' })).status).toBe(400);
  });

  it('clusters accounts seen on one network, a shared device or a shared artifact', { timeout: 60_000 }, async () => {
    r = await startRanked();
    const accounts = new Accounts(r.storage, 30 * 86_400_000);
    const a = await linkedProfile(r, 2001, '10.20.30.1');
    const b = await linkedProfile(r, 2002, '10.20.30.99');
    const c = await linkedProfile(r, 2003, '10.21.0.1');
    expect(await accounts.clusterOf(a.id)).toBe(await accounts.clusterOf(b.id));
    expect(await accounts.clusterOf(c.id)).not.toBe(await accounts.clusterOf(a.id));
    await accounts.note(c.id, 'artifact', 'f'.repeat(64));
    await accounts.note(b.id, 'artifact', 'f'.repeat(64));
    expect(await accounts.clusterOf(c.id)).toBe(await accounts.clusterOf(a.id));
    // Network evidence older than 30 days no longer links; everything is pruned after 90.
    const later = Date.now() + 31 * 86_400_000;
    expect((await accounts.clusters(later)).get(a.id)).not.toBe((await accounts.clusters(later)).get(b.id));
    await accounts.prune(Date.now() + 91 * 86_400_000);
    expect((await r.storage.query('SELECT 1 FROM ac_account_links'))).toHaveLength(0);
  });
});
