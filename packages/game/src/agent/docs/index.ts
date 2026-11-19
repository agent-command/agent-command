/**
 * Every game briefing topic in index order (agents fetch them with game_briefing {topic}).
 */
import { COMBAT_TOPICS as C } from './combat.ts';
import { ECONOMY_TOPICS as E } from './economy.ts';
import { PLANE_TOPICS as P } from './planes.ts';
import type { Topic } from './shared.ts';
import { WORLD_TOPICS as W } from './world.ts';

export const TOPICS: Record<string, Topic> = {
  'match-rules': E['match-rules'],
  maps: E.maps,
  spire: E.spire,
  queue: E.queue,
  structures: E.structures,
  'build-radius': E['build-radius'],
  resources: E.resources,
  lodes: E.lodes,
  geothermal: E.geothermal,
  units: C.units,
  damage: C.damage,
  combat: C.combat,
  vision: C.vision,
  'cross-plane': C['cross-plane'],
  collapses: C.collapses,
  rocks: C.rocks,
  terrain: W.terrain,
  weather: W.weather,
  research: E.research,
  ascent: E.ascent,
  designations: W.designations,
  alerts: W.alerts,
  'mandate-and-messages': W['mandate-and-messages'],
  sequences: W.sequences,
  'depths/digging': P['depths/digging'],
  'depths/bulkheads': P['depths/bulkheads'],
  'depths/wardens': P['depths/wardens'],
  'surface/army': P['surface/army'],
  'surface/building': P['surface/building'],
  'surface/front': P['surface/front'],
  'surface/mooring': P['surface/mooring'],
  'sky/islands': P['sky/islands'],
  'sky/hardpoints': P['sky/hardpoints'],
  'sky/ore': P['sky/ore'],
  'sky/aerie': P['sky/aerie'],
  'orbit/fleet': P['orbit/fleet'],
  'orbit/abilities': P['orbit/abilities'],
  'orbit/economy': P['orbit/economy'],
  'orbit/derelict': P['orbit/derelict'],
};
