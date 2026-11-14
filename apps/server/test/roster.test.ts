import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameServer } from '../src/app.ts';
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

describe('private named commander roster', () => {
  it('starts empty and supports multiple named commanders compatible with the same plane', async () => {
    const owner = await profile();
    expect((await json<RosterResponse>(await api('/api/profile', 'GET', undefined, owner.secret))).commanders).toEqual([]);
    for (const name of ['DeepSeek', 'Claude']) expect((await api('/api/profile/commanders', 'POST', { name, kind: 'agent', roles: ['surface'], isolation: { independentSessions: true } }, owner.secret)).status).toBe(201);
    const roster = await json<RosterResponse>(await api('/api/profile', 'GET', undefined, owner.secret));
    expect(roster.commanders.map((entry) => entry.name)).toEqual(['DeepSeek', 'Claude']);
    expect(new Set(roster.commanders.map((entry) => entry.id)).size).toBe(2);
    expect(roster.commanders.every((entry) => entry.roles.includes('surface') && entry.seated === null && entry.token.length > 0)).toBe(true);
    expect(roster.commanders.some((entry) => 'role' in entry || 'preference' in entry)).toBe(false);
  });
  it('names, compatible roles, declared isolation and self-reported metadata round trip by ID', async () => {
    const owner = await profile();
    const created = await json<RosterResponse>(await api('/api/profile/commanders', 'POST', { name: 'Model', kind: 'agent', roles: ['surface'] }, owner.secret));
    const id = created.commanders[0]!.id;
    const response = await api(`/api/profile/commanders/${id}`, 'PATCH', { name: 'Named model', roles: ['surface', 'sky'], isolation: { independentSessions: true }, metadata: { provider: 'Owner report', model: 'Example', scaffoldVersion: '3' } }, owner.secret);
    expect(response.status).toBe(200);
    const commander = (await json<RosterResponse>(response)).commanders[0]!;
    expect(commander).toMatchObject({ id, name: 'Named model', roles: ['surface', 'sky'], isolation: { independentSessions: true }, metadata: { provider: 'Owner report', model: 'Example', scaffoldVersion: '3' } });
  });
  it('rotation revokes the old token without changing stable identity; deletion removes the connection', async () => {
    const owner = await profile();
    const first = (await json<RosterResponse>(await api('/api/profile/commanders', 'POST', { name: 'Stable', kind: 'policy', roles: ['depths'] }, owner.secret))).commanders[0]!;
    const next = (await json<RosterResponse>(await api(`/api/profile/commanders/${first.id}/rotate`, 'POST', {}, owner.secret))).commanders[0]!;
    expect(next.id).toBe(first.id); expect(next.token).not.toBe(first.token);
    expect((await api(`/api/profile/commanders/${first.id}`, 'DELETE', undefined, owner.secret)).status).toBe(200);
    expect((await json<RosterResponse>(await api('/api/profile', 'GET', undefined, owner.secret))).commanders).toEqual([]);
  });
  it('practice takes canonical map rules (no terrain shorthand) for a compatible role', async () => {
    const owner = await profile();
    const id = (await json<RosterResponse>(await api('/api/profile/commanders', 'POST', { name: 'Practice', kind: 'policy', roles: ['orbit'] }, owner.secret))).commanders[0]!.id;
    const practice = (body: unknown) => api(`/api/profile/commanders/${id}/practice`, 'POST', body, owner.secret);
    for (const bad of [
      { opponent: 'god', role: 'orbit' }, { opponent: 'novice' }, { opponent: 'novice', role: 'orbit', ticks: 0 },
      { opponent: 'novice', role: 'orbit', terrain: 'canyons' }, { opponent: 'novice', role: 'orbit', rules: { terrain: 'moon' } },
      { opponent: 'novice', role: 'orbit', rules: { map: { name: 'crown', seed: 1 } } }, { opponent: 'novice', role: 'surface' },
      // There is no public event seed: events derive from the match seed.
      { opponent: 'novice', role: 'orbit', rules: { eventSeed: 23 } },
    ]) expect((await practice(bad)).status).toBe(400);
    const valid = await practice({ opponent: 'novice', role: 'orbit', ticks: 100, rules: { terrain: 'canyons', map: { seed: 19, params: { size: 64 } } } });
    expect(valid.status).toBe(409);
    expect(await json(valid)).toEqual({ error: 'no_policy' });
  });
  it('cannot mutate another owner connection or use removed role-key schemas', async () => {
    const owner = await profile(); const other = await profile();
    const roster = await json<RosterResponse>(await api('/api/profile/commanders', 'POST', { name: 'Private', kind: 'agent', roles: ['surface'] }, owner.secret));
    expect((await api(`/api/profile/commanders/${roster.commanders[0]!.id}`, 'PATCH', { name: 'Stolen' }, other.secret)).status).toBe(404);
    expect((await api('/api/profile/commanders/surface', 'PATCH', { preference: 'agent' }, owner.secret)).status).toBe(404);
    expect((await api('/api/profile/tell', 'POST', { roles: ['surface'], text: 'Old shape' }, owner.secret)).status).toBe(400);
    expect((await api('/api/profile/tell', 'POST', { commanderIds: [roster.commanders[0]!.id], text: 'Own named connection' }, owner.secret)).status).toBe(200);
    expect((await api('/api/profile/tell', 'POST', { commanderIds: ['not-owned'], text: 'No' }, owner.secret)).status).toBe(400);
  });
  it('rejects unknown fields, incompatible roles and malformed isolation/metadata', async () => {
    const owner = await profile();
    for (const body of [{ name: 'X', kind: 'agent', roles: ['moon'] }, { name: 'X', kind: 'agent', roles: ['surface'], isolation: { independentSessions: 'yes' } }, { name: 'X', kind: 'agent', roles: ['surface'], metadata: { apiKey: 'forbidden' } }, { name: 'X', kind: 'agent', roles: ['surface'], preference: 'human' }]) expect((await api('/api/profile/commanders', 'POST', body, owner.secret)).status).toBe(400);
    expect((await api('/api/profile', 'GET')).status).toBe(401);
    expect((await api('/api/profile', 'GET', undefined, 'wrong')).status).toBe(401);
  });
});
