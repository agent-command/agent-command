/**
 * A joined match: HUD, minimap, command card, commander chips on the plane rail. Input and orders live in `controls.ts`.
 * Every order goes through the PlayerThree control plane (`playerthree:call` → `act`), exactly like an agent's.
 */
import type { SeatInfo } from 'playerthree';
import { SCOPES } from 'playerthree/control';
import {
  BUILDABLE,
  PLANES,
  TICK_RATE,
  frameOf,
  isAircraft,
  isPlane,
  isUpgrade,
  UPGRADES,
  resolveUpgrade,
  type ArmyId,
  type Kind,
  type Macro,
  type Plane,
  type QueueItem,
  type Report,
  type Rules,
  type StatKind,
  type UnitKind,
  type UpgradeId,
  type View,
} from '@agent-command/game/contract';
import { armyLabel, matchArmy, placeLabel } from './armies.ts';
import { ApiError } from './api.ts';
import { outcomeCard, perspectiveChoice } from './outcome.ts';
import { ChatBar, CommanderLog } from './chat.ts';
import { CommanderSeats, type SeatState } from './commander-pop.ts';
import { ProfileApi, type PlaneMandate, type SeatOccupantChoice } from './profile.ts';
import { Controls, type Intent } from './controls.ts';
import { Minimap } from './minimap.ts';
import { CallError, ackText, type MatchLeft, type MatchMode, type MatchTicket } from './net.ts';
import { Connection } from './match-connection.ts';
import type { PublicLobbyCard } from '@agent-command/game/lobby';
import { PLANE_ACCENT, copyText, fitClasses, fmt, h, isTextEntry, patch } from './dom.ts';
import { mountAgentConsole } from './agent-console.ts';
import type { ConsolePanel, PlayerConsoleTarget } from '@playerthree/console';
import { CONSOLE_KEY_LABEL, keyLabel, keyLayout } from './keymap.ts';
import { getTool, type Armed } from './tools/index.ts';
import { SettingsMenu } from './settings.ts';
import { Overlay } from './overlay.ts';
import { CrownsBoard, MatchPointBanner, MatchTimer, PlaneChips, SuddenDeathBanner, SunDial } from './plan-hud.ts';
import { QueuePanel } from './queue-panel.ts';
import { EventFeed, type SignalEvent } from './event-feed.ts';
import { answerers, signalPlane, type SignalEntry, type SignalHooks } from './signals.ts';
import { CONTROLLER_BADGE, ERROR_TEXT, KIND_HINT, KIND_LABEL, MACRO_LABEL, PLANE_BLURB, PLANE_MACROS, PLANE_NAME, VERB_ERROR, VERB_LABEL, alertPlanes, eventText, stateLabel, upgradeTip, type FeedEvent } from './text.ts';
import { RETURN_WARN, returnArrivals, returnLeft, returnSeconds } from './world/returns.ts';
import { SIDE_HEX } from './world/common.ts';
import type { World } from './world/world.ts';
import { matchShareLinks, TopBar } from './topbar.ts';
import { ProductionTabs, productionEnabled, productionTabDirection } from './production-tabs.ts';
import { icon, type IconName } from './icons.ts';
import { tip } from './tooltip.ts';
import { islandOreInfo, oreIsland, selectedAerie, skyActions, skyStructureHint, weatherLegend } from './sky-panel.ts';
import { mooringDescription, mooringStatus } from './tools/mooring.ts';
import { CommandCard } from './command-card.ts';
import { structureActions } from './structure-action.ts';
import { seatSpendable } from '@agent-command/game/economy';
import { kindStats, ruleTables, statCells, statGrid, type KindStats } from './unit-stats.ts';
import { observeHudSafeArea } from './hud-safe-area.ts';
import { arrayInfo, coreInfo, depositLegend, rockInfo } from './rock-panel.ts';
import { matchView, type MatchView } from './match-view.ts';
import { rockFuseLeft } from './world/asteroid.ts';
import { AudioDirector, followRig } from './audio/director.ts';
import { audioFrame, audioOrderSent, audioOutcome, audioSink, audioUi, listener, setAudioScene } from './audio/index.ts';
import './icon-hud.css';
export { ObserverGame, type ExitRoute, type ObserverOptions } from './observer.ts';
import type { ExitRoute } from './observer.ts';
import type { ObserverGrant } from 'playerthree/protocol';

export interface SessionOptions {
  roomId: string;
  token: string;
  tickets?: MatchTicket['tickets'];
  lobbyCode?: string;
  lobbyAuth?: MatchTicket['lobbyAuth'];
  agentHandOver?: MatchTicket['agentHandOver'];
  quickPlay?: boolean;
  readOnly?: boolean;
  observer?: boolean;
  grant?: ObserverGrant;
  mode?: MatchMode;
  /** pvp: fragment for the opponent; agents/bots: spectator token. */
  invite?: string;
  spectator?: string;
  /** An eliminated player's observer pass (DESIGN §15.7): hand this match over to the read-only observer on
   *  `perspective`. Rejects (the elimination card shows why) until the server grants it. */
  spectate?(perspective: ArmyId | 'all'): Promise<void>;
  label: string;
  /** `to`: where leaving lands (the lobby observer's end card offers both); unset returns to where play began. */
  onExit(to?: ExitRoute): void;
}

const PLANE_KEY: Record<Plane, string> = { depths: 'F1', surface: 'F2', sky: 'F3', orbit: 'F4' };
/** Why a match ended for us without a result. Only a real outcome from the match shows victory, defeat or draw. */
const LEFT_TEXT: Record<MatchLeft, string> = {
  restart: 'Server restarted: this match was lost.',
  update: 'Server updated: this match was lost.',
  closed: 'Match closed by the server: no result.',
  lost: 'Connection lost: this match was closed.',
};
const MACRO_ICON: Record<Macro, IconName> = { auto_mine: 'auto_mine', guard_root: 'guard_root', defend_spire: 'defend_spire', attack_nearest: 'attack_nearest', recapture: 'recapture', intercept: 'intercept', harvest_core: 'harvest_core', haul_core: 'haul_core', spread_arrays: 'spread_arrays' };

function costBadge(kind: 'alloy' | 'energy', amount: number): HTMLElement {
  return h('span', { class: `hud-cost c-${kind}` }, icon(kind, 12), String(amount));
}

export class Game {
  private readonly root: HTMLElement;
  private readonly world: World;
  private readonly overlay: Overlay;
  private readonly opts: SessionOptions;
  private conn: Connection | undefined;
  private views = new Map<ArmyId, MatchView>();
  private viewArmy: ArmyId | undefined;
  private view: MatchView | undefined;
  private get rules(): Rules | undefined { return this.view?.match.rules; }
  private seats: SeatInfo[] = [];
  private publicCards: PublicLobbyCard[] = [];
  private cardRevision = 0;
  private report: Report | undefined;
  private reportShown = false;
  /** The elimination card (rank, then spectating) is up; it shows once. */
  private eliminationShown = false;
  /** The eliminated player chose a perspective: disposing hands the seat over to the observer instead of leaving. */
  private observerHandoff = false;
  private feed: { key: string; ev: FeedEvent | SignalEvent; at: number }[] = [];
  private readonly feedSeen = new Set<string>();
  private alerts: Record<Plane, number> = { depths: 0, surface: 0, sky: 0, orbit: 0 };
  /** Where the latest alert on each plane happened (pip click jumps there). */
  private alertAt: Partial<Record<Plane, { x: number; y: number }>> = {};
  private disposed = false;
  private readonly cleanup: (() => void)[] = [];

  // DOM
  private readonly hud: HTMLElement;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly commanders: CommanderSeats;
  private readonly chat: ChatBar;
  private readonly chatLog: CommanderLog;
  private readonly controls: Controls;
  private readonly minimap: Minimap;
  /** The team build queue, pinned above the field map. */
  private readonly queuePanel: QueuePanel;
  /** Team requests in the feed and on the plane chips: the human answers as the planes they control. */
  private readonly signalHooks: SignalHooks = {
    mine: (p) => !this.opts.readOnly && this.seatFor(p).controller === 'human',
    open: (e, p) => this.openSignal(e, p),
    answer: (e, p, update) => void this.act(p, [{ kind: 'signal_update', id: e.id, update }]),
  };
  /** The event feed, bottom-left. */
  private readonly eventFeed = new EventFeed((plane, x, y) => this.jumpOrGo(plane, x, y), this.signalHooks);
  private readonly sunDial = new SunDial();
  private readonly matchTimer = new MatchTimer();
  private readonly suddenDeath = new SuddenDeathBanner();
  private readonly matchPoint = new MatchPointBanner();
  private readonly crowns = new CrownsBoard();
  private readonly planeChips = new PlaneChips((plane, x, y) => this.jumpOrGo(plane, x, y), this.signalHooks);
  private topBar!: TopBar;
  private readonly productionTabs = new ProductionTabs(() => this.renderCard());
  /** The card's orders: commands and abilities of the selection, never scrolled (overflow goes under More). */
  private readonly commandCard = new CommandCard();
  private readonly settings = new SettingsMenu();
  /** Turns this team's fogged views into sound cues (fog-safe; see audio/director.ts). */
  private readonly audio: AudioDirector;
  private outcomeHeard = false;
  /** The agent console (`\`): this team's own planes as the player API reports them. */
  private readonly agentConsole: ConsolePanel;
  /** The owner's named commander seated in this room, once the roster confirms it. */
  private consoleTarget: PlayerConsoleTarget | undefined;
  /** The structure whose Destroy awaits its in-card confirmation (cleared once the selection moves off it). */
  private dismantleArmed: string | undefined;

  constructor(root: HTMLElement, world: World, overlay: Overlay, opts: SessionOptions) {
    this.root = root;
    this.world = world;
    this.audio = new AudioDirector(audioSink, listener, world.size);
    this.overlay = overlay;
    this.opts = opts;
    this.world.reset();
    this.commanders = new CommanderSeats({
      matchId: opts.roomId,
      team: () => this.view?.army,
      quickPlay: opts.quickPlay,
      readOnly: opts.readOnly,
      seat: (p) => {
        const s = this.seatFor(p);
        return s;
      },
      setController: async (p, c) => {
        if (!this.conn) throw new CallError('disconnected');
        await this.conn.setController(p, c);
      },
      setMandate: async (p, mandate) => {
        if (!this.conn) throw new CallError('disconnected');
        await this.conn.setMandate(p, mandate);
      },
      setScopes: async (p, scopes) => {
        if (!this.conn) throw new CallError('disconnected');
        await this.conn.setScopes(p, scopes);
      },
      resolveApproval: async (p, id, approve) => {
        if (!this.conn) throw new CallError('disconnected');
        await this.conn.resolveApproval(p, id, approve);
      },
      policyStatus: async (p) => {
        if (!this.conn) throw new CallError('disconnected');
        return this.conn.policyStatus(p);
      },
      mint: async (p) => {
        if (!this.conn) throw new CallError('disconnected');
        return (await this.conn.mint(p)).token;
      },
      pickFocus: (p) => this.arm({ kind: 'pick', role: p }),
      toast: (text, kind) => this.toast(text, kind),
      // Lobby matches: hand a plane over mid-match (the connection rejoins with this owner's current seat tickets).
      ...(opts.lobbyCode && !opts.quickPlay && !opts.readOnly ? {
        assign: async (p: Plane, occupant: SeatOccupantChoice) => {
          const team = this.view?.army;
          if (!team || !this.conn) throw new CallError('disconnected');
          await this.conn.handOver(team, p, occupant);
        },
        agentHandOver: opts.agentHandOver !== false,
      } : {}),
      changed: () => this.renderSwitcher(),
    });
    this.minimap = new Minimap((plane, x, y) => this.jumpTo(plane, x, y), world.size);
    this.queuePanel = new QueuePanel({ act: (role, intents) => this.act(role, intents), canAct: (role) => this.canQueue(role), canPrioritize: (role) => this.canQueue(role) && !!this.conn?.canPrioritize(role), toast: (text, kind) => this.toast(text, kind) });
    this.chatLog = new CommanderLog({ max: 30 });
    this.chatLog.el.classList.add('slip');
    this.hud = this.buildHud();
    root.append(this.hud);
    // Owner ↔ own-agent chat: Enter opens the bar, Alt+click attaches a map ping; replies land in the log and as
    // speech bubbles over that plane's Spire segment (plain text only).
    this.chat = new ChatBar(
      async (roles, text, ping) => {
        if (!this.conn) throw new Error('disconnected');
        await this.conn.tell(roles, text, ping);
        this.chatLog.add({ from: 'owner', roles: roles === 'all' ? [...PLANES] : roles, text, at: Date.now(), ...(ping ? { ping } : {}) });
      },
      { floating: true },
    );
    this.hud.append(this.chat.el);
    this.controls = new Controls(world, overlay, {
      onChatKey: () => this.opts.readOnly ? this.toast('Spectating') : this.opts.quickPlay ? this.toast('Connect agents in a custom lobby.') : this.chat.open(),
      onPing: (p) => { if (!this.opts.quickPlay && !this.opts.readOnly) this.chat.attachPing(p); },
      view: () => this.view,
      rules: () => this.rules,
      readOnly: !!opts.readOnly,
      act: (role, intents) => this.act(role, intents),
      canQueue: (role) => this.canQueue(role),
      toast: (text, kind) => this.toast(text, kind),
      goTo: (p) => this.goTo(p),
      jumpTo: (p, x, y) => this.jumpTo(p, x, y),
      // The ` shortcut: open on the focused plane with keyboard focus on its "Who plays" picker.
      toggleCommander: () => { this.toggleCommander(); this.commanders.focusPicker(); },
      pickDirective: (role, x, y) => this.pickDirective(role, x, y),
      changed: () => this.renderCard(),
      hint: (text) => {
        this.el.hint!.textContent = text;
        this.el.hint!.classList.toggle('show', !!text);
      },
    });
    this.cleanup.push(this.commanders.start());
    this.agentConsole = mountAgentConsole({
      credential: () => this.opts.quickPlay || this.opts.readOnly ? undefined : this.opts.lobbyCode ? ProfileApi.stored()?.profile.secret : this.opts.token,
      key: !this.opts.quickPlay && !this.opts.readOnly,
      mount: this.el.journal!,
      target: () => this.consoleTarget,
      resolveApproval: async (target, id, approve) => {
        if (target.kind === 'commander') {
          const api = ProfileApi.stored();
          if (!api) throw new CallError('unauthorized');
          await api.resolveApproval(target.commander, id, approve);
          return;
        }
        if (!this.conn) throw new CallError('disconnected');
        await this.conn.resolveApproval(target.role as Plane, id, approve);
      },
      onToggle: (open) => this.el.consoleBtn?.classList.toggle('on', open),
    });
    if (this.opts.lobbyCode && !this.opts.readOnly) {
      void ProfileApi.stored()?.roster().then((roster) => {
        const seated = roster.commanders.find((commander) => commander.seated?.roomId === this.opts.roomId);
        if (seated?.seated?.roles[0]) this.consoleTarget = { commander: seated.id, match: seated.seated.match, team: seated.seated.team, role: seated.seated.roles[0] };
      }).catch(() => {});
    }
    this.cleanup.push(observeHudSafeArea(this.hud, world.canvas, (area) => world.rig.setSafeArea(area)));
    if (typeof ResizeObserver === 'function') {
      const fit = new ResizeObserver(() => this.fitCard());
      fit.observe(this.el.selCol!);
      fit.observe(this.el.prod!);
      this.cleanup.push(() => fit.disconnect());
    }
    const productionKeys = (event: KeyboardEvent) => {
      const direction = productionTabDirection(event);
      if (!direction || isTextEntry(event.target)) return;
      event.preventDefault();
      this.productionTabs.step(this.world.rig.focus, direction);
    };
    window.addEventListener('keydown', productionKeys);
    this.cleanup.push(() => window.removeEventListener('keydown', productionKeys));
  }

  async start(): Promise<boolean> {
    this.setStatus('Connecting…');
    try {
      await this.topBar.prepare();
      if (this.disposed) return false;
      this.conn = await Connection.join(this.opts.roomId, this.opts.token, {
        view: (v) => this.onView(v),
        seats: (s) => this.onSeats(s),
        report: (team, r) => this.onReport(team, r),
        left: (reason) => this.onLeft(reason),
        recovering: (active) => this.setStatus(active ? 'Reconnecting…' : ''),
        authorityChanged: () => {
          if (this.disposed || !this.view) return;
          this.renderCard();
          this.queuePanel.update(this.view);
        },
        cards: (cards) => { this.publicCards = cards; this.cardRevision++; this.renderSwitcher(); },
        said: (s) => {
          this.chatLog.add({ from: 'agent', roles: [s.role], text: s.text, at: Date.now() });
          if (isPlane(s.role)) this.world.speech(s.role, s.text);
        },
      }, { tickets: this.opts.tickets, lobbyCode: this.opts.lobbyCode, lobbyAuth: this.opts.lobbyAuth });
      this.setStatus('');
      if (this.view) {
        this.renderCard();
        this.queuePanel.update(this.view);
      }
      return true;
    } catch {
      this.setStatus('Could not join this match. It may have ended or the link is invalid.', true);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Handing an eliminated player to the observer keeps the lobby membership that carries their observer pass.
    if (this.observerHandoff) this.conn?.handOff();
    else this.conn?.leave();
    this.controls.dispose();
    this.commandCard.dispose();
    this.audio.reset();
    for (const c of this.cleanup) c();
    this.agentConsole.destroy();
    this.settings.dispose();
    this.queuePanel.dispose();
    this.topBar.dispose();
    this.eventFeed.dispose();
    this.hud.remove();
    this.world.rig.setSafeArea(undefined);
    this.overlay.preview = undefined;
    this.overlay.drag = undefined;
  }

  // ---------------------------------------------------------------- network events
  private onView(incoming: View): void {
    const previous = this.views.get(incoming.army);
    const v = matchView(incoming, previous);
    if (!v) {
      this.views.delete(incoming.army);
      if (this.view?.army === incoming.army) {
        this.view = undefined;
        this.world.reset();
        this.setStatus('Waiting for match snapshot…', true);
      }
      if (!this.viewArmy) this.setStatus('Waiting for match snapshot…', true);
      this.renderArmyToggle();
      return;
    }
    if (previous && (v.rulesHash !== previous.rulesHash || v.tick < previous.tick) && v.army === this.viewArmy) {
      this.view = undefined;
      this.world.reset();
    }
    this.views.set(v.army, v);
    if (!this.viewArmy) this.viewArmy = v.army;
    if (v.army !== this.viewArmy) {
      this.renderArmyToggle();
      return;
    }
    const first = !this.view;
    const prev = this.view;
    this.view = v;
    if (first) {
      this.setStatus('');
      // Match views include the team's controllers, including on a direct-link reload. Follow the
      // rail's top-to-bottom order (Orbit → Depths), once only: updates must not steal camera focus.
      this.goTo(PLANES.findLast((p) => v.seats.some((s) => s.role === p && s.controller === 'human')) ?? 'surface');
      // Start the match's music from its first authoritative camera pose, not after shader warm-up.
      listener.plane = this.world.rig.focus;
      setAudioScene('match');
    }
    this.world.setView(v);
    this.audio.ingest(v, this.world.entities.renderTick);
    this.ingestEvents(v, prev);
    this.renderHud();
    // Eliminated while other armies still fight: the elimination card (rank, then spectating); the report follows at
    // the end of the match. Otherwise a final outcome is the end of the match for us.
    const out = v.eliminated.includes(v.army) && v.eliminated.length < v.match.armies.length - 1;
    if (out) { if (!this.eliminationShown && !this.reportShown) this.showElimination(v); }
    else if (v.outcome !== 'running' && !this.reportShown) this.showOutcome();
  }

  private onSeats(s: SeatInfo[]): void {
    this.seats = s;
    this.renderSwitcher();
    this.commanders.refresh();
  }

  private onReport(army: ArmyId, r: Report): void {
    if (army !== (this.viewArmy ?? army)) return;
    this.report = r;
    this.showOutcome();
  }

  /** The match ended for us without a result: say why, with Back to lobby. A real outcome already shown stays. */
  private onLeft(reason: MatchLeft): void {
    if (this.disposed || this.reportShown) return;
    this.setStatus(LEFT_TEXT[reason], true);
  }

  private ingestEvents(v: View, prev: View | undefined): void {
    const now = performance.now();
    for (const ev of v.events) {
      // queue events can repeat tick, place and item (two entries cancelled at once): the entry and move keep them apart
      this.pushFeed(`${ev.tick}:${ev.kind}:${ev.x}:${ev.y}:${ev.subject ?? ''}:${ev.side ?? ''}:${ev.entry ?? ''}:${ev.by ?? ''}:${ev.from ?? ''}:${ev.index ?? ''}`, ev, now);
    }
    // Timed visits end without a server event: the feed notes our units arriving back on their return plane.
    if (prev) for (const a of returnArrivals(prev, v)) this.pushFeed(`${a.tick}:transit_return:${a.plane}:${a.subject}`, { kind: 'transit_return', ...a }, now);
    // Team requests: a line when one appears and one per later state (stamped when this client first sees it).
    for (const e of v.signals)
      this.pushFeed(`signal:${v.army}:${e.tick}:${e.id}:${e.state}`, { kind: 'signal', tick: e.state === 'submitted' ? e.tick : v.tick, entry: e }, now);
    if (this.feed.length > 40) this.feed = this.feed.slice(-40);
    if (this.feedSeen.size > 3000) {
      this.feedSeen.clear();
      for (const f of this.feed) this.feedSeen.add(f.key);
    }
    // alert pips: recent alerting events per plane (events in the view cover ~10 s)
    const alerts: Record<Plane, number> = { depths: 0, surface: 0, sky: 0, orbit: 0 };
    for (const ev of v.events)
      for (const p of alertPlanes(ev, v.army)) {
        alerts[p]++;
        this.alertAt[p] = { x: ev.x, y: ev.y };
      }
    this.alerts = alerts;
  }

  private pushFeed(key: string, ev: FeedEvent | SignalEvent, now: number): void {
    if (this.feedSeen.has(key)) return;
    this.feedSeen.add(key);
    this.feed.push({ key, ev, at: now });
  }

  // ---------------------------------------------------------------- HUD
  private buildHud(): HTMLElement {
    const el = this.el;
    el.chips = h('div', { class: 'chips' });
    el.cmdBtn = h('button', { class: 'btn ghost cmd-open-btn', 'data-tip': 'Commander of this plane (`)', 'aria-label': 'Commanders', onclick: (e: Event) => (e.stopPropagation(), this.toggleCommander()) }, icon('commanders'));
    el.consoleBtn = h('button', { class: 'btn ghost', hidden: this.opts.quickPlay || this.opts.readOnly, 'data-tip': `Agent console: your planes' agents, orders and rejections (${CONSOLE_KEY_LABEL})`, 'aria-label': 'Agent console', onclick: () => this.agentConsole.toggle() }, icon('console'));
    const leave = h('button', { class: 'btn ghost', 'data-tip': 'Leave match', 'aria-label': 'Leave match', onclick: () => this.exit() }, icon('leave'));
    const actions = h('section', { class: 'ledger-actions', 'aria-label': 'Match actions' },
      h('div', { class: 'top-actions' }, el.cmdBtn, el.consoleBtn, this.settings.el, leave),
      h('div', { class: 'order-meta' }, h('div', { class: 'ledger-heading ledger-match', 'data-tip': this.opts.label }, this.opts.label), el.chips));
    this.topBar = new TopBar(h('section', { class: 'ledger-time', 'aria-label': 'Time' }, h('div', { class: 'ledger-clocks' }, this.sunDial.el, this.matchTimer.el), this.planeChips.el, this.crowns.el), actions);
    const top = this.topBar.el;
    el.switcher = h('div', { class: 'switcher' });
    el.sel = h('div', { class: 'sel' });
    el.prod = h('div', { class: 'prod', id: 'production-items', role: 'tabpanel' });
    el.macros = h('div', { class: 'macros' });
    el.planeTitle = h('div', { class: 'card-title' });
    const card = h(
      'div',
      { class: 'card' },
      el.planeTitle,
      h('div', { class: 'card-row' }, el.selCol = h('div', { class: 'card-col sel-col' }, el.sel), h('div', { class: 'card-col orders-col' }, this.commandCard.el), h('div', { class: 'card-col production-col' }, this.productionTabs.el, el.prod), h('div', { class: 'card-col macro-col' }, el.macros)),
    );
    el.toasts = h('div', { class: 'toasts' });
    el.banner = h('div', { class: 'plane-banner' });
    el.status = h('div', { class: 'status' });
    el.hint = h('div', { class: 'armed-hint' });
    const mini = h(
      'div',
      { class: 'minimap-box' },
      h('div', { class: 'minimap-head' }, h('span', { class: 'stamp', 'data-tip': 'Field map · click a plane to jump there; Orbit on top', tabindex: 0, 'aria-label': 'Field map' }, icon('map', 16))),
      this.minimap.el,
    );
    el.teamToggle = h('div', { class: 'team-toggle' });
    el.outcome = h('div', { class: 'outcome hidden' });
    // Shared grid tracks reserve the rail, command page and field map before the world gets the centre.
    el.journal = h('div', { class: 'journal-col' }, el.switcher, this.eventFeed.el);
    const fieldCol = h('div', { class: 'field-col' }, h('div', { class: 'dispatch-slot' }, this.chatLog.el), this.queuePanel.el, mini);
    return h('div', { class: 'hud' }, top, el.journal, card, fieldCol, el.toasts, el.banner, this.suddenDeath.el, this.matchPoint.el, el.status, el.hint, el.teamToggle, this.commanders.pop, el.outcome);
  }

  private setStatus(text: string, fatal = false): void {
    const s = this.el.status!;
    s.replaceChildren();
    if (!text) {
      s.classList.remove('show');
      return;
    }
    s.classList.add('show');
    s.append(h('div', {}, text));
    if (fatal) s.append(h('button', { class: 'btn', 'data-tip': 'Back to lobby', 'aria-label': 'Back to lobby', onclick: () => this.exit() }, icon('leave')));
  }

  private toast(text: string, kind: 'err' | 'ok' = 'err'): void {
    // Every error toast is a rejection (order acknowledgements, commander calls): the error buzz.
    if (kind === 'err') audioUi('error');
    const t = h('div', { class: `toast ${kind}` }, text);
    this.el.toasts!.append(t);
    while (this.el.toasts!.children.length > 4) this.el.toasts!.firstElementChild?.remove();
    setTimeout(() => t.classList.add('out'), 2300);
    setTimeout(() => t.remove(), 2800);
  }

  private renderHud(): void {
    const v = this.view;
    if (!v) return;
    this.topBar.update(v);
    this.sunDial.update(v, this.world.layers.orbit.sunAngle.value);
    this.matchTimer.update(v, v.tick);
    this.suddenDeath.update(v.match?.rules, v.tick);
    const name = (army: ArmyId): string => (v.match ? armyLabel(v.match, army) : army);
    this.matchPoint.update(v.match?.rules, v.crowns, v.eliminated, name);
    this.crowns.update(v.match?.rules, v.crowns, v.army, name);
    this.planeChips.update(v);
    this.renderSwitcher();
    this.renderFeed();
    this.renderCard();
    this.queuePanel.update(v);
    this.renderChips();
  }

  private seatFor(p: Plane): SeatState & { stance?: string } {
    const army = this.view?.army;
    const s = this.seats.find((x) => x.role === p && (!army || x.team === army));
    const vs = this.view?.seats.find((x) => x.role === p);
    const mandate = (s?.mandate ?? vs?.mandate ?? { autonomy: 'autonomous', directive: { stance: 'economy' }, whenAbsent: 'policy' }) as PlaneMandate;
    return {
      controller: s?.controller ?? vs?.controller ?? 'none',
      agentActive: !!s?.agentActive,
      commander: s?.commander,
      stance: mandate.directive.stance,
      policyVersion: s?.policyVersion,
      mandate,
      scopes: s?.scopes ?? [...SCOPES],
    };
  }

  private renderSwitcher(): void {
    const focus = this.world.rig.focus;
    const key = PLANES.map((p) => {
      const s = this.seatFor(p);
      return `${p}${s.controller}${s.agentActive}${s.stance}${this.alerts[p]}${this.minimap.idle[p]}`;
    }).join('|') + focus + this.commanders.railKey() + this.cardRevision;
    patch(this.el.switcher!, key, () =>
      [...PLANES].reverse().map((p) => {
        const s = this.seatFor(p);
        const card = this.publicCards.find((candidate) => candidate.seat.team === this.viewArmy && candidate.seat.role === p);
        const at = this.alertAt[p];
        const idle = this.minimap.idle[p];
        return h(
          'button',
          { class: `plane-btn${p === focus ? ' active' : ''}`, style: `--accent:${PLANE_ACCENT[p]}`, 'data-plane': p, 'aria-label': PLANE_NAME[p], 'aria-pressed': String(p === focus), onclick: () => this.goTo(p), 'data-tip': `${PLANE_NAME[p]} · ${PLANE_KEY[p]} · ${PLANE_BLURB[p]}` },
          h('span', { class: 'key' }, icon(p, 22)),
          h('span', { class: 'pname' }, PLANE_NAME[p]),
          h(
            'span',
            { class: 'prow' },
            this.commanders.chipFor(p),
            card ? h('span', { class: 'ai-label', 'data-tip': `AI Player · ${card.harness?.label ?? card.kind}${card.harness?.verified ? '' : ' (unverified)'}` }, icon('generic', 12), 'AI') : null,
            idle ? h('span', { class: 'idle', 'data-tip': `Idle units (press ${keyLabel('idle')} on this plane)` }, icon('idle', 12), String(idle)) : null,
            s.stance && s.controller !== 'human' ? h('span', { class: 'stance' }, s.stance) : null,
          ),
          this.alerts[p]
            ? h(
                'span',
                {
                  class: 'pip',
                  'data-tip': 'Alerts on this plane — click to jump there',
                  onclick: (e: Event) => {
                    e.stopPropagation();
                    if (at) this.jumpTo(p, at.x, at.y);
                    else this.goTo(p);
                  },
                },
                String(Math.min(9, this.alerts[p])),
              )
            : null,
        );
      }),
    );
  }

  private renderFeed(): void {
    if (this.view) this.eventFeed.update(this.feed, this.view.army, this.view.match, this.view.signals);
  }

  private renderChips(): void {
    const o = this.opts;
    const spectating = this.views.size > 1;
    patch(this.el.chips!, `${o.mode}|${spectating}`, () => {
      const out: HTMLElement[] = [];
      for (const share of matchShareLinks(o, `${location.origin}${location.pathname}`)) {
        const what = share.kind === 'invite' ? 'Invite' : 'Spectator';
        out.push(h('button', { class: 'btn ghost chip share-link', 'data-tip': `${share.label} · ${share.hint}\n${share.url}`, 'aria-label': share.label, onclick: () => void copyText(share.url).then((ok) => (ok ? this.toast(`${what} link copied`, 'ok') : this.toast(`Couldn't copy the ${what.toLowerCase()} link`))) },
          icon(share.kind === 'invite' ? 'invite' : 'spectate', 16)));
      }
      if (spectating) out.push(h('span', { class: 'chip static', 'data-tip': 'Spectating', 'aria-label': 'Spectating' }, icon('spectate', 16)));
      return out;
    });
  }

  /** Spectators receive every army's view: one button per army, in its colour (`data-army` for tooling). */
  private renderArmyToggle(): void {
    patch(this.el.teamToggle!, [...this.views.keys()].join(',') + this.viewArmy, () =>
      [...this.views.values()].map((v) => {
        const label = `${armyLabel(v.match, v.army)} view`;
        const on = v.army === this.viewArmy;
        return h('button', { class: `btn small${on ? ' on' : ''}`, 'data-army': v.army, style: `--side:${SIDE_HEX[matchArmy(v.match, v.army).colour]}`, 'data-tip': label, 'aria-label': label, 'aria-pressed': String(on), onclick: () => this.switchArmy(v.army) }, icon('spectate', 16), armyLabel(v.match, v.army).toUpperCase());
      }),
    );
  }

  private switchArmy(army: ArmyId): void {
    const v = this.views.get(army);
    if (!v) return;
    this.viewArmy = army;
    this.controls.forgetIds();
    this.view = v;
    // Another army's view of the same match: shown in place, no loader.
    this.world.setView(v, true);
    this.world.rig.centerOn(frameOf(army), matchArmy(v.match, army).spireAt);
    this.renderHud();
    this.renderArmyToggle();
  }

  // ---------------------------------------------------------------- command card
  private renderCard(): void {
    const v = this.view;
    const rules = this.rules;
    if (!v || !rules) return;
    const focus = this.world.rig.focus;
    const sel = this.controls.selectedTracks().map((t) => t.e);
    const seg = v.spire.find((s) => s.plane === focus);
    const segDead = !!seg && seg.hp <= 0;
    const rootDead = v.spire.some((s) => s.plane === 'depths' && s.hp === 0);
    const shaft = focus === 'surface' && rootDead
      ? sel.find((e) => e.kind === 'shaft' && e.side === v.army && e.hp > 0 && e.state !== 'constructing')
      : undefined;

    const depositsKey = `${v.oreCaches?.some(c => c.alloy > 0)}:${v.oreCaches?.some(c => (c.below?.alloy ?? 0) > 0)}:${v.scorches?.some(s => s.until > v.tick)}`;
    patch(this.el.planeTitle!, `${focus}${this.seatFor(focus).controller}${keyLayout()}${depositsKey}`, () => {
      const s = this.seatFor(focus);
      return [
        h('span', { class: 'section', style: `--accent:${PLANE_ACCENT[focus]}`, 'data-tip': `${PLANE_NAME[focus]} · ${PLANE_BLURB[focus]}` }, icon(focus, 16)),
        focus === 'sky' ? weatherLegend(rules) : null,
        depositLegend(v, rules, focus),
        s.controller !== 'human' ? h('span', { class: 'ct-warn', 'data-tip': `${(CONTROLLER_BADGE[s.controller] ?? CONTROLLER_BADGE.none!).label} in command — your orders still override`, 'aria-label': 'Commander controls this plane' }, icon('commanders', 14)) : null,
        tip(h('button', { class: 'btn ghost keyboard-help', 'aria-label': 'Keyboard and mouse help' }, icon('keyboard', 16)), {
          title: 'Keyboard and mouse',
          description: `${getTool('default').hint}\n${keyLabel('amove')} attack-move · Shift queues · Ctrl+1–9 sets groups · 1–9 selects groups · ${keyLabel('idle')} idle unit.\nF1–F4 planes · Ctrl+[ / Ctrl+] production tabs · Tab unit types · Enter chat · Alt+click ping.\nQueue: drag or Alt+↑↓ reorders, Delete cancels. ${getTool('designate').planes.includes(focus) ? `${keyLabel('designate')} ${getTool('designate').hint}` : ''}`,
        }),
      ];
    });

    // selection summary
    const counts = new Map<Kind, number>();
    let groupHp = 0;
    for (const e of sel) {
      counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
      groupHp += e.hp;
    }
    const tables = ruleTables(rules);
    // a timed visit about to run out: the soonest return in the selection, counted down in whole seconds
    let returnIn = -1;
    let returnTo: Plane | undefined;
    for (const e of sel) {
      const left = returnLeft(e, v.tick);
      if (left >= 0 && left <= RETURN_WARN && (returnIn < 0 || left < returnIn)) {
        returnIn = left;
        returnTo = e.transit!.return;
      }
    }
    const back = returnTo ? { to: returnTo, secs: returnSeconds(returnIn) } : undefined;
    const shieldKey = sel.map((e) => `${e.plane}:${e.shield ?? 0}/${e.maxShield ?? 0}`).join(',');
    const one = sel.length === 1 ? sel[0]! : undefined;
    const rockKey = one?.kind === 'asteroid' ? `|${one.rockSize ?? ''}:${one.resourceType ?? ''}:${one.volatile ?? ''}:${one.resourceRemaining ?? ''}:${Math.ceil(rockFuseLeft(one, v.tick))}`
      : one?.kind === 'tug' ? `|${one.cargoAlloy ?? ''}:${one.cargoEnergy ?? ''}:${one.miningTarget ?? ''}:${one.miningAssigned ?? ''}`
      : one?.kind === 'core' ? `|${one.vents ?? -1}:${Math.round(one.heat ?? -1)}`
      : one?.kind === 'solar' ? `|${Math.round((one.ramp ?? -1) * 100)}:${Math.round((one.output ?? -1) * 10)}` : '';
    const mooringKey = one && (one.kind === 'mooring_tower' || one.kind === 'island') ? `|${one.mooringState ?? ''}:${one.mooringTarget ?? ''}:${one.mooringGrace ?? ''}:${mooringStatus(one, v)}` : '';
    const ore = oreIsland(one, v);
    const extractor = one?.kind === 'ore_extractor' ? one : ore ? v.entities.find((e) => e.kind === 'ore_extractor' && e.link === ore.id) : undefined;
    const oreKey = ore ? `|${ore.id}:${ore.oreCapacity ?? ''}:${ore.oreRemaining?.toFixed(1) ?? ''}:${ore.oreBuffer?.toFixed(1) ?? ''}:${extractor?.state ?? ''}:${extractor?.extractorPowered ?? ''}` : '';
    // Orders first: they settle the active Tab subgroup the selection summary highlights.
    const actions = this.controls.cardActions();
    const active = counts.size > 1 ? this.controls.activeKind : undefined;
    const selKey = `${active ?? ''}|` + [...counts].map(([k, n]) => `${k}${n}`).join(',') + (sel.length === 1 ? `${sel[0]!.hp}${sel[0]!.state}${sel[0]!.side}${sel[0]!.sealed ? 'sealed' : ''}` : `${groupHp}`) + (sel.length ? '' : focus + keyLayout()) + (back ? `${back.to}${back.secs}` : '') + `|${v.research.completed.length}|${v.research.seen.reduce((n, s) => n + s.upgrades.length, 0)}|${shieldKey}` + rockKey + mooringKey + oreKey;
    const selBefore = this.el.sel!.dataset.key;
    patch(this.el.sel!, selKey, () => {
      if (!sel.length) return [];
      const cue = back ? h('div', {
        class: 'return-cue',
        'data-tip': `Visit ending: back to ${PLANE_NAME[back.to]} in ${back.secs}s`,
        'aria-label': `Back to ${PLANE_NAME[back.to]} in ${back.secs} seconds`,
      }, icon('transit_return', 16), icon(back.to, 14), h('span', { class: 'num' }, `${back.secs}s`)) : null;
      // One stats row per kind, side and plane, not per unit. Fog-safe: our research for our units; for the enemy's,
      // only the upgrades this team has seen them use (a kind's base stats are public).
      const rows = new Map<string, KindStats>();
      const shield = { shield: 0, max: 0, count: 0 };
      for (const e of sel) {
        if (e.kind === 'island' || e.kind === 'asteroid' || e.side === 'neutral') continue;
        const key = `${e.kind}|${e.side}|${e.plane}`;
        if (!rows.has(key)) {
          const side = e.side;
          const stats = kindStats(tables, e.kind as StatKind, e.plane, side === v.army ? v.research.completed : v.research.seen.find((s) => s.army === side)?.upgrades ?? []);
          // Capacity/current values belong to the visible snapshot, not an inferred enemy upgrade.
          stats.shield = e.maxShield ?? 0;
          rows.set(key, stats);
        }
        if ((e.maxShield ?? 0) > 0) {
          shield.shield += e.shield ?? 0;
          shield.max += e.maxShield!;
          shield.count++;
        }
      }
      const grid = rows.size ? statGrid(statCells([...rows.values()], sel.length > 1 ? { hp: groupHp, max: sel.reduce((n, e) => n + e.maxHp, 0), count: sel.length } : undefined, shield.max > 0 ? shield : undefined)) : null;
      if (sel.length === 1) {
        const e = sel[0]!;
        const state = stateLabel(e, { depths: v.depths, holes: v.holes, size: this.world.size });
        return [
          tip(h('div', { class: 'unit-one', 'aria-label': `${KIND_LABEL[e.kind]} · ${state}`, style: `color:${e.side === 'neutral' ? 'var(--neutral-ink)' : `var(--army-${matchArmy(v.match, e.side).colour}-ink)`}` }, icon(e.kind, 20), h('span', { class: 'unit-name' }, KIND_LABEL[e.kind])),
            { title: `${KIND_LABEL[e.kind]} · ${state}`, description: skyStructureHint(e.kind, rules), ...(grid ? { stats: statGrid(statCells([...rows.values()]), true) } : {}) }),
          h('div', { class: 'hpbar' }, h('span', { style: `width:${(e.hp / e.maxHp) * 100}%` }), h('em', {}, `${e.hp}/${e.maxHp}`)),
          e.carry !== undefined && e.kind === 'digger' ? h('div', { class: 'muted small', 'data-tip': 'Carried ore' }, costBadge('alloy', e.carry)) : null,
          e.sealed ? h('div', { class: 'muted small', 'data-tip': 'No open tunnel beside its Depths landing: troopers cannot transfer here until diggers reach it' }, icon('shaft', 14), 'Sealed · dig to connect') : null,
          e.kind === 'asteroid' ? rockInfo(e, rules, v.tick) : e.kind === 'core' ? coreInfo(e, rules) : e.kind === 'solar' ? arrayInfo(e, rules) : null,
          e.kind === 'mooring_tower' || (e.kind === 'island' && (e.mooringState || (e.mooringReadyAt ?? 0) > v.tick))
            ? tip(h('div', { class: 'muted small', 'aria-label': 'Mooring status' }, icon('moor', 14), mooringStatus(e, v),
              e.mooringTarget ? ` · ${e.mooringTarget}` : ''), { title: 'Mooring', description: mooringDescription(rules) }) : null,
          islandOreInfo(e, v, rules) ?? null,
          e.kind === 'tug' && e.cargoAlloy !== undefined && e.cargoEnergy !== undefined ? h('div', { class: 'unit-chips', 'aria-label': 'Mining cargo' },
            h('span', { class: 'unit-chip' }, icon('alloy', 14), `${e.cargoAlloy.toFixed(1)} alloy`),
            h('span', { class: 'unit-chip' }, icon('energy', 14), `${e.cargoEnergy.toFixed(1)} energy`),
            h('span', { class: 'unit-chip' }, icon('mine', 14), `Hold ${(e.cargoAlloy + e.cargoEnergy).toFixed(1)}/${rules.orbit.tugHold}`),
            e.miningAssigned ? h('span', { class: 'unit-chip' }, e.state === 'returning' ? 'Returning cargo' : e.state === 'mining' ? 'Mining' : e.state === 'idle' ? 'Searching for ore / ice' : e.miningTarget ? 'Approaching rock' : 'Reacquiring mining site') : null,
            tip(h('span', { class: 'muted small' }, 'Ice bypasses solar cap'), { title: 'Mining cargo', description: 'Unload at your live Orbit segment. Ice delivers energy outside the solar delivery cap.' })) : null,
          grid,
          cue,
        ];
      }
      // Several kinds: icon-first chips (names and per-kind stats in hints); the Tab subgroup is the lit chip.
      const chips = [...counts].map(([k, n]) => {
        const kindRows = [...rows].filter(([key]) => key.startsWith(`${k}|`)).map(([, stats]) => stats);
        return tip(h('span', { class: `unit-chip${k === active ? ' on' : ''}`, 'aria-label': `${KIND_LABEL[k]} ×${n}${k === active ? ' · active unit type' : ''}` }, icon(k, 16), h('span', { class: 'unit-name' }, KIND_LABEL[k]), h('span', { class: 'num' }, `×${n}`)),
          { title: `${KIND_LABEL[k]} ×${n}`, description: k === active ? 'Active unit type: the card shows its orders. Tab cycles unit types.' : 'Tab cycles selected unit types.', ...(kindRows.length ? { stats: statGrid(statCells(kindRows), true) } : {}) });
      });
      return [h('div', { class: `unit-chips${counts.size > 1 ? ' many' : ''}` }, ...chips), grid, cue];
    });

    // orders for the selection: commands, stances and formations, unit and team abilities, Sky structure orders
    if (focus === 'sky') actions.push(...skyActions(v, rules, sel, (intents) => { void this.act('sky', intents); }));
    if (this.dismantleArmed && !(sel.length === 1 && sel[0]!.id === this.dismantleArmed)) this.dismantleArmed = undefined;
    actions.push(...structureActions(v, rules, focus, sel, (intents) => { void this.act(focus, intents); }, this.dismantleArmed, (id) => {
      this.dismantleArmed = id;
      this.renderCard();
    }));
    this.commandCard.update(actions, PLANE_ACCENT[focus]);
    const armed = this.controls.armed;
    const armedKind = armed?.kind ?? '';

    // Production categories come from the same registries as queue entries, never a second plane/item list.
    this.productionTabs.update(focus, v);
    const tab = this.productionTabs.state.get(focus);
    this.el.prod!.setAttribute('aria-labelledby', `production-${focus}-${tab.id}`);
    const productionCost = (item: Exclude<QueueItem, UpgradeId | 'rebuild'>) => {
      const cost = rules.stats[item];
      const multiplier = item === 'digger' && shaft ? rules.economy.shaftDiggerMultiplier : 1;
      return { alloy: Math.ceil(cost.alloy * multiplier), energy: Math.ceil(cost.energy * multiplier), build: cost.build };
    };
    // Queueing in a lane may draw on the free bank plus that lane's own earmark, never another lane's (sim `available`).
    const canPay = (plane: Plane, cost: { alloy: number; energy: number }) => {
      const spendable = seatSpendable(v.res, v.queue, plane);
      return spendable.alloy >= cost.alloy && spendable.energy >= cost.energy;
    };
    const afford = (item: Exclude<QueueItem, UpgradeId | 'rebuild'>) => canPay(tables.stats[item].plane, productionCost(item));
    const spire = rules.spire;
    const rebuildCost = { alloy: spire.rebuildAlloy, energy: spire.rebuildEnergy, build: spire.rebuildTime };
    const rebuildAffordable = segDead && canPay(focus, rebuildCost);
    const hasDigger = sel.some((e) => e.kind === 'digger' && e.side === v.army);
    const aerie = focus === 'sky' ? selectedAerie(sel, v.army) : undefined;
    const items = (shaft && tab.id === 'units' ? [...tab.items, 'digger' as const] : tab.items).filter((item) => productionEnabled(item, rules));
    const itemKey = items.map((item) => {
      if (!isUpgrade(item)) return `${item}:${afford(item)}:${this.canQueue(tables.stats[item].plane)}`;
      const cost = resolveUpgrade(rules, item);
      return `${item}:${v.research.available.includes(item)}:${v.research.inProgress.includes(item)}:${v.research.completed.includes(item)}:${canPay(UPGRADES[item].at, cost)}:${this.canQueue(UPGRADES[item].at)}`;
    }).join('|');
    const prodBefore = this.el.prod!.dataset.key;
    patch(this.el.prod!, `${focus}|${this.canQueue(focus)}|${tab.id}|${itemKey}|${segDead}|${v.res.rebuilds}|${rebuildAffordable}|${aerie?.id ?? ''}|${armedKind}|${armed?.kind === 'build' ? armed.structure : ''}|${hasDigger}|${shaft?.id ?? ''}|${v.research.completed.length}`, () => {
      const availableItems = segDead ? items.filter((item) => (focus === 'depths' && tab.id === 'structures') || item === 'relay' || (item === 'digger' && shaft) || (aerie && isAircraft(item))) : items;
      // A fallen segment offers its rebuild (rules.spire.rebuilds per match; it returns the crown under lossRule crowns).
      const rebuild = segDead && v.res.rebuilds > 0 ? [tip(h('button', {
        class: `prod-btn${rebuildAffordable ? '' : ' poor'}`,
        'aria-label': `Rebuild the ${PLANE_NAME[focus]} segment`,
        'aria-disabled': String(!this.canQueue(focus)),
        disabled: !this.canQueue(focus),
        onclick: () => void this.act(focus, [{ kind: 'queue_add', item: 'rebuild', plane: focus }]).then((ok) => ok && this.toast(`${PLANE_NAME[focus]} rebuild queued`, 'ok')),
      }, icon('rebuild', 24), h('span', { class: 'prod-name' }, 'Rebuild'),
      h('span', { class: 'cost' }, costBadge('alloy', rebuildCost.alloy), costBadge('energy', rebuildCost.energy))),
      { title: `Rebuild the ${PLANE_NAME[focus]} segment`, description: `${v.res.rebuilds} left this match · returns at ${Math.round(spire.rebuildHp * 100)}% HP${spire.lossRule === 'crowns' ? ', with its crown' : ''} · pauses while an enemy is within ${spire.rebuildClearance} tiles\nBuild time: ${spire.rebuildTime}s`, cost: rebuildCost })] : [];
      if (!availableItems.length) return [...rebuild, h('div', { class: 'dead-note' }, segDead ? `${PLANE_NAME[focus]} Spire segment destroyed — no production here${focus === 'depths' ? '. Select a built Surface shaft to queue replacement diggers on its Units tab.' : ''}` : 'No research in this match')];
      return [...rebuild, ...availableItems.map((item) => {
        if (isUpgrade(item)) {
          const upgrade = UPGRADES[item];
          const cost = resolveUpgrade(rules, item);
          const completed = v.research.completed.includes(item);
          const pending = v.research.inProgress.includes(item);
          const available = v.research.available.includes(item);
          const affordable = canPay(upgrade.at, cost);
          const authorized = this.canQueue(upgrade.at);
          const status = !authorized ? 'Read-only lane: no acting credential' : completed ? 'Complete' : pending ? 'Queued / researching' : !available ? 'Research prerequisites required' : !affordable ? 'Waiting for free or own-lane funds when queued' : '';
          return tip(h('button', {
            class: `prod-btn${available && affordable ? '' : ' poor'}`,
            'aria-label': `Research ${upgrade.label}${status ? ` · ${status}` : ''}`,
            'aria-disabled': String(!authorized || !available || completed || pending),
            disabled: !authorized || !available || completed || pending,
            onclick: () => {
              if (!authorized || !available || completed || pending) return;
              void this.act(upgrade.at, [{ kind: 'research', upgrade: item }]).then((ok) => ok && this.toast(`${upgrade.label} queued`, 'ok'));
            },
          }, icon(item, 24), h('span', { class: 'prod-name' }, upgrade.label),
          h('span', { class: 'cost' }, costBadge('alloy', cost.alloy), costBadge('energy', cost.energy))),
          { title: upgrade.label, description: upgradeTip(item, rules), cost, status });
        }
        const structure = tab.id === 'structures';
        const tool = getTool(item === 'relay' || item === 'bulkhead' || item === 'geothermal' ? item : 'build');
        const cost = productionCost(item);
        const fallback = item === 'digger' && shaft;
        const on = structure && (armed?.kind === 'build' ? armed.structure === item : armedKind === item);
        const stats = kindStats(tables, item, tables.stats[item].plane, v.research.completed);
        const authorized = this.canQueue(tables.stats[item].plane);
        return tip(h('button', {
          class: `prod-btn${structure ? ' build' : ''}${afford(item) ? '' : ' poor'}${on ? ' on' : ''}`,
          'aria-label': `${structure ? 'Build ' : 'Produce '}${KIND_LABEL[item]}`,
          ...(structure ? { 'aria-pressed': String(on) } : {}),
          'aria-disabled': String(!authorized || item === 'bulkhead' && !hasDigger),
          disabled: !authorized || item === 'bulkhead' && !hasDigger,
          onclick: (event: Event) => {
            if (!authorized || item === 'bulkhead' && !hasDigger) return;
            if (!structure) this.cmdProduce(item as UnitKind, (event as MouseEvent).shiftKey ? 5 : 1, fallback ? fallback.id : aerie?.id);
            else this.arm(item === 'relay' || item === 'bulkhead' || item === 'geothermal' ? { kind: item } : { kind: 'build', structure: item as (typeof BUILDABLE)[number] });
          },
        }, icon(item, 24), h('span', { class: 'prod-name' }, KIND_LABEL[item]),
        h('span', { class: 'cost' }, costBadge('alloy', cost.alloy), cost.energy ? costBadge('energy', cost.energy) : null)),
        {
          title: fallback ? 'Digger · Shaft fallback' : KIND_LABEL[item],
          description: `${skyStructureHint(item, rules) || KIND_HINT[item] || ''}\n${fallback ? `Produced in the Depths at the selected Shaft · ${rules.economy.shaftDiggerMultiplier}× resource cost.\n` : ''}${item === 'geothermal' ? `${rules.economy.geothermalHealthyRate} energy/s while our Orbit segment lives, ${rules.economy.geothermalRate} after · ${rules.economy.geothermalSurgeMultiplier}× during a surge.\n` : ''}${structure ? tool.hint : `Click: 1 · Shift-click: 5${aerie ? ' · Produced at the selected Aerie' : ''}`}\nBuild time: ${cost.build}s`,
          cost,
          stats: statGrid(statCells([stats], { max: stats.hp, count: 1 }), true),
          status: !authorized ? 'Read-only lane: no acting credential' : item === 'bulkhead' && !hasDigger ? 'Select a digger first' : !afford(item) ? 'Waiting for free or own-lane funds when queued' : '',
        });
      })];
    });

    patch(this.el.macros!, focus, () =>
      PLANE_MACROS[focus].map((m) => h('button', { class: 'btn small macro', 'data-tip': m === 'auto_mine' && focus === 'orbit' ? 'Auto-mine · Idle tugs mine visible nonvolatile ore / ice, unload and find another rock. Move, Stop or Release cancels; queued orders take over after unloading.' : MACRO_LABEL[m] ?? m, 'aria-label': MACRO_LABEL[m] ?? m, onclick: () => this.cmdMacro(m) }, icon(MACRO_ICON[m]!))));
    if (this.el.sel!.dataset.key !== selBefore || this.el.prod!.dataset.key !== prodBefore) this.fitCard();
  }

  /** Nothing on the card scrolls: the summary and production page shed inline detail until they fit (tooltips keep it). */
  private fitCard(): void {
    fitClasses(this.el.selCol!, ['compact']);
    fitClasses(this.el.prod!, ['compact', 'tight']);
  }

  // ---------------------------------------------------------------- orders
  private async act(role: Plane, intents: Intent[]): Promise<boolean> {
    if (!this.conn || !intents.length || this.opts.readOnly) return false;
    if (intents.some((intent) => intent.kind.startsWith('queue_') || intent.kind === 'research') && !this.canQueue(role)) {
      this.toast(`${PLANE_NAME[role]} production is read-only: no acting credential`);
      return false;
    }
    audioOrderSent();
    try {
      const acks = await this.conn.act(role, intents);
      let ok = true;
      acks.forEach((a, i) => {
        if (a.ok) return;
        ok = false;
        const code = ackText(a);
        const what = intents[i]?.kind ?? 'order';
        const gameCode = a.code === 'game' ? a.gameCode : a.code === 'signal' ? a.signalCode : a.code;
        this.toast(`${VERB_LABEL[what] ?? what}: ${VERB_ERROR[what]?.[gameCode] ?? ERROR_TEXT[gameCode] ?? code} · ${code}`);
      });
      if (ok) audioUi('confirm');
      return ok;
    } catch (e) {
      const code = e instanceof CallError ? e.code : 'internal';
      // Before the match starts (a seat still loading or readying) the host refuses orders as `paused`: say so plainly.
      this.toast(code === 'paused' ? `${ERROR_TEXT.paused}…` : `${ERROR_TEXT[code] ?? 'Order failed'} · ${code}`);
      return false;
    }
  }

  private cmdProduce(unit: UnitKind, count: number, producer?: string): void {
    // Wire rules carry numeric overrides only; the compiled registry supplies each unit's production plane.
    const role = this.rules && ruleTables(this.rules).stats[unit].plane;
    if (!role || !this.canQueue(role)) return;
    void this.act(role, [{ kind: 'queue_add', item: unit, count, ...(producer ? { producer } : {}) }]).then((ok) => ok && this.toast(`${KIND_LABEL[unit]}${count > 1 ? ` ×${count}` : ''} queued`, 'ok'));
  }

  /** Queue authority comes from current role credentials, never from controller or request attribution. */
  private canQueue(role: Plane): boolean {
    return !this.opts.readOnly && !!this.conn?.canAct(role);
  }

  private cmdMacro(action: Macro): void {
    const focus = this.world.rig.focus;
    void this.act(focus, [{ kind: 'macro', action }]).then((ok) => ok && this.toast(`${MACRO_LABEL[action] ?? action}`, 'ok'));
  }

  private arm(a: Armed | undefined): void {
    this.controls.arm(a);
  }

  /** Commander focus point picked on the map: update the live mandate's directive. */
  private pickDirective(role: Plane, x: number, y: number): void {
    const cur = this.seatFor(role).mandate;
    this.conn
      ?.setMandate(role, { ...cur, directive: { ...cur.directive, focusX: x, focusY: y } })
      .then(() => this.toast(`${PLANE_NAME[role]} focus set`, 'ok'))
      .catch((err: unknown) => this.toast(`Directive: ${errCode(err)}`));
  }

  // ---------------------------------------------------------------- planes / camera
  goTo(p: Plane): void {
    const rig = this.world.rig;
    // Picking the plane already in view does nothing; picking it again mid-dive lands the dive at once.
    if (p === rig.focus) {
      if (rig.diving) rig.goTo(p, performance.now(), 'jump');
      return;
    }
    rig.goTo(p, performance.now(), 'jump');
    this.controls.onPlane(p);
    const b = this.el.banner!;
    b.replaceChildren(h('b', { class: 'section', style: `--accent:${PLANE_ACCENT[p]}`, 'data-tip': PLANE_BLURB[p] }, icon(p, 22), ' ', PLANE_NAME[p]));
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    this.renderSwitcher();
    this.renderCard();
    if (this.view) this.queuePanel.update(this.view);
  }

  private jumpTo(p: Plane, x: number, y: number): void {
    this.goTo(p);
    this.world.rig.lookAtTile(x, y);
  }

  private jumpOrGo(p: Plane, x: number | undefined, y: number | undefined): void {
    if (x === undefined || y === undefined) this.goTo(p);
    else this.jumpTo(p, x, y);
  }

  /**
   * A request clicked in the feed or on a chip: jump to its tile on `plane` (else the plane that answers it) and, while
   * it still waits there for a plane the human controls, take it as that plane.
   */
  private openSignal(e: SignalEntry, plane?: Plane): void {
    const now = this.view?.signals.find((s) => s.id === e.id && s.tick === e.tick) ?? e;
    const p = plane ?? signalPlane(now);
    this.jumpOrGo(p, now.x === undefined ? undefined : now.x + 0.5, now.y === undefined ? undefined : now.y + 0.5);
    if (now.state === 'submitted' && answerers(now).includes(p) && this.signalHooks.mine(p)) this.signalHooks.answer(now, p, 'ack');
  }

  // ---------------------------------------------------------------- commanders
  /** ` or the Commanders button: the commander popover of the plane in view. */
  private toggleCommander(): void {
    this.commanders.toggle(this.world.rig.focus);
  }

  // ---------------------------------------------------------------- outcome
  private showOutcome(): void {
    const v = this.view;
    const r = this.report;
    const outcome = r?.outcome ?? v?.outcome ?? 'running';
    if (outcome === 'running') return;
    this.reportShown = true;
    if (!this.outcomeHeard) {
      this.outcomeHeard = true;
      audioOutcome(outcome);
    }
    const el = this.el.outcome!;
    el.replaceChildren(outcomeCard({
      outcome,
      label: this.opts.label,
      report: r,
      view: v,
      army: this.viewArmy ?? v?.army,
      exit: () => this.exit(),
      keepLooking: () => el.classList.add('hidden'),
    }));
    el.classList.remove('hidden');
  }

  /**
   * Our Spire fell while other armies fight on (DESIGN §15.7): the place we finished, then the perspective to watch
   * the rest from (an observer pass). The after-action report replaces this card if the match ends first.
   */
  private showElimination(v: MatchView): void {
    this.eliminationShown = true;
    // Out for good: the server re-tickets no seats now, so a dropped seat connection is not recovered.
    this.conn?.eliminated();
    if (!this.outcomeHeard) {
      this.outcomeHeard = true;
      audioOutcome('loss');
    }
    const el = this.el.outcome!;
    const spectate = this.opts.spectate;
    const note = h('p', { class: 'outcome-note muted', role: 'status', 'aria-live': 'polite' });
    let pending = false;
    const choose = (perspective: ArmyId | 'all') => {
      if (pending || !spectate) return;
      pending = true; this.observerHandoff = true;
      note.textContent = 'Requesting an observer pass…';
      spectate(perspective).catch((error: unknown) => {
        pending = false; this.observerHandoff = false;
        note.textContent = error instanceof ApiError && error.code === 'still_playing' ? 'Your result is not final yet. Try again in a moment.' : 'Could not open the observer. Try again.';
      });
    };
    el.replaceChildren(
      h('div', { class: 'outcome-card loss eliminated' },
        h('div', { class: 'outcome-kicker' }, `${armyLabel(v.match, v.army)} Spire fallen`),
        h('div', { class: 'outcome-title' }, v.rank === undefined ? 'Eliminated' : `Eliminated — ${placeLabel(v.rank)}`),
        h('div', { class: 'outcome-meta' }, `${this.opts.label} · ${v.match.armies.length - v.eliminated.length} of ${v.match.armies.length} armies still fighting`),
        spectate ? perspectiveChoice(v.match, v.army, choose) : null,
        note,
        h('div', { class: 'outcome-actions' },
          h('button', { class: 'btn primary', 'data-tip': 'Back to lobby', 'aria-label': 'Back to lobby', onclick: () => this.exit() }, icon('leave')),
          h('button', { class: 'btn ghost', 'data-tip': 'Keep looking', 'aria-label': 'Keep looking', onclick: () => el.classList.add('hidden') }, icon('spectate'))),
      ),
    );
    el.classList.remove('hidden');
  }

  private exit(): void {
    this.dispose();
    this.opts.onExit();
  }

  /** Per-frame HUD bits and the audio listener. */
  frame(): void {
    this.controls.frame();
    const now = performance.now();
    this.minimap.draw(this.world, now);
    const rig = this.world.rig;
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
  }
}

function errCode(err: unknown): string {
  const code = err instanceof CallError ? err.code : 'internal';
  return `${ERROR_TEXT[code] ?? code} · ${code}`;
}
