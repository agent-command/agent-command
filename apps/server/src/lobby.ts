/** One server-owned lobby pipeline for play, hosting, observers and benchmarks. */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Room, matchMaker, type Client } from '@colyseus/core';
import { PlayerThreeError, surfaceHash, mergeMatchOptions } from 'playerthree';
import type { MatchSpec, ObserverGrant, SlotOccupant } from 'playerthree/arena';
import type { LobbyReservation, MatchLogFacts, SeatAssignment } from 'playerthree/host';
import { LOBBY_MOVED_CLOSE, lobbyLayout, lobbyMap, lobbyMode, type LobbyMember, type LobbyModeDescriptor, type LobbyPhase, type LobbySeat, type LobbySnapshot, type LobbySummary } from '@agent-command/game/lobby';
import { arenaRulesHash, arenaMapIdentity } from '@agent-command/game/arena';
import { definition, lobbySummary, resolveRules, resolveRulesPreset, RULE_PRESETS, rulesOptions, diffRules, isCustomRules, resolveBotOptions, hostileSide, COLOURS, OPPONENTS, type ArmyId, type Colour, type Opponent, type MatchOptions, type Rules, type Plane } from '@agent-command/game';
import type { ServerConfig } from './config.ts';
import type { GameHost } from './room.ts';
import type { LobbyMatch } from './lobby-match.ts';
import type { LobbyCheckpoints } from './cluster.ts';
export type { LobbyMatch } from './lobby-match.ts';
import { clientIp, HttpError, originAllowed, RateLimiter, readJson, sendJson } from './http.ts';
import { requestRules } from './rules.ts';
import { featuredMatchup, PUBLIC_OBSERVER_DELAY_MS, type FeaturedSeat, type PublicGame } from './featured.ts';

export const LOBBY_ROOM = 'agent_command_lobby';
export const DIRECTORY_ROOM = 'agent_command_lobbies';
/** A fresh seat ticket is an unclaimed bearer credential: a short admission window. */
const SEAT_TICKET_TTL_S = 120;
/**
 * A renewal extends a credential already bound to a live socket, so its expiry only backstops a forgotten connection.
 * The protocol maximum keeps a background tab (whose timers the browser may delay by a minute) well inside it.
 */
const SEAT_RENEWAL_TTL_S = 600;
/**
 * A seat or observer ticket the match refuses is an answer, not a server fault: 4xx with the host's code and no logged
 * stack. Workers and cluster peers carry the host's code on an HttpError.
 */
function refused(error: unknown): never {
  const code = error instanceof PlayerThreeError || error instanceof HttpError ? error.code : undefined;
  if (code === 'forbidden') throw new HttpError(403, 'forbidden');
  if (code === 'invalid') throw new HttpError(400, 'invalid');
  if (code === 'bad_token') throw new HttpError(409, 'bad_token');
  throw error;
}
const CODE_RE = /^[A-Za-z0-9_-]{16}$/;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const opaque = (): string => randomBytes(24).toString('base64url');
interface Member {
  owner: string; id: string; label: string; observer: boolean; ready: boolean;
  holdUntil: number; gameHoldUntil?: number; client?: Client; gameTokens: Set<string>;
}
interface Slot { team: ArmyId; role: Plane; occupant: SlotOccupant; owner?: string; ownerControl?: boolean; assignedAt: number }
/** One army of the lobby: its corner, label and colour (`alliance` IS the colour, DESIGN §15.3). */
type LobbySide = LobbyModeDescriptor['sides'][number];
export interface LobbyOpenOptions {
  speed: number; identity: string;
  /** A secret match seed the caller derived (arena scenarios); absent, every match draws a fresh one (matchSeeding). */
  secretSeed?: number;
  /** The match's armies (slot order) and its alliances keyed by colour (stage 2: one army per colour). */
  teams: readonly ArmyId[];
  alliances: Readonly<Record<string, readonly ArmyId[]>>;
  observerPolicy: { allowOmniscient: boolean; minDelayMs: number; public: boolean };
  botSeats: readonly { team: ArmyId; role: Plane; level: string; options: Record<string, number | boolean> }[];
  metricSampleEveryTicks?: number;
  maxWallMs?: number;
  /** Stable play owner of the lobby's creator, attached to the live match for restart reclamation. */
  ownerKey?: string;
  /** The agents' pre-match summary (manifest.lobby), shown while the match is held. */
  lobby?: unknown;
  /** Commander-log facts of the match (PlayerThree `CreateMatchOptions.log`). */
  log?: MatchLogFacts;
}
/** PlayerThree match armies and colour-keyed alliances for lobby or arena sides (`alliance` is the side's colour). */
export function matchSides(sides: readonly { id: ArmyId; alliance: string }[]): Pick<LobbyOpenOptions, 'teams' | 'alliances'> {
  const alliances: Record<string, ArmyId[]> = {};
  for (const side of sides) (alliances[side.alliance] ??= []).push(side.id);
  return { teams: sides.map((side) => side.id), alliances };
}
/** Side colours after a `colours` request (sparse, by army id): stage 2 keeps every army a distinct colour (§15.11). */
function sideColours(sides: readonly LobbySide[], input: unknown): LobbySide[] {
  if (input === undefined) return sides.map((side) => ({ ...side }));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'bad_colour');
  const colours = input as Record<string, unknown>;
  if (Object.entries(colours).some(([id, colour]) => !sides.some((side) => side.id === id) || !(COLOURS as readonly unknown[]).includes(colour))) throw new HttpError(400, 'bad_colour');
  const next = sides.map((side) => ({ ...side, alliance: (colours[side.id] as Colour | undefined) ?? side.alliance }));
  if (new Set(next.map((side) => side.alliance)).size !== next.length) throw new HttpError(409, 'colour_taken');
  return next;
}
export interface ResolvedLobbyRules {
  rules: Rules; options: MatchOptions;
  rulesHash: string; rulesDiff: LobbySummary['rulesDiff']; customRules: boolean;
}
interface Pregame extends ResolvedLobbyRules {
  code: string; roomId: string; mode: LobbyModeDescriptor; sides: LobbySide[]; mapSeed: number; size: number; observerDelayMs: number;
  visibility: 'public' | 'private'; phase: LobbyPhase; leader: string; members: Map<string, Member>; slots: Slot[];
  revision: number; expiresAt: number; generation: number; work: Promise<void>; signature: string;
  autoStart: boolean; benchmark: boolean; running: boolean; playerHistory: Map<string, string>; playOwner: string;
  /** The host leaves a public lobby's game on Watch live (`featured`, default on); a private one is never featured. */
  featured: boolean;
  /** Wall clock (ms) the match began to run: the featured relay shows the newest public game. */
  runningAt?: number;
  /** Armies of the current match already forfeited (left or absent): never forfeited twice. */
  forfeited: Set<ArmyId>;
  countdownAt?: number; preparingUntil?: number; handoffUntil?: number; queuePosition?: number; estimatedWaitMs?: number; game?: LobbyMatch;
  publicFrozen?: { summary: LobbySummary; players: LobbyMember[] };
  /** Commander lanes this lobby reserved for its agents: lane key → the reservation JSON last sent (sends only changes). */
  reserved: Map<string, string>;
  /** An owner played hostile armies in this match (`cross-side owner`): kept once the match exists, so a later hand-over
   *  cannot make it look ranked. Drafts before the match follow the current seats. */
  crossSide: boolean;
}
interface Grant { key: string; owner: string; roomId: string; ip: string; code?: string; expiresAt: number; connection?: string }
/** A visitor credential as checkpointed (keyed by its digest). */
interface VisitorRecord { owner: string; expiresAt: number }
/**
 * A lobby as checkpointed in cluster mode: everything but its sockets, grants, timers, in-flight work and members'
 * match credentials (a fresh ticket replaces a seat's credential anyway). Its match is referenced by room id.
 */
interface LobbyRecord extends ResolvedLobbyRules {
  code: string; mapId: string; layoutId: string; sides: LobbySide[]; mapSeed: number; size: number; observerDelayMs: number;
  visibility: 'public' | 'private'; phase: LobbyPhase; leader: string; slots: Slot[]; revision: number; expiresAt: number;
  generation: number; autoStart: boolean; benchmark: boolean; running: boolean; playOwner: string; crossSide: boolean;
  featured: boolean; runningAt?: number;
  members: Pick<Member, 'owner' | 'id' | 'label' | 'observer' | 'ready' | 'gameHoldUntil'>[];
  playerHistory: [string, string][]; forfeited: ArmyId[]; handoffUntil?: number;
  publicFrozen?: Pregame['publicFrozen']; game?: string;
}
export interface LobbyContext {
  config: ServerConfig; host: GameHost;
  profileOf(req: IncomingMessage): string | undefined; accepting(): boolean;
  open(identity: string, assignments: SeatAssignment[], options: MatchOptions, queued: (state?: { position: number; estimatedWaitMs: number }) => void, current: () => boolean, settings: LobbyOpenOptions): Promise<LobbyMatch>;
  /** Profile → `profile:<id>`; a visitor → its HttpOnly browser cookie (lobby visitor identities are per lobby). */
  playOwner(req: IncomingMessage, res: ServerResponse, profile: string | undefined): string;
  /** Reclaim the owner's unattended previous games now (each ends as a draw). */
  releaseAbandoned(ownerKey: string, profile: string | undefined): Promise<void>;
  /**
   * Cluster mode: lobbies and visitor credentials are checkpointed (fenced by the primary's lease) so the next
   * primary restores them, and a restored lobby adopts its match by room id wherever it runs.
   */
  cluster?: { checkpoints: LobbyCheckpoints; adopt(roomId: string): Promise<LobbyMatch | undefined> };
  /** Cluster mode: the lobby cap, `MAX_MATCHES` per live node (one node's figure would cap the whole cluster). */
  maxLobbies?(): number;
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new HttpError(400, 'bad_request');
  return value as Record<string, unknown>;
}
/** Host defaults, preset and request overrides merge field-wise (map selections atomically), then the lobby's map wins. */
export function resolveLobbyMap(mapId: string, layoutId: string, seed: number, size: number, ...layers: (MatchOptions | undefined)[]): ResolvedLobbyRules {
  const map = lobbyMap(mapId); const layout = lobbyLayout(mapId, layoutId);
  if (!map || !layout || !map.sizes.includes(size) || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff ||
    map.mapSeed !== undefined && map.mapSeed !== seed) throw new HttpError(400, 'bad_map_options');
  const input = layers.reduce<Record<string, unknown> | undefined>((merged, layer) => mergeMatchOptions(definition.manifest.matchOptions, merged, layer), undefined);
  const base = resolveRules(input as MatchOptions | undefined);
  const options: MatchOptions = {
    // A generated recipe plays the layout's slot count (C2 duel or C4 ffa); authored maps carry their own slots.
    ...rulesOptions(base), terrain: map.terrain,
    map: map.tags.includes('generated') ? { seed, params: { ...base.map, size, slots: layout.sides } } : { name: map.id },
  };
  const rules = resolveRules(options);
  return { rules, options, rulesHash: arenaRulesHash(rules), rulesDiff: diffRules(rules), customRules: isCustomRules(rules) };
}
function observerDelay(input: unknown, visibility: 'private' | 'public', current = 0): number {
  if (input === undefined) return current;
  const policy = object(input, ['minDelayMs']);
  const minimum = visibility === 'public' ? PUBLIC_OBSERVER_DELAY_MS : 0;
  if (!Number.isSafeInteger(policy.minDelayMs) || (policy.minDelayMs as number) < minimum || (policy.minDelayMs as number) > 300_000) throw new HttpError(400, 'bad_observer_policy');
  return policy.minDelayMs as number;
}
export class LobbyService {
  readonly #ctx: LobbyContext;
  readonly #lobbies = new Map<string, Pregame>();
  readonly #participation = new Map<string, string>();
  readonly #visitors = new Map<string, VisitorRecord>();
  readonly #grants = new Map<string, Grant>();
  readonly #directory = new Map<string, Client>();
  readonly #rooms = new Map<string, Room>();
  readonly #pendingRooms = new Set<string>();
  readonly #limiters: Record<'createIp' | 'createOwner' | 'joinIp' | 'joinOwner' | 'claimIp' | 'claimOwner', RateLimiter>;
  readonly #sweep: NodeJS.Timeout;
  #directoryRoom: Promise<string> | undefined;
  #closed = false;
  /** Lobbies changed since their last checkpoint (cluster mode), and the JSON last written for each. */
  readonly #dirty = new Set<string>();
  readonly #written = new Map<string, string>();
  #flushing: Promise<void> | undefined;
  constructor(ctx: LobbyContext) {
    this.#ctx = ctx;
    // The lobby is the only match creation path, so the match creation limit governs lobby creation per IP and per
    // owner alike (Play again must not be capped below it); joins use the server's join limit.
    this.#limiters = { createIp: new RateLimiter(ctx.config.matchesPerIp, ctx.config.matchRateWindowMs), createOwner: new RateLimiter(ctx.config.matchesPerIp, ctx.config.matchRateWindowMs), joinIp: new RateLimiter(ctx.config.joinsPerIpPerMin, 60_000), joinOwner: new RateLimiter(15, 60_000), claimIp: new RateLimiter(120, 60_000), claimOwner: new RateLimiter(60, 60_000) };
    this.#sweep = setInterval(() => this.#tick(), 250); this.#sweep.unref();
  }
  #setVisitor(key: string, visitor: VisitorRecord): void {
    this.#visitors.set(key, visitor);
    void this.#ctx.cluster?.checkpoints.saveVisitor(key, JSON.stringify(visitor), visitor.expiresAt - Date.now()).catch(() => console.error('lobby: visitor checkpoint failed'));
  }
  #dropVisitor(key: string): void {
    if (this.#visitors.delete(key)) void this.#ctx.cluster?.checkpoints.removeVisitor(key).catch(() => console.error('lobby: visitor checkpoint failed'));
  }
  #record(lobby: Pregame): LobbyRecord {
    return {
      code: lobby.code, mapId: lobby.mode.mapId, layoutId: lobby.mode.layoutId, sides: lobby.sides, mapSeed: lobby.mapSeed, size: lobby.size,
      rules: lobby.rules, options: lobby.options, rulesHash: lobby.rulesHash, rulesDiff: lobby.rulesDiff, customRules: lobby.customRules,
      observerDelayMs: lobby.observerDelayMs, visibility: lobby.visibility, phase: lobby.phase, leader: lobby.leader, slots: lobby.slots,
      revision: lobby.revision, expiresAt: lobby.expiresAt, generation: lobby.generation, autoStart: lobby.autoStart, benchmark: lobby.benchmark,
      running: lobby.running, playOwner: lobby.playOwner, crossSide: lobby.crossSide, featured: lobby.featured,
      ...(lobby.runningAt === undefined ? {} : { runningAt: lobby.runningAt }),
      members: [...lobby.members.values()].map(({ owner, id, label, observer, ready, gameHoldUntil }) => ({ owner, id, label, observer, ready, ...(gameHoldUntil === undefined ? {} : { gameHoldUntil }) })),
      playerHistory: [...lobby.playerHistory], forfeited: [...lobby.forfeited],
      ...(lobby.handoffUntil === undefined ? {} : { handoffUntil: lobby.handoffUntil }),
      ...(lobby.publicFrozen ? { publicFrozen: lobby.publicFrozen } : {}), ...(lobby.game ? { game: lobby.game.roomId } : {}),
    };
  }
  /** Cluster mode: checkpoint `code` (or its removal) with the next flush. */
  #mark(code: string): void {
    if (this.#ctx.cluster && !this.#closed) this.#dirty.add(code);
  }
  /**
   * Write every changed lobby (one batch in flight at a time). The checkpoint store refuses writes once this node no
   * longer holds the lease, so a retired coordinator can never overwrite its successor's lobbies.
   */
  #flush(): Promise<void> {
    const checkpoints = this.#ctx.cluster?.checkpoints;
    if (!checkpoints) return Promise.resolve();
    if (this.#flushing) return this.#flushing;
    const write = async () => {
      while (this.#dirty.size) {
        const codes = [...this.#dirty];
        this.#dirty.clear();
        for (const code of codes) {
          const lobby = this.#lobbies.get(code);
          if (!lobby) {
            if (this.#written.delete(code)) await checkpoints.remove(code);
            continue;
          }
          const json = JSON.stringify(this.#record(lobby));
          if (this.#written.get(code) === json) continue;
          if (await checkpoints.save(code, json, lobby.expiresAt - Date.now())) this.#written.set(code, json);
        }
      }
    };
    // Cleared in a later microtask, never during the call: a batch with nothing to await must not stay "in flight".
    this.#flushing = write()
      .catch((error: unknown) => console.error('lobby: checkpoint failed', error instanceof Error ? error.message : error))
      .finally(() => { this.#flushing = undefined; });
    return this.#flushing;
  }
  /**
   * A new primary's lobbies: every checkpointed lobby still in time comes back with its members, seats and settings.
   * A started lobby keeps its match where it runs (adopted by room id); one whose match is gone with its node ends
   * here. A lobby that was preparing or counting down returns to waiting (its humans' sockets closed with the old
   * primary, which cancels a start), and its held match is released. Members reconnect through `connect`.
   */
  async restore(): Promise<void> {
    const cluster = this.#ctx.cluster;
    if (!cluster) return;
    const { lobbies, visitors } = await cluster.checkpoints.load();
    const now = Date.now();
    for (const { digest: key, record } of visitors) {
      const visitor = JSON.parse(record) as VisitorRecord;
      if (visitor.expiresAt > now) this.#visitors.set(key, visitor);
    }
    for (const raw of lobbies) {
      const record = JSON.parse(raw) as LobbyRecord;
      const mode = lobbyMode(record.mapId, record.layoutId);
      const game = record.game ? await cluster.adopt(record.game) : undefined;
      const started = record.phase === 'started';
      if (!mode || record.expiresAt <= now || started && (!game || game.match.over)) {
        void cluster.checkpoints.remove(record.code).catch(() => {});
        continue;
      }
      if (!started && game) void game.close().catch(() => {});
      const members = new Map(record.members.map((member): [string, Member] => [member.owner, {
        ...member, ready: started && member.ready, holdUntil: now + this.#ctx.config.lobbyRecoveryMs, gameTokens: new Set(),
      }]));
      const lobby: Pregame = {
        code: record.code, roomId: '', mode, sides: record.sides, mapSeed: record.mapSeed, size: record.size, observerDelayMs: record.observerDelayMs,
        rules: record.rules, options: record.options, rulesHash: record.rulesHash, rulesDiff: record.rulesDiff, customRules: record.customRules,
        visibility: record.visibility, phase: started ? 'started' : 'waiting', leader: record.leader, members, slots: record.slots,
        revision: record.revision + 1, expiresAt: record.expiresAt, generation: record.generation + 1, work: Promise.resolve(), signature: '',
        autoStart: record.autoStart, benchmark: record.benchmark, running: started && record.running, playerHistory: new Map(record.playerHistory),
        featured: record.featured, ...(started && record.runningAt !== undefined ? { runningAt: record.runningAt } : {}),
        playOwner: record.playOwner, forfeited: new Set(record.forfeited), reserved: new Map(), crossSide: record.crossSide,
        ...(started && game ? { game } : {}), ...(started && record.handoffUntil !== undefined ? { handoffUntil: record.handoffUntil } : {}),
        ...(started && record.publicFrozen ? { publicFrozen: record.publicFrozen } : {}),
      };
      this.#pendingRooms.add(lobby.code);
      try { lobby.roomId = (await matchMaker.createRoom(LOBBY_ROOM, { code: lobby.code })).roomId; }
      finally { this.#pendingRooms.delete(lobby.code); }
      this.#lobbies.set(lobby.code, lobby);
      for (const member of members.values()) this.#participation.set(member.owner, lobby.code);
      this.#publish(lobby);
    }
    await this.#flush();
  }
  /**
   * Cluster handover or demotion: write the final checkpoint (while the lease still fences it), close every pregame
   * and directory socket with `LOBBY_MOVED_CLOSE` so clients reconnect through the next primary, and let go of the
   * lobbies without touching their matches: those finish where they run, now coordinated by the successor.
   */
  async retire(): Promise<void> {
    if (this.#closed) return;
    clearInterval(this.#sweep);
    for (const code of this.#lobbies.keys()) this.#dirty.add(code);
    await this.#flushing;
    await this.#flush();
    this.#closed = true; for (const limiter of Object.values(this.#limiters)) limiter.close();
    for (const room of this.#rooms.values()) void room.disconnect(LOBBY_MOVED_CLOSE).catch(() => {});
    this.#grants.clear(); this.#lobbies.clear(); this.#participation.clear(); this.#directory.clear(); this.#visitors.clear(); this.#rooms.clear();
  }
  #accepting(): void { if (!this.#ctx.accepting()) throw new HttpError(503, 'server_updating', 'Server updating, try again in a moment'); }
  #limit(kind: 'create' | 'join' | 'claim', owner: string, ip: string): void {
    if (Math.max(this.#limiters[`${kind}Ip`].take(ip), owner.startsWith('visitor:') ? 0 : this.#limiters[`${kind}Owner`].take(owner))) throw new HttpError(429, 'rate_limited');
  }
  #require(code: string): Pregame { const lobby = this.#lobbies.get(code); if (!lobby || lobby.expiresAt <= Date.now()) throw new HttpError(404, 'lobby_not_found'); return lobby; }
  #member(lobby: Pregame, owner: string): Member { const member = lobby.members.get(owner); if (!member) throw new HttpError(403, 'forbidden'); return member; }
  #owner(req: IncomingMessage): string | undefined {
    if (req.headers.authorization?.startsWith('Visitor ')) {
      const visitor = this.#visitors.get(digest(req.headers.authorization.slice(8)));
      if (!visitor || visitor.expiresAt <= Date.now()) throw new HttpError(401, 'bad_visitor');
      return visitor.owner;
    }
    return this.#ctx.profileOf(req);
  }
  /** Starting or joining a game is the player leaving whatever they were in: a reload, closed tab or lost link must
   *  never lock anyone out. An unstarted room is simply left; a match in progress is forfeited like Leave. */
  #leavePrevious(owner: string, except?: Pregame): void {
    const previous = this.#lobbies.get(this.#participation.get(owner) ?? '');
    if (previous && previous !== except) this.#leave(previous, previous.members.get(owner)!);
    else if (!previous) this.#participation.delete(owner);
  }
  #add(lobby: Pregame, owner: string, observer: boolean, team?: string): Member {
    const existing = lobby.members.get(owner); if (existing) return existing;
    this.#leavePrevious(owner, lobby);
    if (!observer && lobby.phase !== 'waiting') throw new HttpError(409, 'not_open');
    if (lobby.members.size >= 16) throw new HttpError(429, 'capacity');
    const member: Member = { owner, id: randomBytes(12).toString('base64url'), label: `Player ${lobby.members.size + 1}`, observer, ready: false, holdUntil: Date.now() + this.#ctx.config.lobbyReservationMs, gameTokens: new Set() };
    if (!observer) {
      const available = lobby.sides.find((side) => (!team || team === side.id) && lobby.slots.some((slot) => slot.team === side.id && slot.occupant.kind === 'open'));
      if (!available) throw new HttpError(409, 'seat_taken');
      for (const slot of lobby.slots) if (slot.team === available.id && slot.occupant.kind === 'open') { slot.occupant = { kind: 'human', memberId: member.id }; slot.owner = owner; slot.ownerControl = true; }
    }
    lobby.members.set(owner, member); this.#participation.set(owner, lobby.code);
    if (!observer) this.#invalidate(lobby); else if (lobby.phase !== 'started') lobby.revision++;
    return member;
  }
  #policy(lobby: Pregame) { return { allowOmniscient: true, minDelayMs: Math.max(lobby.observerDelayMs, lobby.visibility === 'public' ? PUBLIC_OBSERVER_DELAY_MS : 0) }; }
  #humanTeams(lobby: Pregame, owner: string): ArmyId[] { return [...new Set(lobby.slots.filter((slot) => slot.owner === owner && slot.occupant.kind === 'human').map((slot) => slot.team))]; }
  /** Authority follows retained ownership, not the currently selected human/agent/bot controller. */
  #ownedTeams(lobby: Pregame, owner: string): ArmyId[] { return [...new Set(lobby.slots.filter((slot) => slot.owner === owner && slot.ownerControl).map((slot) => slot.team))]; }
  /**
   * Whether another member's claim holds a slot. Humans and commanders always hold theirs. A delegated bot is held only
   * while its owner keeps control of it: before the start alongside that owner's You seat on the same army (a dormant
   * all-Bot draft keeps its owner so choosing You again restores it, but others may replace it), in a match as granted
   * (`#prepare` drops unplayed draft control).
   */
  #heldByOther(lobby: Pregame, slot: Slot, owner: string): boolean {
    if (!slot.owner || slot.owner === owner) return false;
    return slot.occupant.kind !== 'bot' || slot.ownerControl === true && (lobby.phase === 'started' || this.#humanTeams(lobby, slot.owner).includes(slot.team));
  }
  /** Hostility between two of the lobby's armies is colour inequality (DESIGN §15.6), never side inequality. */
  #hostile(lobby: Pregame, a: ArmyId, b: ArmyId): boolean { return hostileSide({ armies: lobby.sides.map((side) => ({ id: side.id, colour: side.alliance })) }, a, b); }
  /**
   * One named commander plays one army per match (PlayerThree seats it on one team only): the army it already holds
   * outside `except` (the slots being replaced), if that is not `team`.
   */
  #commanderArmy(lobby: Pregame, owner: string, id: string, team: ArmyId, except: readonly Slot[]): ArmyId | undefined {
    return lobby.slots.find((slot) => !except.includes(slot) && slot.team !== team && slot.owner === owner && slot.occupant.kind === 'commander' && slot.occupant.ref.id === id)?.team;
  }
  /** An owner whose played seats (You or a commander; bots are configuration) sit on mutually hostile armies. */
  #crossSide(lobby: Pregame): boolean {
    return [...lobby.members.values()].some((member) => {
      const armies = [...new Set(lobby.slots.filter((slot) => slot.owner === member.owner && (slot.occupant.kind === 'human' || slot.occupant.kind === 'commander')).map((slot) => slot.team))];
      return armies.some((army) => armies.some((other) => this.#hostile(lobby, army, other)));
    });
  }
  #practiceReasons(lobby: Pregame): string[] {
    const reasons: string[] = lobby.customRules ? ['custom rules'] : [];
    // An owner on both sides is its own practice opponent: never a ranked result (the match itself is marked too).
    if (lobby.crossSide || this.#crossSide(lobby)) reasons.push('cross-side owner');
    return reasons;
  }
  #observerGrant(lobby: Pregame, member: Member): ObserverGrant {
    const team = lobby.playerHistory.get(member.owner) ?? this.#humanTeams(lobby, member.owner)[0];
    // The room's observer delay binds every grant: validateObserverGrant rejects a team grant below it.
    return team ? { kind: 'team', team, delayMs: this.#policy(lobby).minDelayMs } : { kind: 'omniscient', teams: lobby.sides.map((side) => side.id), delayMs: this.#policy(lobby).minDelayMs };
  }
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path !== '/api/lobbies' && !path.startsWith('/api/lobbies/')) return false;
    // Series setup routes are owned by the PlayerThree service wrapper.
    if (/\/series$/.test(path)) return false;
    if (!originAllowed(req, this.#ctx.config)) throw new HttpError(403, 'forbidden_origin');
    // A finished match frees its lobby before any request sees it, not only at the next sweep.
    this.#releaseFinished();
    let owner = this.#owner(req); const ip = clientIp(req, this.#ctx.config);
    const reply = (value: unknown): true => { sendJson(res, 200, value); return true; };
    if (path === '/api/lobbies' && req.method === 'GET') { this.#limit('join', owner ?? ip, ip); return reply({ lobbies: this.list() }); }
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    let visitorToken: string | undefined;
    if (!owner && (path === '/api/lobbies' || path === '/api/lobbies/directory/connect')) {
      if (this.#visitors.size >= 1024) throw new HttpError(429, 'capacity');
      visitorToken = opaque(); owner = `visitor:${opaque()}`;
      this.#setVisitor(digest(visitorToken), { owner, expiresAt: Date.now() + this.#ctx.config.maxMatchMs + this.#ctx.config.inviteMs });
    }
    if (!owner) throw new HttpError(401, 'bad_profile');
    try {
      return await this.#handlePost(req, res, path, owner, ip, visitorToken);
    } catch (error) {
      // A rejected anonymous request must not consume an hour-long visitor slot. In particular, rate-limited
      // retries used to fill all 1024 slots before the limiter could refuse them.
      if (visitorToken) this.#dropVisitor(digest(visitorToken));
      throw error;
    }
  }
  async #handlePost(req: IncomingMessage, res: ServerResponse, path: string, owner: string, ip: string, visitorToken?: string): Promise<boolean> {
    const reply = (value: unknown): true => {
      sendJson(res, 200, value);
      return true;
    };
    if (path === '/api/lobbies') {
      this.#limit('create', owner, ip); this.#accepting();
      const body = object(await readJson(req, 16_384), ['mapId', 'layoutId', 'visibility', 'preset', 'autoStart', 'rules', 'rulesPreset', 'mapSeed', 'size', 'observerPolicy', 'botLevel', 'featured']);
      if (typeof body.mapId !== 'string' || typeof body.layoutId !== 'string' || body.visibility !== 'private' && body.visibility !== 'public' || !['play', 'host', 'benchmark'].includes(body.preset as string) || body.autoStart !== undefined && typeof body.autoStart !== 'boolean' || body.featured !== undefined && typeof body.featured !== 'boolean') throw new HttpError(400, 'bad_request');
      const botLevel = body.botLevel ?? 'standard';
      if (!OPPONENTS.includes(botLevel as Opponent)) throw new HttpError(400, 'bad_bot');
      const mode = lobbyMode(body.mapId, body.layoutId); const map = lobbyMap(body.mapId);
      if (!mode?.supported || !map) throw new HttpError(400, 'unsupported_layout');
      const profile = owner.startsWith('visitor:') ? undefined : owner;
      const playOwner = this.#ctx.playOwner(req, res, profile);
      // Starting again reclaims this owner's unattended previous games; every finished lobby releases its slot and members now.
      await this.#ctx.releaseAbandoned(playOwner, profile);
      this.#releaseFinished();
      this.#leavePrevious(owner);
      if (this.#lobbies.size >= (this.#ctx.maxLobbies?.() ?? this.#ctx.config.maxMatches)) throw new HttpError(409, 'capacity');
      const seed = body.mapSeed ?? map.mapSeed ?? randomInt(0x1_0000_0000); const size = body.size ?? map.size;
      if (typeof seed !== 'number' || typeof size !== 'number') throw new HttpError(400, 'bad_request');
      if (body.rulesPreset !== undefined && (typeof body.rulesPreset !== 'string' || !RULE_PRESETS.some((preset) => preset.id === body.rulesPreset))) throw new HttpError(400, 'bad_rules_preset');
      const presetRules = typeof body.rulesPreset === 'string' ? rulesOptions(resolveRulesPreset(body.rulesPreset)) : undefined;
      const resolved = resolveLobbyMap(map.id, mode.layoutId, seed, size, this.#ctx.config.rules, presetRules, requestRules(body.rules));
      let code: string; do { code = randomBytes(12).toString('base64url'); } while (this.#lobbies.has(code));
      const lobby: Pregame = {
        code, roomId: '', mode, sides: mode.sides.map((side) => ({ ...side })), ...resolved, mapSeed: seed, size,
        visibility: body.visibility, observerDelayMs: observerDelay(body.observerPolicy, body.visibility), featured: body.featured ?? true,
        phase: 'waiting', leader: owner, members: new Map(),
        slots: mode.sides.flatMap((side) => mode.roles.map((role): Slot => ({ team: side.id, role, occupant: { kind: 'open' }, assignedAt: Date.now() }))),
        revision: 0, expiresAt: Date.now() + this.#ctx.config.inviteMs, generation: 0,
        work: Promise.resolve(), signature: '', autoStart: body.autoStart === true, crossSide: false,
        benchmark: body.preset === 'benchmark', running: false, playerHistory: new Map(), playOwner, forfeited: new Set(), reserved: new Map(),
      };
      this.#lobbies.set(code, lobby);
      try {
        this.#add(lobby, owner, lobby.benchmark, mode.sides[0]!.id);
        for (const slot of lobby.slots) if (lobby.benchmark || body.preset === 'play' && slot.team !== mode.sides[0]!.id) {
          slot.occupant = { kind: 'bot', level: botLevel as Opponent, options: { ...resolveBotOptions(botLevel as Opponent) } }; slot.owner = undefined; slot.ownerControl = false;
        }
        this.#pendingRooms.add(code); lobby.roomId = (await matchMaker.createRoom(LOBBY_ROOM, { code })).roomId;
      } catch (error) { this.#remove(lobby); throw error; } finally { this.#pendingRooms.delete(code); }
      this.#publish(lobby); return reply({ code, roomId: lobby.roomId, ...(visitorToken ? { visitorToken } : {}) });
    }
    if (path === '/api/lobbies/join') {
      this.#limit('join', owner, ip); const body = object(await readJson(req, 2048), ['code', 'observer', 'team']);
      if (typeof body.code !== 'string' || !CODE_RE.test(body.code) || body.observer !== undefined && typeof body.observer !== 'boolean' || body.team !== undefined && typeof body.team !== 'string') throw new HttpError(400, 'bad_request');
      if (!this.#lobbies.get(body.code)?.members.has(owner)) this.#accepting();
      const lobby = this.#require(body.code);
      this.#add(lobby, owner, body.observer === true, body.team as string | undefined); this.#publish(lobby); return reply({ code: lobby.code, roomId: lobby.roomId });
    }
    if (path === '/api/lobbies/directory/connect') {
      this.#limit('join', owner, ip); object(await readJson(req, 2048), []);
      if (!this.#directoryRoom) { this.#pendingRooms.add('directory'); this.#directoryRoom = matchMaker.createRoom(DIRECTORY_ROOM, {}).then((room) => room.roomId).catch((error: unknown) => { this.#directoryRoom = undefined; throw error; }).finally(() => this.#pendingRooms.delete('directory')); }
      const roomId = await this.#directoryRoom;
      // Check after the shared room creation await, then reserve synchronously: concurrent joins cannot all
      // observe the same free slots. The IP lives on its grant, so releasing it also releases address bookkeeping.
      let ipGrants = 0;
      for (const grant of this.#grants.values()) if (!grant.code && grant.ip === ip) ipGrants++;
      if (this.#grants.size >= 1024 || ipGrants >= 8) throw new HttpError(429, 'capacity');
      return reply({ ...this.#grant(owner, roomId, ip), ...(visitorToken ? { visitorToken } : {}) });
    }
    const adoption = /^\/api\/lobbies\/([A-Za-z0-9_-]{16})\/claim-owner$/.exec(path);
    if (adoption) {
      if (owner.startsWith('visitor:')) throw new HttpError(401, 'profile_required');
      this.#limit('claim', owner, ip);
      const body = object(await readJson(req, 2048), ['visitorToken', 'revision']);
      if (typeof body.visitorToken !== 'string') throw new HttpError(400, 'bad_request');
      const key = digest(body.visitorToken);
      const visitor = this.#visitors.get(key);
      const lobby = this.#require(adoption[1]!);
      if (!visitor || visitor.expiresAt <= Date.now() || !lobby.members.has(visitor.owner)) throw new HttpError(403, 'bad_visitor');
      if (body.revision !== lobby.revision) throw new HttpError(409, 'stale_revision');
      if (lobby.phase === 'started' || this.#participation.has(owner)) throw new HttpError(409, 'not_open');
      const member = lobby.members.get(visitor.owner)!;
      for (const [grantKey, grant] of this.#grants) if (grant.owner === visitor.owner && grant.code === lobby.code) this.#grants.delete(grantKey);
      member.client?.leave(4001); member.client = undefined;
      lobby.members.delete(visitor.owner); this.#participation.delete(visitor.owner);
      if (lobby.leader === visitor.owner) { lobby.leader = owner; lobby.playOwner = this.#ctx.playOwner(req, res, owner); }
      for (const slot of lobby.slots) if (slot.owner === visitor.owner) slot.owner = owner;
      member.owner = owner; member.holdUntil = Date.now() + this.#ctx.config.lobbyReservationMs;
      lobby.members.set(owner, member); this.#participation.set(owner, lobby.code);
      this.#dropVisitor(key);
      lobby.autoStart = false; this.#invalidate(lobby); this.#publish(lobby);
      return reply({ code: lobby.code, roomId: lobby.roomId });
    }
    const route = /^\/api\/lobbies\/([A-Za-z0-9_-]{16})\/(connect|ticket|renew|leave|seat)$/.exec(path);
    if (!route) throw new HttpError(404, 'not_found'); this.#limit('join', owner, ip); const body = object(await readJson(req, 2048), route[2] === 'ticket' ? ['observer'] : route[2] === 'seat' ? ['team', 'role', 'occupant'] : []);
    const lobby = this.#require(route[1]!); const member = this.#member(lobby, owner);
    if (route[2] === 'leave') { this.#leave(lobby, member); res.writeHead(204).end(); return true; }
    if (route[2] === 'connect') return reply(this.#grant(owner, lobby.roomId, ip, lobby.code));
    if (route[2] === 'seat') { await this.#reseat(lobby, member, body); return reply({ ok: true }); }
    if (body.observer !== undefined && body.observer !== true) throw new HttpError(400, 'bad_request');
    if (lobby.phase !== 'started' || !lobby.game) throw new HttpError(409, 'not_started');
    await lobby.work;
    const match = lobby.game.match;
    // An eliminated human watches the rest under the lobby's observer policy (DESIGN §15.7) once every army they
    // played has a final outcome; their own seats show only public information from then on.
    const eliminated = body.observer === true;
    if (eliminated) {
      const armies = this.#ownedTeams(lobby, owner);
      if (!armies.length) throw new HttpError(403, 'no_human_seats');
      for (const army of armies) if (await match.outcome(army) === 'running') throw new HttpError(409, 'still_playing');
    }
    if (route[2] === 'renew' && member.observer) throw new HttpError(409, 'not_renewable');
    if (member.observer || eliminated) {
      const grant: ObserverGrant = eliminated ? { kind: 'omniscient', teams: lobby.sides.map((side) => side.id), delayMs: this.#policy(lobby).minDelayMs } : this.#observerGrant(lobby, member);
      const ttlSeconds = Math.min(86_400, Math.max(120, Math.ceil((lobby.expiresAt - Date.now()) / 1000) + 60));
      // Minted before the old tokens go: a refused grant must never leave the member without its seats.
      const ticket = await Promise.resolve().then(() => match.mintObserverToken(grant, { owner, ttlSeconds })).catch(refused);
      for (const token of member.gameTokens) await match.revokeToken(token); member.gameTokens.clear();
      member.gameTokens.add(ticket.token);
      return reply({ roomId: lobby.game.roomId, token: ticket.token, tickets: [ticket], observer: true, grant, readOnly: true, label: `${lobby.mode.label} · Observer` });
    }
    const owned = lobby.slots.filter((slot) => slot.owner === owner && slot.ownerControl && slot.occupant.kind !== 'open' && slot.occupant.kind !== 'closed');
    if (!owned.length) {
      // A former player without any retained assignments keeps watching their previous army.
      const army = lobby.slots.find((slot) => slot.owner === owner)?.team ?? (lobby.playerHistory.get(owner) as ArmyId | undefined);
      if (!army) throw new HttpError(403, 'no_human_seats');
      if (route[2] === 'renew') throw new HttpError(409, 'not_renewable');
      if (await match.outcome(army) !== 'running') throw new HttpError(409, 'eliminated');
      const ttlSeconds = Math.min(600, Math.max(120, Math.ceil((lobby.expiresAt - Date.now()) / 1000)));
      const ticket = await match.mintSpectatorToken(army, { ttlSeconds });
      for (const token of member.gameTokens) await match.revokeToken(token); member.gameTokens.clear();
      member.gameTokens.add(ticket.token);
      // One role-less ticket: the client renews and rejoins it like seat tickets.
      return reply({ roomId: lobby.game.roomId, token: ticket.token, tickets: [ticket], team: army, mode: 'pvp', readOnly: true, spectator: true, label: lobby.mode.label });
    }
    // Tickets are keyed by role within one team. Cross-side isolated agents do not grant their owner coaching.
    if (new Set(owned.map((slot) => slot.team)).size !== 1) throw new HttpError(403, 'forbidden');
    // An army already out has no seat to play: refused before anything is revoked (its observer pass stays valid).
    for (const army of new Set(owned.map((slot) => slot.team))) if (await match.outcome(army) !== 'running') throw new HttpError(409, 'eliminated');
    if (route[2] === 'renew') {
      // The connected seats keep their sockets: no rejoin, no fresh keyframe, no dropped commands. A seat with nothing
      // live to extend (dropped, never joined) answers `not_renewable` and the client takes fresh tickets instead.
      try {
        const renewed = await Promise.all(owned.map(async (slot) => ({ role: slot.role, queuePriority: true, ...await match.renewHumanToken(slot.team, slot.role, { ttlSeconds: SEAT_RENEWAL_TTL_S }) })));
        return reply({ roomId: lobby.game.roomId, tickets: renewed });
      } catch (error) {
        if (error instanceof PlayerThreeError || error instanceof HttpError) throw new HttpError(409, 'not_renewable');
        throw error;
      }
    }
    // Minted before the old tokens go: a refused renewal must not cut seats that are still playing (each mint already
    // replaces its own seat's previous credential).
    const tickets = await Promise.all(owned.map(async (slot) => ({ role: slot.role, queuePriority: true, ...await match.mintHumanToken(slot.team, slot.role, { ttlSeconds: SEAT_TICKET_TTL_S }) }))).catch(refused);
    for (const token of member.gameTokens) await match.revokeToken(token); member.gameTokens.clear();
    for (const ticket of tickets) member.gameTokens.add(ticket.token);
    // `agentHandOver`: a commander can take one of these seats mid-match (main-process match; `#reseat` refuses
    // `agents_need_main` on a worker), so the seat picker can say so before anyone clicks.
    return reply({ roomId: lobby.game.roomId, token: tickets[0]!.token, tickets, team: owned[0]!.team, mode: 'pvp', readOnly: false, label: lobby.mode.label, agentHandOver: lobby.game.localMatch !== undefined });
  }
  /**
   * Mid-match seat hand-over by its army's owner (a member holding a seat on that army): a named commander, a bot,
   * or the owner as human. Agents need a main-process match (commanders live on the canonical host).
   */
  async #reseat(lobby: Pregame, member: Member, body: Record<string, unknown>): Promise<void> {
    if (lobby.phase !== 'started' || !lobby.game || lobby.game.match.over) throw new HttpError(409, 'not_started');
    await lobby.work;
    const game = lobby.game;
    const slot = lobby.slots.find((entry) => entry.team === body.team && entry.role === body.role);
    if (!slot) throw new HttpError(400, 'bad_request');
    if (!lobby.slots.some((entry) => entry.team === slot.team && entry.owner === member.owner)) throw new HttpError(403, 'forbidden');
    if (this.#heldByOther(lobby, slot, member.owner)) throw new HttpError(403, 'release_required');
    const raw = body.occupant;
    if (!raw || typeof raw !== 'object' || !('kind' in raw) || !['human', 'bot', 'commander'].includes(raw.kind as string)) throw new HttpError(400, 'bad_occupant');
    // A mid-match bot plays at the seat's own level (the lobby's bot seat level, else the match default `standard`);
    // no level or options travel here.
    if (raw.kind === 'bot') object(raw, ['kind']);
    const occupant: SlotOccupant = raw.kind === 'bot' ? { kind: 'bot', level: 'standard', options: {} } : this.#occupant(raw, member, [slot.role]);
    // One army per player: owner control (a You seat or a plane delegated from one) on another army blocks taking a seat.
    if (occupant.kind === 'human' && this.#ownedTeams(lobby, member.owner).some((army) => army !== slot.team)) throw new HttpError(409, 'human_side_conflict');
    if (await game.match.outcome(slot.team) !== 'running') throw new HttpError(409, 'eliminated');
    let assignment: SeatAssignment;
    let next: SlotOccupant = occupant;
    if (occupant.kind === 'commander') {
      if (!game.localMatch) throw new HttpError(409, 'agents_need_main', 'Agent seats need a main-process match; set an agent on a seat before the start.');
      // One commander, one army (PlayerThree's own rule, checked first so the refusal names it, not isolation).
      if (this.#commanderArmy(lobby, member.owner, occupant.ref.id, slot.team, [slot])) throw new HttpError(409, 'commander_other_army');
      // The host's cross-team agent rule, checked here so its refusal keeps its own code.
      const crossTeam = occupant.ref.kind === 'agent' && lobby.slots.some((other) => other !== slot && other.team !== slot.team && other.owner === member.owner && other.occupant.kind === 'commander' && other.occupant.ref.kind === 'agent');
      if (crossTeam && !this.#ctx.host.commanders.roster(member.owner).find((entry) => entry.id === occupant.ref.id)?.isolation.independentSessions) throw new HttpError(409, 'isolated_sessions_required');
      const frozen = this.#freezeOccupant({ ...slot, occupant, owner: member.owner });
      if (frozen.kind !== 'commander') throw new HttpError(400, 'bad_occupant');
      assignment = { team: slot.team, role: slot.role, owner: member.owner, kind: frozen.ref.kind, commander: { id: frozen.ref.id }, ...(frozen.ref.version === undefined ? {} : { policy: { version: frozen.ref.version } }) };
      next = frozen;
    } else assignment = { team: slot.team, role: slot.role, owner: member.owner, kind: occupant.kind === 'human' ? 'human' : 'bot' };
    if (occupant.kind === 'human' || slot.ownerControl) assignment.ownerControl = true;
    try {
      await game.match.assign(assignment);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'busy') throw new HttpError(409, 'commander_busy');
      // Isolation was checked above: what the host still forbids is owner control for a member who has watched this
      // match with broader (omniscient) vision.
      if (code === 'forbidden') throw new HttpError(409, 'observer_vision_held');
      throw new HttpError(400, 'bad_occupant');
    }
    slot.occupant = next;
    slot.owner = member.owner; slot.assignedAt = Date.now();
    slot.ownerControl = assignment.ownerControl === true;
    member.observer = this.#ownedTeams(lobby, member.owner).length !== 1;
    lobby.crossSide ||= this.#crossSide(lobby);
    if (occupant.kind === 'human') { lobby.playerHistory.set(member.owner, slot.team); await game.match.setHumanReady(slot.team, slot.role, true); }
    this.#publish(lobby);
  }
  #grant(owner: string, roomId: string, ip: string, code?: string) {
    for (const [key, grant] of this.#grants) if (grant.owner === owner && grant.roomId === roomId) this.#grants.delete(key);
    (code ? this.#lobbies.get(code)?.members.get(owner)?.client : this.#directory.get(owner))?.leave(4001);
    const token = opaque(); const expiresAt = Date.now() + this.#ctx.config.lobbyReservationMs; const key = digest(token);
    this.#grants.set(key, { key, owner, roomId, ip, ...(code ? { code } : {}), expiresAt }); return { roomId, token, expiresAt };
  }
  admits(roomId: string, token: unknown): boolean { const grant = typeof token === 'string' && token.length === 32 ? this.#grants.get(digest(token)) : undefined; return !!grant && grant.roomId === roomId && grant.expiresAt > Date.now() && !grant.connection; }
  claim(roomId: string, token: unknown, connection: string): Grant | undefined { if (!this.admits(roomId, token)) return; const grant = this.#grants.get(digest(token as string))!; grant.connection = connection; return grant; }
  roomOpened(room: Room, code?: string): boolean { if (!this.#pendingRooms.has(code ?? 'directory')) return false; this.#rooms.set(room.roomId, room); return true; }
  attach(client: Client, grant: Grant): void {
    if (this.#closed || this.#grants.get(grant.key) !== grant || grant.expiresAt <= Date.now()) { client.leave(4003); return; }
    grant.expiresAt = Infinity;
    if (!grant.code) { this.#directory.set(grant.owner, client); client.send('lobby:list', { lobbies: this.list() }); return; }
    const lobby = this.#lobbies.get(grant.code); const member = lobby?.members.get(grant.owner);
    if (!lobby || !member) { client.leave(4003); return; } member.client = client; member.holdUntil = Infinity;
    // Auto-start is the leader's one-click Play; anyone else attaching early (an observer) must not run the leader's
    // start, whose rejection would abort this join and leave a dead client holding the member's reservation forever.
    if (lobby.autoStart && lobby.phase === 'waiting' && lobby.leader === member.owner) { member.ready = true; this.#start(lobby, member); }
    this.#publish(lobby);
  }
  detach(client: Client, grant: Grant): void {
    this.#grants.delete(grant.key); if (!grant.code) { if (this.#directory.get(grant.owner) === client) this.#directory.delete(grant.owner); return; }
    const lobby = this.#lobbies.get(grant.code); const member = lobby?.members.get(grant.owner); if (!lobby || !member || member.client !== client) return;
    member.client = undefined; if (lobby.phase === 'started') return;
    member.holdUntil = Date.now() + this.#ctx.config.lobbyRecoveryMs;
    if (this.#humanTeams(lobby, member.owner).length) this.#invalidate(lobby);
    this.#publish(lobby);
  }
  #occupant(raw: unknown, member: Member, roles: readonly Plane[]): SlotOccupant {
    if (!raw || typeof raw !== 'object' || !('kind' in raw)) throw new HttpError(400, 'bad_occupant');
    const kind = raw.kind;
    if (kind === 'human') { object(raw, ['kind', 'memberId']); if ('memberId' in raw && raw.memberId !== member.id) throw new HttpError(403, 'forbidden'); return { kind, memberId: member.id }; }
    if (kind === 'open' || kind === 'closed') { object(raw, ['kind']); return { kind }; }
    if (kind === 'bot') {
      const body = object(raw, ['kind', 'level', 'options']); if (!OPPONENTS.includes(body.level as never)) throw new HttpError(400, 'bad_bot');
      const options = object(body.options ?? {}, ['aggression', 'economyReserve']);
      if (Object.values(options).some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) throw new HttpError(400, 'bad_bot_options');
      return { kind, level: body.level as string, options: { ...resolveBotOptions(body.level as Opponent, options) } };
    }
    if (kind === 'commander') {
      const body = object(raw, ['kind', 'ref']); const ref = object(body.ref, ['id', 'kind', 'version']);
      const commander = this.#ctx.host.commanders.roster(member.owner).find((entry) => entry.id === ref.id);
      if (!commander || commander.kind !== ref.kind || roles.some((role) => !commander.roles.includes(role))) throw new HttpError(403, 'incompatible_commander');
      if (ref.version !== undefined && (!Number.isSafeInteger(ref.version) || (ref.version as number) < 1)) throw new HttpError(400, 'bad_policy_version');
      return { kind, ref: { id: commander.id, kind: commander.kind, ...(ref.version === undefined ? {} : { version: ref.version as number }) } };
    }
    throw new HttpError(400, 'bad_occupant');
  }
  command(client: Client, grant: Grant, raw: unknown): void {
    const seq = raw && typeof raw === 'object' && 'seq' in raw && Number.isSafeInteger(raw.seq) ? raw.seq as number : 0;
    try {
      if (!grant.code || this.#grants.get(grant.key) !== grant || grant.connection !== client.sessionId) throw new HttpError(403, 'forbidden');
      const lobby = this.#require(grant.code); const member = this.#member(lobby, grant.owner); if (member.client !== client) throw new HttpError(403, 'forbidden');
      this.#limit('claim', grant.owner, grant.ip); if (Buffer.byteLength(JSON.stringify(raw)) > 16_384) throw new HttpError(413, 'too_large');
      const body = object(raw, ['seq', 'revision', 'op', 'team', 'roles', 'occupant', 'ready', 'memberId', 'mapId', 'layoutId', 'visibility', 'rules', 'rulesPreset', 'autoStart', 'mapSeed', 'size', 'observerPolicy', 'colours', 'featured']);
      if (body.seq !== seq || seq < 0 || body.revision !== lobby.revision) throw new HttpError(409, 'stale_revision');
      if (body.op === 'leave') { client.send('lobby:result', { seq, ok: true }); this.#leave(lobby, member); return; }
      if (lobby.phase === 'started' && body.op !== 'kick') throw new HttpError(409, 'not_open');
      if (body.op === 'assign') {
        if (typeof body.team !== 'string' || !Array.isArray(body.roles) || !body.roles.length || new Set(body.roles).size !== body.roles.length || !body.roles.every((role) => lobby.mode.roles.includes(role as Plane))) throw new HttpError(400, 'bad_request');
        const slots = lobby.slots.filter((slot) => slot.team === body.team && (body.roles as unknown[]).includes(slot.role));
        if (slots.length !== body.roles.length) throw new HttpError(400, 'bad_request');
        if (slots.some((slot) => this.#heldByOther(lobby, slot, member.owner))) throw new HttpError(403, 'release_required');
        const occupant = this.#occupant(body.occupant, member, body.roles as Plane[]);
        // Unclaimed seats (open, opponent bots, dormant draft delegations) are the leader's to configure; anyone may sit.
        if (lobby.leader !== member.owner && slots.some((slot) => slot.owner !== member.owner) && occupant.kind !== 'human') throw new HttpError(403, 'forbidden');
        // One commander, one army: refused here, not first at the start, so its agent never sees both sides' seats.
        if (occupant.kind === 'commander' && this.#commanderArmy(lobby, member.owner, occupant.ref.id, body.team as ArmyId, slots)) throw new HttpError(409, 'commander_other_army');
        if (occupant.kind === 'human') {
          const other = this.#humanTeams(lobby, member.owner).filter((team) => team !== body.team); if (other.length) throw new HttpError(409, 'human_side_conflict');
          // Taking You on an army moves the player there: delegations kept on other armies lapse (a bot is unowned
          // configuration again, an agent an isolated one), so owner control never spans armies into the match.
          for (const slot of lobby.slots) if (slot.team !== body.team && slot.owner === member.owner) { if (slot.occupant.kind === 'bot') slot.owner = undefined; slot.ownerControl = false; }
        }
        for (const slot of slots) {
          const own = slot.owner === member.owner;
          slot.occupant = structuredClone(occupant);
          // Filling an unowned opponent bot is configuration, not an ownership claim. Delegation retains its owner.
          slot.owner = occupant.kind === 'human' || occupant.kind === 'commander' || occupant.kind === 'bot' && own ? member.owner : undefined;
          slot.ownerControl = occupant.kind === 'human' || own && slot.ownerControl === true;
          slot.assignedAt = Date.now();
        }
        // Pregame participation follows actual humans; retained bot ownership still grants mixed-seat control.
        member.observer = this.#humanTeams(lobby, member.owner).length === 0; lobby.autoStart = false; this.#invalidate(lobby);
      } else if (body.op === 'observe') {
        // Only a seated human can step back: for anyone else it would be a free reset of the start countdown.
        if (!this.#humanTeams(lobby, member.owner).length) throw new HttpError(403, 'forbidden');
        for (const slot of lobby.slots) if (slot.owner === member.owner && slot.occupant.kind === 'human') { slot.occupant = { kind: 'open' }; slot.owner = undefined; slot.ownerControl = false; }
        member.observer = true; lobby.autoStart = false; this.#invalidate(lobby);
      } else if (body.op === 'configure') {
        if (lobby.leader !== member.owner) throw new HttpError(403, 'forbidden');
        if (body.autoStart !== undefined && body.autoStart !== false) throw new HttpError(400, 'bad_request');
        const mapId = body.mapId ?? lobby.mode.mapId; const layoutId = body.layoutId ?? lobby.mode.layoutId;
        if (typeof mapId !== 'string' || typeof layoutId !== 'string') throw new HttpError(400, 'bad_request');
        const mode = lobbyMode(mapId, layoutId); const map = lobbyMap(mapId); if (!mode?.supported || !map) throw new HttpError(400, 'unsupported_layout');
        if (body.visibility !== undefined && body.visibility !== 'public' && body.visibility !== 'private' || body.featured !== undefined && typeof body.featured !== 'boolean') throw new HttpError(400, 'bad_request');
        const changedMap = mapId !== lobby.mode.mapId;
        const seed = body.mapSeed ?? (changedMap ? map.mapSeed ?? randomInt(0x1_0000_0000) : lobby.mapSeed);
        const size = body.size ?? (changedMap ? map.size : lobby.size);
        if (typeof seed !== 'number' || typeof size !== 'number') throw new HttpError(400, 'bad_request');
        if (body.rulesPreset !== undefined && (typeof body.rulesPreset !== 'string' || !RULE_PRESETS.some((preset) => preset.id === body.rulesPreset))) throw new HttpError(400, 'bad_rules_preset');
        const presetRules = typeof body.rulesPreset === 'string' ? rulesOptions(resolveRulesPreset(body.rulesPreset)) : undefined;
        const resolved = resolveLobbyMap(map.id, layoutId, seed, size, rulesOptions(lobby.rules), presetRules, requestRules(body.rules));
        const delay = observerDelay(body.observerPolicy, (body.visibility ?? lobby.visibility) as 'public' | 'private', lobby.observerDelayMs);
        const changedMode = mapId !== lobby.mode.mapId || layoutId !== lobby.mode.layoutId;
        // A new map or layout starts from its default colours; `colours` (sparse, by army) applies over them.
        const sides = sideColours(changedMode ? mode.sides : lobby.sides, body.colours);
        if (changedMode) {
          // Seats carry over to the new map/layout wherever the same (slot, role) exists; only vanished seats reopen.
          const kept = new Map(lobby.slots.map((slot) => [`${slot.team}:${slot.role}`, slot]));
          const next = mode.sides.flatMap((side) => mode.roles.map((role): Slot => kept.get(`${side.id}:${role}`) ?? ({ team: side.id, role, occupant: { kind: 'open' }, assignedAt: Date.now() })));
          const dropped = lobby.slots.filter((slot) => !next.includes(slot));
          if (dropped.some((slot) => this.#heldByOther(lobby, slot, member.owner))) throw new HttpError(403, 'release_required');
          lobby.slots = next; lobby.mode = mode;
          for (const candidate of lobby.members.values()) candidate.observer = this.#humanTeams(lobby, candidate.owner).length === 0;
        }
        lobby.sides = sides;
        if (body.visibility !== undefined) lobby.visibility = body.visibility as 'public' | 'private';
        if (body.featured !== undefined) lobby.featured = body.featured as boolean;
        Object.assign(lobby, resolved); lobby.mapSeed = seed; lobby.size = size; lobby.observerDelayMs = delay;
        lobby.autoStart = false; this.#invalidate(lobby);
      } else if (body.op === 'ready') {
        if (typeof body.ready !== 'boolean') throw new HttpError(400, 'bad_request');
        // Start waits only on seated humans; an observer's readiness is meaningless, and accepting it would let any
        // member with the lobby code cancel preparation and the countdown over and over.
        if (!this.#humanTeams(lobby, member.owner).length) throw new HttpError(403, 'forbidden');
        if (lobby.phase !== 'waiting') this.#invalidate(lobby); member.ready = body.ready;
      } else if (body.op === 'start') { this.#start(lobby, member); }
      else if (body.op === 'kick') {
        if (lobby.leader !== member.owner || typeof body.memberId !== 'string') throw new HttpError(403, 'forbidden');
        const target = [...lobby.members.values()].find((entry) => entry.id === body.memberId); if (!target || target === member) throw new HttpError(400, 'bad_request');
        // A running match is decided by play, forfeit or absence: removing a seat owner would let the leader end it
        // (escaping a loss) or strip the other side's humans and commanders. Only seatless observers can be removed.
        if (lobby.phase === 'started' && lobby.slots.some((slot) => slot.owner === target.owner)) throw new HttpError(409, 'not_open');
        this.#leave(lobby, target);
      } else throw new HttpError(400, 'bad_request');
      this.#publish(lobby); client.send('lobby:result', { seq, ok: true, revision: lobby.revision });
    } catch (error) { client.send('lobby:result', { seq, ok: false, code: error instanceof HttpError ? error.code : 'internal' }); }
  }
  #freezeOccupant(slot: Slot): SlotOccupant {
    const occupant = structuredClone(slot.occupant);
    if (occupant.kind !== 'commander') return occupant;
    if (!slot.owner) throw new HttpError(403, 'forbidden');
    const commander = this.#ctx.host.commanders.roster(slot.owner).find((entry) => entry.id === occupant.ref.id);
    if (!commander || commander.kind !== occupant.ref.kind || !commander.roles.includes(slot.role)) throw new HttpError(409, 'commander_changed');
    if (occupant.ref.kind === 'policy') {
      const version = occupant.ref.version ?? commander.policy.activeByRole[slot.role];
      if (version == null || !commander.policy.versions.some((entry) => entry.version === version && entry.role === slot.role)) throw new HttpError(409, 'policy_failed');
      occupant.ref.version = version;
    }
    return occupant;
  }
  #start(lobby: Pregame, member: Member): void {
    this.#accepting(); if (lobby.leader !== member.owner) throw new HttpError(403, 'forbidden');
    // Pressing Start is the leader's readiness: a solo practice lobby is one click from map setup to match.
    member.ready = true;
    const humans = [...lobby.members.values()].filter((candidate) => this.#humanTeams(lobby, candidate.owner).length);
    if (lobby.phase !== 'waiting' || humans.some((candidate) => !candidate.client || !candidate.ready) || lobby.slots.some((slot) => slot.occupant.kind === 'open') || lobby.sides.some((side) => !lobby.slots.some((slot) => slot.team === side.id && slot.occupant.kind !== 'closed'))) throw new HttpError(409, 'not_ready');
    if (lobby.benchmark && lobby.slots.some((slot) => slot.occupant.kind === 'human' || slot.occupant.kind === 'closed')) throw new HttpError(400, 'benchmark_seats_required');
    // One owner's agent sessions on mutually hostile armies must be isolated (one commander never spans armies: `assign`).
    const agentSides = new Map<string, ArmyId[]>();
    for (const slot of lobby.slots) if (slot.owner && slot.occupant.kind === 'commander' && slot.occupant.ref.kind === 'agent') agentSides.set(slot.owner, [...agentSides.get(slot.owner) ?? [], slot.team]);
    for (const slot of lobby.slots) if (slot.owner && slot.occupant.kind === 'commander' && slot.occupant.ref.kind === 'agent' && agentSides.get(slot.owner)!.some((army) => this.#hostile(lobby, army, slot.team))) {
      const commander = this.#ctx.host.commanders.roster(slot.owner).find((entry) => entry.id === (slot.occupant as Extract<SlotOccupant, {kind:'commander'}>).ref.id);
      if (!commander?.isolation.independentSessions) throw new HttpError(409, 'isolated_sessions_required');
    }
    void this.#prepare(lobby);
  }
  #invalidate(lobby: Pregame): void {
    if (lobby.phase === 'started') return; lobby.generation++; lobby.revision++; lobby.phase = 'waiting'; lobby.countdownAt = undefined; lobby.preparingUntil = undefined; lobby.queuePosition = undefined; lobby.estimatedWaitMs = undefined;
    lobby.playerHistory.clear(); lobby.crossSide = false;
    if (lobby.game) { const game = lobby.game; lobby.game = undefined; lobby.work = lobby.work.then(() => game.close()); void lobby.work.catch(() => console.error('Lobby match disposal failed')); }
    for (const member of lobby.members.values()) member.ready = false;
  }
  async #prepare(lobby: Pregame): Promise<void> {
    const previous = lobby.work; const work = Promise.withResolvers<void>(); lobby.work = work.promise; const generation = ++lobby.generation; lobby.phase = 'preparing';
    try {
      await previous; if (!this.#lobbies.has(lobby.code) || generation !== lobby.generation) return;
      // Draft delegation alone is not played history: only participating humans carry owner control into a match.
      const humanOwners = new Set<string>();
      for (const slot of lobby.slots) if (slot.occupant.kind === 'human' && slot.owner) humanOwners.add(slot.owner);
      const assignments: SeatAssignment[] = lobby.slots.map((slot) => {
        const occupant = this.#freezeOccupant(slot); if (occupant.kind === 'open') throw new HttpError(409, 'open_seat');
        slot.occupant = occupant;
        return { team: slot.team, role: slot.role, owner: slot.owner ?? `lobby:${lobby.code}`, ...(slot.ownerControl && slot.owner && humanOwners.has(slot.owner) ? { ownerControl: true } : {}), kind: occupant.kind === 'closed' ? 'none' : occupant.kind === 'commander' ? occupant.ref.kind : occupant.kind, ...(occupant.kind === 'commander' ? { commander: { id: occupant.ref.id }, ...(occupant.ref.version === undefined ? {} : { policy: { version: occupant.ref.version } }) } : {}) };
      });
      const game = await this.#ctx.open(lobby.code, assignments, lobby.options, (queued) => {
        if (generation !== lobby.generation) return;
        lobby.queuePosition = queued?.position; lobby.estimatedWaitMs = queued?.estimatedWaitMs; this.#publish(lobby);
      }, () => this.#lobbies.has(lobby.code) && generation === lobby.generation, {
        identity: lobby.code, speed: 1, ownerKey: lobby.playOwner, ...matchSides(lobby.sides), lobby: this.#agentSummary(lobby),
        observerPolicy: { ...this.#policy(lobby), public: lobby.visibility === 'public' },
        botSeats: lobby.slots.flatMap((slot) => slot.occupant.kind === 'bot' ? [{ team: slot.team, role: slot.role, level: slot.occupant.level, options: slot.occupant.options }] : []),
        // A lobby room is never a rated queue (`lobby_match`): only the matchmaker writes a queue.
        log: { mode: 'lobby', queue: null, rulesHash: lobby.rulesHash, customRules: lobby.customRules, map: { id: lobby.mode.mapId, identity: arenaMapIdentity(lobby.mode.mapId, lobby.mapSeed, lobby.rules), seed: lobby.mapSeed, size: lobby.size, layout: lobby.mode.layoutId } },
      });
      if (!this.#lobbies.has(lobby.code) || generation !== lobby.generation) { await game.close(); return; }
      lobby.game = game; lobby.forfeited = new Set(); lobby.preparingUntil = Date.now() + this.#ctx.config.readySeconds * 1000;
      lobby.crossSide = this.#crossSide(lobby);
      // The lobby's grants are now the match's: an unplayed draft delegation keeps its owner (who may still hand it to
      // their commander) but no control, or a later hand-over would claim control the host never granted.
      for (const [index, slot] of lobby.slots.entries()) slot.ownerControl = assignments[index]!.ownerControl === true;
      for (const slot of lobby.slots) if (slot.occupant.kind === 'human' && slot.owner) { lobby.playerHistory.set(slot.owner, slot.team); await game.match.setHumanReady(slot.team, slot.role, true); }
      this.#publish(lobby);
    } catch (error) {
      if (this.#lobbies.has(lobby.code) && generation === lobby.generation) { this.#invalidate(lobby); for (const member of lobby.members.values()) member.client?.send('lobby:error', { code: error instanceof HttpError ? error.code : 'busy' }); this.#publish(lobby); }
    } finally { work.resolve(); }
  }
  #leave(lobby: Pregame, member: Member): void {
    for (const [key, grant] of this.#grants) if (grant.owner === member.owner && grant.code === lobby.code) this.#grants.delete(key);
    member.client?.leave(4000); lobby.members.delete(member.owner); this.#participation.delete(member.owner);
    const game = lobby.game;
    const tokens = [...member.gameTokens];
    const owned = lobby.slots.filter((slot) => slot.owner === member.owner);
    const armies = [...new Set(owned.filter((slot) => slot.occupant.kind === 'human').map((slot) => slot.team))];
    for (const slot of owned) { slot.occupant = { kind: 'open' }; slot.owner = undefined; slot.ownerControl = false; }
    if (game) {
      lobby.work = lobby.work.then(async () => {
        for (const token of tokens) await game.match.revokeToken(token);
        for (const slot of owned) await game.match.revokeSeat(slot.team, slot.role);
      });
      void lobby.work.catch((error: unknown) => { console.error('Lobby seat release failed', error); this.#remove(lobby); });
      // Leaving mid-match forfeits the member's army; the match goes on for the others. (Seat owners of a running
      // match cannot be kicked: only seatless observers are.)
      if (lobby.phase === 'started') this.#forfeit(lobby, game, armies);
    }
    if (!lobby.members.size) {
      // A started match plays on for the armies still in it (it ends, and the lobby is released, on its own).
      if (lobby.phase === 'started') return;
      this.#remove(lobby); return;
    }
    if (lobby.leader === member.owner) lobby.leader = lobby.members.keys().next().value!;
    this.#invalidate(lobby); this.#publish(lobby);
  }
  /**
   * Forfeited armies are eliminated and the others play on (DESIGN §15.7, §15.11); once every army is gone it is a
   * draw (armies already out keep their outcomes).
   */
  #forfeit(lobby: Pregame, game: LobbyMatch, armies: readonly ArmyId[]): void {
    const leaving = armies.filter((army) => !lobby.forfeited.has(army));
    if (!leaving.length) return;
    for (const army of leaving) lobby.forfeited.add(army);
    this.#mark(lobby.code);
    const everyone = lobby.sides.every((side) => lobby.forfeited.has(side.id));
    lobby.work = lobby.work.then(async () => {
      if (game.match.over) return;
      // An army already out (its Spire fell) has nothing to forfeit, and its human going absent decides nothing.
      const inPlay: ArmyId[] = [];
      for (const army of leaving) if (await game.match.outcome(army) === 'running') inPlay.push(army);
      if (!inPlay.length) return;
      if (everyone) await game.match.end('draw');
      else for (const army of inPlay) await game.match.forfeit(army);
    });
    void lobby.work.catch((error: unknown) => { console.error('Lobby forfeit failed', error); this.#remove(lobby); });
  }
  /** Drop the pregame reservation and its members' membership; a game room it handed off closes on its own grace. */
  #release(lobby: Pregame): void {
    lobby.generation++; this.#lobbies.delete(lobby.code); this.#mark(lobby.code); for (const member of lobby.members.values()) { this.#participation.delete(member.owner); member.client?.leave(4000); }
    this.#syncAgents(lobby, true);
    for (const [key, grant] of this.#grants) if (grant.code === lobby.code) this.#grants.delete(key);
    void this.#rooms.get(lobby.roomId)?.disconnect().catch((error: unknown) => console.error('Lobby room close failed', error));
    this.#rooms.delete(lobby.roomId); this.#publishDirectory();
  }
  #remove(lobby: Pregame): void {
    this.#release(lobby);
    if (lobby.game) void lobby.game.close().catch((error: unknown) => console.error('Lobby close failed', error));
  }
  /** A match that ended (normally, by forfeit, at its cap or reclaimed) frees its lobby so the same owners can play again. */
  #releaseFinished(): void {
    for (const lobby of [...this.#lobbies.values()]) if (lobby.phase === 'started' && lobby.game?.match.over) this.#release(lobby);
  }
  #seats(lobby: Pregame, owner?: string): LobbySeat[] {
    const readiness = lobby.game?.match.readiness().seats ?? []; const cards = lobby.game?.match.cards() ?? [];
    return lobby.slots.map((slot) => {
      const occupant = slot.occupant; const member = slot.owner ? lobby.members.get(slot.owner) : undefined;
      const state = readiness.find((seat) => seat.team === slot.team && seat.role === slot.role);
      const commander = slot.owner && occupant.kind === 'commander' ? this.#ctx.host.commanders.roster(slot.owner).find((entry) => entry.id === occupant.ref.id) : undefined;
      // A commander seat before its match exists: absent → online (its agent is connected) → ready (it called game_ready).
      const reserved = commander?.reservations.find((entry) => entry.team === slot.team && entry.role === slot.role);
      const ready = occupant.kind === 'human' ? member?.ready && member.client ? 'ready' : 'waiting' : occupant.kind === 'commander' ? state?.state ?? (!commander?.connected ? 'absent' : reserved?.ready ? 'ready' : 'online') : occupant.kind === 'open' ? 'waiting' : 'ready';
      const card = cards.find((entry) => entry.seat.team === slot.team && entry.seat.role === slot.role);
      return { team: slot.team, role: slot.role, occupant: occupant.kind === 'commander' ? { kind: 'commander', entrantId: `entrant-${lobby.slots.indexOf(slot)}`, ...(slot.owner === owner ? { ref: occupant.ref } : {}) } : structuredClone(occupant), ready, ...(card ? { card } : {}) };
    });
  }
  #summary(lobby: Pregame, owner?: string): LobbySummary {
    // Running public pregame metadata cannot become a side channel around the delayed match stream.
    if (lobby.publicFrozen) return lobby.publicFrozen.summary;
    const reasons = this.#practiceReasons(lobby);
    return {
      code: lobby.code, purpose: lobby.benchmark ? 'benchmark' : 'play', mapId: lobby.mode.mapId, layoutId: lobby.mode.layoutId, mode: lobby.mode.id,
      visibility: lobby.visibility, featured: lobby.featured, phase: lobby.phase, revision: lobby.revision, mapSeed: lobby.mapSeed, size: lobby.size,
      rules: lobby.rules, rulesHash: lobby.rulesHash, rulesDiff: lobby.rulesDiff,
      customRules: lobby.customRules, unrankedPractice: reasons.length > 0, practiceReasons: reasons,
      sides: lobby.sides, observerPolicy: this.#policy(lobby), terrain: lobby.rules.terrain,
      members: lobby.members.size, capacity: 16, seats: this.#seats(lobby, owner), agentsAllowed: true,
      ...(lobby.queuePosition === undefined ? {} : { queuePosition: lobby.queuePosition, estimatedWaitMs: lobby.estimatedWaitMs }),
    };
  }
  list(): LobbySummary[] { return [...this.#lobbies.values()].filter((lobby) => lobby.visibility === 'public' && lobby.expiresAt > Date.now()).map((lobby) => this.#summary(lobby)); }
  /**
   * Running public games their hosts leave on Watch live (`featured`), wherever they run. Private lobbies never.
   * Seats and the matchup line carry only what the public lobby already shows: display names, public seat cards
   * and bot levels.
   */
  featuredGames(): PublicGame[] {
    const games: PublicGame[] = [];
    for (const lobby of this.#lobbies.values()) {
      const game = lobby.game;
      if (lobby.visibility !== 'public' || !lobby.featured || lobby.phase !== 'started' || !lobby.running || lobby.runningAt === undefined || !game || game.match.over) continue;
      const cards = game.match.cards();
      const players = lobby.publicFrozen?.players ?? [];
      const seats: FeaturedSeat[] = [];
      for (const slot of lobby.slots) {
        const occupant = slot.occupant;
        if (occupant.kind === 'bot') seats.push({ team: slot.team, role: slot.role, kind: 'bot', level: occupant.level });
        else if (occupant.kind === 'human') seats.push({ team: slot.team, role: slot.role, kind: 'human', name: players.find((player) => player.id === occupant.memberId)?.label ?? 'Human' });
        else if (occupant.kind === 'commander') {
          const card = cards.find((entry) => entry.seat.team === slot.team && entry.seat.role === slot.role);
          seats.push({ team: slot.team, role: slot.role, kind: card?.kind ?? 'agent', name: card?.harness?.label ?? 'AI Player' });
        }
      }
      const policy = this.#policy(lobby);
      games.push({
        roomId: game.roomId, startedAt: lobby.runningAt, delayMs: policy.minDelayMs, omniscient: policy.allowOmniscient,
        armies: lobby.sides.map((side) => side.id), seats, label: `${featuredMatchup(lobby.sides.map((side) => side.id), seats)} · ${lobby.mode.label}`, game,
        // Having played a match restricts what you may watch of it: the armies an owner held a seat on.
        played: (owner) => {
          const armies = new Set<ArmyId>();
          const history = lobby.playerHistory.get(owner);
          if (history) armies.add(history as ArmyId);
          for (const slot of lobby.slots) if (slot.owner === owner && slot.occupant.kind !== 'open' && slot.occupant.kind !== 'closed') armies.add(slot.team);
          return armies.size ? [...armies] : undefined;
        },
      });
    }
    return games;
  }
  /** The lobby identity behind a request's credential (a profile or a lobby visitor); undefined when it names nobody. */
  viewer(req: IncomingMessage): string | undefined {
    try { return this.#owner(req); } catch { return undefined; }
  }
  /** The agents' pre-match summary: what the lobby shows everyone (map, layout, armies, changed rules). */
  #agentSummary(lobby: Pregame): unknown {
    return lobbySummary({ mapId: lobby.mode.mapId, layoutId: lobby.mode.layoutId, size: lobby.size, sides: lobby.sides, rules: lobby.rules });
  }
  /** When the match starts, as the agents' lobby state says; undefined once it runs. */
  #lobbyStart(lobby: Pregame): LobbyReservation['start'] | undefined {
    if (lobby.running) return undefined;
    if (lobby.phase === 'waiting') return { kind: 'host' };
    if (lobby.phase === 'preparing') return { kind: 'ready', ...(lobby.preparingUntil === undefined ? {} : { at: lobby.preparingUntil }) };
    if (lobby.phase === 'countdown') return { kind: 'countdown', ...(lobby.countdownAt === undefined ? {} : { at: lobby.countdownAt }) };
    return { kind: 'ready' };
  }
  /**
   * Reserve every agent commander seat for its agent (seat, summary, start) until the match runs, release the rest, and
   * describe the held match's start. Only changes reach the registry.
   */
  #syncAgents(lobby: Pregame, clear = false): void {
    const start = clear ? undefined : this.#lobbyStart(lobby);
    const want = new Map<string, LobbyReservation>();
    if (start) {
      const match = this.#agentSummary(lobby);
      for (const slot of lobby.slots) {
        if (slot.owner && slot.occupant.kind === 'commander' && slot.occupant.ref.kind === 'agent') want.set(`${slot.owner}\n${slot.occupant.ref.id}\n${slot.role}`, { team: slot.team, match, start });
      }
    }
    const commanders = this.#ctx.host.commanders;
    for (const key of [...lobby.reserved.keys()]) {
      if (want.has(key)) continue;
      const [owner, id, role] = key.split('\n') as [string, string, Plane];
      lobby.reserved.delete(key);
      try { commanders.reserve(owner, id, role, null); } catch { /* The commander or its role is gone: nothing reserved. */ }
    }
    for (const [key, reservation] of want) {
      const json = JSON.stringify(reservation);
      if (lobby.reserved.get(key) === json) continue;
      const [owner, id, role] = key.split('\n') as [string, string, Plane];
      try { commanders.reserve(owner, id, role, reservation); lobby.reserved.set(key, json); } catch { /* Removed commander: the start check refuses it. */ }
    }
    if (start && start.kind !== 'host' && lobby.game?.localMatch && !lobby.game.match.over) {
      try { lobby.game.localMatch.setLobbyStart(start); } catch { /* Disposed meanwhile. */ }
    }
  }
  #publish(lobby: Pregame): void {
    if (!this.#lobbies.has(lobby.code)) return;
    this.#syncAgents(lobby);
    let players: LobbyMember[] = [...lobby.members.values()].map((member) => ({
      id: member.id, label: member.label, observer: member.observer, connected: !!member.client,
      ready: member.ready, leader: lobby.leader === member.owner,
      seats: lobby.slots.filter((slot) => slot.owner === member.owner).map((slot) => ({ team: slot.team, role: slot.role })),
    }));
    if (lobby.visibility === 'public' && lobby.phase === 'started') {
      lobby.publicFrozen ??= { summary: this.#summary(lobby), players };
      players = lobby.publicFrozen.players;
    }
    for (const member of lobby.members.values()) {
      const leader = lobby.publicFrozen
        ? lobby.publicFrozen.players.some((player) => player.id === member.id && player.leader)
        : lobby.leader === member.owner;
      const snapshot: LobbySnapshot = {
        ...this.#summary(lobby, member.owner), players,
        you: { memberId: member.id, observer: member.observer, leader, ...(member.observer ? { grant: this.#observerGrant(lobby, member) } : {}) },
        expiresAt: lobby.expiresAt, ...(lobby.countdownAt === undefined ? {} : { countdownAt: lobby.countdownAt }),
      };
      member.client?.send('lobby:snapshot', snapshot);
    }
    lobby.signature = JSON.stringify(this.#summary(lobby)); this.#mark(lobby.code); this.#publishDirectory();
  }
  #publishDirectory(): void { if (this.#directory.size) { const state = { lobbies: this.list() }; for (const client of this.#directory.values()) client.send('lobby:list', state); } }
  frozenSpec(owner: string, code: string, revision: number): MatchSpec {
    const lobby = this.#require(code); this.#member(lobby, owner); if (lobby.leader !== owner) throw new HttpError(403, 'forbidden'); if (revision !== lobby.revision) throw new HttpError(409, 'stale_revision');
    if (lobby.slots.some((slot) => slot.occupant.kind !== 'bot' && slot.occupant.kind !== 'commander')) throw new HttpError(400, 'benchmark_seats_required');
    return {
      format: 'playerthree.match', version: 1, game: definition.manifest.id, gameVersion: definition.manifest.version,
      surfaceHash: surfaceHash(definition.manifest), rulesHash: lobby.rulesHash, seed: lobby.mapSeed,
      map: { id: lobby.mode.mapId, identity: arenaMapIdentity(lobby.mode.mapId, lobby.mapSeed, lobby.rules), seed: lobby.mapSeed, layout: lobby.mode.layoutId },
      options: { ...lobby.options },
      sides: lobby.sides.map((side) => ({
        id: side.id, spawnSlot: side.id, alliance: side.alliance,
        seats: lobby.slots.filter((slot) => slot.team === side.id).map((slot) => ({ role: slot.role, occupant: this.#freezeOccupant(slot) })),
      })),
      bindings: lobby.slots.filter((slot) => slot.occupant.kind !== 'closed').map((slot, index) => ({ seat: { team: slot.team, role: slot.role }, entrantId: `entrant-${index}` })),
      observerPolicy: this.#policy(lobby),
      rules: { ranked: false, coaching: 'off', practiceReasons: this.#practiceReasons(lobby) },
    };
  }
  #tick(): void {
    if (this.#closed) return; const now = Date.now();
    for (const [key, grant] of this.#grants) if (grant.expiresAt <= now) this.#grants.delete(key);
    for (const [key, visitor] of this.#visitors) if (visitor.expiresAt <= now) this.#visitors.delete(key);
    for (const lobby of this.#lobbies.values()) {
      if (lobby.expiresAt <= now) { this.#remove(lobby); continue; }
      if (lobby.phase === 'started' && lobby.game?.match.over) { this.#release(lobby); continue; }
      if (lobby.phase !== 'started') for (const member of lobby.members.values()) if (!member.client && member.holdUntil <= now) this.#leave(lobby, member);
      if (!this.#lobbies.has(lobby.code)) continue;
      if (lobby.phase === 'preparing' && lobby.game && (lobby.game.match.readiness().seats.filter((seat) => seat.kind !== 'human').every((seat) => seat.state === 'ready') || now >= (lobby.preparingUntil ?? Infinity))) { lobby.phase = 'countdown'; lobby.countdownAt = now + (lobby.autoStart ? 0 : this.#ctx.config.lobbyCountdownMs); this.#publish(lobby); }
      if (lobby.phase === 'countdown' && now >= (lobby.countdownAt ?? Infinity)) { lobby.phase = 'started'; lobby.handoffUntil = now + 30_000; lobby.expiresAt = now + this.#ctx.config.maxMatchMs + this.#ctx.config.endGraceMs + this.#policy(lobby).minDelayMs; this.#publish(lobby); }
      if (lobby.phase === 'started' && lobby.game && !lobby.game.match.over) {
        const humans = lobby.game.match.readiness().seats.filter((seat) => seat.kind === 'human');
        if (!lobby.running && humans.every((seat) => seat.state === 'ready')) {
          lobby.running = true; lobby.runningAt = now; this.#mark(lobby.code); this.#syncAgents(lobby);
          void Promise.resolve(lobby.game.start()).catch((error: unknown) => { console.error('Lobby start failed', error); this.#remove(lobby); });
        }
        const absent: ArmyId[] = [];
        for (const member of lobby.members.values()) { const teams = this.#humanTeams(lobby, member.owner).filter((army) => !lobby.forfeited.has(army)); if (!teams.length) continue;
          if (humans.some((seat) => teams.includes(seat.team as ArmyId) && seat.state !== 'ready')) { member.gameHoldUntil ??= lobby.running ? now + this.#ctx.config.lobbyRecoveryMs : lobby.handoffUntil; if (now >= (member.gameHoldUntil ?? Infinity)) absent.push(...teams); } else member.gameHoldUntil = undefined;
        }
        this.#forfeit(lobby, lobby.game, absent);
      }
      if (JSON.stringify(this.#summary(lobby)) !== lobby.signature) this.#publish(lobby);
    }
    void this.#flush();
  }
  beginDrain(): void { for (const lobby of this.#lobbies.values()) if (!lobby.running) { for (const member of lobby.members.values()) member.client?.send('lobby:error', { code: 'server_updating' }); this.#remove(lobby); } }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; clearInterval(this.#sweep); for (const limiter of Object.values(this.#limiters)) limiter.close();
    const lobbies = [...this.#lobbies.values()];
    for (const lobby of lobbies) lobby.generation++;
    await Promise.all(lobbies.map((lobby) => lobby.work));
    await Promise.all(lobbies.flatMap((lobby) => lobby.game ? [lobby.game.close()] : []));
    this.#grants.clear(); this.#lobbies.clear(); this.#participation.clear(); this.#directory.clear(); this.#visitors.clear();
  }
}
/** No shared schema: every packet is the service's allowlisted recipient projection. */
export function createLobbyRoom(service: LobbyService, directory = false) {
  return class PregameRoom extends Room {
    #grants = new WeakMap<Client, Grant>();
    onCreate(options: { code?: string }) {
      if (!service.roomOpened(this, directory ? undefined : options.code)) throw new Error('room creation requires server admission');
      this.autoDispose = false; this.maxClients = directory ? 256 : 16; this.maxMessagesPerSecond = 10; this.seatReservationTimeout = 15;
      this.onMessage('*', (client) => client.send('lobby:error', { code: 'bad_request' }));
      if (!directory) this.onMessage('lobby:command', (client, message) => { const grant = this.#grants.get(client); if (grant) service.command(client, grant, message); });
    }
    onAuth(client: Client, options: unknown) { const token = options && typeof options === 'object' && 'token' in options ? options.token : undefined; const grant = service.claim(this.roomId, token, client.sessionId); if (!grant) return false; this.#grants.set(client, grant); return { authorized: true }; }
    onJoin(client: Client) { const grant = this.#grants.get(client); if (!grant) return client.leave(4003); service.attach(client, grant); }
    onLeave(client: Client) { const grant = this.#grants.get(client); if (grant) service.detach(client, grant); this.#grants.delete(client); }
  };
}
