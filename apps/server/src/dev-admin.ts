/**
 * Dev-admin API (`/dev/*`) for local tooling (tools/dev-mcp): list and create matches, control sim speed, god view,
 * cheats and ending matches. Mounted only when `AC_DEV_ADMIN_TOKEN` is set (never on a public deployment); every
 * request must come straight from loopback (no proxy headers) and carry `Authorization: Bearer <token>`.
 *
 *   GET  /dev/matches                      every live match: room, mode, armies, tick, speed, outcomes, seat controllers
 *   POST /dev/matches                      { mode, opponent?, seed?, rules?, speed?, map?, armies?, colours? } → room id + every token
 *                                          (`ffa`: you on the first army vs bots on a four-slot map, default four_corners)
 *   GET  /dev/matches/<roomId>             one match, with its tokens
 *   POST /dev/matches/<roomId>/speed       { speed } game ticks per room tick, 0 pauses (1–50)
 *   POST /dev/matches/<roomId>/step        { ticks } while paused
 *   GET  /dev/matches/<roomId>/god         ?plane=&detail=summary|entities|events — unfogged, straight from the sim
 *   POST /dev/matches/<roomId>/cheat       { op: give|spawn|reveal|damage|kill|spire, army?, … }
 *   POST /dev/matches/<roomId>/end         { winner?: army } (default draw)
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FinalOutcome, GameDefinition } from 'playerthree';
import { lobbyLayout, lobbyMap } from '@agent-command/game/lobby';
import {
  CELL,
  COLOURS,
  ISLAND_STRUCTURES,
  isIslandStructure,
  isUnitKind,
  type IslandStructure,
  definition,
  OPPONENTS,
  PLANES,
  slotArmyIds,
  TICK_RATE,
  UNIT_KINDS,
  NEUTRAL,
  type AgentCommandGame,
  type Army,
  type ArmyId,
  type AgentCommandManifest,
  type MatchArmy,
  type MatchOptions,
  type Opponent,
  type Plane,
  type UnitKind,
} from '@agent-command/game';
import { HttpError, readJson, sendJson } from './http.ts';
import type { GameMatch, LiveMatch, MatchMode, MatchRegistry } from './room.ts';
import { requestRules } from './rules.ts';

type Sim = AgentCommandGame['sim'];
type Ent = Sim['ents'][number];

export const MAX_DEV_SPEED = 50;
/** Largest single `step` (10 game minutes). */
export const MAX_DEV_STEP = 10 * 60 * TICK_RATE;
/** Create bodies may carry a bounded inline map document plus numeric rules. */
const BODY_BYTES = 144 * 1024;
const MODES: readonly MatchMode[] = ['bots', 'pvp', 'agents', 'ffa'];
/** Default map of `ffa` dev matches. */
const FFA_MAP = 'four_corners';
const DETAILS = ['summary', 'entities', 'events'] as const;
const SPAWN_STRUCTURES = ['shaft', 'turret', ...ISLAND_STRUCTURES, 'headframe', 'bulkhead', 'lava_bridge'] as const;
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'];

export interface DevAdminOptions {
  token: string;
  registry: MatchRegistry;
  /** Operator-only match allocation; public setup goes through the lobby service. */
  open(o: { mode: MatchMode; opponent: Opponent; seed?: number; rules?: MatchOptions; armies?: readonly MatchArmy[] }): Promise<{ match: GameMatch; roomId: string }>;
}

export interface DevAdmin {
  /** The game definition the host must use: records each match's game so the god view and cheats reach its sim. */
  readonly definition: GameDefinition<AgentCommandManifest>;
  /** Call right after `host.createMatch`: binds the game created for it to the match. */
  adopt(match: GameMatch): void;
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
}

/**
 * `ffa` armies and map selection: a registry map with an `ffa` layout (authored, or a generated recipe launched with
 * its slot count), 2..slots armies (default every slot) and one distinct colour per army (stage 2).
 */
function ffaSetup(b: Record<string, unknown>, rules: MatchOptions | undefined): { armies: MatchArmy[]; rules: MatchOptions } {
  const map = lobbyMap(b.map === undefined ? FFA_MAP : typeof b.map === 'string' ? b.map : '');
  const layout = map && lobbyLayout(map.id, 'ffa');
  if (!map || !layout) throw new HttpError(400, 'bad_map');
  const count = b.armies === undefined ? layout.sides : intIn(b.armies, 2, layout.sides, 'bad_armies');
  // Two armies take the diagonal (the C4 duel corners); more take the slots in order.
  const ids = count === 2 ? slotArmyIds(2) : slotArmyIds(layout.sides).slice(0, count);
  const colours: unknown = b.colours ?? COLOURS.slice(0, count);
  if (!Array.isArray(colours) || colours.length !== count || colours.some((colour) => !(COLOURS as readonly unknown[]).includes(colour)) || new Set(colours).size !== count) throw new HttpError(400, 'bad_colours');
  const selection = (rules?.map ?? {}) as { seed?: number; params?: Record<string, unknown> };
  return {
    armies: ids.map((id, k) => ({ id, colour: colours[k] as MatchArmy['colour'] })),
    rules: { ...rules, terrain: map.terrain, map: map.tags.includes('generated')
      ? { ...(selection.seed === undefined ? {} : { seed: selection.seed }), params: { ...selection.params, slots: layout.sides } }
      : { name: map.id } } as MatchOptions,
  };
}

/** Loopback peers only: 127.0.0.0/8, ::1 and IPv4-mapped loopback. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad_request');
  return body as Record<string, unknown>;
}

function oneOf<T extends string>(v: unknown, values: readonly T[], code: string): T {
  if (typeof v !== 'string' || !values.includes(v as T)) throw new HttpError(400, code);
  return v as T;
}

function intIn(v: unknown, min: number, max: number, code: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, code);
  return v;
}

/** Entity ids as the views spell them (`e_12`); a bare number is accepted too. */
function entityId(v: unknown, code: string): number {
  const n = typeof v === 'string' && /^e_\d{1,10}$/.test(v) ? Number(v.slice(2)) : v;
  return intIn(n, 1, 2 ** 31 - 1, code);
}

function numIn(v: unknown, min: number, max: number, code: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, code);
  return v;
}

export function createDevAdmin(opts: DevAdminOptions): DevAdmin {
  const tokenHash = digest(opts.token);
  const games = new WeakMap<GameMatch, AgentCommandGame>();
  let created: AgentCommandGame | undefined;

  const wrapped: GameDefinition<AgentCommandManifest> = {
    ...definition,
    create(o) {
      created = definition.create(o) as AgentCommandGame;
      return created;
    },
  };

  function authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer ([\x21-\x7e]{1,256})$/.exec(h) : null;
    return m !== null && timingSafeEqual(digest(m[1]!), tokenHash);
  }

  function live(roomId: string): { live: LiveMatch; game: AgentCommandGame } {
    const l = opts.registry.get(roomId);
    const game = l && games.get(l.match);
    if (!l || !game) throw new HttpError(404, 'match_not_found');
    return { live: l, game };
  }

  function info(roomId: string, l: LiveMatch, tokens: boolean) {
    const m = l.match;
    const seats: Record<string, Record<string, string>> = {};
    for (const s of m.seats()) (seats[s.team] ??= {})[s.role] = s.agentActive ? `${s.controller}+agent` : s.controller;
    const game = games.get(m);
    return {
      roomId,
      mode: l.mode,
      /** The match's armies in slot order with their colours (alliances are keyed by colour). */
      armies: m.teams.map((id) => ({ id, colour: Object.entries(m.alliances ?? {}).find(([, members]) => members.includes(id))?.[0] })),
      tick: m.tick,
      speed: l.speed ?? null,
      ...(game ? { seed: game.sim.seed, terrain: game.sim.preset } : {}),
      outcomes: Object.fromEntries(m.teams.map((t) => [t, m.outcome(t)])),
      seats,
      ...(m.readyCheck()?.pending ? { readyCheck: true } : {}),
      ...(tokens ? { tokens: { ...m.tokens.teams, spectator: m.tokens.spectator } } : {}),
      /** Operator console deep link to this match (local mode: no credential). */
      devtools: `/playerthree/devtools#sessions/${m.id}`,
    };
  }

  async function createMatch(req: IncomingMessage) {
    const b = record(await readJson(req, BODY_BYTES));
    if (Object.keys(b).some(key => !['mode', 'opponent', 'seed', 'rules', 'speed', 'map', 'armies', 'colours'].includes(key))) throw new HttpError(400, 'bad_request');
    const mode = oneOf(b.mode, MODES, 'bad_mode');
    if (mode !== 'ffa' && (b.map !== undefined || b.armies !== undefined || b.colours !== undefined)) throw new HttpError(400, 'ffa_only');
    const opponent = b.opponent === undefined ? 'standard' : oneOf(b.opponent, OPPONENTS, 'bad_opponent');
    const seed = b.seed === undefined ? undefined : intIn(b.seed, 0, 2 ** 31 - 1, 'bad_seed');
    const requested = requestRules(b.rules);
    const speed = b.speed === undefined ? undefined : intIn(b.speed, 0, MAX_DEV_SPEED, 'bad_speed');
    const { rules, armies } = mode === 'ffa' ? ffaSetup(b, requested) : { rules: requested, armies: undefined };
    const { roomId } = await opts.open({ mode, opponent, ...(seed === undefined ? {} : { seed }), ...(rules ? { rules } : {}), ...(armies ? { armies } : {}) });
    const l = opts.registry.get(roomId);
    if (!l) throw new HttpError(500, 'internal');
    if (speed !== undefined) l.speed = speed;
    return info(roomId, l, true);
  }

  async function setSpeed(req: IncomingMessage, roomId: string) {
    const { live: l } = live(roomId);
    const speed = intIn(record(await readJson(req, BODY_BYTES)).speed, 0, MAX_DEV_SPEED, 'bad_speed');
    if (l.speed === undefined) throw new HttpError(409, 'realtime_match');
    l.speed = speed;
    return { roomId, speed, tick: l.match.tick };
  }

  async function step(req: IncomingMessage, roomId: string) {
    const { live: l, game } = live(roomId);
    const ticks = intIn(record(await readJson(req, BODY_BYTES)).ticks, 1, MAX_DEV_STEP, 'bad_ticks');
    if (l.speed !== 0) throw new HttpError(409, 'not_paused');
    if (game.sim.over) throw new HttpError(409, 'ended');
    const from = l.match.tick;
    await l.match.step(ticks);
    return { roomId, from, tick: l.match.tick, outcomes: Object.fromEntries(l.match.teams.map((t) => [t, l.match.outcome(t)])) };
  }

  async function cheat(req: IncomingMessage, roomId: string) {
    const { game } = live(roomId);
    const sim = game.sim;
    if (sim.over) throw new HttpError(409, 'ended');
    const b = record(await readJson(req, BODY_BYTES));
    const op = oneOf(b.op, ['give', 'spawn', 'reveal', 'damage', 'kill', 'spire'] as const, 'bad_op');
    switch (op) {
      case 'give': {
        const { army, index } = armyOf(sim, b.army);
        const t = sim.armies[index]!;
        const alloy = b.alloy === undefined ? 0 : intIn(b.alloy, -1e6, 1e6, 'bad_alloy');
        const energy = b.energy === undefined ? 0 : intIn(b.energy, -1e6, 1e6, 'bad_energy');
        t.alloy = Math.max(0, t.alloy + alloy);
        t.energy = Math.max(0, t.energy + energy);
        return { op, army, alloy: Math.floor(t.alloy), energy: Math.floor(t.energy) };
      }
      case 'spawn':
        return { op, ...spawn(sim, b) };
      case 'reveal': {
        const { army, index } = armyOf(sim, b.army);
        const seconds = b.seconds === undefined ? undefined : intIn(b.seconds, 1, 3600, 'bad_seconds');
        const until = seconds === undefined ? sim.timeCap : sim.tick + seconds * TICK_RATE;
        const t = sim.armies[index]!;
        // Full scans on a grid persist the reveal through vision refreshes; setting the group's vision bit shows it
        // right away (the bit-planes are shared by every group, so only this group's bit is touched), and a sightings
        // pass names what it now sees (views list only named entities, game sim/aliases.ts).
        for (let y = 2; y < sim.size; y += 4) for (let x = 2; x < sim.size; x += 4) t.scans.push({ x, y, until });
        for (const v of sim.vis) for (let c = 0; c < v.length; c++) v[c]! |= t.group.bit;
        t.group.known.set(sim.cells);
        sim.noteSightings();
        return { op, army, until };
      }
      case 'damage':
      case 'kill': {
        const e = sim.alive(entityId(b.id, 'bad_id'));
        if (!e || e.kind === 'island') throw new HttpError(404, 'entity_not_found');
        const amount = op === 'kill' ? e.hp : numIn(b.amount, 0, 1e6, 'bad_amount');
        sim.damage(e, amount, NEUTRAL);
        return { op, id: `e_${e.id}`, kind: e.kind, side: sim.sideId(e.side), hp: Math.max(0, Math.round(e.hp)), maxHp: e.maxHp, ...(e.hp <= 0 ? { dies: 'next tick' } : {}) };
      }
      case 'spire': {
        const { army, index } = armyOf(sim, b.army);
        const plane = oneOf(b.plane, PLANES, 'bad_plane');
        const seg = sim.armies[index]!.spire[plane];
        if (seg.dead) throw new HttpError(409, 'segment_destroyed');
        seg.hp = intIn(b.hp, 0, seg.maxHp, 'bad_hp');
        return { op, army, plane, hp: seg.hp, maxHp: seg.maxHp, ...(seg.hp === 0 ? { dies: 'next tick' } : {}) };
      }
    }
  }

  async function end(req: IncomingMessage, roomId: string) {
    const { live: l } = live(roomId);
    const b = record(await readJson(req, BODY_BYTES));
    const winner = b.winner === undefined ? undefined : oneOf(b.winner, l.match.teams, 'bad_winner');
    // PlayerThree ends the match now (onEnd, room grace timer) and the sim adopts the result for views and reports.
    const outcomes = l.match.end(winner === undefined ? 'draw' : Object.fromEntries(l.match.teams.map((t): [string, FinalOutcome] => [t, t === winner ? 'win' : 'loss'])));
    return { roomId, tick: l.match.tick, outcomes };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!isLoopback(req.socket.remoteAddress) || PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) {
      return sendJson(res, 403, { error: 'loopback_only' });
    }
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (path === '/dev/matches') {
      if (method === 'GET') return sendJson(res, 200, { matches: [...opts.registry.rooms()].map(([id, l]) => info(id, l, false)) });
      if (method === 'POST') return sendJson(res, 200, await createMatch(req));
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
    }
    const m = /^\/dev\/matches\/([A-Za-z0-9_-]{1,64})(?:\/(speed|step|god|cheat|end))?$/.exec(path);
    if (!m) return sendJson(res, 404, { error: 'not_found' });
    const roomId = m[1]!;
    const op = m[2];
    if (op === undefined || op === 'god') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      if (op === undefined) return sendJson(res, 200, info(roomId, live(roomId).live, true));
      const p = url.searchParams.get('plane');
      const plane = p === null ? undefined : oneOf(p, PLANES, 'bad_plane');
      const detail = oneOf(url.searchParams.get('detail') ?? 'summary', DETAILS, 'bad_detail');
      const { live: l, game } = live(roomId);
      return sendJson(res, 200, { roomId, speed: l.speed ?? 'realtime', ...game.debugView({ ...(plane ? { plane } : {}), detail }) });
    }
    if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (op === 'speed') return sendJson(res, 200, await setSpeed(req, roomId));
    if (op === 'step') return sendJson(res, 200, await step(req, roomId));
    if (op === 'cheat') return sendJson(res, 200, await cheat(req, roomId));
    return sendJson(res, 200, await end(req, roomId));
  }

  return {
    definition: wrapped,
    adopt(match) {
      if (created) games.set(match, created);
      created = undefined;
    },
    handle,
  };
}

/** A cheat's army: an army id of this match and its sim index. */
function armyOf(sim: Sim, value: unknown): { army: ArmyId; index: Army } {
  const army = oneOf(value, sim.armyIds, 'bad_army');
  return { army, index: sim.armyIndex(army) };
}

/**
 * `spawn` cheat: units (any count, free, at x/y on any plane the sim lets them stand on) or a finished structure.
 * Units live on their home plane; surface units can also be in the depths (troopers transfer and breach, every surface
 * unit falls through holes). Structures stay on their home plane.
 */
function spawn(sim: Sim, b: Record<string, unknown>) {
  const { army: id, index: army } = armyOf(sim, b.army);
  const kind = oneOf(b.kind, [...UNIT_KINDS, ...SPAWN_STRUCTURES], 'bad_kind');
  const home = sim.stats[kind].plane;
  const plane = b.plane === undefined ? home : oneOf(b.plane, PLANES, 'bad_plane');
  const unit = isUnitKind(kind);
  if (plane !== home && !(unit && home === 'surface' && plane === 'depths')) throw new HttpError(400, 'wrong_plane');
  const t = sim.armies[army]!;
  if (isIslandStructure(kind)) {
    const isl = sim.alive(entityId(b.island, 'bad_island'));
    if (!isl || isl.kind !== 'island') throw new HttpError(404, 'island_not_found');
    if (isl.side !== army) throw new HttpError(409, 'not_held');
    if (isl.link && sim.alive(isl.link)) throw new HttpError(409, 'occupied');
    const e = finished(sim, army, kind, isl.x, isl.y, 'sky');
    e.link = isl.id;
    isl.link = e.id;
    return { army: id, kind, plane, ...spawned(sim, army, [e]), note: 'completes next tick' };
  }
  const x = numIn(b.x, 0, sim.size, 'bad_x');
  const y = numIn(b.y, 0, sim.size, 'bad_y');
  if (kind === 'shaft' || kind === 'turret') {
    return { army: id, kind, plane, ...spawned(sim, army, [finished(sim, army, kind, x, y, 'surface')]), note: 'completes next tick' };
  }
  if (kind === 'headframe') {
    // On the lode whose outcrop (or pocket) is at x/y; it opens the seal when it completes.
    const lode = sim.lodes[sim.lodeAt[Math.floor(y) * sim.size + Math.floor(x)]!];
    if (!lode) throw new HttpError(409, 'no_lode');
    const e = finished(sim, army, 'headframe', (lode.c % sim.size) + 0.5, Math.floor(lode.c / sim.size) + 0.5, 'surface');
    return { army: id, kind, plane, ...spawned(sim, army, [e]), note: 'completes next tick' };
  }
  if (kind === 'bulkhead') {
    const c = Math.floor(y) * sim.size + Math.floor(x);
    if (sim.cells[c] !== CELL.tunnel || sim.bulkheadAt[c]) throw new HttpError(409, 'not_a_free_tunnel_cell');
    return { army: id, kind, plane, ...spawned(sim, army, [sim.placeBulkhead(army, c)]) };
  }
  if (kind === 'lava_bridge') {
    // Through the sim's placement path (its cell, deck code and collapse back to lake); any lake cell, span unchecked.
    const c = Math.floor(y) * sim.size + Math.floor(x);
    if (sim.cells[c] !== CELL.lake) throw new HttpError(409, 'not_a_lake_cell');
    return { army: id, kind, plane, ...spawned(sim, army, [sim.placeLavaBridge(c, army)]) };
  }
  const count = b.count === undefined ? 1 : intIn(b.count, 1, 50, 'bad_count');
  const ents: Ent[] = [];
  for (let i = 0; i < count; i++) {
    // Sunflower spread so a group does not start stacked.
    const a = i * 2.39996;
    const r = 0.7 * Math.sqrt(i);
    let px = x + Math.cos(a) * r;
    let py = y + Math.sin(a) * r;
    if (plane === 'surface') {
      const open = sim.openSurfaceNear(px, py, 6);
      if (open) ({ x: px, y: py } = open);
    }
    const e: Ent = sim.add(kind as UnitKind, army, plane, px, py);
    t.pop++;
    ents.push(e);
  }
  return { army: id, kind, plane, ...spawned(sim, army, ents) };
}

/**
 * A spawn's entities: `ids` as the spawning army names them (its views and intents: ac_view, ac_act), `names` as every
 * army names them (null: it does not see that one; a sightings pass names what each sees now), `simIds` as ac_god and
 * damage/kill do.
 */
function spawned(sim: Sim, army: Army, ents: readonly Ent[]): { ids: string[]; names: Record<string, (string | null)[]>; simIds: string[] } {
  sim.noteSightings();
  const names: Record<string, (string | null)[]> = {};
  for (const a of sim.allArmies) names[sim.armyIds[a]!] = ents.map((e) => (sim.aliasOf(a, e.id) ? `e_${sim.aliasOf(a, e.id)}` : null));
  return { ids: names[sim.armyIds[army]!]! as string[], names, simIds: ents.map((e) => `e_${e.id}`) };
}

/** A free structure through the normal construction path (sim.build places it; only the queue pays), one tick from done (completion effects run in the sim). */
function finished(sim: Sim, army: Army, kind: 'shaft' | 'turret' | 'headframe' | IslandStructure, x: number, y: number, plane: Plane): Ent {
  const e = sim.build(army, kind, x, y, plane);
  e.hp = e.maxHp;
  e.progress = 1 - 1e-9;
  return e;
}

