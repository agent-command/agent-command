#!/usr/bin/env node
/** Render the paired short sweep without replaying matches. */
import { readFileSync, writeFileSync } from 'node:fs';
import { ARMIES, TICK_RATE, type ArmyId, type LodeSideMetrics } from '@agent-command/game';
import { evaluate } from './guardrails.ts';
import type { ArchivedMatch, SweepResult } from './report.ts';
import { quantile, uniformFit, wilson } from './stats.ts';

type Result = SweepResult & { gameSourceSha256: string };
const [baselineFile, currentFile, outFile] = process.argv.slice(2);
if (!baselineFile || !currentFile || !outFile) throw new Error('usage: node tools/balance/src/lode-report.ts <baseline.json> <current.json> <report.md>');
const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Result;
const current = JSON.parse(readFileSync(currentFile, 'utf8')) as Result;
const preparation = JSON.parse(readFileSync(process.argv[5] ?? 'docs/balance/lode-zones-preparation.json', 'utf8')) as {
  presets: { terrain: string; maps: number; cliffPreparedMaps: number; preparedPairs: number; cliffPreparedPairs: number; fallbackPairs: number; missingPairs: number }[];
};
const [baselineKeys, currentKeys] = [baseline, current].map((r) => r.matches.map((m) => `${m.set}/${m.seed}`).sort().join('\n'));
if (baselineKeys !== currentKeys) throw new Error('Comparison requires matching run sets and seeds');
/** Every army of the compared run sets, in slot order. */
const armies: ArmyId[] = ARMIES.filter((army) => [...baseline.sets, ...current.sets].some((s) => s.slots.includes(army)));
const fmt = (n: number): string => n.toFixed(2);
const pct = (n: number): string => `${(100 * n).toFixed(1)}%`;
const table = (headers: string[], rows: (string | number)[][]): string => [headers, headers.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');
const sum = (ms: ArchivedMatch[], army: ArmyId, key: keyof LodeSideMetrics): number => ms.reduce((n, m) => {
  const side = m.lodes?.sides[army];
  if (!side) throw new Error(`Missing lode measurements: ${m.set}/${m.seed} ${army}`);
  return n + side[key];
}, 0);
const economyRows = (label: string, ms: ArchivedMatch[]): (string | number)[][] => armies.map((army) => {
  const alloy = sum(ms, army, 'lodeAlloy');
  const earned = sum(ms, army, 'earnedAlloy');
  return [label, army, fmt(alloy), fmt(earned), earned ? pct(alloy / earned) : 'n/a', sum(ms, army, 'headframesBuilt'), sum(ms, army, 'headframesLost'), sum(ms, army, 'flankBuilt'), sum(ms, army, 'flankLost'), sum(ms, army, 'flankSitesLost')];
});
const pacing = (label: string, ms: ArchivedMatch[]): (string | number)[] => {
  const lengths = ms.map((m) => m.ticks / TICK_RATE / 60);
  const wins = armies.map((army) => ms.filter((m) => m.winner === army).length);
  const decisive = wins.reduce((a, b) => a + b, 0);
  const ci = wilson(wins[0]!, decisive);
  return [label, ms.length, `${wins.join('/')}/${ms.length - decisive}`, ms.filter((m) => m.capped).length, fmt(quantile(lengths, 0.5)), `${fmt(quantile(lengths, 0.25))}–${fmt(quantile(lengths, 0.75))}`, `${fmt(Math.min(...lengths))}–${fmt(Math.max(...lengths))}`, decisive ? `${pct(ci.p)} [${pct(ci.lo)}–${pct(ci.hi)}]` : 'n/a [0–100%]', uniformFit(wins).toFixed(4)];
};
const out = [
  '# Lode zones: short paired balance comparison',
  '',
  'Six seeds (1001–1006) × open/ridges/canyons × standard/veteran mirrors: **36 matches per revision, 72 total**. Every seat uses that revision’s built-in bot; no policies, cheats, custom economy, shorter time cap, ladder or strategy probes. This is diagnostic evidence, not full balance acceptance.',
  '',
  '## Findings',
  '',
  ...armies.map((army) => `- **${army}:** lode alloy share ${pct(sum(baseline.matches, army, 'lodeAlloy') / sum(baseline.matches, army, 'earnedAlloy'))} → ${pct(sum(current.matches, army, 'lodeAlloy') / sum(current.matches, army, 'earnedAlloy'))}; flank Headframes built/lost ${sum(baseline.matches, army, 'flankBuilt')}/${sum(baseline.matches, army, 'flankLost')} → ${sum(current.matches, army, 'flankBuilt')}/${sum(current.matches, army, 'flankLost')}. Baseline has no outcrops in the measured flank region, so its zero is absence of opportunity, not evidence its bots refuse flanks.`),
  `- Pooled median match length ${fmt(quantile(baseline.matches.map((m) => m.ticks / TICK_RATE / 60), 0.5))} → ${fmt(quantile(current.matches.map((m) => m.ticks / TICK_RATE / 60), 0.5))} minutes. Current unchanged guardrail failures: ${evaluate(current.sets).filter((g) => !g.pass).map((g) => `${g.id} ${g.set} (${g.value})`).join('; ') || 'none in the exercised mirror sets'}.`,
  `- Current run sets with no completed flank Headframe on any army: ${current.sets.filter((s) => armies.every((army) => sum(current.matches.filter((m) => m.set === s.key), army, 'flankBuilt') === 0)).map((s) => s.key).join(', ') || 'none'}. Flank engagement is therefore reported per terrain and level rather than inferred from placement alone.`,
  '- Slot-bias conclusions remain inconclusive: many matches draw and every six-seed set is underpowered at the unchanged Bonferroni threshold. Discovery/last-seen lode state, scouting, flank tactics and terrain preparation are included in the current revision; this comparison does not isolate one of those changes.',
  '',
  '## Revisions and reproduction',
  '',
  ...([['Baseline', baseline, baselineFile], ['Current', current, currentFile]] as const).map(([label, r, file]) => `- **${label}:** game-source SHA256 \`${r.gameSourceSha256}\`; Node ${r.node}; ${r.workers} workers; ${fmt(r.wallMs / 60000)} min wall. Raw data: [${file.split('/').pop()}](${file.split('/').pop()}). The JSON retains the game-source diff if uncommitted.`),
  '',
  'Run from the isolated checkout of each revision with the same measurement harness copied in. Never point its game dependency at another worktree; the runner rejects that. The baseline is a detached checkout of the revision being compared against.',
  '',
  '```sh',
  'cd <current-checkout>',
  'git worktree add --detach ../ac-lodes-baseline <baseline-revision>',
  'cp tools/balance/src/{lodes,lode-sweep,record,trace,metrics}.ts ../ac-lodes-baseline/tools/balance/src/',
  'cd ../ac-lodes-baseline',
  'pnpm install --offline --ignore-scripts --frozen-lockfile',
  'node tools/balance/src/lode-sweep.ts --label lode-zones-baseline --workers 2 --out <current-checkout>/docs/balance',
  '# In current worktree, after implementation is frozen:',
  'cd <current-checkout>',
  'node tools/balance/src/lode-sweep.ts --label lode-zones-current --workers 2',
  'node tools/balance/src/lode-preparation.ts',
  'node tools/balance/src/lode-report.ts docs/balance/lode-zones-baseline.json docs/balance/lode-zones-current.json docs/balance/lode-zones.md',
  '```',
  '',
  '## Metric definitions and limitations',
  '',
  '- **Lode alloy:** cumulative `sim.armies[army].stats.lodeAlloy`: delivered ore mined from any lode pocket (including enemy-opened pockets), plus Headframe trickles. It is all lodes, not only flank lodes. Undelivered carried ore is excluded.',
  '- **Earned alloy:** sum of the sim’s current per-tick `income` ring entry after every step: all digger deliveries plus Spire and Headframe trickles. Starting stock, refunds and spending are excluded. **Lode share** is total lode alloy / total earned alloy, pooled across matches for each army (not the average of per-match percentages). Counters remain unrounded in JSON.',
  '- **Flank:** outcrop cell centre within Euclidean distance 9 of (40,8) or (8,40), and absolute distance-to-base skew ≤10 using bases (8,8)/(40,40). This fixed geographic classifier applies to both revisions, independently of `rich` or zone metadata. Old central contested lodes do not become flanks merely because they are rich. Distances use cell centres (cell x+0.5, y+0.5), as the map generator does.',
  '- **Built/lost:** completed Headframes and subsequently destroyed completed Headframes, credited to their owning army; rebuilds count again. Unfinished flank sites destroyed before completion are reported separately. Queue requests and cancellations are not builds or losses. Counts are totals, not per-match means. Deaths do not require kill attribution.',
  `- **Length:** ticks / 20 / 60 game minutes; interpolated quartiles. Cap count means every Surface Spire still stands when the match ends (normal 30-minute cap). Wins/draws are wins per army in slot order (${armies.join(', ')}), then draws.`,
  `- **Slot bias:** ${armies[0]} wins / decisive matches, 95% Wilson interval, and the goodness of fit of wins per slot against equal shares (two slots: exact two-sided binomial p against 50%). Existing guardrails remain unchanged: per-revision six-mirror Bonferroni α=0.05/6, and competent-mirror median 10–15 minutes. With six decisive matches, even 6–0 has p=0.03125: no individual set can reject at α=0.00833. A passing slot-bias check here is weak evidence, not proof of fairness. Pooled bias is descriptive: terrain/level runs reuse map seeds and are not independent samples.`,
  '- No novice/ladder/probe evidence was collected; their guardrails are unexercised, not passed. These paired revisions may contain other bot or game changes; results describe the combined revision difference, not a causal estimate of lode placement alone. No package test, lint, format or build run is part of this measurement.',
  '',
  '## Pooled economy and Headframes',
  '',
  table(['Revision', 'Army', 'Lode alloy', 'Earned alloy', 'Lode share', 'All HF built', 'All HF lost', 'Flank built', 'Flank lost', 'Flank sites lost'], [...economyRows('baseline', baseline.matches), ...economyRows('current', current.matches)]),
  '',
  '## Match length and slot bias',
  '',
  table(['Revision / set', 'N', 'Wins/draws', 'Capped', 'Median min', 'Q25–Q75', 'Min–max', `${armies[0]} decisive [95% CI]`, 'Exact p'], [pacing('baseline pooled', baseline.matches), pacing('current pooled', current.matches), ...baseline.sets.flatMap((s) => [pacing(`baseline ${s.key}`, baseline.matches.filter((m) => m.set === s.key)), pacing(`current ${s.key}`, current.matches.filter((m) => m.set === s.key))])]),
  '',
  '## Economy by terrain and level',
  '',
  table(['Revision / set', 'Army', 'Lode alloy', 'Earned alloy', 'Lode share', 'All HF built', 'All HF lost', 'Flank built', 'Flank lost', 'Flank sites lost'], baseline.sets.flatMap((s) => [...economyRows(`baseline ${s.key}`, baseline.matches.filter((m) => m.set === s.key)), ...economyRows(`current ${s.key}`, current.matches.filter((m) => m.set === s.key))])),
  '',
  '## Unchanged guardrails',
  '',
  table(['Revision', 'Guardrail', 'Set', 'Result', 'Actual', 'Target'], ([['baseline', baseline], ['current', current]] as const).flatMap(([label, r]) => evaluate(r.sets).map((g) => [label, g.id, g.set, g.pass ? 'pass' : '**FAIL**', g.value, g.target]))),
  '',
  '## Outcrop availability',
  '',
  'Counts below pool all 36 maps per revision (the same terrain/seed is repeated at two bot levels). Raw JSON records every outcrop coordinate, richness and load count. Availability is distinct from successful construction.',
  '',
  table(['Revision', 'All outcrops', 'Flank outcrops', 'Rich outcrops'], ([['baseline', baseline], ['current', current]] as const).map(([label, r]) => { const ls = r.matches.flatMap((m) => m.lodes!.outcrops); return [label, ls.length, ls.filter((l) => l.flank).length, ls.filter((l) => l.rich).length]; })),
  '',
  '## Home terrain preparation (current generator)',
  '',
  'Separate static-map measurement on seeds **1–100**, every terrain, using `generateWorld(seed, generateTerrain(seed, terrain, map), map)`: terrain → depths → magma → ore → faults → features → islands/orbit, with an independent stream derived from the raw map seed for each stage. Counts are **mirrored pairs** (two outcrops per pair), not changed terrain cells. `cliffPreparedMaps` counts seeds with at least one home pair requiring cliff-to-ground preparation; `preparedPairs` includes all terrain preparation. `fallbackPairs` counts home pairs placed beyond the preferred maximum radius. This does not measure in-game Headframe construction or certify every possible seed.',
  '',
  'Raw per-seed summaries: [lode-zones-preparation.json](lode-zones-preparation.json).',
  '',
  table(['Terrain', 'Maps', 'Maps needing cliff prep', 'Prepared pairs', 'Cliff-prepared pairs', 'Fallback pairs', 'Missing home pairs'], preparation.presets.map((p) => [p.terrain, p.maps, p.cliffPreparedMaps, p.preparedPairs, p.cliffPreparedPairs, p.fallbackPairs, p.missingPairs])),
  '',
];
writeFileSync(outFile, out.join('\n'));
process.stdout.write(`Wrote ${outFile}\n`);
