/**
 * What a real harness (Claude Code, Codex) receives over MCP: the default result of every knowledge tool must fit the
 * inline limit (Claude Code saves results over 25K tokens / 50K chars to a file the agent may never open; Codex keeps
 * about 10K tokens), so nothing an agent needs is silently spilled. Measured on the actual MCP text content.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectSeat, type RemoteSeat, type ToolOutcome } from '@playerthree/runner';
import { RESULT_TEXT_MAX, TOPIC_TEXT_MAX, briefingTopics, servedSkills, type SkillPage, type TopicPage } from 'playerthree';
import { manifest, PLANES } from '@agent-command/game';
import type { GameServer } from '../src/app.ts';
import { lobbyHandoff, start } from './helpers.ts';

/** The always-loaded layer: core rules, this seat's role section, the topic index. */
const CORE_BRIEFING_MAX = 12_000;

let server: GameServer;
let base: string;
const seats = new Map<string, RemoteSeat>();

/** One MCP call as a harness makes it; this test reads far faster than an LLM turn, so it waits out the call rate limit. */
async function call(role: string, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  for (;;) {
    const out = await seats.get(role)!.call(tool, args);
    if (!out.isError || !out.text.includes('rate_limited')) return out;
    await sleep(200);
  }
}

beforeAll(async () => {
  ({ server, base } = await start({ matchesPerIp: 10 }));
  const ticket = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
  const match = server.host.authenticate(ticket.token)!.match;
  for (const role of PLANES) seats.set(role, await connectSeat({ url: `${base}/mcp`, token: match.mintSeatToken('nw', role) }));
});

afterAll(async () => {
  for (const seat of seats.values()) await seat.close();
  await server.close();
});

describe('agent knowledge over MCP fits the harness inline limit', () => {
  it('serves a small core briefing per seat, with only that seat\'s role section', async () => {
    for (const role of PLANES) {
      const out = await call(role, 'game_briefing', {});
      expect(out.isError, role).toBe(false);
      expect(out.text.length, `${role} core briefing`).toBeLessThanOrEqual(CORE_BRIEFING_MAX);
      for (const other of PLANES) if (other !== role) expect(out.text).not.toContain(JSON.stringify(manifest.roleDocs[other]).slice(1, 80));
    }
  });

  it('serves every page of every topic, and the live match bootstrap, within budget', async () => {
    // In a match `match-data` is the live bootstrap (its own page count), walked by `next` below.
    for (const topic of briefingTopics(manifest).filter((t) => t.name !== 'match-data')) {
      for (let page = 1; page <= topic.pages.length; page++) {
        const out = await call('surface', 'game_briefing', { topic: topic.name, page });
        expect(out.isError, `${topic.name} p${page}: ${out.text}`).toBe(false);
        // The MCP layer sends the TopicPage object as structuredContent.
        const served = out.structured as TopicPage;
        expect(served.text.length, `${topic.name} p${page}`).toBeLessThanOrEqual(TOPIC_TEXT_MAX);
        expect(out.text.length, `${topic.name} p${page}`).toBeLessThanOrEqual(RESULT_TEXT_MAX);
      }
    }
    for (let page: number | undefined = 1; page; ) {
      const out = await call('surface', 'game_briefing', { topic: 'match-data', page });
      expect(out.isError).toBe(false);
      expect(out.text.length).toBeLessThanOrEqual(RESULT_TEXT_MAX);
      const served = out.structured as TopicPage;
      page = served.next?.page;
    }
  }, 120_000);

  it('serves every skill file in default windows', async () => {
    for (const skill of servedSkills(manifest)) {
      for (const path of Object.keys(skill.files)) {
        for (let offset: number | undefined = 0; offset !== undefined; ) {
          const out = await call('depths', 'game_skill', { name: skill.name, path, offset });
          expect(out.isError, `${skill.name}/${path}@${offset}`).toBe(false);
          expect(out.text.length, `${skill.name}/${path}@${offset}`).toBeLessThanOrEqual(RESULT_TEXT_MAX);
          const window = out.structured as SkillPage;
          offset = window.next;
        }
      }
    }
  }, 120_000);

  it('keeps observe, wait and policy status within the limit', async () => {
    for (const role of PLANES) {
      for (const [tool, args] of [['game_observe', {}], ['game_wait', { seconds: 0 }], ['policy_status', {}]] as const) {
        const out = await call(role, tool, args);
        expect(out.text.length, `${role} ${tool}`).toBeLessThanOrEqual(RESULT_TEXT_MAX);
      }
    }
  });
});
