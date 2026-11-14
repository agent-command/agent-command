import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SeatInfo } from 'playerthree';
import type { ObserverFrame, ObserverGrant, ObserverMessage } from 'playerthree/protocol';
import { patch } from 'playerthree/delta';
import { ARMIES, isArmyId, type ArmyId } from '@agent-command/game/contract';
import { sendJson } from './http.ts';
import type { LobbyMatch } from './lobby-match.ts';
import type { GameMatch } from './room.ts';

/** Wall-clock delay of every built-in-bot featured stream (omniscient and fogged), independent of the tick rate. */
export const FEATURED_DELAY_MS = 3000;
/**
 * Every public observer view of a game is at least this late (DESIGN §2.4): a public lobby's floor, the rated queue's
 * delay, and the delay of every featured stream of a game with a human or agent seat.
 */
export const PUBLIC_OBSERVER_DELAY_MS = 180_000;
/** How often the session lifecycle (open, cut over, rotate, release) is checked. */
const PUMP_MS = 1000;
/** A reader whose socket stays full this long is dropped; a shorter stall resumes at a fresh keyframe. */
const SLOW_CLIENT_MS = 5000;
/** The final frames stay up this long after their release so viewers see the result before the next match. */
const END_HOLD_MS = 8000;
/**
 * A public game already past its delay (a successor primary picking up the current game) normally has a released
 * keyframe within a moment: the relay waits this long for it before it opens a bot match instead.
 */
const PICKUP_GRACE_MS = 5000;

/** One featured stream: an army's fogged view, or `all`, the omniscient projection. */
export type FeaturedPerspective = ArmyId | 'all';

/**
 * Nobody behind these seats can be coached: each is played by a built-in bot with no agent present. Only then may a
 * stream at the featured delay show everything.
 */
export function builtInBotsOnly(seats: readonly Pick<SeatInfo, 'controller' | 'agentActive'>[]): boolean {
  return seats.length > 0 && seats.every((seat) => seat.controller === 'bot' && !seat.agentActive);
}

/**
 * Source frames of one featured stream. A team grant passes through. An omniscient grant at the public observer delay
 * is the view the public rules give anyone, whoever plays; a shorter one (the bot playlist's) ends at the first frame
 * released after any seat stops being a built-in bot (a controller change or an agent arriving mid-match).
 */
export async function* featuredFrames(match: Pick<GameMatch, 'observerFrames' | 'seats'>, grant: ObserverGrant): AsyncGenerator<ObserverFrame> {
  const publicDelay = grant.delayMs >= PUBLIC_OBSERVER_DELAY_MS;
  for await (const frame of match.observerFrames(grant)) {
    if (grant.kind === 'omniscient' && !publicDelay && !builtInBotsOnly(match.seats())) return;
    yield frame;
  }
}

/** Relay one main-process match's featured frames to `frame`; returns stop. */
export function observeMatch(match: Pick<GameMatch, 'observerFrames' | 'seats'>, grant: ObserverGrant, frame: (frame: ObserverFrame) => void): () => void {
  let open = true;
  void (async () => {
    try { for await (const next of featuredFrames(match, grant)) { if (!open) return; frame(next); } }
    catch { /* The stream closed with its match; the relay rotates on release. */ }
  })();
  return () => { open = false; };
}

/** The grant behind one featured perspective at `delayMs`. */
export function featuredGrant(perspective: FeaturedPerspective, armies: readonly ArmyId[], delayMs: number): ObserverGrant {
  return perspective === 'all' ? { kind: 'omniscient', teams: [...armies], delayMs } : { kind: 'team', team: perspective, delayMs };
}

/**
 * Seat identity shown to featured viewers: what a public lobby already shows anyone. Bots by level, humans by their
 * lobby display name, commanders by their public seat card (`AI Player` or the harness label); never owners,
 * commander refs or credentials.
 */
export interface FeaturedSeat { team: ArmyId; role: string; kind: 'bot' | 'human' | 'agent' | 'policy'; level?: string; name?: string }

export interface FeaturedSession {
  roomId: string;
  /** `public`: a running public game (lobby or rated); otherwise a bot playlist match the relay opened. */
  public: boolean;
  /** The match's armies, each with its own delayed perspective. */
  armies: readonly ArmyId[];
  seats: readonly FeaturedSeat[];
  /** Matchup line shown to viewers (bot levels and map, or the players' public names); empty for the fixed duel. */
  label: string;
  /**
   * The relay serves `all`: a bot match whose seats were all built-in bots at open (`builtInBotsOnly`), or a public
   * game whose observer policy allows an omniscient view; otherwise only army streams.
   */
  omniscient: boolean;
  /** Release delay of every stream: `FEATURED_DELAY_MS` for bots, the game's own observer delay for a public game. */
  delayMs: number;
  /** Released frames of one perspective at `delayMs`: one keyframe, then each delta. */
  observe(perspective: FeaturedPerspective, frame: (frame: ObserverFrame) => void): () => void;
  ended(): boolean | Promise<boolean>;
  /** A bot match: release the worker's reserved capacity slot as well as the simulation. A public game: nothing. */
  close(): Promise<void>;
  /** A public game: the armies `owner` played in it (they may watch only those), or undefined for a non-player. */
  played?(owner: string): readonly ArmyId[] | undefined;
}

/** A running public game the relay may feature (a public lobby left on Watch live, or a rated match). */
export interface PublicGame {
  roomId: string;
  /** Wall clock (ms) its play began: the newest is featured. */
  startedAt: number;
  /** Its observer policy's delay (never below `PUBLIC_OBSERVER_DELAY_MS`). */
  delayMs: number;
  /** Its observer policy allows an omniscient view (public lobbies do, rated matches do not). */
  omniscient: boolean;
  armies: readonly ArmyId[];
  seats: readonly FeaturedSeat[];
  label: string;
  game: LobbyMatch;
  /** The armies `owner` played in it, or undefined for a non-player. */
  played(owner: string): readonly ArmyId[] | undefined;
}

/** The honest matchup line: each army's public names (`Player 1 + AI Player`, `Veteran bot`), army against army. */
export function featuredMatchup(armies: readonly ArmyId[], seats: readonly FeaturedSeat[]): string {
  return armies.map((army) => [...new Set(seats.filter((seat) => seat.team === army).map((seat) => seat.kind === 'bot'
    ? `${(seat.level ?? 'bot').charAt(0).toUpperCase()}${(seat.level ?? 'bot').slice(1)} bot` : seat.name ?? 'Player'))].join(' + ')).join(' vs ');
}

export interface FeaturedOptions {
  /** Open an agents-mode, realtime-speed-one bot match in the reserved worker slot. */
  open(): Promise<FeaturedSession>;
  /** Capacity/lag gate; must not consume a player queue ticket. */
  canStart(): boolean;
  /** Eligible running public games, across every node (the coordinator's lobbies and rated matches). */
  publicGames(): readonly PublicGame[];
  /** Follow one public game's delayed streams at its own delay (never closes the game). */
  openPublic(game: PublicGame): FeaturedSession;
  /** The lobby identity behind a stream request's credential (undefined: an anonymous public reader). */
  viewer(req: IncomingMessage): string | undefined;
  maxMatchMs: number;
  /** Bound fan-out separately from simulation capacity; rejected viewers never enter the relay. */
  viewerLimits: { total: number; perIp: number; ip(req: IncomingMessage): string };
}

export interface FeaturedStats {
  viewers: number;
  /** The match on air has a released frame. */
  ready: boolean;
  /** The bot match holding the relay's reserved slot (on air or cut away from and running to its end). */
  activeRoomId?: string;
  /** What viewers see now. */
  onAir?: { roomId: string; public: boolean };
  /** A public game waiting for its delayed stream's first frame before the relay cuts over to it. */
  upcoming?: { roomId: string };
  delayMs: number;
}

/** The relay's surface. Cluster mode runs it on the coordinator only; retiring it closes every viewer, who reconnect. */
export interface FeaturedRelay {
  start(): void;
  stats(): FeaturedStats;
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  close(): Promise<void>;
}

interface Viewer {
  res: ServerResponse;
  perspective: FeaturedPerspective;
  /** The reader's lobby identity, when its request carried one. */
  owner: string | undefined;
  /** False while the match on air is one this reader played and this perspective is not its own side. */
  allowed: boolean;
  /** Last sequence written; undefined until the reader has a keyframe of the current match. */
  sequence: number | undefined;
  blockedAt?: number;
}

/** One perspective's released stream, rebuilt once in this process and relayed to every viewer of it. */
interface Channel {
  sequence: number;
  state: unknown;
  frame: ObserverFrame | undefined;
  /** SSE bytes of the current keyframe, encoded on the first join after each frame. */
  keyframe: Buffer | undefined;
}

/** One featured match the relay follows: on air, warming up (a public game), or a bot match running off air. */
interface Live {
  session: FeaturedSession;
  openedAt: number;
  startedAt: number;
  /** When its delayed stream should have its first frame (a public game; bots at once). */
  liveAt: number;
  endedAt: number | undefined;
  channels: Map<FeaturedPerspective, Channel>;
  /** The current subscription: frames of an older one (before a cut away and resume) are ignored. */
  run: symbol | undefined;
  unsubscribe: (() => void)[];
  announce: Buffer;
}

const sse = (event: string, data: unknown): Buffer => Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * A broadcast relay for the public featured match (GOTV style): one match on air, one delayed observer stream per
 * perspective, each frame serialized once and written to every viewer of it. Joins and stalled readers get one
 * keyframe of the current released state, then the shared deltas. The public endpoint has no match token and no
 * command channel; only delayed views leave it.
 *
 * On air is the newest eligible public game once its delayed stream has a frame, else the bot playlist. A public
 * game is announced (`upcoming`) while its stream warms up; the relay cuts over at its first released frame, holds
 * its result after its delayed end, then resumes the bot match it cut away from (which kept running) or opens the
 * next one. A player of the public game on air (identified by its request credential) may watch only its own side.
 */
export function createFeatured(options: FeaturedOptions): FeaturedRelay {
  const viewers = new Set<Viewer>();
  const viewersPerIp = new Map<string, number>();
  /** The bot match holding the reserved slot, the match on air, and a public game warming up. */
  let bot: Live | undefined;
  let onAir: Live | undefined;
  let next: Live | undefined;
  let started = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pumping: Promise<void> | undefined;

  function write(viewer: Viewer, bytes: Buffer, now: number): void {
    if (!viewer.res.write(bytes)) viewer.blockedAt = now;
  }

  function keyframe(channel: Channel): Buffer | undefined {
    const frame = channel.frame;
    if (!frame) return undefined;
    channel.keyframe ??= sse('observer', {
      op: 'observer', state: 'ready',
      frame: { sequence: frame.sequence, tick: frame.tick, recordedAt: frame.recordedAt, releaseAt: frame.releaseAt, perspective: frame.perspective, world: channel.state, ...(frame.outcomes ? { outcomes: frame.outcomes } : {}) },
    } satisfies ObserverMessage);
    return channel.keyframe;
  }

  /** The armies a reader may watch of the match on air: its own sides if it played it, else everything. */
  function played(viewer: Viewer): readonly ArmyId[] | undefined {
    return viewer.owner === undefined ? undefined : onAir?.session.played?.(viewer.owner);
  }

  /** The announcement this reader gets: the shared one, or its own sides only when it played the match on air. */
  function announcement(viewer: Viewer): Buffer | undefined {
    if (!onAir) return undefined;
    const own = played(viewer);
    if (!own) return onAir.announce;
    const session = onAir.session;
    return sse('match', { roomId: session.roomId, public: session.public, delayMs: session.delayMs, armies: own, seats: session.seats, label: session.label, omniscient: false, played: true });
  }

  function upcoming(): Buffer {
    return sse('upcoming', next ? { roomId: next.session.roomId, label: next.session.label, liveInMs: Math.max(0, next.liveAt - Date.now()) } : null);
  }

  /** Bring one reader up to date: a keyframe (join, stall, cut over) or nothing (live readers get deltas). */
  function catchUp(viewer: Viewer, now: number): void {
    const { res } = viewer;
    if (res.destroyed || res.writableEnded) { viewers.delete(viewer); return; }
    if (viewer.blockedAt !== undefined) {
      if (now - viewer.blockedAt >= SLOW_CLIENT_MS) res.destroy();
      return;
    }
    if (!viewer.allowed) return;
    const channel = onAir?.channels.get(viewer.perspective);
    if (viewer.sequence !== undefined || !channel?.frame) return;
    const bytes = keyframe(channel);
    if (!bytes) return;
    viewer.sequence = channel.sequence;
    write(viewer, bytes, now);
  }

  function relay(live: Live, perspective: FeaturedPerspective, frame: ObserverFrame): void {
    let channel = live.channels.get(perspective);
    if (!channel) live.channels.set(perspective, channel = { sequence: 0, state: undefined, frame: undefined, keyframe: undefined });
    if (frame.world !== undefined) channel.state = frame.world;
    else if (frame.sequence !== channel.sequence + 1) return;
    else if (frame.delta) channel.state = patch(channel.state, frame.delta);
    const continuous = frame.world === undefined;
    channel.sequence = frame.sequence;
    channel.frame = frame;
    channel.keyframe = undefined;
    // A public game warming up keeps its released state here; its readers get it as a keyframe at the cut over.
    if (live !== onAir) return;
    const now = Date.now();
    let delta: Buffer | undefined;
    for (const viewer of viewers) {
      if (viewer.perspective !== perspective) continue;
      // A reader with the previous frame takes the shared delta; any other reader needs a keyframe.
      if (continuous && viewer.sequence === frame.sequence - 1 && viewer.allowed && viewer.blockedAt === undefined && !viewer.res.destroyed) {
        delta ??= sse('observer', { op: 'observer', state: 'ready', frame } satisfies ObserverMessage);
        viewer.sequence = frame.sequence;
        write(viewer, delta, now);
      } else {
        viewer.sequence = undefined;
        catchUp(viewer, now);
      }
    }
  }

  function follow(session: FeaturedSession, startedAt: number, liveAt: number): Live {
    const live: Live = {
      session, openedAt: Date.now(), startedAt, liveAt, endedAt: undefined, channels: new Map(), run: undefined, unsubscribe: [],
      announce: sse('match', { roomId: session.roomId, public: session.public, delayMs: session.delayMs, armies: session.armies, seats: session.seats, label: session.label, omniscient: session.omniscient }),
    };
    subscribe(live);
    return live;
  }

  /** Observe every perspective the session serves (a match with no omniscient view never opens `all`). */
  function subscribe(live: Live): void {
    const run = Symbol(live.session.roomId);
    live.run = run;
    live.channels.clear();
    const perspectives: FeaturedPerspective[] = live.session.omniscient ? ['all', ...live.session.armies] : [...live.session.armies];
    live.unsubscribe = perspectives.map((perspective) => live.session.observe(perspective, (frame) => { if (live.run === run) relay(live, perspective, frame); }));
  }

  /** Stop relaying a match (it keeps running where it runs). */
  function quiet(live: Live): void {
    for (const off of live.unsubscribe) off();
    live.unsubscribe = [];
    live.run = undefined;
    live.channels.clear();
  }

  /** Stop following a match: off air, its subscription closed and, for a bot match, its slot released. */
  async function drop(live: Live): Promise<void> {
    if (onAir === live) onAir = undefined;
    if (bot === live) bot = undefined;
    if (next === live) {
      next = undefined;
      broadcast(upcoming());
    }
    quiet(live);
    await live.session.close();
  }

  function broadcast(bytes: Buffer): void {
    const now = Date.now();
    for (const viewer of viewers) if (viewer.blockedAt === undefined) write(viewer, bytes, now);
  }

  /** Put `live` on air: every reader is announced the match (their own sides if they played it) and resynchronized. */
  function show(live: Live): void {
    onAir = live;
    const now = Date.now();
    for (const viewer of viewers) {
      viewer.sequence = undefined;
      const own = played(viewer);
      viewer.allowed = !own || viewer.perspective !== 'all' && own.includes(viewer.perspective);
      const bytes = announcement(viewer);
      if (bytes && viewer.blockedAt === undefined) write(viewer, bytes, now);
    }
  }

  const isReady = (live: Live) => [...live.channels.values()].some((channel) => channel.frame !== undefined);

  async function pump() {
    const now = Date.now();
    // A bot match runs to its own end. On air it is released after its delay and a short result hold; cut away from,
    // as soon as it ends. Either way at the transport lifetime limit.
    if (bot) {
      const live = bot;
      if (live.endedAt === undefined && await live.session.ended()) live.endedAt = Date.now();
      const done = live.endedAt !== undefined && (live !== onAir || now >= live.endedAt + live.session.delayMs + END_HOLD_MS);
      if (done || now - live.openedAt >= Math.max(1, options.maxMatchMs - PUMP_MS)) await drop(live);
    }
    // A public game on air holds its result after its delayed end, then gives the air back.
    if (onAir?.session.public) {
      const live = onAir;
      if (live.endedAt === undefined && await live.session.ended()) live.endedAt = Date.now();
      if (live.endedAt !== undefined && now >= live.endedAt + live.session.delayMs + END_HOLD_MS) await drop(live);
    }
    // The newest eligible public game. While a public game is on air, only a newer one cuts in; an older one still
    // running waits (warmed up) for the end of the delayed playback on air.
    const showing = onAir?.session.public ? onAir : undefined;
    let pick: PublicGame | undefined;
    for (const game of options.publicGames()) {
      if (game.roomId === onAir?.session.roomId || showing && showing.endedAt === undefined && game.startedAt <= showing.startedAt) continue;
      if (!pick || game.startedAt > pick.startedAt) pick = game;
    }
    if (next && next.session.roomId !== pick?.roomId) await drop(next);
    if (pick && !next && !stopped) {
      next = follow(options.openPublic(pick), pick.startedAt, pick.startedAt + pick.delayMs);
      broadcast(upcoming());
    }
    // Cut over at the public game's first released frame. A bot match cut away from keeps running off air.
    if (next && isReady(next) && (!showing || next.startedAt > showing.startedAt)) {
      const live = next;
      next = undefined;
      const previous = onAir;
      if (previous?.session.public) await drop(previous);
      else if (previous) quiet(previous);
      broadcast(upcoming());
      show(live);
    }
    if (!onAir && !stopped) {
      if (bot) {
        // Back to the bot match the public game cut away from: a fresh keyframe of where it is now.
        subscribe(bot);
        show(bot);
      } else if (!(next && now >= next.liveAt && now - next.openedAt < PICKUP_GRACE_MS) && options.canStart()) {
        const opened = await options.open();
        if (stopped) {
          await opened.close();
          return;
        }
        const at = Date.now();
        bot = follow(opened, at, at);
        show(bot);
      }
    }
    const at = Date.now();
    for (const viewer of viewers) catchUp(viewer, at);
  }

  async function dropAll(): Promise<void> {
    for (const live of new Set([next, onAir, bot])) if (live) await drop(live);
  }

  function schedule() {
    if (pumping || stopped) return;
    // Opening is single-flight, including when the host needs time to create its transport room.
    pumping = pump().catch(() => dropAll().catch(() => {})).finally(() => { pumping = undefined; });
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      timer = setInterval(schedule, PUMP_MS);
      timer.unref();
      schedule();
    },
    stats() {
      return {
        viewers: viewers.size, ready: onAir ? isReady(onAir) : false,
        ...(bot ? { activeRoomId: bot.session.roomId } : {}),
        ...(onAir ? { onAir: { roomId: onAir.session.roomId, public: onAir.session.public } } : {}),
        ...(next ? { upcoming: { roomId: next.session.roomId } } : {}),
        delayMs: onAir?.session.delayMs ?? FEATURED_DELAY_MS,
      };
    },
    /** Call after the server's normal origin/security handling and before its generic /api fallback. */
    handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
      if (path !== '/api/featured' && path !== '/api/featured/stream') return false;
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return true;
      }
      if (stopped) {
        sendJson(res, 503, { error: 'draining' });
        return true;
      }
      if (path === '/api/featured') {
        sendJson(res, 200, this.stats(), { 'Cache-Control': 'no-store' });
        return true;
      }
      // Any army id is accepted: a perspective the current match lacks simply has no frames. So is `all`: a match
      // without an omniscient view announces `omniscient: false` to its readers and never sends them a frame.
      const team = new URL(req.url ?? '/', 'http://localhost').searchParams.get('team') ?? ARMIES[0];
      if (team !== 'all' && !isArmyId(team)) {
        sendJson(res, 400, { error: 'bad_team' });
        return true;
      }
      const ip = options.viewerLimits.ip(req);
      const ipViewers = viewersPerIp.get(ip) ?? 0;
      if (ipViewers >= options.viewerLimits.perIp) {
        sendJson(res, 429, { error: 'stream_capacity' }, { 'Retry-After': '5' });
        return true;
      }
      if (viewers.size >= options.viewerLimits.total) {
        sendJson(res, 503, { error: 'stream_capacity' }, { 'Retry-After': '5' });
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      // A credential that names nobody (expired visitor, unknown profile) is an anonymous public reader.
      let owner: string | undefined;
      try { owner = options.viewer(req); } catch { owner = undefined; }
      const viewer: Viewer = { res, perspective: team, owner, allowed: true, sequence: undefined };
      const own = played(viewer);
      viewer.allowed = !own || team !== 'all' && own.includes(team);
      viewers.add(viewer);
      viewersPerIp.set(ip, ipViewers + 1);
      // A frame relayed during a stall drops the reader's cursor (relay): it resumes at the current keyframe, never a
      // backlog. A full buffer alone (a keyframe larger than the socket's high-water mark) keeps it: everything written
      // is still queued, and re-sending the keyframe on every drain would loop at socket speed.
      res.on('drain', () => { viewer.blockedAt = undefined; catchUp(viewer, Date.now()); });
      res.once('close', () => {
        viewers.delete(viewer);
        const left = (viewersPerIp.get(ip) ?? 1) - 1;
        if (left > 0) viewersPerIp.set(ip, left);
        else viewersPerIp.delete(ip);
      });
      const now = Date.now();
      const delayMs = onAir?.session.delayMs ?? FEATURED_DELAY_MS;
      const grant: ObserverGrant = team === 'all'
        ? { kind: 'omniscient', teams: [...(onAir?.session.armies ?? [])], delayMs }
        : { kind: 'team', team, delayMs };
      write(viewer, sse('observer', { op: 'observer', state: 'buffering', grant } satisfies ObserverMessage), now);
      const bytes = announcement(viewer);
      if (bytes) write(viewer, bytes, now);
      if (next) write(viewer, upcoming(), now);
      catchUp(viewer, now);
      return true;
    },
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const viewer of viewers) viewer.res.destroy();
      viewers.clear();
      await pumping;
      await dropAll();
    },
  };
}
