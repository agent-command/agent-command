/** The MCP over real stdio (official v2 client) against an in-process game server with the dev-admin API on. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createGameServer, type GameServer } from '@agent-command/server/src/app.ts';
import { loadConfig } from '@agent-command/server/src/config.ts';
import { CHAT } from '../src/tools.ts';

const TOKEN = 'dev-mcp-test-token-0123456789';
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

let server: GameServer;
let client: Client;

beforeAll(async () => {
  // Dev-admin matches run on the canonical host; booting the default sim worker pool (up to 7 threads) only adds
  // startup time on a loaded machine, and a featured match would add load the tools never read.
  server = createGameServer({ ...loadConfig({}), port: 0, host: '127.0.0.1', devAdminToken: TOKEN, simWorkers: 0, featuredMatch: false });
  const port = await server.listen();
  client = new Client({ name: 'dev-mcp-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [MAIN], env: { ...process.env, AC_URL: `http://127.0.0.1:${port}`, AC_DEV_ADMIN_TOKEN: TOKEN } as Record<string, string> }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const out = res.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  if (res.isError) throw new Error(`${name}: ${out}`);
  return out;
}

describe('agent-command-dev MCP', () => {
  let roomId: string;

  it('lists the dev tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    const expected = ['ac_act', 'ac_cheat', 'ac_controller', 'ac_mandate', 'ac_end', 'ac_god', 'ac_match_create', 'ac_mint', 'ac_screenshot', 'ac_speed', 'ac_status', 'ac_step', 'ac_sweep', 'ac_view'];
    expect(names).toEqual([...expected, ...(CHAT ? ['ac_tell'] : [])].sort());
  });

  it('creates a paused match, steps it and reads views', async () => {
    const created = await call('ac_match_create', { mode: 'bots', opponent: 'novice', seed: 11, rules: { terrain: 'open' }, speed: 0 });
    roomId = /^created (\S+) bots/.exec(created)![1]!;
    expect(created).toContain('paused');
    expect(await call('ac_step', { roomId, ticks: 40 })).toContain('stepped 0 → 40');
    const status = await call('ac_status');
    expect(status).toContain(`${roomId} bots · open seed 11 · nw blue, se red · tick 40`);
    const view = await call('ac_view', { roomId, army: 'nw' });
    expect(view).toMatch(/^nw view · tick \d+/);
    expect(view).toMatch(/surface +own .*trooper/);
    expect(await call('ac_god', { roomId, plane: 'surface' })).toMatch(/god · room \S+ · tick 40 .* paused/);
  });

  it('cheats, acts as an owner and changes seats', async () => {
    const spawned = await call('ac_cheat', { roomId, op: 'spawn', army: 'nw', kind: 'tank', x: 20, y: 20, count: 4 });
    // `ids`: nw's own names (ac_view, ac_act); `simIds`: the sim's, as the unfogged ac_god lists them.
    const { ids, simIds } = JSON.parse(spawned.replace(/^cheat /, '')) as { ids: string[]; simIds: string[] };
    expect(ids).toHaveLength(4);
    const ents = await call('ac_god', { roomId, plane: 'surface', detail: 'entities' });
    for (const id of simIds) expect(ents).toContain(`${id} nw tank`);
    expect(await call('ac_act', { roomId, army: 'nw', role: 'surface', intents: [{ kind: 'move', units: ids, x: 30, y: 30 }, { kind: 'queue_cancel', entry: 'q_999' }] })).toBe(
      'nw surface: #0 ok · #1 invalid_target',
    );
    await call('ac_step', { roomId, ticks: 20 });
    const moved = await call('ac_view', { roomId, army: 'nw', plane: 'surface', detail: 'entities' });
    // Groups keep their formation: each tank heads to its own slot around (30, 30).
    expect(moved).toMatch(new RegExp(`${ids[0]} nw tank @[\\d.,]+ hp 300/300 moving →(29|30|31)`));
    expect(await call('ac_controller', { roomId, army: 'se', role: 'orbit', controller: 'none' })).toBe('se orbit → none');
    expect(await call('ac_mandate', { roomId, army: 'nw', role: 'sky', mandate: { autonomy: 'autonomous', directive: { stance: 'attack', focusX: 40, focusY: 40 }, whenAbsent: 'policy' } })).toContain('"stance":"attack"');
    expect(await call('ac_mint', { roomId, army: 'nw', role: 'depths' })).toMatch(/claude mcp add --transport http agent-command-nw-depths http:\/\/127\.0\.0\.1:\d+\/mcp/);
    expect(await call('ac_status')).toContain('se: depths+surface+sky bot, orbit none');
  });

  it.runIf(CHAT)('tells an army\'s own agents', async () => {
    expect(await call('ac_tell', { roomId, army: 'nw', roles: 'all', text: 'hold the sky', ping: { plane: 'sky', x: 20, y: 20 } })).toBe(
      'told nw all seats; replies show up in ac_view {detail: events}',
    );
    const tooLong = (await client.callTool({ name: 'ac_tell', arguments: { roomId, army: 'nw', roles: 'all', text: 'x'.repeat(501) } })) as CallToolResult;
    expect(tooLong.isError).toBe(true);
  });

  it('speeds up and ends', async () => {
    expect(await call('ac_speed', { roomId, speed: 20 })).toContain('speed 20');
    expect(await call('ac_end', { roomId, winner: 'nw' })).toContain('nw win, se loss');
    const bad = (await client.callTool({ name: 'ac_step', arguments: { roomId: 'nope', ticks: 1 } })) as CallToolResult;
    expect(bad.isError).toBe(true);
  });

  // Two short duel matches on the sweep's worker threads (game load dominates).
  it('sweeps headless bot matches', { timeout: 30_000 }, async () => {
    const out = await call('ac_sweep', { entrants: ['idle', 'standard'], seeds: [1, 2], rotations: 'none', maxTicks: 200, terrain: 'open' });
    expect(out).toContain('2 entrants on open (nw, se; 2 matches)');
    expect(out).toContain('timeouts 2');
    expect(out).toMatch(/seed 1: timeout at t200 · nw A, se B/);
  });

  it('creates a four-army FFA, views and cheats per army, and ends with a winning army', async () => {
    const created = await call('ac_match_create', { mode: 'ffa', seed: 5, speed: 0, colours: ['green', 'blue', 'violet', 'red'] });
    const ffa = /^created (\S+) ffa/.exec(created)![1]!;
    expect(created).toContain('nw green, ne blue, se violet, sw red');
    expect(created).toMatch(/owner tokens \(kept here; use roomId\): nw \S+ · ne \S+ · se \S+ · sw \S+ · spectator \S+/);
    await call('ac_step', { roomId: ffa, ticks: 20 });
    const view = await call('ac_view', { roomId: ffa, army: 'ne' });
    expect(view).toMatch(/^ne view · tick \d+ \(0:0\d\) · running/);
    expect(view).toMatch(/surface +own .*trooper.* \| hostile /);
    expect(JSON.parse((await call('ac_cheat', { roomId: ffa, op: 'give', army: 'sw', alloy: 50 })).replace(/^cheat /, ''))).toMatchObject({ army: 'sw' });
    expect(await call('ac_god', { roomId: ffa })).toMatch(/^sw \(red\) alloy/m);
    expect(await call('ac_end', { roomId: ffa, winner: 'se' })).toContain('nw loss, ne loss, se win, sw loss');
  });
});
