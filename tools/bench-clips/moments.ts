/**
 * The benchmark clip moments (moments.json): one per model card, each a tick window of one recorded campaign match.
 * BENCH_CLIPS_CAMPAIGN: the downloaded campaign root (per model `<model>/results/run-1/{results.json,replays/}`).
 * BENCH_CLIPS_WORK: scratch for the frame dumps and raw frames (default `tmp/bench-clips/` at the repo root).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plane } from '../../packages/game/src/rules/contract.ts';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Ticks dumped and rendered before the moment so interpolation, fog and in-flight effects have settled. */
export const WARM_TICKS = 30;
/** Ticks dumped past the moment: the client draws a few ticks behind its newest snapshot (entities.ts delay). */
export const TAIL_TICKS = 10;

/** Camera framing: tile focus, distance in tiles of a 48 map, yaw/pitch in radians (camera.ts CameraRig). */
export interface Shot { x: number; y: number; dist: number; yaw?: number; pitch?: number }

export interface Moment {
  release: string;
  model: string;
  /** Campaign-relative run directory holding results.json and replays/. */
  run: string;
  matchId: string;
  /** Inclusive tick window shown (20 ticks per second). */
  from: number;
  to: number;
  plane: Plane;
  /** Framing at `from`; `end` (optional) is the framing at `to`, eased between. */
  camera: Shot;
  end?: Shot;
  caption: string;
}

export function loadMoment(id: string): Moment & { replayPath: string; resultsPath: string } {
  const all = JSON.parse(readFileSync(new URL('./moments.json', import.meta.url), 'utf8')) as { campaign: string; moments: Record<string, Moment> };
  const moment = all.moments[id];
  if (!moment) throw new Error(`no moment ${id} in moments.json`);
  const campaign = process.env.BENCH_CLIPS_CAMPAIGN ?? all.campaign;
  const run = join(campaign, moment.run);
  // P3 stores each replay artifact under its URI-encoded artifact id (`<matchId>/replay`).
  return { ...moment, replayPath: join(run, 'replays', `${encodeURIComponent(`${moment.matchId}/replay`)}.json`), resultsPath: join(run, 'results.json') };
}

export function momentDir(id: string): string {
  return join(process.env.BENCH_CLIPS_WORK ?? join(ROOT, 'tmp/bench-clips'), id);
}
