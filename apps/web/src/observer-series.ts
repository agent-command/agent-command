/**
 * Benchmark preset data: the series a watched game belongs to, from the same authorized results projection (and
 * its release clock) as the results page. Pure derivation plus a small subscriber; the observer renders it.
 */
import type { EntrantRow, ResultsSummary } from 'playerthree/arena';
import { arenaPath, arenaRequest, streamArena, type ArenaAccess } from './arena-net.ts';

export interface SeriesAgentStats {
  entrantId: string;
  entrant: EntrantRow | undefined;
  label: string;
  /** Mean command APM over this entrant's recorded seats; null when no seat reported it. */
  apm: number | null;
  submitted: number | null;
  accepted: number | null;
  rejected: number | null;
  /** Decision latency (ms); host inter-call gaps are not think time and are never shown as latency. */
  latency: { p50: number | null; p95: number | null; source: string } | undefined;
  tokens: { input: number | null; output: number | null } | undefined;
  cost: { amount: string; currency: string | null } | undefined;
  /** Seat rows behind these numbers (completed games of this series). */
  seats: number;
}

export interface SeriesContext {
  title: string;
  state: ResultsSummary['state'];
  /** 1-based schedule position of the watched game, or 0 when it is not in the released schedule. */
  game: number;
  games: number;
  completed: number;
  standings: { entrantId: string; label: string; wins: number; losses: number; draws: number }[];
  rotation: { trialId: string; mapId: string; current: boolean; done: boolean }[];
  /** Who plays which side in the watched game, and whether that is the schedule's swapped order. */
  sides: { team: string; entrantId: string; label: string }[];
  swapped: boolean;
  live: { matchId: string; label: string; current: boolean }[];
  agents: SeriesAgentStats[];
}

const sum = (values: (number | null)[]): number | null => values.some((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;

export function seriesContext(result: ResultsSummary, matchId: string): SeriesContext {
  const t = result.tables;
  const label = (id: string) => t.entrants.find((entrant) => entrant.entrantId === id)?.label ?? id;
  const schedule = [...t.schedule].sort((a, b) => a.scheduleIndex - b.scheduleIndex);
  const active = result.activeMatches.find((match) => match.matchId === matchId);
  const attempt = t.matches.find((match) => match.matchId === matchId);
  const trialId = active?.trialId ?? attempt?.trialId;
  const trial = schedule.find((row) => row.trialId === trialId);
  const done = new Set(t.matches.filter((match) => match.acceptedAttempt).map((match) => match.trialId));
  const first = schedule[0];
  const agents = t.entrants.map((entrant): SeriesAgentStats => {
    const seats = t.seats.filter((seat) => seat.entrantId === entrant.entrantId);
    const apm = seats.flatMap((seat) => seat.commandApm === null ? [] : [seat.commandApm]);
    const latency = result.summaries.latency.find((row) => row.entrantId === entrant.entrantId && row.source !== 'host_gap' && row.samples > 0);
    const usage = result.summaries.usage.filter((row) => row.entrantId === entrant.entrantId && row.phase === 'inference');
    const priced = usage.filter((row) => row.costAmount !== null);
    return {
      entrantId: entrant.entrantId, entrant, label: entrant.label,
      apm: apm.length ? apm.reduce((a, b) => a + b, 0) / apm.length : null,
      submitted: sum(seats.map((seat) => seat.submittedIntents)), accepted: sum(seats.map((seat) => seat.acceptedIntents)), rejected: sum(seats.map((seat) => seat.rejectedIntents)),
      latency: latency ? { p50: latency.p50Ms, p95: latency.p95Ms, source: latency.source } : undefined,
      tokens: usage.length ? { input: sum(usage.map((row) => row.inputTokens)), output: sum(usage.map((row) => row.outputTokens)) } : undefined,
      // Amounts are decimal strings per currency; only a single-currency total is summed (exactly, in micro-units).
      cost: priced.length && new Set(priced.map((row) => row.currency)).size === 1
        ? { amount: (priced.reduce((total, row) => total + Math.round(Number(row.costAmount) * 1e6), 0) / 1e6).toFixed(4), currency: priced[0]!.currency }
        : undefined,
      seats: seats.length,
    };
  });
  return {
    title: t.entrants.map((entrant) => entrant.label).join(' vs '),
    state: result.state,
    game: trial ? schedule.indexOf(trial) + 1 : 0,
    games: schedule.length,
    completed: done.size,
    standings: t.standings.map((row) => ({ entrantId: row.entrantId, label: label(row.entrantId), wins: row.wins, losses: row.losses, draws: row.draws })),
    rotation: schedule.map((row) => ({ trialId: row.trialId, mapId: row.mapId, current: row.trialId === trialId, done: done.has(row.trialId) })),
    sides: (trial?.sideBindings ?? []).map((binding) => ({ team: binding.team, entrantId: binding.entrantId, label: label(binding.entrantId) })),
    swapped: !!trial && !!first && trial.permutationId !== first.permutationId,
    live: result.activeMatches.map((match) => {
      const row = schedule.find((entry) => entry.trialId === match.trialId);
      return { matchId: match.matchId, label: row ? `Game ${schedule.indexOf(row) + 1} · ${row.mapId}` : match.spec.map.id, current: match.matchId === matchId };
    }),
    agents,
  };
}

/** Where the results page of this series lives (a link the observer can open or return to). */
export function resultsHref(access: ArenaAccess): string {
  return access.kind === 'owner' ? `/#series=${encodeURIComponent(access.seriesId)}` : arenaPath(access);
}

/** Keeps the latest released results revision of a series; `receive` runs on every newer revision. */
export function watchSeries(access: ArenaAccess, receive: (result: ResultsSummary) => void, signal: AbortSignal): void {
  void (async () => {
    let revision = -1;
    const take = (result: ResultsSummary) => { if (result.revision > revision) { revision = result.revision; receive(result); } };
    while (!signal.aborted) {
      try {
        take(await arenaRequest<ResultsSummary>(access, '', undefined, signal));
        await streamArena(access, revision, signal, take);
      } catch { /* retried below: the panel keeps its last released revision */ }
      if (signal.aborted) return;
      const pause = Promise.withResolvers<void>();
      const timer = setTimeout(pause.resolve, 3000);
      const interrupted = () => { clearTimeout(timer); pause.resolve(); };
      signal.addEventListener('abort', interrupted, { once: true });
      await pause.promise;
      signal.removeEventListener('abort', interrupted);
    }
  })();
}
