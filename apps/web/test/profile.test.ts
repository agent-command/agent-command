import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ProfileApi, answerPairedConsent, consentInfo, createLobby, pairConsent, parseLobbyCode, profileCall, publicDirectoryAdmission, publicLobbies } from '../src/profile.ts';
const KEY = 'agent-command.profile';
const profile = { id: 'a'.repeat(16), secret: 'b'.repeat(43) };
const roster = { id: profile.id, commanders: [], chat: [] };
let data: Map<string, string>; let fetcher: Mock;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  data = new Map(); vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
  fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe('lazy identity and preservation', () => {
  it('reads absent credentials without creating or requesting anything', () => { expect(ProfileApi.stored()).toBeUndefined(); expect(fetcher).not.toHaveBeenCalled(); expect(data.size).toBe(0); });
  it('reads saved credentials without network access', () => { data.set(KEY, JSON.stringify(profile)); expect(ProfileApi.stored()!.profile).toEqual(profile); expect(fetcher).not.toHaveBeenCalled(); });
  it('opens existing identities without replacement', async () => {
    data.set(KEY, JSON.stringify(profile)); fetcher.mockImplementation(async () => json(roster));
    for (let index = 0; index < 3; index++) expect((await ProfileApi.open()).created).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3); for (const [path, init] of fetcher.mock.calls) { expect(path).toBe('/api/profile'); expect(init.headers.authorization).toBe(`Bearer ${profile.secret}`); }
    expect(data.get(KEY)).toBe(JSON.stringify(profile));
  });
  it.each(['{broken', JSON.stringify({ ...profile, secret: 'x'.repeat(42) }), JSON.stringify({ ...profile, secret: 'x'.repeat(44) })])('preserves unreadable credentials %s', async (saved) => {
    data.set(KEY, saved); await expect(ProfileApi.open()).rejects.toThrow(/preserved/); expect(data.get(KEY)).toBe(saved); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not replace a server-rejected identity', async () => {
    data.set(KEY, JSON.stringify(profile)); fetcher.mockResolvedValue(json({ error: 'bad_profile' }, 401)); await expect(ProfileApi.open()).rejects.toThrow(); expect(data.get(KEY)).toBe(JSON.stringify(profile)); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not replace identity after network failure', async () => {
    data.set(KEY, JSON.stringify(profile)); fetcher.mockRejectedValue(new TypeError('Failed to fetch')); await expect(ProfileApi.open()).rejects.toThrow('Failed to fetch'); expect(data.get(KEY)).toBe(JSON.stringify(profile));
  });
  it('creates identity only for explicit open', async () => { fetcher.mockResolvedValueOnce(json(profile)).mockResolvedValueOnce(json(roster)); expect((await ProfileApi.open()).created).toBe(true); expect(data.get(KEY)).toBe(JSON.stringify(profile)); });
  it('does not manufacture identity when browser storage fails', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage denied'); } }); await expect(ProfileApi.open()).rejects.toThrow('Storage denied'); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('named commanders, not role singleton preferences', () => {
  beforeEach(() => { data.set(KEY, JSON.stringify(profile)); fetcher.mockImplementation(async () => json(roster)); });
  it('creates multiple named entries with compatible roles and explicit isolation declaration', async () => {
    const api = ProfileApi.stored()!;
    await api.createCommander({ name: 'DeepSeek Surface', kind: 'agent', roles: ['surface'], isolation: { independentSessions: true }, metadata: { provider: 'DeepSeek', model: 'self-report' } });
    await api.createCommander({ name: 'OpenAI Surface', kind: 'agent', roles: ['surface'], isolation: { independentSessions: true } });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/profile/commanders', '/api/profile/commanders']);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ name: 'DeepSeek Surface', roles: ['surface'], isolation: { independentSessions: true } });
  });
  it('targets opaque commander IDs and never adds role preferences', async () => {
    const patch = { scopes: ['policy', 'practice', 'say'] as const, mandate: { autonomy: 'supervised' as const, whenAbsent: 'hold' as const } };
    await ProfileApi.stored()!.update('commander/id', { ...patch, scopes: [...patch.scopes] });
    expect(fetcher.mock.calls[0]![0]).toBe('/api/profile/commanders/commander%2Fid'); expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(patch);
  });
  it.each([true, false])('resolves approvals by commander and request ID (%s)', async (approve) => {
    expect(await ProfileApi.stored()!.resolveApproval('surface-alpha', 'pending/id', approve)).toEqual(roster);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/profile/commanders/surface-alpha/approvals/pending%2Fid'); expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ approve });
  });
  it('deletes a named commander, never a role lane', async () => {
    await ProfileApi.stored()!.deleteCommander('named-1'); expect(fetcher.mock.calls[0]![0]).toBe('/api/profile/commanders/named-1'); expect(fetcher.mock.calls[0]![1].method).toBe('DELETE');
  });
  it('activates a version on an explicit compatible role and sends private chat to commander IDs', async () => {
    fetcher.mockResolvedValueOnce(json({ roster })).mockResolvedValueOnce(json(roster));
    const api = ProfileApi.stored()!;
    await api.rollback('multi-role', 'sky', 7); await api.tell(['multi-role'], 'Hold the relay');
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ role: 'sky', version: 7 });
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ commanderIds: ['multi-role'], text: 'Hold the relay' });
  });
});

describe('request-scoped named consent', () => {
  it('reads consent without profile authentication', async () => { fetcher.mockResolvedValue(json({ client: { name: 'Test' } })); await consentInfo('request-id'); expect(fetcher.mock.calls[0]![1].headers.authorization).toBeUndefined(); expect(data.size).toBe(0); });
  it('uses only pairing capability and selected commander even with another saved owner', async () => {
    data.set(KEY, JSON.stringify(profile)); fetcher.mockResolvedValueOnce(json({ commanders: [], pairingToken: 'request-capability', expiresAt: 100 })).mockResolvedValueOnce(json({ redirect: 'http://localhost/callback' }));
    const pair = await pairConsent('request-id', 'ABC234'); await answerPairedConsent('request-id', 'commander-id', ['sky'], true, pair.pairingToken);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ commander: 'commander-id', roles: ['sky'], approve: true, pairingToken: 'request-capability' });
    for (const [, init] of fetcher.mock.calls) expect(init.headers.authorization).toBeUndefined(); expect(data.get(KEY)).toBe(JSON.stringify(profile));
  });
  it('submits exact named consent from the current owner', async () => {
    data.set(KEY, JSON.stringify(profile)); fetcher.mockResolvedValue(json({ redirect: 'http://localhost/callback' })); await ProfileApi.stored()!.answerConsent('request-id', 'named-1', ['orbit'], true);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ commander: 'named-1', roles: ['orbit'], approve: true }); expect(fetcher.mock.calls[0]![1].headers.authorization).toBe(`Bearer ${profile.secret}`);
  });
});

describe('single lobby allocator and safe admission', () => {
  it.each([false, true])('browses without credentials (saved profile %s)', async (saved) => {
    if (saved) data.set(KEY, JSON.stringify(profile)); fetcher.mockResolvedValueOnce(json({ lobbies: [] })).mockResolvedValueOnce(json({ roomId: 'directory', token: 'directory-only', expiresAt: 1000 }));
    await publicLobbies(); await publicDirectoryAdmission(); for (const [, init] of fetcher.mock.calls) expect(init.headers.authorization).toBeUndefined(); expect(data.get(KEY)).toBe(saved ? JSON.stringify(profile) : undefined);
  });
  it('creates anonymous private Play through the same lobby API without storing a profile', async () => {
    fetcher.mockResolvedValue(json({ code: 'ROOM1234', roomId: 'pregame', visitorToken: 'visitor-only' }));
    expect(await createLobby({ mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true })).toMatchObject({ visitorToken: 'visitor-only' });
    expect(fetcher.mock.calls[0]![0]).toBe('/api/lobbies'); expect(fetcher.mock.calls[0]![1].headers.authorization).toBeUndefined(); expect(data.size).toBe(0);
  });
  it('keeps owner authentication out of lobby bodies and links', async () => {
    data.set(KEY, JSON.stringify(profile)); fetcher.mockResolvedValue(json({ code: 'ROOM1234', roomId: 'pregame' }));
    await ProfileApi.stored()!.createLobby({ mapId: 'canyons', mapSeed: 42, size: 48, layoutId: 'duel', visibility: 'private', preset: 'host' });
    const [path, init] = fetcher.mock.calls[0]!; expect(path).toBe('/api/lobbies'); expect(init.headers.authorization).toBe(`Bearer ${profile.secret}`); expect(JSON.parse(init.body)).toEqual({ mapId: 'canyons', mapSeed: 42, size: 48, layoutId: 'duel', visibility: 'private', preset: 'host' }); expect(init.body).not.toContain(profile.secret);
  });
  it('authenticates fresh admissions, handoff and release over HTTP', async () => {
    data.set(KEY, JSON.stringify(profile)); fetcher.mockImplementation(async () => json({})); const api = ProfileApi.stored()!;
    await api.joinLobby('ROOM1234', { observer: true }); await api.connectLobby('ROOM1234'); await profileCall('/api/lobbies/ROOM1234/ticket', { body: {}, secret: profile.secret }); await profileCall('/api/lobbies/ROOM1234/leave', { body: {}, secret: profile.secret });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/lobbies/join', '/api/lobbies/ROOM1234/connect', '/api/lobbies/ROOM1234/ticket', '/api/lobbies/ROOM1234/leave']);
    for (const [path, init] of fetcher.mock.calls) { expect(init.headers.authorization).toBe(`Bearer ${profile.secret}`); expect(path).not.toContain(profile.secret); expect(init.body).not.toContain(profile.secret); }
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ code: 'ROOM1234', observer: true });
  });
  it('sends visitor authority only as a scoped HTTP scheme', async () => {
    fetcher.mockResolvedValue(json({})); await profileCall('/api/lobbies/ROOM1234/connect', { body: {}, visitorToken: 'visitor-only' });
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe('Visitor visitor-only'); expect(fetcher.mock.calls[0]![1].body).toBe('{}'); expect(data.size).toBe(0);
  });
  it('launches the generic runner with full explicit schedule input', async () => {
    data.set(KEY, JSON.stringify(profile)); fetcher.mockResolvedValue(json({ seriesId: 'series-id' }));
    const setup = { revision: 3, seeds: [5, 8], maps: ['open'], sideSwaps: true, speed: 2, concurrency: 1, maxTicks: 1000, maxWallMs: 60000, retries: 1, retryOn: ['infrastructure'], abortOn: [], schedule: 'paired' as const, resetAgentState: true as const };
    await ProfileApi.stored()!.startSeries('ROOM1234', setup); expect(fetcher.mock.calls[0]![0]).toBe('/api/lobbies/ROOM1234/series'); expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(setup);
  });
  it('reads authenticated operator limits before a benchmark', async () => {
    data.set(KEY, JSON.stringify(profile)); fetcher.mockResolvedValue(json({ maxGames: 200 }));
    await ProfileApi.stored()!.arenaLimits();
    expect(fetcher.mock.calls[0]![0]).toBe('/api/arena/limits');
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe(`Bearer ${profile.secret}`);
  });
  it('explicitly adopts a visitor membership with owner authorization and an expected revision', async () => {
    data.set(KEY, JSON.stringify(profile)); fetcher.mockResolvedValue(json({ code: 'ROOM1234', roomId: 'pregame' }));
    await ProfileApi.stored()!.claimLobby('ROOM1234', 'visitor-private', 7);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/lobbies/ROOM1234/claim-owner');
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ visitorToken: 'visitor-private', revision: 7 });
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe(`Bearer ${profile.secret}`);
  });
  it.each(['ROOM1234', '#l=ROOM1234', 'https://play.example/?screen=browse#l=ROOM1234'])('parses credential-free destination %s', (value) => { expect(parseLobbyCode(value)).toBe('ROOM1234'); });
  it.each(['#i=ROOM1234', '#r=room&t=secret', 'https://play.example/?l=ROOM1234', '<script>', 'short'])('rejects non-lobby input %s', (value) => { expect(parseLobbyCode(value)).toBeUndefined(); });
});
