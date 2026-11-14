/**
 * N replicas behind a non-sticky balancer (scripts/cluster-rig.ts): three server processes, one Redis, Postgres and a
 * round-robin proxy. Runs only with `AC_TEST_REDIS_URL` (a disposable Redis: the rig flushes it) and, for the
 * production store path, `AC_TEST_DATABASE_URL` (a disposable database) or `PG_BIN` (a directory with initdb and
 * postgres, for a throwaway cluster); without either the nodes use in-memory stores. Nodes run under
 * `taskset -c 2,3` unless RIG_CPUS says otherwise. Run before every deploy that touches the server:
 *
 *   AC_TEST_REDIS_URL=redis://127.0.0.1:6379 PG_BIN=~/.local/pgsql/bin \
 *     pnpm --filter @agent-command/server exec vitest run test/cluster-rig.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Rig, scenarioAgent, scenarioFeatured, scenarioFeaturedPublic, scenarioLimits, scenarioLoad, scenarioLobby, scenarioPrimaryCrash, scenarioRolling } from '../scripts/cluster-rig.ts';

const REDIS_URL = process.env.AC_TEST_REDIS_URL;
const DATABASE_URL = process.env.AC_TEST_DATABASE_URL;
const PG_BIN = process.env.PG_BIN;

describe.skipIf(!REDIS_URL)('cluster mode: three nodes behind a non-sticky balancer', () => {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await Rig.start({
      nodes: 3, dir: mkdtempSync(join(tmpdir(), 'ac-cluster-rig-')), redisUrl: REDIS_URL!,
      ...(DATABASE_URL ? { databaseUrl: DATABASE_URL } : PG_BIN ? { pgBin: PG_BIN } : { memory: true }),
      ...(process.env.RIG_CPUS !== undefined ? { cpus: process.env.RIG_CPUS } : {}),
    });
  }, 180_000);

  afterAll(async () => { await rig?.close(); }, 60_000);

  it('(g) holds the per-IP and capacity limits across nodes', async () => {
    const result = await scenarioLimits(rig!);
    expect(result.lobbyCreates.at(-1)).toBe(429);
    expect(result.admission).toMatchObject({ queuePosition: 1, overbookedWorkers: 0 });
    expect(result.featuredViewers.at(-1)).toBe(429);
    expect(result.ok).toBe(true);
  }, 240_000);

  it('(a) creates, joins and starts a lobby with every request and socket on a different node', async () => {
    const result = await scenarioLobby(rig!);
    expect(result).toMatchObject({ ok: true, sameMatch: true, listedInDirectory: true });
    expect(Object.values(result.requestsPerNode).filter((count) => count > 0)).toHaveLength(3);
  }, 120_000);

  it('(b) an MCP agent signs in with OAuth, deploys a policy and plays, its requests spread over every node', async () => {
    const result = await scenarioAgent(rig!);
    expect(result).toMatchObject({ ok: true, deployedVersion: 1, matchPhase: 'match' });
    expect(result.intentsAcknowledged).toBeGreaterThan(0);
    expect(Object.values(result.mcpPostsPerNode).filter((count) => count > 0).length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('(c) streams Watch live through every node and the balancer', async () => {
    const result = await scenarioFeatured(rig!);
    expect(result.ok).toBe(true);
    expect(result.streams).toHaveLength(4);
  }, 120_000);

  it('(f) carries a small player load run through the balancer', async () => {
    const result = await scenarioLoad(rig!, ['--players', '--levels', '2', '--duration', '20', '--ramp', '4', '--measurement-only', '--request-timeout', '60']);
    // The loadtest's own verdict, tick-rate budget included; on failure the stage tells host saturation from loss.
    expect(result.ok, JSON.stringify(result.stage)).toBe(true);
  }, 240_000);

  it('(d) survives kill -9 of the primary mid-match: other nodes\' matches run on and reconnect, lobbies come back', async () => {
    const result = await scenarioPrimaryCrash(rig!);
    expect(result).toMatchObject({ ok: true, lostOnSurvivingNodes: 0, restoredLobbyPhase: 'waiting' });
    expect(result.matchesOnSurvivingNodes).toBeGreaterThan(0);
    expect(result.failoverMs).toBeLessThan(15_000);
  }, 300_000);

  it('(e) restarts every node in turn under load without losing a match or a pregame lobby', async () => {
    const result = await scenarioRolling(rig!);
    expect(result).toMatchObject({ ok: true, interrupted: 0, pregameLobbyAfter: 'waiting' });
    expect(result.creationErrors).toEqual([]);
  }, 900_000);

  it('(h) features a public game running off the primary through the balancer, and again from the successor after a handover', async () => {
    const result = await scenarioFeaturedPublic(rig!);
    expect(result).toMatchObject({ ok: true, releaseDelayMs: 180_000 });
    expect(result.hostedOn).not.toBe(result.primary);
    expect(result.successor).not.toBe(result.primary);
  }, 600_000);
});
