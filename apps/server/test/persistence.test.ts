import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RosterResponse } from '../src/roster.ts';
import { freshIp, json, namedCommander, start } from './helpers.ts';

async function newProfile(base: string): Promise<{ id: string; secret: string }> {
  const res = await fetch(`${base}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: '{}' });
  expect(res.status).toBe(200);
  return json(res);
}

async function rosterOf(secret: string, base: string): Promise<RosterResponse> {
  const res = await fetch(`${base}/api/profile`, { headers: { authorization: `Bearer ${secret}`, 'x-forwarded-for': freshIp() } });
  expect(res.status).toBe(200);
  return json<RosterResponse>(res);
}

describe('persistence', () => {
  it('profiles, rosters and tokens survive a restart with DATA_DIR', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ac-data-'));
    let s = await start({ dataDir });
    const b1 = s.base;
    const { secret } = await newProfile(b1);
    const commander = await namedCommander(b1, secret, 'Persistent strategist', ['depths', 'orbit']);
    const patched = await fetch(`${b1}/api/profile/commanders/${commander.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ name: 'Persistent commander' }),
    });
    expect(patched.status).toBe(200);
    const before = await rosterOf(secret, b1);
    await s.server.close();

    s = await start({ dataDir });
    const b2 = s.base;
    const after = await rosterOf(secret, b2);
    expect(after.commanders).toEqual(before.commanders);
    expect(after.commanders).toHaveLength(1);
    expect(after.commanders[0]).toMatchObject({ id: commander.id, name: 'Persistent commander', roles: ['depths', 'orbit'], token: commander.token });
    const stranger = await newProfile(b2);
    const privateResponse = await fetch(`${b2}/api/profile/commanders/${commander.id}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${stranger.secret}`, 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ name: 'Stolen' }),
    });
    expect(privateResponse.status).toBe(404);
    expect((await rosterOf(secret, b2)).commanders[0]?.name).toBe('Persistent commander');
    await s.server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
