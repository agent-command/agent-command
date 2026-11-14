/**
 * The pre-match shell, four one-viewport screens: Home (ways in), Lobby (the public games list only), Commanders
 * (connect my agents) and the game room (Create Game). Every game is one authoritative pregame room, including
 * anonymous one-click practice, so Create Game is the room from its first frame: battlefield, sides and setup.
 */
import { COLOURS, DEFAULT_TIME_CAP_TICKS, PLANES, OPPONENTS, rulesOptions, type Opponent, type Plane } from '@agent-command/game/contract';
import { MAPS, lobbyMode, type LobbyOccupant, type LobbyPhase, type LobbyReadyState, type LobbySeat, type LobbySide, type LobbySnapshot, type LobbySummary } from '@agent-command/game/lobby';
import { COLOUR_LABEL } from './armies.ts';
import type { ConnectionInfo } from '@playerthree/connect';
// The Commanders screen, the agent console and the Colyseus lobby sockets (with their PlayerThree and Colyseus libraries)
// load on first use, never before the home menu.
import type { CommandersScreen } from './commanders.ts';
import { agentButton, agentText, occupantAgent, type AgentIdentity } from './agent-button.ts';
import { COMMANDER_VALUE, commanderPicker, otherArmyTip } from './commander-picker.ts';
import { occupantSelect, slotState, wholeArmyOccupant } from './occupant-select.ts';
import { draggedCommander, rosterDock } from './roster-dock.ts';
import { ApiError } from './api.ts';
import { CallError, type MatchMode, type MatchTicket } from './net.ts';
import { copyText, h, isTextEntry, patch } from './dom.ts';
import { SettingsMenu } from './settings.ts';
import type { ConsolePanel } from '@playerthree/console';
import { CONSOLE_KEY, CONSOLE_KEY_LABEL } from './keymap.ts';
import { ProfileApi, createLobby, parseLobbyCode, profileCall, publicDirectoryAdmission, publicLobbies, type ArenaLimits, type LobbyAdmission, type LobbyCreate, type LobbyJoinOptions, type LobbyMatchTicket, type LobbyObserverTicket, type Roster, type SeriesSetup } from './profile.ts';
import { playableMap, type TerrainChoice } from './terrain-choice.ts';
import { MapPicker, paintMap } from './map-picker.ts';
import { thumbnailMaps } from './preview-client.ts';
import { PLANE_BLURB, PLANE_NAME } from './text.ts';
import logoUrl from './brand/logo.webp';
import { icon, type IconName } from './icons.ts';
import { tip } from './tooltip.ts';
import type { LobbySocket, LobbyCommand } from './lobby-net.ts';
import { createRulesEditor, type RulesEditor } from './rules-editor.ts';
import { poweredBy, socialLinks, versionTag, withSplash } from './home-flair.ts';
import { setAudioScene } from './audio/index.ts';
import './lobby.css';

/** `observe`: a player's observer pass for this match once eliminated (`POST /api/lobbies/:code/ticket {observer:true}`;
 *  409 `still_playing` until the server finalises our outcome). Absent for observers, who already watch. */
export interface LobbyChoice { ticket: MatchTicket; mode: MatchMode; label: string; observe?: () => Promise<LobbyObserverTicket> }
export interface SeriesChoice { seriesId: string; credential: string }
/** `game` is the room (Create Game); `lobby` is the public games list. */
export type LobbyRoute = 'home' | 'lobby' | 'game' | 'commanders';
const ROUTES: readonly LobbyRoute[] = ['home', 'lobby', 'game', 'commanders'];
type SetupTab = 'match' | 'rules' | 'series';
const SETUP_TABS: readonly { id: SetupTab; label: string; glyph: IconName }[] = [
  { id: 'match', label: 'Match', glyph: 'spire' }, { id: 'rules', label: 'Rules', glyph: 'settings' }, { id: 'series', label: 'Series', glyph: 'queue' },
];
const VISITOR_STORAGE_PREFIX = 'agent-command.visitor.';
const BOT_LEVEL_STORAGE_KEY = 'agent-command.practice-level';
const SERIES_SEATS_TIP = 'Series needs agent or bot seats for now';
/**
 * Re-admission attempts (the wait before each) when a pregame or directory socket's lobby moved to another server or
 * its connection broke: a cluster handover takes about a second, a crashed primary's successor up to about fifteen.
 */
const REJOIN_DELAYS_MS = [250, 1000, 3000, 6000];
export function lobbyRoute(search: string): LobbyRoute {
  const value = new URLSearchParams(search).get('screen');
  return ROUTES.find((route) => route === value) ?? 'home';
}
const ERR: Record<string, string> = {
  rate_limited: 'Too many requests. Try again shortly.', capacity: 'All match slots are busy. Try again shortly.',
  bad_request: 'The server rejected these settings.', busy: 'A match could not start right now. Try again shortly.',
  queue_full: 'The match queue is full.', queue_expired: 'Your queued request expired.', server_updating: 'Server updating. Try again shortly.',
  already_joined: 'Leave your current game first.', seat_taken: 'That seat is already claimed.', not_open: 'This game has already started.',
  unsupported_layout: 'That layout is not available.', bad_map_options: 'That map seed or size is not available for this map.', lobby_not_found: 'This game is unavailable.', forbidden: 'Release occupied seats before changing them.',
  not_ready: 'Every player and commander must be ready, with no Open seats.', absent: 'Connect the commander before starting.',
  stale_policy: 'Select a current policy version.', policy_failed: 'The policy could not start.', consent_required: 'Approve the commander in Commanders.',
  disconnected: 'Disconnected. Reconnect to recover your seats.', expired: 'This game expired.', conflict: 'The game changed. Review its current settings.',
  stale_revision: 'The game changed. Review its current settings.', visitor_not_allowed: 'Open a profile to save commanders or series results.',
  benchmark_seats_required: `${SERIES_SEATS_TIP}.`, commander_changed: 'That commander changed. Pick it again.',
  bad_colour: 'That colour is not available.', colour_taken: 'Another army already has that colour.',
  commander_other_army: 'That commander already plays another army. A commander plays one army per match.',
};
function errorText(error: unknown): string {
  const code = error instanceof ApiError || error instanceof CallError ? error.code : 'network';
  return ERR[code] ?? 'Could not complete the request. Please try again.';
}
const READY_LABEL: Record<LobbyReadyState, string> = { ready: 'Ready', online: 'Online', waiting: 'Waiting', absent: 'Offline', stale_policy: 'Stale policy', policy_failed: 'Policy failed', consent_required: 'Consent needed' };
const PHASE_LABEL: Record<LobbyPhase, string> = { waiting: 'waiting', countdown: 'starting', preparing: 'preparing', started: 'started' };
const planesTopDown = (seats: readonly LobbySeat[]): LobbySeat[] => [...seats].sort((a, b) => PLANES.indexOf(b.role) - PLANES.indexOf(a.role));
/** Unattended series run only bots and commanders (the server's `benchmark_seats_required`). */
const seriesSeats = (snapshot: LobbySnapshot): boolean => snapshot.seats.every((seat) => seat.occupant.kind === 'bot' || seat.occupant.kind === 'commander');

export class Lobby {
  readonly el: HTMLElement;
  /** Sub-screens share one frame: a header (back, title, screen tools), the body and the status line. */
  private readonly headTools = h('div', { class: 'pm-head-tools' });
  private readonly title = h('h2', { class: 'pm-title', tabindex: -1 });
  private readonly back = h('button', { type: 'button', class: 'btn pm-back', 'data-lobby-action': 'home' });
  private readonly body = h('div', { class: 'pm-body' });
  private readonly message = h('p', { class: 'lobby-msg', role: 'status', 'aria-live': 'polite' });
  private readonly frame = h('section', { class: 'pm-frame' },
    h('header', { class: 'pm-head' }, h('img', { class: 'pm-logo', src: logoUrl, alt: 'Agent Command', width: 960, height: 402 }), this.back, this.title, this.headTools),
    this.body, h('footer', { class: 'pm-foot' }));
  /** The room renders in parts so the battlefield picker, tabs and seed typing survive snapshot re-renders. */
  private readonly roomHead = h('div', { class: 'lobby-room-head' });
  private readonly roomPreview = h('canvas', { class: 'pm-preview-map', width: 1, height: 1, 'aria-hidden': 'true' });
  private readonly roomCaption = h('figcaption', { class: 'pm-preview-caption' });
  private readonly roomMap = h('fieldset', { class: 'lobby-battlefield' }, h('legend', { class: 'pm-col-title' }, icon('map'), 'Battlefield'));
  private readonly sides = h('div', { class: 'pm-sides' });
  private readonly people = h('div', { class: 'pm-people' });
  private readonly dock = h('div', { class: 'pm-dock', 'aria-label': 'Commanders dock' });
  private readonly tabs = h('div', { class: 'pm-tabs', role: 'tablist', 'aria-label': 'Game setup' });
  private readonly panels: Record<SetupTab, HTMLElement> = {
    match: h('div', { class: 'pm-panel', role: 'tabpanel', id: 'pm-panel-match', 'aria-label': 'Match' }),
    rules: h('div', { class: 'pm-panel', role: 'tabpanel', id: 'pm-panel-rules', 'aria-label': 'Rules' }),
    series: h('div', { class: 'pm-panel', role: 'tabpanel', id: 'pm-panel-series', 'aria-label': 'Series' }),
  };
  private readonly startBar = h('div', { class: 'pm-start' });
  private readonly roomPane = h('div', { class: 'pm-room lobby-room', 'aria-label': 'Game room' },
    h('section', { class: 'pm-col pm-field', 'aria-label': 'Battlefield' }, h('figure', { class: 'pm-preview', role: 'button', tabindex: 0, 'aria-label': 'View the battlefield', 'data-tip': 'View the battlefield full screen (Esc returns)', onclick: () => this.peek(true), onkeydown: (event: Event) => { const key = (event as KeyboardEvent).key; if (key === 'Enter' || key === ' ') { event.preventDefault(); this.peek(true); } } }, this.roomPreview, this.roomCaption, h('span', { class: 'pm-preview-peek', 'aria-hidden': 'true' }, icon('spectate', 18))), this.roomMap),
    h('section', { class: 'pm-col pm-armies', 'aria-label': 'Sides' }, this.sides, this.people, this.dock),
    h('section', { class: 'pm-col pm-setup', 'aria-label': 'Setup' }, this.tabs, this.panels.match, this.panels.rules, this.panels.series, this.startBar));
  private mapPicker: MapPicker | undefined;
  /** Hides the whole setup frame so the live backdrop (the chosen battlefield) shows unobstructed. */
  private readonly peekExit = h('button', { type: 'button', class: 'btn primary pm-peek-exit', 'data-tip': 'Back to setup (Esc)', onclick: () => this.peek(false) }, icon('settings'), 'Back to setup');
  private previewKey = '';
  /** True while the shared map selection is being set from a snapshot, so it is not echoed back as a command. */
  private syncingTerrain = false;
  private readonly browsePane = h('div', { class: 'pm-games', 'aria-label': 'Public games' });
  private readonly filterInput = h('input', { type: 'search', class: 'pm-filter', placeholder: 'Filter', 'aria-label': 'Filter games', autocomplete: 'off', spellcheck: false });
  private readonly openOnly = h('input', { type: 'checkbox', 'aria-label': 'Open seats only' });
  private readonly joinInput = h('input', { id: 'lobby-join-code', type: 'text', required: true, placeholder: 'Code or #l= link', autocomplete: 'off', spellcheck: false });
  private readonly commanderPane = h('div', { class: 'pm-commanders', 'aria-label': 'My commanders' });
  private readonly settings = new SettingsMenu({ up: false });
  private readonly onEnter: (choice: LobbyChoice) => void;
  private readonly onSeries: ((choice: SeriesChoice) => void) | undefined;
  private readonly onWatch: (() => void) | undefined;
  private readonly onJoining: ((joining: boolean) => void) | undefined;
  private readonly terrain: TerrainChoice;
  /** Per army: the user's chosen seat mode (true = each plane separately). Unset follows the seats: mixed means per plane. */
  private readonly perPlane = new Map<string, boolean>();
  private readonly cleanups: (() => void)[] = [];
  private route: LobbyRoute = 'home';
  private setupTab: SetupTab = 'match';
  private rulesEditor: RulesEditor | undefined;
  private screen: CommandersScreen | undefined;
  private agentConsole: ConsolePanel | undefined;
  private api: ProfileApi | undefined;
  private roster: Roster | undefined;
  private connections: readonly ConnectionInfo[] | undefined;
  private profileLoading: Promise<void>;
  private profileOpening: Promise<ProfileApi> | undefined;
  private visitorAdoption: Promise<void> | undefined;
  private profileError: unknown;
  private directory: LobbySummary[] = [];
  private directorySocket: LobbySocket | undefined;
  private directoryStatus = 'connecting';
  private directoryGeneration = 0;
  private roomSocket: LobbySocket | undefined;
  private roomStatus = 'connecting';
  private roomGeneration = 0;
  private snapshot: LobbySnapshot | undefined;
  private code: string | undefined;
  private visitorToken: string | undefined;
  private busy = false;
  private stopped = false;
  private handingOff = false;
  /** Series (N games through PlayerThree) instead of a single game; only effective with bot/commander seats. */
  private seriesMode = false;
  /** Commander picked in the dock for click/keyboard placement (the drag alternative), and the one being dragged. */
  private picked: string | undefined;
  private dragging: string | undefined;
  private timer: number | undefined;
  private countdown: number | undefined;
  private botLevel: Opponent = 'standard';
  private limits: ArenaLimits | undefined;
  private limitsLoading = false;
  private limitsError: string | undefined;
  private series: Omit<SeriesSetup, 'revision'> = {
    seeds: Array.from({ length: 10 }, (_, index) => index + 1), maps: [], sideSwaps: true,
    speed: 1, concurrency: 1, maxTicks: DEFAULT_TIME_CAP_TICKS, maxWallMs: 1800000, retries: 1, retryOn: ['infrastructure'], abortOn: [], schedule: 'paired', resetAgentState: true,
  };
  /** The seed text as typed: room snapshots and roster polls re-render the Series panel before Start series. */
  private seedText = this.series.seeds.join(', ');
  /** `onJoining`: true while joining a room or entering its started match (play.ts shows the loader), false once the
   *  room screen is what shows. */
  constructor(onEnter: (choice: LobbyChoice) => void, terrain: TerrainChoice, onSeries?: (choice: SeriesChoice) => void, onWatch?: () => void, onJoining?: (joining: boolean) => void) {
    this.onEnter = onEnter; this.terrain = terrain; this.onSeries = onSeries; this.onWatch = onWatch; this.onJoining = onJoining;
    try { const savedLevel = localStorage.getItem(BOT_LEVEL_STORAGE_KEY); if (OPPONENTS.some((level) => level === savedLevel)) this.botLevel = savedLevel as Opponent; } catch { /* The default level still permits anonymous play. */ }
    this.el = h('div', { class: 'lobby lobby-toon prematch' });
    this.back.addEventListener('click', () => this.show(this.route === 'commanders' && this.code ? 'game' : 'home'));
    this.tabs.replaceChildren(...SETUP_TABS.map((tab) => h('button', { type: 'button', role: 'tab', class: 'pm-tab', id: `pm-tab-${tab.id}`, 'data-setup-tab': tab.id, 'aria-controls': `pm-panel-${tab.id}`, onclick: () => this.pickTab(tab.id), onkeydown: (event: Event) => this.tabKey(event as KeyboardEvent) }, icon(tab.glyph, 16), h('span', {}, tab.label))));
    this.pickTab('match');
    this.filterInput.addEventListener('input', () => this.renderBrowse());
    this.openOnly.addEventListener('change', () => this.renderBrowse());
    this.wireDrops();
    this.profileLoading = this.loadProfile().catch((error) => {
      if (error instanceof ApiError && error.code === 'bad_profile') { ProfileApi.retire(); return; }
      this.profileError = error; this.commanderPane.replaceChildren(h('p', { role: 'alert' }, 'Saved profile unavailable. Its credentials have not been replaced.'));
    });
    this.show(lobbyRoute(location.search), false);
    const pop = () => this.show(lobbyRoute(location.search), false);
    window.addEventListener('popstate', pop); this.cleanups.push(() => window.removeEventListener('popstate', pop));
    const keys = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || isTextEntry(event.target)) return;
      if (event.key === 'Escape' && this.el.classList.contains('pm-peek')) { event.preventDefault(); this.peek(false); return; }
      if (event.key === 'Escape' && this.picked) { event.preventDefault(); this.pick(undefined); return; }
      if (event.code !== CONSOLE_KEY || this.route !== 'commanders') return;
      event.preventDefault(); this.agentConsole?.toggle();
    };
    window.addEventListener('keydown', keys); this.cleanups.push(() => window.removeEventListener('keydown', keys));
    this.cleanups.push(terrain.onChange(() => { this.terrainPicked(); this.renderPreview(); }));
  }
  private button(label: string, glyph: IconName, action: string, click: () => void, primary = false): HTMLButtonElement {
    return h('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, 'data-lobby-action': action, 'data-tip': label, onclick: click }, icon(glyph), label);
  }
  private peek(on: boolean): void {
    this.el.classList.toggle('pm-peek', on);
    if (on) this.peekExit.focus(); else this.roomPane.querySelector<HTMLElement>('.pm-preview')?.focus();
  }
  private show(route: LobbyRoute, navigate = true): void {
    if (route === 'game' && !this.code) route = 'home';
    this.el.classList.remove('pm-peek');
    if (route !== 'commanders') this.agentConsole?.close();
    if (navigate) { const url = new URL(location.href); if (route === 'home') url.searchParams.delete('screen'); else url.searchParams.set('screen', route); history.pushState(null, '', url); }
    this.route = route;
    this.el.dataset.lobbyRoute = route;
    // The public games list connects when first shown: Home never opens the directory socket.
    if (route === 'lobby' && !this.directoryGeneration) void this.connectDirectory();
    // the public games list and the Create Game room have their own music; Home and Commanders keep the home themes
    setAudioScene(route === 'lobby' || route === 'game' ? 'lobby' : 'home');
    if (route === 'home') { this.el.replaceChildren(this.home()); this.focusFirst(navigate); return; }
    const backToGame = route === 'commanders' && !!this.code;
    this.back.replaceChildren(icon(backToGame ? 'gamepad' : 'home'), backToGame ? 'Back to game' : 'Home');
    this.back.dataset.lobbyAction = backToGame ? 'return-game' : 'home';
    this.back.setAttribute('data-tip', backToGame ? 'Back to the game room' : 'Home');
    if (route === 'commanders') {
      this.title.replaceChildren(icon('commanders'), 'Commanders');
      this.headTools.replaceChildren(this.button(`Agent console (${CONSOLE_KEY_LABEL})`, 'console', 'agent-console', () => this.agentConsole?.toggle()), this.settings.el);
      if (!this.api) this.commanderPane.replaceChildren(h('p', { class: 'pm-empty' }, 'Opening your commanders…'));
      void this.ensureProfile().catch((error) => { this.message.textContent = errorText(error); });
      this.body.replaceChildren(this.commanderPane);
    } else if (route === 'game') {
      this.title.replaceChildren(icon('create_game'), 'Create Game');
      this.headTools.replaceChildren(this.roomHead, this.settings.el);
      this.syncTerrain(); this.renderPreview(); this.renderRoom(); this.body.replaceChildren(this.roomPane);
    } else {
      this.title.replaceChildren(icon('browse'), 'Lobby');
      this.headTools.replaceChildren(this.browseTools(), this.settings.el);
      this.renderBrowse(); this.body.replaceChildren(this.browsePane);
    }
    this.frame.querySelector('.pm-foot')!.replaceChildren(this.message);
    this.el.replaceChildren(this.frame, this.peekExit);
    this.focusFirst(navigate);
  }
  private focusFirst(navigate: boolean): void {
    if (!navigate) return;
    const target = this.route === 'home' ? this.el.querySelector<HTMLElement>('.lobby-actions button') : this.title;
    target?.focus();
  }
  private home(): HTMLElement {
    const tile = (label: string, detail: string, glyph: IconName, action: string, click: () => void, primary = false) =>
      h('button', { type: 'button', class: `btn pm-tile${primary ? ' primary' : ''}`, 'data-lobby-action': action, 'data-tip': `${label} · ${detail}`, onclick: click },
        icon(glyph, primary ? 26 : 22), h('span', { class: 'pm-tile-text' }, h('b', {}, label), h('small', {}, detail)));
    // The badges hang off the card's outer edge, so they sit beside the card: its own scroll box would clip them. The
    // PlayerThree credit is fixed to the screen's bottom-left corner, outside the card.
    return h('div', { class: 'pm-home-shell' }, h('section', { class: 'lobby-inner pm-home', 'aria-label': 'Agent Command' },
      h('div', { class: 'pm-home-corner' }, this.settings.el),
      h('div', { class: 'hero' }, withSplash(h('h1', {}, h('img', { class: 'hero-logo', src: logoUrl, alt: 'Agent Command', width: 960, height: 402 })))),
      ...(this.code ? [h('button', { type: 'button', class: 'btn pm-resume', 'data-lobby-action': 'resume', 'data-tip': 'Back to your open game room', onclick: () => this.show('game') }, icon('gamepad'), 'Back to game', h('code', {}, this.code))] : []),
      h('div', { class: 'lobby-actions' },
        tile('Quick Play', 'You vs Agents or Bots', 'bot', 'play', () => void this.create('play'), true),
        tile('Create Game', 'Map, slots, rules, series', 'create_game', 'create', () => void this.create('host')),
        tile('Lobby', 'Public games', 'browse', 'lobby', () => this.show('lobby')),
        tile('Commanders', 'Connect your agents', 'commanders', 'commanders', () => this.show('commanders')),
        ...(this.onWatch ? [tile('Watch live', 'Featured match', 'spectate', 'watch', () => this.onWatch?.())] : [])),
      h('a', { class: 'btn pm-benchmarks', href: '/benchmarks/', 'data-tip': 'ACBench · published policy scores and how they are measured' },
        icon('chart', 20), h('b', {}, 'Latest Benchmarks')),
      h('div', { class: 'lobby-plane-strip', 'aria-label': 'Four planes' }, ...[...PLANES].reverse().map((plane) => h('span', { tabindex: 0, 'data-tip': PLANE_BLURB[plane] }, icon(plane), PLANE_NAME[plane]))),
      h('section', { class: 'home-about', 'aria-label': 'About the game' },
        h('p', {}, 'A 3D RTS on four stacked planes. Your AI agents or bots command the planes you aren\'t watching.'),
        h('details', {}, h('summary', {}, 'About Agent Command'),
          h('p', {}, 'The planes are Surface, Depths, Sky and Orbit. They share one economy, and each army defends one Spire. You can play bots, join multiplayer games or connect your own AI agents in Commanders.'),
          h('p', {}, 'Watch live shows a featured match. Create Game also runs series. You need JavaScript and a browser with WebGL2.'))),
      this.message,
      h('details', { class: 'lobby-key-help' }, h('summary', { 'data-tip': 'Native controls support Tab, Enter, Space and arrow keys' }, icon('keyboard'), 'Controls'), h('p', { class: 'small muted' }, 'Tab focuses controls · Enter selects · arrows change dropdowns · F1–F4 switch planes in game.'))),
      socialLinks(), poweredBy(), versionTag());
  }
  private async loadProfile(create = false): Promise<void> {
    const stored = create ? undefined : ProfileApi.stored();
    if (!stored && !create) return;
    const ui = Promise.all([import('./commanders.ts'), import('./agent-console.ts')]);
    const { api, roster } = create ? await ProfileApi.open() : { api: stored!, roster: await stored!.roster() };
    const connections = await api.connections().catch(() => undefined);
    const [{ CommandersScreen }, { mountAgentConsole }] = await ui;
    if (this.stopped) return;
    this.api = api; this.roster = roster; this.connections = connections;
    this.screen?.dispose();
    this.screen = new CommandersScreen(api, roster, (next) => { this.roster = next; this.renderRoom(); }, this.terrain, connections);
    this.agentConsole?.destroy();
    this.agentConsole = mountAgentConsole({ credential: () => api.profile.secret, mount: this.el, key: false, resolveApproval: async (target, id, approve) => {
      if (target.kind !== 'commander') throw new ApiError('forbidden');
      const next = await api.resolveApproval(target.commander, id, approve);
      this.roster = next; this.screen?.update(next); this.renderRoom();
    } });
    this.commanderPane.replaceChildren(this.screen.el);
    this.renderRoom();
    this.schedulePoll();
  }
  private async ensureProfile(): Promise<ProfileApi> {
    await this.profileLoading;
    if (this.profileError) throw this.profileError;
    const api = this.api ?? await (this.profileOpening ??= this.loadProfile(true).then(() => { if (!this.api) throw new ApiError('no_profile'); return this.api; }).finally(() => { this.profileOpening = undefined; }));
    if (this.visitorToken && this.code && this.snapshot && this.snapshot.phase !== 'started') {
      if (!this.visitorAdoption) {
        const code = this.code;
        const visitorToken = this.visitorToken;
        const revision = this.snapshot.revision;
        this.visitorAdoption = api.claimLobby(code, visitorToken, revision).then(async () => {
          this.visitorToken = undefined;
          try { sessionStorage.removeItem(`${VISITOR_STORAGE_PREFIX}${code}`); } catch { /* In-memory admission still revokes the visitor capability. */ }
          await this.connectRoom(code, false);
        }).finally(() => { this.visitorAdoption = undefined; });
      }
      await this.visitorAdoption;
    }
    return api;
  }
  /** Roster and harness connections refresh together: the dock's online dots come from both. */
  private schedulePoll(): void {
    window.clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = window.setTimeout(async () => {
      try {
        if (this.api) {
          const [roster, connections] = await Promise.all([this.api.roster(), this.api.connections().catch(() => this.connections)]);
          if (!this.stopped) { this.roster = roster; this.connections = connections; this.screen?.update(roster, connections); this.renderRoom(); }
        }
      } catch { /* Preserve the last owner-private connection status through transient failures. */ }
      if (!this.stopped) this.schedulePoll();
    }, 2000);
  }
  /** Quick Play and Create Game both open a fresh room; an open room is left first (one room per member). */
  private create(preset: Extract<LobbyCreate['preset'], 'play' | 'host'>, visibility: LobbyCreate['visibility'] = 'private'): Promise<void> {
    return this.run(async () => {
      this.seriesMode = false; this.setupTab = 'match'; this.picked = undefined; this.perPlane.clear();
      if (preset === 'host') await this.ensureProfile(); else await this.profileLoading;
      if (this.code) await this.release();
      await this.terrain.ready;
      const selectedMap = this.terrain.getMap();
      const map = MAPS.find((entry) => entry.id === selectedMap.mapId);
      const layout = map?.layouts.find((entry) => entry.supported);
      if (!map || !layout) throw new ApiError('unsupported_layout');
      const setup: LobbyCreate = { ...selectedMap, mapId: map.id, layoutId: layout.id, visibility, preset, ...(preset === 'play' ? { botLevel: this.botLevel } : {}) };
      const address = await (this.api ? this.api.createLobby(setup) : createLobby(setup));
      this.visitorToken = address.visitorToken;
      if (address.visitorToken) {
        try { sessionStorage.setItem(`${VISITOR_STORAGE_PREFIX}${address.code}`, address.visitorToken); } catch { /* This tab retains its in-memory capability. */ }
      }
      this.series.maps = [map.id];
      await this.connectRoom(address.code);
    });
  }
  /** Join a room by code. Its match may already be running, so the loader shows until the room settles: the room
   *  screen (still waiting, or a failure with its message), or the match's first frame via the hand-off. */
  join(code: string, options?: LobbyJoinOptions): Promise<void> {
    this.onJoining?.(true);
    return this.run(async () => {
      let visitorToken: string | null = null;
      try { visitorToken = sessionStorage.getItem(`${VISITOR_STORAGE_PREFIX}${code}`); } catch { /* Browser storage may be unavailable. */ }
      this.seriesMode = false; this.setupTab = 'match'; this.picked = undefined; this.perPlane.clear();
      if (visitorToken) { this.visitorToken = visitorToken; await this.connectRoom(code); return; }
      const api = await this.ensureProfile(); this.visitorToken = undefined;
      const address = await api.joinLobby(code, options); await this.connectRoom(address.code);
    }).finally(() => { if (!this.stopped && !this.handingOff) this.onJoining?.(false); });
  }
  private auth(): { secret?: string; visitorToken?: string } { return this.visitorToken ? { visitorToken: this.visitorToken } : this.api ? { secret: this.api.profile.secret } : {}; }
  private async connectRoom(code: string, display = true): Promise<void> {
    await this.terrain.ready;
    if (this.stopped) return;
    const generation = ++this.roomGeneration;
    this.roomSocket?.leave(); this.roomSocket = undefined; this.roomStatus = 'connecting'; this.handingOff = false;
    if (this.code !== code) this.snapshot = undefined;
    this.code = code;
    const url = new URL(location.href); url.hash = `l=${encodeURIComponent(code)}`; history.replaceState(null, '', url);
    if (display) this.show('game');
    try {
      const [admission, { LobbySocket }] = await Promise.all([profileCall<LobbyAdmission>(`/api/lobbies/${encodeURIComponent(code)}/connect`, { body: {}, ...this.auth() }), import('./lobby-net.ts')]);
      const socket = await LobbySocket.pregame(admission, (snapshot) => {
        if (this.stopped || generation !== this.roomGeneration) return;
        if (!this.snapshot && snapshot.purpose === 'benchmark') { this.seriesMode = true; this.setupTab = 'series'; this.pickTab('series'); }
        this.snapshot = snapshot;
        this.syncTerrain();
        this.renderRoom();
        if (snapshot.phase === 'started') void this.handoff();
      }, (rejoin) => {
        if (this.stopped || generation !== this.roomGeneration) return;
        this.roomStatus = 'disconnected'; this.renderRoom();
        if (rejoin) void this.rejoinRoom(code);
      });
      if (this.stopped || generation !== this.roomGeneration) return socket.leave();
      this.roomSocket = socket; this.roomStatus = 'live';
      window.clearInterval(this.countdown); this.countdown = window.setInterval(() => this.updateCountdown(), 250);
      this.renderRoom();
      if (this.seriesMode) void this.loadSeriesLimits().catch(() => {});
    } catch (error) { if (generation === this.roomGeneration) { this.roomStatus = 'disconnected'; this.renderRoom(); } throw error; }
  }
  /** The lobby moved to another server (or its connection broke): re-admit a few times before offering Reconnect. */
  private async rejoinRoom(code: string): Promise<void> {
    for (const delayMs of REJOIN_DELAYS_MS) {
      const waited = Promise.withResolvers<void>();
      window.setTimeout(waited.resolve, delayMs);
      await waited.promise;
      if (this.stopped || this.code !== code || this.roomStatus !== 'disconnected') return;
      try { await this.connectRoom(code, false); return; } catch { /* Shown as disconnected; the next attempt follows. */ }
    }
  }
  private async rejoinDirectory(): Promise<void> {
    for (const delayMs of REJOIN_DELAYS_MS) {
      const waited = Promise.withResolvers<void>();
      window.setTimeout(waited.resolve, delayMs);
      await waited.promise;
      if (this.stopped || this.directoryStatus !== 'disconnected') return;
      await this.connectDirectory();
    }
  }
  private async connectDirectory(): Promise<void> {
    const generation = ++this.directoryGeneration;
    this.directorySocket?.leave(); this.directoryStatus = 'connecting';
    try {
      const [initial, { LobbySocket }] = await Promise.all([publicLobbies(), import('./lobby-net.ts')]);
      if (this.stopped || generation !== this.directoryGeneration) return;
      this.directory = initial.lobbies;
      const socket = await LobbySocket.directory(await publicDirectoryAdmission(), (lobbies) => { if (!this.stopped && generation === this.directoryGeneration) { this.directory = lobbies; this.renderBrowse(); } }, (rejoin) => {
        if (this.stopped || generation !== this.directoryGeneration) return;
        this.directoryStatus = 'disconnected'; this.renderBrowse();
        if (rejoin) void this.rejoinDirectory();
      });
      if (this.stopped || generation !== this.directoryGeneration) return socket.leave();
      this.directorySocket = socket; this.directoryStatus = 'live';
    } catch { if (!this.stopped && generation === this.directoryGeneration) this.directoryStatus = 'disconnected'; }
    this.renderBrowse();
  }
  /** Lobby header: a filter over the public list, plus joining a private game by its code. */
  private browseTools(): HTMLElement {
    return h('div', { class: 'pm-browse-tools' },
      this.filterInput,
      h('label', { class: 'pm-check', 'data-tip': 'Only games with an Open seat' }, this.openOnly, 'Open seats'),
      h('form', { class: 'lobby-join-form', onsubmit: (event: Event) => {
        event.preventDefault(); const code = parseLobbyCode(this.joinInput.value);
        if (code) void this.join(code); else { this.message.textContent = 'Paste a valid game code or link.'; this.joinInput.focus(); }
      } }, h('label', { for: this.joinInput.id }, 'Join by code'), this.joinInput, h('button', { class: 'btn', type: 'submit', 'data-tip': 'Join a private game by its credential-free code' }, icon('invite'), 'Join')));
  }
  private renderBrowse(): void {
    const filter = this.filterInput.value.trim().toLowerCase();
    patch(this.browsePane, JSON.stringify([this.directory, this.directoryStatus, filter, this.openOnly.checked, this.roster?.commanders.length]), () => {
      const rooms = this.directory.filter((room) => room.visibility === 'public')
        .filter((room) => !this.openOnly.checked || room.seats.some((seat) => seat.occupant.kind === 'open'))
        .filter((room) => !filter || [room.code, MAPS.find((map) => map.id === room.mapId)?.label ?? room.mapId, lobbyMode(room.mapId, room.layoutId)?.label ?? room.mode].join(' ').toLowerCase().includes(filter));
      const total = this.directory.filter((room) => room.visibility === 'public').length;
      return [
        h('div', { class: 'pm-games-status', role: 'status' },
          h('i', { class: `pm-dot ${this.directoryStatus}`, 'aria-hidden': 'true' }),
          this.directoryStatus === 'live' ? `${total} public ${total === 1 ? 'game' : 'games'}` : this.directoryStatus === 'connecting' ? 'Connecting…' : 'Directory disconnected',
          ...(this.directoryStatus === 'disconnected' ? [this.button('Reconnect', 'queue', 'reconnect-directory', () => void this.connectDirectory())] : [])),
        h('div', { class: 'pm-games-head', 'aria-hidden': 'true' }, h('span', {}, 'Battlefield'), h('span', {}, 'Sides'), h('span', {}, 'Room'), h('span', {})),
        h('div', { class: 'pm-games-list' },
          ...rooms.map((room) => this.gameRow(room)),
          ...(!rooms.length ? [h('div', { class: 'lobby-empty' }, h('p', {}, total ? 'No game matches the filter.' : 'No public games right now.'), this.button('Create Game', 'invite', 'create', () => void this.create('host', 'public'), true))] : [])),
      ];
    });
  }
  private gameRow(room: LobbySummary): HTMLElement {
    const open = room.seats.filter((seat) => seat.occupant.kind === 'open').length;
    return h('article', { class: 'match-card', 'data-match-card': room.code },
      h('div', { class: 'match-card-map' },
        h('b', {}, MAPS.find((map) => map.id === room.mapId)?.label ?? room.mapId),
        h('span', { class: 'match-card-detail' }, `${room.size} × ${room.size} · seed ${room.mapSeed} · ${lobbyMode(room.mapId, room.layoutId)?.label ?? room.mode}`)),
      h('div', { class: 'match-card-roster' }, ...room.sides.flatMap((side, index) => [
        ...(index ? [h('span', { class: 'pm-vs', 'aria-hidden': 'true' }, 'vs')] : []),
        h('section', { class: 'match-card-side', 'data-side': side.id, 'data-colour': side.alliance, 'aria-label': `${COLOUR_LABEL[side.alliance]} · ${side.label}` }, ...this.sideSummary(room.seats.filter((seat) => seat.team === side.id)))])),
      h('div', { class: 'match-card-meta' },
        h('span', {}, icon('human', 14), `${room.members}`),
        h('span', { class: open ? 'open' : '' }, `${open} open`),
        h('span', { 'data-tip': room.observerPolicy.allowOmniscient ? 'Observers: all or side perspective' : 'Observers: side perspective' }, icon('spectate', 14), `${Math.ceil(room.observerPolicy.minDelayMs / 1000)} s`),
        h('code', { class: 'match-card-code' }, room.code)),
      h('div', { class: 'match-card-actions' },
        this.button('Join', 'human', `join-${room.code}`, () => void this.join(room.code), open > 0),
        this.button('Observe', 'spectate', `observe-${room.code}`, () => void this.join(room.code, { observer: true }))));
  }
  /** One chip for a uniform army, else one small chip per plane seat (top plane first). */
  private sideSummary(seats: readonly LobbySeat[]): HTMLElement[] {
    const common = wholeArmyOccupant(seats);
    if (common) return [agentButton(this.agent(common, seats[0], undefined), { size: 'small' })];
    return planesTopDown(seats).map((seat) => h('span', { class: 'match-card-seat', 'data-tip': PLANE_NAME[seat.role] }, icon(seat.role, 14), agentButton(this.agent(seat.occupant, seat, undefined), { size: 'small' })));
  }
  /** Seats outside my current room (directory rows) have no member context: humans stay anonymous there. */
  private agent(occupant: LobbyOccupant, seat: LobbySeat | undefined, snapshot: LobbySnapshot | undefined): AgentIdentity {
    return occupantAgent(occupant, { you: snapshot?.you.memberId ?? '', members: snapshot?.players ?? [], roster: this.roster?.commanders, card: seat?.card, ready: seat?.ready });
  }
  private canEdit(seat: LobbySeat, snapshot: LobbySnapshot): boolean {
    if (this.roomStatus !== 'live' || snapshot.phase !== 'waiting') return false;
    const occupant = seat.occupant;
    if (occupant.kind === 'human') return occupant.memberId === snapshot.you.memberId;
    if (occupant.kind === 'commander') return !!occupant.ref;
    return snapshot.you.leader || occupant.kind === 'open';
  }
  /** Non-leaders may only claim open slots for themselves; everyone else may seat a commander where they can edit. */
  private claimOnly(snapshot: LobbySnapshot, seats: readonly LobbySeat[]): boolean { return !snapshot.you.leader && seats.every((seat) => seat.occupant.kind === 'open'); }
  private placeable(snapshot: LobbySnapshot, seats: readonly LobbySeat[]): boolean { return seats.every((seat) => this.canEdit(seat, snapshot)) && !this.claimOnly(snapshot, seats); }
  /** My commanders seated on an army other than `team` (id → that army's label): one commander plays one army. */
  private otherArmy(snapshot: LobbySnapshot, team: string): Map<string, string> {
    const armies = new Map<string, string>();
    for (const seat of snapshot.seats) if (seat.team !== team && seat.occupant.kind === 'commander' && seat.occupant.ref) armies.set(seat.occupant.ref.id, snapshot.sides.find((side) => side.id === seat.team)?.label ?? seat.team);
    return armies;
  }
  private occupantEditor(snapshot: LobbySnapshot, team: string, seats: LobbySeat[], current: LobbyOccupant | undefined, label: string, claim: string): HTMLElement {
    const roles = seats.map((seat) => seat.role);
    return occupantSelect({
      team, roles, label, current, currentText: current ? agentText(this.agent(current, seats[0], snapshot)) : '',
      you: snapshot.you.memberId, roster: this.roster?.commanders, otherArmy: this.otherArmy(snapshot, team),
      disabled: seats.some((seat) => !this.canEdit(seat, snapshot)),
      claimOnly: this.claimOnly(snapshot, seats),
      claim,
      assign: (occupant) => void this.command({ op: 'assign', team, roles, occupant }),
      botLevel: (level) => {
        this.botLevel = level;
        try { localStorage.setItem(BOT_LEVEL_STORAGE_KEY, level); } catch { /* This tab still remembers its selected practice level. */ }
      },
    });
  }
  /** A slot (whole army or one plane seat) as a commander drop target, with the picked-commander "Place" alternative. */
  private slot(snapshot: LobbySnapshot, team: string, seats: LobbySeat[], className: string, ...children: (HTMLElement | null)[]): HTMLElement {
    const roles = seats.map((seat) => seat.role);
    const el = h('div', { class: className, 'data-slot-state': slotState(seats.map((seat) => seat.occupant)), ...(seats.length === 1 ? { 'data-seat': `${team}:${seats[0]!.role}` } : {}) }, ...children);
    if (!this.placeable(snapshot, seats)) return el;
    el.dataset.dropTeam = team; el.dataset.dropRoles = roles.join(',');
    const picked = this.picked ? this.roster?.commanders.find((commander) => commander.id === this.picked) : undefined;
    if (picked && roles.every((role) => picked.roles.includes(role)) && !this.otherArmy(snapshot, team).has(picked.id)) {
      el.append(h('button', { type: 'button', class: 'btn small pm-place', 'data-place': `${team}:${roles.join(',')}`, 'data-tip': `Seat ${picked.name} here`, onclick: () => this.place(picked.id, team, roles) }, icon('commanders', 16), `Place ${picked.name}`));
    }
    return el;
  }
  private place(id: string, team: string, roles: readonly Plane[]): void {
    const commander = this.roster?.commanders.find((entry) => entry.id === id);
    const army = this.snapshot ? this.otherArmy(this.snapshot, team).get(id) : undefined;
    const ref = commanderPicker(this.roster?.commanders, roles, undefined, false).ref(`${COMMANDER_VALUE}${id}`);
    this.pick(undefined);
    if (commander && army !== undefined) { this.message.textContent = otherArmyTip(commander.name, army); return; }
    if (!commander || !ref) { this.message.textContent = `${commander?.name ?? 'That commander'} can't command ${roles.map((role) => PLANE_NAME[role]).join(', ')}.`; return; }
    void this.command({ op: 'assign', team, roles: [...roles], occupant: { kind: 'commander', ref } });
  }
  private pick(id: string | undefined): void {
    if (this.picked === id) return;
    this.picked = id; this.renderRoom();
  }
  /** Drag from the dock: compatible editable slots light up, incompatible ones dim; a drop is one atomic assign. */
  private wireDrops(): void {
    const fits = (slot: HTMLElement, id: string | undefined): boolean => {
      const commander = id ? this.roster?.commanders.find((entry) => entry.id === id) : undefined;
      return !!commander && (slot.dataset.dropRoles ?? '').split(',').every((role) => commander.roles.includes(role as Plane)) &&
        !(this.snapshot && this.otherArmy(this.snapshot, slot.dataset.dropTeam ?? '').has(commander.id));
    };
    const mark = (id: string | undefined) => {
      for (const slot of this.sides.querySelectorAll<HTMLElement>('[data-drop-roles]')) {
        if (id) slot.dataset.drop = fits(slot, id) ? 'ok' : 'no'; else { delete slot.dataset.drop; slot.classList.remove('drop-over'); }
      }
    };
    const target = (event: DragEvent): HTMLElement | undefined => {
      const slot = (event.target as Element | null)?.closest?.<HTMLElement>('[data-drop-roles]');
      return slot && fits(slot, this.dragging) ? slot : undefined;
    };
    this.dock.addEventListener('dragstart', (event) => {
      this.dragging = (event.target as Element | null)?.closest?.<HTMLElement>('[data-commander-id]')?.dataset.commanderId;
      mark(this.dragging);
    });
    this.dock.addEventListener('dragend', () => { this.dragging = undefined; mark(undefined); });
    this.sides.addEventListener('dragover', (event) => {
      const slot = target(event); if (!slot) return;
      event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'link'; slot.classList.add('drop-over');
    });
    this.sides.addEventListener('dragleave', (event) => {
      const slot = (event.target as Element | null)?.closest?.<HTMLElement>('[data-drop-roles]');
      if (slot && !slot.contains(event.relatedTarget as Node | null)) slot.classList.remove('drop-over');
    });
    this.sides.addEventListener('drop', (event) => {
      const slot = target(event); if (!slot) return;
      event.preventDefault();
      const id = draggedCommander(event) ?? this.dragging;
      this.dragging = undefined; mark(undefined);
      if (id) this.place(id, slot.dataset.dropTeam!, slot.dataset.dropRoles!.split(',') as Plane[]);
    });
  }
  private member(member: LobbySnapshot['players'][number], status: string): HTMLElement {
    return agentButton({ kind: 'human', name: member.label, detail: status, status: member.connected ? 'online' : 'offline' }, { size: 'small' });
  }
  /** The shared map selection mirrors the room; the backdrop previews whatever the room plays. */
  private syncTerrain(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.syncingTerrain = true;
    try { this.terrain.set(snapshot.mapId); this.terrain.setSeed(snapshot.mapSeed); this.terrain.setSize(snapshot.size); }
    finally { this.syncingTerrain = false; }
  }
  /** The leader's battlefield picker edits the room; elsewhere (Commanders practice) the selection stays local. */
  private terrainPicked(): void {
    const snapshot = this.snapshot;
    if (this.syncingTerrain || !snapshot || this.route !== 'game' || this.roomStatus !== 'live' || snapshot.phase !== 'waiting' || !snapshot.you.leader) return;
    const choice = this.terrain.getMap();
    if (choice.mapId !== snapshot.mapId) {
      const selected = MAPS.find((entry) => entry.id === choice.mapId);
      const layout = selected?.layouts.find((entry) => entry.id === snapshot.layoutId && entry.supported) ?? selected?.layouts.find((entry) => entry.supported);
      if (layout) void this.command({ op: 'configure', mapId: choice.mapId, layoutId: layout.id, size: choice.size, mapSeed: choice.mapSeed });
    } else if (choice.mapSeed !== snapshot.mapSeed || choice.size !== snapshot.size) {
      void this.command({ op: 'configure', ...(choice.mapSeed !== snapshot.mapSeed ? { mapSeed: choice.mapSeed } : {}), ...(choice.size !== snapshot.size ? { size: choice.size } : {}) });
    }
  }
  /** The large live preview of the exact selected battlefield (map, seed and size), generated off the main thread. */
  private renderPreview(): void {
    if (this.route !== 'game') return;
    const choice = this.terrain.getMap();
    const map = MAPS.find((entry) => entry.id === choice.mapId);
    const mode = this.snapshot ? lobbyMode(this.snapshot.mapId, this.snapshot.layoutId)?.label : undefined;
    this.roomCaption.replaceChildren(h('b', {}, map?.label ?? choice.mapId), h('span', {}, [`${choice.size} × ${choice.size}`, map?.tags.includes('generated') ? `seed ${choice.mapSeed}` : 'authored', mode].filter(Boolean).join(' · ')));
    const options = this.terrain.options();
    const key = JSON.stringify(options);
    if (key === this.previewKey) return;
    this.previewKey = key;
    thumbnailMaps.get(options).then((preview) => { if (this.previewKey === key) paintMap(this.roomPreview, preview); }, () => { /* unavailable saved map: the caption still names it */ });
  }
  private pickTab(tab: SetupTab): void {
    this.setupTab = tab;
    for (const button of this.tabs.querySelectorAll<HTMLButtonElement>('[data-setup-tab]')) {
      const on = button.dataset.setupTab === tab;
      button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1;
    }
    for (const [id, panel] of Object.entries(this.panels)) panel.hidden = id !== tab;
  }
  private tabKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = SETUP_TABS[(SETUP_TABS.findIndex((tab) => tab.id === this.setupTab) + step + SETUP_TABS.length) % SETUP_TABS.length]!.id;
    this.pickTab(next); this.tabs.querySelector<HTMLButtonElement>(`[data-setup-tab="${next}"]`)?.focus();
  }
  private renderRoom(): void {
    if (!this.code) return;
    const snapshot = this.snapshot;
    const rosterKey = this.roster?.commanders.map((commander) => [commander.id, commander.name, commander.roles, commander.kind, commander.connected, commander.policy.activeByRole, commander.metadata]);
    const connectionKey = this.connections?.map((connection) => [connection.id, connection.commander, connection.active]);
    const key = JSON.stringify([snapshot, this.roomStatus, this.handingOff, this.seriesMode, this.limits, this.limitsLoading, this.limitsError, rosterKey, connectionKey, this.picked, [...this.perPlane]]);
    const frozen = !snapshot || snapshot.phase !== 'waiting' || this.roomStatus !== 'live';
    if (snapshot && !this.mapPicker) { this.mapPicker = new MapPicker(this.terrain, playableMap); this.roomMap.append(this.mapPicker.el); }
    this.roomMap.disabled = frozen || !snapshot?.you.leader;
    this.roomPane.toggleAttribute('data-loading', !snapshot);
    patch(this.roomHead, key, () => {
      if (!snapshot) return [h('p', { class: 'lobby-live-status', role: 'status' }, this.roomStatus === 'connecting' ? 'Opening game…' : 'Disconnected · seats held briefly'), ...(this.roomStatus === 'connecting' ? [] : [this.button('Reconnect', 'reconnect', 'reconnect', () => void this.run(() => this.connectRoom(this.code!)))])];
      const invite = `${location.origin}${location.pathname}#l=${encodeURIComponent(snapshot.code)}`;
      return [
        h('div', { class: 'invite-box' }, h('input', { readonly: true, value: invite, 'aria-label': 'Credential-free game invite', onfocus: (event: Event) => (event.target as HTMLInputElement).select() }), h('button', { class: 'btn small', 'data-lobby-action': 'copy-invite', 'data-tip': 'Copy the invite link (no player credentials)', onclick: () => void copyText(invite).then((ok) => { this.message.textContent = ok ? 'Invite copied.' : 'Could not copy invite.'; }) }, icon('copy', 16), 'Invite')),
        h('p', { class: 'lobby-live-status', role: 'status', 'data-phase': snapshot.phase }, this.handingOff ? 'Entering match…' : this.roomStatus !== 'live' ? 'Disconnected · seats held briefly' : PHASE_LABEL[snapshot.phase] ?? snapshot.phase),
        ...(this.roomStatus !== 'live' ? [this.button('Reconnect', 'reconnect', 'reconnect', () => void this.run(() => this.connectRoom(snapshot.code)))] : []),
        this.button('Leave', 'leave', 'leave-lobby', () => void this.leave())];
    });
    patch(this.sides, key, () => snapshot ? [this.armies(snapshot)] : [h('p', { class: 'pm-empty' }, this.roomStatus === 'connecting' ? 'Opening game…' : 'Disconnected')]);
    patch(this.people, key, () => snapshot ? this.peopleStrip(snapshot) : []);
    patch(this.dock, key, () => this.dockView(snapshot));
    patch(this.panels.match, key, () => snapshot ? this.matchPanel(snapshot, frozen) : []);
    patch(this.panels.rules, key, () => {
      this.rulesEditor?.destroy(); this.rulesEditor = undefined;
      if (!snapshot) return [];
      const map = MAPS.find((entry) => entry.id === snapshot.mapId);
      const rules = createRulesEditor({ rules: snapshot.rules, mapEditable: map?.tags.includes('generated') === true, choices: { 'map.size': map?.sizes ?? [snapshot.size] }, disabled: frozen || !snapshot.you.leader, onChange: (value) => void this.command({ op: 'configure', rules: rulesOptions(value) }) });
      this.rulesEditor = rules;
      return [rules.element, h('p', { class: 'small muted lobby-rules-hash' }, `Resolved rules · ${snapshot.rulesHash} · rule changes clear readiness`)];
    });
    patch(this.panels.series, key, () => snapshot ? this.seriesPanel(snapshot) : []);
    patch(this.startBar, key, () => snapshot ? this.startActions(snapshot, frozen) : []);
    const rulesTab = this.tabs.querySelector<HTMLElement>('[data-setup-tab="rules"]');
    rulesTab?.toggleAttribute('data-changed', !!snapshot?.customRules);
    const seriesTab = this.tabs.querySelector<HTMLElement>('[data-setup-tab="series"]');
    seriesTab?.toggleAttribute('data-changed', !!snapshot && this.seriesMode && seriesSeats(snapshot));
    this.updateCountdown();
  }
  private armies(snapshot: LobbySnapshot): HTMLElement {
    const locked = snapshot.phase !== 'waiting' || this.roomStatus !== 'live' || !snapshot.you.leader;
    const versus = snapshot.sides.length === 2;
    return h('div', { class: 'lobby-armies', 'data-armies': String(snapshot.sides.length) }, ...snapshot.sides.flatMap((side, index) => {
      const seats = snapshot.seats.filter((seat) => seat.team === side.id);
      const common = wholeArmyOccupant(seats);
      const ready = seats.filter((seat) => seat.occupant.kind !== 'open' && seat.occupant.kind !== 'closed');
      const perPlane = this.perPlane.get(side.id) ?? !common;
      const army = h('section', { class: 'lobby-army', 'data-side': side.id, 'data-colour': side.alliance, 'data-slot-state': slotState(seats.map((seat) => seat.occupant)) },
        h('header', { class: 'lobby-army-head' }, h('h3', { 'data-tip': `${side.label} corner` }, icon('spire'), COLOUR_LABEL[side.alliance], h('small', { class: 'lobby-army-corner' }, side.label)),
          this.colourPicker(snapshot, side, locked),
          ready.length ? h('span', { class: 'lobby-army-ready' }, `${ready.filter((seat) => seat.ready === 'ready').length}/${ready.length} ready`) : null),
        this.seatMode(side.id, perPlane),
        ...(perPlane
          ? planesTopDown(seats).map((seat) => this.planeSeat(snapshot, side, seat))
          : [this.slot(snapshot, side.id, seats, 'lobby-whole-army',
            ...(common ? [] : [h('span', { class: 'lobby-slot-scope' }, 'Mixed · pick one to apply to all 4')]),
            agentButton(common ? this.agent(common, seats[0], snapshot) : { kind: 'none', name: 'Mixed', detail: '4 planes' }),
            this.occupantEditor(snapshot, side.id, seats, common, `${side.label} all planes`, 'Claim slot'))]));
      return [...(index && versus ? [h('span', { class: 'pm-vs', 'aria-hidden': 'true' }, 'VS')] : []), army];
    }));
  }
  /**
   * One seat mode per army card: one choice for all four planes, or each plane separately. Only that mode's editor is
   * shown. Switching changes no seats by itself: per-plane rows start from the current seats, and returning to "All
   * planes" while they differ shows "Mixed" until a pick applies one occupant to all four.
   */
  private seatMode(team: string, perPlane: boolean): HTMLElement {
    return h('div', { class: 'seg-ctl lobby-seat-mode', role: 'radiogroup', 'aria-label': 'Seat mode' }, ...([false, true] as const).map((value) => h('button', {
      type: 'button', role: 'radio', class: perPlane === value ? 'on' : '', 'aria-checked': String(perPlane === value), 'data-lobby-action': `seat-mode-${team}-${value ? 'planes' : 'all'}`,
      'data-tip': value ? 'Give each plane its own player, commander or bot' : 'One player, commander or bot commands all four planes',
      onclick: () => { if (perPlane !== value) { this.perPlane.set(team, value); this.renderRoom(); } },
    }, icon(value ? 'units' : 'spire', 16), value ? 'Per plane' : 'All planes')));
  }
  /** A per-plane row: the plane icon (ready dot, name in its tip) beside a full-width editor. */
  private planeSeat(snapshot: LobbySnapshot, side: LobbySide, seat: LobbySeat): HTMLElement {
    const active = slotState([seat.occupant]) === 'active';
    const ready = active ? READY_LABEL[seat.ready] ?? seat.ready : 'Open';
    return this.slot(snapshot, side.id, [seat], 'lobby-seat',
      h('span', { class: 'lobby-seat-icon', 'data-ready': active ? seat.ready : 'open', 'data-tip': `${PLANE_NAME[seat.role]} · ${ready}. ${PLANE_BLURB[seat.role]}`, 'aria-label': `${PLANE_NAME[seat.role]}, ${ready}` }, icon(seat.role, 18)),
      h('div', { class: 'lobby-seat-body' }, h('span', { class: 'lobby-seat-name' }, PLANE_NAME[seat.role]),
        this.occupantEditor(snapshot, side.id, [seat], seat.occupant, `${side.label} ${PLANE_NAME[seat.role]}`, 'Claim seat')));
  }
  /**
   * An army's colour picker (DESIGN §15.11): four swatches. Stage 2 keeps every army a distinct colour, so a colour
   * another army holds is disabled (the server would answer `colour_taken`).
   */
  private colourPicker(snapshot: LobbySnapshot, side: LobbySide, locked: boolean): HTMLElement {
    return h('div', { class: 'lobby-colours', role: 'radiogroup', 'aria-label': `${side.label} colour` }, ...COLOURS.map((colour) => {
      const holder = snapshot.sides.find((other) => other.alliance === colour);
      const own = holder?.id === side.id;
      const name = COLOUR_LABEL[colour];
      return h('button', {
        type: 'button', role: 'radio', class: 'lobby-colour', 'data-colour': colour, 'aria-checked': String(own), 'aria-label': name,
        disabled: locked || (holder !== undefined && !own) || undefined,
        'data-tip': holder && !own ? `${name} · taken by ${holder.label}` : own ? `${name} · this army` : name,
        onclick: () => { if (!own) void this.command({ op: 'configure', colours: { [side.id]: colour } }); },
      });
    }));
  }
  private peopleStrip(snapshot: LobbySnapshot): HTMLElement[] {
    const players = snapshot.players.filter((member) => !member.observer);
    const observers = snapshot.players.filter((member) => member.observer);
    return [
      h('section', { class: 'lobby-members', 'aria-label': 'Players' }, h('h3', {}, icon('human', 16), 'Players'),
        ...players.map((member) => h('div', { class: 'lobby-member' }, this.member(member, !member.connected ? 'Away' : member.ready ? 'Ready' : 'Not ready'),
          snapshot.you.leader && member.id !== snapshot.you.memberId ? h('button', { type: 'button', class: 'btn small ghost', 'data-lobby-action': `kick-${member.id}`, 'aria-label': `Release / kick ${member.label}`, 'data-tip': `Release ${member.label}'s seats and remove them`, onclick: () => { if (confirm(`Release ${member.label}'s occupied seats and remove them?`)) void this.command({ op: 'kick', memberId: member.id }); } }, icon('cancel', 14)) : null)),
        ...(!players.length ? [h('span', { class: 'muted small' }, 'None')] : [])),
      h('section', { class: 'lobby-observers', 'aria-label': 'Observers' },
        h('h3', { 'data-tip': `${snapshot.observerPolicy.allowOmniscient ? 'All / side perspective' : 'Authorized side perspective'} · delay ${Math.ceil(snapshot.observerPolicy.minDelayMs / 1000)} s · read-only` }, icon('spectate', 16), 'Observers'),
        ...observers.map((member) => h('div', { class: 'lobby-member' }, this.member(member, 'Observer'))),
        ...(snapshot.you.observer ? [] : [h('button', { type: 'button', class: 'btn small', 'data-lobby-action': 'move-observer', 'data-tip': 'Release my seats and watch read-only', onclick: () => void this.command({ op: 'observe' }) }, icon('spectate', 16), 'Observe')])),
    ];
  }
  private dockView(snapshot: LobbySnapshot | undefined): HTMLElement[] {
    const commanders = this.roster?.commanders ?? [];
    const manage = this.button(commanders.length ? 'Manage' : 'Connect commanders', 'commanders', 'commanders', () => this.show('commanders'), !commanders.length);
    if (!commanders.length) return [h('h3', {}, icon('commanders', 16), 'Commanders'), h('p', { class: 'pm-dock-empty muted' }, 'No commanders yet.'), manage];
    const editable = !!snapshot && snapshot.phase === 'waiting' && this.roomStatus === 'live';
    return [h('h3', { 'data-tip': 'Drag a commander onto a slot, or pick one and press Place' }, icon('commanders', 16), 'Commanders'),
      rosterDock(commanders, this.connections, { label: 'My commanders', ...(this.picked ? { selected: this.picked } : {}), ...(editable ? { onPick: (commander) => this.pick(this.picked === commander.id ? undefined : commander.id) } : {}) }),
      manage];
  }
  private matchPanel(snapshot: LobbySnapshot, frozen: boolean): HTMLElement[] {
    const map = MAPS.find((entry) => entry.id === snapshot.mapId);
    const locked = frozen || !snapshot.you.leader;
    // Only playable layouts are offered; a single one reads as plain text, not a dead dropdown.
    const layouts = (map?.layouts ?? []).filter((entry) => entry.supported);
    const layoutSelect = layouts.length > 1
      ? h('select', { 'aria-label': 'Layout', disabled: locked, onchange: (event: Event) => void this.command({ op: 'configure', layoutId: (event.target as HTMLSelectElement).value }) }, ...layouts.map((entry) => h('option', { value: entry.id, selected: entry.id === snapshot.layoutId }, entry.label)))
      : h('b', { 'aria-label': 'Layout' }, layouts[0]?.label ?? snapshot.mode);
    const visibility = h('div', { class: 'seg-ctl', role: 'radiogroup', 'aria-label': 'Visibility' }, ...(['private', 'public'] as const).map((value) => h('button', {
      type: 'button', role: 'radio', class: snapshot.visibility === value ? 'on' : '', 'aria-checked': String(snapshot.visibility === value), 'data-visibility': value, disabled: locked,
      'data-tip': value === 'private' ? 'Invite only' : 'Listed in the Lobby · observers delayed ≥180 s',
      onclick: () => { if (snapshot.visibility !== value) void this.command({ op: 'configure', visibility: value }); },
    }, icon(value === 'private' ? 'invite' : 'queue', 16), value === 'private' ? 'Private' : 'Public')));
    const observerDelay = h('input', { type: 'number', min: snapshot.visibility === 'public' ? 180 : 0, max: 300, step: 1, value: snapshot.observerPolicy.minDelayMs / 1000, 'aria-label': 'Observer delay seconds', 'data-tip': 'Wall-clock delay covers world, commentary, outcomes and results. Public omniscience is delayed at least 180 seconds.', disabled: locked, onchange: (event: Event) => void this.command({ op: 'configure', observerPolicy: { minDelayMs: Number((event.target as HTMLInputElement).value) * 1000 } }) });
    return [
      h('label', { class: 'pm-field-row' }, h('span', {}, 'Layout'), layoutSelect),
      h('div', { class: 'pm-field-row' }, h('span', {}, 'Visibility'), visibility),
      // Public lobbies only: a private game is never featured.
      ...(snapshot.visibility === 'public' ? [h('label', { class: 'pm-field-row pm-check', 'data-lobby-featured': '' },
        tip(h('input', { type: 'checkbox', checked: snapshot.featured, disabled: locked, 'aria-label': 'Feature on Watch live', onchange: (event: Event) => void this.command({ op: 'configure', featured: (event.target as HTMLInputElement).checked }) }),
          'Watch live may show this game to everyone, at the observer delay. Untick to keep it off.'),
        icon('spectate', 16), 'Feature on Watch live')] : []),
      h('label', { class: 'pm-field-row' }, h('span', {}, 'Observer delay (s)'), observerDelay),
      h('p', { class: 'small muted' }, `Observers · ${snapshot.observerPolicy.allowOmniscient ? 'all or side perspective' : 'side perspective'} · read-only`),
      ...(snapshot.customRules || snapshot.unrankedPractice ? [h('p', { class: 'lobby-practice-badge', 'data-unranked': '' }, icon('info'), `${snapshot.customRules ? 'Custom rules · ' : ''}Unranked practice${snapshot.practiceReasons.length ? ` · ${snapshot.practiceReasons.join(' · ')}` : ''}`)] : []),
    ];
  }
  private async loadSeriesLimits(): Promise<void> {
    if (this.limits || this.limitsLoading) return;
    this.limitsLoading = true; this.limitsError = undefined; this.renderRoom();
    try {
      const api = await this.ensureProfile();
      const limits = await api.arenaLimits();
      if (!this.stopped) {
        this.limits = limits;
        this.series.maxTicks = Math.min(this.series.maxTicks, limits.maxTicks);
        this.series.maxWallMs = Math.min(this.series.maxWallMs, limits.maxWallMs);
      }
    } catch (error) { this.limitsError = errorText(error); throw error; }
    finally { this.limitsLoading = false; if (!this.stopped) this.renderRoom(); }
  }
  private setSeriesMode(on: boolean): void {
    this.seriesMode = on; this.renderRoom();
    if (on) void this.loadSeriesLimits().catch(() => {});
  }
  private seriesGames(maps: number): { values: string[]; valid: boolean; total: number } {
    const values = this.seedText.split(/[,\s]+/).filter(Boolean);
    const valid = values.length > 0 && values.every((value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)));
    return { values, valid, total: values.length * maps * (this.series.sideSwaps ? 2 : 1) };
  }
  /** Single game or a series through PlayerThree; series options appear only for an all-bot/commander lineup. */
  private seriesPanel(snapshot: LobbySnapshot): HTMLElement[] {
    const eligible = seriesSeats(snapshot);
    const locked = !snapshot.you.leader || snapshot.phase !== 'waiting';
    const series = this.seriesMode && eligible;
    const mode = h('div', { class: 'seg-ctl', role: 'radiogroup', 'aria-label': 'Games' },
      h('button', { type: 'button', role: 'radio', class: series ? '' : 'on', 'aria-checked': String(!series), 'data-series-mode': 'single', disabled: locked, onclick: () => this.setSeriesMode(false) }, 'Single game'),
      h('button', { type: 'button', role: 'radio', class: series ? 'on' : '', 'aria-checked': String(series), 'data-series-mode': 'series', disabled: locked || !eligible, 'data-tip': eligible ? 'Balanced, seed-paired games with standings' : SERIES_SEATS_TIP, onclick: () => this.setSeriesMode(true) }, 'Series'));
    if (!series) return [mode, h('p', { class: 'small muted' }, eligible ? 'Run N seed-paired games with results, standings and a share link.' : SERIES_SEATS_TIP)];
    const limits = this.limits;
    if (!limits) return [mode, h('p', { role: 'status' }, this.limitsLoading ? 'Loading server limits…' : this.limitsError ?? 'Load the current server limits before scheduling.'),
      ...(this.limitsLoading ? [] : [h('button', { type: 'button', class: 'btn small', onclick: () => void this.loadSeriesLimits().catch(() => {}) }, 'Load limits')])];
    const live = snapshot.seats.some((seat) => seat.occupant.kind === 'commander' && seat.occupant.ref?.kind !== 'policy');
    const maps = new Set(this.series.maps.length ? this.series.maps : [snapshot.mapId]);
    const count = h('output', { class: 'lobby-series-count', 'aria-live': 'polite' });
    const updateCount = () => { const games = this.seriesGames(maps.size); count.textContent = games.valid ? `${games.total} games · ${maps.size} ${maps.size === 1 ? 'map' : 'maps'}${this.series.sideSwaps ? ' · paired swaps' : ''}` : 'Enter integer seeds separated by commas.'; };
    const seeds = h('input', { value: this.seedText, 'aria-label': 'Series seed list', required: true, oninput: (event: Event) => { this.seedText = (event.target as HTMLInputElement).value; updateCount(); } });
    const numberField = (label: string, value: number, min: number, max: number, change: (value: number) => void) => h('label', {}, h('span', {}, label), h('input', { type: 'number', value, min, max, step: 1, required: true, 'aria-label': label, onchange: (event: Event) => change(Number((event.target as HTMLInputElement).value)) }));
    updateCount();
    return [mode, h('div', { class: 'lobby-series-form' },
      h('label', { class: 'pm-wide' }, h('span', {}, 'Seeds'), seeds),
      h('fieldset', { class: 'pm-wide' }, h('legend', {}, 'Map rotation'), ...MAPS.filter((map) => map.layouts.some((layout) => layout.supported)).map((map) => h('label', {}, h('input', { type: 'checkbox', checked: maps.has(map.id), onchange: (event: Event) => { if ((event.target as HTMLInputElement).checked) maps.add(map.id); else maps.delete(map.id); this.series.maps = [...maps]; updateCount(); } }), map.label))),
      h('label', { class: 'pm-wide pm-check' }, h('input', { type: 'checkbox', checked: this.series.sideSwaps, onchange: (event: Event) => { this.series.sideSwaps = (event.target as HTMLInputElement).checked; updateCount(); } }), 'Swap sides every seed and map'),
      numberField('Speed ×', this.series.speed, 1, 20, (value) => { this.series.speed = value; }),
      numberField('Concurrency', this.series.concurrency, 1, live ? limits.maxLiveConcurrency : limits.maxConcurrency, (value) => { this.series.concurrency = value; }),
      numberField('Max ticks', this.series.maxTicks, 20, limits.maxTicks, (value) => { this.series.maxTicks = value; }),
      numberField('Max wall ms', this.series.maxWallMs, 1000, limits.maxWallMs, (value) => { this.series.maxWallMs = value; }),
      numberField('Retries', this.series.retries, 0, 3, (value) => { this.series.retries = value; }),
      h('label', { class: 'pm-wide pm-check' }, h('input', { type: 'checkbox', checked: this.series.abortOn.includes('infrastructure'), onchange: (event: Event) => { this.series.abortOn = (event.target as HTMLInputElement).checked ? ['infrastructure'] : []; } }), 'Abort on exhausted infrastructure failure'),
      count,
      h('details', { class: 'pm-wide lobby-series-limits' }, h('summary', {}, icon('info', 16), 'Limits'),
        h('p', { class: 'small muted' }, `Agent state resets each match; commentary excluded by default. ${limits.maxGames} games per series, ${limits.maxActiveSeries} active series per profile, ${limits.maxLiveConcurrency} live lane(s), ${limits.maxConcurrency} concurrent model-free matches, ${limits.maxTicks / 1200} simulated / ${limits.maxWallMs / 60000} wall minutes per match. Retention ${limits.retentionMs / 86400000} days; raw limits ${limits.maxAttemptBytes / 1048576} MiB per match, ${limits.maxBytes / 1073741824} GiB per series, ${limits.maxOwnerBytes / 1073741824} GiB per profile. Failed attempts remain in exports.`)))];
  }
  private startSeries(snapshot: LobbySnapshot): void {
    const limits = this.limits;
    if (!limits) return;
    const maps = this.series.maps.length ? this.series.maps : [snapshot.mapId];
    const games = this.seriesGames(maps.length);
    if (!games.valid || !maps.length) { this.message.textContent = 'Choose at least one map and an explicit integer seed list.'; return; }
    if (games.total > limits.maxGames) { this.message.textContent = `This schedule has ${games.total} games; the server limit is ${limits.maxGames}. Choose a complete smaller balanced schedule.`; return; }
    this.series.seeds = games.values.map(Number); this.series.maps = [...maps];
    void this.run(async () => { const api = await this.ensureProfile(); if (!this.code) return; const result = await api.startSeries(this.code, { ...this.series, revision: snapshot.revision }); if (this.onSeries) this.onSeries({ seriesId: result.seriesId, credential: api.profile.secret }); else location.hash = `series=${encodeURIComponent(result.seriesId)}`; });
  }
  private startActions(snapshot: LobbySnapshot, frozen: boolean): HTMLElement[] {
    const own = snapshot.players.find((member) => member.id === snapshot.you.memberId);
    const series = this.seriesMode && seriesSeats(snapshot);
    const open = snapshot.seats.some((seat) => seat.occupant.kind === 'open');
    return [
      ...(snapshot.queuePosition === undefined ? [] : [h('p', { class: 'pm-queue', role: 'status' }, `Queued ${snapshot.queuePosition} · about ${Math.max(1, Math.ceil((snapshot.estimatedWaitMs ?? 0) / 60000))} min`)]),
      h('span', { class: 'lobby-countdown', role: 'timer' }),
      ...(snapshot.phase === 'started' && !this.handingOff ? [this.button('Enter match', 'human', 'enter-match', () => void this.handoff(), true)] : []),
      ...(!snapshot.you.observer && !series ? [this.button(own?.ready ? 'Unready' : 'Ready', 'human', 'ready', () => void this.command({ op: 'ready', ready: !own?.ready }))] : []),
      ...(snapshot.you.leader ? [series
        ? h('button', { type: 'button', class: 'btn primary pm-go', 'data-lobby-action': 'start-series', disabled: snapshot.phase !== 'waiting' || !this.limits, 'data-tip': 'Start the series; results and standings follow', onclick: () => this.startSeries(snapshot) }, icon('queue'), 'Start series')
        : h('button', { type: 'button', class: 'btn primary pm-go', 'data-lobby-action': 'start-lobby', disabled: frozen || open, 'data-tip': open ? 'Fill or close every Open slot first' : 'Start now; other players must be ready', onclick: () => void this.command({ op: 'start' }) }, icon('aggressive'), 'Start')] : []),
    ];
  }
  private updateCountdown(): void {
    const node = this.startBar.querySelector('.lobby-countdown');
    if (node) node.textContent = this.snapshot?.phase === 'countdown' && this.snapshot.countdownAt !== undefined ? `Starting in ${Math.max(0, Math.ceil((this.snapshot.countdownAt - Date.now()) / 1000))}` : '';
  }
  private async send(command: LobbyCommand): Promise<void> {
    if (!this.roomSocket || this.roomStatus !== 'live' || !this.snapshot) throw new CallError('disconnected');
    await this.roomSocket.command(command, this.snapshot.revision);
  }
  private command(command: LobbyCommand): Promise<void> { return this.run(() => this.send(command)); }
  private async handoff(): Promise<void> {
    if (!this.code || this.handingOff || this.stopped) return;
    const generation = this.roomGeneration; this.handingOff = true; this.renderRoom();
    // Entering a started match: the loader shows from here until its first frame (or this hand-off fails).
    this.onJoining?.(true);
    try {
      const ticket = await profileCall<LobbyMatchTicket>(`/api/lobbies/${encodeURIComponent(this.code)}/ticket`, { body: {}, ...this.auth() });
      // The Lobby is disposed on entry: capture the code and our admission now for the observer pass.
      const code = this.code, auth = this.auth();
      const observe = ticket.observer ? undefined : () => profileCall<LobbyObserverTicket>(`/api/lobbies/${encodeURIComponent(code)}/ticket`, { body: { observer: true }, ...auth });
      if (!this.stopped && generation === this.roomGeneration) this.onEnter({ ticket: { ...ticket, lobbyCode: this.code, lobbyAuth: auth }, mode: ticket.observer ? 'pvp' : ticket.mode, label: ticket.label, ...(observe ? { observe } : {}) });
      else if (!this.stopped) this.onJoining?.(false);
    } catch (error) { if (!this.stopped) { this.onJoining?.(false); if (generation === this.roomGeneration) { this.handingOff = false; this.message.textContent = errorText(error); this.renderRoom(); } } }
  }
  /** Releases my membership in the current room and forgets it (its visitor capability too). */
  private async release(): Promise<void> {
    if (!this.code) return;
    try { await profileCall(`/api/lobbies/${encodeURIComponent(this.code)}/leave`, { body: {}, ...this.auth() }); }
    catch (error) { if (!(error instanceof ApiError && error.code === 'lobby_not_found')) throw error; /* A finished match already released it. */ }
    try { sessionStorage.removeItem(`${VISITOR_STORAGE_PREFIX}${this.code}`); } catch { /* Server release already revoked this visitor admission. */ }
    ++this.roomGeneration; this.roomSocket?.leave(); this.roomSocket = undefined; this.snapshot = undefined; this.code = undefined; this.visitorToken = undefined; this.handingOff = false; this.picked = undefined;
    window.clearInterval(this.countdown); const url = new URL(location.href); url.hash = ''; history.replaceState(null, '', url);
  }
  private leave(): Promise<void> { return this.run(async () => { await this.release(); this.show('home'); }); }
  /** One action at a time. The "Connecting…" note only appears if the action is still pending after 400 ms, so quick
   *  room edits (rules, seats, ready) never flash it. */
  private async run(task: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.message.textContent = ''; this.el.setAttribute('aria-busy', 'true');
    const slow = window.setTimeout(() => { if (!this.stopped) this.message.textContent = 'Connecting…'; }, 400);
    try { await task(); if (!this.stopped) this.message.textContent = ''; }
    catch (error) { if (!this.stopped) this.message.textContent = errorText(error); }
    finally { window.clearTimeout(slow); this.busy = false; this.el.removeAttribute('aria-busy'); }
  }
  dispose(): void {
    this.stopped = true; ++this.roomGeneration; ++this.directoryGeneration;
    window.clearTimeout(this.timer); window.clearInterval(this.countdown);
    this.roomSocket?.leave(); this.directorySocket?.leave(); this.screen?.dispose(); this.agentConsole?.destroy(); this.rulesEditor?.destroy(); this.mapPicker?.dispose(); this.settings.dispose();
    for (const cleanup of this.cleanups) cleanup();
    this.el.remove();
  }
}
