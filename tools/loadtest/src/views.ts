/**
 * In-process cost of player views per tick. Three identical seeded matches are warmed to the same tick: one bare, one
 * bound to the real `@playerthree/colyseus` binding with no readers, and one bound with `--readers` view readers per team
 * (fake sockets that only count the bytes enqueued to them). Ticks alternate between the three and each tick's thread
 * CPU is measured, so the differences are what views cost per tick: projection (bound − bare) and delta/encode/fan-out
 * (readers − bound), independent of the network. A codec pass then times, on the same views, the pre-delta wire
 * (each team's whole periodic view encoded) against the stream (structural diff of the complete view + delta encode).
 * Timing-sensitive: run in the shared timing slot, from the repo root:
 *   node tools/loadtest/src/views.ts [--warmup 9600] [--ticks 1200] [--readers 4] [--seed 1]
 * Prints one JSON line.
 */
import { setImmediate as settle } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ClientState, getMessageBytes, Protocol, type Client } from '@colyseus/core';
import { bindPlayerThreeRoom } from '@playerthree/colyseus';
import { diff } from 'playerthree/delta';
import { createPlayerThreeHost, type PlayerThreeMatch } from 'playerthree/host';
import { MSG } from 'playerthree/protocol';
import { definition, PLANES, slotArmyIds } from '@agent-command/game';

type Match = PlayerThreeMatch<typeof definition.manifest>;

const { values } = parseArgs({ options: {
  warmup: { type: 'string', default: '9600' }, ticks: { type: 'string', default: '1200' },
  readers: { type: 'string', default: '4' }, seed: { type: 'string', default: '1' },
} });
const integer = (key: keyof typeof values, min: number): number => {
  const n = Number(values[key]);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`--${key} must be an integer >= ${min}`);
  return n;
};
const warmup = integer('warmup', 0);
const ticks = integer('ticks', 1);
const readers = integer('readers', 1);
const seed = integer('seed', 0);

const host = createPlayerThreeHost({ definition, maxMatches: 3 });
/** The default two-slot map's armies: a duel. */
const TEAMS = slotArmyIds(2);
const controllers = Object.fromEntries(TEAMS.map((team) => [team, Object.fromEntries(PLANES.map((plane) => [plane, 'bot' as const]))]));
async function warmed(): Promise<Match> {
  const match = host.createMatch({ teams: TEAMS, controllers, realtime: false, seed });
  await match.step(warmup);
  if (match.over) throw new Error('the match ended during warmup: lower --warmup');
  return match;
}

interface Sink { bytes: number; messages: number; keyframeBytes: number }
function bind(match: Match, perTeam: number): Sink[] {
  const room = { onMessage() {}, clock: { setInterval() { return { clear() {} }; } } };
  const binding = bindPlayerThreeRoom(room, { host, match, viewIntervalMs: 0, disposeMatch: false });
  const sinks: Sink[] = [];
  for (const team of TEAMS) {
    for (let i = 0; i < perTeam; i++) {
      const sink: Sink = { bytes: 0, messages: 0, keyframeBytes: 0 };
      const count = (bytes: Buffer) => {
        if (sink.messages === 0) sink.keyframeBytes = bytes.length;
        sink.bytes += bytes.length;
        sink.messages++;
      };
      // The binding consumes this documented structural subset of a Colyseus client.
      const client = { sessionId: `${team}-${i}`, state: ClientState.JOINED, ref: undefined, enqueueRaw: count, raw: count, leave() {} } as unknown as Client;
      if (!binding.onAuth(client, { token: match.mintSpectatorToken(team).token })) throw new Error('spectator admission failed');
      binding.onJoin(client, { watch: [team] });
      sinks.push(sink);
    }
  }
  return sinks;
}

const bare = await warmed();
const bound = await warmed();
const read = await warmed();
bind(bound, 0);
const sinks = bind(read, readers);
const joined = sinks.map((sink) => ({ ...sink }));

const cpu = { bare: 0, bound: 0, read: 0 };
for (let i = 0; i < ticks; i++) {
  for (const [key, match] of [['bare', bare], ['bound', bound], ['read', read]] as const) {
    const start = process.threadCpuUsage();
    await match.step(1);
    await settle();
    const used = process.threadCpuUsage(start);
    cpu[key] += used.user + used.system;
  }
}
const per = (micros: number) => Math.round(micros / ticks * 10) / 10;
const sent = sinks.map((sink, i) => ({ bytes: sink.bytes - joined[i]!.bytes, messages: sink.messages - joined[i]!.messages }));
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

// Codec only, on the same views: the pre-delta wire encoded each team's whole periodic view (static members omitted);
// the stream diffs the complete view (static members shared by identity, as the host's stream does) and encodes the
// delta. Snapshot projection happens outside the timed spans. These spans are short synchronous calls, so they use the
// high-resolution clock (thread CPU accounting is too coarse for microsecond spans on some kernels).
const codec = { encodeWhole: 0, diff: 0, encodeDelta: 0, wholeBytes: 0, deltaBytes: 0, deltas: 0 };
const bootstrap = new Map<string, Record<string, unknown>>();
const previous = new Map<string, unknown>();
const since = (start: number) => (performance.now() - start) * 1000;
for (let i = 0; i < ticks; i++) {
  await bare.step(1);
  for (const team of TEAMS) {
    const { match: _static, ...periodic } = bare.view(team);
    let base = bootstrap.get(team);
    if (!base) bootstrap.set(team, base = { ...bare.view(team) });
    const complete = { ...base, ...periodic };
    let start = performance.now();
    codec.wholeBytes += getMessageBytes.raw(Protocol.ROOM_DATA, MSG.view, { op: 'view', team, data: periodic }).length;
    codec.encodeWhole += since(start);
    const prior = previous.get(team);
    previous.set(team, complete);
    if (prior === undefined) continue;
    start = performance.now();
    const delta = diff(prior, complete);
    codec.diff += since(start);
    if (!delta) continue;
    start = performance.now();
    codec.deltaBytes += getMessageBytes.raw(Protocol.ROOM_DATA, MSG.view, { op: 'view', team, version: i, delta }).length;
    codec.encodeDelta += since(start);
    codec.deltas++;
  }
}
const perTeamTick = (value: number, count: number) => Math.round(value / count * 10) / 10;
console.log(JSON.stringify({
  schema: 'ac-loadtest-views/v1', warmup, ticks, readersPerTeam: readers, teams: TEAMS.length, seed, tick: read.tick,
  cpuMicrosPerTick: { bare: per(cpu.bare), bound: per(cpu.bound), readers: per(cpu.read),
    projection: per(cpu.bound - cpu.bare), deltaEncodeFanOut: per(cpu.read - cpu.bound), viewsTotal: per(cpu.read - cpu.bare) },
  perReader: {
    bytesPerTick: Math.round(mean(sent.map((s) => s.bytes)) / ticks),
    bytesPerSecond: Math.round(mean(sent.map((s) => s.bytes)) / ticks * definition.manifest.tickRate),
    messagesPerTick: Math.round(mean(sent.map((s) => s.messages)) / ticks * 100) / 100,
    joinKeyframeBytes: Math.round(mean(sinks.map((s) => s.keyframeBytes))),
  },
  codecMicrosPerTeamTick: {
    wholeEncode: perTeamTick(codec.encodeWhole, ticks * TEAMS.length),
    deltaDiff: perTeamTick(codec.diff, (ticks - 1) * TEAMS.length),
    deltaEncode: perTeamTick(codec.encodeDelta, codec.deltas),
    wholeBytes: Math.round(codec.wholeBytes / (ticks * TEAMS.length)),
    deltaBytes: Math.round(codec.deltaBytes / codec.deltas),
  },
}));
host.dispose();
