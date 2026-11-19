/**
 * Per-plane alerts (contract ALERT_KINDS): each plane's timed items, most relevant first. Built only from fields of the
 * same fogged observation or view, so an alert can never reveal more than the data the team already holds.
 */
import { ALERT_COUNT_CAP, ALERTS_PER_PLANE, inChamber, type DerelictGeometry, type FullObservation, type NaturalStorm, type Observation } from '../rules/contract.ts';

type Alert = Observation['alerts'][number];
export type AlertSource = Pick<FullObservation, 'army' | 'spire' | 'schedule' | 'weather' | 'impacts' | 'charges' | 'cracks' | 'tremors' | 'entities' | 'coreLifted' | 'motherLode'>;
/** Hostile Depths units the team sees intruding near its home (Sim.intruders: own vision and own tunnels only). */
export interface Intrusion { x: number; y: number; count: number }
/**
 * A hostile charge the team knows of (its fogged `charges`) whose collapse reaches `count` of its own Surface units and
 * structures; x/y the charge cell centre, `tick` when it blows.
 */
export interface ChargeUnder { x: number; y: number; tick: number; count: number }
const NO_CHARGES: readonly ChargeUnder[] = [];

/** A storm's alert at its current stage: the next stage starts at `tick`. */
const STORM_STAGE: Record<NaturalStorm['stage'], (s: NaturalStorm) => Pick<Alert, 'kind' | 'tick'>> = {
  forecast: (s) => ({ kind: 'storm_forming', tick: s.start }),
  forming: (s) => ({ kind: 'storm_growing', tick: s.grown }),
  mature: (s) => ({ kind: 'storm_peak', tick: s.breaking }),
  breaking: (s) => ({ kind: 'storm_breaking', tick: s.end }),
};

function push(out: Alert[], items: readonly Alert[]): void {
  for (let i = 0; i < items.length && i < ALERTS_PER_PLANE; i++) out.push(items[i]!);
}

/**
 * `ruin`: the public derelict geometry when its chamber irradiates (else null): own ships inside it raise `radiation`,
 * from our own entities and public geometry only. `intrusion`: hostile Depths units seen near our home (null: none).
 * `under`: known hostile charges whose collapse reaches our Surface presence, soonest first.
 */
export function planeAlerts(o: AlertSource, ruin: DerelictGeometry | null = null, intrusion: Intrusion | null = null, under: readonly ChargeUnder[] = NO_CHARGES): Alert[] {
  const out: Alert[] = [];
  // Each plane leads with its own segment under threat (our own segment's hits and HP), then sudden death's countdown
  // (public schedule): each seat's segment takes the extra damage.
  const doom = o.schedule.find((s) => s.kind === 'sudden_death');
  const lead = (plane: Alert['plane']): Alert[] => {
    const lead: Alert[] = [];
    if (o.spire.some((s) => s.plane === plane && s.threatened)) lead.push({ plane, kind: 'segment_threatened' });
    if (doom) lead.push({ plane, kind: 'sudden_death', tick: doom.tick });
    return lead;
  };
  // Depths, threat-first: the Mother Lode's fuse burning (it vents at `tick`; only with a lode cell we know to point
  // at), enemies inside our tunnels near home, enemy digging into our walls (deepest crack first) and known enemy
  // charges (soonest first), then troopers digging up and other movement beneath our surface presence, then known
  // magma floods cooling.
  const depths: Alert[] = lead('depths');
  const lode = o.motherLode;
  if (lode?.ventAt !== undefined && lode.x !== undefined && lode.y !== undefined) depths.push({ plane: 'depths', kind: 'lode_critical', tick: lode.ventAt, x: lode.x, y: lode.y });
  if (intrusion && intrusion.count > 0) depths.push({ plane: 'depths', kind: 'intruder', x: intrusion.x, y: intrusion.y, count: Math.min(ALERT_COUNT_CAP, intrusion.count) });
  const walls = o.cracks.filter((k) => k.enemy).sort((a, b) => b.stage - a.stage);
  for (const k of walls) depths.push({ plane: 'depths', kind: 'wall_dig', x: k.x + 0.5, y: k.y + 0.5, stage: k.stage });
  const charges = o.charges.filter((c) => c.side !== o.army).sort((a, b) => a.tick - b.tick);
  for (const c of charges) depths.push({ plane: 'depths', kind: 'charge', tick: c.tick, x: c.x + 0.5, y: c.y + 0.5 });
  for (const t of o.tremors) if (t.breach) depths.push({ plane: 'depths', kind: 'breach', x: t.x + 0.5, y: t.y + 0.5 });
  const felt = o.tremors.filter((t) => !t.breach);
  if (felt.length) depths.push({ plane: 'depths', kind: 'tremor', x: felt[0]!.x + 0.5, y: felt[0]!.y + 0.5, count: felt.length });
  for (const s of o.schedule) if (s.kind === 'magma_cools') depths.push({ plane: 'depths', kind: 'magma', tick: s.tick, ...(s.x === undefined || s.y === undefined ? {} : { x: s.x, y: s.y }) });
  push(out, depths);
  // Surface, threat-first: known hostile charges about to hole the ground under our units or structures (soonest
  // first: step clear), our forward posts an enemy is taking or fighting over (furthest capture first), then
  // telegraphed drops, soonest landing first.
  const surface: Alert[] = lead('surface');
  for (const c of under) surface.push({ plane: 'surface', kind: 'charge_under', tick: c.tick, x: c.x, y: c.y, count: Math.min(ALERT_COUNT_CAP, c.count) });
  const posts = o.entities.filter((e) => e.kind === 'post' && e.side === o.army && (e.state === 'capturing' || e.state === 'contested'));
  posts.sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0));
  for (const p of posts) surface.push({ plane: 'surface', kind: 'post_contested', x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 });
  for (const i of o.impacts.toSorted((a, b) => a.tick - b.tick)) surface.push({ plane: 'surface', kind: 'drop', tick: i.tick, x: i.x, y: i.y, side: i.side });
  push(out, surface);
  // Sky, threat-first: our islands an enemy is taking or fighting over (furthest capture first), then storms in the
  // order they form, each at its current life stage (live storms formed before any forecast one).
  const sky: Alert[] = lead('sky');
  const contested = o.entities.filter((e) => e.kind === 'island' && e.side === o.army && (e.state === 'capturing' || e.state === 'contested'));
  contested.sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0));
  // At the island's cell centre: views and observations quantize entity positions on different grids.
  for (const i of contested) sky.push({ plane: 'sky', kind: 'island_contested', x: Math.floor(i.x) + 0.5, y: Math.floor(i.y) + 0.5 });
  const storms = [...o.weather.storms, ...o.weather.forecast].sort((a, b) => a.start - b.start);
  for (const s of storms) sky.push({ plane: 'sky', ...STORM_STAGE[s.stage](s), x: s.x, y: s.y });
  push(out, sky);
  // Orbit, threat-first: our ships irradiated in the derelict chamber, the core out of the ruin under tow (a strike or a
  // meltdown is coming), then the next rocks.
  const orbit: Alert[] = lead('orbit');
  if (ruin) {
    const hot = o.entities.filter((e) => e.side === o.army && e.plane === 'orbit' && e.kind !== 'spire' && inChamber(ruin, e.x - ruin.x, e.y - ruin.y));
    if (hot.length) orbit.push({ plane: 'orbit', kind: 'radiation', x: ruin.x, y: ruin.y, count: Math.min(ALERT_COUNT_CAP, hot.length) });
  }
  if (o.coreLifted) orbit.push({ plane: 'orbit', kind: 'core_lifted', tick: o.coreLifted.tick, x: o.coreLifted.x, y: o.coreLifted.y, side: o.coreLifted.side });
  for (const s of o.schedule) if (s.kind === 'asteroid_spawn') orbit.push({ plane: 'orbit', kind: 'rocks', tick: s.tick });
  push(out, orbit);
  return out;
}
