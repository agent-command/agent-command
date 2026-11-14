import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { Client as SdkClient, type Room as SdkRoom } from '@colyseus/sdk';
import { applyView, type ServerMsg, type ViewState } from 'playerthree';
import { loadConfig, type ServerConfig } from '../src/config.ts';
import { createGameServer, type GameServer } from '../src/app.ts';
import type { LobbySnapshot } from '@agent-command/game/lobby';
import type { RosterResponse } from '../src/roster.ts';

export function webDist(): string {
  const dir = mkdtempSync(joinPath(tmpdir(), 'ac-web-'));
  writeFileSync(joinPath(dir, 'index.html'), readFileSync(new URL('../../web/index.html', import.meta.url)));
  mkdirSync(joinPath(dir, 'assets'));
  writeFileSync(joinPath(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  return dir;
}

export async function start(overrides: Partial<ServerConfig> = {}): Promise<{ server: GameServer; base: string; sdk: SdkClient }> {
  const config: ServerConfig = { ...loadConfig({}), port: 0, host: '127.0.0.1', trustProxy: true, webDist: webDist(), simWorkers: 0, mainMaxMatches: 1000, maxMatches: 1000, admissionLagMs: 1000, featuredMatch: false, ...overrides };
  const server = createGameServer(config);
  const port = await server.listen();
  const base = `http://127.0.0.1:${port}`;
  return { server, base, sdk: new SdkClient(base) };
}

let ipCounter = 1;
/** A fresh client IP per call (the test server trusts X-Forwarded-For). */
export function freshIp(): string {
  ipCounter++;
  return `10.0.${ipCounter >> 8}.${ipCounter & 255}`;
}

export function postLobby(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/lobbies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export interface Conn {
  room: SdkRoom;
  inbox: { type: string; msg: ServerMsg }[];
  /** Each team's view as the client rebuilds it from keyframes and deltas. */
  views: Map<string, ViewState>;
  /** The rebuilt view's tick after every view message, in arrival order. */
  viewTicks: number[];
  /** Deltas that arrived without their base version (must stay 0). */
  gaps: number;
}

/** Test-side view of a JSON body (the server under test is what is being checked). */
export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export interface LobbyCreate {
  mapId: string;
  layoutId: string;
  visibility: 'public' | 'private';
  preset: 'play' | 'host' | 'benchmark';
  autoStart?: boolean;
  featured?: boolean;
  rules?: Record<string, unknown>;
}

export interface Handoff {
  roomId: string;
  token: string;
  tickets: { role: string; token: string }[];
  /** Lobby seat tickets: whether a commander can take one of these seats mid-match (main-process match). */
  agentHandOver?: boolean;
}

export interface AttachedLobby {
  code: string;
  authorization: string;
  sdk: SdkClient;
  lobby: SdkRoom;
  snapshots: LobbySnapshot[];
  /** The create response's Set-Cookie (the anonymous play-owner cookie), if any. */
  setCookie: string | null;
}

/** POST to a lobby's owner route (`connect`, `ticket`, `leave`) with that lobby's credential. */
export function lobbyRoute(base: string, code: string, path: string, authorization: string): Promise<Response> {
  return fetch(`${base}/api/lobbies/${code}/${path}`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: '{}',
  });
}

/** Real lobby creation and pregame attachment; auto-start presets then allocate, queue and start on their own. */
export async function lobbyAttach(base: string, body: LobbyCreate, headers: Record<string, string> = {}): Promise<AttachedLobby> {
  const response = await postLobby(base, body, headers);
  if (response.status !== 200) throw new Error(`POST /api/lobbies → ${response.status}`);
  const opened = await json<{ code: string; visitorToken?: string }>(response);
  const authorization = headers.authorization ?? `Visitor ${opened.visitorToken}`;
  const grant = await json<{ roomId: string; token: string }>(await lobbyRoute(base, opened.code, 'connect', authorization));
  const sdk = new SdkClient(base);
  const lobby = await sdk.joinById(grant.roomId, { token: grant.token });
  const snapshots: LobbySnapshot[] = [];
  lobby.onMessage('lobby:snapshot', (snapshot: LobbySnapshot) => snapshots.push(snapshot));
  return { code: opened.code, authorization, sdk, lobby, snapshots, setCookie: response.headers.get('set-cookie') };
}

/** Exact-seat handoff once the lobby has started; resolves when a joined seat sees a running tick. */
export async function lobbyEnter(base: string, attached: AttachedLobby, ms = 5000): Promise<Handoff & { connections: Conn[] }> {
  await until(() => attached.snapshots.some((snapshot) => snapshot.phase === 'started'), ms);
  const ticketResponse = await lobbyRoute(base, attached.code, 'ticket', attached.authorization);
  if (ticketResponse.status !== 200) throw new Error(`lobby ticket → ${ticketResponse.status}`);
  const ticket = await json<Handoff>(ticketResponse);
  const connections = await Promise.all(ticket.tickets.map((seat) => join(attached.sdk, ticket.roomId, seat.token)));
  await until(() => connections.some((connection) => (connection.viewTicks.at(-1) ?? 0) > 0));
  return { ...ticket, connections };
}

/** Real lobby attachment, readiness and exact-seat handoff; never creates matches directly. */
export async function lobbyHandoff(base: string, body: LobbyCreate, authorization?: string): Promise<Handoff & { code: string; authorization: string; lobby: SdkRoom; connections: Conn[] }> {
  const attached = await lobbyAttach(base, body, authorization ? { authorization } : {});
  return { ...await lobbyEnter(base, attached), code: attached.code, authorization: attached.authorization, lobby: attached.lobby };
}

export async function namedCommander(base: string, secret: string, name: string, roles: string[]) {
  const response = await fetch(`${base}/api/profile/commanders`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ name, kind: 'agent', roles, isolation: { independentSessions: false } }),
  });
  if (response.status !== 201) throw new Error(`register commander → ${response.status}`);
  const roster = await json<RosterResponse>(response);
  const commander = roster.commanders.find((entry) => entry.name === name);
  if (!commander) throw new Error('registered commander missing from roster');
  return commander;
}

export async function join(sdk: SdkClient, roomId: string, token: string): Promise<Conn> {
  const room = await sdk.joinById(roomId, { token });
  const conn: Conn = { room, inbox: [], views: new Map(), viewTicks: [], gaps: 0 };
  room.onMessage('*', (type, msg) => {
    const received = msg as ServerMsg;
    conn.inbox.push({ type: String(type), msg: received });
    if (received.op !== 'view') return;
    const next = applyView(conn.views.get(received.team), received);
    if (!next) { conn.gaps++; return; }
    conn.views.set(received.team, next);
    const view = next.view;
    if (typeof view === 'object' && view !== null && 'tick' in view && typeof view.tick === 'number') conn.viewTicks.push(view.tick);
  });
  return conn;
}

/** Ask only after the SDK join and handler installation; an onJoin-only push cannot satisfy this handshake. */
export async function requestAuthority(conn: Conn, claims: Record<string, unknown> = {}): Promise<unknown> {
  const first = conn.inbox.length;
  conn.room.send('ac:authority', claims);
  return (await until(() => conn.inbox.find((entry, index) => index >= first && entry.type === 'ac:authority'))).msg;
}

/** Polls a condition fed by network messages (the SDK exposes no promise per message). */
export async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
