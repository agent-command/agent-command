/**
 * Sim benchmark: ~600 entities in permanent contact on every plane (unkillable, so the count stays put),
 * diggers mining, armies marching. Prints one JSON line. Run with plain Node (the production runtime):
 *   node test/bench.ts [ticks per trial] [terrain preset] [fixture: battle | duel4 | ffa4 | vision]
 */
import { DEFAULT_TERRAIN, PLANES, TERRAIN_PRESETS, type TerrainPreset, type UnitKind } from '../src/rules/contract.ts';
import { createGame } from '../src/agent/adapter.ts';
import { applyIntent } from '../src/agent/intents.ts';
import { namedMap } from '../src/maps/maps.ts';
import { Sim } from '../src/sim/sim.ts';
import { NEUTRAL, rotX, rotY } from '../src/util/teams.ts';

const ticks = Number(process.argv[2] ?? 300);
const terrain = (process.argv[3] ?? DEFAULT_TERRAIN) as TerrainPreset;
/**
 * Fixture: `battle` (default; two armies on the S48 terrain preset), or the linear-scaling pair on `four_corners`
 * (M64, DESIGN §15.14): `duel4` (two armies on opposite slots) and `ffa4` (four armies), the same units per army.
 */
const fixture = process.argv[4] ?? 'battle';
if (!TERRAIN_PRESETS.includes(terrain)) throw new Error(`unknown terrain preset ${terrain}`);
if (fixture === 'vision') {
  // computeVision's clear + stamp pass over the same 1200 bodies split among 2, 3 or 4 armies (vision groups): with
  // one bit per group in shared bit-planes its cost must not grow with the group count (DESIGN §15.14).
  const slots = [[0, 2], [0, 1, 2], [0, 1, 2, 3]];
  const ms = slots.map((taken) => {
    const v = new Sim(31, {}, namedMap('four_corners')!, taken.map((slot, i) => ({ slot, colour: (['blue', 'red', 'green', 'violet'] as const)[i]! })));
    const per = 1200 / taken.length;
    const kinds: [UnitKind, 'depths' | 'surface' | 'sky' | 'orbit'][] = [['digger', 'depths'], ['trooper', 'surface'], ['interceptor', 'sky'], ['solar', 'orbit']];
    for (const army of v.allArmies) for (let i = 0; i < per; i++) v.spawnUnit(army, kinds[i % 4]![0], kinds[i % 4]![1]);
    let j = 0;
    for (const e of v.ents) if (e.side !== NEUTRAL && e.kind !== 'spire' && e.plane !== 'depths') { e.x = 4 + ((j * 7.31) % 56); e.y = 4 + ((j++ * 3.77) % 56); }
    for (let i = 0; i < 50; i++) v.stampVision();
    const best = [0, 1, 2].map(() => {
      const cpu0 = process.threadCpuUsage();
      for (let i = 0; i < ticks; i++) v.stampVision();
      const cpu = process.threadCpuUsage(cpu0);
      return (cpu.user + cpu.system) / 1000 / ticks;
    });
    return Math.min(...best);
  });
  console.log(JSON.stringify({ groups: slots.map((t) => t.length), stampMs: ms }));
  process.exit(0);
}
const s = fixture === 'battle' ? createGame({ seed: 31, options: { terrain } }).sim
  : new Sim(31, {}, namedMap('four_corners')!, fixture === 'ffa4'
    ? [{ slot: 0, colour: 'blue' }, { slot: 1, colour: 'red' }, { slot: 2, colour: 'green' }, { slot: 3, colour: 'violet' }]
    : [{ slot: 0, colour: 'blue' }, { slot: 2, colour: 'red' }]);
const plan: [UnitKind, number][] = [
  ['digger', 40],
  ['sapper', 10],
  ['trooper', 90],
  ['tank', 40],
  ['flak', 20],
  ['interceptor', 50],
  ['bomber', 15],
  ['solar', 20],
  ['tug', 5],
];
for (const army of s.allArmies) {
  for (const [kind, n] of plan) {
    const plane = kind === 'digger' || kind === 'sapper' ? 'depths' : kind === 'interceptor' || kind === 'bomber' ? 'sky' : kind === 'solar' || kind === 'tug' ? 'orbit' : 'surface';
    for (let i = 0; i < n; i++) s.spawnUnit(army, kind, plane);
  }
}
// Spread the bodies over a centred square (S48 battle: the old 4..44) so every plane is in permanent contact. The
// four_corners pair is density-equal: four armies fill 4..60, two armies a square of half that area, so both have the
// same bodies per tile and the four-army cost measures more armies, not a twice-as-crowded map (contact work per body
// grows with the bodies around it).
const span = fixture === 'battle' ? s.size - 8 : (s.size - 8) * Math.sqrt(s.allArmies.length / 4);
const from = (s.size - span) / 2;
let k = 0;
for (const e of s.ents) {
  if (e.side === NEUTRAL) continue;
  e.hp = 1e9;
  if (e.kind === 'spire' || e.plane === 'depths') continue;
  e.x = from + ((k * 7.31) % span);
  e.y = from + ((k++ * 3.77) % span);
}
s.step();
// Every army fight-moves to the far corner of its own frame (S48: blue to (40, 40), red to (8, 8)).
const goal = s.size - 8;
for (const army of s.allArmies) {
  const frame = s.armyFrame[army]!;
  for (const role of PLANES) {
    const units = s.ents.filter((e) => e.side === army && e.plane === role && e.kind !== 'spire');
    for (let i = 0; i < units.length; i += 64) {
      const batch = units.slice(i, i + 64);
      if (role === 'depths') applyIntent(s, army, role, { kind: 'mine', units: batch.filter((e) => e.kind === 'digger').map((e) => `e_${e.id}`) });
      else applyIntent(s, army, role, { kind: 'move', units: batch.map((e) => `e_${e.id}`), x: rotX(frame, goal, goal, s.size), y: rotY(frame, goal, goal, s.size), mode: 'fight' });
    }
  }
}
const start = s.ents.length;
for (let i = 0; i < 50; i++) s.step(); // JIT warm-up
// Three consecutive trials; the best one is the least disturbed by other processes on the machine.
// The cost metric is CPU time of the thread running the sim (process.threadCpuUsage): time descheduled by a loaded
// machine and V8's helper threads (concurrent GC, background compilation) do not count. Wall time is information only:
// on a shared machine it mostly measures the neighbours.
const trials = [0, 1, 2].map(() => {
  const times: number[] = [];
  const cpu0 = process.threadCpuUsage();
  const proc0 = process.cpuUsage();
  const wall0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    const a = performance.now();
    s.step();
    times.push(performance.now() - a);
  }
  const wallTotal = performance.now() - wall0;
  const cpu = process.threadCpuUsage(cpu0);
  const proc = process.cpuUsage(proc0);
  times.sort((a, b) => a - b);
  return {
    cpuMs: (cpu.user + cpu.system) / 1000 / ticks,
    /** Share of the trial's wall time the sim thread was on a CPU (1 = never descheduled). */
    onCpu: (cpu.user + cpu.system) / 1000 / wallTotal,
    wallMs: times.reduce((a, b) => a + b, 0) / times.length,
    p95Ms: times[Math.floor(times.length * 0.95)]!,
    maxMs: times[times.length - 1]!,
    /** Whole-process CPU per tick (adds V8's GC and compiler threads): information only. */
    procCpuMs: (proc.user + proc.system) / 1000 / ticks,
  };
});
const best = trials.reduce((a, b) => (b.cpuMs < a.cpuMs ? b : a));
console.log(JSON.stringify({ entities: start, entitiesAfter: s.ents.length, ticks, ...best, trialCpuMs: trials.map((t) => t.cpuMs) }));
