/**
 * Fog safety on the wire: a real lobby match on the real server (lobby room, Colyseus room binding, MCP), every message
 * the nw player and its agent receive scanned against the simulation's truth at that tick, plus the observer delay.
 * The truth is taken right after each simulation step, before the host builds that tick's views.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyView, type ViewState } from 'playerthree';
import { connectSeat } from '@playerthree/runner';
import { definition, type AgentCommandGame } from '@agent-command/game';
import type { GameServer } from '../src/app.ts';
import type { GameMatch } from '../src/room.ts';
import { lobbyAttach, lobbyEnter, start, type LobbyCreate } from './helpers.ts';

const DELAY_MS = 2000;
/** Army indices of the duel's nw and se armies (slot order). */
const NW = 0;
const SE = 1;

/**
 * nw names entities its own way (game sim/aliases.ts): per tick, how many names it had given and the se entities it
 * sees under their names at their true positions; which se entities ever lived and which nw ever saw (sim ids).
 */
const named = new Map<number, number>();
const visible = new Map<number, Map<string, { x: number; y: number }>>();
const tickAt = new Map<number, number>();
const seEver = new Set<number>();
const seSeen = new Set<number>();
const games: AgentCommandGame[] = [];

function record(game: AgentCommandGame): void {
  const sim = game.sim;
  tickAt.set(sim.tick, Date.now());
  const seen = new Map<string, { x: number; y: number }>();
  for (const e of sim.ents) {
    if (e.dead || e.side !== SE) continue;
    seEver.add(e.id);
    if (!sim.sees(NW, e)) continue;
    seSeen.add(e.id);
    seen.set(`e_${sim.aliasOf(NW, e.id)}`, { x: e.x, y: e.y });
  }
  visible.set(sim.tick, seen);
  named.set(sim.tick, sim.armies[NW]!.aliases.count);
}

const create = definition.create.bind(definition);
vi.spyOn(definition, 'create').mockImplementation((options) => {
  const game = create(options) as AgentCommandGame;
  const step = game.step.bind(game);
  game.step = () => { step(); record(game); };
  record(game);
  games.push(game);
  return game;
});

let server: GameServer;
let base: string;
beforeAll(async () => { ({ server, base } = await start({ lobbyCountdownMs: 500 })); });
afterAll(async () => { await server.close(); vi.restoreAllMocks(); });

/** Every `e_<n>` string anywhere in a value. */
function ids(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') { if (/^e_\d+$/.test(value)) out.push(value); }
  else if (Array.isArray(value)) for (const v of value) ids(v, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { ids(k, out); ids(v, out); }
  return out;
}

/**
 * Ids in `value` nw had not given by `tick` (its own entities are named as they are made, so up to the next tick's
 * count): an id that is no name of nw's can only come from somewhere else (a sim id, another army's name).
 */
const leaked = (value: unknown, tick: number): string[] =>
  ids(value).filter((id) => Number(id.slice(2)) > (named.get(tick + 1) ?? named.get(tick) ?? Infinity));

describe('what team nw receives', () => {
  it('names only se entities nw has seen, at their true visible positions, and never the secret seed', async () => {
    const body = { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true, observerPolicy: { minDelayMs: DELAY_MS } };
    const attached = await lobbyAttach(base, body as LobbyCreate);
    const lobbyInbox = attached.snapshots;
    const handoff = await lobbyEnter(base, attached);
    expect(games).toHaveLength(1);
    const game = games[0]!;
    const match = server.host.authenticate(handoff.token)!.match as GameMatch;
    const agent = await connectSeat({ url: `${base}/mcp`, token: match.mintSeatToken('nw', 'surface') });
    const observations: unknown[] = [];
    try {
      // Real play time is the point here (bots act on the live room clock): a few seconds while nw's fog hides se.
      for (let i = 0; i < 4; i++) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 1200);
        await promise;
        const out = await agent.call('game_observe', {});
        expect(out.isError, out.text).toBe(false);
        observations.push(out.structured);
      }
    } finally { await agent.close(); }
    expect(game.sim.tick).toBeGreaterThan(60);
    // The fixture must actually hide se: most se entities stay unseen by nw.
    expect([...seEver].filter((id) => !seSeen.has(id)).length).toBeGreaterThan(5);

    let views = 0;
    for (const conn of handoff.connections) {
      // Views arrive as a keyframe then structural deltas: scan each wire message as sent, and check every decoded
      // view (the state the client actually holds) against the truth at its tick.
      const states = new Map<string, ViewState>();
      for (const { msg } of conn.inbox) {
        expect(msg.op).not.toBe('observer');
        let view: { tick?: number; entities?: { id: string; side: string; x: number; y: number }[] } | undefined;
        if (msg.op === 'view') {
          const next = applyView(states.get(msg.team), msg);
          expect(next, `view stream gap for ${msg.team}`).toBeDefined();
          states.set(msg.team, next!);
          view = next!.view as typeof view;
        }
        const tick = typeof view?.tick === 'number' ? view.tick : game.sim.tick;
        expect(leaked(msg, tick), `${msg.op} @${tick}`).toEqual([]);
        if (!view?.entities) continue;
        views++;
        expect(leaked(view, tick), `view @${tick}`).toEqual([]);
        const truth = visible.get(tick)!;
        for (const e of view.entities.filter((entity) => entity.side === 'se')) {
          const at = truth.get(e.id);
          expect(at, `${e.id} @${tick}`).toBeDefined();
          expect(e.x).toBeCloseTo(at!.x, 1);
          expect(e.y).toBeCloseTo(at!.y, 1);
        }
      }
    }
    expect(views).toBeGreaterThan(5);
    for (const obs of observations) expect(leaked(obs, (obs as { tick?: number }).tick ?? game.sim.tick)).toEqual([]);
    expect(observations.length).toBeGreaterThan(0);
    expect(lobbyInbox.length).toBeGreaterThan(0);
    for (const msg of lobbyInbox) expect(leaked(msg, game.sim.tick)).toEqual([]);
    // The secret match seed (and any event seed) never leaves the server during play.
    const everything = JSON.stringify([handoff.connections.map((c) => c.inbox), observations, lobbyInbox]);
    expect(everything).not.toContain(String(game.sim.seed));
    expect(everything).not.toContain('eventSeed');
    expect(game.sim.seed).toBeGreaterThan(2 ** 32);
  }, 60_000);

  it('an observer of the live match only ever gets frames at least the delay old, and cannot lower it', async () => {
    const game = games[0]!;
    const match = [...server.host.matches()].find((m) => m.tick > 0) as GameMatch;
    expect(match).toBeDefined();
    // Lowering the configured delay is refused by the host itself, whoever asks.
    expect(() => match.mintObserverToken({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: 0 }, { owner: 'fog-wire-probe' })).toThrow();
    expect(() => match.mintObserverToken({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: DELAY_MS - 1 }, { owner: 'fog-wire-probe' })).toThrow();
    expect(() => match.observerFrames({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: 0 })).toThrow();
    const received: { at: number; frame: { tick: number; recordedAt: number; releaseAt: number } }[] = [];
    // Through the host's trusted pull, which the room binding and featured relay share.
    const frames = match.observerFrames({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: DELAY_MS });
    const started = Date.now();
    for await (const frame of frames) {
      received.push({ at: Date.now(), frame });
      if (Date.now() - started > DELAY_MS + 1500) break;
    }
    expect(received.length).toBeGreaterThan(0);
    for (const { at, frame } of received) {
      expect(frame.releaseAt - frame.recordedAt).toBeGreaterThanOrEqual(DELAY_MS);
      expect(frame.releaseAt).toBeLessThanOrEqual(at);
      // The simulation reached this frame's tick no later than `delay` before it was delivered.
      expect(tickAt.get(frame.tick)!).toBeLessThanOrEqual(at - DELAY_MS);
    }
    expect(game.sim.tick).toBeGreaterThan(Math.max(...received.map((r) => r.frame.tick)));
  }, 30_000);
});
