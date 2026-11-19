/**
 * The home backdrop's map-only preview over time: the worker's tick-0 view (preview-map.ts buildPreviewView) moved
 * along the map's public schedules, so islands drift on their rings, the sun sweeps Orbit and fog banks travel. Pure
 * formulas only (islandAt, sunAngleAt, the fog paths): no sim, no units, a few dozen small objects per view.
 */
import { islandAt, sunAngleAt } from '@agent-command/game/contract';
import type { MatchView } from './match-view.ts';
import { weatherAt } from './world/weather.ts';

/** Ticks between preview views (4 per second): the renderer interpolates islands and extrapolates the sun between. */
export const PREVIEW_VIEW_TICKS = 5;

/** `base` at `tick`. Island entities lead `base.entities`, index-aligned with `base.islands`. */
export function previewViewAt(base: MatchView, tick: number): MatchView {
  const { match, islands } = base;
  const size = match.rules.map.size;
  const point = { x: 0, y: 0 };
  return {
    ...base,
    tick,
    sun: { angle: sunAngleAt(tick, match.sun.speed) },
    entities: base.entities.map((e, i) => (i < islands.length ? { ...e, ...islandAt(islands[i]!, tick) } : e)),
    weather: {
      ...base.weather,
      fog: base.weather.fog.map((cell, i) => {
        weatherAt(match.fogPaths[i]!, tick, point, size);
        return { x: point.x, y: point.y, radius: cell.radius };
      }),
    },
  };
}
