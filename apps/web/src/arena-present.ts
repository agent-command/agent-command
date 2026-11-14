import type { ResultsSummary } from 'playerthree/arena';

export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'Not reported';
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function availableReplays(result: ResultsSummary) {
  return result.tables.artifacts.filter((artifact) => artifact.availability === 'available' && artifact.kind === 'replay');
}

export type SeriesPoint = { tick: number; value: number };
export function chartPoints(points: readonly SeriesPoint[]): string {
  if (!points.length) return '';
  let minTick = points[0]!.tick, maxTick = minTick, minValue = 0, maxValue = 0;
  for (const point of points) {
    minTick = Math.min(minTick, point.tick); maxTick = Math.max(maxTick, point.tick);
    minValue = Math.min(minValue, point.value); maxValue = Math.max(maxValue, point.value);
  }
  const span = Math.max(1, maxTick - minTick);
  const range = Math.max(1, maxValue - minValue);
  return points.map((point) => `${4 + (point.tick - minTick) / span * 292},${96 - (point.value - minValue) / range * 92}`).join(' ');
}
