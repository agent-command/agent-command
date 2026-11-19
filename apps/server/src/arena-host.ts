/** A single-match adapter over the canonical game host/room allocator. Scheduling stays in PlayerThree. */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, surfaceHash } from 'playerthree';
import type { ObserverCommentary } from 'playerthree';
import { ARENA_HOST_EVENT_DEFINITIONS } from 'playerthree/results';
import type { SeatAssignment } from 'playerthree/host';
import type { AbortReason, BoundSeat, GameMatchHost, GameMatchResult, MatchSpec, OutcomeRow, ResultRows, SeatBinder, SeatRow } from 'playerthree/arena';
import { eventDefinitions, isCustomRules, manifest, metricDefinitions, resolveRules, TICK_RATE, type ArmyId, type MatchOptions, type Plane } from '@agent-command/game';
import { arenaLayouts, resolveArenaMatch } from '@agent-command/game/arena';
import { matchSides, type LobbyMatch, type LobbyOpenOptions } from './lobby.ts';
import type { GameHost, GameMatch } from './room.ts';
import { HttpError } from './http.ts';
import { arenaSeedSource } from './arena-seeds.ts';

export type ArenaAllocator = (
  identity: string, assignments: SeatAssignment[], options: MatchOptions,
  queued: (state?: { position: number; estimatedWaitMs: number }) => void,
  current: () => boolean, settings: Partial<LobbyOpenOptions> & Pick<LobbyOpenOptions, 'teams' | 'alliances'>,
) => Promise<LobbyMatch>;
interface Binding { assignment: SeatAssignment; attemptId: string }
interface LiveExecution { match: GameMatch; spec: MatchSpec; commentary: ObserverCommentary[]; close(): Promise<void> }
const remapRows = (rows: Partial<ResultRows>, matchId: string): Partial<ResultRows> => Object.fromEntries(
  Object.entries(rows).map(([key, entries]) => [key, (entries as readonly object[]).map(row => ({ ...row, matchId }))]),
) as Partial<ResultRows>;

export function createArenaMatchHost(host: GameHost, open: ArenaAllocator, consent: (attemptId: string, entrantId: string, category: 'summary' | 'chat') => Promise<boolean> = async () => false, seedFor = arenaSeedSource(),
  /** The commander-log queue of a series' matches (`gauntlet` for the gauntlet's series), else null. */
  logQueue: (seriesId: string) => string | null = () => null) {
  const bindings = new Map<string, Binding>();
  const leased = new Set<string>();
  const matches = new Map<string, LiveExecution>();
  const artifacts = new Map<string, Uint8Array>();
  const releaseTimers = new Set<NodeJS.Timeout>();
  let closing = false;
  // Persisted secret material and the durable series/world identity preserve mirrors and retries across restarts.
  // The realized seed is never part of the participant-facing spec.

  function assignments(owner: string, spec: MatchSpec): SeatAssignment[] {
    const roster = host.commanders.roster(owner);
    const used = new Map<string, string>();
    return spec.sides.flatMap(side => side.seats.map(entry => {
      const occupant = entry.occupant;
      if (occupant.kind === 'human' || occupant.kind === 'open') throw new HttpError(400, 'unsupported_occupant');
      if (occupant.kind === 'commander') {
        const commander = roster.find(c => c.id === occupant.ref.id);
        if (!commander || commander.kind !== occupant.ref.kind || !commander.roles.includes(entry.role)) throw new HttpError(403, 'commander_unavailable');
        if (commander.seated || used.has(commander.id) && used.get(commander.id) !== side.id) throw new HttpError(409, 'commander_busy');
        used.set(commander.id, side.id);
        if (occupant.ref.kind === 'policy' && (occupant.ref.version === undefined || !commander.policy.versions.some(v => v.version === occupant.ref.version))) throw new HttpError(400, 'policy_version_required');
        return { team: side.id, role: entry.role, owner, kind: occupant.ref.kind, commander: { id: commander.id }, ...(occupant.ref.kind === 'policy' ? { policy: { version: occupant.ref.version! } } : {}) };
      }
      return { team: side.id, role: entry.role, owner, kind: occupant.kind === 'bot' ? 'bot' : 'none' };
    }));
  }
  const binder: SeatBinder = {
    async validate(owner, spec) {
      const seats = assignments(owner, spec.template);
      if (spec.entrantSeats) for (const lineup of spec.entrantSeats) assignments(owner, { ...spec.template, sides: [{ ...spec.template.sides[0]!, seats: lineup.seats }] });
      // The gauntlet is policy-only (D8); bot-only series hold no commanders.
      if (spec.track === 'bots' && seats.some(s => s.kind === 'agent' || s.kind === 'policy') || (spec.track === 'policy' || spec.track === 'gauntlet') && seats.some(s => s.kind === 'agent')) throw new HttpError(400, 'track_mismatch');
      if (seats.some(s => s.commander) && spec.execution.concurrency > 1) throw new HttpError(400, 'commander_lane_capacity');
      const commanderSides = new Set(seats.filter(s => s.commander).map(s => s.team));
      if (commanderSides.size > 1 && seats.some(s => s.commander && !host.commanders.roster(owner).find(c => c.id === s.commander!.id)!.isolation.independentSessions)) throw new HttpError(400, 'independent_sessions_required');
    },
    async bind(owner, spec, context) {
      if (closing || context.signal.aborted) throw new HttpError(503, 'server_updating');
      const seats = assignments(owner, spec);
      const commanderKeys = seats.filter(s => s.commander).map(s => `${owner}/${s.commander!.id}`);
      if (commanderKeys.some(key => leased.has(key))) throw new HttpError(409, 'commander_busy');
      for (const key of commanderKeys) leased.add(key);
      const handles = seats.map(assignment => {
        const executionId = randomUUID(); bindings.set(executionId, { assignment, attemptId: context.attemptId });
        return { seat: { team: assignment.team, role: assignment.role }, executionId, kind: assignment.kind } satisfies BoundSeat;
      });
      let released = false;
      return { seats: handles, async release() {
        if (released) return; released = true;
        for (const handle of handles) bindings.delete(handle.executionId);
        for (const key of commanderKeys) leased.delete(key);
      } };
    },
  };
  const gameHost: GameMatchHost = {
    async describe() {
      return { game: manifest.id, gameVersion: manifest.version, surfaceHash: surfaceHash(manifest),
        supportedLayouts: arenaLayouts(),
        clocks: ['realtime', 'accelerated'], metricDefinitions, eventDefinitions: [...eventDefinitions, ...ARENA_HOST_EVENT_DEFINITIONS] };
    },
    async resolve(spec) { return resolveArenaMatch(spec, host.matchOptions); },
    async create(spec, context) {
      if (closing || context.signal.aborted) throw new HttpError(503, 'server_updating');
      const assigned = context.bindings.map(bound => {
        const binding = bindings.get(bound.executionId);
        if (!binding || binding.attemptId !== context.attemptId || binding.assignment.team !== bound.seat.team || binding.assignment.role !== bound.seat.role || binding.assignment.kind !== bound.kind) throw new HttpError(403, 'invalid_binding');
        return binding.assignment;
      });
      if (assigned.length !== spec.sides.reduce((n, side) => n + side.seats.length, 0)) throw new HttpError(400, 'incomplete_bindings');
      const allocation = await open(`arena:${context.attemptId}`, assigned, spec.options as MatchOptions, () => {}, () => !closing && !context.signal.aborted, {
        identity: `arena:${context.attemptId}`, speed: context.execution.speed, metricSampleEveryTicks: context.telemetry.sampleEveryTicks,
        secretSeed: await seedFor(context.attemptId.split('_')[0]!, canonicalJson({ seed: spec.seed, map: spec.map.identity, rules: spec.rulesHash })),
        // resolveArenaMatch checked every side id as an army corner of the layout.
        ...matchSides(spec.sides.map(side => ({ id: side.id as ArmyId, alliance: side.alliance }))),
        observerPolicy: { ...spec.observerPolicy, public: spec.observerPolicy.minDelayMs >= 180000 },
        maxWallMs: context.execution.maxWallMs,
        botSeats: spec.sides.flatMap(side => side.seats.flatMap(entry => entry.occupant.kind === 'bot' ? [{ team: side.id as ArmyId, role: entry.role as Plane, level: entry.occupant.level, options: entry.occupant.options }] : [])),
        log: { mode: 'series', queue: logQueue(context.attemptId.split('_')[0]!), rulesHash: spec.rulesHash, customRules: isCustomRules(resolveRules(spec.options as MatchOptions)),
          map: { id: spec.map.id, identity: spec.map.identity, seed: spec.map.seed, layout: spec.map.layout } },
      });
      const local = allocation.localMatch;
      if (!local) { await allocation.close(); throw new HttpError(503, 'canonical_host_required'); }
      const match: GameMatch = local;
      const done = Promise.withResolvers<GameMatchResult>();
      void done.promise.catch(() => {}); // The runner attaches after activation; failures remain on finished.
      const startedAt = Date.now();
      let settled = false;
      let disposed = false;
      let started = false;
      let sequence = 0;
      let emitQueue = Promise.resolve();
      let queuedBytes = 0;
      let streamError: unknown;
      const commentary: ObserverCommentary[] = [];
      let commentaryQueue = Promise.resolve();
      let reportedTokens = 0;
      let reportedTurns = 0;
      const accepted = new Map<string, { submitted: number; accepted: number; rejected: number; policyErrors: number }>();
      const counters = (team: string, role: string) => { const key = `${team}/${role}`; let c = accepted.get(key); if (!c) { c = { submitted: 0, accepted: 0, rejected: 0, policyErrors: 0 }; accepted.set(key, c); } return c; };
      const enqueue = (rows: Partial<ResultRows>) => {
        if (Object.values(rows).every(entries => !entries.length)) return;
        const mapped = remapRows(rows, context.attemptId);
        if (mapped.events) mapped.events = mapped.events.map(event => ({ ...event, sequence: sequence++ }));
        const bytes = Buffer.byteLength(canonicalJson(mapped));
        queuedBytes += bytes;
        if (queuedBytes > 8 * 1024 * 1024) { streamError = new Error('Recording backpressure limit'); void finish('aborted', 'artifact_limit'); return; }
        emitQueue = emitQueue.then(() => context.emitChunk(mapped)).then(() => { queuedBytes -= bytes; }).catch(error => { streamError = error; void finish('aborted', 'storage'); });
      };
      const offTrace = host.onTrace(event => {
        if (event.match !== match.id || settled) return;
        if (event.type === 'intent') {
          const c = counters(event.team, event.role); c.submitted++; if (event.ack.ok) c.accepted++; else c.rejected++;
        } else if (event.type === 'policy_call' && event.error) counters(event.team, event.role).policyErrors++;
      });
      const offCommentary = match.onCommentary(event => {
        if (settled) return;
        const entrantId = spec.bindings.find(binding => binding.seat.team === event.team && binding.seat.role === event.role)?.entrantId;
        if (!entrantId) return;
        commentaryQueue = commentaryQueue.then(async () => {
          if (!await consent(context.attemptId, entrantId, event.category)) return;
          if (commentary.length >= 4096) { void finish('aborted', 'artifact_limit'); return; }
          const item = { ...event, id: `${context.attemptId}:commentary:${commentary.length}` };
          commentary.push(item);
          enqueue({ events: [{ matchId: context.attemptId, sequence: 0, tick: event.tick, atMs: Date.now() - startedAt, kind: 'commentary', team: event.team, role: event.role, data: { entrantId, category: event.category, text: event.text } }] });
        }).catch(error => { streamError = error; void finish('aborted', 'storage'); });
      });
      const offUsage = match.onUsage(event => {
        if (settled) return;
        const bound = context.bindings.find(binding => binding.seat.team === event.team && binding.seat.role === event.role);
        const entrantId = spec.bindings.find(binding => binding.seat.team === event.team && binding.seat.role === event.role)?.entrantId;
        if (!bound || !entrantId) return;
        const report = event.report;
        const finishedAt = new Date(event.receivedAt).toISOString();
        const started = new Date(event.receivedAt - report.latencyMs).toISOString();
        enqueue({
          decisions: [{ matchId: context.attemptId, team: event.team, role: event.role, decisionId: report.decisionId, startedAt: started, finishedAt, latencyMs: report.latencyMs, source: report.source, status: 'reported' }],
          usage: [{ matchId: context.attemptId, phase: 'inference', team: event.team, role: event.role, entrantId, executionId: bound.executionId, decisionId: report.decisionId, reporter: report.reporter,
            inputTokens: report.inputTokens ?? null, outputTokens: report.outputTokens ?? null, cacheReadTokens: report.cacheReadTokens ?? null, cacheWriteTokens: report.cacheWriteTokens ?? null,
            costAmount: report.costAmount ?? null, currency: report.currency ?? null, pricingVersion: report.pricingVersion ?? null, coverage: report.coverage }],
        });
        reportedTokens += (report.inputTokens ?? 0) + (report.outputTokens ?? 0);
        reportedTurns++;
        if (context.budgets.maxTokens !== null && reportedTokens >= context.budgets.maxTokens || context.budgets.maxTurns !== null && reportedTurns >= context.budgets.maxTurns) void finish('aborted', 'budget_exhausted');
      });
      const offTick = match.onTick(tick => {
        if (settled) return;
        if (tick % context.telemetry.sampleEveryTicks === 0) enqueue(match.metricRows());
        if (tick >= context.execution.maxTicks) void finish('aborted', 'tick_limit');
      });
      const offEnd = match.onEnd(() => { void finish('finished', 'game'); });
      const stop = () => { void finish('aborted', typeof context.signal.reason === 'string' ? context.signal.reason : 'owner'); };
      context.signal.addEventListener('abort', stop, { once: true });
      const live = { match, spec, commentary, close: allocation.close };
      matches.set(context.attemptId, live);

      async function finish(terminal: GameMatchResult['terminal'], reason: string) {
        if (settled) return;
        settled = true; match.stop();
        offTick(); offTrace(); offEnd(); offUsage(); offCommentary(); context.signal.removeEventListener('abort', stop);
        try {
          await match.halt();
          match.metrics(); // Final exact sample before the recorder's last drain.
          await commentaryQueue;
          enqueue(match.metricRows());
          await emitQueue;
          const seats: SeatRow[] = assigned.map(assignment => {
            const c = counters(assignment.team, assignment.role);
            const current = match.seats().find(s => s.team === assignment.team && s.role === assignment.role)!;
            const version = assignment.policy && 'version' in assignment.policy ? assignment.policy.version : null;
            // The deployed artifact's SHA-256, from the owner's library (host-computed at deploy).
            const artifactHash = version !== null && assignment.commander ? host.commanders.roster(assignment.owner).find(cmd => cmd.id === assignment.commander!.id)?.policy.versions.find(v => v.version === version && v.role === assignment.role)?.artifactHash ?? null : null;
            return { matchId: context.attemptId, team: assignment.team, role: assignment.role,
              entrantId: spec.bindings.find(b => b.seat.team === assignment.team && b.seat.role === assignment.role)?.entrantId ?? null,
              executionKind: assignment.kind, fallbackKind: current.controller !== assignment.kind ? current.controller : null,
              artifactVersion: version, artifactHash,
              readyState: match.readiness().seats.find(s => s.team === assignment.team && s.role === assignment.role)?.state ?? 'ready',
              activeTicks: match.tick, submittedIntents: c.submitted, acceptedIntents: c.accepted, rejectedIntents: c.rejected,
              commandApm: match.tick > 0 ? c.accepted * TICK_RATE * 60 / match.tick : null, policyErrors: c.policyErrors };
          });
          const artifactId = randomUUID();
          // Replay contains only validated intents and resolved rules, not commander tokens or owner metadata.
          const recording = match.replay();
          const replay = Buffer.from(canonicalJson(recording));
          const ref = { id: artifactId, matchId: context.attemptId, kind: 'replay' as const, format: recording.format, version: recording.version, sha256: createHash('sha256').update(replay).digest('hex'), bytes: replay.length, availability: 'available' as const, releaseAt: Date.now() + spec.observerPolicy.minDelayMs };
          if (replay.length > 256 * 1024 * 1024) throw new HttpError(413, 'artifact_limit');
          artifacts.set(artifactId, replay);
          const outcomes: OutcomeRow[] = match.teams.map(team => {
            const outcome = terminal === 'finished' ? match.outcome(team) : 'aborted';
            if (outcome === 'running') throw new Error('Terminal game outcome unavailable');
            return { team, outcome, rank: terminal === 'finished' ? match.rank(team) : null, reason };
          });
          done.resolve({ terminal: streamError ? 'aborted' : terminal, terminalReason: streamError ? 'storage' : reason, ticks: match.tick, simulatedMs: match.tick / TICK_RATE * 1000, wallMs: Date.now() - startedAt, outcomes, metrics: [], artifacts: [ref], rows: { seats, events: [{ matchId: context.attemptId, tick: match.tick, sequence: sequence++, atMs: Date.now() - startedAt, kind: 'host.lifecycle', team: null, role: null, data: { state: terminal, reason } }] } });
        } catch (error) { done.reject(error); }
      }
      if (context.signal.aborted) stop();
      return {
        id: context.attemptId,
        async start() {
          if (started || settled) return; started = true;
          const gate = Promise.withResolvers<boolean>();
          const check = () => {
            const seats = match.readiness().seats;
            if (seats.some(seat => seat.state === 'policy_failed' || seat.state === 'consent_required')) gate.resolve(false);
            else if (seats.every(seat => seat.state === 'ready')) gate.resolve(true);
          };
          const offReady = match.onReadiness(check);
          const timer = setTimeout(() => gate.resolve(false), Math.min(30000, context.execution.maxWallMs));
          let canStart: boolean;
          try { check(); canStart = await Promise.race([gate.promise, done.promise.then(() => false)]); }
          finally { clearTimeout(timer); offReady(); }
          if (settled) return;
          if (!canStart) { await finish('aborted', 'seat_not_ready'); return; }
          enqueue({ events: [{ matchId: context.attemptId, tick: 0, sequence: sequence++, atMs: 0, kind: 'host.lifecycle', team: null, role: null, data: { state: 'started' } }] });
          await allocation.start();
        },
        finished: done.promise,
        async abort(reason: AbortReason) { await finish('aborted', reason); await done.promise; },
        async dispose() {
          if (disposed) return; disposed = true;
          if (!settled) await finish('aborted', 'shutdown');
          await done.promise.catch(() => {});
          await match.releaseBindings();
          // Retain only read-only playback after releasing exact-seat execution leases.
          const timer = setTimeout(() => {
            releaseTimers.delete(timer); matches.delete(context.attemptId);
            void allocation.close().catch(() => {});
          }, spec.observerPolicy.minDelayMs + 1000);
          timer.unref(); releaseTimers.add(timer);
        },
      };
    },
    async *observe(matchId, grant, after) {
      const live = matches.get(matchId);
      if (!live || !live.spec.observerPolicy.allowOmniscient && grant.kind === 'omniscient' || grant.delayMs < live.spec.observerPolicy.minDelayMs) throw new HttpError(404, 'not_found');
      let commentaryAfter = -1;
      for await (const frame of live.match.observerFrames(grant, after)) {
        const commentary: ObserverCommentary[] = [];
        for (const item of live.commentary) {
          if (item.tick > frame.tick || item.tick <= commentaryAfter || grant.kind === 'team' && item.team !== grant.team) continue;
          const entrantId = live.spec.bindings.find(binding => binding.seat.team === item.team && binding.seat.role === item.role)?.entrantId;
          if (entrantId && await consent(matchId, entrantId, item.category)) commentary.push(item);
        }
        commentaryAfter = frame.tick;
        yield { ...frame, commentary };
      }
    },
    async artifact(id) {
      const bytes = artifacts.get(id); if (!bytes) throw new HttpError(404, 'not_found');
      return (async function* () { try { yield bytes; } finally { artifacts.delete(id); } })();
    },
  };
  return { host: gameHost, binder, hasMatch: (matchId: string) => matches.has(matchId), async close() {
    closing = true;
    for (const timer of releaseTimers) clearTimeout(timer);
    releaseTimers.clear();
    await Promise.all([...matches.values()].map(live => live.close()));
    matches.clear(); bindings.clear(); leased.clear(); artifacts.clear();
  } };
}
