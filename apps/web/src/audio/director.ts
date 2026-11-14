/**
 * Turns the team's fogged view into sound cues: weapon fire, impacts and explosions from fx; non-verbal alert chirps
 * and cue sounds from own events, research and per-plane alerts; Warden shield walls, island moorings, Mother Lode picks
 * and Storm Seeder telegraphs from what changes on screen; derelict core pickups, heat warnings, vents, meltdowns and
 * drops; close-zoom activity loops (drilling, treads, engines, rotors, towing, machinery, the derelict's turning ring
 * and its chamber radiation) and wind/storm ambience from what is on screen; a battle heat for the combat music layer and a
 * per-match seed for its rotation. Fog safety: the server already filters fx/events per team, and every enemy-owned
 * effect or unit is additionally checked against this view's vision bits, so nothing hidden is ever heard. Runs per
 * view (20 Hz) and per frame (thunder only, allocation-free).
 */
import { AIRCRAFT as AIRCRAFT_KINDS, ALERT_KINDS, CELL, inChamber, LODE_PRESSURE_MAX, ringTurning, STATS, STRUCTURE_KINDS, TICK_RATE, VISION_BITS_PER_WORD, islandAt, type Entity, type Fx, type Kind, type Plane, type State, type StatKind, type View } from '@agent-command/game/contract';
import { sampleStorm, type StormSample } from '@agent-command/game/weather';
import { flashAt } from '../world/weather.ts';
import { idSpace, type MatchView } from '../match-view.ts';
import { ACTIVITY_IDS, ACTIVITY_VOICES, AMBIENCE_IDS, type ActivityId, type AlertCue, type AmbienceId, type LoopId, type SfxId } from './catalog.ts';
import { DEATH_PLANES, deathProfile, wreckFallMs } from '../world/death-profiles.ts';

export type OneShot = Exclude<SfxId, LoopId>;

/** What the director drives; the audio facade implements it (no-ops until the engine is loaded). */
export interface AudioSink {
  /** Positional effect at tile (x, y) on `plane`, `delayMs` from now (to land with the visuals). */
  sfx(id: OneShot, plane: Plane, x: number, y: number, delayMs: number, level?: number): void;
  /** An important moment: a non-verbal alert chirp, rate-limited per cue. */
  alert(cue: AlertCue): void;
  /** Battle heat near the camera focus (accumulates; the engine decays it). */
  combat(heat: number): void;
  /** Per-match seed for the battle-track rotation. */
  battleSeed(seed: number): void;
  /** Target level (0..1) of a weather ambience loop. */
  loop(id: AmbienceId, level: number): void;
  /** Close-zoom activity loop `voice` (0 left, 1 right of the focus) of `id`: level 0..1 and stereo pan -1..1. */
  activity(id: ActivityId, voice: number, level: number, pan: number): void;
}

/** Where the camera looks: the plane in view, tile coordinates and the camera's right axis on the map. */
export interface Listener {
  /**
   * The plane in view (set by {@link followRig}): the bed, weather, activity loops and plane-bound sounds (catalog
   * HEARD_ON) all follow it.
   */
  plane: Plane;
  x: number;
  y: number;
  rightX: number;
  rightY: number;
}

/**
 * Per frame from the HUD/observer: the plane in view is the dive's destination once the camera lands (an instant jump
 * lands at once). A dive across planes (Orbit to the Depths, or chained dive keys retargeting it on the way) is one
 * change from the old plane straight to where it ends; intermediate planes never sound.
 */
export function followRig(listener: Listener, rig: { readonly focus: Plane; readonly diving: boolean }): void {
  if (!rig.diving) listener.plane = rig.focus;
}

const MS_PER_TICK = 1000 / TICK_RATE;
/** Combat within this many tiles of the focus drives the battle layer. */
const NEAR = 16;
/** Activity within this many tiles of the focus drives the close-zoom loops (closer counts more). */
const ACTIVITY_RADIUS = 14;
/** Derelict core heat (0..100, meltdown at 100) whose upward crossing sounds the warning whine: the vent point the strategy skill teaches. */
const CORE_HEAT_WARN = 80;
/** Gate-loop weight of the turning ring (a unit near the focus weighs up to 1): the whole ruin grinds, not one ship. */
const GATE_WEIGHT = 3;
/** Level (0..1) of the shared asteroid impact sound when a dropped derelict core lands. */
const CORE_IMPACT_LEVEL = 0.8;
/** An own `irradiated` event swells the radiation loop at the listener, on any plane, for this long (ticks; the sim repeats it while ships burn). */
const RADIATION_SWELL_TICKS = 3 * TICK_RATE;
/** Radiation-loop weight of that swell (a ship near the focus weighs up to 1). */
const RADIATION_SWELL = 1.5;
const WORK: Readonly<Partial<Record<State, true>>> = { digging: true, mining: true, fortifying: true, undermining: true, breaching: true, bridging: true, laying: true };
const VEHICLES: Readonly<Partial<Record<Kind, true>>> = { tank: true, flak: true, sapper: true, digger: true, tug: true };
const AIRCRAFT: Readonly<Partial<Record<Kind, true>>> = Object.fromEntries(AIRCRAFT_KINDS.map((kind) => [kind, true as const]));
const ENGINE: Readonly<Record<Plane, ActivityId | undefined>> = { orbit: 'engine_orbit', sky: 'engine_air', surface: 'treads', depths: 'engine_depths' };

/** The activity loop a visible entity feeds, if any. */
export function activityOf(e: Pick<Entity, 'kind' | 'state' | 'plane'>): ActivityId | undefined {
  // the torn flag on a forward post flaps at close zoom whoever holds it (posts are public)
  if (e.kind === 'post') return 'flag';
  if (e.kind === 'drill_yard' && e.state === 'active') return 'yard';
  if (e.kind === 'tug' && e.plane === 'orbit' && e.state === 'mining') return 'mine';
  if (WORK[e.state]) return 'drill';
  if (e.state === 'towing' || e.state === 'grappling') return 'tow';
  if (e.kind === 'headframe') return 'machinery';
  // the Gunship's ducted rotors are heavier than the jets of the other aircraft
  if (e.plane === 'sky') return AIRCRAFT[e.kind] && e.state !== 'hangared' ? (e.kind === 'gunship' ? 'rotor' : 'engine_air') : undefined;
  if (e.state !== 'moving') return undefined;
  if (e.plane === 'surface') return VEHICLES[e.kind] ? 'treads' : undefined;
  return STRUCTURES.has(e.kind) ? undefined : ENGINE[e.plane];
}

/** Deterministic per-match seed (battle rotation): the rules hash mixed with the Spire layout. */
export function matchSeed(view: Pick<View, 'rulesHash' | 'match'>): number {
  let h = view.rulesHash >>> 0;
  const armies = view.match?.armies;
  if (armies) for (const a of armies) for (const v of [a.spireAt.x, a.spireAt.y]) h = Math.imul(h ^ Math.round(v * 16), 0x01000193) >>> 0;
  return h;
}
/**
 * Effects any team that receives them may hear without vision: the sim publishes them to everyone (telegraphed drops,
 * collapses, breaches...) or, for the Mother Lode's eruption, to every army that knows the lode.
 */
export const PUBLIC_FX: Readonly<Partial<Record<Fx['kind'], true>>> = { impact: true, intercept: true, deorbit: true, collapse: true, breach: true, breakout: true, chasm: true, bridge: true, defuse: true, volatile_detonation: true, core_vent: true, lode_vent: true };
const STRUCTURES: ReadonlySet<Kind> = new Set(STRUCTURE_KINDS);

/** Is tile (x, y) on `plane` of a `size`-tile map visible to the view's team right now? */
export function seen(view: Pick<View, 'vision'>, plane: Plane, x: number, y: number, size: number): boolean {
  const cx = Math.floor(x), cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= size || cy >= size) return false;
  const cell = cy * size + cx;
  const word = view.vision[plane][Math.floor(cell / VISION_BITS_PER_WORD)] ?? 0;
  return ((word >>> (cell % VISION_BITS_PER_WORD)) & 1) === 1;
}

/** Fog rule for one effect: own and public effects always, anything else only where the team sees now. */
export function audibleFx(view: Pick<View, 'army' | 'vision'>, f: Fx, size: number): boolean {
  if (f.side === view.army) return true;
  if (PUBLIC_FX[f.kind]) return true;
  return seen(view, f.plane, f.x, f.y, size);
}

/** Does tile (x, y) touch a Mother Lode cell the view's team knows (its 3×3 neighbourhood in `view.depths`)? */
export function besideMotherLode(view: Pick<View, 'depths'>, x: number, y: number, size: number): boolean {
  const cx = Math.floor(x), cy = Math.floor(y);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = cx + dx, ny = cy + dy;
    if (nx >= 0 && ny >= 0 && nx < size && ny < size && view.depths[ny * size + nx] === CELL.lode) return true;
  }
  return false;
}

/** The weapon sound of a shot. */
export function shotSound(f: Fx): OneShot | undefined {
  if (f.subject === 'skiff') return 'w_skiff';
  if (f.subject === 'bastion') return 'w_bastion_pd';
  // an emplaced Gunship's platform turret
  if (f.subject === 'gun_platform') return 'w_platform';
  const w = f.w ?? (f.subject && Object.hasOwn(STATS, f.subject) ? STATS[f.subject as StatKind].weapon : undefined);
  switch (w) {
    case 'rifle': return 'w_rifle';
    case 'cannon': return 'w_cannon';
    case 'turret': return 'w_turret';
    case 'flak': return 'w_flak';
    case 'missile': return 'w_missile';
    case 'bomb': return 'w_bomb';
    case 'beam': return 'w_beam';
    case 'point_defence': return 'w_pd';
    case 'pick': return 'dig';
    case 'shotgun': return 'w_shotgun';
    case 'flamer': return 'w_flamer';
    default: return undefined;
  }
}

/** The sound of a non-shot effect. */
export function fxSound(f: Fx): OneShot | undefined {
  switch (f.kind) {
    case 'lance': return 'lance_fire';
    case 'lance_hit': return 'exp_large';
    case 'death': return deathProfile(f.subject ?? 'trooper').sound.id;
    case 'core_vent': return 'vent_hiss';
    case 'volatile_detonation': return f.subject === 'core' ? 'meltdown' : 'volatile';
    case 'collapse': return 'collapse';
    case 'impact': return 'asteroid_impact';
    case 'dig': return 'dig';
    case 'magma': return 'magma';
    // the Mother Lode erupting: the volatile blast
    case 'lode_vent': return 'volatile';
    case 'breach':
    case 'breakout':
    case 'chasm': return 'breach';
    case 'intercept': return 'w_pd';
    case 'deorbit': return 'tug_drop';
    case 'mining_start': return 'mine_extract';
    case 'mining_depleted': return 'mine_depleted';
    case 'mining_unload': return 'cargo_unload';
    case 'scan': return 'scan';
    // the derelict core cashed in at a segment: the delivery chime of a big haul
    case 'core_cashed': return 'construction';
    // a Warden throws a flare (its fizz follows where it lands, see effects)
    case 'flare': return 'flare_launch';
    // a unit rides a Shaft's cage between the Surface and the Depths
    case 'portal': return 'shaft_lift';
    // a digger backfills a hole (public, like the chasm it closes)
    case 'bridge': return 'backfill';
    default: return undefined;
  }
}


interface Seen {
  shield: number;
  grappling: boolean;
  lance: number;
  /** deploy stance cue of the current state ('' when mobile): Warden wall, dug in, siege, emplaced flak */
  stance: OneShot | '';
  /** island caught by a Mooring Tower */
  moored: boolean;
  gen: number;
  /** digger: ore carried (a rise while mining beside a Mother Lode cell is one load picked from it) */
  carry: number;
  /** derelict core under tow */
  towed: boolean;
  /** derelict core heat (0..100; kept while unreported) */
  heat: number;
}

/** Deploy stance phases to their cue: deploying and deployed share one (heard once, as the stance starts), packing its own. */
const STANCE_CUE: Readonly<Partial<Record<State, OneShot>>> = {
  walling: 'wall_deploy', walled: 'wall_deploy', unwalling: 'wall_undeploy',
  digging_in: 'dig_in', dug_in: 'dig_in',
  sieging: 'siege_lock', sieged: 'siege_lock', unsieging: 'siege_unlock',
  emplacing: 'flak_emplace', emplaced: 'flak_emplace', unemplacing: 'siege_unlock',
};

export class AudioDirector {
  private readonly sink: AudioSink;
  private readonly listener: Listener;
  /** map side in tiles */
  private readonly size: number;
  private lastTick = -1;
  /** The army heard and its entity id namespace (match-view.ts idSpace): `units` and `mounts` are keyed by its ids. */
  private space: string | undefined;
  private view: View | undefined;
  private gen = 0;
  private readonly units = new Map<string, Seen>();
  private readonly research = new Set<string>();
  private alertKeys = new Set<number>();
  private nextAlertKeys = new Set<number>();
  /** Seeded storms heard: telegraphs (by their form tick) and the storms themselves (by their end tick). */
  private warnKeys = new Set<number>();
  private nextWarnKeys = new Set<number>();
  private seededKeys = new Set<number>();
  private nextSeededKeys = new Set<number>();
  /** Island hardpoints heard: island id → occupant (`kind:side`, '' = empty). */
  private readonly mounts = new Map<string, string>();
  /** This view's own Gunship emplacements (x, y pairs): their landing thump comes before the hardpoint lock. */
  private readonly landed: number[] = [];
  /** Render tick until which our irradiated ships swell the radiation loop wherever the camera is. */
  private radiationUntil = -1;
  private readonly at = { x: 0, y: 0 };
  private readonly flash = new Map<number, number>();
  private readonly storm: StormSample = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' };
  private readonly levels: Record<AmbienceId, number> = { wind_loop: 0, storm_loop: 0 };
  /** The plane in view the ambience levels were set for. */
  private ambiencePlane: Plane | undefined;
  /** Activity accumulators per (category, voice): summed weight and weighted side offset. */
  private readonly weight = new Float64Array(ACTIVITY_IDS.length * ACTIVITY_VOICES);
  private readonly offset = new Float64Array(ACTIVITY_IDS.length * ACTIVITY_VOICES);

  constructor(sink: AudioSink, listener: Listener, size: number) {
    this.sink = sink;
    this.listener = listener;
    this.size = size;
  }

  /** Forget the match (new match, army switch or rewind). */
  reset(): void {
    this.lastTick = -1;
    this.space = undefined;
    this.view = undefined;
    this.units.clear();
    this.research.clear();
    this.alertKeys.clear();
    this.warnKeys.clear();
    this.seededKeys.clear();
    this.mounts.clear();
    this.flash.clear();
    for (const id of AMBIENCE_IDS) this.sink.loop(id, 0);
    for (const id of ACTIVITY_IDS) for (let v = 0; v < ACTIVITY_VOICES; v++) this.sink.activity(id, v, 0, 0);
  }

  /** One new view of `view.army`; `renderTick` is the server tick on screen now. */
  ingest(view: View & Pick<MatchView, 'names'>, renderTick: number): void {
    const space = `${view.army}:${idSpace(view)}`;
    const first = this.space !== space || view.tick < this.lastTick;
    if (first) {
      this.reset();
      this.sink.battleSeed(matchSeed(view));
    }
    this.view = view;
    this.space = space;
    const since = first ? view.tick : this.lastTick;
    this.lastTick = view.tick;
    this.effects(view, since, renderTick, first);
    this.events(view, since, first);
    this.researchDone(view, first);
    this.alerts(view, first);
    this.entities(view, renderTick, first);
    this.hardpoints(view, first);
    this.seeding(view, first);
    this.ambience(view);
  }

  /**
   * Per frame: weather levels again when the view changes planes (not only at the next view), thunder on each
   * lightning strike (sky storms, same clock as the renderer's flashes).
   */
  frame(renderTick: number): void {
    const view = this.view;
    if (!view) return;
    if (this.listener.plane !== this.ambiencePlane) this.ambience(view);
    const w = view.weather;
    const s = renderTick / TICK_RATE;
    for (let i = 0; i < w.storms.length; i++) {
      const c = w.storms[i]!;
      if (renderTick >= c.end || c.maxRadius <= 0) continue;
      sampleStorm(c, renderTick, this.storm, 0, this.size);
      if (this.storm.stage === 'mature') this.strike(c.id, s, this.storm.x, this.storm.y);
    }
    for (let i = 0; i < w.seeded.length; i++) {
      const c = w.seeded[i]!;
      if (renderTick < c.until && c.radius > 0) this.strike(4 + i, s, c.x, c.y);
    }
  }

  private strike(id: number, s: number, x: number, y: number): void {
    const f = flashAt(s, id);
    const was = this.flash.get(id) ?? 0;
    this.flash.set(id, f);
    // heard under the clouds only (catalog HEARD_ON): full in the Sky, muffled on the Surface
    if (f > 0 && was === 0) this.sink.sfx('thunder', 'sky', x, y, 0);
  }

  private delay(tick: number, renderTick: number): number {
    return Math.min(300, Math.max(0, (tick - renderTick) * MS_PER_TICK));
  }

  private near(plane: Plane, x: number, y: number): boolean {
    const l = this.listener;
    return plane === l.plane && Math.abs(x - l.x) <= NEAR && Math.abs(y - l.y) <= NEAR;
  }

  private effects(view: View, since: number, renderTick: number, first: boolean): void {
    if (first) return;
    let heat = 0;
    for (const f of view.fx) {
      if (f.tick <= since || !audibleFx(view, f, this.size)) continue;
      // A delivery receipt is our economy news, not a confirmation for a visible enemy's cargo.
      if (f.kind === 'mining_unload' && f.side !== view.army) continue;
      const d = this.delay(f.tick, renderTick);
      if (f.kind === 'shot') {
        // An unseen shooter hitting something we see arrives stripped (no side/src): only the hit is heard.
        if (f.side === undefined && f.src === undefined) {
          this.sink.sfx('imp_small', f.plane, f.x, f.y, this.delay(f.arrive ?? f.tick, renderTick), 0.6);
          if (this.near(f.plane, f.x, f.y)) heat += 1;
          continue;
        }
        const id = shotSound(f);
        if (id) this.sink.sfx(id, f.plane, f.x, f.y, d, id === 'dig' ? 0.5 : 1);
        if (this.near(f.plane, f.x, f.y)) heat += 1;
        continue;
      }
      const id = fxSound(f);
      if (!id) continue;
      const death = f.kind === 'death' ? deathProfile(f.subject ?? 'trooper') : undefined;
      this.sink.sfx(id, f.plane, f.x, f.y, d, death ? death.sound.level : f.kind === 'impact' && f.subject === 'core' ? CORE_IMPACT_LEVEL : 1);
      // A falling wreck strikes the plane below on the renderer's fall clock, heard only where that ground is seen.
      const fall = death?.land ? wreckFallMs(f.subject ?? 'trooper', f.plane) : undefined;
      const below = DEATH_PLANES[f.plane].below;
      if (fall !== undefined && below && seen(view, below, f.x, f.y, this.size)) this.sink.sfx(death!.land!.id, below, f.x, f.y, d + fall, death!.land!.level);
      if (f.kind === 'intercept') this.sink.sfx('imp_small', f.plane, f.x, f.y, d + 60);
      if (f.kind === 'flare') this.sink.sfx('flare_fizz', f.plane, f.x, f.y, d + 250);
      if ((f.kind === 'death' || f.kind === 'lance_hit' || f.kind === 'volatile_detonation') && this.near(f.plane, f.x, f.y)) heat += 3;
    }
    if (heat > 0) this.sink.combat(heat);
  }

  private events(view: View, since: number, first: boolean): void {
    this.landed.length = 0;
    if (first) return;
    for (const ev of view.events) {
      if (ev.tick <= since) continue;
      // The view's events are already this team's own log; cue only our own news.
      switch (ev.kind) {
        case 'constructed':
          if (ev.side === view.army) this.sink.sfx('construction', ev.plane, ev.x, ev.y, 0);
          break;
        case 'produced':
          if (ev.side === view.army && ev.subject === 'breacher') this.sink.sfx('convert_done', ev.plane, ev.x, ev.y, 0);
          break;
        case 'irradiated':
          if (ev.side === view.army) this.radiationUntil = ev.tick + RADIATION_SWELL_TICKS;
          break;
        case 'post_captured':
        case 'post_lost':
          this.sink.sfx('post_capture', ev.plane, ev.x, ev.y, 0);
          break;
        case 'spire_damaged':
          if (ev.side !== view.army) this.sink.alert('base_under_attack');
          break;
        case 'structure_lost':
          if (ev.side === view.army && ev.subject === 'spire') this.sink.alert('spire_segment_lost');
          break;
        case 'crown_lost':
          // public (lossRule crowns): our own fallen segment already sounds through structure_lost; another army's
          // crown is the match turning
          if (ev.side !== view.army) this.sink.alert('breakthrough');
          break;
        case 'sudden_death':
          // public: the match's climax begins (the countdown alert chirped a minute before)
          this.sink.alert('breakthrough');
          break;
        case 'emplaced':
          // our Gunship sets down on an island: the landing thump, then the hardpoint locks (see hardpoints)
          if (ev.side === view.army) {
            this.sink.sfx('gunship_land', ev.plane, ev.x, ev.y, 0);
            this.landed.push(ev.x, ev.y);
          }
          break;
        default:
          break;
      }
    }
  }

  private researchDone(view: View, first: boolean): void {
    let fresh = false;
    for (const id of view.research.completed) {
      if (this.research.has(id)) continue;
      this.research.add(id);
      fresh = true;
    }
    if (fresh && !first) this.sink.sfx('research', this.listener.plane, this.listener.x, this.listener.y, 0);
  }

  /** Per-plane alerts (already fog-safe by construction): cue each one the first time it appears. */
  private alerts(view: View, first: boolean): void {
    const next = this.nextAlertKeys;
    next.clear();
    for (const a of view.alerts) {
      // An intrusion is one episode however its nearest intruder moves: keyed by kind alone, so it chirps once.
      const key = a.kind === 'intruder' ? ALERT_KINDS.indexOf(a.kind) * 1e6 : ALERT_KINDS.indexOf(a.kind) * 1e6 + Math.round(a.x ?? 999) * 1000 + Math.round(a.y ?? 999);
      // The same item on several planes (sudden death leads every plane) cues once.
      const repeat = next.has(key);
      next.add(key);
      if (first || repeat || this.alertKeys.has(key)) continue;
      switch (a.kind) {
        case 'sudden_death':
          this.sink.sfx('alert', this.listener.plane, this.listener.x, this.listener.y, 0);
          break;
        case 'drop':
          if (a.side !== view.army) this.sink.alert('asteroid_incoming');
          break;
        case 'breach':
          this.sink.alert('breakthrough');
          break;
        case 'intruder':
        case 'wall_dig':
        case 'charge':
        case 'charge_under':
        case 'island_contested':
        case 'post_contested':
          this.sink.sfx('alert', a.plane, a.x ?? this.listener.x, a.y ?? this.listener.y, 0);
          break;
        case 'lode_critical':
          // white-hot Mother Lode: the alert chirp over a deep tremor at the lode (public pressure, a lode cell we know)
          this.sink.sfx('alert', a.plane, a.x ?? this.listener.x, a.y ?? this.listener.y, 0);
          this.sink.sfx('tremor', a.plane, a.x ?? this.listener.x, a.y ?? this.listener.y, 0);
          break;
        case 'core_lifted':
          if (a.side !== view.army) this.sink.sfx('alert', a.plane, a.x ?? this.listener.x, a.y ?? this.listener.y, 0);
          break;
        case 'tremor':
          this.sink.sfx('tremor', a.plane, a.x ?? this.listener.x, a.y ?? this.listener.y, 0);
          break;
        default:
          break;
      }
    }
    this.nextAlertKeys = this.alertKeys;
    this.alertKeys = next;
  }

  /**
   * Visible ships and units: shield hits/breaks, tug grapples, lance charges, core pickups and heat, plus close-zoom
   * activity near the focus (the derelict's ring by its public cycle, chamber radiation through our own ships).
   */
  private entities(view: View, renderTick: number, first: boolean): void {
    const gen = ++this.gen;
    const l = this.listener;
    const g = view.match?.derelict;
    this.weight.fill(0);
    this.offset.fill(0);
    for (const e of view.entities) {
      if (e.plane === l.plane) {
        const act = activityOf(e);
        if (act && (e.side === view.army || seen(view, e.plane, e.x, e.y, this.size))) this.feed(act, e.x, e.y, 1);
        // The chamber is seen from outside only along an open gate's line: its radiation is heard through our own ships only.
        if (g && e.side === view.army && e.plane === 'orbit' && !STRUCTURES.has(e.kind) && inChamber(g, e.x - g.x, e.y - g.y)) this.feed('radiation', e.x, e.y, 1);
      }
      let s = this.units.get(e.id);
      const shield = e.shield ?? 0;
      const grappling = e.state === 'grappling';
      const lance = e.lance?.at ?? 0;
      const stance = STANCE_CUE[e.state] ?? '';
      // Only observed islands emit catch/release cues; neither pending targets nor hidden towers are inferred.
      const moored = e.kind === 'island' && (e.mooringState === 'lowering' || e.mooringState === 'held');
      const carry = e.carry ?? 0;
      const towed = e.kind === 'core' && e.state === 'towed';
      // heat is reported only with actual vision of the core: keep the last value while it is absent
      const heat = e.heat ?? s?.heat ?? 0;
      if (!s) {
        s = { shield, grappling, lance, stance, moored, towed, heat, gen, carry };
        this.units.set(e.id, s);
        continue;
      }
      if (!first) {
        if (shield < s.shield) this.sink.sfx(shield <= 0 ? 'shield_break' : 'shield_hit', e.plane, e.x, e.y, 0);
        if (grappling && !s.grappling) this.sink.sfx('tug_tow', e.plane, e.x, e.y, 0);
        if (lance > 0 && lance !== s.lance && lance > renderTick) this.sink.sfx('lance_charge', e.plane, e.x, e.y, 0);
        if (stance !== s.stance && stance !== '') this.sink.sfx(stance, e.plane, e.x, e.y, 0);
        if (moored !== s.moored) this.sink.sfx(moored ? 'anchor_on' : 'anchor_off', e.plane, e.x, e.y, 0);
        // a load picked from a Mother Lode cell (as quiet as an ordinary dig)
        if (e.kind === 'digger' && e.state === 'mining' && carry > s.carry && besideMotherLode(view, e.x, e.y, this.size)) this.sink.sfx('lode_pick', e.plane, e.x, e.y, 0, 0.5);
        if (towed && !s.towed) this.sink.sfx('core_pickup', e.plane, e.x, e.y, 0);
        if (heat >= CORE_HEAT_WARN && s.heat < CORE_HEAT_WARN) this.sink.sfx('core_heat', e.plane, e.x, e.y, 0);
      }
      s.shield = shield;
      s.grappling = grappling;
      s.lance = lance;
      s.stance = stance;
      s.moored = moored;
      s.carry = carry;
      s.towed = towed;
      s.heat = heat;
      s.gen = gen;
    }
    for (const [id, s] of this.units) if (s.gen !== gen) this.units.delete(id);
    // The ring's cycle and geometry are public: it grinds from its nearest point, or all around inside it.
    if (g && l.plane === 'orbit' && ringTurning(g, renderTick)) {
      const cx = l.x - g.x, cy = l.y - g.y;
      const r = Math.hypot(cx, cy);
      const k = r > g.ringOuter ? g.ringOuter / r : 1;
      this.feed('gate', g.x + cx * k, g.y + cy * k, GATE_WEIGHT);
    }
    // Our ships burning in the chamber swell its loop wherever the camera is (a replay seeking back drops the swell).
    const swell = this.radiationUntil - renderTick;
    if (swell > 0 && swell <= RADIATION_SWELL_TICKS) this.feed('radiation', l.x, l.y, RADIATION_SWELL);
    // The Mother Lode rumbles from lodeWarn (public pressure) at the lode cell we know nearest our Spire: the grinding
    // ring loop, louder as it heats toward the vent.
    const lode = view.motherLode;
    const rules = view.match?.rules.depths;
    if (lode && rules && l.plane === 'depths' && lode.x !== undefined && lode.y !== undefined && lode.state !== 'cooling' && lode.pressure >= rules.lodeWarn) {
      this.feed('gate', lode.x, lode.y, GATE_WEIGHT * Math.min(1, (lode.pressure - rules.lodeWarn) / Math.max(1, LODE_PRESSURE_MAX - rules.lodeWarn) + 0.3));
    }
    for (let i = 0; i < ACTIVITY_IDS.length; i++)
      for (let v = 0; v < ACTIVITY_VOICES; v++) {
        const k = i * ACTIVITY_VOICES + v;
        const w = this.weight[k]!;
        // Soft cap: a few units are clearly audible, a crowd only a little louder.
        const level = 1 - Math.exp(-w / 1.5);
        const pan = w > 0 ? Math.max(-1, Math.min(1, (this.offset[k]! / w) / (ACTIVITY_RADIUS * 0.6))) * 0.8 : 0;
        this.sink.activity(ACTIVITY_IDS[i]!, v, level, pan);
      }
  }

  /** Add a source of activity `act` at tile (x, y) on the focused plane, weighted by `scale` and closeness to the focus. */
  private feed(act: ActivityId, x: number, y: number, scale: number): void {
    const l = this.listener;
    const dx = x - l.x, dy = y - l.y;
    const d = Math.hypot(dx, dy);
    if (d >= ACTIVITY_RADIUS) return;
    const side = dx * l.rightX + dy * l.rightY;
    const k = ACTIVITY_IDS.indexOf(act) * ACTIVITY_VOICES + (side < 0 ? 0 : 1);
    const w = scale * (1 - d / ACTIVITY_RADIUS);
    this.weight[k]! += w;
    this.offset[k]! += w * side;
  }

  /**
   * Island hardpoints (public: `islands[].hardpoint`): any attachment clamps in (`attach_lock`), settles with a servo
   * whine (`attach_servo`) and unlatches when it is destroyed or the island is captured (`attach_release`).
   */
  private hardpoints(view: View, first: boolean): void {
    for (const p of view.islands) {
      const now = p.hardpoint ? `${p.hardpoint.kind}:${p.hardpoint.side}` : '';
      const was = this.mounts.get(p.id);
      if (was === now) continue;
      this.mounts.set(p.id, now);
      if (first || was === undefined) continue;
      const at = islandAt(p, view.tick, this.at);
      if (was !== '') this.sink.sfx('attach_release', 'sky', at.x, at.y, 0);
      if (now === '') continue;
      let d = 0;
      for (let i = 0; i < this.landed.length; i += 2) if (Math.hypot(this.landed[i]! - at.x, this.landed[i + 1]! - at.y) < 3) d = 400;
      this.sink.sfx('attach_lock', 'sky', at.x, at.y, d);
      this.sink.sfx('attach_servo', 'sky', at.x, at.y, d + 300);
    }
  }

  /**
   * Storm Seeders: the public telegraph charges up, then the storm bursts. Weather is heard under the clouds only
   * (catalog HEARD_ON: Sky and, muffled, Surface), like thunder.
   */
  private seeding(view: View, first: boolean): void {
    const warn = this.nextWarnKeys;
    warn.clear();
    for (const w of view.weather.seedWarnings) {
      warn.add(w.from);
      if (!first && !this.warnKeys.has(w.from)) this.sink.sfx('seeder_charge', 'sky', w.x, w.y, 0);
    }
    this.nextWarnKeys = this.warnKeys;
    this.warnKeys = warn;
    const storms = this.nextSeededKeys;
    storms.clear();
    for (const c of view.weather.seeded) {
      storms.add(c.until);
      if (!first && !this.seededKeys.has(c.until)) this.sink.sfx('seeder_burst', 'sky', c.x, c.y, 0);
    }
    this.nextSeededKeys = this.seededKeys;
    this.seededKeys = storms;
  }

  /** Wind under the clouds, storm roar by distance to the nearest live storm: full in the Sky, muffled on the Surface. */
  private ambience(view: View): void {
    const l = this.listener;
    let storm = 0;
    for (const c of view.weather.storms) {
      if (view.tick >= c.end) continue;
      sampleStorm(c, view.tick, this.storm, 0, this.size);
      if (this.storm.stage === 'forecast') continue;
      const d = Math.hypot(this.storm.x - l.x, this.storm.y - l.y);
      storm = Math.max(storm, this.storm.strength * Math.max(0, 1 - Math.max(0, d - this.storm.radius) / 18));
    }
    this.ambiencePlane = l.plane;
    const under = l.plane === 'sky' ? 1 : l.plane === 'surface' ? 0.25 : 0;
    this.levels.wind_loop = 0.45 * under;
    this.levels.storm_loop = 0.8 * storm * under;
    for (const id of AMBIENCE_IDS) this.sink.loop(id, this.levels[id]);
  }
}
