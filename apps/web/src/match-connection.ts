/** Gameplay-only transport: static SDK dependencies stay outside the cold lobby module graph. */
import { Client, type Room } from '@colyseus/sdk';
import { applyView, MSG, type ServerMsg, type ViewMessage, type ViewState } from 'playerthree/protocol';
import type { Controller, IntentAck, SeatInfo } from 'playerthree';
import type { Mandate, PolicyStatus, Scope } from 'playerthree/control';
import { isPlane, type ArmyId, type Plane, type Report, type View } from '@agent-command/game/contract';
import { matchCloseReason, type PublicLobbyCard } from '@agent-command/game/lobby';
import { ApiError } from './api.ts';
import { profileCall, type LobbyMatchTicket, type LobbySeatRenewal, type SeatOccupantChoice } from './profile.ts';
import { CallError, colyseusEndpoint, type ConnectionEvents, type MatchLeft, type MatchTicket } from './net.ts';
import { MatchRequests, type MatchRequest } from './match-requests.ts';

type LobbyOptions = Pick<MatchTicket, 'tickets' | 'lobbyCode' | 'lobbyAuth'>;
const MIN_RENEWAL_DELAY_MS = 5000;
const RECOVERY_ATTEMPTS = 3;
const RECOVERY_BACKOFF_MS = 250;
/**
 * While the server answers "unavailable" (a 5xx, `cluster_unavailable`, or no connection at all), recovery keeps
 * asking this long without using up an attempt: a crashed cluster primary is replaced within it, and the match
 * itself runs on.
 */
const RECOVERY_UNAVAILABLE_MS = 20_000;
const RECOVERY_UNAVAILABLE_RETRY_MS = 1000;
export class Connection {
  private readonly requests = new MatchRequests();
  private readonly rooms = new Map<string, Room>();
  private readonly knownSeats = new Map<string, SeatInfo>();
  /** Private authenticated authority, sent only to this connection (never inferred from public seats). */
  private legacyAuthority: { roles: Plane[]; queuePriority: boolean } = { roles: [], queuePriority: false };
  /** Each team's view as rebuilt from the primary room's keyframes and deltas. */
  private readonly views = new Map<string, ViewState>();
  private readonly events: ConnectionEvents;
  private readonly options: LobbyOptions;
  private primaryKey: string;
  private primaryRoom: Room;
  private readonly roomId: string;
  private renewal: number | undefined;
  private recovering = false;
  private closed = false;
  private terminal = false;
  /** Our army's outcome is final (eliminated): the server issues no more seat tickets, so seats are never recovered. */
  private final = false;

  private constructor(room: Room, roomId: string, ev: ConnectionEvents, options: LobbyOptions) {
    this.events = ev;
    this.options = options;
    this.roomId = roomId;
    this.primaryKey = options.tickets?.[0]?.role ?? '';
    this.primaryRoom = room;
    this.rooms.set(this.primaryKey, room);
    this.attach(room, this.primaryKey);
  }

  get room(): Room { return this.primaryRoom; }

  /** Role tickets are private server-issued capabilities, not a guess from seat controller labels. */
  canAct(role: Plane): boolean {
    return !this.closed && !this.terminal && !this.final && !this.recovering
      && (this.rooms.has(role) || !this.options.tickets?.length && this.legacyAuthority.roles.includes(role));
  }

  /** Only an explicitly owner-authorized ticket may reallocate that owner's protected commitments. */
  canPrioritize(role: Plane): boolean {
    return this.canAct(role) && (this.options.tickets?.length
      ? this.options.tickets.some((ticket) => ticket.role === role && ticket.queuePriority === true)
      : this.legacyAuthority.queuePriority);
  }

  private attach(room: Room, key: string): void {
    const current = (): boolean => !this.closed && this.rooms.get(key) === room;
    room.onMessage('ac:authority', (message: { roles?: unknown; queuePriority?: unknown }) => {
      if (!current() || this.options.tickets?.length || key !== this.primaryKey) return;
      this.legacyAuthority = {
        roles: Array.isArray(message.roles) ? message.roles.filter(isPlane) : [],
        queuePriority: message.queuePriority === true,
      };
      this.events.authorityChanged?.();
    });
    room.onMessage(MSG.result, (m: Extract<ServerMsg, { op: 'result' }>) => {
      if (current()) this.requests.receive(m);
    });
    room.onMessage(MSG.view, (m: ViewMessage) => {
      if (!current() || key !== this.primaryKey) return;
      const next = applyView(this.views.get(m.team), m);
      if (next) {
        this.views.set(m.team, next);
        this.events.view(next.view as View);
        return;
      }
      // A delta without its base cannot be repaired in place: a fresh admission starts from a keyframe.
      this.views.delete(m.team);
      if (this.options.lobbyCode) void this.recover();
      else this.lose('lost');
    });
    room.onMessage(MSG.seats, (m: Extract<ServerMsg, { op: 'seats' }>) => {
      if (!current()) return;
      for (const seat of m.seats) this.knownSeats.set(`${seat.team}/${seat.role}`, seat);
      this.events.seats([...this.knownSeats.values()]);
    });
    room.onMessage(MSG.cards, (m: { cards: PublicLobbyCard[] }) => {
      if (current() && key === this.primaryKey) this.events.cards?.(m.cards);
    });
    room.onMessage(MSG.report, (m: { op: 'report'; team: ArmyId; data: Report }) => {
      if (!current() || key !== this.primaryKey) return;
      this.terminal = true;
      this.events.authorityChanged?.();
      window.clearTimeout(this.renewal);
      if (this.recovering) { this.recovering = false; this.events.recovering?.(false); }
      this.requests.disconnect();
      this.events.report(m.team, m.data);
    });
    room.onMessage(MSG.said, (m: { op: 'said'; role: unknown; tick: unknown; text: unknown }) => {
      if (current() && typeof m?.role === 'string' && typeof m.tick === 'number' && typeof m.text === 'string') this.events.said?.({ role: m.role, tick: m.tick, text: m.text });
    });
    room.onLeave((code: number) => {
      if (!current() || this.recovering || this.terminal || this.final) return;
      this.requests.disconnect();
      // The server took the match away (restart, update, closed): nothing to rejoin and no result to show.
      const reason = matchCloseReason(code);
      if (reason) this.lose(reason);
      else if (this.options.lobbyCode) void this.recover();
      else this.lose('lost');
    });
    // The SDK can drop onJoin messages before joinById resolves. Request the authenticated
    // principal's authority only after the receiver is installed; never send client role claims.
    if (!this.options.tickets?.length && key === this.primaryKey) room.send('ac:authority', {});
  }

  static async join(roomId: string, token: string, ev: ConnectionEvents, options: LobbyOptions = {}): Promise<Connection> {
    const client = new Client(colyseusEndpoint());
    const first = options.tickets?.[0];
    const room = await client.joinById(roomId, { token: first?.token ?? token });
    // Public leases cannot replay a bearer through SDK session reconnection.
    if (options.tickets?.length) room.reconnection.enabled = false;
    const connection = new Connection(room, roomId, ev, options);
    try {
      for (const ticket of options.tickets?.slice(1) ?? []) {
        const extra = await client.joinById(roomId, { token: ticket.token, view: false });
        extra.reconnection.enabled = false;
        const key = ticket.role ?? '';
        connection.rooms.set(key, extra);
        connection.attach(extra, key);
      }
      connection.scheduleRenewal();
      if (options.tickets?.length) connection.events.authorityChanged?.();
      return connection;
    } catch (error) {
      connection.closed = true;
      for (const joined of connection.rooms.values()) void joined.leave(true);
      throw error;
    }
  }

  private scheduleRenewal(): void {
    window.clearTimeout(this.renewal);
    if (!this.options.lobbyCode || !this.options.tickets?.length || this.closed || this.terminal) return;
    const expiresAt = Math.min(...this.options.tickets.map((ticket) => ticket.expiresAt));
    // Halfway through what is left: room for a slow request, a retry, or a background tab's timer delayed by a minute.
    // The floor bounds retries once little is left (the server closes the seats at expiry, which `recover` handles).
    this.renewal = window.setTimeout(() => void this.renew(), Math.max(MIN_RENEWAL_DELAY_MS, (expiresAt - Date.now()) / 2));
  }

  /**
   * Extend the connected seats' credentials in place. The sockets, the view stream and pending commands all stay; only
   * a seat the server can no longer extend (dropped, revoked) takes fresh tickets and rejoins through `recover`.
   */
  private async renew(): Promise<void> {
    const tickets = this.options.tickets;
    if (this.closed || this.terminal || this.final || this.recovering || !this.options.lobbyCode || !tickets?.length) return;
    try {
      const renewed = await this.lobbyCall<LobbySeatRenewal>('renew');
      if (this.closed || this.terminal || this.final || this.recovering || this.options.tickets !== tickets) return;
      const expiry = new Map(renewed.tickets.map((ticket) => [ticket.role ?? '', ticket.expiresAt]));
      if (renewed.roomId !== this.roomId || tickets.some((ticket) => !expiry.has(ticket.role ?? ''))) throw new CallError('bad_response');
      this.options.tickets = tickets.map((ticket) => ({ ...ticket, expiresAt: expiry.get(ticket.role ?? '')! }));
      this.scheduleRenewal();
    } catch (error) {
      if (this.closed || this.terminal || this.final || this.recovering || this.options.tickets !== tickets) return;
      const code = error instanceof CallError || error instanceof ApiError ? error.code : undefined;
      if (code === 'eliminated') { this.eliminated(); return; }
      if (code === 'not_renewable' || code === 'bad_response' || code === 'lobby_not_found') { void this.recover(); return; }
      // A blip (offline, timeout, 5xx): try again in half the time left; the seats stay up until their expiry.
      this.scheduleRenewal();
    }
  }

  /**
   * Mid-match: hand one of my army's seats to a commander of mine, a bot or me (`POST …/seat`, with the admission
   * that entered this match, profile or visitor), then rejoin with my current seat tickets (new human seats, or none).
   */
  async handOver(team: string, role: Plane, occupant: SeatOccupantChoice): Promise<void> {
    await this.lobbyCall('seat', { team, role, occupant });
    await this.recover();
  }

  private async recover(): Promise<void> {
    if (this.closed || this.terminal || this.final || this.recovering || !this.options.lobbyCode) return;
    this.recovering = true;
    this.events.authorityChanged?.();
    window.clearTimeout(this.renewal);
    this.events.recovering?.(true);
    this.requests.disconnect();
    let gone = false;
    const outageSince = performance.now();
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS && !this.closed && !this.terminal; attempt++) {
      const opened: Room[] = [];
      try {
        const ticket = await this.lobbyCall<LobbyMatchTicket>('ticket');
        if (ticket.roomId !== this.roomId || !ticket.tickets?.length) throw new CallError('bad_response');
        if (this.closed || this.terminal) return;
        const client = new Client(colyseusEndpoint());
        const next = new Map<string, Room>();
        // The view-receiving primary joins last: its keyframe cannot arrive before its handlers are attached below
        // (the SDK drops messages without a handler, and every later delta builds on that keyframe).
        for (let i = ticket.tickets.length - 1; i >= 0; i--) {
          const admission = ticket.tickets[i]!;
          const room = await client.joinById(this.roomId, { token: admission.token, ...(i === 0 ? {} : { view: false }) });
          room.reconnection.enabled = false;
          opened.push(room);
          next.set(admission.role ?? '', room);
        }
        if (this.closed || this.terminal) { for (const room of opened) void room.leave(true); return; }
        const previous = [...this.rooms.values()];
        this.rooms.clear();
        this.views.clear();
        for (const [key, room] of next) this.rooms.set(key, room);
        this.primaryKey = ticket.tickets[0]!.role ?? '';
        this.primaryRoom = next.get(this.primaryKey)!;
        this.options.tickets = ticket.tickets;
        for (const [key, room] of next) this.attach(room, key);
        for (const room of previous) void room.leave(true);
        this.recovering = false;
        this.events.authorityChanged?.();
        this.events.recovering?.(false);
        this.scheduleRenewal();
        return;
      } catch (error) {
        for (const room of opened) void room.leave(true);
        // The server refuses seat tickets for an army that is out: stop quietly, the player watches as an observer.
        if ((error instanceof CallError || error instanceof ApiError) && error.code === 'eliminated') { this.final = true; break; }
        // The server no longer has the lobby or the room (it restarted while we were cut off): nothing to retry.
        if (error instanceof ApiError && error.code === 'lobby_not_found' || error instanceof Error && error.message === 'room_not_found') { gone = true; break; }
        const unavailable = error instanceof TypeError || error instanceof ApiError && (error.code === 'cluster_unavailable' || /^http_5\d\d$/.test(error.code));
        if (unavailable && performance.now() - outageSince < RECOVERY_UNAVAILABLE_MS && !this.closed && !this.terminal) {
          attempt--;
          const delay = Promise.withResolvers<void>();
          window.setTimeout(delay.resolve, RECOVERY_UNAVAILABLE_RETRY_MS);
          await delay.promise;
          continue;
        }
        if (attempt + 1 < RECOVERY_ATTEMPTS && !this.closed && !this.terminal) {
          const delay = Promise.withResolvers<void>();
          window.setTimeout(delay.resolve, RECOVERY_BACKOFF_MS * (attempt + 1));
          await delay.promise;
        }
      }
    }
    this.recovering = false;
    this.events.recovering?.(false);
    if (!this.terminal && !this.final) this.lose(gone ? 'restart' : 'lost');
  }

  /** The match ended for us without a result: close everything and say why (never as a win, loss or draw). */
  private lose(reason: MatchLeft): void {
    if (this.close()) this.events.left(reason);
  }

  private request(body: MatchRequest, role?: string): Promise<unknown> {
    const room = this.options.tickets?.length && role !== undefined ? this.rooms.get(role) : this.primaryRoom;
    if (this.closed || this.terminal || this.recovering) return Promise.reject(new CallError('disconnected'));
    if (!room) return Promise.reject(new CallError('forbidden'));
    return this.requests.send(room, body);
  }

  async act(role: Plane, intents: Record<string, unknown>[]): Promise<IntentAck[]> {
    const data = await this.request({ op: 'call', role, method: 'act', args: { intents } }, role);
    return Array.isArray(data) ? data as IntentAck[] : [];
  }
  async setController(role: string, controller: Controller): Promise<void> {
    await this.request({ op: 'controller', role, controller }, role);
  }
  async setMandate(role: string, mandate: Mandate): Promise<void> {
    await this.request({ op: 'mandate', role, mandate }, role);
  }
  async setScopes(role: string, scopes: Scope[]): Promise<void> {
    await this.request({ op: 'scopes', role, scopes }, role);
  }
  async resolveApproval(role: Plane, id: string, approve: boolean): Promise<void> {
    await this.request({ op: 'resolveApproval', role, id, approve }, role);
  }
  async policyStatus(role: Plane): Promise<PolicyStatus | null> {
    return await this.request({ op: 'call', role, method: 'policyStatus' }, role) as PolicyStatus | null;
  }
  async mint(role: string): Promise<{ role: string; token: string }> {
    const data = await this.request({ op: 'mint', role }, role) as { role?: unknown; token?: unknown } | string;
    if (typeof data === 'string') return { role, token: data };
    if (typeof data?.token !== 'string') throw new CallError('bad_response');
    return { role, token: data.token };
  }

  async tell(roles: Plane[] | 'all', text: string, ping?: unknown): Promise<void> {
    if (!this.options.tickets?.length) {
      await this.request({ op: 'tell', roles, text, ...(ping !== undefined ? { ping } : {}) });
      return;
    }
    const selected = roles === 'all' ? [...this.rooms.keys()] : roles;
    for (const role of selected) await this.request({ op: 'tell', roles: [role], text, ...(ping !== undefined ? { ping } : {}) }, role);
  }

  watch(armies: ArmyId[]): void { this.primaryRoom.send(MSG.watch, { teams: armies }); }

  /**
   * Our army is eliminated (its outcome is final). The seat connection may still deliver public views until the
   * observer pass takes over, but a dropped seat is never re-ticketed and its loss is not a disconnect.
   */
  eliminated(): void {
    this.final = true;
    this.events.authorityChanged?.();
    window.clearTimeout(this.renewal);
  }

  /** Leave the match and its lobby (the player is done with this game). */
  leave(): void {
    if (!this.close()) return;
    if (this.options.lobbyCode) void this.lobbyCall('leave').catch(() => this.events.left('lost'));
  }

  /** A lobby call with the admission that entered this match (profile or anonymous visitor), never a new identity. */
  private lobbyCall<T>(action: 'ticket' | 'renew' | 'leave' | 'seat', body: Record<string, unknown> = {}): Promise<T> {
    const { lobbyCode, lobbyAuth } = this.options;
    if (!lobbyCode || !lobbyAuth?.secret && !lobbyAuth?.visitorToken) return Promise.reject(new CallError('bad_profile'));
    return profileCall<T>(`/api/lobbies/${encodeURIComponent(lobbyCode)}/${action}`, { body, ...lobbyAuth });
  }

  /** Close the seat connections but stay a lobby member: an eliminated player's observer pass rides on it. */
  handOff(): void { this.close(); }

  private close(): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.events.authorityChanged?.();
    window.clearTimeout(this.renewal);
    this.requests.disconnect();
    for (const room of this.rooms.values()) void room.leave(true);
    return true;
  }
}
