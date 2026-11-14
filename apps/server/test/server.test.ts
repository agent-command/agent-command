import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlayerThreeHost } from 'playerthree/host';
import { definition, DEFAULT_RULES } from '@agent-command/game';
import { resolveMapDocument } from '@agent-command/game/maps';
import type { GameServer } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { requestRules } from '../src/rules.ts';
import { HttpError } from '../src/http.ts';
import { start, freshIp, json, postLobby, lobbyHandoff } from './helpers.ts';
let server: GameServer;
let base: string;
// Colyseus room definitions are process-global, so this file runs exactly one game server (production-style surfaces).
beforeAll(async () => { ({ server, base } = await start({ matchesPerIp: 3, devtools: false })); });
afterAll(async () => { await server.close(); });
const preset = { mapId: 'open', layoutId: 'duel', visibility: 'private' as const, preset: 'play' as const, autoStart: true };

describe('public server admission', () => {
  it('has one match setup API and removes all old creation/start/queue routes', async () => {
    for (const path of ['/api/match', '/api/match/ready', '/api/match/start', '/api/queue/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(404);
    }
  });
  it('issues human capabilities, not team roots or writable omniscience, from quick play', async () => {
    const ticket = await lobbyHandoff(base, preset);
    const auth = server.host.authenticate(ticket.token)!;
    expect(auth.principal.kind).toBe('human');
    expect(auth.match.readiness().seats.filter((seat) => seat.kind === 'human')).toHaveLength(4);
    expect(ticket).not.toHaveProperty('invite');
    expect(ticket).not.toHaveProperty('spectator');
    for (const connection of ticket.connections) await connection.room.leave();
  });
  it('enforces method, origin, bounded strict JSON and supported layout constraints', async () => {
    expect((await fetch(`${base}/api/lobbies`, { method: 'PUT' })).status).toBe(405);
    expect((await postLobby(base, preset, { origin: 'https://untrusted.invalid' })).status).toBe(403);
    for (const body of [{ ...preset, extra: true }, { ...preset, layoutId: 'adjacent' }, { ...preset, mapId: 'missing' }, { ...preset, preset: 'legacy-mode' }, { ...preset, mapSeed: -1 }, { ...preset, rules: { economy: { invented: true } } }]) expect((await postLobby(base, body)).status).toBe(400);
    expect((await fetch(`${base}/api/lobbies`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: '{' })).status).toBe(400);
    expect((await fetch(`${base}/api/lobbies`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ ...preset, padding: 'x'.repeat(20_000) }) })).status).toBe(413);
  });
  it('rate limits anonymous setup by real client IP and never reveals a private lobby through directory', async () => {
    // The default 30 per 10 minutes (MATCHES_PER_IP / MATCH_RATE_WINDOW_S) governs the only creation path.
    expect(loadConfig({})).toMatchObject({ matchesPerIp: 30, matchRateWindowMs: 600_000 });
    const ip = freshIp();
    for (let index = 0; index < 3; index++) expect((await postLobby(base, preset, { 'x-forwarded-for': ip })).status).toBe(200);
    expect((await postLobby(base, preset, { 'x-forwarded-for': ip })).status).toBe(429);
    const created = await json<{ code: string }>(await postLobby(base, preset));
    const list = await (await fetch(`${base}/api/lobbies`, { headers: { 'x-forwarded-for': freshIp() } })).text();
    expect(list).not.toContain(created.code);
  });
  it('requires exact match credentials before Colyseus seat reservation', async () => {
    const ticket = await lobbyHandoff(base, preset);
    const response = await fetch(`${base}/matchmake/joinById/${ticket.roomId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ token: 'not-a-token' }) });
    expect(response.status).toBe(401);
    for (const connection of ticket.connections) await connection.room.leave();
  });
  it('validates host rule files and preserves nested host defaults in the canonical host', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ac-rules-'));
    try {
      const file = join(directory, 'rules.json');
      writeFileSync(file, JSON.stringify({ economy: { startAlloy: 777 }, spire: { timeCap: 900 } }));
      const rules = loadConfig({ RULES_FILE: file }).rules!;
      expect(rules).toEqual({ economy: { startAlloy: 777 }, spire: { timeCap: 900 } });
      expect(() => loadConfig({ RULES_JSON: '{', RULES_FILE: file })).toThrow('not both');
      expect(() => loadConfig({ RULES_JSON: '{' })).toThrow('not readable JSON');
      const host = createPlayerThreeHost({ definition, matchOptions: rules });
      try {
        const match = host.createMatch({ teams: ['nw', 'se'], realtime: false, options: { economy: { startEnergy: 10 } } });
        expect(match.view('nw').res).toMatchObject({ alloy: 777, energy: 10 });
      } finally { host.dispose(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('never exposes alternative room-create or operator APIs to public requests', async () => {
    expect((await fetch(`${base}/matchmake/create/agent_command`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/dev/status`)).status).toBe(404);
    expect((await fetch(`${base}/playerthree/devtools`)).status).toBe(404);
  });
});

describe('map selection', () => {
  it('reproduces public generated maps independently of the secret match seed and selects authored maps', () => {
    const host = createPlayerThreeHost({ definition });
    try {
      const options = requestRules({ terrain: 'rivers', map: { seed: 1234, params: { size: 64 } } });
      const first = host.createMatch({ teams: ['nw', 'se'], realtime: false, seed: 7, options }).view('nw').match!;
      const second = host.createMatch({ teams: ['nw', 'se'], realtime: false, seed: 2 ** 40 + 8, options }).view('nw').match!;
      expect(first).toMatchObject({ mapId: 'rivers', mapSeed: 1234, rules: { map: { size: 64 } } });
      expect(second).toEqual(first);
      expect(JSON.stringify(second)).not.toMatch(/eventSeed|1099511627784/);
      const named = host.createMatch({ teams: ['nw', 'se'], realtime: false, options: requestRules({ map: { name: 'crown' } }) });
      expect(named.view('nw').match).toMatchObject({ mapId: 'crown', mapSeed: 0, preset: 'fortress', rules: { map: { size: 48 } } });
    } finally { host.dispose(); }
  });
  it('resolves bounded Orbit placement controls into public numeric rules', () => {
    const template = { orbitWidth: 10, orbitLength: 16, orbitSpread: 0.6, orbitHomeWeight: 2, orbitFlankWeight: 3, orbitCentreWeight: 4 };
    const host = createPlayerThreeHost({ definition });
    try {
      const bootstrap = host.createMatch({ teams: ['nw', 'se'], realtime: false, options: requestRules({ map: { seed: 32, params: { template } } }) }).view('nw').match!;
      expect(bootstrap.rules.map.template).toMatchObject(template);
      expect(bootstrap.orbitRegions.length).toBeGreaterThan(0);
    } finally { host.dispose(); }
    for (const bad of [{ orbitWidth: 0 }, { orbitLength: 41 }, { orbitSpread: 1.1 }, { orbitHomeWeight: 0 }, { orbitFlankWeight: 101 }, { orbitCentreWeight: -1 }]) {
      expect(() => requestRules({ map: { params: { template: bad } } })).toThrow(HttpError);
    }
  });
  it('validates bounded inline documents and does not publish their hidden source', () => {
    const document = resolveMapDocument(17, 'ridges', DEFAULT_RULES.map, undefined);
    const host = createPlayerThreeHost({ definition });
    try {
      const match = host.createMatch({ teams: ['nw', 'se'], realtime: false, options: requestRules({ map: { document } }) });
      expect(match.options).toMatchObject({ map: { document } });
      const bootstrap = match.view('nw').match!;
      expect(bootstrap).toMatchObject({ mapSeed: 17, rules: { map: { size: 48 } } });
      expect(bootstrap.orbitRegions.length).toBeGreaterThan(0);
      expect(bootstrap.rules.map).not.toHaveProperty('document');
      expect(JSON.stringify(bootstrap)).not.toContain('intGridRle');
    } finally { host.dispose(); }
    for (const map of [
      { name: 'crown', seed: 1 }, { name: 'missing' }, { name: 'open' }, { params: { slots: 3 } },
      { params: { size: 60 } }, { document: { ...document, size: 800 } },
      { document: { ...document, identity: 'x'.repeat(129 * 1024) } },
    ]) expect(() => requestRules({ map })).toThrow(HttpError);
  });
  it('loads host-authored maps from MAPS_DIR into the catalogue and the host default selection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ac-map-directory-'));
    try {
      const document = { ...resolveMapDocument(44, 'highlands', DEFAULT_RULES.map, undefined), id: 'saved_highlands' };
      writeFileSync(join(directory, 'saved_highlands.json'), JSON.stringify(document));
      const configured = loadConfig({ MAPS_DIR: directory, RULES_JSON: JSON.stringify({ map: { name: 'saved_highlands' } }) });
      const catalogue = await json<{ maps: unknown[] }>(await fetch(`${base}/api/maps`));
      expect(catalogue.maps).toContainEqual(expect.objectContaining({ id: 'saved_highlands', mapSeed: 44, size: 48 }));
      const loaded = createPlayerThreeHost({ definition, matchOptions: configured.rules });
      try {
        expect(loaded.createMatch({ teams: ['nw', 'se'], realtime: false, seed: 12 }).view('nw').match).toMatchObject({ preset: 'highlands', mapSeed: 44 });
      } finally { loaded.dispose(); }
      const host = createPlayerThreeHost({ definition, matchOptions: { terrain: 'open', map: { seed: 77, params: { size: 80 } } } });
      try {
        const match = host.createMatch({ teams: ['nw', 'se'], realtime: false, options: { map: { name: 'crown' } } });
        expect(match.options).toEqual({ terrain: 'open', map: { name: 'crown' } });
        expect(match.view('nw').match).toMatchObject({ mapId: 'crown', rules: { map: { size: 48 } } });
      } finally { host.dispose(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('publishes only public map descriptors', async () => {
    const response = await fetch(`${base}/api/maps`);
    expect(response.status).toBe(200);
    const catalogue = await json<{ maps: { id: string; sizes: number[] }[] }>(response);
    expect(catalogue.maps).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'rivers', sizes: [48, 64, 80] })]));
    expect(JSON.stringify(catalogue)).not.toMatch(/intGridRle|entityInstances|levels|fieldInstances/);
    expect((await fetch(`${base}/api/maps`, { method: 'POST' })).status).toBe(405);
  });
});
