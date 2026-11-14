/**
 * Strategy probes: JS policies (PlayerThree policy ABI, sandboxed like any agent's) that force one strategy on the
 * seats they drive. The rest of the probe's army plays as built-in bots of the same level as the opponents, so a
 * probe's win rate measures the strategy, not a skill gap. Guardrail: no probe above 1.3× the uniform share against
 * its own level (65% in a duel, 32.5% in four-army FFA; DESIGN §11.5, §15.13).
 */
import { readFileSync } from 'node:fs';
import type { Plane } from '@agent-command/game';
import type { Layout } from './spec.ts';

export interface Probe {
  id: string;
  /** the strategy it forces, one line */
  strategy: string;
  /** policy file under tools/balance/probes/ per driven seat */
  seats: Partial<Record<Plane, string>>;
  /** layouts the strategy is meaningful in (and the standard plan of each layout runs) */
  layouts: readonly Layout[];
}

const ANY: readonly Layout[] = ['duel', 'ffa'];

export const PROBES: readonly Probe[] = [
  { id: 'surface-rush', strategy: 'troopers only, all-in waves at the focus Spire from 1:00', seats: { surface: 'surface-rush.js' }, layouts: ANY },
  { id: 'turret-turtle', strategy: 'turret ring around the Spire, defensive army, never attacks', seats: { surface: 'turret-turtle.js' }, layouts: ANY },
  { id: 'sapper-swarm', strategy: 'tunnel into collapse reach of the focus Spire from 0:00, sapper waves every 12 s', seats: { depths: 'sapper-swarm.js' }, layouts: ANY },
  { id: 'asteroid-spam', strategy: 'every alloy into tugs, unpaired drops on the focus Spire', seats: { orbit: 'asteroid-spam.js' }, layouts: ANY },
  { id: 'lancer-night-siege', strategy: 'arrays then Lancers only; at night they siege the focus Orbit segment from its diagonal, past its night detection, with scans', seats: { orbit: 'lancer-night-siege.js' }, layouts: ANY },
  { id: 'volatile-tows', strategy: 'tug-heavy volatile-only strikes with fuse-reachable acquisition; tests live-bomb interception', seats: { orbit: 'volatile-tows.js' }, layouts: ANY },
  { id: 'island-turtle', strategy: '12 interceptors hold every island with relays, never raid', seats: { sky: 'island-turtle.js' }, layouts: ANY },
  { id: 'bomber-raid', strategy: 'bombers only (3 interceptor screen), packs at the focus Spire', seats: { sky: 'bomber-raid.js' }, layouts: ANY },
  { id: 'rail-economy', strategy: '20 diggers on auto-mine, rail the cavern to the centre from 1:00 (exploit-hunt finding)', seats: { depths: 'rail-economy.js' }, layouts: ANY },
  {
    id: 'breach-ambush',
    strategy: 'trooper squads go down from 2:00, tunnel next to the focus base and break out behind its lines',
    seats: { depths: 'breach-ambush-depths.js', surface: 'breach-ambush-surface.js' },
    layouts: ANY,
  },
  // FFA only: with one hostile army they are a plain turtle and a plain rush.
  { id: 'ffa-turtle', strategy: 'defend at home until one hostile army falls, then attack the weakest survivor', seats: { surface: 'ffa-turtle.js' }, layouts: ['ffa'] },
  { id: 'ffa-vulture', strategy: 'always attack the hostile army with the lowest known Spire HP', seats: { surface: 'ffa-vulture.js' }, layouts: ['ffa'] },
];

const DIR = new URL('../probes/', import.meta.url);

export function probeSource(file: string): string {
  return readFileSync(new URL(file, DIR), 'utf8');
}
