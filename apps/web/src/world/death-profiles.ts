/**
 * Death VFX profiles: what every kind's death looks and sounds like, as data. `DeathPlayer` (`death-fx.ts`) executes
 * a profile from a fog-filtered death record; it holds no per-kind look of its own. A kind resolves to its entry in
 * `DEATH_FX`, else to its class default (`deathClass`), so a new kind needs at most one profile entry and no code.
 *
 * Units: lengths in tiles × the death's scale (`deathScale`: the profile's `size` × the kind's body size), speeds in
 * tiles/s × scale, `at`/`ms` in milliseconds after the death reaches the screen, particle `life` in seconds. Each
 * stage takes its plane's variant from `DEATH_PLANES` (gravity, a tunnel ceiling, smoke → dust or nothing, fire
 * strength, whether a scorch stays), so one stage list serves a kind wherever it dies. Three-free: the audio
 * director reads the sounds here without the renderer.
 */
import { PLANE_Y, STATS, STRUCTURE_KINDS, isStatKind, type Kind, type Plane } from '@agent-command/game/contract';
import type { OneShot } from '../audio/director.ts';

/** Named pigments (`death-fx.ts` resolves them once); `side` is the dying army's colour. */
export type DeathPigment = 'flash' | 'fire' | 'ember' | 'smoke' | 'soot' | 'dust' | 'debris' | 'spark' | 'cold' | 'splash' | 'side';

/** A one-shot or lingering effect stage. Every stage starts `at` ms after the death is on screen. */
export type DeathStage =
  /** Emissive core, the only part that blooms: one flash `size` across for `ms`, `spread` off the anchor. */
  | { readonly kind: 'flash'; readonly at: number; readonly size: number; readonly ms: number; readonly spread?: number; readonly pigment?: DeathPigment }
  /** Fire wash: `lobes` hot puffs blooming out to `size`, a wash ring under them; `spread` moves the burst off-centre. */
  | { readonly kind: 'fireball'; readonly at: number; readonly size: number; readonly ms: number; readonly lobes: number; readonly spread?: number }
  /** `count` chunks flung out at `speed` and up at `arc` (a ring: in the plane only), `size` across, resting on the floor. */
  | { readonly kind: 'debris'; readonly at: number; readonly count: number; readonly speed: number; readonly arc: number; readonly size: number; readonly life: number; readonly ring?: boolean; readonly pigment?: DeathPigment }
  /** A fan of `count` sparks, each `size` tiles long at first (default 0.08; a speck at gameplay zoom). */
  | { readonly kind: 'sparks'; readonly at: number; readonly count: number; readonly speed: number; readonly life: number; readonly size?: number; readonly pigment?: DeathPigment }
  /** A lingering column: `rate` puffs/s for `ms`, rising `rise`, growing to `size`, each living `life`, at opacity `alpha` (default 0.7). */
  | { readonly kind: 'smoke'; readonly at: number; readonly ms: number; readonly rate: number; readonly rise: number; readonly size: number; readonly life: number; readonly pigment?: DeathPigment; readonly alpha?: number }
  /** A low skirt of `count` dust puffs pushed `spread` out along the floor. */
  | { readonly kind: 'dust'; readonly at: number; readonly count: number; readonly spread: number; readonly size: number; readonly life: number }
  /** `count` chunks dropping from the plane's ceiling (else `drop` over the anchor) onto the floor. */
  | { readonly kind: 'rubble'; readonly at: number; readonly count: number; readonly drop: number; readonly size: number; readonly life: number }
  /** A flat ring from `r0` to `r1`: ink shockwave, wash bloom or dashed pencil. */
  | { readonly kind: 'ring'; readonly at: number; readonly r0: number; readonly r1: number; readonly ms: number; readonly style: 'ink' | 'wash' | 'dash'; readonly alpha: number; readonly pigment?: DeathPigment }
  /** The ink scorch splat (`RING.splat`, the impact scorch decal) on the floor, on planes that keep one; `pigment` (default soot) tints its heart. */
  | { readonly kind: 'scorch'; readonly at: number; readonly size: number; readonly ms: number; readonly pigment?: DeathPigment }
  /**
   * The model itself over `ms`: tips `tilt` rad (to a side its id picks), sinks `sink` of its height into the floor,
   * loses `squash` of its height (a building pancakes), shrinks to `shrink`, chars `char` toward ink, spins `spin`
   * rad, fading out over its last `fade` share.
   */
  | { readonly kind: 'collapse'; readonly at: number; readonly ms: number; readonly tilt: number; readonly sink: number; readonly squash: number; readonly shrink: number; readonly char: number; readonly spin: number; readonly fade: number }
  /**
   * The model falls to the plane below (`DEATH_PLANES[plane].below`) under `gravity` (tiles/s²) after a `pop` upward
   * (tiles/s), drifting `drift` tiles/s (× scale) along its last heading, nose down, tumbling `spin` rad/s, trailing
   * `trail` smoke puffs/s, then plays the profile's `landing` (ground) or `splash` (water). Without a plane below it
   * fades in place instead.
   */
  | { readonly kind: 'wreck'; readonly at: number; readonly gravity: number; readonly pop: number; readonly drift: number; readonly spin: number; readonly trail: number };

export interface DeathSound {
  readonly id: OneShot;
  /** 0..1 against the catalog level. */
  readonly level: number;
}

export interface DeathProfile {
  /** Effect scale against the kind's body size (`deathScale`). */
  readonly size: number;
  readonly stages: readonly DeathStage[];
  /** A wreck's ground strike, and its strike on water. */
  readonly landing?: readonly DeathStage[];
  readonly splash?: readonly DeathStage[];
  /** Played by the audio director at the death's on-screen tick; `land` when a wreck strikes. */
  readonly sound: DeathSound;
  readonly land?: DeathSound;
  /** Camera shake (0..1) when the death is on the focused plane (a third of it elsewhere). */
  readonly shake: number;
  /** Combat heat (`Combat.heat`) the death adds where it happened. */
  readonly heat: number;
  /** Anchor: the body (default) or the top of a Spire segment's crystal. */
  readonly anchor?: 'body' | 'spire';
}

/** A plane's variant of every stage. */
export interface DeathPlaneEnv {
  /** Debris gravity (tiles/s²) and linear drag (1/s). */
  readonly gravity: number;
  readonly drag: number;
  /** What a smoke column is here: smoke, dust (the Depths) or nothing (vacuum). */
  readonly smoke: 'smoke' | 'dust' | 'none';
  /** Fire wash strength (a muffled Depths burst, a cold vacuum flash). */
  readonly fire: number;
  /** Whether a scorch splat stays on the floor. */
  readonly scorch: boolean;
  /** Height over the floor nothing rises past (a tunnel's rock top, `DEPTHS_ROCK_HEIGHT`); Infinity when open. */
  readonly ceiling: number;
  /** Lateral spread: Depths tunnels are a tile wide. */
  readonly spread: number;
  /** Where a wreck falls. */
  readonly below?: Plane;
}

export const DEATH_PLANES: Readonly<Record<Plane, DeathPlaneEnv>> = {
  depths: { gravity: 9, drag: 1.6, smoke: 'dust', fire: 0.55, scorch: true, ceiling: 1.2, spread: 0.45 },
  surface: { gravity: 9, drag: 0.5, smoke: 'smoke', fire: 1, scorch: true, ceiling: Infinity, spread: 1 },
  sky: { gravity: 9, drag: 0.3, smoke: 'smoke', fire: 1, scorch: false, ceiling: Infinity, spread: 1, below: 'surface' },
  orbit: { gravity: 0, drag: 0, smoke: 'none', fire: 0.35, scorch: false, ceiling: Infinity, spread: 1 },
};

/** Class defaults: every kind inherits one (`deathClass`) unless `DEATH_FX` names its own profile. */
export type DeathClass = 'infantry' | 'vehicle' | 'air' | 'orbit' | 'depths' | 'structure' | 'spire' | 'neutral';

/**
 * Small arms on the ground: a body-sized pop, an ink shock loop, a dust skirt and a small ink blot where it fell, the
 * body folding over. A Trooper is a few pixels across at gameplay zoom, so the loop and blot carry the read.
 */
const INFANTRY: DeathProfile = {
  size: 1.25, shake: 0, heat: 1,
  sound: { id: 'imp_small', level: 0.8 },
  stages: [
    { kind: 'flash', at: 0, size: 1.05, ms: 160 },
    { kind: 'sparks', at: 0, count: 7, speed: 2.8, life: 0.4, size: 0.13 },
    { kind: 'ring', at: 20, r0: 0.2, r1: 1.7, ms: 520, style: 'ink', alpha: 0.95, pigment: 'debris' },
    { kind: 'dust', at: 30, count: 9, spread: 1.3, size: 0.8, life: 1.3 },
    { kind: 'scorch', at: 40, size: 0.75, ms: 2200, pigment: 'dust' },
    { kind: 'collapse', at: 0, ms: 850, tilt: 1.4, sink: 0.15, squash: 0, shrink: 0.9, char: 0.5, spin: 0, fade: 0.3 },
  ],
};

/** Armour: fireball flash, arcing chunks, a lingering column, a scorch. */
const VEHICLE: DeathProfile = {
  size: 1, shake: 0.15, heat: 1.5,
  sound: { id: 'exp_large', level: 1 },
  stages: [
    { kind: 'flash', at: 0, size: 0.8, ms: 140 },
    { kind: 'fireball', at: 20, size: 1.1, ms: 650, lobes: 6 },
    { kind: 'debris', at: 30, count: 7, speed: 2.4, arc: 4.5, size: 0.16, life: 1.5 },
    { kind: 'sparks', at: 30, count: 9, speed: 3.2, life: 0.55 },
    { kind: 'ring', at: 40, r0: 0.3, r1: 1.9, ms: 520, style: 'ink', alpha: 0.8, pigment: 'debris' },
    // a dense soot column that reads for about three seconds, over a dark ink scorch
    { kind: 'smoke', at: 150, ms: 2800, rate: 11, rise: 1.1, size: 1.2, life: 2.6, pigment: 'soot', alpha: 0.9 },
    { kind: 'scorch', at: 60, size: 1.35, ms: 6000 },
    { kind: 'collapse', at: 0, ms: 1400, tilt: 0.14, sink: 0.2, squash: 0, shrink: 0.92, char: 0.85, spin: 0.1, fade: 0.4 },
  ],
};

/** Aircraft: a midair burst, then the wreck falls smoking to the ground or into the water. */
const AIR: DeathProfile = {
  size: 1, shake: 0.1, heat: 1.5,
  sound: { id: 'exp_large', level: 0.85 },
  land: { id: 'imp_small', level: 0.9 },
  stages: [
    { kind: 'flash', at: 0, size: 0.85, ms: 130 },
    { kind: 'fireball', at: 10, size: 0.9, ms: 500, lobes: 5 },
    { kind: 'debris', at: 20, count: 6, speed: 2.6, arc: 1.5, size: 0.12, life: 1.6 },
    { kind: 'sparks', at: 20, count: 8, speed: 3.6, life: 0.5 },
    { kind: 'ring', at: 30, r0: 0.2, r1: 1.6, ms: 420, style: 'ink', alpha: 0.7, pigment: 'spark' },
    { kind: 'wreck', at: 60, gravity: 13, pop: 0.8, drift: 1.1, spin: 2.4, trail: 16 },
  ],
  landing: [
    { kind: 'flash', at: 0, size: 0.5, ms: 110 },
    { kind: 'dust', at: 0, count: 7, spread: 1.1, size: 0.45, life: 1.1 },
    { kind: 'debris', at: 0, count: 4, speed: 1.6, arc: 3, size: 0.12, life: 1.2 },
    { kind: 'smoke', at: 80, ms: 1600, rate: 4, rise: 0.8, size: 0.7, life: 2 },
    { kind: 'scorch', at: 0, size: 0.8, ms: 4200 },
  ],
  splash: [
    { kind: 'ring', at: 0, r0: 0.2, r1: 1.5, ms: 700, style: 'wash', alpha: 0.75, pigment: 'splash' },
    { kind: 'ring', at: 120, r0: 0.3, r1: 2.1, ms: 900, style: 'ink', alpha: 0.6, pigment: 'splash' },
    { kind: 'sparks', at: 0, count: 10, speed: 1.4, life: 0.7, pigment: 'splash' },
  ],
};

/**
 * Orbit ships: a silent vacuum burst: a white-hot core and a cold afterglow, an expanding ring of hull plates and
 * glints in the plane, sparks flying straight. No smoke, and nothing falls (the plane has no gravity).
 */
const ORBIT: DeathProfile = {
  size: 1, shake: 0.1, heat: 1,
  // Vacuum: no boom, only the hull's dull crack carried to the camera.
  sound: { id: 'imp_small', level: 0.45 },
  stages: [
    { kind: 'flash', at: 0, size: 1.5, ms: 200 },
    { kind: 'flash', at: 60, size: 0.95, ms: 280, pigment: 'cold' },
    { kind: 'ring', at: 0, r0: 0.2, r1: 2.8, ms: 900, style: 'ink', alpha: 1, pigment: 'spark' },
    { kind: 'ring', at: 0, r0: 0.2, r1: 1.8, ms: 600, style: 'wash', alpha: 0.6, pigment: 'cold' },
    { kind: 'debris', at: 0, count: 14, speed: 2, arc: 0, size: 0.16, life: 1.6, ring: true, pigment: 'cold' },
    { kind: 'debris', at: 0, count: 8, speed: 1.2, arc: 0, size: 0.12, life: 1.8, ring: true, pigment: 'side' },
    { kind: 'sparks', at: 0, count: 16, speed: 3.4, life: 0.6, size: 0.16 },
    { kind: 'sparks', at: 0, count: 10, speed: 2.2, life: 0.8, size: 0.12, pigment: 'cold' },
    { kind: 'collapse', at: 0, ms: 900, tilt: 0.5, sink: 0, squash: 0, shrink: 0.55, char: 0.7, spin: 1.2, fade: 0.6 },
  ],
};

/**
 * Underground: a muffled burst lit by rock sparks, a warm afterglow and shock loop, pale dust and rubble shaken from
 * the roof, an ink blot on the tunnel floor. Tunnels are a tile wide between rock tops that hide anything flat past
 * their walls: the warm light and the pale dust carry the read.
 */
const DEPTHS: DeathProfile = {
  size: 1.25, shake: 0.05, heat: 1,
  sound: { id: 'imp_small', level: 0.75 },
  stages: [
    // muffled: a warm flash held low, no fire wash
    { kind: 'flash', at: 0, size: 1.3, ms: 200 },
    { kind: 'flash', at: 60, size: 0.9, ms: 450, pigment: 'spark' },
    { kind: 'sparks', at: 0, count: 10, speed: 2.2, life: 0.5, size: 0.16 },
    { kind: 'ring', at: 20, r0: 0.15, r1: 1.5, ms: 520, style: 'ink', alpha: 0.95, pigment: 'spark' },
    { kind: 'ring', at: 20, r0: 0.15, r1: 0.95, ms: 450, style: 'wash', alpha: 0.7, pigment: 'dust' },
    { kind: 'dust', at: 20, count: 10, spread: 1, size: 0.9, life: 1.6 },
    { kind: 'rubble', at: 80, count: 7, drop: 1, size: 0.15, life: 1.3 },
    { kind: 'smoke', at: 150, ms: 1300, rate: 8, rise: 0.4, size: 0.7, life: 1.6, alpha: 0.9 },
    { kind: 'scorch', at: 40, size: 0.85, ms: 2600 },
    { kind: 'collapse', at: 0, ms: 850, tilt: 1.1, sink: 0.3, squash: 0, shrink: 0.88, char: 0.45, spin: 0, fade: 0.35 },
  ],
};

/** Buildings: a bigger, staged collapse: the first blast, secondary blasts round the footprint, the fall in dust. */
const STRUCTURE: DeathProfile = {
  size: 1, shake: 0.35, heat: 2.4,
  sound: { id: 'collapse', level: 1 },
  stages: [
    { kind: 'flash', at: 0, size: 0.9, ms: 160 },
    { kind: 'fireball', at: 20, size: 1.1, ms: 700, lobes: 7 },
    { kind: 'ring', at: 40, r0: 0.4, r1: 2.2, ms: 650, style: 'ink', alpha: 0.85, pigment: 'debris' },
    { kind: 'flash', at: 320, size: 0.55, ms: 120, spread: 0.55 },
    { kind: 'fireball', at: 340, size: 0.6, ms: 520, lobes: 4, spread: 0.55 },
    { kind: 'flash', at: 640, size: 0.5, ms: 120, spread: 0.6 },
    { kind: 'debris', at: 300, count: 9, speed: 1.8, arc: 4, size: 0.18, life: 1.8 },
    { kind: 'dust', at: 700, count: 12, spread: 1.4, size: 0.7, life: 1.8 },
    { kind: 'rubble', at: 500, count: 6, drop: 1.2, size: 0.16, life: 1.4 },
    { kind: 'smoke', at: 300, ms: 3600, rate: 5, rise: 1, size: 1.1, life: 2.8, pigment: 'soot' },
    { kind: 'scorch', at: 100, size: 1.2, ms: 7000 },
    { kind: 'collapse', at: 200, ms: 1800, tilt: 0.06, sink: 0, squash: 0.92, shrink: 0.96, char: 0.9, spin: 0, fade: 0.25 },
  ],
};

/** A Spire segment's crystal bursts at its top (`spires.ts` draws the shattered casing): ink ring and side shards. */
const SPIRE: DeathProfile = {
  size: 1, shake: 0.6, heat: 3, anchor: 'spire',
  sound: { id: 'collapse', level: 1 },
  stages: [
    { kind: 'flash', at: 0, size: 0.6, ms: 180, pigment: 'side' },
    { kind: 'ring', at: 0, r0: 0.12, r1: 0.75, ms: 550, style: 'ink', alpha: 0.6, pigment: 'side' },
    { kind: 'debris', at: 0, count: 8, speed: 0.75, arc: 0.6, size: 0.065, life: 0.9, pigment: 'side' },
    { kind: 'fireball', at: 250, size: 0.45, ms: 700, lobes: 5, spread: 0.3 },
    { kind: 'ring', at: 300, r0: 0.3, r1: 1.2, ms: 900, style: 'wash', alpha: 0.4, pigment: 'dust' },
    { kind: 'dust', at: 450, count: 10, spread: 0.8, size: 0.4, life: 1.8 },
    { kind: 'smoke', at: 400, ms: 3000, rate: 4, rise: 0.9, size: 0.6, life: 2.6, pigment: 'soot' },
  ],
};

/** Neutral bodies never die through a death record today; they inherit a plain burst so nothing resolves to nothing. */
const NEUTRAL: DeathProfile = {
  size: 1, shake: 0, heat: 0,
  sound: { id: 'imp_small', level: 0.6 },
  stages: [
    { kind: 'flash', at: 0, size: 0.5, ms: 110 },
    { kind: 'debris', at: 0, count: 5, speed: 1.6, arc: 2, size: 0.12, life: 1 },
    { kind: 'collapse', at: 0, ms: 500, tilt: 0, sink: 0, squash: 0, shrink: 0.5, char: 0.5, spin: 0.5, fade: 0.6 },
  ],
};

export const DEATH_CLASSES: Readonly<Record<DeathClass, DeathProfile>> = {
  infantry: INFANTRY, vehicle: VEHICLE, air: AIR, orbit: ORBIT, depths: DEPTHS, structure: STRUCTURE, spire: SPIRE, neutral: NEUTRAL,
};

const withSize = (p: DeathProfile, size: number, sound = p.sound): DeathProfile => ({ ...p, size, sound });

/** Per-kind profiles where the class default is not enough. */
export const DEATH_FX: Readonly<Partial<Record<Kind, DeathProfile>>> = {
  tank: { ...VEHICLE, size: 1.15, shake: 0.2, stages: [...VEHICLE.stages, { kind: 'debris', at: 60, count: 1, speed: 0.6, arc: 6, size: 0.32, life: 2 }] },
  flak: withSize(VEHICLE, 1),
  breacher: {
    ...INFANTRY,
    sound: { id: 'exp_large', level: 0.6 },
    // its fuel tank goes up: a short fire wash and a puff of soot
    stages: [...INFANTRY.stages, { kind: 'fireball', at: 30, size: 0.55, ms: 420, lobes: 4 }, { kind: 'smoke', at: 120, ms: 900, rate: 4, rise: 0.8, size: 0.5, life: 1.4, pigment: 'soot' }],
  },
  sapper: {
    ...DEPTHS,
    size: 1.2,
    sound: { id: 'exp_large', level: 0.6 },
    // the charge it carries cooks off
    stages: [...DEPTHS.stages, { kind: 'fireball', at: 10, size: 0.7, ms: 450, lobes: 4 }],
  },
  bomber: { ...AIR, size: 1.2, sound: { id: 'exp_large', level: 1 } },
  gunship: withSize(AIR, 1.1, { id: 'exp_large', level: 0.95 }),
  interceptor: withSize(AIR, 0.9),
  lancer: withSize(ORBIT, 1.2, { id: 'imp_small', level: 0.55 }),
  bastion: withSize(ORBIT, 1.3, { id: 'imp_small', level: 0.6 }),
  skiff: withSize(ORBIT, 0.85),
  // panel glass shatters in a glittering ring
  solar: { ...ORBIT, stages: [...ORBIT.stages, { kind: 'debris', at: 0, count: 8, speed: 1.1, arc: 0, size: 0.1, life: 1.6, ring: true, pigment: 'cold' }] },
  spire: SPIRE,
};

const STRUCTURES: ReadonlySet<Kind> = new Set(STRUCTURE_KINDS);

/** The class a kind inherits its profile from: Spire segment, structure, then a unit's home plane and armour. */
export function deathClass(kind: Kind): DeathClass {
  if (kind === 'spire') return 'spire';
  if (STRUCTURES.has(kind)) return 'structure';
  if (!isStatKind(kind)) return 'neutral';
  const s = STATS[kind];
  if (s.plane === 'depths') return 'depths';
  if (s.plane === 'sky') return 'air';
  if (s.plane === 'orbit') return 'orbit';
  return s.armor === 'light' ? 'infantry' : 'vehicle';
}

/** Every kind's profile: its own entry, else its class default. Never undefined. */
export function deathProfile(kind: Kind): DeathProfile {
  return DEATH_FX[kind] ?? DEATH_CLASSES[deathClass(kind)];
}

/** A kind's body size against a mid unit (a Tank's 0.6-tile radius ≈ 1.2): footprint half-diagonal for buildings. */
export function bodySize(kind: Kind): number {
  if (!isStatKind(kind)) return 1;
  const s = STATS[kind];
  const f = s.footprint;
  return f ? Math.hypot(f.w, f.h) / 2 : s.radius / 0.5;
}

/** The scale every length and speed of `kind`'s death stages is multiplied by. */
export const deathScale = (kind: Kind): number => deathProfile(kind).size * bodySize(kind);

/**
 * About how many ms after a `kind` death on `plane` its wreck strikes the plane below (undefined: nothing falls): the
 * fall between the two planes' reference heights. The drawn fall lands on the actual ground, within a few frames.
 */
export function wreckFallMs(kind: Kind, plane: Plane): number | undefined {
  const below = DEATH_PLANES[plane].below;
  if (below === undefined) return undefined;
  const drop = PLANE_Y[plane] - PLANE_Y[below];
  for (const s of deathProfile(kind).stages)
    if (s.kind === 'wreck') return s.at + ((s.pop + Math.sqrt(s.pop * s.pop + 2 * s.gravity * drop)) / s.gravity) * 1000;
  return undefined;
}
