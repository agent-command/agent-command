/**
 * Compact chart-ready summary of the frontier live-command series (`bench/frontier-live.config.ts`): one entry per
 * pairing (model vs model, model vs standard bot) with W/L/D, match length, final state, per-seat tokens/cost/latency,
 * recorded failures and replay paths. Reads every `<live>/<pairing>/results.json` except `pilot*` directories.
 *
 *   node bench/frontier-summary.ts --live .data/bench/frontier/live [--billed USD]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateResultsEnvelope } from 'playerthree/results';
import { MODELS, PRICING } from './frontier-models.ts';

const { values } = parseArgs({ options: { live: { type: 'string' }, billed: { type: 'string' } } });
if (!values.live) throw new Error('--live DIRECTORY');
const live = resolve(values.live);
const BOT = 'standard-bot';
const PLANES = ['surface', 'depths', 'sky', 'orbit'] as const;

interface Record_ { w: number; l: number; d: number; other: number }
interface SeatSummary {
  entrant: string; turns: number; inputTokens: number; outputTokens: number; costUsd: number; latencyP50Ms: number | null; latencyP95Ms: number | null;
  providerErrors: number; agentIntents: { submitted: number; accepted: number; rejected: number; rejectedByCode: Record<string, number> };
}
const quantile = (values: number[], q: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
};

const dirs = (await readdir(live, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('pilot')).map(d => d.name).sort();
const pairings = [];
const totals = new Map<string, { matches: number; inputTokens: number; outputTokens: number; costUsd: number; turns: number; providerErrors: number; rejectedIntents: number }>();
for (const name of dirs) {
  let text: string;
  try { text = await readFile(join(live, name, 'results.json'), 'utf8'); } catch { continue; }
  const results = validateResultsEnvelope(JSON.parse(text));
  const t = results.tables;
  const entrants = t.entrants.map(e => e.entrantId);
  const record: Record<string, Record_> = Object.fromEntries(entrants.map(e => [e, { w: 0, l: 0, d: 0, other: 0 }]));
  const matches = t.matches.filter(m => m.acceptedAttempt).map(m => {
    const sides = Object.fromEntries(m.spec.sides.map(s => [s.id, m.spec.bindings.find(b => b.seat.team === s.id)!.entrantId]));
    // A pairing's shared USD cap is the harness's spending guard, not play: its forfeit is unscored ("other").
    const budgetForfeit = m.status === 'forfeit' && m.outcomes.some(o => o.reason === 'budget');
    for (const o of m.outcomes) {
      const r = record[sides[o.team]!]!;
      if (budgetForfeit) r.other++; else if (o.outcome === 'win') r.w++; else if (o.outcome === 'loss') r.l++; else if (o.outcome === 'draw') r.d++; else r.other++;
    }
    const report = [...t.events].reverse().filter(e => e.matchId === m.matchId && e.kind === 'game_report');
    const finalTick = Math.max(0, ...t.metrics.filter(x => x.matchId === m.matchId && x.scope === 'side').map(x => x.tick));
    const metric = (team: string, key: string) => t.metrics.find(x => x.matchId === m.matchId && x.scope === 'side' && x.team === team && x.metric === key && x.tick === finalTick)?.value ?? null;
    const finalState = Object.fromEntries(Object.keys(sides).map(team => {
      const armies = (report.find(e => e.team === team)?.data as { report?: { armies?: { army: string; spire: { plane: string; hp: number; maxHp: number }[]; stats: Record<string, number> }[] } } | undefined)?.report?.armies ?? [];
      const army = armies.find(a => a.army === team);
      return [team, {
        entrant: sides[team],
        spireHp: Object.fromEntries((army?.spire ?? []).map(s => [s.plane, { hp: s.hp, maxHp: s.maxHp }])),
        units: Object.fromEntries(PLANES.map(p => [p, metric(team, `army.${p}.units`)])),
        structures: Object.fromEntries(PLANES.map(p => [p, metric(team, `army.${p}.structures`)])),
        resources: { alloy: metric(team, 'economy.stock.alloy'), energy: metric(team, 'economy.stock.energy') },
        stats: army?.stats ?? null,
      }];
    }));
    const seats: SeatSummary[] = [];
    for (const team of Object.keys(sides)) {
      const entrant = sides[team]!;
      if (entrant === BOT) continue;
      const usage = t.usage.filter(u => u.matchId === m.matchId && u.team === team);
      const decisions = t.decisions.filter(d => d.matchId === m.matchId && d.team === team);
      const intents = t.intents.filter(i => i.matchId === m.matchId && i.team === team && i.source === 'agent');
      const rejectedByCode: Record<string, number> = {};
      for (const i of intents) if (i.rejected) rejectedByCode[i.code] = (rejectedByCode[i.code] ?? 0) + i.rejected;
      seats.push({ entrant, turns: decisions.filter(d => d.status === 'completed').length,
        inputTokens: usage.reduce((n, u) => n + (u.inputTokens ?? 0), 0), outputTokens: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0),
        costUsd: +usage.reduce((n, u) => n + Number(u.costAmount ?? 0), 0).toFixed(6),
        latencyP50Ms: quantile(decisions.filter(d => d.status === 'completed').map(d => d.latencyMs), 0.5),
        latencyP95Ms: quantile(decisions.filter(d => d.status === 'completed').map(d => d.latencyMs), 0.95),
        providerErrors: decisions.filter(d => d.status === 'provider_error').length,
        agentIntents: { submitted: intents.reduce((n, i) => n + i.submitted, 0), accepted: intents.reduce((n, i) => n + i.accepted, 0), rejected: intents.reduce((n, i) => n + i.rejected, 0), rejectedByCode } });
    }
    const replay = t.artifacts.find(a => a.matchId === m.matchId && a.kind === 'replay' && a.availability === 'available');
    return { matchId: m.matchId, seed: m.spec.seed, mapId: m.spec.map.id, mapSeed: m.spec.map.seed, sides, status: m.status, terminalReason: m.outcomes[0]?.reason ?? null, scored: !budgetForfeit,
      outcomes: Object.fromEntries(m.outcomes.map(o => [o.team, o.outcome])), simulatedMs: m.simulatedMs, wallMs: Math.round(m.wallMs ?? 0),
      finalState, seats, replay: replay ? join(live, name, 'artifacts', `${encodeURIComponent(replay.id)}.json`) : null };
  });
  for (const match of matches) for (const seat of match.seats) {
    const total = totals.get(seat.entrant) ?? { matches: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, providerErrors: 0, rejectedIntents: 0 };
    total.matches++; total.inputTokens += seat.inputTokens; total.outputTokens += seat.outputTokens; total.costUsd = +(total.costUsd + seat.costUsd).toFixed(6);
    total.turns += seat.turns; total.providerErrors += seat.providerErrors; total.rejectedIntents += seat.agentIntents.rejected;
    totals.set(seat.entrant, total);
  }
  const mean = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  pairings.push({ id: name, kind: entrants.includes(BOT) ? 'vs-bot' : 'model-vs-model', entrants, seriesId: results.seriesId, seriesState: results.state,
    record, averageSimulatedMs: mean(matches.map(m => m.simulatedMs)), averageWallMs: mean(matches.map(m => m.wallMs)), matches,
    results: join(live, name, 'results.json') });
}

const summary = {
  format: 'ac.frontier-live-summary', version: 1, generatedAt: new Date().toISOString(),
  pricing: { ...PRICING, note: 'Per-seat costUsd is the runner estimate at these ceiling prices without cache discounts; billedUsd is the OpenRouter key usage delta.' },
  billedUsd: values.billed === undefined ? null : Number(values.billed),
  models: MODELS,
  harness: 'playerthree-bench live track; OpenAI Responses provider via OpenRouter; provider-default reasoning; maxOutputTokens 4096; Surface seat live, other planes standard bot; realtime speed 1',
  modelVsModel: pairings.filter(p => p.kind === 'model-vs-model'),
  vsBot: pairings.filter(p => p.kind === 'vs-bot'),
  // Round-robin pairings and bot baselines without an exported series (not run within the spending cap).
  notPlayed: Object.keys(MODELS).flatMap((a, i, ids) => [...ids.slice(i + 1), BOT].map(b => [a, b]))
    .filter(([a, b]) => !pairings.some(p => p.entrants.includes(a!) && p.entrants.includes(b!))),
  totals: Object.fromEntries(totals),
};
await writeFile(join(live, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${pairings.length} pairing(s) → ${join(live, 'summary.json')}`);
