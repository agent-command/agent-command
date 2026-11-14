/**
 * The observer: a read-only caster surface over released (delayed) frames, in the game HUD's visual language. One
 * toolkit, two presets: `broadcast` (Watch live, Lobby → Observe) and `benchmark` (a series game, with the series
 * strip and per-agent stats). Every panel is optional and collapsible; stream mode leaves only the scoreboard and
 * the delay badge. Player controls (command card, chat, mandates, consoles) are never constructed here.
 */
import { COLOURS, PLANES, TICK_RATE, UPGRADES, isArmyId, isUpgrade, type ArmyId, type Colour, type GameEvent, type ObserverView, type Outcome, type Plane, type View } from '@agent-command/game/contract';
import type { MatchCloseReason } from '@agent-command/game/lobby';
import type { ResultsSummary } from 'playerthree/arena';
import type { ObserverAgentCard, ObserverCommentary, ObserverGrant, ObserverMessage } from 'playerthree/protocol';
import { agentButton, entrantAgent, OPP_LABEL, type AgentIdentity } from './agent-button.ts';
import { arenaRequest, type ArenaAccess } from './arena-net.ts';
import { AudioDirector, followRig } from './audio/director.ts';
import { audioFrame, audioOutcome, audioSink, listener, setAudioScene } from './audio/index.ts';
import { h, isTextEntry, patch, PLANE_ACCENT } from './dom.ts';
import { tip } from './tooltip.ts';
import { hudSafeArea } from './hud-safe-area.ts';
import { icon, type IconName } from './icons.ts';
import { keyLayout, panFor } from './keymap.ts';
import { idSpace, matchView, type MatchView } from './match-view.ts';
import { Minimap } from './minimap.ts';
import { DIRECTOR_LIVE, DIRECTOR_STREAM, Director, DirectorCamera, PHONE_FRAMING } from './observer-director.ts';
import { composition, endLabel, endReason, gameClock, lensView, observerBoard, standings, Timeline, viewBoard, visionOptions, type BoardSide, type Moment, type ObserverSideData, type Standing, type VisionOption } from './observer-model.ts';
import { isPhone } from './mobile-banner.ts';
import { COLOUR_LABEL, CORNER_LABEL, placeLabel } from './armies.ts';
import { FeaturedObserverConnection, ObserverConnection, SeriesObserverConnection, type FeaturedMatch, type FeaturedUpcoming, type ObserverTransport } from './observer-net.ts';
import { ObserverFeed, type PlayedFrame } from './observer-feed.ts';
import { resultsHref, seriesContext, watchSeries, type SeriesContext } from './observer-series.ts';
import { crownPips, crownsOn, MatchPointBanner, SuddenDeathBanner } from './plan-hud.ts';
import { queueLabel, queueStatus } from './queue-panel.ts';
import { KIND_LABEL, PLANE_NAME } from './text.ts';
import { ledgerNumber, ledgerRate } from './topbar.ts';
import { TouchGesture } from './touch-camera.ts';
import type { Overlay } from './overlay.ts';
import { SIDE_COLOR, SIDE_HEX, colourOf, defaultArmyColours, setArmyColours, sideHex, wx, wz } from './world/common.ts';
import type { World } from './world/world.ts';
import './observer.css';

/** Where leaving lands: the public games list or Home; unset returns to wherever the observer was opened from. */
export type ExitRoute = 'lobby' | 'home';
/** `perspective`: the vision to open on when the grant permits it (an eliminated player's choice); else the grant's first. */
export type ObserverOptions = { observer?: boolean; grant: ObserverGrant; perspective?: ArmyId | 'all'; label?: string; onExit(to?: ExitRoute): void } & (
  | { roomId: string; token: string; source?: never }
  | { source: { kind: 'series'; access: ArenaAccess; matchId: string }; roomId?: never; token?: never }
  /** `secret`: the viewer's profile credential, so the relay applies the player rules to a public game it played. */
  | { source: { kind: 'featured'; secret?: string }; roomId?: never; token?: never }
);
/** A stream the server closed without a result (`MATCH_CLOSE`): never shown as an outcome. */
const OBSERVER_CLOSED: Record<MatchCloseReason, string> = {
  restart: 'Server restarted · match lost', update: 'Server updated · match lost', closed: 'Closed by the server · no result',
};
export function observerStatus(delayMs: number, state: string): string {
  return `${delayMs ? `Delayed ${Math.ceil(delayMs / 1000)} s` : 'Private authorized · no delay'} · ${state} · All channels use the same server release clock`;
}
/** The broadcast badge: how far behind the live match this playback runs (the release delay). */
export function liveBadge(delayMs: number): string {
  return delayMs ? `LIVE −${Math.ceil(delayMs / 1000)} s` : 'LIVE';
}
/** Watch live's notice for a public game about to go on air: `m:ss` until its delayed stream starts. */
export function upcomingNotice(liveInMs: number): string {
  const seconds = Math.max(0, Math.ceil(liveInMs / 1000));
  return seconds ? `Public game starting · live in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Public game next';
}

type PanelId = 'sides' | 'overview' | 'timeline' | 'agents';
type SideTab = 'production' | 'research' | 'army';
const PANEL_KEYS: Record<PanelId, string> = { sides: 'P', overview: 'M', timeline: 'T', agents: 'G' };
const STORE = 'ac.observer';
/** Manual camera input pauses the director this long (ms) before it resumes. */
const MANUAL_HOLD_MS = 8000;
/** The director re-evaluates its shot this often (ms); its camera moves every frame. */
const DECIDE_MS = 250;
/** Camera ease time constant toward a followed unit (s). */
const EASE_S = 0.45;
const PANEL_REFRESH_MS = 250;
/** Accessible army inks (display only; cyan / gold / rose / lavender, CSS `--army-<colour>-ink-accessible`): every
 *  pair stays apart under the common colour-vision deficiencies (palette.test.ts checks the separation). */
export const ACCESSIBLE_HEX: Readonly<Record<Colour, string>> = { blue: '#7fd6ff', red: '#ffcb66', green: '#f59aa6', violet: '#a99cff' };
/** Watch live rolls on to the next featured match this long (s) after the result shows, unless the viewer stays. */
export const FEATURED_CONTINUE_S = 15;
const RESULT_WORD: Readonly<Record<Exclude<Outcome, 'running'>, string>> = { win: 'Win', loss: 'Loss', draw: 'Draw' };
/** Observer letters never collide with pan keys in either camera layout (WASD pans when the player chose it). */
const HOTKEYS: readonly [string, string][] = [
  ['F1–F4', 'Depths · Surface · Sky · Orbit'], ['M', 'All-planes overview'], ['V', 'Next vision'], ['C', 'Auto-director'],
  ['Click unit', 'Follow it'], ['F / Esc', 'Stop following'], ['Space', 'Jump to latest moment'], ['P · R · U', 'Production · Research · Army'],
  ['T · G', 'Timeline · Agents'], ['B', 'Stream mode'], ['[ · ]', 'Previous · next series game'],
  ['Drag · wheel', 'Pan · zoom'], ['Right-drag · middle-drag · Alt+drag', 'Rotate'], ['Arrows (WASD if set)', 'Pan'], ['H or ?', 'This help'],
];
const BREAKTHROUGH: Partial<Record<Moment['event'], string>> = { tunnel_breach: 'Tunnel breach', breach_opened: 'Breach opened', chasm_opened: 'Chasm opened' };

function control(label: string, name: IconName, action: () => void, text?: string): HTMLButtonElement {
  return h('button', { class: 'btn small', type: 'button', 'data-tip': label, 'aria-label': label, onclick: action }, icon(name, 16), text ?? null);
}
/** An army's ink, or muted for an unknown or absent side (a moment without an actor). */
const sideInk = (army: string) => (army === '' ? 'var(--muted)' : sideHex(army as ArmyId));

interface Stream { perspective: string; feed: ObserverFeed; conn: ObserverTransport | undefined; previous: MatchView | undefined }

/** A separate game surface: never constructs player Controls, owner chat, commander popovers or console. */
export class ObserverGame {
  private readonly el = h('section', { class: 'obs', 'aria-label': 'Read-only observer', 'data-palette': 'standard' });
  private readonly world: World;
  /** The overlay canvas sits above the WebGL canvas and receives all pointer input (as in play). */
  private readonly input: HTMLCanvasElement;
  private readonly opts: ObserverOptions;
  private grant: ObserverGrant;
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;
  private readonly streams = new Map<string, Stream>();
  private options: VisionOption[];
  private vision: ArmyId | 'all';
  /** Latest played omniscient projection (sides) and the view on screen. */
  private all: ObserverView | undefined;
  private worldView: MatchView | undefined;
  private readonly boards = new Map<ArmyId, BoardSide>();
  /** The match's armies (from the grant until the first released frame names them all), in army order. */
  private armies: readonly ArmyId[];
  /** The match whose armies label the panels (a released frame's `match`, shared by reference across frames). */
  private adopted: MatchView['match'] | undefined;
  private readonly timeline = new Timeline();
  /** A phone (`isPhone`): the battlefield under one compact strip (score and clock, vision, planes, leave); `more`
   *  reveals the side stats, the director and the status line. Panels, overview and caster tools stay desktop-only. */
  private readonly compact = isPhone();
  private readonly director = new Director();
  /** A phone frames the director's shots tighter (`PHONE_FRAMING`); desktop framing is the presets' own. */
  private readonly directorCamera = new DirectorCamera(this.compact ? PHONE_FRAMING : 1);
  /** The shown view's sound cues (same director as the player HUD: only what the shown view contains). */
  private readonly audio: AudioDirector;
  private disclosed: ObserverCommentary[] = [];
  private agentCards: readonly ObserverAgentCard[] = [];
  private featuredSeats: FeaturedMatch['seats'] = [];
  private featuredRoom = '';
  private series: SeriesContext | undefined;
  private seriesResult: ResultsSummary | undefined;
  private readonly seriesAbort = new AbortController();
  private matchId: string | undefined;
  /** The released final frame's result: outcomes per army, known places and the tick it ended on. */
  private outcomes: Readonly<Record<string, Outcome>> | undefined;
  private readonly ranks = new Map<ArmyId, number>();
  private endTick = 0;
  /** The end card has shown for this match (its sting played); `endOpen` false = folded to a banner. */
  private ended = false;
  private endOpen = true;
  /** Featured: seconds left before rolling on, the next match held off screen while the result shows, and a viewer
   *  who asked to continue before the relay announced it. */
  private countdown: number | undefined;
  private countdownTimer = 0;
  private nextMatch: FeaturedMatch | undefined;
  private continueWanted = false;
  /** Featured: the loader's line while it holds for a public game the relay just cut over to. */
  private transition: string | undefined;
  /** Featured: a public game about to go on air (when, on the performance clock), and its notice's ticker. */
  private upcoming: { label: string; at: number } | undefined;
  private upcomingTimer = 0;
  private readonly upcomingNote = h('p', { class: 'obs-upcoming obs-face', role: 'status', 'aria-live': 'polite', hidden: true });
  private terminal = false;
  private renderedAt = Number.NEGATIVE_INFINITY;
  private lastFrameAt = 0;
  private chooseAt = 0;
  private directorOn = true;
  private manualUntil = 0;
  private follow: string | undefined;
  private tab: SideTab = 'production';
  private collapsed: Set<PanelId>;
  private stream: boolean;
  private more = false;
  private readonly minimap: Minimap;
  // Elements
  private readonly status = h('p', { class: 'obs-status', role: 'status', 'aria-live': 'polite' });
  private readonly badge = h('strong', { class: 'observer-live', role: 'status', 'data-tip': 'Playback runs this far behind the live match; every channel uses the same release clock' });
  private readonly clock = h('b', { class: 'obs-clock', 'aria-label': 'Game clock' }, '00:00');
  private readonly suddenDeath = new SuddenDeathBanner();
  private readonly matchPoint = new MatchPointBanner();
  /** Public crowns (lossRule crowns), as the last view on screen shows them. */
  private crowns: MatchView['crowns'];
  private readonly matchLabel = h('span', { class: 'obs-match-label' });
  private readonly boardSides = h('div', { class: 'obs-board-sides' });
  private readonly board = h('header', { class: 'obs-board obs-face', 'aria-label': 'Scoreboard' });
  private readonly seriesBar = h('div', { class: 'obs-series obs-face', 'aria-label': 'Series' });
  private readonly sidesBody = h('div', { class: 'obs-panel-body obs-sides' });
  private readonly tabs = h('div', { class: 'obs-tabs', role: 'tablist', 'aria-label': 'Side details' });
  private readonly timelineBody = h('ol', { class: 'obs-panel-body obs-timeline' });
  private readonly agentsBody = h('div', { class: 'obs-panel-body obs-agents' });
  private readonly visionBar = h('div', { class: 'obs-seg obs-vision', role: 'radiogroup', 'aria-label': 'Vision' });
  private readonly planeBar = h('div', { class: 'obs-seg obs-planes', 'aria-label': 'Planes' });
  private readonly directorButton: HTMLButtonElement;
  private readonly followButton: HTMLButtonElement;
  private readonly streamButton: HTMLButtonElement;
  private readonly overviewButton: HTMLButtonElement;
  private readonly moreButton: HTMLButtonElement | undefined;
  private readonly help = h('div', { class: 'obs-help obs-face', role: 'dialog', 'aria-label': 'Observer hotkeys', hidden: true });
  private readonly panels = new Map<PanelId, HTMLElement>();
  private readonly left = h('aside', { class: 'obs-col obs-left' });
  private readonly right = h('aside', { class: 'obs-col obs-right' });
  private readonly dock = h('nav', { class: 'obs-dock obs-face', 'aria-label': 'Observer controls' });
  private readonly endCard = h('div', { class: 'outcome-card obs-end-card' });
  private readonly end = h('section', { class: 'obs-end', role: 'dialog', 'aria-label': 'Match result', hidden: true }, this.endCard);

  constructor(root: HTMLElement, world: World, overlay: Overlay, opts: ObserverOptions) {
    this.world = world; this.input = overlay.canvas; this.opts = opts; this.grant = opts.grant;
    // The observer never sets a game cursor: whatever a player session left on the shared canvas (an armed order,
    // the edge-scroll arrow) must not show here.
    overlay.cursor.reset();
    world.reset();
    const featured = opts.source?.kind === 'featured';
    // Watch live: the granted armies until the relay announces the match's own (a duel or a four-army FFA).
    this.options = visionOptions(opts.grant, featured ? (opts.grant.kind === 'omniscient' ? opts.grant.teams : [opts.grant.team]).filter(isArmyId) : undefined);
    this.armies = this.options.flatMap((option) => (option.value === 'all' ? [] : [option.value]));
    // Until a released frame names the match's colours: the match rule over the granted armies. A one-army grant
    // cannot place itself among the others, so it stays uncoloured (named by its corner) until then.
    setArmyColours(this.armies.length > 1 ? defaultArmyColours(this.armies) : []);
    this.vision = this.options.find((option) => option.value === opts.perspective)?.value ?? this.options[0]!.value;
    world.observing = this.vision;
    this.matchId = opts.source?.kind === 'series' ? opts.source.matchId : undefined;
    this.el.dataset.preset = opts.source?.kind === 'series' ? 'benchmark' : 'broadcast';
    const stored = this.load();
    this.collapsed = new Set(stored.collapsed);
    // A phone has no stream toggle (it is a caster's desktop tool), so it never opens in stream mode.
    this.stream = !this.compact && stored.stream;
    this.el.toggleAttribute('data-compact', this.compact);
    this.badge.textContent = liveBadge(opts.grant.delayMs);
    this.matchLabel.textContent = opts.label ?? '';
    this.board.append(this.boardSides);
    this.minimap = new Minimap((plane, x, y) => this.jump(plane, x, y), world.size);
    this.audio = new AudioDirector(audioSink, listener, world.size);

    // Left column: per-side production / research / army; the all-planes overview.
    for (const [id, label, glyph] of [['production', 'Production', 'queue'], ['research', 'Research', 'research'], ['army', 'Army', 'units']] as const)
      this.tabs.append(h('button', { type: 'button', role: 'tab', class: 'btn small obs-tab', 'data-tab': id, 'aria-label': label, 'data-tip': `${label} · ${id === 'production' ? 'P' : id === 'research' ? 'R' : 'A'}`, onclick: () => this.showTab(id) }, icon(glyph, 14), label));
    this.left.append(
      this.panel('sides', 'Sides', 'units', this.tabs, this.sidesBody),
      this.panel('overview', 'All planes', 'overview', h('div', { class: 'obs-panel-body minimap-box obs-overview' }, this.minimap.el)),
    );
    this.right.append(this.panel('timeline', 'Timeline', 'time_cap', this.timelineBody), this.panel('agents', 'Agents', 'commanders', this.agentsBody));

    // Dock: planes, overview, vision, camera modes, stream, help, leave. `obs-desk` controls are hidden on a phone;
    // `obs-extra` ones show there only with More.
    for (const [index, plane] of PLANES.entries())
      this.planeBar.append(h('button', { type: 'button', class: 'btn small obs-plane', style: `--accent:${PLANE_ACCENT[plane]}`, 'data-plane': plane, 'aria-label': PLANE_NAME[plane], 'data-tip': `${PLANE_NAME[plane]} · F${index + 1}`, onclick: () => this.showPlane(plane) }, icon(plane, 16), h('kbd', {}, `F${index + 1}`)));
    this.overviewButton = control('All-planes overview · M', 'overview', () => this.toggle('overview'));
    this.planeBar.append(this.overviewButton);
    this.renderVision();
    this.directorButton = control('Auto-director: follows the action · C', 'director', () => this.toggleDirector(), 'Director');
    this.followButton = control('Click a unit to follow it · F or Esc stops', 'follow', () => this.stopFollow(), 'Follow');
    this.streamButton = control('Stream mode: scoreboard and badge only · B', 'stream', () => this.toggleStream());
    const palette = control('Side colours: standard / colour-blind safe', 'settings', () => this.togglePalette());
    const hotkeys = control('Hotkeys · H', 'keyboard', () => this.toggleHelp());
    const label = h('span', { class: 'obs-dock-label' }, icon('spectate', 14));
    for (const desk of [this.overviewButton, this.streamButton, palette, hotkeys, label]) desk.classList.add('obs-desk');
    this.directorButton.classList.add('obs-extra');
    this.status.classList.add('obs-extra');
    this.moreButton = this.compact ? control('More: side stats, director and status', 'more', () => this.toggleMore()) : undefined;
    this.dock.append(this.planeBar, label, this.visionBar, this.directorButton, this.followButton, this.streamButton, palette, hotkeys,
      ...(this.moreButton ? [this.moreButton] : []), control('Leave observer', 'leave', () => opts.onExit()), this.status);
    this.help.append(h('h2', {}, icon('keyboard', 18), 'Observer hotkeys'), h('dl', {}, ...HOTKEYS.flatMap(([keys, what]) => [h('dt', {}, keys), h('dd', {}, what)])), control('Close · Esc', 'cancel', () => this.toggleHelp(false), 'Close'));

    this.el.append(this.board, this.seriesBar, this.upcomingNote, this.left, this.right, this.dock, this.help, this.end);
    root.append(this.el);
    this.status.textContent = observerStatus(opts.grant.delayMs, 'Buffering');
    this.renderBoard(); this.renderSides(); this.renderTimeline(); this.renderAgents(); this.syncChrome();
    this.bindCamera(); this.bindKeys(); this.bindLayout();
    if (opts.source?.kind === 'series') {
      const source = opts.source;
      watchSeries(source.access, (result) => {
        this.seriesResult = result; this.series = seriesContext(result, this.matchId ?? '');
        this.renderSeries(); this.renderAgents(); this.renderBoard();
        // The next game of the series can start while the result shows.
        if (this.ended) this.renderEnd();
      }, this.seriesAbort.signal);
    }
    this.cleanups.push(() => this.seriesAbort.abort(), () => window.clearInterval(this.countdownTimer), () => window.clearInterval(this.upcomingTimer));
  }

  async start(): Promise<boolean> {
    try {
      await this.connect();
      if (this.disposed) { this.closeStreams(); return false; }
      return true;
    } catch { this.status.textContent = observerStatus(this.grant.delayMs, 'Observer admission failed or expired. Return to the lobby to request access.'); return false; }
  }

  /**
   * The streams the vision needs. A room or series grant is one projection, connected once. The featured relay serves
   * each perspective on its own: All's stream plus the chosen army's fog while it serves All, else every army's fog.
   */
  private async connect(): Promise<void> {
    if (this.opts.source?.kind === 'featured') { this.syncFeatured(); return; }
    for (const option of this.options) if (option.stream) await this.open(option.value);
  }

  private async open(perspective: ArmyId | 'all'): Promise<void> {
    const source = this.opts.source;
    const disconnected = (reason?: MatchCloseReason) => {
      if (!this.disposed) this.status.textContent = observerStatus(this.grant.delayMs, reason ? OBSERVER_CLOSED[reason] : 'Disconnected · no live fallback');
    };
    const stream: Stream = { perspective, feed: new ObserverFeed(perspective, (played) => this.played(stream, played), () => stream.conn?.resync()), conn: undefined, previous: undefined };
    const receive = (message: ObserverMessage) => this.receive(stream, message);
    stream.conn = source?.kind === 'featured'
      ? new FeaturedObserverConnection(perspective, receive, (match) => this.rotate(match), (upcoming) => this.announce(upcoming), disconnected, source.secret)
      : source
        ? await SeriesObserverConnection.join(source.access, this.matchId!, this.grant, receive, disconnected)
        : await ObserverConnection.join(this.opts.roomId!, this.opts.token!, this.grant, receive, disconnected);
    this.streams.set(perspective, stream);
  }

  /** Featured: open the streams the current vision needs and close the others (bounded bytes per viewer). */
  private syncFeatured(): void {
    const wanted = new Set<string>(this.options[0]?.value === 'all' ? ['all', this.vision] : this.options.map((option) => option.value));
    for (const [perspective, stream] of this.streams) if (!wanted.has(perspective)) { stream.conn?.close(); this.streams.delete(perspective); }
    for (const option of this.options) if (wanted.has(option.value) && !this.streams.has(option.value)) void this.open(option.value);
  }

  /**
   * Featured: the relay's announcement names the match's armies (a duel or a four-army FFA), its matchup line, its
   * release delay and whether it serves All (a built-in-bot match, or a public game whose policy allows it): All when
   * served, then one vision per army.
   */
  private serve(match: FeaturedMatch): void {
    const armies = match.armies.filter(isArmyId);
    if (!armies.length) return;
    this.matchLabel.textContent = match.label || (this.opts.label ?? '');
    const delayMs = match.delayMs;
    this.badge.textContent = liveBadge(delayMs);
    const grant: ObserverGrant = match.omniscient ? { kind: 'omniscient', teams: armies, delayMs } : { kind: 'team', team: armies[0]!, delayMs };
    const options = visionOptions(grant, armies);
    this.grant = grant;
    if (options.map((option) => option.value).join() === this.options.map((option) => option.value).join()) return;
    this.options = options;
    // Until a released frame of this match names its colours: the match rule over the announced armies.
    if (this.armies.join() !== armies.join()) {
      this.armies = armies;
      setArmyColours(armies.length > 1 ? defaultArmyColours(armies) : []);
      this.renderBoard(); this.renderSides(); this.renderAgents();
    }
    if (!this.options.some((option) => option.value === this.vision)) { this.vision = this.options[0]!.value; this.world.observing = this.vision; }
    this.renderVision(); this.syncChrome(); this.syncFeatured();
  }

  private closeStreams(): void { for (const stream of this.streams.values()) stream.conn?.close(); this.streams.clear(); }

  /** Drop everything shown: a new match (featured rotation, series jump) starts at its first keyframe. */
  private restart(): void {
    this.all = undefined; this.worldView = undefined; this.terminal = false; this.clearEnd();
    this.boards.clear(); this.disclosed = []; this.agentCards = []; this.timeline.reset(); this.director.reset(); this.stopFollow();
    for (const stream of this.streams.values()) { stream.previous = undefined; stream.feed.reset(stream.perspective); }
    this.world.reset();
    this.renderBoard(); this.renderSides(); this.renderTimeline(); this.renderAgents();
  }

  /**
   * The featured relay announced its next match (each stream announces it; restart once). While a result shows, the
   * next match waits off screen (its frames are dropped) until Watch now or the countdown moves on; the runtime's
   * loader then holds until its first frame.
   */
  private rotate(match: FeaturedMatch): void {
    if (match.roomId === this.featuredRoom) { this.featuredSeats = match.seats; this.renderAgents(); this.serve(match); return; }
    if (this.ended) {
      this.nextMatch = match;
      if (this.continueWanted) this.continueNext(); else this.syncEnd();
      return;
    }
    if (this.featuredRoom) this.cut(match);
    else { this.featuredSeats = match.seats; this.featuredRoom = match.roomId; }
    this.renderAgents();
    this.serve(match);
  }

  /**
   * Featured: a new match on air replaces the one shown. A public game the relay cut over to names itself on the
   * loader card ("Live: public game") while the runtime holds for its first frame.
   */
  private cut(match: FeaturedMatch): void {
    this.featuredSeats = match.seats; this.featuredRoom = match.roomId;
    this.transition = match.public ? ['Live: public game', match.label].filter(Boolean).join(' · ') : undefined;
    this.restart();
  }

  /** The loader's line while it holds for the match on air (the runtime asks on every world drop). */
  loadingNote(): string | undefined {
    return this.transition;
  }

  /** Featured: the relay's notice of a public game about to go on air (null: none), counted down every second. */
  private announce(upcoming: FeaturedUpcoming | null): void {
    window.clearInterval(this.upcomingTimer);
    this.upcoming = upcoming ? { label: upcoming.label, at: performance.now() + upcoming.liveInMs } : undefined;
    this.renderUpcoming();
    if (this.upcoming) this.upcomingTimer = window.setInterval(() => this.renderUpcoming(), 1000);
  }

  private renderUpcoming(): void {
    const upcoming = this.upcoming;
    this.upcomingNote.hidden = !upcoming;
    if (!upcoming) return;
    this.upcomingNote.textContent = upcomingNotice(upcoming.at - performance.now());
    this.upcomingNote.dataset.tip = upcoming.label;
  }

  /** Benchmark: watch another running game of the same series (fresh admission for that match). */
  private async jumpMatch(matchId: string): Promise<void> {
    const source = this.opts.source;
    if (source?.kind !== 'series' || matchId === this.matchId) return;
    const admission = await arenaRequest<{ grant: ObserverGrant }>(source.access, `/matches/${encodeURIComponent(matchId)}/observer`, undefined, this.seriesAbort.signal);
    if (this.disposed) return;
    this.closeStreams();
    this.grant = admission.grant; this.matchId = matchId;
    this.restart();
    if (this.seriesResult) { this.series = seriesContext(this.seriesResult, matchId); this.renderSeries(); }
    this.status.textContent = observerStatus(this.grant.delayMs, 'Buffering');
    await this.connect();
  }

  private receive(stream: Stream, message: ObserverMessage): void {
    // A held next match (featured): the result stays on screen; its stream resynchronizes when it is shown.
    if (this.disposed || this.nextMatch) return;
    if (message.state !== 'ready' || !message.frame) {
      if (!this.worldView) this.status.textContent = observerStatus(this.grant.delayMs, message.state === 'closed' ? 'Stream closed' : 'Buffering');
      return;
    }
    stream.feed.receive(message);
  }

  /** One played frame of one stream (paced by its feed's playout clock). */
  private played(stream: Stream, { frame, world }: PlayedFrame): void {
    const projection = world as ObserverView | View;
    if (frame.commentary?.length) this.disclosed = [...this.disclosed, ...frame.commentary].slice(-200);
    if (frame.agentCards) this.agentCards = frame.agentCards;
    if (frame.outcomes && Object.values(frame.outcomes).every((outcome) => outcome !== 'running')) {
      if (!this.terminal) this.endTick = frame.tick;
      this.terminal = true; this.outcomes = frame.outcomes;
    }
    if ('world' in projection) {
      const resolved = matchView(projection.world, stream.previous);
      if (!resolved) return;
      // The omniscient row (and every lens over it) names entities by sim id, not as any army does.
      resolved.names = 'sim';
      stream.previous = resolved;
      this.adopt(resolved.match);
      this.all = projection;
      for (const side of projection.sides) {
        this.boards.set(side.army, observerBoard(side)); this.timeline.ingest(side.army, side.events);
        if (side.rank !== undefined) this.ranks.set(side.army, side.rank);
      }
      // All, or a lens over it: a fog without its own stream, or a featured army's fog until its stream has played.
      if (this.vision === 'all') this.show(resolved);
      else if (!this.streams.get(this.vision)?.previous) {
        const lens = projection.sides.find((side) => side.army === this.vision);
        if (lens) this.show(lensView(resolved, lens));
      }
    } else {
      const resolved = matchView(projection, stream.previous);
      if (!resolved) return;
      stream.previous = resolved;
      this.adopt(resolved.match);
      // Beside the featured All stream, the omniscient projection fills every board and the timeline.
      if (!this.streams.has('all')) {
        this.boards.set(resolved.army, viewBoard(resolved, resolved.army));
        if (resolved.rank !== undefined) this.ranks.set(resolved.army, resolved.rank);
        // Armies without their own stream are shown as this army sees them.
        for (const army of this.armies) if (!this.streams.has(army) && army !== resolved.army) this.boards.set(army, viewBoard(resolved, army));
        this.timeline.ingest(resolved.army, resolved.events);
      }
      if (stream.perspective === this.vision) this.show(resolved);
    }
    const now = performance.now();
    if (!this.terminal && now - this.renderedAt < PANEL_REFRESH_MS) return;
    this.renderedAt = now;
    this.renderBoard(); this.renderSides(); this.renderTimeline(); this.renderAgents();
    const tick = this.worldView?.tick ?? frame.tick;
    this.status.textContent = observerStatus(this.grant.delayMs, `${this.terminal ? 'Ended · released playback complete' : 'Released playback'} · tick ${tick} · ${Math.round(stream.feed.rate)} fps stream · ${this.vision === 'all' ? 'No fog' : `${this.sideName(this.vision)} fog`}`);
    if (this.terminal) this.renderEnd();
  }

  /** A released frame's match: its armies (a team grant only names its own) and their colours label every panel. */
  private adopt(match: MatchView['match']): void {
    if (match === this.adopted) return;
    this.adopted = match;
    setArmyColours(match.armies);
    this.armies = match.armies.map((army) => army.id);
    this.renderVision();
    this.syncChrome();
  }

  /** One vision button per permitted perspective, in its army's ink and colour name (on a phone with more than two
   *  armies, its initial: All and four armies still fit the compact strip). */
  private renderVision(): void {
    const initials = this.compact && this.options.length > 3;
    patch(this.visionBar, this.options.map((option) => (option.value === 'all' ? 'all' : `${option.value}:${colourOf(option.value)}`)).join(), () => this.options.map((option) => {
      const name = option.value === 'all' ? 'All' : this.sideName(option.value);
      return h('button', { type: 'button', class: 'btn small', role: 'radio', 'data-vision': option.value, 'data-team': option.value === 'all' ? undefined : option.value, style: option.value === 'all' ? undefined : `--side-ink:${sideInk(option.value)}`, 'aria-label': `Vision: ${name}`, 'data-tip': option.value === 'all' ? 'All · no fog · V' : `${name}'s fog · V`, onclick: () => this.setVision(option.value) }, icon(option.value === 'all' ? 'spectate' : 'fog', 14), initials && option.value !== 'all' ? name.slice(0, 1) : name);
    }));
  }

  /** Put a view on screen; a change of fogged army or id namespace keeps the camera where the caster left it. */
  private show(view: MatchView): void {
    const rig = this.world.rig;
    // Within one match (restart() clears worldView for another match): another army's fog or id namespace is a
    // perspective switch, shown in place with no loader.
    const moved = this.worldView !== undefined && (this.worldView.army !== view.army || idSpace(this.worldView) !== idSpace(view));
    const keep = moved ? { tx: rig.tx, tz: rig.tz, yaw: rig.yaw, pitch: rig.pitch, dist: rig.dist } : undefined;
    // A followed track's id names nothing (or something else) in another namespace.
    if (this.worldView && idSpace(this.worldView) !== idSpace(view)) this.stopFollow();
    void this.world.setView(view, moved);
    if (keep) Object.assign(rig, keep);
    if (!this.worldView) {
      listener.plane = rig.focus;
      setAudioScene('match');
    }
    this.worldView = view;
    // The omniscient perspective reads every army's event window; a fog (lens or stream) only its own view.
    this.director.ingest(view, this.vision, this.vision === 'all' ? this.all?.sides : undefined);
    this.audio.ingest(view, this.world.entities.renderTick);
    this.clock.textContent = gameClock(view.tick);
    this.suddenDeath.update(view.match.rules, view.tick);
    this.crowns = view.crowns;
    this.matchPoint.update(view.match.rules, view.crowns, view.eliminated, (army) => this.sideName(army));
  }

  private setVision(value: ArmyId | 'all'): void {
    const option = this.options.find((entry) => entry.value === value);
    if (!option || value === this.vision) return;
    this.vision = value;
    this.world.observing = value;
    this.syncChrome();
    if (this.opts.source?.kind === 'featured') this.syncFeatured();
    const latest = option.stream ? this.streams.get(value)?.previous : undefined;
    if (latest) { this.show(latest); return; }
    // A lens over the omniscient stream (also while a featured army's own stream starts): the next played frame applies
    // it; show the current one through it now.
    const all = this.streams.get('all')?.previous;
    const side = this.all?.sides.find((entry) => entry.army === value);
    if (all && side) this.show(lensView(all, side));
  }

  private cycleVision(): void {
    const index = this.options.findIndex((option) => option.value === this.vision);
    this.setVision(this.options[(index + 1) % this.options.length]!.value);
  }

  // ------------------------------------------------------------------ panels

  private panel(id: PanelId, title: string, glyph: IconName, ...body: HTMLElement[]): HTMLElement {
    const head = h('button', { type: 'button', class: 'obs-panel-head', 'aria-label': `${title} panel`, 'data-tip': `Show or hide · ${PANEL_KEYS[id]}`, onclick: () => this.toggle(id) }, icon(glyph, 16), h('span', {}, title), h('kbd', {}, PANEL_KEYS[id]));
    const el = h('section', { class: 'obs-face obs-panel', 'data-panel': id, 'aria-label': title }, head, ...body);
    this.panels.set(id, el);
    return el;
  }

  private toggle(id: PanelId, open?: boolean): void {
    const show = open ?? this.collapsed.has(id);
    if (show) this.collapsed.delete(id); else this.collapsed.add(id);
    this.save(); this.syncChrome();
  }

  private showTab(tab: SideTab): void { this.tab = tab; this.toggle('sides', true); this.renderSides(); }

  private toggleStream(): void { this.stream = !this.stream; this.save(); this.syncChrome(); }

  private toggleMore(): void { this.more = !this.more; this.syncChrome(); }

  private toggleDirector(): void { this.directorOn = !this.directorOn; this.manualUntil = 0; this.director.release(); this.directorCamera.release(); this.syncChrome(); }

  private toggleHelp(open = this.help.hidden): void { this.help.hidden = !open; }

  private togglePalette(): void {
    const accessible = this.el.dataset.palette !== 'accessible';
    this.el.dataset.palette = accessible ? 'accessible' : 'standard';
    this.applyPalette(accessible);
  }

  private readonly originalHex: Readonly<Record<Colour, string>> = { blue: SIDE_HEX.blue, red: SIDE_HEX.red, green: SIDE_HEX.green, violet: SIDE_HEX.violet };
  /** Swaps all four army colours (drawn and ink) in place; leaving the observer restores the standard palette. */
  private applyPalette(accessible: boolean): void {
    for (const colour of COLOURS) {
      const hex = accessible ? ACCESSIBLE_HEX[colour] : this.originalHex[colour];
      SIDE_HEX[colour] = hex; SIDE_COLOR[colour].set(hex);
    }
    for (const node of this.el.querySelectorAll<HTMLElement>('[data-team]')) node.style.setProperty('--side-ink', sideInk(node.dataset.team!));
  }

  /** Reflect panel, mode and camera state on the chrome (cheap; only attributes). */
  private syncChrome(): void {
    for (const [id, panel] of this.panels) {
      const open = !this.collapsed.has(id);
      panel.dataset.collapsed = String(!open);
      panel.querySelector('.obs-panel-head')?.setAttribute('aria-expanded', String(open));
    }
    this.overviewButton.setAttribute('aria-pressed', String(!this.collapsed.has('overview')));
    this.el.toggleAttribute('data-stream', this.stream);
    this.streamButton.setAttribute('aria-pressed', String(this.stream));
    this.el.toggleAttribute('data-more', this.more);
    this.moreButton?.setAttribute('aria-pressed', String(this.more));
    for (const button of this.visionBar.querySelectorAll<HTMLElement>('[data-vision]')) button.setAttribute('aria-checked', String(button.dataset.vision === this.vision));
    for (const button of this.tabs.querySelectorAll<HTMLElement>('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === this.tab));
    const held = this.directorOn && performance.now() < this.manualUntil;
    // Watch live and stream mode get the broadcast preset: longer holds, regular overviews, roomier framing.
    this.director.preset = this.stream || this.opts.source?.kind === 'featured' ? DIRECTOR_STREAM : DIRECTOR_LIVE;
    this.directorButton.setAttribute('aria-pressed', String(this.directorOn));
    this.directorButton.dataset.state = !this.directorOn ? 'off' : this.follow ? 'follow' : held ? 'held' : 'on';
    this.followButton.hidden = !this.follow;
    this.followButton.setAttribute('aria-pressed', String(!!this.follow));
  }

  /** An army's name: its series entrant, else its colour (its corner while the match's colours are unknown). */
  private sideName(army: string): string {
    const label = this.series?.sides.find((side) => side.team === army)?.label;
    if (label) return label;
    if (!isArmyId(army)) return 'Neutral';
    const colour = colourOf(army);
    return colour === 'neutral' ? CORNER_LABEL[army] : COLOUR_LABEL[colour];
  }

  /** The scoreboard: one column per army (data-driven, two to four armies) around the clock and delay badge. */
  private renderBoard(): void {
    const armies = this.armies;
    // The phone strip lays four armies out differently from two (observer.css).
    this.el.dataset.armies = String(armies.length);
    const key = `${armies.join()}|${armies.map((army) => this.sideName(army)).join()}`;
    patch(this.boardSides, key, () => {
      const columns = armies.map((army, index) => h('section', { class: 'obs-side', 'data-team': army, 'data-align': index < armies.length / 2 ? 'start' : 'end', style: `--side-ink:${sideInk(army)}`, 'aria-label': this.sideName(army) },
        h('div', { class: 'obs-side-name' }, h('i', { class: 'obs-swatch', 'aria-hidden': 'true' }), h('b', {}, this.sideName(army))),
        h('div', { class: 'obs-stats' },
          h('span', { class: 'obs-stat hud-chip alloy', 'data-stat': 'alloy', 'data-tip': 'Alloy · income per second' }, icon('alloy', 16), h('b', {}), h('small', {})),
          h('span', { class: 'obs-stat hud-chip energy', 'data-stat': 'energy', 'data-tip': 'Energy · income per second' }, icon('energy', 16), h('b', {}), h('small', {})),
          h('span', { class: 'obs-stat hud-chip army', 'data-stat': 'army', 'data-tip': 'Army: units and their replacement value (alloy + energy)' }, icon('units', 16), h('b', {}), h('small', {})),
          h('span', { class: 'obs-spire hud-chip', 'aria-label': 'Spire health by plane' }, ...[...PLANES].reverse().map((plane) => h('span', { class: 'obs-spire-seg', 'data-plane': plane, style: `--accent:${PLANE_ACCENT[plane]}` }, icon(plane, 12), h('i', { class: 'obs-hp' }, h('i', {}))))),
          h('span', { class: 'obs-crowns hud-chip', 'data-stat': 'crowns', hidden: true }))));
      const center = h('div', { class: 'obs-center' }, this.clock, this.suddenDeath.el, this.matchPoint.el, this.badge, this.matchLabel);
      columns.splice(Math.ceil(armies.length / 2), 0, center);
      return columns;
    });
    for (const column of this.boardSides.querySelectorAll<HTMLElement>('.obs-side')) {
      const board = this.boards.get(column.dataset.team as ArmyId);
      const set = (stat: string, value: string, detail: string, tipText: string) => {
        const el = column.querySelector<HTMLElement>(`[data-stat="${stat}"]`)!;
        el.children[1]!.textContent = value; el.children[2]!.textContent = detail;
        el.setAttribute('aria-label', tipText);
      };
      const res = board?.res;
      set('alloy', res ? ledgerNumber(res.alloy) : '—', res ? ledgerRate(res.alloyRate) : '', res ? `Alloy ${res.alloy}, ${ledgerRate(res.alloyRate)}` : 'Alloy hidden by fog');
      set('energy', res ? ledgerNumber(res.energy) : '—', res ? ledgerRate(res.energyRate) : '', res ? `Energy ${res.energy}, ${ledgerRate(res.energyRate)}` : 'Energy hidden by fog');
      set('army', board?.forces ? ledgerNumber(board.forces.value) : '—', board?.forces ? `${board.forces.units} units` : '', board?.forces ? `Army ${board.forces.units} units worth ${board.forces.value}` : 'Army hidden by fog');
      column.classList.toggle('fogged', !!board && !board.disclosed);
      const crowns = column.querySelector<HTMLElement>('[data-stat="crowns"]')!;
      const rules = this.adopted?.rules;
      const row = this.crowns?.find((entry) => entry.army === column.dataset.team);
      crowns.hidden = !crownsOn(rules) || !row;
      const pips = row && rules && crownsOn(rules) ? JSON.stringify(row) : '';
      if (crowns.dataset.key !== pips) {
        crowns.dataset.key = pips;
        crowns.replaceChildren(...(row && pips ? [crownPips(row, rules!, this.sideName(row.army))] : []));
      }
      for (const seg of column.querySelectorAll<HTMLElement>('.obs-spire-seg')) {
        const plane = seg.dataset.plane as Plane;
        const hp = board?.spire[plane];
        const ratio = hp ? Math.max(0, Math.min(1, hp.hp / hp.maxHp)) : 0;
        seg.style.setProperty('--health', `${ratio * 100}%`);
        seg.dataset.state = !hp ? 'unknown' : ratio === 0 ? 'dead' : ratio < 0.35 ? 'low' : 'ok';
        seg.setAttribute('aria-label', `${PLANE_NAME[plane]} Spire: ${hp ? `${hp.hp} / ${hp.maxHp} HP` : 'not visible'}`);
      }
    }
  }

  private renderSides(): void {
    this.syncChrome();
    const sides = this.armies.map((army) => ({ army, board: this.boards.get(army) }));
    const entities = this.worldView?.entities ?? [];
    const key = `${this.tab}|${sides.map(({ army, board }) => {
      if (!board) return `${army}:${this.sideName(army)}`;
      if (this.tab === 'production') return `${army}:${this.sideName(army)}:${board.queue.map((entry) => `${entry.id}${queueStatus(entry)}`).join()}`;
      if (this.tab === 'research') return `${army}:${this.sideName(army)}:${board.research ? `${board.research.inProgress}${board.research.completed}${board.research.available}` : '-'}`;
      return `${army}:${this.sideName(army)}:${board.forces?.value}:${JSON.stringify(composition(entities, army))}`;
    }).join('|')}`;
    patch(this.sidesBody, key, () => sides.map(({ army, board }) => {
      const section = h('section', { class: 'obs-side-detail', 'data-team': army, style: `--side-ink:${sideInk(army)}` }, h('h3', {}, h('i', { class: 'obs-swatch', 'aria-hidden': 'true' }), this.sideName(army)));
      if (!board || !board.disclosed && this.tab !== 'army') { section.append(h('p', { class: 'muted' }, board ? 'Hidden by fog' : 'Waiting for released frames')); return section; }
      if (this.tab === 'production') {
        const items = board.queue.filter((entry) => !isUpgrade(entry.item));
        section.append(items.length ? h('ul', { class: 'obs-queue' }, ...items.slice(0, 12).map((entry) => {
          const label = queueLabel(entry);
          return h('li', {}, h('button', { type: 'button', class: 'obs-row', style: `--accent:${PLANE_ACCENT[entry.plane]}`, 'aria-label': `${label} · ${queueStatus(entry)}`, 'data-tip': `${label} · ${PLANE_NAME[entry.plane]} · ${queueStatus(entry)}`, onclick: () => this.focusEntry(entry, board.names) },
            icon(entry.item, 16), h('span', { class: 'obs-row-label' }, label), h('i', { class: 'obs-progress', style: `--p:${Math.round(entry.progress * 100)}%` }), h('small', {}, queueStatus(entry))));
        })) : h('p', { class: 'muted' }, 'Nothing queued'));
      } else if (this.tab === 'research') {
        const research = board.research!;
        section.append(h('ul', { class: 'obs-queue' },
          ...research.completed.map((id) => h('li', { class: 'obs-row done', 'aria-label': `${UPGRADES[id].label} researched` }, icon(id, 16), h('span', { class: 'obs-row-label' }, UPGRADES[id].label), icon('check', 14))),
          ...research.inProgress.map((id) => { const entry = board.queue.find((queued) => queued.item === id); return h('li', { class: 'obs-row', 'aria-label': `${UPGRADES[id].label} researching` }, icon(id, 16), h('span', { class: 'obs-row-label' }, UPGRADES[id].label), h('i', { class: 'obs-progress', style: `--p:${Math.round((entry?.progress ?? 0) * 100)}%` }), h('small', {}, entry ? queueStatus(entry) : '…')); }),
        ));
        if (!research.completed.length && !research.inProgress.length) section.append(h('p', { class: 'muted' }, 'No research yet'));
        if (research.available.length) section.append(h('p', { class: 'muted small' }, `${research.available.length} available`));
      } else {
        const rows = composition(entities, army);
        if (board.forces) section.append(h('p', { class: 'obs-army-total' }, icon('units', 14), `${board.forces.units} units · ${ledgerNumber(board.forces.value)} value`));
        section.append(rows.length ? h('ul', { class: 'obs-comp' }, ...rows.map((row) => h('li', { style: `--accent:${PLANE_ACCENT[row.plane]}` },
          h('span', { class: 'obs-comp-plane', 'data-tip': PLANE_NAME[row.plane], 'aria-label': PLANE_NAME[row.plane] }, icon(row.plane, 14)),
          ...row.kinds.map(({ kind, count }) => h('span', { class: 'obs-unit chip', 'data-tip': KIND_LABEL[kind], 'aria-label': `${count} ${KIND_LABEL[kind]}` }, icon(kind, 14), String(count)))))) : h('p', { class: 'muted' }, board.disclosed ? 'No units' : 'None in sight'));
      }
      return section;
    }));
  }

  /** What happened, read after the acting side's name ("Blue · destroyed Tank ×2"). */
  private momentText(moment: Moment): string {
    const times = moment.count > 1 ? ` ×${moment.count}` : '';
    if (moment.kind === 'kill') return `destroyed ${moment.subject ? KIND_LABEL[moment.subject] : 'a unit'}${times}`;
    if (moment.kind === 'spire') return `hit ${moment.victim ? `${this.sideName(moment.victim)}'s` : 'the'} ${PLANE_NAME[moment.plane]} Spire${times}`;
    if (moment.kind === 'capture') return `captured an island${times}`;
    return `${BREAKTHROUGH[moment.event] ?? 'broke through'}${times}`;
  }

  private renderTimeline(): void {
    patch(this.timelineBody, `${this.timeline.revision}|${this.armies.map((army) => this.sideName(army)).join()}`, () => {
      // Streams play out independently: newest game time first, not arrival order.
      const moments = this.timeline.moments.toSorted((a, b) => b.tick - a.tick).slice(0, 60);
      if (!moments.length) return [h('li', { class: 'muted obs-empty' }, 'Kills, Spire hits, captures and breakthroughs appear here')];
      return moments.map((moment) => {
        const text = this.momentText(moment);
        const team = moment.team ?? '';
        return h('li', {}, h('button', { type: 'button', class: `ev obs-moment ${moment.kind}`, 'data-team': team, style: `--side-ink:${sideInk(team)}`, 'aria-label': `Jump to ${team ? `${this.sideName(team)} ` : ''}${text}`, 'data-tip': `Jump to ${PLANE_NAME[moment.plane]}: ${team ? `${this.sideName(team)} ` : ''}${text}`, onclick: () => this.jump(moment.plane, moment.x, moment.y) },
          h('span', { class: 'ev-t' }, gameClock(moment.tick)),
          h('span', { class: 'ev-p', style: `--accent:${PLANE_ACCENT[moment.plane]}` }, icon(moment.plane, 14)),
          icon(moment.subject && moment.kind === 'kill' ? moment.subject : moment.event, 14),
          h('span', { class: 'ev-text' }, team ? h('b', {}, `${this.sideName(team)} `) : null, text)));
      });
    });
  }

  private identity(team: string, role: Plane): AgentIdentity | undefined {
    const card = this.agentCards.find((entry) => entry.team === team && entry.role === role)?.card;
    if (card) return entrantAgent(card);
    const seat = this.featuredSeats.find((entry) => entry.team === team && entry.role === role);
    if (!seat) return undefined;
    return seat.kind === 'bot' ? { kind: 'bot', name: 'Bot', detail: OPP_LABEL[seat.level as keyof typeof OPP_LABEL] ?? seat.level } : { kind: seat.kind, name: seat.name ?? 'Player' };
  }

  private renderAgents(): void {
    const series = this.series;
    // The featured room is in the key: two matches on air in turn can field as many seats with different occupants.
    const key = `${this.agentCards.length}|${this.featuredRoom}|${this.featuredSeats.length}|${this.disclosed.length}|${this.disclosed.at(-1)?.id}|${this.seriesResult?.revision}|${this.armies.map((army) => this.sideName(army)).join()}`;
    patch(this.agentsBody, key, () => this.armies.map((team) => {
      const chatter = this.disclosed.filter((message) => message.team === team).slice(-3).reverse();
      const seats = [...PLANES].reverse().map((role) => ({ role, identity: this.identity(team, role) }));
      const entrant = series?.sides.find((side) => side.team === team)?.entrantId;
      const stats = entrant ? series?.agents.find((agent) => agent.entrantId === entrant) : undefined;
      return h('section', { class: 'obs-agent-side', 'data-team': team, style: `--side-ink:${sideInk(team)}` },
        h('h3', {}, h('i', { class: 'obs-swatch', 'aria-hidden': 'true' }), this.sideName(team)),
        h('ul', { class: 'obs-seats' }, ...seats.map(({ role, identity }) => h('li', { style: `--accent:${PLANE_ACCENT[role]}` }, h('span', { class: 'obs-seat-plane', 'data-tip': PLANE_NAME[role], 'aria-label': PLANE_NAME[role] }, icon(role, 14)),
          identity ? agentButton(identity, { size: 'small' }) : h('span', { class: 'muted small' }, 'Not disclosed')))),
        stats ? this.statsTable(stats) : null,
        h('div', { class: 'obs-chatter', 'aria-label': 'Public chatter' }, ...(chatter.length ? chatter.map((message) => h('p', { class: 'obs-chat' }, icon(message.role as Plane, 12), h('small', {}, gameClock(message.tick)), h('span', {}, message.text))) : [h('p', { class: 'muted small' }, 'No public chatter')])));
    }));
  }

  private statsTable(stats: SeriesContext['agents'][number]): HTMLElement {
    const value = (n: number | null | undefined, digits = 0) => n == null ? '—' : digits ? n.toFixed(digits) : ledgerNumber(n);
    const rows: [string, string, string][] = [
      ['Recorded', `${stats.seats} seat-games`, 'Completed games of this series behind these numbers; the live game counts once it ends'],
      ['APM', value(stats.apm, 1), 'Commands per minute (mean over this series’ completed games)'],
      ['Intents ✓ / ✗', `${value(stats.accepted)} / ${value(stats.rejected)}`, 'Accepted / rejected intents (series so far)'],
      ['Latency p50 / p95', stats.latency ? `${value(stats.latency.p50)} / ${value(stats.latency.p95)} ms` : '—', stats.latency ? `${stats.latency.source} decision latency` : 'Not published'],
      ['Tokens in / out', stats.tokens ? `${value(stats.tokens.input)} / ${value(stats.tokens.output)}` : '—', stats.tokens ? 'Inference tokens (reported coverage may be partial)' : 'Not reported'],
      ['Cost', stats.cost ? `${stats.cost.amount} ${stats.cost.currency ?? ''}`.trim() : '—', stats.cost ? 'Reported inference cost; unknown is not zero' : 'Not reported'],
    ];
    return h('dl', { class: 'obs-agent-stats', 'aria-label': `${stats.label} series stats` }, ...rows.flatMap(([label, text, hint]) => [h('dt', { 'data-tip': hint }, label), h('dd', {}, text)]));
  }

  private renderSeries(): void {
    const series = this.series;
    const source = this.opts.source;
    if (!series || source?.kind !== 'series') return;
    const results = h('a', { class: 'btn small', href: resultsHref(source.access), 'data-tip': 'Series results page', 'aria-label': 'Series results', onclick: (event: Event) => { event.preventDefault(); this.opts.onExit(); } }, icon('standings', 14), 'Results');
    patch(this.seriesBar, JSON.stringify(series), () => [
      h('b', { class: 'obs-series-title' }, icon('standings', 16), series.title),
      h('span', { class: 'hud-stamp obs-series-game' }, series.game ? `Game ${series.game} of ${series.games}` : `${series.completed} of ${series.games} played`),
      h('span', { class: 'obs-standings', 'aria-label': 'Standings' }, ...series.standings.map((row) => h('span', { class: 'chip', 'data-tip': `${row.label}: ${row.wins} wins, ${row.losses} losses, ${row.draws} draws` }, h('b', {}, row.label), ` ${row.wins}–${row.losses}${row.draws ? `–${row.draws}` : ''}`))),
      h('span', { class: 'obs-rotation', 'aria-label': 'Map rotation' }, ...series.rotation.map((row, index) => h('span', { class: `obs-map${row.current ? ' current' : ''}${row.done ? ' done' : ''}`, 'data-tip': `Game ${index + 1} · ${row.mapId}${row.done ? ' · played' : ''}`, 'aria-label': `Game ${index + 1} ${row.mapId}` }, String(index + 1)))),
      series.sides.length ? h('span', { class: 'obs-swap', 'data-tip': series.swapped ? 'Sides swapped for this game' : 'Original sides', 'aria-label': series.swapped ? 'Sides swapped' : 'Original sides' }, icon('swap', 14), ...series.sides.map((side) => h('span', { style: `--side-ink:${sideInk(side.team)}`, 'data-team': side.team }, side.label))) : null,
      series.live.length > 1 ? h('span', { class: 'obs-live-games', 'aria-label': 'Running games' }, ...series.live.map((game) => h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(game.current), 'data-tip': `Watch ${game.label} · [ ]`, 'aria-label': `Watch ${game.label}`, onclick: () => void this.jumpMatch(game.matchId).catch(() => { this.status.textContent = observerStatus(this.grant.delayMs, 'That game is unavailable'); }) }, icon('spectate', 14), game.label))) : null,
      results,
    ]);
  }

  // ------------------------------------------------------------------ end card

  /**
   * The released final frame (never earlier: playback runs on the delay clock) shows the result card once, with the
   * outcome sting; it then refreshes as the other streams' final frames and the series land. Folded, it is a banner.
   */
  private renderEnd(): void {
    const match = this.adopted;
    const outcomes = this.outcomes;
    if (!match || !outcomes) return;
    if (!this.ended) {
      this.ended = true; this.endOpen = true;
      // Observers take no side: a decided match plays the victory sting, a draw what the players hear for one.
      audioOutcome(Object.values(outcomes).includes('win') ? 'win' : 'draw');
      if (this.opts.source?.kind === 'featured') this.startCountdown();
    }
    const rows = standings(match.armies, outcomes, this.ranks, this.boards);
    const reason = endReason(this.endTick, match.rules.spire.timeCap * TICK_RATE, this.finalEvents(), (army, plane) => this.boards.get(army)?.spire[plane]?.hp);
    const label = endLabel(reason, this.endTick, this.finalEvents(), this.crowns, (army) => this.sideName(army));
    const series = this.series;
    const next = series?.live.find((game) => !game.current);
    const continues = series?.state === 'queued' || series?.state === 'running';
    patch(this.endCard, JSON.stringify([rows, label, rows.map((row) => this.sideName(row.army)), next?.matchId, continues, series?.game]), () => this.endContent(rows, label, next, continues));
    this.syncEnd();
  }

  /** Every event window on hand: the omniscient rows, else each stream's own view (eliminations reach every army). */
  private *finalEvents(): Iterable<GameEvent> {
    if (this.all) for (const side of this.all.sides) yield* side.events;
    for (const stream of this.streams.values()) if (stream.previous) yield* stream.previous.events;
  }

  private endContent(rows: readonly Standing[], reason: string, next: SeriesContext['live'][number] | undefined, continues: boolean): HTMLElement[] {
    const winners = rows.filter((row) => row.outcome === 'win');
    const lead = winners[0];
    const colour = lead ? colourOf(lead.army) : 'neutral';
    const title = !lead ? 'Draw' : winners.length === 1 ? `${this.sideName(lead.army)} wins` : `${colour === 'neutral' ? 'Alliance' : `${COLOUR_LABEL[colour]} alliance`} wins`;
    const seconds = Math.floor(this.endTick / TICK_RATE);
    const meta = [this.matchLabel.textContent, `${Math.floor(seconds / 60)}m ${seconds % 60}s`, reason].filter(Boolean).join(' · ');
    this.endCard.className = `outcome-card obs-end-card ${lead ? 'win' : 'draw'}`;
    this.endCard.style.setProperty('--side-ink', lead ? sideInk(lead.army) : 'var(--warn)');
    if (lead) this.endCard.dataset.team = lead.army; else delete this.endCard.dataset.team;
    const fold = h('button', { type: 'button', class: 'btn small obs-end-fold', 'data-end-action': 'fold', onclick: () => this.toggleEnd() });
    return [
      h('div', { class: 'obs-end-head' },
        h('div', { class: 'outcome-kicker' }, this.series?.game ? `Game ${this.series.game} of ${this.series.games} · final` : 'Match over'),
        h('div', { class: 'outcome-title' }, title),
        h('div', { class: 'outcome-meta' }, meta),
        fold),
      h('ol', { class: 'obs-end-ranks', 'aria-label': 'Final standings' }, ...rows.map((row) => {
        const name = this.sideName(row.army);
        const forces = row.forces ? `${row.forces.units} units · ${ledgerNumber(row.forces.value)}` : '—';
        const spire = row.spire ? `${ledgerNumber(row.spire.hp)} / ${ledgerNumber(row.spire.maxHp)}` : '—';
        return h('li', { 'data-team': row.army, 'data-outcome': row.outcome, style: `--side-ink:${sideInk(row.army)}` },
          h('b', { class: 'obs-end-place' }, row.rank === undefined ? '—' : placeLabel(row.rank)),
          h('span', { class: 'obs-end-name' }, h('i', { class: 'obs-swatch', 'aria-hidden': 'true' }), h('span', {}, name)),
          h('span', { class: 'obs-end-result' }, RESULT_WORD[row.outcome]),
          h('span', { class: 'obs-end-stat', 'data-stat': 'army', 'data-tip': 'Army left: units and their replacement value', 'aria-label': `${name} army: ${forces}` }, icon('units', 14), forces),
          h('span', { class: 'obs-end-stat', 'data-stat': 'spire', 'data-tip': 'Spire HP left over every plane', 'aria-label': `${name} Spire: ${spire} HP` }, icon('spire', 14), spire));
      })),
      h('p', { class: 'obs-end-note', role: 'status', 'aria-live': 'polite', 'data-end-note': '' }),
      h('div', { class: 'outcome-actions obs-end-actions' }, ...this.endActions(next, continues)),
    ];
  }

  /** Where to go from here, by how the observer was opened. */
  private endActions(next: SeriesContext['live'][number] | undefined, continues: boolean): HTMLElement[] {
    const source = this.opts.source;
    const action = (id: string, label: string, glyph: IconName, text: string, run: () => void, primary = false) =>
      h('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, 'data-end-action': id, 'data-tip': label, 'aria-label': label, onclick: run }, icon(glyph, 16), text);
    const home = action('home', 'Home', 'spire', 'Home', () => this.opts.onExit('home'));
    if (source?.kind === 'featured') return [
      tip(action('next', 'Watch now', 'next', 'Watch now', () => this.continueNext(), true), 'The next match is already live for everyone. This only skips the result screen for you.'),
      tip(action('stay', 'Stay', 'cancel', 'Stay', () => this.stopCountdown()), 'Keep this result on screen. The broadcast keeps going.'),
      home,
    ];
    if (source?.kind === 'series') {
      const results = h('a', { class: 'btn primary', href: resultsHref(source.access), 'data-end-action': 'results', 'data-tip': 'Series results page', 'aria-label': 'Series results', onclick: (event: Event) => { event.preventDefault(); this.opts.onExit(); } }, icon('standings', 16), 'Results');
      if (!continues) return [results];
      const label = next ? `Watch ${next.label}` : 'The next game has not started yet';
      const step = h('button', { type: 'button', class: 'btn', 'data-end-action': 'next-game', 'data-tip': label, 'aria-label': label, disabled: !next, onclick: () => { if (next) void this.jumpMatch(next.matchId).catch(() => { this.status.textContent = observerStatus(this.grant.delayMs, 'That game is unavailable'); }); } }, icon('next', 16), 'Next game');
      return [results, step];
    }
    return [action('lobby', 'Back to lobby', 'leave', 'Back to lobby', () => this.opts.onExit('lobby'), true), home];
  }

  /** Card or banner, the fold control and the featured countdown (attributes and text only). */
  private syncEnd(): void {
    this.end.hidden = !this.ended;
    if (!this.ended) return;
    this.end.dataset.state = this.endOpen ? 'open' : 'banner';
    const fold = this.end.querySelector<HTMLElement>('[data-end-action="fold"]');
    if (fold) {
      const label = this.endOpen ? 'Fold to a banner · Esc' : 'Show the result';
      fold.dataset.tip = label; fold.setAttribute('aria-label', label); fold.setAttribute('aria-expanded', String(this.endOpen));
      fold.replaceChildren(icon(this.endOpen ? 'fold' : 'unfold', 14));
    }
    const note = this.end.querySelector<HTMLElement>('[data-end-note]');
    if (note) note.textContent = this.countdown !== undefined ? `Next match in ${this.countdown} s` : this.continueWanted ? 'Waiting for the next match…' : '';
    const stay = this.end.querySelector<HTMLElement>('[data-end-action="stay"]');
    if (stay) stay.hidden = this.countdown === undefined;
  }

  private toggleEnd(open = !this.endOpen): void { this.endOpen = open; this.syncEnd(); }

  private startCountdown(): void {
    window.clearInterval(this.countdownTimer);
    this.countdown = FEATURED_CONTINUE_S;
    this.countdownTimer = window.setInterval(() => {
      this.countdown = (this.countdown ?? 1) - 1;
      if (this.countdown > 0) this.syncEnd(); else this.continueNext();
    }, 1000);
  }

  private stopCountdown(): void {
    window.clearInterval(this.countdownTimer);
    this.countdown = undefined;
    this.syncEnd();
  }

  /** Featured: show the announced next match now, or as soon as the relay announces it. */
  private continueNext(): void {
    this.stopCountdown();
    const match = this.nextMatch;
    if (!match) { this.continueWanted = true; this.syncEnd(); return; }
    this.nextMatch = undefined;
    this.cut(match);
    // Its frames were dropped while the result held the screen: every stream starts again at its current keyframe.
    for (const stream of this.streams.values()) stream.conn?.resync();
    this.serve(match);
    this.status.textContent = observerStatus(this.grant.delayMs, 'Buffering');
  }

  /** A new match on screen: no result, and the match music again after a sting. */
  private clearEnd(): void {
    window.clearInterval(this.countdownTimer);
    if (this.ended) setAudioScene('match');
    this.ended = false; this.outcomes = undefined; this.countdown = undefined; this.continueWanted = false;
    this.ranks.clear();
    delete this.endCard.dataset.key;
    this.endCard.replaceChildren();
    this.syncEnd();
  }

  // ------------------------------------------------------------------ camera

  /** Manual camera input: the director yields for a while. */
  private manual(): void { this.manualUntil = performance.now() + MANUAL_HOLD_MS; this.directorCamera.release(); this.syncChrome(); }

  /**
   * The viewer chose a plane (chip, F-key, timeline, queue, overview): another plane releases any unit follow, which
   * would otherwise drag the camera straight back to the unit's plane. Holds the director, then dives.
   */
  private showPlane(plane: Plane): void {
    this.manual();
    if (plane !== this.world.rig.focus) this.stopFollow();
    this.world.rig.goTo(plane, performance.now(), 'jump');
  }

  private jump(plane: Plane, x: number, y: number): void {
    this.stopFollow();
    this.showPlane(plane);
    this.world.rig.lookAtTile(x, y);
  }

  /** Look at a board's queue entry: its producer or site when the shown view names them alike (`names`), else its point. */
  private focusEntry(entry: View['queue'][number], names: string): void {
    const view = this.worldView;
    const entity = view && idSpace(view) === names ? view.entities.find((candidate) => candidate.id === entry.producer || candidate.id === entry.site) : undefined;
    const x = entity?.x ?? entry.x;
    const y = entity?.y ?? entry.y;
    if (x === undefined || y === undefined) { this.showPlane(entry.plane); return; }
    this.jump(entity?.plane ?? entry.plane, x, y);
  }

  private stopFollow(): void { if (!this.follow) return; this.follow = undefined; this.syncChrome(); }

  private jumpLatest(): void {
    const moment = this.timeline.moments.at(-1);
    if (moment) this.jump(moment.plane, moment.x, moment.y);
  }

  private bindCamera(): void {
    const canvas = this.input;
    let drag: { x: number; y: number; rotate: boolean; moved: boolean } | undefined;
    const touch = new TouchGesture();
    // A touch pan, pinch or twist holds the director and releases a follow, as a mouse pan does.
    const touched = () => { this.manual(); this.stopFollow(); };
    // A tap or click follows the unit under it (any side the shown view contains).
    const pick = (x: number, y: number) => {
      const track = this.world.pickEntity(x, y);
      if (track && track.e.kind !== 'spire') { this.follow = track.e.id; this.syncChrome(); }
    };
    // Rotate like the player camera (middle-drag or Alt+drag), plus right-drag since observers have no orders.
    const down = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      if (event.pointerType === 'touch') {
        const was = touch.moved;
        if (touch.down(event.pointerId, event.clientX, event.clientY) && touch.moved && !was) touched();
        return;
      }
      drag = { x: event.clientX, y: event.clientY, rotate: event.button === 2 || event.button === 1 || (event.button === 0 && event.altKey), moved: false };
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        const was = touch.moved;
        if (touch.move(event.pointerId, event.clientX, event.clientY, this.world.rig, this.world.viewport) && touch.moved && !was) touched();
        return;
      }
      if (!drag) return;
      const x = event.clientX - drag.x; const y = event.clientY - drag.y;
      if (!drag.moved && Math.abs(x) + Math.abs(y) < 4) return;
      if (!drag.moved) { drag.moved = true; this.manual(); if (!drag.rotate) this.stopFollow(); }
      if (drag.rotate) this.world.rig.rotate(x, y); else this.world.rig.pan(-x * this.world.rig.dist / 700, -y * this.world.rig.dist / 700);
      drag.x = event.clientX; drag.y = event.clientY;
    };
    const up = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        if (touch.up(event.pointerId)) pick(event.clientX, event.clientY);
        return;
      }
      const click = drag && !drag.moved && !drag.rotate;
      drag = undefined;
      if (click) pick(event.clientX, event.clientY);
    };
    const cancel = (event: PointerEvent) => { if (event.pointerType === 'touch') touch.up(event.pointerId); else drag = undefined; };
    const wheel = (event: WheelEvent) => { event.preventDefault(); this.world.rig.zoom(event.deltaY); };
    const context = (event: Event) => event.preventDefault();
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('wheel', wheel, { passive: false }); canvas.addEventListener('contextmenu', context);
    this.cleanups.push(() => { canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancel); canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('contextmenu', context); });
  }

  private bindKeys(): void {
    const key = (event: KeyboardEvent) => {
      if (isTextEntry(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      // The player's camera layout (Settings: classic arrows, or WASD) pans here too.
      const pan = panFor(event.key.toLowerCase(), keyLayout());
      if (pan) {
        event.preventDefault();
        if (event.type === 'keydown') { this.world.rig.keys.add(pan); this.manual(); this.stopFollow(); } else this.world.rig.keys.delete(pan);
        return;
      }
      if (event.type !== 'keydown' || event.repeat) return;
      const plane = ['F1', 'F2', 'F3', 'F4'].indexOf(event.key);
      if (plane >= 0) { event.preventDefault(); this.showPlane(PLANES[plane]!); return; }
      const actions: Record<string, () => void> = {
        m: () => this.toggle('overview'), v: () => this.cycleVision(), c: () => this.toggleDirector(), f: () => this.stopFollow(),
        p: () => this.showTab('production'), r: () => this.showTab('research'), u: () => this.showTab('army'),
        t: () => this.toggle('timeline'), g: () => this.toggle('agents'), b: () => this.toggleStream(), h: () => this.toggleHelp(), '?': () => this.toggleHelp(),
        ' ': () => this.jumpLatest(), '[': () => this.stepGame(-1), ']': () => this.stepGame(1),
        escape: () => { if (!this.help.hidden) this.toggleHelp(false); else if (this.ended && this.endOpen) this.toggleEnd(false); else if (this.follow) this.stopFollow(); else if (this.stream) this.toggleStream(); },
      };
      const action = actions[event.key.toLowerCase()];
      if (!action) return;
      event.preventDefault();
      action();
    };
    const blur = () => this.world.rig.keys.clear();
    window.addEventListener('keydown', key); window.addEventListener('keyup', key); window.addEventListener('blur', blur);
    this.cleanups.push(() => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); window.removeEventListener('blur', blur); blur(); });
  }

  private stepGame(step: number): void {
    const live = this.series?.live;
    if (!live || live.length < 2) return;
    const index = live.findIndex((game) => game.current);
    const next = live[(index + step + live.length) % live.length]!;
    void this.jumpMatch(next.matchId).catch(() => { this.status.textContent = observerStatus(this.grant.delayMs, 'That game is unavailable'); });
  }

  /** The battlefield's clear area is what the chrome leaves free (stream mode: below the scoreboard only; a phone:
   *  below its compact strip, whose scoreboard and dock sit side by side or stacked). */
  private bindLayout(): void {
    const measure = () => {
      const canvas = this.world.canvas.getBoundingClientRect();
      const visible = (el: HTMLElement) => el.offsetParent !== null ? el.getBoundingClientRect() : undefined;
      const left = visible(this.left);
      const right = visible(this.right);
      const board = this.board.getBoundingClientRect();
      const dock = visible(this.dock);
      this.world.rig.setSafeArea(hudSafeArea(canvas, this.compact ? { top: dock && dock.bottom > board.bottom ? dock : board } : {
        top: board, bottom: dock,
        left: left && left.width ? left : undefined, right: right && right.width && right.left > canvas.left + canvas.width / 2 ? right : undefined,
      }));
    };
    const layout = new ResizeObserver(measure);
    for (const panel of [this.world.canvas, this.board, this.left, this.right, this.dock]) layout.observe(panel);
    this.cleanups.push(() => { layout.disconnect(); this.world.rig.setSafeArea(undefined); });
    measure();
  }

  private load(): { collapsed: PanelId[]; stream: boolean } {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(STORE) ?? 'null');
      if (value && typeof value === 'object' && 'collapsed' in value && Array.isArray(value.collapsed) && 'stream' in value)
        return { collapsed: value.collapsed.filter((id): id is PanelId => typeof id === 'string' && id in PANEL_KEYS), stream: value.stream === true };
    } catch { /* storage unavailable: defaults */ }
    // The overview is opt-in; everything else starts open.
    return { collapsed: ['overview'], stream: false };
  }

  private save(): void {
    try { localStorage.setItem(STORE, JSON.stringify({ collapsed: [...this.collapsed], stream: this.stream })); } catch { /* storage unavailable */ }
  }

  /** Once per animation frame: playout, then the camera (follow > director), the overview and the plane buttons. */
  frame(): void {
    for (const stream of this.streams.values()) stream.feed.pump();
    const now = performance.now();
    const dt = this.lastFrameAt ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 0;
    this.lastFrameAt = now;
    const rig = this.world.rig;
    const view = this.worldView;
    if (view) {
      const size = view.match.rules.map.size;
      if (this.follow) {
        const track = this.world.entities.tracks.get(this.follow);
        if (track) {
          // A followed unit that changed plane is tracked without the dive's ink.
          if (rig.focus !== track.e.plane) rig.goTo(track.e.plane, now, 'track');
          const k = 1 - Math.exp(-dt / EASE_S);
          rig.tx += (wx(track.rx, size) - rig.tx) * k;
          rig.tz += (wz(track.ry, size) - rig.tz) * k;
        } else this.stopFollow();
      } else if (this.directorOn && now >= this.manualUntil) {
        if (now >= this.chooseAt) { this.chooseAt = now + DECIDE_MS; this.director.decide(now); }
        this.directorCamera.frame(rig, this.director, now, dt);
        const shot = this.director.shot;
        if (shot.active && this.directorButton.dataset.shot !== shot.reason) this.directorButton.dataset.shot = shot.reason;
      }
    }
    const m = rig.camera.matrixWorld.elements;
    followRig(listener, rig);
    listener.x = rig.tx + this.world.size / 2;
    listener.y = rig.tz + this.world.size / 2;
    listener.level = rig.level;
    listener.rightX = m[0]!;
    listener.rightY = m[2]!;
    listener.dist = rig.dist;
    this.audio.frame(this.world.entities.renderTick);
    audioFrame(now);
    if (!this.stream && !this.compact && !this.collapsed.has('overview')) this.minimap.draw(this.world, now);
    const state = this.directorButton.dataset.state;
    const held = this.directorOn && now < this.manualUntil;
    if (state === 'held' && !held || state === 'on' && held) this.syncChrome();
    if (this.el.dataset.plane === rig.focus) return;
    this.el.dataset.plane = rig.focus;
    for (const button of this.planeBar.querySelectorAll<HTMLElement>('[data-plane]')) button.setAttribute('aria-pressed', String(button.dataset.plane === rig.focus));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeStreams();
    this.audio.reset();
    for (const cleanup of this.cleanups) cleanup();
    if (this.el.dataset.palette === 'accessible') this.applyPalette(false);
    this.el.remove();
    this.world.observing = undefined;
    this.world.reset();
  }
}

