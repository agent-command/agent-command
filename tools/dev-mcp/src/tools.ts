/**
 * The dev MCP tool surface. One `DevMcp` per process keeps the state the tools share: match tokens (never echoed
 * except by ac_match_create/ac_mint), live Colyseus connections (one spectator per match keeps it alive and streams
 * fogged views; owner connections act for an army), and the headless browser for screenshots.
 */
import { fromJsonSchema, McpServer, type CallToolResult, type JsonSchemaType } from '@modelcontextprotocol/server';
import { MSG } from 'playerthree/protocol';
import { CONTROLLERS, type IntentAck, type MandateOf } from 'playerthree';
import { ARMIES, COLOURS, DEFAULT_TERRAIN, manifest, DEFAULT_TIME_CAP_TICKS, MAX_ARMIES, MAX_MAP_SIZE, OPPONENTS, PLANES, STANCES, TERRAIN_PRESETS, UNIT_KINDS, type ArmyId, type Plane, type TerrainPreset } from '@agent-command/game';
import { DevAdminClient, type MatchInfo } from './admin.ts';
import { Screenshots } from './screenshot.ts';
import { clock, eventLine, godEntities, godSummary, viewEntities, viewSummary, type GodView } from './summary.ts';
import { ROTATIONS, sweep, sweepReport, type Rotations, type SweepEntrant } from './sweep.ts';
import { Watch, type Viewer } from './watch.ts';

export const VERSION = '0.1.0';
const DETAILS = ['summary', 'entities', 'events'] as const;
const CHEATS = ['give', 'spawn', 'reveal', 'damage', 'kill', 'spire'] as const;
/** Chat (owner → own agents) exists only when the game manifest enables it. */
export const CHAT = manifest.control.chat !== undefined;

type Tokens = NonNullable<MatchInfo['tokens']>;
interface Tracked {
  roomId: string;
  /** The match's armies in slot order (the default owner view is the first). */
  armies: ArmyId[];
  tokens: Tokens;
  watches: Map<Viewer, Watch>;
}

export interface DevMcpOptions {
  /** Game server, e.g. http://localhost:2567. */
  url: string;
  /** Web client (Vite dev server or the game server itself), e.g. http://localhost:5173. */
  webUrl: string;
  /** AC_DEV_ADMIN_TOKEN; falls back to the token file `pnpm dev` writes. */
  token?: string;
  tokenFile?: string;
  /** Chromium binary for screenshots (default: playwright-core's own install). */
  chrome?: string;
}

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

const roomId = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Room id from ac_match_create / ac_status' } as const;
const army = { type: 'string', enum: ARMIES, description: 'Army id = its map corner (duels: nw vs se; four-army: nw, ne, se, sw)' } as const;
const plane = { type: 'string', enum: PLANES } as const;
/** Tile coordinates: bounded by the largest map; the server checks them against the match's own size. */
const tile = { type: 'number', minimum: 0, maximum: MAX_MAP_SIZE } as const;

function ackLine(a: IntentAck, i: number): string {
  if (a.ok) return `#${i} ok`;
  if (a.code === 'game') return `#${i} ${a.gameCode}`;
  if (a.code === 'invalid') return `#${i} invalid (${a.schemaCode})`;
  return `#${i} ${a.code}`;
}

function seatLine(seats: Record<string, string>): string {
  const by = new Map<string, string[]>();
  for (const [role, c] of Object.entries(seats)) by.set(c, [...(by.get(c) ?? []), role]);
  return [...by].map(([c, roles]) => `${roles.join('+')} ${c}`).join(', ');
}

function matchLine(m: MatchInfo): string {
  const outcome = Object.values(m.outcomes).every((o) => o === 'running') ? 'running' : Object.entries(m.outcomes).map(([t, o]) => `${t} ${o}`).join(', ');
  const speed = m.speed === null ? 'realtime' : m.speed === 0 ? 'paused' : `speed ${m.speed}`;
  const seats = Object.entries(m.seats).map(([t, s]) => `${t}: ${seatLine(s)}`).join(' · ');
  const world = m.terrain ? ` · ${m.terrain} seed ${m.seed}` : '';
  const armies = m.armies.map((a) => `${a.id} ${a.colour}`).join(', ');
  return `${m.roomId} ${m.mode}${world} · ${armies} · tick ${m.tick} (${clock(m.tick)}) · ${speed} · ${outcome}${m.readyCheck ? ' · ready check' : ''}\n  ${seats}`;
}

export class DevMcp {
  readonly admin: DevAdminClient;
  readonly shots: Screenshots;
  readonly url: string;
  readonly #matches = new Map<string, Tracked>();

  constructor(opts: DevMcpOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.admin = new DevAdminClient(this.url, opts.token, opts.tokenFile);
    this.shots = new Screenshots(opts.webUrl, opts.chrome);
  }

  async #tracked(id: string): Promise<Tracked> {
    let t = this.#matches.get(id);
    if (!t) {
      const info = await this.admin.match(id);
      t = { roomId: id, armies: info.armies.map((a) => a.id), tokens: info.tokens!, watches: new Map() };
      this.#matches.set(id, t);
    }
    return t;
  }

  /** A live connection for `viewer` (opened on first use, reopened if it dropped). */
  async #watch(id: string, viewer: Viewer): Promise<Watch> {
    const t = await this.#tracked(id);
    const token = t.tokens[viewer];
    if (!token) throw new Error(`${viewer} is not an army of ${id} (armies: ${t.armies.join(', ')})`);
    let w = t.watches.get(viewer);
    if (!w?.alive) {
      w = await Watch.open(this.url, id, token, viewer);
      t.watches.set(viewer, w);
    }
    return w;
  }

  async #owner(id: string, army: ArmyId, type: string, body: Record<string, unknown>): Promise<unknown> {
    return (await this.#watch(id, army)).request(type, body);
  }

  async status(): Promise<string> {
    const h = await this.admin.health();
    const { matches } = await this.admin.matches();
    const lines = [`server ${this.admin.url} ok · ${h.matches}/${h.maxMatches} matches`];
    for (const m of matches) lines.push(matchLine(m));
    if (!matches.length) lines.push('no live matches (ac_match_create)');
    return lines.join('\n');
  }

  async create(args: { mode: string; opponent?: string; seed?: number; rules?: Record<string, unknown>; speed?: number; map?: string; armies?: number; colours?: string[] }): Promise<string> {
    const info = await this.admin.request<MatchInfo>('POST', '/dev/matches', args);
    const t: Tracked = { roomId: info.roomId, armies: info.armies.map((a) => a.id), tokens: info.tokens!, watches: new Map() };
    this.#matches.set(info.roomId, t);
    // A spectator connection keeps the room alive (idle rooms close) and streams every army's fogged view.
    await this.#watch(info.roomId, 'spectator');
    return [
      `created ${matchLine(info)}`,
      `owner tokens (kept here; use roomId): ${Object.entries(info.tokens!).map(([viewer, token]) => `${viewer} ${token}`).join(' · ')}`,
      `next: ac_speed / ac_step, ac_view {army}, ac_god, ac_screenshot`,
    ].join('\n');
  }

  async view(args: { roomId: string; army: ArmyId; plane?: Plane; detail?: (typeof DETAILS)[number] }): Promise<string> {
    // The spectator connection lives as long as the match is tracked, so its event log is the longest; it receives
    // exactly the fogged view the army's owner gets. Owner connections (opened by ac_act & co.) carry chat replies.
    const w = await this.#watch(args.roomId, 'spectator');
    const owner = (await this.#tracked(args.roomId)).watches.get(args.army);
    const v = await w.view(args.army);
    if (!v) return `no view of ${args.army} yet (connection ${w.alive ? 'open' : 'closed'})`;
    const events = w.events.get(args.army) ?? [];
    const detail = args.detail ?? 'summary';
    if (detail === 'entities') return `${v.army} view · tick ${v.tick} · visible entities (id side kind @x,y hp state …)\n${viewEntities(v, w.matchData.get(args.army), args.plane)}`;
    if (detail === 'events') {
      const evs = events.filter((e) => !args.plane || e.plane === args.plane);
      const lines = [`${v.army} view · tick ${v.tick} · ${evs.length} events since this tool started watching`, ...evs.map(eventLine)];
      const said = owner?.said ?? [];
      if (said.length) lines.push('agent replies:', ...said.map((s) => `t${s.tick} ${s.role}: ${s.text}`));
      return lines.join('\n');
    }
    return `${viewSummary(v, w.matchData.get(args.army), events, args.plane)}\n(fogged ${v.army} view via a live spectator connection; it refreshes while the match runs or steps)`;
  }

  async god(args: { roomId: string; plane?: Plane; detail?: (typeof DETAILS)[number] }): Promise<string> {
    const q = new URLSearchParams({ detail: args.detail ?? 'summary', ...(args.plane ? { plane: args.plane } : {}) });
    const g = await this.admin.request<GodView>('GET', `/dev/matches/${args.roomId}/god?${q}`);
    const out = [godSummary(g, args.plane)];
    if (g.entities) out.push(`entities (${g.entities.length}):`, godEntities(g.entities));
    if (g.events) for (const [id, evs] of Object.entries(g.events)) out.push(`${id} events (${evs.length}):`, ...evs.map((e) => `  ${eventLine(e)}`));
    return out.join('\n');
  }

  async act(args: { roomId: string; army: ArmyId; role: Plane; intents: Record<string, unknown>[] }): Promise<string> {
    const data = await this.#owner(args.roomId, args.army, MSG.call, { op: 'call', role: args.role, method: 'act', args: { intents: args.intents } });
    const acks = Array.isArray(data) ? (data as IntentAck[]) : [];
    return `${args.army} ${args.role}: ${acks.map(ackLine).join(' · ') || 'no acks'}`;
  }

  async controller(args: { roomId: string; army: ArmyId; role: Plane; controller: string }): Promise<string> {
    await this.#owner(args.roomId, args.army, MSG.controller, { op: 'controller', role: args.role, controller: args.controller });
    return `${args.army} ${args.role} → ${args.controller}`;
  }

  async mandate(args: { roomId: string; army: ArmyId; role: Plane; mandate: MandateOf<typeof manifest> }): Promise<string> {
    const { roomId: id, army, role, mandate } = args;
    await this.#owner(id, army, MSG.mandate, { op: 'mandate', role, mandate });
    return `${army} ${role} mandate ${JSON.stringify(mandate)}`;
  }

  async mint(args: { roomId: string; army: ArmyId; role: Plane }): Promise<string> {
    const data = (await this.#owner(args.roomId, args.army, MSG.mint, { op: 'mint', role: args.role })) as { token?: unknown } | string;
    const token = typeof data === 'string' ? data : data?.token;
    if (typeof token !== 'string') throw new Error('bad mint response');
    const name = `agent-command-${args.army}-${args.role}`;
    const mcpUrl = `${this.url}/mcp`;
    const config = { mcpServers: { [name]: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } };
    return [
      `seat token for ${args.army} ${args.role} (this match only): ${token}`,
      `claude mcp add --transport http ${name} ${mcpUrl} --header "Authorization: Bearer ${token}"`,
      `mcp.json: ${JSON.stringify(config)}`,
    ].join('\n');
  }

  async tell(args: { roomId: string; army: ArmyId; roles: Plane[] | 'all'; text: string; ping?: { plane: Plane; x: number; y: number } }): Promise<string> {
    const { roomId: id, army, ...body } = args;
    await this.#owner(id, army, MSG.tell, { op: 'tell', ...body });
    return `told ${army} ${args.roles === 'all' ? 'all seats' : args.roles.join('+')}; replies show up in ac_view {detail: events}`;
  }

  async speed(args: { roomId: string; speed: number }): Promise<string> {
    const r = await this.admin.request<{ speed: number; tick: number }>('POST', `/dev/matches/${args.roomId}/speed`, { speed: args.speed });
    return `${args.roomId} ${r.speed === 0 ? 'paused' : `speed ${r.speed} (${r.speed}× real time)`} at tick ${r.tick}`;
  }

  async step(args: { roomId: string; ticks: number }): Promise<string> {
    const r = await this.admin.request<{ from: number; tick: number; outcomes: Record<string, string> }>('POST', `/dev/matches/${args.roomId}/step`, { ticks: args.ticks });
    return `${args.roomId} stepped ${r.from} → ${r.tick} (${clock(r.tick)}) · ${Object.entries(r.outcomes).map(([t, o]) => `${t} ${o}`).join(', ')}`;
  }

  async cheat(args: { roomId: string } & Record<string, unknown>): Promise<string> {
    const { roomId: id, ...body } = args;
    return `cheat ${JSON.stringify(await this.admin.request('POST', `/dev/matches/${id}/cheat`, body))}`;
  }

  /** `winner`: the winning army (every other army loses); absent: a draw. */
  async end(args: { roomId: string; winner?: ArmyId | 'draw' }): Promise<string> {
    const winner = args.winner === 'draw' ? undefined : args.winner;
    const r = await this.admin.request<{ tick: number; outcomes: Record<string, string> }>('POST', `/dev/matches/${args.roomId}/end`, winner ? { winner } : {});
    return `${args.roomId} ended at tick ${r.tick}: ${Object.entries(r.outcomes).map(([t, o]) => `${t} ${o}`).join(', ')}`;
  }

  async screenshot(args: { roomId: string; army?: ArmyId; spectator?: boolean; plane: Plane; x?: number; y?: number; zoom?: number; width?: number; height?: number; waitMs?: number; hud?: boolean }): Promise<CallToolResult> {
    const t = await this.#tracked(args.roomId);
    const viewer: Viewer = args.spectator ? 'spectator' : (args.army ?? t.armies[0]!);
    const token = t.tokens[viewer];
    if (!token) throw new Error(`${viewer} is not an army of ${args.roomId} (armies: ${t.armies.join(', ')})`);
    const shot = await this.shots.shoot({
      roomId: args.roomId,
      token,
      viewer,
      ...(args.army ? { army: args.army } : {}),
      plane: args.plane,
      ...(args.x !== undefined ? { x: args.x } : {}),
      ...(args.y !== undefined ? { y: args.y } : {}),
      ...(args.zoom !== undefined ? { zoom: args.zoom } : {}),
      width: args.width ?? 1280,
      height: args.height ?? 720,
      waitMs: args.waitMs ?? 1500,
      hud: args.hud ?? true,
    });
    return {
      content: [
        { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `${args.roomId} ${args.plane} as ${viewer === 'spectator' ? `spectator (${shot.army} view)` : `${viewer} owner`} · tick ${shot.tick}` },
      ],
    };
  }

  async sweep(args: { entrants: SweepEntrant[]; seeds: number | number[]; rotations?: Rotations; maxTicks?: number; terrain?: TerrainPreset; map?: string; rules?: Record<string, unknown> }): Promise<string> {
    const seeds = typeof args.seeds === 'number' ? Array.from({ length: args.seeds }, (_, i) => i + 1) : args.seeds;
    const t0 = performance.now();
    const stats = await sweep({ ...args, seeds, maxTicks: args.maxTicks ?? DEFAULT_TIME_CAP_TICKS });
    return `${sweepReport(stats)}\n(${stats.runs.length} matches in ${((performance.now() - t0) / 1000).toFixed(1)}s)`;
  }

  async close(): Promise<void> {
    for (const t of this.#matches.values()) for (const w of t.watches.values()) w.close();
    this.#matches.clear();
    await this.shots.close();
  }

  /** A fresh McpServer exposing the tools (one per stdio connection). */
  server(): McpServer {
    const mcp = new McpServer(
      { name: 'agent-command-dev', version: VERSION },
      {
        instructions:
          'Dev tools for Agent Command (local only). Create a duel or a four-army free-for-all (ac_match_create), control time (ac_speed, ac_step), read fogged army views (ac_view) or the unfogged truth (ac_god), act as any seat (ac_act, ac_controller, ac_mandate, ac_mint), cheat (ac_cheat), screenshot the real web client (ac_screenshot) and run headless bot sweeps (ac_sweep). Refer to matches by roomId and armies by corner id (nw, ne, se, sw).',
      },
    );
    const tool = <A>(name: string, description: string, properties: Record<string, JsonSchemaType>, required: string[], run: (a: A) => Promise<string | CallToolResult>) => {
      mcp.registerTool(name, { description, inputSchema: fromJsonSchema<A>({ type: 'object', properties, required, additionalProperties: false }) }, async (a: A) => {
        try {
          const out = await run(a);
          return typeof out === 'string' ? text(out) : out;
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      });
    };

    tool('ac_status', 'Server health and every live match: room id, mode, armies, tick, speed, outcomes, seat controllers.', {}, [], () => this.status());
    tool<Parameters<DevMcp['create']>[0]>(
      'ac_match_create',
      'Create a match. Duels are nw (blue) vs se (red). bots: you are nw (surface human, other planes bots) vs se bots at `opponent`; pvp: both armies human on surface; agents: every seat a bot. ffa: you are the first army vs bots at `opponent` on a four-slot map (`map`, default four_corners; a generated recipe id plays its C4 layout), `armies` 2–4 (default every slot) with distinct `colours`. Returns roomId (tokens are kept here, one per army). Speed 0 starts paused at tick 0.',
      {
        mode: { type: 'string', enum: ['bots', 'pvp', 'agents', 'ffa'] },
        opponent: { type: 'string', enum: OPPONENTS, description: 'bot level of the other armies (default standard)' },
        seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
        rules: { type: 'object', description: 'Canonical matchOptions: terrain, map:{seed,params}|{name}|{document}, economy, depths, surface, sky, orbit, spire, stats. Validated by the server.' },
        speed: { type: 'integer', minimum: 0, maximum: 50, description: 'game ticks per real tick; 0 = paused (default 1)' },
        map: { type: 'string', description: 'ffa: registry map id with an ffa layout (default four_corners)' },
        armies: { type: 'integer', minimum: 2, maximum: MAX_ARMIES, description: 'ffa: number of armies (default every slot; two take the nw/se diagonal)' },
        colours: { type: 'array', items: { type: 'string', enum: COLOURS }, minItems: 2, maxItems: MAX_ARMIES, uniqueItems: true, description: 'ffa: one distinct colour per army in slot order (default blue, red, green, violet)' },
      },
      ['mode'],
      (a) => this.create(a),
    );
    tool<Parameters<DevMcp['view']>[0]>(
      'ac_view',
      "An army's fogged view through a live Colyseus connection (what that player sees). summary: tick, outcome, rank, eliminated armies, resources, Spire HP, per-plane own/hostile counts by kind, fights (fx counts), queues, recent events. entities: every visible entity with ids (the army's own names: its creation and first-sight order, the ids ac_act takes; not ac_god's). events: the event log this connection collected (+ agent chat replies).",
      { roomId, army, plane, detail: { type: 'string', enum: DETAILS } },
      ['roomId', 'army'],
      (a) => this.view(a),
    );
    tool<Parameters<DevMcp['god']>[0]>(
      'ac_god',
      "Unfogged truth straight from the sim: every army's colour, resources, Spire, units/structures per plane and stats, ranks once final, fights, projectiles. detail entities = full entity dump (filter with plane!; sim ids, as damage/kill take them, not an army's names), events = every army's recent events.",
      { roomId, plane, detail: { type: 'string', enum: DETAILS } },
      ['roomId'],
      (a) => this.god(a),
    );
    tool<Parameters<DevMcp['act']>[0]>(
      'ac_act',
      'Submit intents for a seat as its army owner (same path as the web client). Intents are the game\'s act intents, e.g. {"kind":"move","units":["e_12"],"x":30,"y":30} or {"kind":"queue_add","item":"tank"}; see the game briefing. Entity ids are the army\'s own names (ac_view, a spawn\'s `ids`). Returns one ack per intent.',
      { roomId, army, role: plane, intents: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object' } } },
      ['roomId', 'army', 'role', 'intents'],
      (a) => this.act(a),
    );
    tool<Parameters<DevMcp['controller']>[0]>(
      'ac_controller',
      'Set who plays a seat: human (nobody but you via ac_act), agent, policy, bot, none.',
      { roomId, army, role: plane, controller: { type: 'string', enum: CONTROLLERS } },
      ['roomId', 'army', 'role', 'controller'],
      (a) => this.controller(a),
    );
    tool<Parameters<DevMcp['mandate']>[0]>(
      'ac_mandate',
      "Set a seat's complete mandate: autonomy, directive priorities, absence behavior and optional house rules.",
      {
        roomId, army, role: plane,
        mandate: {
          type: 'object', additionalProperties: false, required: ['autonomy', 'directive', 'whenAbsent'],
          properties: {
            autonomy: { type: 'string', enum: ['autonomous', 'supervised'] },
            whenAbsent: { type: 'string', enum: ['policy', 'bot', 'hold'] },
            directive: {
              type: 'object', additionalProperties: false, required: ['stance'],
              properties: { stance: { type: 'string', enum: STANCES }, focusX: tile, focusY: tile },
            },
            limits: { type: 'object', additionalProperties: false, properties: { asteroidDrops: { type: 'boolean' }, collapses: { type: 'boolean' } } },
          },
        },
      },
      ['roomId', 'army', 'role', 'mandate'],
      (a) => this.mandate(a),
    );
    tool<Parameters<DevMcp['mint']>[0]>(
      'ac_mint',
      'Mint a seat token for an agent (one seat, this match) and return the MCP config to connect it.',
      { roomId, army, role: plane },
      ['roomId', 'army', 'role'],
      (a) => this.mint(a),
    );
    if (CHAT) {
      tool<Parameters<DevMcp['tell']>[0]>(
        'ac_tell',
        "Owner chat: message an army's own agents (roles or all), optionally pointing at a map spot. Replies appear in ac_view {detail: events}.",
        {
          roomId,
          army,
          roles: { oneOf: [{ type: 'string', const: 'all' }, { type: 'array', items: plane, minItems: 1, maxItems: 4 }] },
          text: { type: 'string', minLength: 1, maxLength: 500 },
          ping: { type: 'object', properties: { plane, x: tile, y: tile }, required: ['plane', 'x', 'y'], additionalProperties: false },
        },
        ['roomId', 'army', 'roles', 'text'],
        (a) => this.tell(a),
      );
    }
    tool<Parameters<DevMcp['speed']>[0]>(
      'ac_speed',
      'Sim speed: game ticks per real tick (1 = real time, 20 = 20×), 0 pauses.',
      { roomId, speed: { type: 'integer', minimum: 0, maximum: 50 } },
      ['roomId', 'speed'],
      (a) => this.speed(a),
    );
    tool<Parameters<DevMcp['step']>[0]>(
      'ac_step',
      'Advance a paused match by N ticks (20 ticks = 1 game second; bots and policies think as usual).',
      { roomId, ticks: { type: 'integer', minimum: 1, maximum: 12000 } },
      ['roomId', 'ticks'],
      (a) => this.step(a),
    );
    tool<{ roomId: string } & Record<string, unknown>>(
      'ac_cheat',
      'Testing cheats on the live sim. give {army, alloy?, energy?} · spawn {army, kind, x, y, count?, plane?} units free at x/y on their own plane (surface units also plane: depths; shaft/turret: finished next tick, anywhere (skips the build radius); headframe: on the lode at x/y, finished next tick; bulkhead: on the tunnel cell at x/y, at once; lava_bridge: on the lava-lake cell at x/y, at once; relay: {island} held by the army) · reveal {army, seconds?} full vision · damage {id, amount} · kill {id} · spire {army, plane, hp}. Ids are e_<n>: damage/kill take sim ids (ac_god); spawn returns `ids` (the army\'s own names, for ac_act), `names` (every army\'s name for each, null while unseen) and `simIds`; islands are named alike everywhere. Deaths apply on the next tick.',
      {
        roomId,
        op: { type: 'string', enum: CHEATS },
        army,
        alloy: { type: 'integer' },
        energy: { type: 'integer' },
        kind: { type: 'string', enum: [...UNIT_KINDS, 'shaft', 'turret', 'relay', 'headframe', 'bulkhead', 'lava_bridge'] },
        plane,
        x: tile,
        y: tile,
        count: { type: 'integer', minimum: 1, maximum: 50 },
        island: { type: 'string', pattern: '^e_\\d+$' },
        seconds: { type: 'integer', minimum: 1, maximum: 3600 },
        id: { type: 'string', pattern: '^e_\\d+$' },
        amount: { type: 'number', minimum: 0 },
        hp: { type: 'integer', minimum: 0 },
      },
      ['roomId', 'op'],
      (a) => this.cheat(a),
    );
    tool<Parameters<DevMcp['end']>[0]>(
      'ac_end',
      'End a match now: a winning army (every other army loses) or draw (the default).',
      { roomId, winner: { type: 'string', enum: [...ARMIES, 'draw'] } },
      ['roomId'],
      (a) => this.end(a),
    );
    tool<Parameters<DevMcp['screenshot']>[0]>(
      'ac_screenshot',
      "PNG of the real web client joined to the match (headless Chromium, WebGL2; persistent page per match/viewer). As an army's owner (default the first army) or spectator: true (army picks whose fogged view). Focus a plane, optionally centre on tile x/y and zoom (1 = default, 2 = closer, 0.5 = wider). hud false hides the HUD.",
      {
        roomId,
        army,
        spectator: { type: 'boolean' },
        plane,
        x: tile,
        y: tile,
        zoom: { type: 'number', minimum: 0.3, maximum: 3 },
        width: { type: 'integer', minimum: 320, maximum: 2560 },
        height: { type: 'integer', minimum: 240, maximum: 1600 },
        waitMs: { type: 'integer', minimum: 0, maximum: 20000, description: 'settle time before the shot (default 1500)' },
        hud: { type: 'boolean' },
      },
      ['roomId', 'plane'],
      (a) => this.screenshot(a),
    );
    tool<Parameters<DevMcp['sweep']>[0]>(
      'ac_sweep',
      'Headless bot balance sweep in this process (no server): 2–4 entrants (built-in bot levels, one army each, every seat a bot) over seeds × slot rotations (cyclic: each entrant plays each slot once per seed; full: every order; none: entrant k on slot k). Two entrants play a duel; more play the four-slot FFA (`map` default: the terrain\'s generated C4 recipe). Reports per-entrant wins, rank distributions and mean placement, per-slot win rates, draws, timeouts, median ticks and per-match results. Full matches take seconds to minutes each; they run in parallel worker threads.',
      {
        entrants: { type: 'array', items: { type: 'string', enum: OPPONENTS }, minItems: 2, maxItems: MAX_ARMIES },
        seeds: { oneOf: [{ type: 'integer', minimum: 1, maximum: 64, description: 'seeds 1..n' }, { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 64 }] },
        rotations: { type: 'string', enum: ROTATIONS, description: 'slot permutations per seed (default cyclic)' },
        maxTicks: { type: 'integer', minimum: 1, maximum: DEFAULT_TIME_CAP_TICKS, description: `default ${DEFAULT_TIME_CAP_TICKS} (the 30 min cap)` },
        terrain: { type: 'string', enum: TERRAIN_PRESETS, description: `surface terrain preset of generated maps (default ${DEFAULT_TERRAIN})` },
        map: { type: 'string', description: 'registry map id (authored, or a generated recipe) with a duel (2 entrants) or ffa layout' },
        rules: { type: 'object', description: 'Extra canonical matchOptions merged into every match (e.g. spire.timeCap).' },
      },
      ['entrants', 'seeds'],
      (a) => this.sweep(a),
    );
    return mcp;
  }
}
