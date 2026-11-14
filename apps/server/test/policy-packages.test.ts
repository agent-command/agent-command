import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { policyPackageHash, validatePolicyPackage, type PolicyPackage } from 'playerthree';
import type { GameServer } from '../src/app.ts';
import type { BotPackageInfo } from '../src/policy-packages.ts';
import type { RosterResponse } from '../src/roster.ts';
import { start, freshIp, json } from './helpers.ts';

let server: GameServer;
let base: string;
beforeAll(async () => { ({ server, base } = await start()); });
afterAll(async () => { await server.close(); });
async function api(path: string, method: string, body?: unknown, secret?: string) {
  return fetch(`${base}${path}`, { method, headers: { 'x-forwarded-for': freshIp(), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function profile() { return json<{ id: string; secret: string }>(await api('/api/profile', 'POST', {})); }
/** A policy commander on `roles` with one no-op Surface version deployed (v1). */
async function commanderWithVersion(secret: string, name: string, roles = ['surface']) {
  const roster = await json<RosterResponse>(await api('/api/profile/commanders', 'POST', { name, kind: 'policy', roles }, secret));
  const commander = roster.commanders.find((entry) => entry.name === name)!;
  const result = await server.host.agentSession(commander.token, 'surface')!.control.policyDeploy({ runtime: 'js', code: 'function think() { return []; }' });
  expect(result).toMatchObject({ ok: true, version: 1 });
  return commander.id;
}
/** A package with members replaced and its hash recomputed: genuine as far as the envelope goes. */
function rehashed(pkg: PolicyPackage, patch: Partial<PolicyPackage>): PolicyPackage {
  const { hash: _hash, ...rest } = { ...pkg, ...patch };
  return { ...rest, hash: policyPackageHash(rest) };
}
const manifest = () => server.host.definition.manifest;

describe('policy package export', () => {
  it('downloads one library version as a canonical package named after commander, plane and version', async () => {
    const owner = await profile();
    const id = await commanderWithVersion(owner.secret, 'Deep Seek #1');
    const res = await api(`/api/profile/commanders/${id}/versions/1/package`, 'GET', undefined, owner.secret);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="deep-seek-1-surface-v1.policy.json"');
    const pkg = validatePolicyPackage(JSON.parse(await res.text()), manifest().control.policy!, manifest());
    expect(pkg).toMatchObject({ format: 'playerthree.policy/1', roles: ['surface'], lineage: { parent: null, version: 1 } });
  });
  it('is owner-only: another profile, no profile and unknown versions get nothing', async () => {
    const owner = await profile(); const other = await profile();
    const id = await commanderWithVersion(owner.secret, 'Private');
    expect((await api(`/api/profile/commanders/${id}/versions/1/package`, 'GET', undefined, other.secret)).status).toBe(404);
    expect((await api(`/api/profile/commanders/${id}/versions/1/package`, 'GET')).status).toBe(401);
    expect((await api(`/api/profile/commanders/${id}/versions/2/package`, 'GET', undefined, owner.secret)).status).toBe(404);
    expect((await api(`/api/profile/commanders/${id}/versions/1/package`, 'POST', {}, owner.secret)).status).toBe(405);
  });
});

describe('policy package import', () => {
  async function exported(secret: string, id: string): Promise<PolicyPackage> {
    return JSON.parse(await (await api(`/api/profile/commanders/${id}/versions/1/package`, 'GET', undefined, secret)).text()) as PolicyPackage;
  }
  const importInto = (secret: string, id: string, role: string, pkg: unknown) => api(`/api/profile/commanders/${id}/import`, 'POST', { role, package: pkg }, secret);

  it('re-imports an exported version as a new inactive version', async () => {
    const owner = await profile();
    const id = await commanderWithVersion(owner.secret, 'Round trip');
    const res = await importInto(owner.secret, id, 'surface', await exported(owner.secret, id));
    expect(res.status).toBe(200);
    const body = await json<{ result: { version: number; stale: boolean }; roster: RosterResponse }>(res);
    expect(body.result).toEqual({ version: 2, stale: false });
    const commander = body.roster.commanders.find((entry) => entry.id === id)!;
    expect(commander.policy.activeByRole.surface).toBe(1);
    expect(commander.policy.versions.find((v) => v.version === 2)?.surfaceHash).toBe(body.roster.surfaceHash);
  });
  it('exports and re-imports a starter deployed by reference, keeping its from and knobs', async () => {
    const owner = await profile();
    const roster = await json<RosterResponse>(await api('/api/profile/commanders', 'POST', { name: 'Starter', kind: 'policy', roles: ['surface'] }, owner.secret));
    const commander = roster.commanders.find((entry) => entry.name === 'Starter')!;
    const from = 'agent-command-strategy/policies/surface.js';
    const deployed = await server.host.agentSession(commander.token, 'surface')!.control.policyDeploy({ from, knobs: { attackAt: 12 } });
    expect(deployed).toMatchObject({ ok: true, version: 1 });
    const pkg = await exported(owner.secret, commander.id);
    expect(pkg.source).toEqual({ from, knobs: { attackAt: 12 } });
    const res = await importInto(owner.secret, commander.id, 'surface', pkg);
    expect(res.status).toBe(200);
    expect((await json<{ result: { version: number; stale: boolean } }>(res)).result).toEqual({ version: 2, stale: false });
    // Other knobs build another script than the one shipped: refused.
    expect((await importInto(owner.secret, commander.id, 'surface', rehashed(pkg, { source: { from, knobs: { attackAt: 13 } } }))).status).toBe(400);
  });
  it('stores a package from another game surface as stale', async () => {
    const owner = await profile();
    const id = await commanderWithVersion(owner.secret, 'Stale');
    const res = await importInto(owner.secret, id, 'surface', rehashed(await exported(owner.secret, id), { surfaceHash: 'f'.repeat(64) }));
    expect(res.status).toBe(200);
    const body = await json<{ result: { version: number; stale: boolean }; roster: RosterResponse }>(res);
    expect(body.result).toEqual({ version: 2, stale: true });
    expect(body.roster.commanders[0]!.policy.versions.find((v) => v.version === 2)?.surfaceHash).not.toBe(body.roster.surfaceHash);
  });
  it('names each refusal: not a package, wrong game, tampered, wrong plane, source that does not rebuild', async () => {
    const owner = await profile();
    const id = await commanderWithVersion(owner.secret, 'Refusals', ['surface', 'sky']);
    const pkg = await exported(owner.secret, id);
    const refusal = async (role: string, body: unknown) => {
      const res = await importInto(owner.secret, id, role, body);
      expect(res.status).toBe(400);
      return (await json<{ error: string }>(res)).error;
    };
    expect(await refusal('surface', { hello: 'world' })).toBe('not_a_package');
    expect(await refusal('surface', [pkg])).toBe('not_a_package');
    expect(await refusal('surface', rehashed(pkg, { game: { id: 'another-game', version: '1' } }))).toBe('wrong_game');
    expect(await refusal('surface', { ...pkg, script: `${pkg.script}\n// edited` })).toBe('tampered');
    expect(await refusal('surface', rehashed(pkg, { script: `${pkg.script}\n// edited` }))).toBe('tampered');
    expect(await refusal('surface', { ...pkg, surfaceHash: 'f'.repeat(64) })).toBe('tampered');
    expect(await refusal('sky', pkg)).toBe('wrong_plane');
    expect(await refusal('surface', rehashed(pkg, { license: 'not a licence' }))).toBe('not_a_package');
    // The source no longer builds to the shipped script on this surface.
    expect(await refusal('surface', rehashed(pkg, { source: { code: 'function think() { return [1]; }' } }))).toBe('rebuild_failed');
    expect((await importInto(owner.secret, id, 'orbit', pkg)).status).toBe(400);
    expect((await json<RosterResponse>(await api('/api/profile', 'GET', undefined, owner.secret))).commanders[0]!.policy.versions.map((v) => v.version)).toEqual([1]);
  });
  it('is owner-only', async () => {
    const owner = await profile(); const other = await profile();
    const id = await commanderWithVersion(owner.secret, 'Mine');
    const pkg = await exported(owner.secret, id);
    expect((await importInto(other.secret, id, 'surface', pkg)).status).toBe(404);
    expect((await api(`/api/profile/commanders/${id}/import`, 'POST', { role: 'surface', package: pkg })).status).toBe(401);
  });
});

describe('built-in bot packages', () => {
  it('lists exactly the game definition’s registered packages and serves each as source and package', async () => {
    const res = await api('/api/bots', 'GET');
    expect(res.status).toBe(200);
    const { bots } = await json<{ bots: BotPackageInfo[] }>(res);
    const registered = bots.map(({ level, role }) => [level, role, server.host.definition.botPackages?.(level, role)?.hash]);
    expect(bots.map((bot) => [bot.level, bot.role, bot.hash])).toEqual(registered);
    for (const bot of bots) {
      const pkg = await api(`/api/bots/${bot.level}/${bot.role}/package`, 'GET');
      expect(pkg.headers.get('content-disposition')).toBe(`attachment; filename="agent-command-${bot.level}-${bot.role}.policy.json"`);
      const text = await pkg.text();
      expect(Buffer.byteLength(text)).toBe(bot.bytes);
      expect(validatePolicyPackage(JSON.parse(text), manifest().control.policy!, manifest())?.hash).toBe(bot.hash);
      const source = await api(`/api/bots/${bot.level}/${bot.role}/source`, 'GET');
      expect(source.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect((await source.text()).length).toBeGreaterThan(0);
    }
  });
  it('404s anything unregistered and refuses writes', async () => {
    expect((await api('/api/bots/godlike/surface/package', 'GET')).status).toBe(404);
    expect((await api('/api/bots/standard/moon/source', 'GET')).status).toBe(404);
    expect((await api('/api/bots/standard/surface/other', 'GET')).status).toBe(404);
    expect((await api('/api/bots', 'POST', {})).status).toBe(405);
  });
});
