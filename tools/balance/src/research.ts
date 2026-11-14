/** Paired research-content sweep. Run with Node: research.ts [checkout-root] [output.json] [seconds=720].
 * The checkout argument lets this exact recorder compare a baseline without changing its source tree.
 * Six seeds × standard/veteran × three presets of duels; capped matches are not classified as wins.
 */
import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NEUTRAL, TICK_RATE, type ArmyId, type playBotMatch as Runner } from '@agent-command/game';
import { layoutArmies } from './spec.ts';

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../../../', import.meta.url)));
const output = process.argv[3];
const seconds = Number(process.argv[4] ?? 720);
// The checkout is selected at runtime; a static import would always measure this branch, including the baseline run.
const { playBotMatch } = await import(pathToFileURL(resolve(root, 'packages/game/src/bots/play.ts')).href) as { playBotMatch: typeof Runner };
const ARMIES = layoutArmies('duel');
const perArmy = <T>(make: () => T): Record<ArmyId, T> => Object.fromEntries(ARMIES.map((army) => [army, make()])) as Record<ArmyId, T>;
const rows = [];
for (const level of ['standard', 'veteran'] as const) for (const terrain of ['open', 'ridges', 'canyons'] as const) for (let seed = 1; seed <= 6; seed++) {
  const metrics = () => ({ researchRequested: null as number | null, researchCompleted: null as number | null, lancers: 0, lancerShots: 0, ascents: 0, ascentShots: 0, bombers: 0, bomberShots: 0, orbitDamageTaken: 0 });
  const armies = perArmy(metrics);
  const born = new Set<number>();
  const result = playBotMatch({
    seed, levels: perArmy(() => level), options: { terrain }, maxTicks: seconds * 20,
    onIntent: (game, seat, intent, result) => {
      if (!result.ok) return;
      const m = armies[seat.team];
      if (intent.kind === 'research' && m.researchRequested === null) m.researchRequested = game.tick / 20;
      if (intent.kind === 'ascend') m.ascents += intent.units.length;
    },
    onTick: (game) => {
      const sim = game.sim;
      for (const e of sim.ents) {
        if (e.side === NEUTRAL || born.has(e.id)) continue;
        born.add(e.id);
        if (e.kind === 'lancer') armies[sim.armyIds[e.side]!].lancers++;
        if (e.kind === 'bomber') armies[sim.armyIds[e.side]!].bombers++;
      }
      for (const { fx } of sim.fx) {
        if (fx.tick !== game.tick || fx.kind !== 'shot' || fx.side === undefined || fx.side === NEUTRAL) continue;
        const m = armies[sim.armyIds[fx.side]!];
        if (fx.subject === 'lancer') m.lancerShots++;
        if (fx.subject === 'interceptor' && fx.plane === 'orbit') m.ascentShots++;
        if (fx.subject === 'bomber') m.bomberShots++;
      }
      if (game.tick % TICK_RATE === 0) for (const army of ARMIES) {
        if (armies[army].researchCompleted !== null) continue;
        const research = game.observe({ team: army, role: 'sky' }, game.tick).research;
        if (research?.completed.includes('ascent_thrusters')) armies[army].researchCompleted = game.tick / 20;
      }
    },
  });
  for (const army of ARMIES) {
    const segment = result.game.sim.armies[result.game.sim.armyIndex(army)]!.spire.orbit;
    armies[army].orbitDamageTaken = segment.maxHp - Math.max(0, segment.hp);
  }
  const row = { level, terrain, seed, seconds: result.ticks / 20, outcome: result.outcome, armies };
  rows.push(row);
  process.stderr.write(`${level} ${terrain} ${seed}: ${ARMIES.map((army) => `${army} ${row.outcome[army]}`).join(', ')} ${row.seconds}s\n`);
}
const summary = [];
for (const level of ['standard', 'veteran']) for (const terrain of ['open', 'ridges', 'canyons']) {
  const group = rows.filter((r) => r.level === level && r.terrain === terrain);
  const sum = { level, terrain, matches: group.length, wins: perArmy(() => 0), draws: 0, capped: 0, researchCompleted: 0, researchMedianSeconds: null as number | null, lancers: 0, lancerShots: 0, ascents: 0, ascentShots: 0, bombers: 0, bomberShots: 0, orbitDamageTaken: perArmy(() => 0) };
  const completion: number[] = [];
  for (const r of group) {
    const winner = ARMIES.find((army) => r.outcome[army] === 'win');
    if (winner) sum.wins[winner]++; else if (ARMIES.some((army) => r.outcome[army] === 'draw')) sum.draws++; else sum.capped++;
    for (const army of ARMIES) {
      const m = r.armies[army];
      if (m.researchCompleted !== null) { sum.researchCompleted++; completion.push(m.researchCompleted); }
      sum.lancers += m.lancers; sum.lancerShots += m.lancerShots; sum.ascents += m.ascents; sum.ascentShots += m.ascentShots; sum.bombers += m.bombers; sum.bomberShots += m.bomberShots;
      sum.orbitDamageTaken[army] += m.orbitDamageTaken;
    }
  }
  completion.sort((a, b) => a - b);
  if (completion.length) sum.researchMedianSeconds = (completion[Math.floor((completion.length - 1) / 2)]! + completion[Math.floor(completion.length / 2)]!) / 2;
  summary.push(sum);
}
// The measured checkout relative to this one (`.` for itself): committed reports must not carry machine paths.
const report = JSON.stringify({ root: relative(fileURLToPath(new URL('../../../', import.meta.url)), root) || '.', seconds, seeds: [1, 2, 3, 4, 5, 6], summary, rows }, null, 2);
if (output) writeFileSync(output, report + '\n'); else console.log(report);
