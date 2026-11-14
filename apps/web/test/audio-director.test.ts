import { describe, expect, it } from 'vitest';
import { createGame } from '@agent-command/game';
import { CELL, UPGRADE_IDS, VISION_BITS_PER_WORD, type Entity, type Fx, type GameEvent, type View } from '@agent-command/game/contract';
import { AudioDirector, activityOf, audibleFx, fxSound, matchSeed, seen, shotSound, type AudioSink, type Listener } from '../src/audio/director.ts';
import { deathProfile, wreckFallMs } from '../src/world/death-profiles.ts';
import type { ActivityId, AlertCue, AmbienceId } from '../src/audio/catalog.ts';

const game = createGame({ seed: 7 });
const base = game.view('nw');
const size = game.sim.size;
const VISION_WORDS = Math.ceil(size * size / VISION_BITS_PER_WORD);
const ALL = (1 << 30) - 1;
const vision = (bits: number): View['vision'] => ({
  depths: new Array<number>(VISION_WORDS).fill(bits), surface: new Array<number>(VISION_WORDS).fill(bits),
  sky: new Array<number>(VISION_WORDS).fill(bits), orbit: new Array<number>(VISION_WORDS).fill(bits),
});

function view(tick: number, patch: Partial<View> = {}): View {
  return { ...base, tick, fx: [], events: [], alerts: [], entities: [], vision: vision(ALL), research: { ...base.research, completed: [] }, ...patch };
}

class Recorder implements AudioSink {
  readonly sfxs: { id: string; plane: string; x: number; y: number; delay: number; level: number }[] = [];
  readonly alerts: AlertCue[] = [];
  readonly seeds: number[] = [];
  heat = 0;
  readonly loops: Partial<Record<AmbienceId, number>> = {};
  readonly acts: Partial<Record<`${ActivityId}:${number}`, { level: number; pan: number }>> = {};
  sfx(id: string, plane: string, x: number, y: number, delay: number, level = 1): void { this.sfxs.push({ id, plane, x, y, delay, level }); }
  alert(cue: AlertCue): void { this.alerts.push(cue); }
  combat(heat: number): void { this.heat += heat; }
  battleSeed(seed: number): void { this.seeds.push(seed); }
  loop(id: AmbienceId, level: number): void { this.loops[id] = level; }
  activity(id: ActivityId, voice: number, level: number, pan: number): void { this.acts[`${id}:${voice}`] = { level, pan }; }
  level(id: ActivityId): number { return (this.acts[`${id}:0`]?.level ?? 0) + (this.acts[`${id}:1`]?.level ?? 0); }
  get ids(): string[] { return this.sfxs.map((s) => s.id); }
}

const at = (focus: Listener['plane'] = 'surface'): Listener => ({ plane: focus, x: 24, y: 24, rightX: 1, rightY: 0 });

function setup(focus: Listener['plane'] = 'surface') {
  const sink = new Recorder();
  const listener = at(focus);
  const d = new AudioDirector(sink, listener, size);
  d.ingest(view(100), 98); // first view: history, never sounded
  return { sink, d, listener };
}

const shot = (patch: Partial<Fx>): Fx => ({ tick: 101, kind: 'shot', plane: 'surface', x: 24, y: 24, tp: 'surface', tx: 26, ty: 24, side: 'nw', src: 'e_1', ...patch });
const ev = (patch: Partial<GameEvent> & Pick<GameEvent, 'kind'>): GameEvent => ({ tick: 101, plane: 'surface', x: 10, y: 10, ...patch });

describe('audio: event → sound mapping', () => {
  it('maps every weapon to its sound, with Skiff blasters and Bastion point defence by shooter', () => {
    expect(shotSound(shot({ w: 'rifle' }))).toBe('w_rifle');
    expect(shotSound(shot({ w: 'cannon' }))).toBe('w_cannon');
    expect(shotSound(shot({ w: 'flak' }))).toBe('w_flak');
    expect(shotSound(shot({ w: 'missile' }))).toBe('w_missile');
    expect(shotSound(shot({ w: 'bomb' }))).toBe('w_bomb');
    expect(shotSound(shot({ w: 'beam' }))).toBe('w_beam');
    expect(shotSound(shot({ w: 'turret' }))).toBe('w_turret');
    expect(shotSound(shot({ w: 'point_defence' }))).toBe('w_pd');
    expect(shotSound(shot({ w: 'flamer', subject: 'breacher' }))).toBe('w_flamer');
    expect(shotSound(shot({ subject: 'skiff', w: 'rifle' }))).toBe('w_skiff');
    expect(shotSound(shot({ subject: 'bastion', w: 'point_defence' }))).toBe('w_bastion_pd');
    expect(shotSound(shot({ subject: 'tank' }))).toBe('w_cannon');
    expect(shotSound(shot({ subject: 'warden' }))).toBe('w_shotgun');
    expect(shotSound(shot({ w: 'shotgun' }))).toBe('w_shotgun');
    expect(shotSound(shot({ subject: 'gun_platform', w: 'rifle', plane: 'sky' }))).toBe('w_platform');
  });

  it('maps impacts, explosions, collapses, the Sun lance and world effects', () => {
    const f = (kind: Fx['kind'], subject?: Fx['subject']) => fxSound({ tick: 1, kind, plane: 'surface', x: 1, y: 1, ...(subject ? { subject } : {}) });
    expect(f('death', 'trooper')).toBe('imp_small');
    expect(f('death', 'tank')).toBe('exp_large');
    expect(f('death', 'turret')).toBe('collapse');
    expect(f('impact')).toBe('asteroid_impact');
    expect(f('volatile_detonation')).toBe('volatile');
    expect(f('volatile_detonation', 'asteroid')).toBe('volatile');
    expect(f('volatile_detonation', 'core')).toBe('meltdown');
    expect(f('core_vent', 'core')).toBe('vent_hiss');
    expect(f('lance')).toBe('lance_fire');
    expect(f('dig')).toBe('dig');
    expect(f('magma')).toBe('magma');
    expect(f('deorbit')).toBe('tug_drop');
    expect(f('mining_start', 'tug')).toBe('mine_extract');
    expect(f('mining_depleted', 'asteroid')).toBe('mine_depleted');
    expect(f('mining_unload', 'tug')).toBe('cargo_unload');
    expect(f('flare', 'warden')).toBe('flare_launch');
    expect(f('portal', 'trooper')).toBe('shaft_lift');
    expect(f('bridge', 'digger')).toBe('backfill');
  });

  it('plays own fire at the shooter and feeds battle heat near the focus only', () => {
    const { sink, d } = setup();
    d.ingest(view(102, { fx: [shot({ w: 'cannon' }), shot({ w: 'rifle', x: 2, y: 2 })] }), 100);
    expect(sink.ids).toEqual(['w_cannon', 'w_rifle']);
    expect(sink.sfxs[0]).toMatchObject({ plane: 'surface', x: 24, y: 24 });
    expect(sink.heat).toBe(1);
  });

  it('never re-sounds an effect already heard', () => {
    const { sink, d } = setup();
    const fx = [shot({ w: 'cannon' })];
    d.ingest(view(102, { fx }), 100);
    d.ingest(view(103, { fx }), 101);
    expect(sink.ids).toEqual(['w_cannon']);
  });

  it('cues own construction, and alert chirps for Spire attacks and losses (no voices)', () => {
    const { sink, d } = setup();
    d.ingest(view(102, {
      events: [
        ev({ kind: 'produced', subject: 'tank', side: 'nw' }),
        ev({ kind: 'constructed', subject: 'turret', side: 'nw' }),
        ev({ kind: 'spire_damaged', subject: 'spire', side: 'se' }),
        ev({ kind: 'structure_lost', subject: 'spire', side: 'nw' }),
      ],
    }), 100);
    expect(sink.alerts).toEqual(['base_under_attack', 'spire_segment_lost']);
    expect(sink.ids).toEqual(['construction']);
  });
  it('sounds a Drill Yard conversion once, only for our produced Breacher', () => {
    const { sink, d } = setup();
    const events = [
      ev({ kind: 'produced', subject: 'breacher', side: 'nw' }),
      ev({ kind: 'produced', subject: 'breacher', side: 'se' }),
      ev({ kind: 'produced', subject: 'tank', side: 'nw' }),
    ];
    d.ingest(view(102, { events }), 100);
    d.ingest(view(103, { events }), 101);
    expect(sink.ids).toEqual(['convert_done']);
  });

  it('keeps mining effects private to own or currently visible work and never replays history', () => {
    const { sink, d } = setup('orbit');
    const kinds = ['mining_start', 'mining_depleted', 'mining_unload'] as const;
    const fx = kinds.map((kind) => shot({ kind, plane: 'orbit', subject: 'tug', side: 'se' }));
    d.ingest(view(102, { fx, vision: vision(0) }), 100);
    expect(sink.ids).toEqual([]);
    const fresh = fx.map((f) => ({ ...f, tick: 103 }));
    d.ingest(view(104, { fx: fresh }), 102);
    d.ingest(view(105, { fx: fresh }), 103);
    expect(sink.ids).toEqual(['mine_extract', 'mine_depleted']);
    expect(sink.heat).toBe(0);
    const own = fx.map((f) => ({ ...f, tick: 106, side: 'nw' as const }));
    d.ingest(view(107, { fx: own, vision: vision(0) }), 105);
    expect(sink.ids).toEqual(['mine_extract', 'mine_depleted', 'mine_extract', 'mine_depleted', 'cargo_unload']);
    const first = new Recorder();
    new AudioDirector(first, at('orbit'), size).ingest(view(104, { fx: fresh }), 102);
    expect(first.ids).toEqual([]);
  });


  it('cues another army losing a crown (crown_lost); our own fall sounds once, through structure_lost', () => {
    const { sink, d } = setup();
    d.ingest(view(102, {
      events: [
        ev({ kind: 'crown_lost', subject: 'spire', side: 'se', plane: 'sky' }),
        ev({ kind: 'crown_lost', subject: 'spire', side: 'nw', plane: 'orbit' }),
        ev({ kind: 'structure_lost', subject: 'spire', side: 'nw', plane: 'orbit' }),
      ],
    }), 100);
    expect(sink.alerts).toEqual(['breakthrough', 'spire_segment_lost']);
  });

  it('cues research the first time it completes', () => {
    const { sink, d } = setup();
    const completed = [UPGRADE_IDS[0]!];
    d.ingest(view(102, { research: { ...base.research, completed } }), 100);
    d.ingest(view(103, { research: { ...base.research, completed } }), 101);
    expect(sink.ids).toEqual(['research']);
  });

  it('keys alert cues off new per-plane alerts, once each', () => {
    const { sink, d } = setup();
    const alerts: View['alerts'] = [
      { plane: 'surface', kind: 'drop', tick: 300, x: 10, y: 10, side: 'se' },
      { plane: 'sky', kind: 'storm_growing', tick: 300, x: 30, y: 30 },
      { plane: 'depths', kind: 'breach', x: 5.5, y: 5.5 },
      { plane: 'depths', kind: 'charge', tick: 300, x: 7.5, y: 7.5 },
    ];
    d.ingest(view(102, { alerts }), 100);
    d.ingest(view(103, { alerts }), 101);
    expect(sink.alerts).toEqual(['asteroid_incoming', 'breakthrough']);
    expect(sink.ids).toEqual(['alert']);
    // our own drop is no warning
    d.ingest(view(104, { alerts: [{ plane: 'surface', kind: 'drop', tick: 300, x: 40, y: 40, side: 'nw' }] }), 102);
    expect(sink.alerts).toHaveLength(2);
  });

  it('a white-hot Mother Lode chirps with a tremor once; from lodeWarn it rumbles (the grinding loop), louder toward the vent', () => {
    const match = game.view('nw', { snapshot: true }).match!;
    const { warn, crit } = { warn: match.rules.depths.lodeWarn, crit: match.rules.depths.lodeCritical };
    const { sink, d } = setup('depths');
    const lode = (pressure: number, state: NonNullable<View['motherLode']>['state']): Partial<View> => ({ match, motherLode: { pressure, rate: 1, state, x: 24.5, y: 24.5 } });
    d.ingest(view(102, lode(warn - 1, 'calm')), 100);
    expect(sink.level('gate')).toBe(0);
    d.ingest(view(103, lode(warn, 'warn')), 101);
    const low = sink.level('gate');
    expect(low).toBeGreaterThan(0);
    const alerts: View['alerts'] = [{ plane: 'depths', kind: 'lode_critical', x: 24.5, y: 24.5 }];
    d.ingest(view(104, { ...lode(crit + 5, 'critical'), alerts }), 102);
    d.ingest(view(105, { ...lode(crit + 6, 'critical'), alerts }), 103);
    expect(sink.ids).toEqual(['alert', 'tremor']);
    expect(sink.level('gate')).toBeGreaterThan(low);
    d.ingest(view(106, lode(0, 'cooling')), 104);
    expect(sink.level('gate')).toBe(0);
  });

  it('hears shield hits, shield breaks and tug grapples on visible ships', () => {
    const { sink, d } = setup('orbit');
    const ship = { ...base.entities[0]!, id: 'e_900', kind: 'bastion', plane: 'orbit', x: 24, y: 24, shield: 80, maxShield: 100, state: 'idle' } as Entity;
    const tug = { ...ship, id: 'e_901', kind: 'tug', shield: undefined, maxShield: undefined } as Entity;
    d.ingest(view(102, { entities: [ship, tug] }), 100);
    d.ingest(view(103, { entities: [{ ...ship, shield: 40 }, { ...tug, state: 'grappling' }] }), 101);
    d.ingest(view(104, { entities: [{ ...ship, shield: 0 }, { ...tug, state: 'grappling' }] }), 102);
    expect(sink.ids).toEqual(['shield_hit', 'tug_tow', 'shield_break']);
    expect(sink.level('tow')).toBeGreaterThan(0);
  });

  it('classifies close-zoom activity: drilling, treads, engines, towing, machinery', () => {
    expect(activityOf({ kind: 'digger', state: 'digging', plane: 'depths' })).toBe('drill');
    expect(activityOf({ kind: 'sapper', state: 'undermining', plane: 'surface' })).toBe('drill');
    expect(activityOf({ kind: 'tank', state: 'moving', plane: 'surface' })).toBe('treads');
    expect(activityOf({ kind: 'trooper', state: 'moving', plane: 'surface' })).toBeUndefined();
    expect(activityOf({ kind: 'tank', state: 'idle', plane: 'surface' })).toBeUndefined();
    expect(activityOf({ kind: 'bomber', state: 'idle', plane: 'sky' })).toBe('engine_air');
    expect(activityOf({ kind: 'gunship', state: 'moving', plane: 'sky' })).toBe('rotor');
    expect(activityOf({ kind: 'gunship', state: 'hangared', plane: 'sky' })).toBeUndefined();
    expect(activityOf({ kind: 'lancer', state: 'moving', plane: 'orbit' })).toBe('engine_orbit');
    expect(activityOf({ kind: 'digger', state: 'moving', plane: 'depths' })).toBe('engine_depths');
    expect(activityOf({ kind: 'tug', state: 'towing', plane: 'orbit' })).toBe('tow');
    expect(activityOf({ kind: 'headframe', state: 'active', plane: 'surface' })).toBe('machinery');
    expect(activityOf({ kind: 'post', state: 'idle', plane: 'surface' })).toBe('flag');
    expect(activityOf({ kind: 'drill_yard', state: 'active', plane: 'surface' })).toBe('yard');
    expect(activityOf({ kind: 'drill_yard', state: 'idle', plane: 'surface' })).toBeUndefined();
    expect(activityOf({ kind: 'tug', state: 'mining', plane: 'orbit' })).toBe('mine');
    expect(activityOf({ kind: 'digger', state: 'mining', plane: 'depths' })).toBe('drill');
    expect(activityOf({ kind: 'ore_extractor', state: 'mining', plane: 'sky' })).toBe('drill');
    expect(activityOf({ kind: 'ore_extractor', state: 'idle', plane: 'sky' })).toBeUndefined();
    expect(activityOf({ kind: 'ore_extractor', state: 'constructing', plane: 'sky' })).toBeUndefined();
  });

  it('drives activity loops from units near the focus on the focused plane, panned to their side, soft-capped', () => {
    const { sink, d } = setup('surface');
    const tank = { ...base.entities[0]!, kind: 'tank', side: 'nw', plane: 'surface', state: 'moving', x: 30, y: 24 } as Entity;
    const tanks = (n: number, x: number): Entity[] => Array.from({ length: n }, (_, i) => ({ ...tank, id: `e_t${x}_${i}`, x, y: 24 }));
    d.ingest(view(102, { entities: tanks(1, 30) }), 100);
    const one = sink.acts['treads:1']!;
    expect(one.level).toBeGreaterThan(0);
    expect(one.pan).toBeGreaterThan(0); // right of the focus
    expect(sink.acts['treads:0']!.level).toBe(0);
    d.ingest(view(103, { entities: tanks(40, 30) }), 101);
    expect(sink.acts['treads:1']!.level).toBeLessThan(1);
    expect(sink.acts['treads:1']!.level).toBeGreaterThan(one.level);
    // far away, or on another plane: silent
    d.ingest(view(104, { entities: [...tanks(3, 2), { ...tank, id: 'e_air', kind: 'bomber', plane: 'sky', x: 25 }] }), 102);
    expect(sink.level('treads')).toBe(0);
    expect(sink.level('engine_air')).toBe(0);
  });

  it('a Warden flare launches, then fizzes where it lands', () => {
    const { sink, d } = setup('depths');
    d.ingest(view(102, { fx: [{ tick: 101, kind: 'flare', plane: 'depths', x: 20, y: 22, side: 'nw', subject: 'warden', src: 'e_5' }] }), 100);
    expect(sink.ids).toEqual(['flare_launch', 'flare_fizz']);
    expect(sink.sfxs[1]).toMatchObject({ plane: 'depths', x: 20, y: 22 });
  });

  it('hears Warden shield walls deploy and undeploy, once per change', () => {
    const { sink, d } = setup();
    const warden = { ...base.entities[0]!, id: 'e_w', kind: 'warden', side: 'nw', plane: 'surface', x: 24, y: 24, state: 'idle' } as Entity;
    const states: Entity['state'][] = ['idle', 'walling', 'walling', 'walled', 'unwalling', 'idle'];
    states.forEach((state, i) => d.ingest(view(102 + i, { entities: [{ ...warden, state }] }), 100 + i));
    expect(sink.ids).toEqual(['wall_deploy', 'wall_undeploy']);
  });

  it('hears Surface deploy stances set up and pack, once per change', () => {
    const { sink, d } = setup();
    const unit = (kind: Entity['kind'], states: Entity['state'][]) => {
      const e = { ...base.entities[0]!, id: `e_${kind}`, kind, side: 'nw', plane: 'surface', x: 24, y: 24, state: 'idle' } as Entity;
      return states.map((state) => ({ ...e, state }));
    };
    const tank = unit('tank', ['idle', 'sieging', 'sieged', 'unsieging', 'idle']);
    const trooper = unit('trooper', ['idle', 'digging_in', 'dug_in', 'digging_out', 'idle']);
    const flak = unit('flak', ['idle', 'emplacing', 'emplaced', 'unemplacing', 'idle']);
    tank.forEach((_, i) => d.ingest(view(102 + i, { entities: [tank[i]!, trooper[i]!, flak[i]!] }), 100 + i));
    expect(sink.ids).toEqual(['siege_lock', 'dig_in', 'flak_emplace', 'siege_unlock', 'siege_unlock']);
  });

  it('hears own forward posts taken and lost', () => {
    const { sink, d } = setup();
    d.ingest(view(102, { events: [ev({ kind: 'post_captured', x: 12, y: 30, side: 'nw' }), ev({ kind: 'post_lost', x: 36, y: 18, side: 'nw' })] }), 100);
    expect(sink.ids).toEqual(['post_capture', 'post_capture']);
  });

  it('hears observed island moorings engage and release once, not once per movement phase', () => {
    const { sink, d } = setup('sky');
    const island = { ...base.entities[0]!, id: 'e_isl', kind: 'island', side: 'se', plane: 'sky', x: 30, y: 30, state: 'idle' } as Entity;
    d.ingest(view(102, { entities: [island] }), 100);
    d.ingest(view(103, { entities: [{ ...island, mooringState: 'lowering' }] }), 101);
    d.ingest(view(104, { entities: [{ ...island, mooringState: 'held' }] }), 102);
    d.ingest(view(105, { entities: [{ ...island, mooringState: 'raising' }] }), 103);
    expect(sink.ids).toEqual(['anchor_on', 'anchor_off']);
    expect(sink.sfxs[0]).toMatchObject({ plane: 'sky', x: 30, y: 30 });
  });

  it('hears a load picked from a Mother Lode cell (a mining digger beside one gains carry); other mining stays the drill loop', () => {
    const { sink, d } = setup('depths');
    const h = size / 2;
    expect(base.depths[(h - 1) * size + h - 1]).toBe(CELL.lode);
    const digger = { ...base.entities[0]!, id: 'e_dig', kind: 'digger', side: 'nw', plane: 'depths', x: h - 0.5, y: h - 1.5, state: 'mining', carry: 0 } as Entity;
    const far = { ...digger, id: 'e_far', x: 10.5, y: 10.5 };
    d.ingest(view(102, { entities: [digger, far] }), 100);
    d.ingest(view(103, { entities: [{ ...digger, carry: 10 }, { ...far, carry: 10 }] }), 101);
    d.ingest(view(104, { entities: [{ ...digger, carry: 10 }, { ...far, carry: 20 }] }), 102);
    d.ingest(view(105, { entities: [{ ...digger, carry: 20 }, far] }), 103);
    expect(sink.ids).toEqual(['lode_pick', 'lode_pick']);
    expect(sink.sfxs[0]).toMatchObject({ plane: 'depths', x: h - 0.5, y: h - 1.5 });
  });

  it('hears any island hardpoint attachment lock, settle and release (public), an own Gunship landing first', () => {
    const { sink, d } = setup('sky');
    const path = { id: 'e_isl', cx: 30, cy: 30, r: 0, phase: 0, speed: 0 };
    const held = (side: 'nw' | 'se') => ({ ...path, hardpoint: { kind: 'gun_platform' as const, side } });
    d.ingest(view(102, { islands: [path] }), 100);
    d.ingest(view(103, { islands: [held('se')] }), 101);
    d.ingest(view(104, { islands: [held('se')] }), 102);
    d.ingest(view(105, { islands: [path] }), 103);
    expect(sink.ids).toEqual(['attach_lock', 'attach_servo', 'attach_release']);
    expect(sink.sfxs[0]).toMatchObject({ plane: 'sky', x: 30, y: 30, delay: 0 });
    // our own Gunship emplacing: the landing thump, then the clamp and the servo
    sink.sfxs.length = 0;
    d.ingest(view(106, { islands: [held('nw')], events: [ev({ tick: 106, kind: 'emplaced', plane: 'sky', x: 30, y: 30, subject: 'gun_platform', side: 'nw' })] }), 104);
    expect(sink.sfxs.map((x) => `${x.id}@${x.delay}`)).toEqual(['gunship_land@0', 'attach_lock@400', 'attach_servo@700']);
  });

  it('a Storm Seeder charges up on its public warning, then bursts (the engine gates it to under the clouds)', () => {
    const run = (focus: Listener['plane']): string[] => {
      const { sink, d } = setup(focus);
      const warning = { x: 30, y: 30, radius: 6, from: 160 };
      d.ingest(view(102, { weather: { ...base.weather, seedWarnings: [warning], seeded: [] } }), 100);
      d.ingest(view(103, { weather: { ...base.weather, seedWarnings: [warning], seeded: [] } }), 101);
      d.ingest(view(160, { weather: { ...base.weather, seedWarnings: [], seeded: [{ x: 30, y: 30, radius: 6, until: 600 }] } }), 158);
      d.ingest(view(161, { weather: { ...base.weather, seedWarnings: [], seeded: [{ x: 30, y: 30, radius: 6, until: 600 }] } }), 159);
      return sink.ids;
    };
    expect(run('sky')).toEqual(['seeder_charge', 'seeder_burst']);
    expect(run('depths')).toEqual(['seeder_charge', 'seeder_burst']); // cued; silenced by the engine's HEARD_ON gate
  });

  it('seeds the battle rotation once per match', () => {
    const { sink, d } = setup();
    d.ingest(view(102), 100);
    expect(sink.seeds).toEqual([matchSeed(base)]);
  });

  it('hears storms under the clouds only: Sky full, Surface muffled, Orbit and Depths silent', () => {
    const storm = { id: 0, x: 24, y: 24, radius: 4, maxRadius: 4, strength: 1, stage: 'mature' as const, originX: 24, originY: 24, dx: 0, dy: 0, start: 0, grown: 10, breaking: 10_000, end: 20_000, turns: 0 };
    const level = (focus: Listener['plane']): number => {
      const { sink, d } = setup(focus);
      d.ingest(view(102, { weather: { ...base.weather, storms: [storm], forecast: [], seeded: [] } }), 100);
      return sink.loops.storm_loop ?? 0;
    };
    expect(level('sky')).toBeGreaterThan(level('surface'));
    expect(level('surface')).toBeGreaterThan(0);
    expect(level('orbit')).toBe(0);
    expect(level('depths')).toBe(0);
  });

  const derelict = base.match!.derelict!;
  const core = { ...base.entities[0]!, id: 'e_core', kind: 'core', side: 'neutral', plane: 'orbit', x: derelict.x + 6, y: derelict.y, state: 'idle', heat: 0 } as Entity;
  const burst = (radius: number): Fx => ({ tick: 101, kind: 'volatile_detonation', plane: 'orbit', x: core.x, y: core.y, subject: 'core', radius });

  it('distinguishes nonterminal vents from meltdowns without relying on the event tail', () => {
    const { sink, d } = setup('orbit');
    d.ingest(view(102, { fx: [{ ...burst(3), kind: 'core_vent' }, { ...burst(1), subject: 'asteroid' }] }), 100);
    d.ingest(view(105, { fx: [{ ...burst(3), tick: 104 }], events: [] }), 103);
    expect(sink.ids).toEqual(['vent_hiss', 'volatile', 'meltdown']);
  });

  it('a dropped core lands on the asteroid impact sound, a little under a rock', () => {
    const { sink, d } = setup();
    d.ingest(view(102, { fx: [
      { tick: 101, kind: 'impact', plane: 'surface', x: 10, y: 10, side: 'nw', subject: 'core' },
      { tick: 101, kind: 'impact', plane: 'surface', x: 30, y: 30, side: 'se', subject: 'asteroid' },
    ] }), 100);
    expect(sink.sfxs.map((s) => [s.id, s.level])).toEqual([['asteroid_impact', 0.8], ['asteroid_impact', 1]]);
  });

  it('hears a visible core latched for tow, and its heat whine once per upward crossing of the vent point', () => {
    const { sink, d } = setup('orbit');
    const heats: [Entity['state'], number | undefined][] = [['idle', 0], ['towed', 40], ['towed', 79], ['towed', 85], ['towed', undefined], ['towed', 90], ['towed', 0], ['towed', 82]];
    heats.forEach(([state, heat], i) => d.ingest(view(102 + i, { entities: [{ ...core, state, heat }] }), 100 + i));
    expect(sink.ids).toEqual(['core_pickup', 'core_heat', 'core_heat']);
    expect(sink.sfxs[0]).toMatchObject({ plane: 'orbit', x: core.x, y: core.y });
  });

  it('the derelict ring grinds while it turns, near the ruin on the Orbit focus only', () => {
    const period = derelict.open + 2 * derelict.turn + derelict.closed;
    const gate = (focus: Listener['plane'], tick: number, x = derelict.x, y = derelict.y): number => {
      const { sink, d, listener } = setup(focus);
      listener.x = x;
      listener.y = y;
      d.ingest(view(tick + 2), tick);
      return sink.level('gate');
    };
    const turning = period + derelict.open + 1;
    const sealed = turning + derelict.turn;
    expect(gate('orbit', turning)).toBeGreaterThan(0);
    expect(gate('orbit', sealed + derelict.closed + 1)).toBeGreaterThan(0); // the turn back to open
    expect(gate('orbit', period + 1)).toBe(0); // open
    expect(gate('orbit', sealed + 1)).toBe(0); // sealed, still
    expect(gate('surface', turning)).toBe(0);
    expect(gate('orbit', turning, derelict.x + derelict.ringOuter + 20, derelict.y)).toBe(0); // far from the ruin
    // beside the ruin: from the ring's nearest side
    const { sink, d, listener } = setup('orbit');
    listener.x = derelict.x - derelict.ringOuter - 4;
    d.ingest(view(turning + 2), turning);
    expect(sink.acts['gate:1']!.level).toBeGreaterThan(0);
    expect(sink.acts['gate:0']!.level).toBe(0);
  });
});

describe('audio: fog safety', () => {
  it('reads vision bits per plane and cell', () => {
    const v = { vision: vision(0) };
    expect(seen(v, 'surface', 3, 0, size)).toBe(false);
    v.vision.surface[0] = 1 << 3;
    expect(seen(v, 'surface', 3.7, 0.2, size)).toBe(true);
    expect(seen(v, 'sky', 3, 0, size)).toBe(false);
  });

  it('hidden enemy effects produce no sound; seen ones do', () => {
    const hidden = new Recorder();
    const d = new AudioDirector(hidden, at(), size);
    d.ingest(view(100, { vision: vision(0) }), 98);
    const enemy: Fx[] = [
      shot({ side: 'se', w: 'cannon' }),
      { tick: 101, kind: 'death', plane: 'surface', x: 24, y: 24, side: 'se', subject: 'tank' },
      { tick: 101, kind: 'lance', plane: 'orbit', x: 24, y: 24, side: 'se', subject: 'lancer' },
      { tick: 101, kind: 'magma', plane: 'depths', x: 24, y: 24, side: 'se' },
      { tick: 101, kind: 'dig', plane: 'depths', x: 24, y: 24, side: 'se' },
    ];
    expect(enemy.every((f) => !audibleFx({ army: 'nw', vision: vision(0) }, f, size))).toBe(true);
    d.ingest(view(102, { vision: vision(0), fx: enemy }), 100);
    expect(hidden.sfxs).toEqual([]);
    expect(hidden.heat).toBe(0);
    // hidden enemy units near the focus make no activity sound either
    const enemyTank = { ...base.entities[0]!, id: 'e_red', kind: 'tank', side: 'se', plane: 'surface', state: 'moving', x: 26, y: 24 } as Entity;
    d.ingest(view(103, { vision: vision(0), entities: [enemyTank] }), 101);
    expect(hidden.level('treads')).toBe(0);

    const visible = new Recorder();
    const d2 = new AudioDirector(visible, at(), size);
    d2.ingest(view(100), 98);
    d2.ingest(view(102, { fx: enemy }), 100);
    expect(visible.ids).toEqual(['w_cannon', 'exp_large', 'lance_fire', 'magma', 'dig']);
  });

  it('hidden enemy flares and Shaft rides are silent; own ones are heard in fog', () => {
    const sink = new Recorder();
    const d = new AudioDirector(sink, at('depths'), size);
    d.ingest(view(100, { vision: vision(0) }), 98);
    d.ingest(view(102, {
      vision: vision(0),
      fx: [
        { tick: 101, kind: 'flare', plane: 'depths', x: 20, y: 20, side: 'se', subject: 'warden' },
        { tick: 101, kind: 'portal', plane: 'surface', x: 20, y: 20, side: 'se', subject: 'trooper', tp: 'depths' },
      ],
    }), 100);
    expect(sink.sfxs).toEqual([]);
    d.ingest(view(103, { vision: vision(0), fx: [{ tick: 103, kind: 'portal', plane: 'surface', x: 20, y: 20, side: 'nw', subject: 'trooper', tp: 'depths' }] }), 101);
    expect(sink.ids).toEqual(['shaft_lift']);
  });

  it('an unseen shooter is only heard as the hit on what we see', () => {
    const { sink, d } = setup();
    d.ingest(view(102, { fx: [{ tick: 101, kind: 'shot', plane: 'surface', x: 26, y: 24, w: 'cannon', arrive: 104 }] }), 100);
    expect(sink.ids).toEqual(['imp_small']);
    expect(sink.sfxs[0]).toMatchObject({ x: 26, y: 24 });
  });

  it('own and public effects stay audible in fog (telegraphed drops, own losses)', () => {
    const sink = new Recorder();
    const d = new AudioDirector(sink, at(), size);
    d.ingest(view(100, { vision: vision(0) }), 98);
    d.ingest(view(102, {
      vision: vision(0),
      fx: [
        { tick: 101, kind: 'impact', plane: 'surface', x: 5, y: 5, side: 'se', subject: 'asteroid' },
        { tick: 101, kind: 'death', plane: 'surface', x: 5, y: 5, side: 'nw', subject: 'trooper' },
      ],
    }), 100);
    expect(sink.ids).toEqual(['asteroid_impact', 'imp_small']);
  });

  it('a falling wreck strikes on the death profile\'s clock, heard only where the ground below is seen', () => {
    const death: Fx = { tick: 101, kind: 'death', plane: 'sky', x: 24, y: 24, side: 'nw', subject: 'interceptor' };
    const fall = wreckFallMs('interceptor', 'sky')!;
    const seenBelow = new Recorder();
    const d = new AudioDirector(seenBelow, at('sky'), size);
    d.ingest(view(100), 98);
    d.ingest(view(102, { fx: [death] }), 100);
    expect(seenBelow.ids).toEqual([deathProfile('interceptor').sound.id, deathProfile('interceptor').land!.id]);
    expect(seenBelow.sfxs[1]!.plane).toBe('surface');
    expect(seenBelow.sfxs[1]!.delay - seenBelow.sfxs[0]!.delay).toBeCloseTo(fall, 6);
    // own loss in fog: the burst is heard, the strike on unseen ground is not
    const fogged = new Recorder();
    const d2 = new AudioDirector(fogged, at('sky'), size);
    d2.ingest(view(100, { vision: vision(0) }), 98);
    d2.ingest(view(102, { vision: vision(0), fx: [death] }), 100);
    expect(fogged.ids).toEqual([deathProfile('interceptor').sound.id]);
  });

  it('never cues the enemy team\'s own news', () => {
    const { sink, d } = setup();
    d.ingest(view(102, {
      events: [
        ev({ kind: 'produced', subject: 'tank', side: 'se' }),
        ev({ kind: 'constructed', subject: 'turret', side: 'se' }),
        ev({ kind: 'structure_lost', subject: 'spire', side: 'se' }),
      ],
    }), 100);
    expect(sink.alerts).toEqual([]);
    expect(sink.sfxs).toEqual([]);
  });

  it('stays silent for history in the first view of a match or team', () => {
    const sink = new Recorder();
    const d = new AudioDirector(sink, at(), size);
    d.ingest(view(100, { fx: [shot({ tick: 99, w: 'cannon' })], events: [ev({ tick: 99, kind: 'produced', side: 'nw' })] }), 98);
    expect(sink.sfxs).toEqual([]);
    expect(sink.alerts).toEqual([]);
  });

  it('chamber radiation is heard through our own ships inside it only', () => {
    const derelict = base.match!.derelict!;
    const ship = { ...base.entities[0]!, id: 'e_rad', kind: 'lancer', side: 'nw', plane: 'orbit', state: 'idle', x: derelict.x + derelict.ringInner / 2, y: derelict.y } as Entity;
    const level = (e: Entity, focus: Listener['plane'] = 'orbit'): number => {
      const { sink, d } = setup(focus);
      d.ingest(view(102, { entities: [e] }), 100);
      return sink.level('radiation');
    };
    expect(level(ship)).toBeGreaterThan(0);
    expect(level({ ...ship, side: 'se' })).toBe(0);
    expect(level({ ...ship, x: derelict.x + derelict.ringOuter + 1 })).toBe(0);
    expect(level(ship, 'surface')).toBe(0);
  });
});
