// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ARMIES, COLOURS, DEFAULT_RULES, PLANES, resolveBotOptions, rulesOptions } from '@agent-command/game/contract';
import { MAPS, type LobbySnapshot, type LobbySummary } from '@agent-command/game/lobby';
import type * as LobbyModule from '@agent-command/game/lobby';
import type * as TerrainModule from '../src/terrain-choice.ts';
import { Lobby, lobbyRoute } from '../src/lobby.ts';
import { wholeArmyOccupant } from '../src/occupant-select.ts';
import { ProfileApi, type Roster, type RosterCommander } from '../src/profile.ts';
import { LobbySocket } from '../src/lobby-net.ts';
import { playableMap, TerrainChoice } from '../src/terrain-choice.ts';
import { CORNER_LABEL } from '../src/armies.ts';
import { CallError } from '../src/net.ts';
import { ApiError } from '../src/api.ts';

const rulesUI = vi.hoisted(() => ({ change: undefined as undefined | ((rules: typeof DEFAULT_RULES) => void) }));
vi.mock('../src/rules-editor.ts', () => ({ createRulesEditor: (options: { onChange: typeof rulesUI.change }) => {
  rulesUI.change = options.onChange;
  const element = document.createElement('section'); element.setAttribute('aria-label', 'Match rules');
  return { element, update() {}, destroy() {} };
} }));
vi.mock('../src/commanders.ts', () => ({
  CommandersScreen: class { el = document.createElement('div'); update() {} dispose() {} },
}));
vi.mock('../src/settings.ts', () => ({ SettingsMenu: class { el = document.createElement('div'); dispose() {} } }));
vi.mock('../src/agent-console.ts', () => ({ mountAgentConsole: () => ({ toggle() {}, close() {}, destroy() {} }) }));
/** A stateful stand-in for the shared map selection: authored maps carry their fixed seed, like TerrainChoice. */
vi.mock('../src/terrain-choice.ts', async () => {
  const { MAPS: maps } = await vi.importActual<typeof LobbyModule>('@agent-command/game/lobby');
  const { playableMap, duelMap } = await vi.importActual<typeof TerrainModule>('../src/terrain-choice.ts');
  return { playableMap, duelMap, mapChoiceUrl: () => 'http://localhost/?screen=play', TerrainChoice: class {
    ready = Promise.resolve(); value = { mapId: 'open', mapSeed: 17, size: 48 }; listeners = new Set<() => void>();
    get() { return maps.find((map) => map.id === this.value.mapId)!.terrain; }
    getMap() { return { ...this.value }; }
    options() { return { terrain: this.get(), map: { seed: this.value.mapSeed, params: { size: this.value.size } } }; }
    set(mapId: string) {
      const map = maps.find((entry) => entry.id === mapId)!;
      this.value = { mapId, mapSeed: map.tags.includes('generated') ? this.value.mapSeed : map.mapSeed!, size: map.sizes.includes(this.value.size) ? this.value.size : map.size };
      this.emit();
    }
    setSeed(mapSeed: number) { this.value = { ...this.value, mapSeed }; this.emit(); }
    setSize(size: number) { this.value = { ...this.value, size }; this.emit(); }
    emit() { for (const listener of this.listeners) listener(); }
    onChange(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  } };
});
// Map-card thumbnails generate in a worker; the lobby tests only need the cards themselves.
vi.mock('../src/preview-client.ts', () => ({ thumbnailMaps: { get: () => new Promise(() => {}) } }));
vi.mock('../src/lobby-net.ts', () => ({ LobbySocket: { directory: vi.fn(), pregame: vi.fn() } }));
const profile = { id: 'a'.repeat(16), secret: 'b'.repeat(43) };
const roster: Roster = { id: profile.id, surfaceHash: 'a'.repeat(64), commanders: [], chat: [] };
const ticket = { roomId: 'match', token: 't'.repeat(32), team: 'nw', mode: 'pvp', label: '1v1' };
const admission = { roomId: 'pregame', token: 'admission-only', expiresAt: 100000 };
const limits = { maxGames: 200, maxConcurrency: 2, maxLiveConcurrency: 1, maxTicks: 36000, maxWallMs: 3600000, maxAttemptBytes: 268435456, maxBytes: 2147483648, maxOwnerBytes: 4294967296, maxActiveSeries: 2, retentionMs: 2592000000, minPublicDelayMs: 180000 };
const command = vi.fn(); const leaveSocket = vi.fn();
let publish: (snapshot: LobbySnapshot) => void;
let publishList: (rooms: LobbySummary[]) => void;
let disconnected: (rejoin: boolean) => void;
let lobby: Lobby | undefined;
let enter: Mock;
let fetcher: Mock;
function snapshot(patch: Partial<LobbySnapshot> = {}): LobbySnapshot {
  return {
    code: 'ROOM1234', mapId: 'open', layoutId: 'duel', terrain: 'open', mode: '1v1', visibility: 'private', featured: true, phase: 'waiting', revision: 7,
    mapSeed: 17, size: 48, rules: DEFAULT_RULES, rulesHash: 'sha256:resolved', rulesDiff: [], customRules: false, unrankedPractice: false, practiceReasons: [],
    observerPolicy: { allowOmniscient: true, minDelayMs: 0 },
    sides: [{ id: 'nw', label: 'Northwest', alliance: 'blue' }, { id: 'se', label: 'Southeast', alliance: 'red' }],
    members: 1, capacity: 2, agentsAllowed: true,
    purpose: 'play',
    players: [{ id: 'self', label: 'You', seats: PLANES.map((role) => ({ team: 'nw', role })), observer: false, connected: true, ready: false, leader: true }],
    seats: ['nw', 'se'].flatMap((team) => PLANES.map((role) => ({ team, role, occupant: team === 'nw' ? { kind: 'human' as const, memberId: 'self' } : { kind: 'open' as const }, ready: 'ready' as const }))),
    you: { memberId: 'self', observer: false, leader: true }, expiresAt: 100000, ...patch,
  };
}
function commander(id: string, patch: Partial<RosterCommander> = {}): RosterCommander {
  return { id, name: id, kind: 'agent', roles: ['surface'], isolation: { independentSessions: true }, token: 'private-commander-token', scopes: [],
    mandate: { autonomy: 'autonomous', whenAbsent: 'hold', directive: { stance: 'defend' } },
    policy: { activeByRole: { surface: null }, versions: [] }, approvals: [], connected: true, lastSeenAt: null, seated: null, practicing: false, lastPractice: null, ...patch };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  vi.useFakeTimers(); history.replaceState(null, '', '/'); localStorage.clear(); sessionStorage.clear(); localStorage.setItem('agent-command.profile', JSON.stringify(profile));
  vi.spyOn(ProfileApi.prototype, 'roster').mockResolvedValue(roster);
  vi.spyOn(ProfileApi.prototype, 'connections').mockResolvedValue([]);
  vi.spyOn(ProfileApi.prototype, 'arenaLimits').mockResolvedValue(limits);
  fetcher = vi.fn(async (path: string) => {
    if (path === '/api/lobbies') return json({ code: 'ROOM1234', roomId: 'pregame', lobbies: [] });
    if (path.endsWith('/series')) return json({ seriesId: 'series-1' });
    if (path.endsWith('/ticket')) return json(ticket);
    if (path.endsWith('/connect')) return json(admission);
    return json({ code: 'ROOM1234', roomId: 'pregame' });
  });
  vi.stubGlobal('fetch', fetcher);
  command.mockReset().mockResolvedValue(undefined); leaveSocket.mockReset();
  vi.mocked(LobbySocket.directory).mockImplementation(async (_admission, list) => { publishList = list; return { leave: leaveSocket } as unknown as LobbySocket; });
  vi.mocked(LobbySocket.pregame).mockImplementation(async (_admission, update, left) => { publish = update; disconnected = left; update(snapshot()); return { leave: leaveSocket, command } as unknown as LobbySocket; });
  enter = vi.fn();
});
afterEach(() => { lobby?.dispose(); lobby = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });
async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(0); }
async function mount(onSeries?: (result: { seriesId: string; credential: string }) => void, onWatch?: () => void): Promise<Lobby> {
  lobby = new Lobby(enter, new TerrainChoice(), onSeries, onWatch); document.body.append(lobby.el); await flush(); return lobby;
}
function action(name: string): HTMLButtonElement { return lobby!.el.querySelector<HTMLButtonElement>(`[data-lobby-action="${name}"]`)!; }
function request(path: string): { body: Record<string, unknown>; headers: Record<string, string> } {
  const call = fetcher.mock.calls.find(([url, init]) => url === path && init.method === 'POST')!;
  return { body: JSON.parse(call[1].body), headers: call[1].headers };
}
function pick(selector: string, value: string): void { const select = lobby!.el.querySelector<HTMLSelectElement>(selector)!; select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }

/** Every seat a standard bot and me an observer: the lineup an unattended series accepts. */
function botLineup(patch: Partial<LobbySnapshot> = {}): LobbySnapshot {
  const next = snapshot({ you: { memberId: 'self', observer: true, leader: true }, ...patch }); next.players[0]!.observer = true;
  next.seats = next.seats.map((seat) => ({ ...seat, occupant: { kind: 'bot', level: 'standard', options: { ...resolveBotOptions('standard') } } }));
  return next;
}
function drag(type: string, target: Element): void { target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); }
const cards = () => [...lobby!.el.querySelectorAll<HTMLElement>('[data-match-card]')].map((card) => card.dataset.matchCard);

describe('pre-match screens', () => {
  it('Home offers exactly Quick Play, Create Game, Lobby, Commanders and Watch live', async () => {
    const watch = vi.fn(); const view = await mount(undefined, watch);
    expect(view.el.querySelector('img')?.alt).toBe('Agent Command');
    expect([...view.el.querySelectorAll<HTMLElement>('.lobby-actions [data-lobby-action]')].map((button) => button.dataset.lobbyAction)).toEqual(['play', 'create', 'lobby', 'commanders', 'watch']);
    expect(view.el.querySelector('[data-lobby-action="benchmark"], [data-lobby-action="host"]')).toBeNull();
    expect(view.el.querySelector('[title]')).toBeNull();
    action('watch').click(); expect(watch).toHaveBeenCalledOnce();
    expect(lobbyRoute('?screen=lobby')).toBe('lobby'); expect(lobbyRoute('?screen=game')).toBe('game'); expect(lobbyRoute('?screen=browse')).toBe('home');
  });
  it("index.html's boot shell names exactly Home's tiles, in order", async () => {
    const view = await mount(undefined, vi.fn());
    const shell = new DOMParser().parseFromString(readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8'), 'text/html');
    const tiles = (root: ParentNode, selector: string) => [...root.querySelectorAll(selector)].map((tile) => [tile.querySelector('b')?.textContent, tile.querySelector('small')?.textContent]);
    expect(tiles(shell, '.shell-tile')).toEqual(tiles(view.el, '.lobby-actions .pm-tile'));
  });
  it('Lobby is the public games list only: filter, open seats, join or observe', async () => {
    // Home never opens the directory socket (nor loads Colyseus); the list connects when first shown.
    await mount(); expect(LobbySocket.directory).not.toHaveBeenCalled();
    action('lobby').click(); await flush(); expect(LobbySocket.directory).toHaveBeenCalledOnce();
    expect(lobby!.el.dataset.lobbyRoute).toBe('lobby'); expect(location.search).toBe('?screen=lobby');
    expect(lobby!.el.querySelector('.map-picker, .lobby-army, .rules-editor')).toBeNull();
    const open = snapshot({ code: 'OPENROOM', visibility: 'public', mapId: 'rivers', mapSeed: 27, size: 64, observerPolicy: { allowOmniscient: true, minDelayMs: 180000 } });
    const full = snapshot({ code: 'FULLROOM', visibility: 'public' }); full.seats = full.seats.map((seat) => ({ ...seat, occupant: { kind: 'bot', level: 'standard', options: {} } }));
    publishList([open, full, snapshot({ code: 'HIDDEN11', visibility: 'private' })]);
    expect(cards()).toEqual(['OPENROOM', 'FULLROOM']);
    const card = lobby!.el.querySelector('[data-match-card="OPENROOM"]')!;
    expect(card.querySelector('.match-card-detail')?.textContent).toBe('64 × 64 · seed 27 · 1v1');
    expect(card.textContent).toContain('Rivers'); expect(card.textContent).toContain('4 open'); expect(card.textContent).toContain('180 s');
    const openOnly = lobby!.el.querySelector<HTMLInputElement>('[aria-label="Open seats only"]')!; openOnly.checked = true; openOnly.dispatchEvent(new Event('change'));
    expect(cards()).toEqual(['OPENROOM']);
    openOnly.checked = false; openOnly.dispatchEvent(new Event('change'));
    const filter = lobby!.el.querySelector<HTMLInputElement>('[aria-label="Filter games"]')!; filter.value = 'full'; filter.dispatchEvent(new Event('input'));
    expect(cards()).toEqual(['FULLROOM']);
    filter.value = ''; filter.dispatchEvent(new Event('input'));
    action('observe-OPENROOM').click(); await flush();
    expect(request('/api/lobbies/join').body).toEqual({ code: 'OPENROOM', observer: true }); expect(lobby!.el.dataset.lobbyRoute).toBe('game');
  });
  it('joins a private game by code from the Lobby header', async () => {
    await mount(); action('lobby').click();
    const input = lobby!.el.querySelector<HTMLInputElement>('#lobby-join-code')!; input.value = 'https://example.test/#l=ROOM1234'; input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush();
    expect(request('/api/lobbies/join').body).toEqual({ code: 'ROOM1234' }); expect(lobby!.el.dataset.lobbyRoute).toBe('game');
  });
  it('Quick Play opens the private practice room for setup instead of starting', async () => {
    localStorage.clear(); const open = vi.spyOn(ProfileApi, 'open'); await mount(); action('play').click(); await flush();
    expect(request('/api/lobbies').body).toEqual({ mapId: 'open', mapSeed: 17, size: 48, layoutId: 'duel', visibility: 'private', preset: 'play', botLevel: 'standard' });
    expect(open).not.toHaveBeenCalled(); expect(localStorage.getItem('agent-command.profile')).toBeNull();
    expect(lobby!.el.dataset.lobbyRoute).toBe('game'); expect(enter).not.toHaveBeenCalled();
    expect(action('start-lobby')).not.toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('/api/match'))).toBe(false);
  });
  it('Create Game is one three-column room: battlefield, sides with the commander dock, setup with Start', async () => {
    await mount(); action('create').click(); await flush();
    expect(request('/api/lobbies').body).toMatchObject({ preset: 'host', visibility: 'private' });
    expect([...lobby!.el.querySelectorAll<HTMLElement>('.pm-room > .pm-col')].map((column) => column.getAttribute('aria-label'))).toEqual(['Battlefield', 'Sides', 'Setup']);
    expect(lobby!.el.querySelector('.pm-field .map-picker')).not.toBeNull();
    expect(lobby!.el.querySelector('.pm-armies .pm-dock')).not.toBeNull();
    expect(lobby!.el.querySelector('.pm-setup [data-lobby-action="start-lobby"]')).not.toBeNull();
    expect([...lobby!.el.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.dataset.setupTab)).toEqual(['match', 'rules', 'series']);
    expect(lobby!.el.querySelector<HTMLElement>('#pm-panel-rules')!.hidden).toBe(true);
    lobby!.el.querySelector<HTMLButtonElement>('[data-setup-tab="rules"]')!.click();
    expect(lobby!.el.querySelector<HTMLElement>('#pm-panel-rules')!.hidden).toBe(false); expect(lobby!.el.querySelector<HTMLElement>('#pm-panel-match')!.hidden).toBe(true);
    // Only playable layouts are offered: a generated recipe plays the C2 duel or the C4 free-for-all.
    const layout = lobby!.el.querySelector<HTMLSelectElement>('select[aria-label="Layout"]')!;
    expect([...layout.options].map((option) => [option.value, option.textContent, option.selected])).toEqual([['duel', '1v1', true], ['ffa', 'Free-for-all', false]]);
    expect(lobby!.el.textContent).not.toContain('pairs');
  });
  it('with no commanders the dock links to Commanders, and Commanders leads back to the game', async () => {
    await mount(); action('create').click(); await flush();
    expect(lobby!.el.querySelector('.pm-dock')?.textContent).toContain('No commanders yet');
    action('commanders').click(); await flush();
    expect(lobby!.el.dataset.lobbyRoute).toBe('commanders');
    action('return-game').click();
    expect(lobby!.el.dataset.lobbyRoute).toBe('game');
  });
  it('uses the remembered valid bot level without reintroducing roster preferences', async () => {
    localStorage.setItem('agent-command.practice-level', 'veteran'); await mount(); action('play').click(); await flush();
    expect(request('/api/lobbies').body).toMatchObject({ preset: 'play', botLevel: 'veteran' });
  });
  it('offers Back to game from Home and leaves the open room before creating another', async () => {
    await mount(); action('create').click(); await flush();
    action('home').click(); expect(action('resume').textContent).toContain('ROOM1234');
    action('play').click(); await flush();
    const calls = fetcher.mock.calls.map(([url]) => url);
    expect(calls.indexOf('/api/lobbies/ROOM1234/leave')).toBeGreaterThan(-1);
    expect(calls.lastIndexOf('/api/lobbies')).toBeGreaterThan(calls.indexOf('/api/lobbies/ROOM1234/leave'));
  });
  it('hands off only the started snapshot using lobby admission', async () => {
    await mount(); action('play').click(); await flush(); publish(snapshot({ phase: 'started' })); await flush();
    expect(request('/api/lobbies/ROOM1234/ticket').headers.authorization).toBe(`Bearer ${profile.secret}`);
    expect(enter).toHaveBeenCalledWith({ ticket: { ...ticket, lobbyCode: 'ROOM1234', lobbyAuth: { secret: profile.secret } }, mode: 'pvp', label: '1v1', observe: expect.any(Function) });
  });
  it('hands an all-bot Start to the observer with only the server-authorized perspective', async () => {
    // Even when the room permits omniscience, a returning human can receive a narrower history grant.
    const observerTicket = {
      roomId: 'bots-match', token: 'observer-token', observer: true,
      grant: { kind: 'team', team: 'nw', delayMs: 180000 }, label: 'Bots',
    };
    const initial = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path: string, init: RequestInit = {}) =>
      path === '/api/lobbies/ROOM1234/ticket' ? json(observerTicket) : initial(path, init));
    await mount(); action('create').click(); await flush();
    const bots = botLineup();
    bots.players[0]!.seats = [];
    publish(bots);
    expect(action('start-lobby').disabled).toBe(false);
    action('start-lobby').click(); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'start' }, bots.revision);
    expect(enter).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([path]) => path.endsWith('/ticket'))).toBe(false);
    publish({ ...bots, phase: 'started' }); await flush();
    expect(request('/api/lobbies/ROOM1234/ticket')).toEqual({
      body: {}, headers: expect.objectContaining({ authorization: `Bearer ${profile.secret}` }),
    });
    expect(enter).toHaveBeenCalledExactlyOnceWith({
      ticket: {
        roomId: 'bots-match', token: 'observer-token', observer: true,
        grant: { kind: 'team', team: 'nw', delayMs: 180000 }, label: 'Bots',
        lobbyCode: 'ROOM1234', lobbyAuth: { secret: profile.secret },
      },
      mode: 'pvp', label: 'Bots',
    });
    // Observer admission must not acquire a player's post-elimination observer-pass callback.
    expect(enter.mock.calls[0]![0]).not.toHaveProperty('observe');
    expect(enter.mock.calls[0]![0].ticket).not.toHaveProperty('tickets');
  });
  it('shows the shared FIFO queue for a capacity-limited profiled Play and enters on admission', async () => {
    await mount(); action('play').click(); await flush();
    expect(request('/api/lobbies').headers.authorization).toBe(`Bearer ${profile.secret}`);
    publish(snapshot({ phase: 'preparing', queuePosition: 2, estimatedWaitMs: 120_000 })); await flush();
    expect(lobby!.el.textContent).toContain('Queued 2 · about 2 min');
    expect(enter).not.toHaveBeenCalled();
    publish(snapshot({ phase: 'started' })); await flush();
    expect(enter).toHaveBeenCalledOnce();
    expect(lobby!.el.textContent).not.toContain('Queued');
  });
  it('sets aside a profile the server no longer recognizes and creates with a fresh one', async () => {
    vi.mocked(ProfileApi.prototype.roster).mockRejectedValueOnce(new ApiError('bad_profile'));
    const fresh = { id: 'c'.repeat(16), secret: 'd'.repeat(43) };
    const initial = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path: string, init: RequestInit = {}) => path === '/api/profile' && init.method === 'POST' ? json(fresh) : initial(path, init));
    await mount(); action('create').click(); await flush();
    expect(request('/api/lobbies').headers.authorization).toBe(`Bearer ${fresh.secret}`);
    expect(JSON.parse(localStorage.getItem('agent-command.profile')!)).toEqual(fresh);
    const kept = Object.keys(localStorage).filter((key) => key.startsWith('agent-command.profile.unrecognized.'));
    expect(kept.map((key) => JSON.parse(localStorage.getItem(key)!))).toEqual([profile]);
    expect(lobby!.el.textContent).not.toContain('Saved profile unavailable');
  });
  it('uses visitor capability only on lobby HTTP and never in share URLs', async () => {
    localStorage.clear(); const initial = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path: string, init: RequestInit = {}) => path === '/api/lobbies' && init.method === 'POST' ? json({ code: 'ROOM1234', roomId: 'pregame', visitorToken: 'visitor-private' }) : initial(path, init));
    await mount(); action('play').click(); await flush();
    expect(request('/api/lobbies/ROOM1234/connect').headers.authorization).toBe('Visitor visitor-private');
    expect(location.hash).toBe('#l=ROOM1234'); expect(lobby!.el.querySelector<HTMLInputElement>('.invite-box input')?.value).not.toContain('visitor-private');
    // The match keeps the visitor's lobby admission: anonymous Play has no profile to renew or recover its seats with.
    publish(snapshot({ phase: 'started' })); await flush();
    expect(request('/api/lobbies/ROOM1234/ticket').headers.authorization).toBe('Visitor visitor-private');
    expect(enter).toHaveBeenCalledWith(expect.objectContaining({ ticket: expect.objectContaining({ lobbyCode: 'ROOM1234', lobbyAuth: { visitorToken: 'visitor-private' } }) }));
  });
  it('recovers a tab-scoped visitor without creating a persistent profile', async () => {
    localStorage.clear(); sessionStorage.setItem('agent-command.visitor.ROOM1234', 'visitor-private'); const open = vi.spyOn(ProfileApi, 'open');
    await mount(); await lobby!.join('ROOM1234'); await flush();
    expect(open).not.toHaveBeenCalled(); expect(request('/api/lobbies/ROOM1234/connect').headers.authorization).toBe('Visitor visitor-private');
    expect(fetcher.mock.calls.some(([path]) => path === '/api/lobbies/join')).toBe(false);
  });
  it('adopts the visitor membership before using a newly created private roster', async () => {
    localStorage.clear(); sessionStorage.setItem('agent-command.visitor.ROOM1234', 'visitor-private');
    vi.spyOn(ProfileApi, 'create').mockImplementation(async () => { localStorage.setItem('agent-command.profile', JSON.stringify(profile)); return { api: ProfileApi.stored()!, roster }; });
    await mount(); await lobby!.join('ROOM1234'); action('commanders').click(); await flush();
    expect(request('/api/lobbies/ROOM1234/claim-owner').body).toEqual({ visitorToken: 'visitor-private', revision: 7 });
    expect(request('/api/lobbies/ROOM1234/claim-owner').headers.authorization).toBe(`Bearer ${profile.secret}`);
    expect(sessionStorage.getItem('agent-command.visitor.ROOM1234')).toBeNull();
  });
});

describe('slots: whole army, plane seats and the commander dock', () => {
  it('collapses equal semantic settings but exposes mixed knobs', () => {
    const seats = snapshot().seats.filter((seat) => seat.team === 'nw');
    expect(wholeArmyOccupant(seats)).toEqual({ kind: 'human', memberId: 'self' });
    seats[0]!.occupant = { kind: 'bot', level: 'standard', options: { aggression: .2 } };
    expect(wholeArmyOccupant(seats)).toBeUndefined();
  });
  it('sends all four roles in one assignment and uses real tier defaults', async () => {
    await mount(); action('create').click(); await flush();
    pick('[data-side="se"] .lobby-whole-army select', 'bot'); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'assign', team: 'se', roles: [...PLANES], occupant: { kind: 'bot', level: 'standard', options: { ...resolveBotOptions('standard') } } }, 7);
  });
  it('filters my named commanders by compatible roles and permits multiple surface entries', async () => {
    vi.mocked(ProfileApi.prototype.roster).mockResolvedValue({ ...roster, commanders: [commander('deepseek'), commander('openai'), commander('orbit-only', { roles: ['orbit'] })] });
    await mount(); action('create').click(); await flush();
    lobby!.el.querySelector<HTMLButtonElement>('[data-lobby-action="seat-mode-se-planes"]')!.click();
    const select = lobby!.el.querySelector<HTMLSelectElement>('[data-occupant="se:surface"]')!;
    expect([...select.options].map((option) => option.value)).toContain('commander:deepseek'); expect([...select.options].map((option) => option.value)).toContain('commander:openai');
    expect([...select.options].map((option) => option.value)).not.toContain('commander:orbit-only');
    pick('[data-occupant="se:surface"]', 'commander:openai'); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'assign', team: 'se', roles: ['surface'], occupant: { kind: 'commander', ref: { id: 'openai', kind: 'agent' } } }, 7);
    expect(lobby!.el.innerHTML).not.toContain('private-commander-token');
  });
  it('drops a dragged dock commander onto a compatible slot as one atomic assign, never onto an incompatible one', async () => {
    vi.mocked(ProfileApi.prototype.roster).mockResolvedValue({ ...roster, commanders: [commander('deepseek'), commander('army', { roles: [...PLANES] })] });
    await mount(); action('create').click(); await flush();
    const chip = lobby!.el.querySelector<HTMLElement>('.pm-dock [data-commander-id="deepseek"]')!;
    expect(chip.draggable).toBe(true);
    // All-planes mode: a Surface-only commander can't take the whole army.
    const whole = lobby!.el.querySelector<HTMLElement>('[data-side="se"] .lobby-whole-army')!;
    drag('dragstart', chip);
    expect(whole.dataset.drop).toBe('no');
    drag('drop', whole); expect(command).not.toHaveBeenCalled();
    drag('dragend', chip);
    // Per-plane mode: the Surface seat accepts it.
    lobby!.el.querySelector<HTMLButtonElement>('[data-lobby-action="seat-mode-se-planes"]')!.click();
    const surface = lobby!.el.querySelector<HTMLElement>('[data-seat="se:surface"]')!;
    drag('dragstart', lobby!.el.querySelector<HTMLElement>('.pm-dock [data-commander-id="deepseek"]')!);
    expect(surface.dataset.drop).toBe('ok');
    drag('dragover', surface); expect(surface.classList.contains('drop-over')).toBe(true);
    drag('drop', surface); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'assign', team: 'se', roles: ['surface'], occupant: { kind: 'commander', ref: { id: 'deepseek', kind: 'agent' } } }, 7);
    expect(surface.dataset.drop).toBeUndefined();
    lobby!.el.querySelector<HTMLButtonElement>('[data-lobby-action="seat-mode-se-all"]')!.click();
    drag('dragstart', lobby!.el.querySelector<HTMLElement>('.pm-dock [data-commander-id="army"]')!);
    drag('drop', lobby!.el.querySelector<HTMLElement>('[data-side="se"] .lobby-whole-army')!); await flush();
    expect(command).toHaveBeenLastCalledWith({ op: 'assign', team: 'se', roles: [...PLANES], occupant: { kind: 'commander', ref: { id: 'army', kind: 'agent' } } }, 7);
  });
  it('places a picked commander by click or keyboard instead of dragging; Escape cancels the pick', async () => {
    vi.mocked(ProfileApi.prototype.roster).mockResolvedValue({ ...roster, commanders: [commander('deepseek')] });
    await mount(); action('create').click(); await flush();
    lobby!.el.querySelector<HTMLButtonElement>('.pm-dock [data-commander-id="deepseek"]')!.click();
    expect(lobby!.el.querySelector('.pm-dock [data-commander-id="deepseek"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(lobby!.el.querySelector('[data-side="se"] .lobby-whole-army [data-place]')).toBeNull();
    lobby!.el.querySelector<HTMLButtonElement>('[data-lobby-action="seat-mode-se-planes"]')!.click();
    expect(lobby!.el.querySelector('[data-place="se:surface"]')?.textContent).toBe('Place deepseek');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(lobby!.el.querySelector('[data-place]')).toBeNull();
    lobby!.el.querySelector<HTMLButtonElement>('.pm-dock [data-commander-id="deepseek"]')!.click();
    lobby!.el.querySelector<HTMLButtonElement>('[data-place="se:surface"]')!.click(); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'assign', team: 'se', roles: ['surface'], occupant: { kind: 'commander', ref: { id: 'deepseek', kind: 'agent' } } }, 7);
    expect(lobby!.el.querySelector('[data-place]')).toBeNull();
  });
  it('greys a commander out for every other army once it plays one: picker, Place and drops; its own army still takes it', async () => {
    vi.mocked(ProfileApi.prototype.roster).mockResolvedValue({ ...roster, commanders: [commander('deepseek', { roles: ['surface', 'orbit'] })] });
    await mount(); action('create').click(); await flush();
    const seated = snapshot();
    for (const seat of seated.seats) if (seat.team === 'nw' && seat.role === 'surface') seat.occupant = { kind: 'commander', entrantId: 'entrant-1', ref: { id: 'deepseek', kind: 'agent' } };
    publish(seated); await flush();
    for (const team of ['nw', 'se']) lobby!.el.querySelector<HTMLButtonElement>(`[data-lobby-action="seat-mode-${team}-planes"]`)!.click();
    const option = (seat: string) => lobby!.el.querySelector<HTMLOptionElement>(`select[data-occupant="${seat}"] option[value="commander:deepseek"]`)!;
    expect(option('se:orbit').disabled).toBe(true);
    expect(option('se:orbit').dataset.tip).toContain('already plays Northwest');
    expect(option('nw:orbit').disabled).toBe(false);
    // Place appears on its own army only.
    lobby!.el.querySelector<HTMLButtonElement>('.pm-dock [data-commander-id="deepseek"]')!.click();
    expect(lobby!.el.querySelector('[data-place="se:orbit"]')).toBeNull();
    expect(lobby!.el.querySelector('[data-place="nw:orbit"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    // A drop onto the other army is refused locally; the server would answer commander_other_army.
    const se = lobby!.el.querySelector<HTMLElement>('[data-seat="se:orbit"]')!;
    drag('dragstart', lobby!.el.querySelector<HTMLElement>('.pm-dock [data-commander-id="deepseek"]')!);
    expect(se.dataset.drop).toBe('no');
    drag('drop', se); await flush(); expect(command).not.toHaveBeenCalled();
    drag('dragend', lobby!.el.querySelector<HTMLElement>('.pm-dock [data-commander-id="deepseek"]')!);
    const nw = lobby!.el.querySelector<HTMLElement>('[data-seat="nw:orbit"]')!;
    drag('dragstart', lobby!.el.querySelector<HTMLElement>('.pm-dock [data-commander-id="deepseek"]')!);
    drag('drop', nw); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'assign', team: 'nw', roles: ['orbit'], occupant: { kind: 'commander', ref: { id: 'deepseek', kind: 'agent' } } }, 7);
  });
  it('renders unclaimed armies as open slots and claims one with a single click', async () => {
    await mount(); action('create').click(); await flush();
    const army = (side: string) => lobby!.el.querySelector<HTMLElement>(`.lobby-army[data-side="${side}"]`)!;
    expect(army('se').dataset.slotState).toBe('open'); expect(army('nw').dataset.slotState).toBe('active');
    expect(army('se').querySelector('.lobby-whole-army .agent-button')?.getAttribute('data-kind')).toBe('open');
    expect(army('nw').querySelector('[data-occupant-claim]')).toBeNull();
    army('se').querySelector<HTMLButtonElement>('.lobby-whole-army [data-occupant-claim]')!.click(); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'assign', team: 'se', roles: [...PLANES], occupant: { kind: 'human', memberId: 'self' } }, 7);
    const next = snapshot(); for (const seat of next.seats) if (seat.team === 'se') seat.occupant = { kind: 'closed' }; publish(next);
    expect(army('se').dataset.slotState).toBe('closed'); expect(army('se').querySelector('[data-occupant-claim]')).toBeNull();
  });
  it('lets a seatless observer, even a non-leader, claim an open slot back', async () => {
    await mount(); action('create').click(); await flush(); publish(snapshot({ you: { memberId: 'self', observer: true, leader: false } }));
    lobby!.el.querySelector<HTMLButtonElement>('.lobby-army[data-side="se"] .lobby-whole-army [data-occupant-claim]')!.click(); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'assign', team: 'se', roles: [...PLANES], occupant: { kind: 'human', memberId: 'self' } }, 7);
  });
  it('does not let the organizer impersonate an occupied human, nor drop a commander onto them', async () => {
    await mount(); action('create').click(); await flush(); const next = snapshot(); next.seats.find((seat) => seat.team === 'se' && seat.role === 'surface')!.occupant = { kind: 'human', memberId: 'other' }; publish(next);
    expect(lobby!.el.querySelector<HTMLSelectElement>('[data-occupant="se:surface"]')!.disabled).toBe(true);
    expect(lobby!.el.querySelector<HTMLElement>('[data-seat="se:surface"]')!.dataset.dropRoles).toBeUndefined();
  });
  it('moves only my human membership to observers with an atomic action', async () => {
    await mount(); action('create').click(); await flush(); action('move-observer').click(); await flush(); expect(command).toHaveBeenCalledWith({ op: 'observe' }, 7);
  });
});

/** A waiting four-army FFA on four_corners: me on nw, a standard bot on every other army, default colours. */
function ffaSnapshot(patch: Partial<LobbySnapshot> = {}): LobbySnapshot {
  const map = MAPS.find((entry) => entry.id === 'four_corners')!;
  return snapshot({
    mapId: map.id, layoutId: 'ffa', terrain: map.terrain, mode: 'ffa', mapSeed: map.mapSeed!, size: map.size, capacity: 4,
    sides: ARMIES.map((id, k) => ({ id, label: CORNER_LABEL[id], alliance: COLOURS[k]! })),
    seats: ARMIES.flatMap((team) => PLANES.map((role) => ({ team, role, occupant: team === 'nw' ? { kind: 'human' as const, memberId: 'self' } : { kind: 'bot' as const, level: 'standard' as const, options: { ...resolveBotOptions('standard') } }, ready: 'ready' as const }))),
    ...patch,
  });
}

describe('armies: corners and colours', () => {
  const swatches = (side: string) => [...lobby!.el.querySelectorAll<HTMLButtonElement>(`.lobby-army[data-side="${side}"] .lobby-army-head .lobby-colour`)];
  it('gives every army four colour swatches named by tip, with colours another army holds disabled', async () => {
    await mount(); action('create').click(); await flush();
    for (const side of ['nw', 'se']) {
      expect(swatches(side).map((swatch) => swatch.dataset.colour)).toEqual([...COLOURS]);
      expect(swatches(side).map((swatch) => swatch.getAttribute('aria-label'))).toEqual(['Blue', 'Red', 'Green', 'Violet']);
    }
    expect(swatches('nw').map((swatch) => swatch.dataset.tip)).toEqual(['Blue · this army', 'Red · taken by Southeast', 'Green', 'Violet']);
    expect(swatches('nw').map((swatch) => swatch.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    expect(swatches('nw').map((swatch) => swatch.disabled)).toEqual([false, true, false, false]);
    expect(swatches('se').map((swatch) => swatch.disabled)).toEqual([true, false, false, false]);
    expect(lobby!.el.querySelector('.lobby-army [title]')).toBeNull();
    const head = lobby!.el.querySelector<HTMLElement>('.lobby-army[data-side="se"]')!;
    expect(head.dataset.colour).toBe('red');
    expect(head.querySelector('h3')?.textContent).toBe('RedSoutheast');
    swatches('nw')[2]!.click(); await flush();
    expect(command).toHaveBeenLastCalledWith({ op: 'configure', colours: { nw: 'green' } }, 7);
    const calls = command.mock.calls.length;
    swatches('nw')[0]!.click(); await flush();
    expect(command).toHaveBeenCalledTimes(calls);
    publish(snapshot({ revision: 8, sides: [{ id: 'nw', label: 'Northwest', alliance: 'green' }, { id: 'se', label: 'Southeast', alliance: 'red' }] }));
    expect(swatches('nw').map((swatch) => swatch.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false']);
    expect(swatches('se').map((swatch) => swatch.disabled)).toEqual([false, false, true, false]);
    expect(lobby!.el.querySelector<HTMLElement>('.lobby-army[data-side="nw"]')!.dataset.colour).toBe('green');
  });
  it('explains a refused colour and locks the picker for non-leaders', async () => {
    await mount(); action('create').click(); await flush();
    command.mockRejectedValueOnce(new CallError('colour_taken'));
    swatches('se')[3]!.click(); await flush();
    expect(command).toHaveBeenLastCalledWith({ op: 'configure', colours: { se: 'violet' } }, 7);
    expect(lobby!.el.querySelector('.lobby-msg')?.textContent).toBe('Another army already has that colour.');
    publish(snapshot({ revision: 8, you: { memberId: 'self', observer: false, leader: false } }));
    expect([...swatches('nw'), ...swatches('se')].every((swatch) => swatch.disabled)).toBe(true);
  });
  it('lays four armies out in a grid without VS, each in its own colour, and switches the layout', async () => {
    await mount(); action('create').click(); await flush();
    publish(ffaSnapshot());
    const grid = lobby!.el.querySelector<HTMLElement>('.lobby-armies')!;
    expect(grid.dataset.armies).toBe('4');
    expect(grid.querySelector('.pm-vs')).toBeNull();
    expect([...grid.querySelectorAll<HTMLElement>('.lobby-army')].map((army) => [army.dataset.side, army.dataset.colour])).toEqual([['nw', 'blue'], ['ne', 'red'], ['se', 'green'], ['sw', 'violet']]);
    for (const [k, side] of ARMIES.entries()) expect(swatches(side).map((swatch) => swatch.disabled)).toEqual(COLOURS.map((_, j) => j !== k));
    expect(swatches('sw').map((swatch) => swatch.dataset.tip)).toEqual(['Blue · taken by Northwest', 'Red · taken by Northeast', 'Green · taken by Southeast', 'Violet · this army']);
    const layout = lobby!.el.querySelector<HTMLSelectElement>('select[aria-label="Layout"]')!;
    expect([...layout.options].map((option) => [option.value, option.selected])).toEqual([['ffa', true], ['duel', false]]);
    pick('select[aria-label="Layout"]', 'duel'); await flush();
    expect(command).toHaveBeenLastCalledWith({ op: 'configure', layoutId: 'duel' }, 7);
  });
});

describe('setup: battlefield, match options and rules', () => {
  it('sends full resolved rule options and renders readiness from the new revision', async () => {
    await mount(); action('create').click(); await flush(); const rules = { ...DEFAULT_RULES, economy: { ...DEFAULT_RULES.economy, startAlloy: 1200 } }; rulesUI.change!(rules); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'configure', rules: rulesOptions(rules) }, 7);
    publish(snapshot({ revision: 8, rules, customRules: true, unrankedPractice: true, practiceReasons: ['custom rules'] }));
    expect(action('ready').textContent).toContain('Ready'); expect(lobby!.el.querySelector('[data-unranked]')?.textContent).toContain('Custom rules');
    expect(lobby!.el.querySelector('[data-setup-tab="rules"]')!.hasAttribute('data-changed')).toBe(true);
  });
  it('switches visibility and observer delay through revisioned configure commands', async () => {
    await mount(); action('create').click(); await flush();
    lobby!.el.querySelector<HTMLButtonElement>('[aria-label="Visibility"] [data-visibility="public"]')!.click(); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'configure', visibility: 'public' }, 7);
    const delay = lobby!.el.querySelector<HTMLInputElement>('[aria-label="Observer delay seconds"]')!; delay.value = '30'; delay.dispatchEvent(new Event('change')); await flush();
    expect(command).toHaveBeenLastCalledWith({ op: 'configure', observerPolicy: { minDelayMs: 30000 } }, 7);
  });
  it('offers the host "Feature on Watch live" for a public lobby only, on by default, as a revisioned configure command', async () => {
    await mount(); action('create').click(); await flush();
    expect(lobby!.el.querySelector('[data-lobby-featured]')).toBeNull();
    publish(snapshot({ revision: 8, visibility: 'public', observerPolicy: { allowOmniscient: true, minDelayMs: 180000 } }));
    const row = lobby!.el.querySelector<HTMLElement>('[data-lobby-featured]')!;
    const box = row.querySelector<HTMLInputElement>('input[aria-label="Feature on Watch live"]')!;
    expect(box.dataset.tip).toBe('Watch live may show this game to everyone, at the observer delay. Untick to keep it off.');
    expect(box.checked).toBe(true);
    box.checked = false; box.dispatchEvent(new Event('change')); await flush();
    expect(command).toHaveBeenLastCalledWith({ op: 'configure', featured: false }, 8);
    publish(snapshot({ revision: 9, visibility: 'public', featured: false, you: { memberId: 'self', observer: false, leader: false } }));
    const locked = lobby!.el.querySelector<HTMLInputElement>('[data-lobby-featured] input')!;
    expect(locked.checked).toBe(false);
    expect(locked.disabled).toBe(true);
  });
  it('offers playable registry maps as battlefield cards and adopts authored fixed seed and size', async () => {
    await mount(); action('create').click(); await flush();
    const maps = [...lobby!.el.querySelectorAll<HTMLButtonElement>('.lobby-battlefield [data-map]')].map((card) => card.dataset.map);
    expect(maps).toEqual(MAPS.filter(playableMap).map((map) => map.id));
    expect(maps).toContain('four_corners');
    const fords = MAPS.find((map) => map.id === 'twin_fords')!;
    lobby!.el.querySelector<HTMLButtonElement>('[data-map="twin_fords"]')!.click(); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'configure', mapId: 'twin_fords', layoutId: 'duel', size: 48, mapSeed: fords.mapSeed }, 7);
    publish(snapshot({ mapId: 'twin_fords', mapSeed: fords.mapSeed!, size: 48, terrain: 'rivers' }));
    expect(lobby!.el.querySelector<HTMLInputElement>('[aria-label="Public map seed"]')!.closest<HTMLElement>('.mp-seed')!.hidden).toBe(true);
    expect(lobby!.el.querySelector('[aria-label="Map size"] [data-size="80"]')!.getAttribute('aria-disabled')).toBe('true');
    expect(lobby!.el.querySelector('.pm-preview-caption')?.textContent).toContain(fords.label);
  });
  it('changes a generated map seed and size through revisioned configure commands, leader only', async () => {
    await mount(); action('create').click(); await flush();
    const seed = lobby!.el.querySelector<HTMLInputElement>('[aria-label="Public map seed"]')!; seed.value = '4294967295'; seed.dispatchEvent(new Event('change')); await flush();
    expect(command).toHaveBeenCalledWith({ op: 'configure', mapSeed: 4294967295 }, 7);
    publish(snapshot({ mapSeed: 4294967295, revision: 8 }));
    lobby!.el.querySelector<HTMLButtonElement>('[aria-label="Map size"] [data-size="80"]')!.click(); await flush();
    expect(command).toHaveBeenLastCalledWith({ op: 'configure', size: 80 }, 8);
    expect(lobby!.el.querySelector<HTMLFieldSetElement>('.lobby-battlefield')!.disabled).toBe(false);
    publish(snapshot({ revision: 9, you: { memberId: 'self', observer: false, leader: false } }));
    expect(lobby!.el.querySelector<HTMLFieldSetElement>('.lobby-battlefield')!.disabled).toBe(true);
  });
  it('keeps the battlefield picker across snapshots and never echoes a synced snapshot back', async () => {
    await mount(); action('create').click(); await flush();
    const picker = lobby!.el.querySelector('.map-picker');
    command.mockClear(); publish(snapshot({ mapSeed: 99, size: 64, revision: 8 })); await flush();
    expect(lobby!.el.querySelector('.map-picker')).toBe(picker);
    expect(command).not.toHaveBeenCalled();
    expect(lobby!.el.querySelector<HTMLInputElement>('[aria-label="Public map seed"]')!.value).toBe('99');
  });
  it('recovers from disconnect by requesting a new admission rather than reusing a socket capability', async () => {
    await mount(); action('create').click(); await flush(); disconnected(false); action('reconnect').click(); await flush(); expect(LobbySocket.pregame).toHaveBeenCalledTimes(2);
  });
  it('re-admits a pregame socket whose lobby moved to another server, without a click', async () => {
    await mount(); action('create').click(); await flush(); disconnected(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(LobbySocket.pregame).toHaveBeenCalledTimes(2);
  });
});

describe('series from Create Game', () => {
  it('keeps Series off with a tip while a human holds a seat', async () => {
    await mount(); action('create').click(); await flush();
    const series = lobby!.el.querySelector<HTMLButtonElement>('[data-series-mode="series"]')!;
    expect(series.disabled).toBe(true); expect(series.dataset.tip).toBe('Series needs agent or bot seats for now');
    expect(action('start-lobby')).not.toBeNull(); expect(action('start-series')).toBeNull();
  });
  it('launches a fully balanced series and exposes only its ID to navigation', async () => {
    const launch = vi.fn(); await mount(launch); action('create').click(); await flush(); publish(botLineup());
    lobby!.el.querySelector<HTMLButtonElement>('[data-series-mode="series"]')!.click(); await flush();
    expect(lobby!.el.querySelector('.lobby-series-count')?.textContent).toContain('20 games');
    expect(lobby!.el.querySelector('[aria-label="Speed ×"]')).not.toBeNull(); expect(lobby!.el.querySelector('[aria-label="Concurrency"]')).not.toBeNull();
    expect(action('start-lobby')).toBeNull();
    action('start-series').click(); await flush();
    expect(request('/api/lobbies/ROOM1234/series').body).toMatchObject({ revision: 7, seeds: [1,2,3,4,5,6,7,8,9,10], maps: ['open'], sideSwaps: true, concurrency: 1, retryOn: ['infrastructure'], abortOn: [], resetAgentState: true });
    expect(launch).toHaveBeenCalledWith({ seriesId: 'series-1', credential: profile.secret }); expect(location.href).not.toContain(profile.secret);
  });
  it('keeps a typed seed list across room snapshots before Start series', async () => {
    await mount(vi.fn()); action('create').click(); await flush(); publish(botLineup());
    lobby!.el.querySelector<HTMLButtonElement>('[data-series-mode="series"]')!.click(); await flush();
    const seeds = lobby!.el.querySelector<HTMLInputElement>('[aria-label="Series seed list"]')!; seeds.value = '7301'; seeds.dispatchEvent(new Event('input', { bubbles: true }));
    publish(botLineup({ revision: 8 })); await flush();
    expect(lobby!.el.querySelector<HTMLInputElement>('[aria-label="Series seed list"]')).not.toBe(seeds);
    expect(lobby!.el.querySelector<HTMLInputElement>('[aria-label="Series seed list"]')!.value).toBe('7301');
    expect(lobby!.el.querySelector('.lobby-series-count')?.textContent).toContain('2 games');
    action('start-series').click(); await flush();
    expect(request('/api/lobbies/ROOM1234/series').body).toMatchObject({ revision: 8, seeds: [7301], sideSwaps: true });
  });
  it('shows actual operator limits and rejects oversized schedules without dropping side swaps', async () => {
    vi.mocked(ProfileApi.prototype.arenaLimits).mockResolvedValue({ ...limits, maxGames: 10 }); await mount(); action('create').click(); await flush(); publish(botLineup());
    lobby!.el.querySelector<HTMLButtonElement>('[data-series-mode="series"]')!.click(); await flush();
    expect(lobby!.el.querySelector('.lobby-series-limits')?.textContent).toContain('10 games per series');
    action('start-series').click(); await flush();
    expect(lobby!.el.querySelector('.lobby-msg')?.textContent).toContain('20 games'); expect(fetcher.mock.calls.some(([path]) => path.endsWith('/series'))).toBe(false);
  });
});

describe('joining a room whose match may already be running', () => {
  async function joinWith(started: boolean): Promise<Mock> {
    const joining = vi.fn();
    vi.mocked(LobbySocket.pregame).mockImplementation(async (_admission, update, left) => { publish = update; disconnected = left; update(snapshot(started ? { phase: 'started' } : {})); return { leave: leaveSocket, command } as unknown as LobbySocket; });
    lobby = new Lobby(enter, new TerrainChoice(), undefined, undefined, joining); document.body.append(lobby.el); await flush();
    void lobby.join('ROOM1234'); await flush(); await flush();
    return joining;
  }

  it('holds the loader from the join through the hand-off into a started match', async () => {
    const joining = await joinWith(true);
    expect(joining.mock.calls[0]).toEqual([true]);
    expect(joining).not.toHaveBeenCalledWith(false);
    expect(enter).toHaveBeenCalledOnce();
  });

  it('releases the loader onto the room screen while the match has not started', async () => {
    const joining = await joinWith(false);
    expect(joining.mock.calls).toEqual([[true], [false]]);
    expect(enter).not.toHaveBeenCalled();
  });

  it('releases the loader onto the room and its message when the hand-off fails; Enter match retries', async () => {
    const initial = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path: string, init: RequestInit) => path.endsWith('/ticket') ? new Response(JSON.stringify({ error: 'lobby_not_found' }), { status: 404, headers: { 'content-type': 'application/json' } }) : initial(path, init));
    const joining = await joinWith(true);
    expect(joining.mock.calls.at(-1)).toEqual([false]);
    expect(enter).not.toHaveBeenCalled();
    expect(lobby!.el.querySelector('.lobby-msg')?.textContent).not.toBe('');
    fetcher.mockImplementation(initial);
    action('enter-match').click(); await flush();
    expect(joining.mock.calls.at(-1)).toEqual([true]);
    expect(enter).toHaveBeenCalledOnce();
  });
});
