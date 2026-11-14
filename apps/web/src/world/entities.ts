/**
 * Entities: one InstancedMesh per kind, tinted by side, interpolated between server views (snapshot buffer keyed by tick).
 * Field Journal dressing (docs/art/DIRECTIONS.md §1 "Unit readability"): a team-coloured watercolour dab with an ink
 * rim under every unit and structure (ownership reads even when a model is a few pixels tall), an ink altitude stalk
 * from each flyer down to its dab, and ink-rimmed selection loops.
 * Also: Spire beams/segments, selection rings, relay vision cones (tug tow ropes: `orbit.ts`).
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InstancedMesh,
  type InterleavedBufferAttribute,
  LineBasicNodeMaterial,
  LineSegments,
  Mesh,
  MeshBasicNodeMaterial,
  NoBlending,
  Object3D,
  PlaneGeometry,
  RingGeometry,
  Sphere,
  Vector3,
  type Node,
} from 'three/webgpu';
import { abs, atan, attribute, cameraPosition, cameraViewMatrix, color, dot, float, fract, instancedDynamicBufferAttribute, max, mix, mrt, mx_noise_float, packNormalToRGB, positionGeometry, positionLocal, reflect, sin, smoothstep, step, time, uniform, uv, varying, vec3, vec4 } from 'three/tsl';
import { ARMIES, CELL, ECON, KINDS, PLANES, PLANE_Y, STATS, TICK_RATE, footprint, isHardpointKind, isNeutralKind, isStatKind, sunOffset, type ArmyId, type Entity, type Kind, type Plane, type View } from '@agent-command/game/contract';
import { diggerCarryMax } from '@agent-command/game/economy';
import { matchView, type MatchView } from '../match-view.ts';
import { fadeValue, focusValue } from './fade.ts';
import { DEPTHS_ROCK_HEIGHT, GROUND, clamp, relation, sideColor, unitY, wx, wz } from './common.ts';
import { PIDX } from './combat.ts';
import { SUN, aboveStorm, clock, clockAt, commandOverlay, hatch, lines, lum, noise, overlay, seen, type F1, type V3 } from './materials.ts';
import { AIR_SCALE, BASTION_PART, BASTION_PD, BREACHER, EMPLACE_SWAP, GUN_PLATFORM_TURRET_Y, GUNSHIP, MORTAR_MUZZLE, PART, RIG, SOLAR, SOLAR_PART, TANK_SIEGE, TUG_MINER, TURRET, UNIT_SCALE, bumpWindow, depthsDropoffModel, easeWindow, footprintModelScale, hardpointOffset, islandIdentity, islandModel, model, packSolar, STATE_VISUALS, stateVisualChannel, type DropoffKind } from './models.ts';
import { IslandGrove, islandStormPaint, prepareIslandGroves } from './island-groves.ts';
import { IslandOre, islandOreTemplate } from './island-ore.ts';
import { delivered, dropoffKind, landingKind, receivesDelivery, stepHaul, type HaulState } from './dropoffs.ts';
import { Presentations, type PresentationState } from './passages.ts';
import { INK, SHADOW, VIEW } from './palette.ts';
import { REC, STRIDE, TREAD, arrivalScale, constructionRecord, mountPitchStep, packMount, recordAttributes, solarStatus, unitRig, unitZoomScale } from './rig.ts';
import { TerrainField, groundAt } from './terrain.ts';
import { Trenches } from './trenches.ts';
import { SelectionContours, contourEligible } from './selection-contours.ts';
import type { FogField } from './fog.ts';
import { asteroidPosition, rockResource, rockFuseGlow, rockScale, type Fall } from './asteroid.ts';
import { BODY_CENTRE, crossPlaneAim, shotAim } from './aim.ts';
import { RETURN_DIVE, RETURN_LINGER, diveProgress, hopFade, returnHop, returnWarning, type ReturnHop } from './returns.ts';
import { prepareStartup } from './startup.ts';
import { Spires } from './spires.ts';
import { BODY_LIFT, type DeathPlayer, type DeathSlot } from './death-fx.ts';

/** Snapshots kept per entity for interpolation. */
const HIST = 4;
/** Minimum render delay behind the newest snapshot, in snapshot intervals (absorbs network/timer jitter). */
const DELAY_SNAPS = 1.6;
/** Moves faster than this (tiles/s) turn the unit; slower nudges (separation) do not. */
const TURN_SPEED = 0.25 / TICK_RATE;
/** Heading slew rate (rad/s). */
const SLEW = 7;
/** Facing follows the estimated travel direction with damping, not the quantized position of each packet. */
const FACING_RESPONSE = 0.18;
/** A jump longer than this between snapshots is a teleport (fall, transfer): snap, don't slide. */
const TELEPORT = 3;
/**
 * Construction-site look (KindMesh): the cut line's half-width (model units) and how far it darkens the paint, the
 * pencil hatching's frequency, coverage and base wash above the cut, and the sketch's dithered opacity.
 */
const CONSTRUCTION = { line: 0.03, cutShade: 0.3, hatchFreq: 10, hatch: 0.7, wash: 0.15, sketchAlpha: 0.75 } as const;
/** Contact shading on grounded kinds (structures, walkers, tracks): paint darkens to `floor` at the base, clearing by `height` (model units). */
const CONTACT = { floor: 0.8, height: 0.12 } as const;
/** Idle glow breathing (KindMesh) on structures with no other idle life: rate (rad/s) and depth (share of the glow). */
const GLOW_PULSE: Partial<Record<Kind, { rate: number; depth: number }>> = { geothermal: { rate: 2.2, depth: 0.35 }, stormcatcher: { rate: 1.6, depth: 0.45 } };
/** A tethering Mooring Tower's crown crackle: flicker rate (rad/s), and the glow multiplier lit (floor + flare) or dark (floor). */
const MOORING_CRACKLE = { rate: 23, flare: 1.8, floor: 0.2 } as const;
/** Lancer lance tip: its flare's decay (s, the beam's fire envelope), peak gain and the dim rest between shots. */
const LANCE_TIP = { seconds: 0.62, flare: 1.6, rest: 0.4 } as const;
/**
 * An Aerie launch (presentation): over the launch window the aircraft rolls out of the hangar mouth by up to `roll`
 * tiles (back in by the end, where flight resumes) and lifts from `deck` above the Sky plane from `liftFrom` of it.
 */
const AERIE_LAUNCH = { deck: 0.12, roll: 0.6, liftFrom: 0.3 } as const;
/** Docking at an Aerie (presentation): the housed aircraft settles onto the deck and shrinks into the hangar (s). */
const AERIE_DOCK = { seconds: 0.45 } as const;
/** Half the running gear's gauge (model units): the arc a track or foot covers per radian turned in place. */
const TURN_GAUGE = 0.25;
/** Asteroid seams (KindMesh): noise frequency over the rock, its vertical lean, and the seam and fissure widths. */
const ROCK_SEAM = { scale: 0.9, lean: 0.4, seam: [0.02, 0.07], fissure: [0.008, 0.03] } as const;

export interface Track {
  e: Entity;
  /** latest authoritative tile position */
  x: number;
  y: number;
  /** snapshot ring (oldest first): server tick and tile position */
  readonly st: Float64Array;
  readonly sx: Float32Array;
  readonly sy: Float32Array;
  /** Authoritative vertical displacement, interpolated on the same clock as map coordinates. */
  readonly sh: Float32Array;
  n: number;
  /** rendered heading and the heading it is slewing toward */
  heading: number;
  goal: number;
  /** Smooth exposed authoritative mount bearing, independent of cosmetic shot endpoints. */
  aim: number;
  /** Last shot's target resolved only against currently visible view tracks (never hidden ids). */
  mountTarget?: string;
  /** Turret-mount barrel elevation about its `RIG.elevate` trunnion (rad, relative to the barrel's rest pose). */
  mountPitch: number;
  /**
   * Cross-plane aim (`aim.ts`): until `aimUntil` (render ms) the mount elevates toward the world point `aimX/Y/Z`,
   * following a falling rock as drawn (`aimFall`) or a unit target's own track (`aimTarget`; this view's tracks only).
   */
  aimUntil: number;
  aimX: number;
  aimY: number;
  aimZ: number;
  aimFall?: Fall;
  aimTarget?: string;
  /** Quantized hull attitude shared by the shader and muzzle attachment helper. */
  bank: number;
  pitch: number;
  /** Travel bearing for the tow tether, independent of the hull facing back at its asteroid. */
  towHeading: number;
  /** constant per-entity phase for bob / spin (never derived from instance order or position) */
  readonly phase: number;
  /** current render position (tile coords + world y) */
  rx: number;
  ry: number;
  wy: number;
  elevation: number;
  /** Actual model scale and discontinuity generation, shared with the Orbit's bounded engine-wake pool. */
  scale: number;
  motionEpoch: number;
  wakeSlot: number;
  visible: boolean;
  /** animation state (`rig.ts`): last shot and hit (performance.now() ms of the on-screen tick), smoothed speed
   * (tiles/s), acceleration and turn rate (rad/s), distance travelled (model units), solar panel roll (rad) */
  fireAt: number;
  hitAt: number;
  /** Authoritative shield loss, separate from hull flinch; scheduled on the same render clock. */
  shieldAt: number;
  speed: number;
  accel: number;
  turn: number;
  odo: number;
  roll: number;
  haul?: HaulState;
  presentation?: PresentationState;
  /** server tick of a timed visit's return hop still diving on screen (0 = none), and the plane it fell from */
  dive: number;
  /** Damaged look (`Combat.damaged`): fractional soot, spark and fire emission carried between frames. */
  smokeDebt?: number;
  sparkDebt?: number;
  fireDebt?: number;
  /** Render time (ms) it spawned into view or changed plane: the arrival grow-in runs from it (`arrivalScale`). */
  bornAt?: number;
  /** Render time (ms) its Aerie launch began (`AERIE_LAUNCH`). */
  launchAt?: number;
  /** Render time (ms) it was housed in an Aerie (`AERIE_DOCK`): it stays drawn, docking, until the window ends. */
  dockAt?: number;
  /** Render time (ms) it replaced its Gunship / Gun Platform partner (`EMPLACE_SWAP`); undefined: no swap. */
  swapAt?: number;
  diveFrom: Plane;
}

function idPhase(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

/** Shortest signed angle from a to b. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Work bearings use only this view's exposed targets, never hidden orders or rendered tow offsets. */
export function workHeading(e: Entity, army: ArmyId, tracks: ReadonlyMap<string, { e: Entity }>, towHeading?: number): number | undefined {
  switch (e.state) {
    case 'moving':
      if (e.kind !== 'tug' || !e.link) return undefined;
      break;
    case 'attacking':
      // These weapons turn independently: their work target must not steer the hull.
      if (e.kind === 'spire' || (isStatKind(e.kind) && STATS[e.kind].mount?.kind === 'turret')) return undefined;
      break;
    case 'constructing':
      if (e.kind !== 'digger') return undefined;
      break;
    case 'digging': case 'mining': case 'fortifying': case 'laying': case 'bridging':
    case 'undermining': case 'grappling': case 'towing': case 'capturing':
      break;
    case 'contested':
      // A digger waiting its turn at a held Mother Lode cell keeps facing it.
      if (e.kind !== 'digger') return undefined;
      break;
    default: return undefined;
  }
  const own = e.side === army;
  const linked = e.link ? tracks.get(e.link)?.e : undefined;
  const point = own && e.work ? e.work : linked;
  // A tow order's destination is where the tug is travelling, not the rock it is working on.
  const destination = own && e.state !== 'towing' && e.state !== 'moving';
  const x = point?.x ?? (destination ? e.tx : undefined);
  const y = point?.y ?? (destination ? e.ty : undefined);
  if (x === undefined || y === undefined) return undefined;
  let dx = x - e.x, dy = y - e.y;
  if (dx * dx + dy * dy <= 1e-8 && linked) {
    dx = linked.x - e.x;
    dy = linked.y - e.y;
  }
  if (dx * dx + dy * dy <= 1e-8) {
    // The sim co-locates a towed rock (or the derelict core) with its tug; it is drawn TOW_LEN behind along the tow
    // bearing. The tug faces that bearing (cab ahead, grapple and payload behind its stern, models.ts), so it pulls the
    // payload rather than backing.
    return e.kind === 'tug' && (e.state === 'towing' || e.state === 'moving') && (linked?.kind === 'asteroid' || linked?.kind === 'core') && towHeading !== undefined
      ? towHeading : undefined;
  }
  return Math.atan2(dy, dx);
}

/** Current physical muzzle position, without temporary vectors. Returns the hull's visible barrel count. */
export function orbitMuzzle(out: Float64Array, tr: Track, index: number, now: number, size: number): number {
  const kind = tr.e.kind;
  const twin = kind === 'gunship' || kind === 'gun_platform';
  const count = kind === 'bastion' || kind === 'flak' || kind === 'skiff' || twin ? 2 : kind === 'breacher' || kind === 'lancer' || kind === 'tank' || kind === 'turret' || kind === 'tug' || kind === 'island_mortar' ? 1 : 0;
  if (!count || index < 0 || index >= count) return count;
  const rig = RIG[kind];
  const t = clockAt(now);
  const shotAge = (now - tr.fireAt) / 1000;
  const fire = shotAge >= 0 ? Math.max(0, 1 - shotAge / 0.3) ** 2 : 0;
  let x = kind === 'bastion' ? BASTION_PD.tip : kind === 'lancer' ? 0.845 : kind === 'tank' ? 0.76 : kind === 'turret' ? TURRET.tip : kind === 'flak' ? 0.2 + 0.42 * Math.cos(0.91) : twin ? GUNSHIP.turret.tip : 0.35;
  let y = kind === 'bastion' ? BASTION_PD.height : kind === 'tank' ? 0.42 : kind === 'turret' ? TURRET.y : kind === 'flak' ? 0.44 + 0.42 * Math.sin(0.91) : kind === 'skiff' ? -0.0175
    : kind === 'gunship' ? GUNSHIP.turret.y : kind === 'gun_platform' ? GUN_PLATFORM_TURRET_Y : 0;
  let z = (index === 0 ? -1 : 1) * (kind === 'bastion' ? BASTION_PD.z : kind === 'flak' ? 0.08 : kind === 'skiff' ? 0.10 : twin ? GUNSHIP.turret.twin : 0);
  if (kind === 'breacher') { x = BREACHER.nozzle.x; y = BREACHER.nozzle.y; z = BREACHER.nozzle.z; }
  if (kind === 'tug') { x = TUG_MINER.x; y = TUG_MINER.y; z = TUG_MINER.z; }
  if (kind === 'island_mortar') { x = MORTAR_MUZZLE.x; y = MORTAR_MUZZLE.y; }
  // A tank's siege transformation (STATE_VISUALS.tank, in table order): the hull settles and dips, the barrel runs out
  // and rises, the turret swings out and back; all at rest once sieged, and nothing fires mid-transformation.
  const siege = kind === 'tank' ? stateVisualChannel(tr.e, 'work', 0) : 0;
  if (siege > 0) {
    const { settle, extend, swing, thud } = TANK_SIEGE;
    y += TANK_SIEGE.raise * easeWindow(extend, siege) - TANK_SIEGE.lower * easeWindow(settle, siege) - TANK_SIEGE.dip * bumpWindow(thud, siege);
    x *= 1 + (TANK_SIEGE.reach - 1) * easeWindow(extend, siege);
    const a = TANK_SIEGE.turn * bumpWindow(swing, siege);
    const px = x + 0.06;
    x = px * Math.cos(a) + z * Math.sin(a) - 0.06;
    z = z * Math.cos(a) - px * Math.sin(a);
  }
  if (rig.recoil) {
    const heavy = rig.recoil.deployed ? 1 + (rig.recoil.deployed - 1) * siege : 1;
    x -= fire * rig.recoil.dist * rig.recoil.dx * heavy;
    y -= fire * rig.recoil.dist * rig.recoil.dy * heavy;
  }
  if (rig.elevate) {
    // The drawn barrel carries the record's quantized elevation; the muzzle sits on that barrel.
    const a = mountPitchStep(tr.mountPitch);
    const dx = x - rig.elevate.x, dy = y - rig.elevate.y;
    x = rig.elevate.x + dx * Math.cos(a) - dy * Math.sin(a);
    y = rig.elevate.y + dx * Math.sin(a) + dy * Math.cos(a);
  }
  if (kind === 'bastion') {
    const yaw = tr.heading - tr.aim;
    const dx = x - BASTION_PD.x;
    x = BASTION_PD.x + Math.cos(yaw) * dx;
    z -= Math.sin(yaw) * dx;
  }
  else if (rig.top) {
    const kick = fire * rig.top.kick;
    const dx = x - rig.top.x, dy = y - rig.top.y;
    x = rig.top.x + dx * Math.cos(kick) - dy * Math.sin(kick);
    y = rig.top.y + dx * Math.sin(kick) + dy * Math.cos(kick);
    if (isStatKind(kind) && STATS[kind].mount?.kind === 'turret') {
      const yaw = tr.heading - tr.aim;
      const px = x - rig.top.x;
      const pz = z;
      x = rig.top.x + px * Math.cos(yaw) + pz * Math.sin(yaw);
      z = pz * Math.cos(yaw) - px * Math.sin(yaw);
    }
  }
  if (rig.gait?.kind === 'tracks') {
    const speed = clamp((tr.speed - 0.08) / (0.7 - 0.08), 0, 1);
    const move = speed * speed * (3 - 2 * speed);
    y += Math.abs(Math.sin(tr.odo * (Math.PI * 4) / rig.gait.stride)) * 0.012 * move;
  }
  if (rig.gait?.kind === 'legs') {
    const speed = clamp((tr.speed - 0.08) / (0.7 - 0.08), 0, 1);
    const move = speed * speed * (3 - 2 * speed);
    y += (Math.abs(Math.cos(tr.odo * Math.PI * 2 / rig.gait.stride)) - 0.5) * 0.03 * move;
    const a = -0.12 * move, px = x;
    x = px * Math.cos(a) - y * Math.sin(a);
    y = px * Math.sin(a) + y * Math.cos(a);
  }
  if (rig.jolt) {
    const angle = fire * rig.jolt;
    const px = x;
    x = px * Math.cos(angle) - y * Math.sin(angle) - fire * rig.jolt * 0.3;
    y = px * Math.sin(angle) + y * Math.cos(angle);
  }
  if (rig.shudder) y += Math.sin(t * 31 + tr.phase * 7) * rig.shudder;
  if (rig.gait?.kind === 'legs') y *= 1 + Math.sin(t * 2.2 + tr.phase) * 0.015;
  y += Math.sin(t * 0.9 + tr.phase) * (rig.hover ?? 0);
  const hit = Math.max(0, Math.min(1, 1 - (now - tr.hitAt) / 250));
  y *= 1 - hit * 0.06;
  z += Math.sin(t * 60) * 0.03 * hit;
  x *= tr.scale; y *= tr.scale; z *= tr.scale;
  const cp = Math.cos(tr.pitch), sp = Math.sin(tr.pitch);
  const px = x * cp - y * sp;
  const py = x * sp + y * cp;
  const cb = Math.cos(tr.bank), sb = Math.sin(tr.bank);
  y = py * cb - z * sb;
  z = py * sb + z * cb;
  const ch = Math.cos(tr.heading), sh = Math.sin(tr.heading);
  out[0] = wx(tr.rx, size) + px * ch - z * sh;
  out[1] = tr.wy + y;
  out[2] = wz(tr.ry, size) + px * sh + z * ch;
  return count;
}

/** A cross-plane aim holds this long past its shot (ms), and at least this many weapon cooldowns. */
const AIM_HOLD_MS = 1000;
const AIM_HOLD_COOLDOWNS = 2.5;
/** Mount response time constant (s): traverse and elevation ease toward their goals, capped by the traverse rate. */
const MOUNT_RESPONSE = 0.12;
const AIM_ROCK = { x: 0, y: 0, z: 0 };
/** Scratch for `Entities.fire` (resolved at snapshot ingest, never per frame). */
const AIM = shotAim();

/**
 * Only the exposed authoritative pose steers a mount; idle mounts settle forward and level. While a cross-plane aim
 * holds (`Entities.fire`), the barrels elevate toward its point, following the engaged rock or unit as drawn; a rock
 * also takes the bearing, because it is drawn off its logical Sky-plane path.
 */
export function stepMountAim(tr: Track, dt: number, now: number, renderTick: number, size: number, tracks: ReadonlyMap<string, Track>): void {
  const kind = tr.e.kind;
  if (!isStatKind(kind)) return;
  const mount = STATS[kind].mount;
  if (mount?.kind !== 'turret') return;
  const elevate = RIG[kind].elevate;
  const holding = elevate !== undefined && now < tr.aimUntil && tr.e.state !== 'idle';
  if (holding && tr.aimFall) {
    asteroidPosition(tr.aimFall, renderTick, AIM_ROCK, size);
    tr.aimX = AIM_ROCK.x; tr.aimY = AIM_ROCK.y; tr.aimZ = AIM_ROCK.z;
  } else if (holding && tr.aimTarget) {
    const target = tracks.get(tr.aimTarget);
    if (target) {
      tr.aimX = wx(target.rx, size); tr.aimY = target.wy + BODY_CENTRE * target.scale; tr.aimZ = wz(target.ry, size);
    }
  }
  const dx = tr.aimX - wx(tr.rx, size), dz = tr.aimZ - wz(tr.ry, size);
  const goal = holding && tr.aimFall ? Math.atan2(dz, dx) : (tr.e.state !== 'idle' ? tr.e.aim : undefined) ?? tr.heading;
  const ease = -Math.expm1(-Math.max(0, dt) / MOUNT_RESPONSE);
  const limit = mount.traverse * Math.max(0, dt);
  tr.aim += clamp(angleDelta(tr.aim, goal) * ease, -limit, limit);
  if (!elevate) return;
  const pitch = holding ? clamp(Math.atan2(tr.aimY - (tr.wy + elevate.y * tr.scale), Math.hypot(dx, dz)) - elevate.rest, elevate.min, elevate.max) : 0;
  tr.mountPitch += clamp((pitch - tr.mountPitch) * ease, -limit, limit);
}

const CAP: Partial<Record<Kind, number>> = { island: 16, asteroid: 32, core: 2, spire: 4, relay: 32, shaft: 64, turret: 64, gun_platform: 32 };
const tmp = new Object3D();
/**
 * A record's `REC.build`: a structure under construction carries its progress (`constructionRecord`: drawn full
 * height, painted below a rising cut line and sketched above it); everything else stands full height (1). A digger
 * busy constructing keeps its own shape.
 */
export function buildRecord(e: Entity): number {
  return e.state === 'constructing' && STRUCT.has(e.kind) ? constructionRecord(e.progress ?? 0) : 1;
}
/** A towed asteroid or core sits on its tug in the sim; it is drawn this far behind (tiles) so the tug and rope read. */
const TOW_LEN = 2.6;
/** The derelict core's drawn size (×zoom enlargement, like units): a beacon, not its collect radius. */
const CORE_SCALE = 1.1;
const STRUCT = new Set<Kind>(KINDS.filter((kind) => footprint(kind)));
// order lines are drawn in pen on the page: saturated enough to read on cream paper
const ORDER_C = new Color('#5fa83a');
const ATTACK_C = new Color('#e0404e');
const QUEUE_C = new Color('#6f8fbf');
/** The ink a dying model's team accents char toward. */
const CHAR = new Color('#2a2420');
// Selection rings by relation to the viewing army (own / allied / hostile / neutral).
const SEL_OWN = new Color(0.55, 1, 0.45);
const HOVER_OWN = new Color(0.5, 0.8, 1);
const SEL_ALLIED = new Color(0.55, 0.9, 1);
const SEL_NEUTRAL = new Color(1, 0.9, 0.5);
const SEL_HOSTILE = new Color(1, 0.35, 0.3);
const DAB_CAP = 900;
const STALK_CAP = 300;
/** Rotor-wash records: two (one per ducted fan) per flying Gunship. */
const WASH_CAP = 128;
const WASH_SIDES = [-1, 1] as const;
/** Two hollow hit ellipses per ship; admission drops excess cosmetics instead of allocating. */
const SHIELD_CAP = 512;
const SHIELD_LINGER = 650;
/** Kinds with a wide footprint get a wider dab. */
const BIG: Partial<Record<Kind, true>> = { tank: true, bomber: true, gunship: true, shaft: true, turret: true, relay: true, flak: true };
/** Ascent contrails/marks (shared with return hops), return warning arcs, and return hops in flight. */
const TRAIL_CAP = 600;
const RETURN_CAP = 256;
const HOP_CAP = 64;

/** Axis-aligned instance matrix: scale (r, h, r) at (x, y, z). */
function putFlat(m: Float32Array, i: number, x: number, y: number, z: number, r: number, h: number): void {
  const o = i * 16;
  m[o] = r; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
  m[o + 4] = 0; m[o + 5] = h; m[o + 6] = 0; m[o + 7] = 0;
  m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = r; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
}

/** Append a snapshot (server tick, tile position, vertical displacement) to a track's ring, dropping the oldest. */
function pushSample(tr: Track, tick: number, x: number, y: number, h: number): void {
  if (tr.n === HIST) {
    tr.st.copyWithin(0, 1);
    tr.sx.copyWithin(0, 1);
    tr.sy.copyWithin(0, 1);
    tr.sh.copyWithin(0, 1);
    tr.n--;
  }
  tr.st[tr.n] = tick;
  tr.sx[tr.n] = x;
  tr.sy[tr.n] = y;
  tr.sh[tr.n] = h;
  tr.n++;
}

/** How far (tiles, Manhattan) a death record may lie from the track's last snapshot and still be its death. */
const DEATH_REACH = 2;

/**
 * The death record, in this view's fog-filtered fx, of a track the view just lost: its kind, plane and army, after
 * its last snapshot, nearest where it was. Undefined: it left the view some other way (fog, a hangar, a transit).
 */
function deathOf(fx: View['fx'], tr: Track): View['fx'][number] | undefined {
  const last = tr.n > 0 ? tr.st[tr.n - 1]! : -Infinity;
  let best: View['fx'][number] | undefined;
  let reach = DEATH_REACH;
  for (const f of fx) {
    if (f.kind !== 'death' || f.subject !== tr.e.kind || f.plane !== tr.e.plane || f.side !== tr.e.side || f.tick <= last) continue;
    const d = Math.abs(f.x - tr.x) + Math.abs(f.y - tr.y);
    if (d < reach) { reach = d; best = f; }
  }
  return best;
}

/** Shadow tint of the plane with index `pi` (0 depths … 3 orbit), per instance. */
function planeShadow(pi: Node<'float'>): V3 {
  const s = (p: Plane) => color(SHADOW[p]);
  return pi.lessThan(0.5).select(s('depths'), pi.lessThan(1.5).select(s('surface'), pi.lessThan(2.5).select(s('sky'), s('orbit')))) as unknown as V3;
}

/** Upload runs per kind and frame before the whole buffer is uploaded instead. */
const MAX_RUNS = 16;
/** Animation state is quantised so idle and steady units keep identical records (no upload). */
const q = (v: number, step: number): number => Math.round(v / step) * step;
/** Acceleration (tiles/s²) below which units do not pitch: wire rounding alone produces about this much. */
const ACCEL_DEADBAND = 1;
/** Turn rate (rad/s) below which units do not bank. */
const TURN_DEADBAND = 0.35;
/** Bearing (rad) over which a solar array's trim eases between its day and night tone at a wedge edge. */
const SOLAR_DUSK = 0.03;
/** Fighters roll into a turn; heavy ships only lean, and solar panels keep their sun-tracking attitude. */
const ORBIT_BANK: Readonly<Partial<Record<Kind, number>>> = { interceptor: 0.3, skiff: 0.3, bastion: 0.035, solar: 0 };
/** Sky roll limit: the armoured twin-rotor gunship only leans; the jets roll fully. */
const SKY_BANK: Readonly<Partial<Record<Kind, number>>> = { gunship: 0.25 };

/** An instanced copy of a cached model sharing its vertex attributes plus the per-instance record views. */
function instancedModel(src: BufferGeometry, rec: Record<string, InterleavedBufferAttribute>): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  for (const [name, a] of Object.entries(src.attributes)) g.setAttribute(name, a);
  for (const [name, a] of Object.entries(rec)) g.setAttribute(name, a);
  g.instanceCount = 0;
  g.boundingSphere = new Sphere();
  return g;
}

/**
 * One instanced draw per kind: cel-shaded paint with the team colour on the accent parts, ink lines, a dithered plane
 * fade, and the vertex rig (`rig.ts`). Per instance: one `STRIDE`-float record; only changed records are uploaded.
 */
class KindMesh {
  readonly mesh: Mesh;
  readonly cap: number;
  readonly footprintScale: number;
  readonly halfX: number;
  readonly halfZ: number;
  count = 0;
  private readonly data: Float32Array;
  private readonly buf: InstancedInterleavedBuffer;
  private readonly geo: InstancedBufferGeometry;
  /** model bounding radius plus the animation margin */
  private readonly radius: number;
  private changed = false;
  private runStart = -1;
  private runEnd = -1;
  private dirty = false;
  /** instance extents this frame (bounding sphere) */
  private x0 = 0;
  private y0 = 0;
  private z0 = 0;
  private x1 = 0;
  private y1 = 0;
  private z1 = 0;
  private k1 = 0;
  constructor(kind: Kind, geometry = model(kind), pencil = false, storm?: Node<'vec2'>, ore?: IslandOre) {
    this.footprintScale = footprintModelScale(kind, geometry);
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    this.halfX = Math.max(Math.abs(geometry.boundingBox!.min.x), Math.abs(geometry.boundingBox!.max.x));
    this.halfZ = Math.max(Math.abs(geometry.boundingBox!.min.z), Math.abs(geometry.boundingBox!.max.z));
    this.cap = kind === 'headframe' ? 64 : CAP[kind] ?? 600;
    this.data = new Float32Array(this.cap * STRIDE);
    this.buf = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    const rec = recordAttributes(this.buf);
    this.geo = instancedModel(geometry, rec);
    let margin = geometry === model(kind) ? 0.1 : 2.2;
    for (const part of STATE_VISUALS[kind]?.parts ?? []) {
      if (part.translate) margin = Math.max(margin, Math.hypot(...part.translate));
      if (part.stretch) margin = Math.max(margin, (Math.max(...part.stretch) - 1) * geometry.boundingSphere!.radius);
      if (part.hoist) margin = Math.max(margin, part.hoist.distance);
      if (part.drift) margin = Math.max(margin, part.drift.rise + part.drift.grow * geometry.boundingSphere!.radius);
      // a part turned about a pivot moves at most its chord: 2·sin(angle/2) × its distance from the pivot
      if (part.turn) margin = Math.max(margin, 2 * Math.abs(Math.sin(part.turn.angle / 2)) * (geometry.boundingSphere!.radius + Math.hypot(...part.turn.pivot)));
    }
    // An elevated barrel can stand up to its length above the model's resting bounds.
    if (RIG[kind].elevate) margin = Math.max(margin, 0.6);
    this.radius = geometry.boundingSphere!.radius * 1.2 + margin;
    const { position, normal, tint: t, look: lk, opacity, build } = unitRig(kind, pencil);
    const nw = normal.normalize() as V3;
    const paint = attribute<'vec3'>('paint', 'vec3');
    const accent = attribute<'float'>('accent', 'float');
    let glow = attribute<'float'>('glow', 'float') as F1;
    /** Share of the fragment drawn at full paint whichever way it faces the key light (lamps); undefined: all shaded. */
    let unshaded: F1 | undefined;
    const pulse = GLOW_PULSE[kind];
    if (pulse) {
      // idle life on a powered structure: its lamps and hot pipes breathe, out of step from one site to the next
      const seed = attribute<'vec4'>('unitDrive', 'vec4').z;
      glow = glow.mul(sin(time.mul(pulse.rate).add(seed)).mul(pulse.depth).add(1 - pulse.depth)) as F1;
    }
    if (kind === 'mooring_tower') {
      // a held tether (fill) makes the crown sensor crackle on two beating sines
      const drive = attribute<'vec4'>('unitDrive', 'vec4');
      const crackle = step(0, sin(time.mul(MOORING_CRACKLE.rate).add(drive.z)).add(sin(time.mul(MOORING_CRACKLE.rate * 0.44))));
      glow = glow.mul(mix(1, crackle.mul(MOORING_CRACKLE.flare).add(MOORING_CRACKLE.floor), drive.w)) as F1;
    }
    if (kind === 'lancer') {
      // the lance tip flares with each shot (the rig's fire envelope), dim between them
      const shot = float(1).sub(clock.sub(attribute<'vec4'>('unitState', 'vec4').y).div(LANCE_TIP.seconds)).clamp(0, 1);
      const barrel = float(1).sub(step(0.5, abs(attribute<'float'>('part', 'float').sub(PART.barrel))));
      glow = glow.mul(mix(1, shot.mul(shot).mul(LANCE_TIP.flare).add(LANCE_TIP.rest), barrel)) as F1;
    }
    if (kind === 'bastion') {
      const emitter = float(1).sub(step(0.5, abs(attribute<'float'>('part', 'float').sub(BASTION_PART.emitter))));
      const strength = attribute<'vec4'>('unitDrive', 'vec4').y;
      glow = glow.mul(mix(1, strength.mul(0.94).add(0.06), emitter)) as F1;
    }
    const team = t.xyz as unknown as V3;
    let base = mix(paint, team, accent) as V3;
    if (kind === 'asteroid') {
      const drive = attribute<'vec4'>('unitDrive', 'vec4');
      const resource = drive.w;
      const ore = step(0.25, resource).mul(float(1).sub(step(0.75, resource)));
      const ice = step(0.75, resource);
      const volatile = step(0.05, drive.y);
      // Metal seams, pale ice facets and dull slag; volatility is independent hot cracks.
      // Branching seams from the baked noise (not parallel sine stripes): its fine channel's mid crossing, offset per
      // rock so no two rocks share a pattern.
      const g = positionGeometry;
      const vein = abs(noise(g.xz.mul(ROCK_SEAM.scale).add(g.y.mul(ROCK_SEAM.lean)).add(drive.z)).y.sub(0.5));
      const seam = float(1).sub(smoothstep(ROCK_SEAM.seam[0], ROCK_SEAM.seam[1], vein));
      const fissure = float(1).sub(smoothstep(ROCK_SEAM.fissure[0], ROCK_SEAM.fissure[1], vein));
      const crackle = sin(time.mul(drive.y.mul(18).add(9)).add(positionGeometry.y.mul(17)).add(sin(positionGeometry.z.mul(23)))).mul(0.25).add(0.75);
      base = mix(base, color('#71d6bf'), seam.mul(ore).mul(0.9)) as V3;
      base = mix(base, mix(color('#70b9dc'), color('#ecfbff'), seam), ice) as V3;
      base = mix(base, color('#ffd59b').mul(float(1.3).add(drive.y.mul(crackle).mul(3))), fissure.mul(volatile)) as V3;
    }
    if (kind === 'solar') {
      // Photovoltaic glass, not a lamp: a cool reflective sheet with a shaded cell grid and a toon highlight band that
      // catches the key light. Output reads on the frame instead: once anchored its trim fills root → tip to the ramp
      // multiplier (rampStart → 1), brightening as it goes, gold by day and a dimmer cool blue at night, stuttering when
      // damaged; the collector light on the lid shows the same level. Folded, unfolding or packing, both stay iron.
      const drive = attribute<'vec4'>('unitDrive', 'vec4');
      const s = solarStatus(drive.w as F1);
      const part = attribute<'float'>('part', 'float');
      const isPart = (id: number): F1 => float(1).sub(step(0.5, abs(part.sub(id)))) as F1;
      const glass = isPart(PART.panel);
      const trim = isPart(SOLAR_PART.trim);
      const g = positionGeometry;
      // 0 at the wing root, 1 at its tip, in geometry space: the grid and the gauge fold with the wing
      const along = abs(g.z).sub(SOLAR.root).div(SOLAR.tip - SOLAR.root) as F1;
      const seams = lines(along.mul(3).add(0.5) as F1, 0.05);
      const bars = max(lines(along.mul(12).add(0.5) as F1, 0.04), lines(g.x.mul(8).add(0.5) as F1, 0.04));
      const world = varying(position, 'vSolarWorld') as V3;
      const glint = dot(reflect(cameraPosition.sub(world).normalize().negate(), nw), SUN);
      // at night (off the lit wedge) the sheen falls to a faint gleam: there is no sun to catch
      const sheen = smoothstep(0, 0.1, nw.dot(SUN)).mul(mix(0.3, 1, s.light));
      let pv = mix(base, color('#9cc3f0'), smoothstep(0.15, 0.9, glint).mul(sheen).mul(0.4)) as V3;
      pv = mix(pv, color('#121a33'), seams.mul(0.8)) as V3;
      pv = mix(pv, color('#c9d6ee'), bars.mul(0.2)) as V3;
      // two parallel glass streaks that slide along the wing as the panel rolls or the camera moves
      const sweep = glint.add(along.mul(0.3)).add(g.x.mul(0.5));
      const streak = smoothstep(0.86, 0.88, sweep).mul(float(1).sub(smoothstep(0.93, 0.95, sweep)))
        .add(smoothstep(0.985, 0.995, sweep).mul(float(1).sub(smoothstep(1.015, 1.025, sweep))));
      pv = mix(pv, color('#fbf6e8'), streak.mul(sheen).mul(0.75)) as V3;
      base = mix(base, pv, glass) as V3;
      const edge = mix(color('#7aa6f0').mul(0.8), color('#ffc443'), s.light);
      const level = s.charge.mul(s.charge).mul(mix(0.45, 1, s.light));
      const seed = drive.z;
      const stutter = mix(1, step(-0.3, sin(time.mul(23).add(seed)).add(sin(time.mul(7.1).add(seed.mul(3))))).mul(0.85).add(0.15), s.damaged);
      const filled = step(along.clamp(0, 1), s.charge).mul(trim);
      const on = filled.add(isPart(SOLAR_PART.node)).mul(s.anchored).mul(stutter);
      // the unlit rest of an anchored gauge keeps a faint tint, so its length reads
      base = mix(base, edge, max(on, trim.mul(s.anchored).mul(0.1))) as V3;
      glow = on.mul(level).mul(0.75) as F1;
      // a lit gauge is a lamp, not paint: the key light's shadow side (a panel rolled away from it) never greys it
      unshaded = on as F1;
    }
    if (kind === 'core') {
      // Heat (work) ramps the orb cool cyan → amber → red and quickens its pulse; with the core's cell unseen (fill 0)
      // the heat is unknown and the orb holds a dim, steady cyan instead of guessing.
      const drive = attribute<'vec4'>('unitDrive', 'vec4');
      const heat = drive.y;
      const hot = mix(mix(color('#9ff0ff'), color('#ffb347'), smoothstep(0, 0.55, heat)), color('#ff3b2a'), smoothstep(0.55, 1, heat));
      const pulse = sin(time.mul(heat.mul(9).add(1.6))).mul(0.5).add(0.5);
      base = mix(base, hot.mul(mix(0.8, 1, drive.w)), glow) as V3;
      glow = glow.mul(mix(0.5, pulse.mul(heat.mul(0.9).add(0.3)).add(0.7), drive.w)) as F1;
    }
    if (RIG[kind].gait?.kind === 'tracks') {
      // Tread cleats on the track pods, scrolled by the stride-locked gait odometer: where a track meets the ground its
      // cleats hold still in the world while the hull rolls over them (`treadPhase`).
      const part = attribute<'float'>('part', 'float');
      const tread = float(1).sub(step(0.5, abs(part.sub(PART.left)))).add(float(1).sub(step(0.5, abs(part.sub(PART.right)))));
      const odo = attribute<'vec4'>('unitState', 'vec4').w;
      const cleats = lines(positionGeometry.x.add(odo).mul(TREAD.cleats).add(0.5) as F1, TREAD.width);
      base = mix(base, base.mul(TREAD.shade), cleats.mul(tread)) as V3;
    }
    if (ore) base = ore.paint(base, storm);
    if (storm) base = islandStormPaint(base, storm, nw, varying(position) as V3, float(1).sub(accent) as F1);
    const ndl = nw.dot(SUN);
    let shaded = mix(base.mul(planeShadow(lk.y)), base, smoothstep(0, 0.08, ndl)).add(smoothstep(0.7, 0.76, ndl).mul(0.1)) as V3;
    // contact shading: grounded models darken where they meet the ground, so hulls and walls sit rather than float
    if (STRUCT.has(kind) || RIG[kind].gait) shaded = shaded.mul(mix(CONTACT.floor, 1, smoothstep(0, CONTACT.height, positionGeometry.y))) as V3;
    const lit = unshaded ? mix(shaded, base, unshaded) as V3 : shaded;
    const flicker = kind === 'sapper' ? sin(time.mul(9).add(attribute<'vec4'>('unitDrive', 'vec4').z)).mul(0.5).add(0.5) : float(1);
    const band = smoothstep(0.3, 0.5, lum(lit).div(0.75).clamp(0, 1));
    const ghost = mix(VIEW.paper, VIEW.ghostPencil, float(1).sub(band).mul(0.25).add(0.1));
    // Construction (Field Journal "sketch → paint"): a site stands full height; below a cut line rising with its
    // progress it is painted, above it the unbuilt rest is construction pencil and hatching, inked at the cut.
    const cut = build.y.mul(geometry.boundingBox!.max.y);
    const sketched = step(cut, positionGeometry.y).mul(build.x);
    const cutLine = float(1).sub(smoothstep(CONSTRUCTION.line * 0.5, CONSTRUCTION.line, abs(positionGeometry.y.sub(cut)))).mul(build.x);
    const sketch = mix(VIEW.paper, VIEW.ghostPencil, hatch(ndl, CONSTRUCTION.hatchFreq).mul(CONSTRUCTION.hatch).add(CONSTRUCTION.wash));
    let painted = mix(lit.add(base.mul(glow.mul(flicker).mul(1.6))), sketch, sketched) as V3;
    painted = mix(painted, painted.mul(CONSTRUCTION.cutShade), cutLine) as V3;
    const m = new MeshBasicNodeMaterial();
    m.positionNode = position;
    m.colorNode = pencil ? mix(t.xyz.mul(0.75), color('#5a2028'), hatch(ndl, 10).mul(0.6)) : mix(ghost, painted, lk.x);
    m.opacityNode = pencil ? t.w.mul(float(0.35).add(hatch(ndl, 10).mul(0.45))).mul(opacity) : t.w.mul(opacity).mul(mix(1, CONSTRUCTION.sketchAlpha, sketched));
    if (pencil) { overlay(m); m.alphaTest = 0.01; }
    else {
      // Keep the alpha-hashed, depth-writing hull draw after blended plane veils and the holo (group 35).
      // Queueing it with transparency changes ordering only: no alpha blend and no second entity draw.
      m.alphaHash = true;
      m.transparent = true;
      m.blending = NoBlending;
    }
    // the ink pass reads the animated normal, so creases follow the moving parts
    const view = cameraViewMatrix.mul(vec4(nw, 0)).xyz.normalize();
    m.mrtNode = mrt({ normal: vec4(packNormalToRGB(view), lk.x.mul(0.5).add(0.5)) });
    this.mesh = new Mesh(this.geo, m);
    this.mesh.renderOrder = 40;
  }

  /** Store `v` in field `o` of instance `i`'s record, noting whether the stored float changed. */
  set(i: number, o: number, v: number): void {
    const k = i * STRIDE + o;
    const f = Math.fround(v);
    if (this.data[k] !== f) {
      this.data[k] = f;
      this.changed = true;
    }
  }

  /** Close instance `i` (placed at x, y, z with scale k): a changed record joins the current upload run. */
  commit(i: number, x: number, y: number, z: number, k: number): void {
    if (i === 0) {
      this.x0 = this.x1 = x;
      this.y0 = this.y1 = y;
      this.z0 = this.z1 = z;
      this.k1 = k;
    } else {
      this.x0 = Math.min(this.x0, x);
      this.x1 = Math.max(this.x1, x);
      this.y0 = Math.min(this.y0, y);
      this.y1 = Math.max(this.y1, y);
      this.z0 = Math.min(this.z0, z);
      this.z1 = Math.max(this.z1, z);
      this.k1 = Math.max(this.k1, k);
    }
    if (!this.changed) return;
    this.changed = false;
    this.dirty = true;
    if (this.runStart >= 0 && this.runEnd === i - 1) this.runEnd = i;
    else {
      this.flushRun();
      this.runStart = this.runEnd = i;
    }
  }

  private flushRun(): void {
    if (this.runStart < 0) return;
    const r = this.buf.updateRanges;
    // a pending whole-buffer upload (not drawn since it was queued) already covers this run
    if (!(r.length === 1 && r[0]!.count === this.data.length)) this.buf.addUpdateRange(this.runStart * STRIDE, (this.runEnd - this.runStart + 1) * STRIDE);
    this.runStart = -1;
  }

  /** Publish this frame: instance count, bounding sphere and the changed records. */
  publish(count: number): void {
    this.flushRun();
    if (this.dirty) {
      if (this.buf.updateRanges.length > MAX_RUNS) {
        this.buf.clearUpdateRanges();
        this.buf.addUpdateRange(0, this.data.length);
      }
      this.buf.needsUpdate = true;
      this.dirty = false;
    }
    const g = this.geo;
    g.instanceCount = count;
    this.mesh.visible = count > 0;
    if (count > 0) {
      const s = g.boundingSphere!;
      s.center.set((this.x0 + this.x1) / 2, (this.y0 + this.y1) / 2, (this.z0 + this.z1) / 2);
      s.radius = Math.hypot(this.x1 - this.x0, this.y1 - this.y0, this.z1 - this.z0) / 2 + this.radius * this.k1;
    }
  }
}
/** Prepared draw objects are adopted, never cloned: rig records and cached vertex attributes retain their identity. */
interface EntityMeshes {
  kinds: Map<Kind, KindMesh>;
  dropoffs: Map<DropoffKind, KindMesh>;
  dropoffGhosts: Map<DropoffKind, KindMesh>;
  ghosts: Map<Kind, KindMesh>;
  draws: Mesh[];
}

function* entityMeshes(): Generator<void, EntityMeshes> {
  const prepared: EntityMeshes = {
    kinds: new Map(), dropoffs: new Map(), dropoffGhosts: new Map(), ghosts: new Map(), draws: [],
  };
  for (const kind of KINDS) {
    if (kind === 'spire' || kind === 'island') continue;
    const geometry = model(kind);
    yield;
    const mesh = new KindMesh(kind, geometry);
    prepared.kinds.set(kind, mesh);
    prepared.draws.push(mesh.mesh);
    yield;
  }
  for (const kind of ['headframe', 'shaft', 'spire'] as const) {
    // KindMesh also compares against the canonical model to determine its animation margin.
    model(kind);
    yield;
    const geometry = depthsDropoffModel(kind);
    yield;
    const live = new KindMesh(kind, geometry);
    live.mesh.name = `depths-dropoff-${kind}`;
    prepared.dropoffs.set(kind, live);
    prepared.draws.push(live.mesh);
    yield;
    const remembered = new KindMesh(kind, geometry, true);
    remembered.mesh.name = `depths-dropoff-memory-${kind}`;
    prepared.dropoffGhosts.set(kind, remembered);
    prepared.draws.push(remembered.mesh);
    yield;
  }
  for (const kind of ['shaft', 'turret', 'mooring_tower', 'relay', 'aerie', 'storm_seeder', 'stormcatcher', 'headframe', 'bulkhead', 'lava_bridge', 'geothermal', 'gun_platform', 'island_mortar', 'ore_extractor'] as const) {
    const mesh = new KindMesh(kind, model(kind), true);
    mesh.mesh.name = `remembered-${kind}`;
    prepared.ghosts.set(kind, mesh);
    prepared.draws.push(mesh.mesh);
    yield;
  }
  return prepared;
}


/** Visual altitude above the plane reference for a kind on a plane (idle bob is in the vertex rig). */
function hover(kind: Kind, plane: Plane): number {
  switch (plane) {
    case 'depths':
      return kind === 'geothermal' ? DEPTHS_ROCK_HEIGHT : 0;
    case 'sky':
      if (kind === 'island') return 0;
      if (STRUCT.has(kind)) return 0.05;
      return 1.6;
    case 'orbit':
      return 0.2;
    default:
      // A forward post stands on the ground itself: its mound sinks into its ground bed (post-beds.ts).
      return kind === 'post' ? -GROUND.surface : 0;
  }
}

export class Entities {
  readonly root = new Group();
  /** Drawn by the ink pipeline's overlay pass, after the Sky's storms, against the scene's depth: the viewer's command
   * overlays (selection rings and contours, order lines: `commandOverlay`) and the public effects that rise above or
   * through a storm (ascent columns and rings, return arcs, relay cones, Spire connectors: `aboveStorm`). They show
   * only what this view already draws; no storm or fog hides anything else for them. */
  readonly overlays = new Group();
  /** Whether any overlay draws this frame (the overlay pass is skipped otherwise). */
  get overlaysShown(): boolean {
    return this.sel.count > 0 || this.lines.visible || this.selectionContours.mesh.visible || this.contrails.count > 0
      || this.returnArcs.count > 0 || (this.cones.count > 0 && this.coneAlpha.value > 0) || this.spires.connectorsShown;
  }
  /** Canonical draws only, never fog-derived islands or scope instances; startup compiles detached copies. */
  readonly shaderTemplates: readonly Object3D[];
  readonly tracks = new Map<string, Track>();
  /**
   * The death player (`Combat.deaths`, wired by World): a track leaving the view with its death record stays drawn,
   * posed by its death stage, until that stage is over. Without one, a dead unit leaves with its track.
   */
  deaths: DeathPlayer | undefined;
  private snapshot: MatchView | undefined;
  private readonly fogField: FogField | undefined;
  private carryMax = 0;
  /** This match's solar ramp floor (`rules.orbit.solarRampStart`) and sun wedges, for the arrays' packed fill. */
  private rampStart = 0;
  private sunHalf = 0;
  private sunWedges = 1;
  private depthKnowledge: View['depths'] = [];
  private viewArmy: ArmyId = 'nw';
  private readonly kinds: Map<Kind, KindMesh>;
  /** Prepared island draws, and each island's hardpoint pad centre as a tile offset from the island centre. */
  private readonly islands = new Map<string, { terrain: KindMesh; grove: IslandGrove; ore: IslandOre | undefined; padX: number; padY: number }>();
  /** Islands whose hardpoint attachment entity was drawn this frame (the rest show the public occupant from memory). */
  private readonly mounted = new Set<string>();
  /** Scratch occupant of a public hardpoint with no visible entity (`islands[].hardpoint`). */
  private readonly mountSpot: Pick<Entity, 'kind' | 'side' | 'x' | 'y'> = { kind: 'gun_platform', side: 'neutral', x: 0, y: 0 };
  private readonly dropoffs: Map<DropoffKind, KindMesh>;
  private readonly dropoffGhosts: Map<DropoffKind, KindMesh>;
  private readonly presentations = new Presentations();
  private readonly motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  private deliveryTick = -1;
  /** render clock in server ticks (−1 = unset) */
  private clock = -1;
  private lastTick = -1;
  private lastArrival = 0;
  private msPerTick = 1000 / TICK_RATE;
  /** Last rendered batch's newest arrival: adjacent deltas in a catch-up batch are not clock samples. */
  private rateTick = -1;
  private rateArrival = 0;
  /** ticks between consecutive views (views may be sent less often than every tick) */
  private gap = 1;
  private lastFrame = 0;
  private lastDt = 0;
  private readonly seen = new Set<string>();
  /** scratch from sample(): estimated travel velocity (tiles/tick), independent of position interpolation */
  private vel = 0;
  private vx = 0;
  private vy = 0;
  private readonly sel: InstancedMesh;
  private readonly selTint: InstancedBufferAttribute;
  private readonly dabs: InstancedMesh;
  /** rgb = team, w = seed (integer part) + opacity (fraction) */
  private readonly dabTint: InstancedBufferAttribute;
  readonly selectionContours: SelectionContours;
  /** Trench lines joining neighbouring dug-in troopers' foxholes (`trenches.ts`). */
  readonly trenches: Trenches;
  private readonly stalks: InstancedMesh;
  private readonly stalkTint: InstancedBufferAttribute;
  private readonly washColumns: InstancedMesh;
  private readonly washRipples: InstancedMesh;
  /** rgb = team, w = seed (integer part) + opacity (fraction), per fan */
  private readonly washTint: InstancedBufferAttribute;
  private readonly shields: InstancedMesh;
  private readonly shieldTint: InstancedBufferAttribute;
  private readonly lines: LineSegments;
  private readonly contrails: InstancedMesh;
  private readonly ascentMarks: InstancedMesh;
  private readonly ascentTint: InstancedBufferAttribute;
  private ascentClimb = 0;
  private readonly returnArcs: InstancedMesh;
  /** rgb = team, w = warning progress in 1/64ths (integer part) + opacity (fraction) */
  private readonly returnTint: InstancedBufferAttribute;
  /** Return hops in flight (kept past their entity, which may have fallen into fog): tick, tile spot, planes, side. */
  private hopN = 0;
  private readonly hopTick = new Float64Array(HOP_CAP);
  private readonly hopX = new Float32Array(HOP_CAP);
  private readonly hopY = new Float32Array(HOP_CAP);
  private readonly hopFrom = new Uint8Array(HOP_CAP);
  private readonly hopTo = new Uint8Array(HOP_CAP);
  private readonly hopLiftFrom = new Float32Array(HOP_CAP);
  private readonly hopLiftTo = new Float32Array(HOP_CAP);
  /** Owner of each hop, as an index into ARMIES. */
  private readonly hopSide = new Uint8Array(HOP_CAP);
  private readonly hopSeen = new Uint8Array(HOP_CAP);
  private readonly linePos: Float32Array;
  private readonly lineCol: Float32Array;
  private readonly mooringFields: InstancedMesh;
  private readonly mooringTethers: InstancedMesh;
  private readonly mooringTint: InstancedBufferAttribute;
  private readonly mooringDirection = new Vector3();
  private readonly mooringUp = new Vector3(0, 1, 0);
  private readonly cones: InstancedMesh;
  private readonly coneTint: InstancedBufferAttribute;
  readonly spires: Spires;
  readonly coneAlpha = uniform(0);
  private readonly counts = new Map<Kind, number>();
  private readonly ghosts: Map<Kind, KindMesh>;
  /** Enemy structures last seen (fog memory). */
  memory: View['memory'] = [];
  private seg = 0;
  private readonly listedOnly: boolean;

  /** Construct every model and rig in bounded startup tasks before publishing a complete instance. */
  static async create(listedOnly: boolean, size: number, terrain?: TerrainField, fogField?: FogField): Promise<Entities> {
    return new Entities(listedOnly, await prepareStartup(entityMeshes()), size, terrain, fogField);
  }

  /** Synchronous construction remains useful for offline rendering and tests. */
  readonly size: number;
  private readonly terrain: TerrainField;

  constructor(listedOnly: boolean, prepared: EntityMeshes | undefined, size: number, terrain = new TerrainField(size), fogField?: FogField) {
    this.size = size;
    this.terrain = terrain;
    this.fogField = fogField;
    this.listedOnly = listedOnly;
    if (!prepared) {
      const tasks = entityMeshes();
      let next = tasks.next();
      while (!next.done) next = tasks.next();
      prepared = next.value;
    }
    this.kinds = prepared.kinds;
    this.dropoffs = prepared.dropoffs;
    this.dropoffGhosts = prepared.dropoffGhosts;
    this.ghosts = prepared.ghosts;
    // A Group's renderOrder is the groupOrder of everything below it (compared before per-object renderOrder):
    // entities draw after every plane layer.
    this.root.renderOrder = 40;
    this.root.add(...prepared.draws);

    // selection rings: a brushed loop of the selection colour between two ink rims
    this.selTint = new InstancedBufferAttribute(new Float32Array(256 * 4), 4);
    this.selTint.setUsage(DynamicDrawUsage);
    const st = instancedDynamicBufferAttribute<'vec4'>(this.selTint, 'vec4');
    const sq = uv().sub(0.5).mul(2);
    const sl = sq.length();
    // RingGeometry uv spans the outer radius: 0.62 inner … 1 outer, + a hand-drawn wobble along the loop
    const across = sl.sub(0.62).div(0.38).add(mx_noise_float(vec3(sq.div(sl.max(1e-3)).mul(1.6), 3)).mul(0.12));
    const fillS = smoothstep(0.18, 0.3, across).mul(float(1).sub(smoothstep(0.7, 0.82, across)));
    const rimS = max(float(1).sub(smoothstep(0.03, 0.08, abs(across.sub(0.22)))), float(1).sub(smoothstep(0.03, 0.08, abs(across.sub(0.78)))));
    const selMat = commandOverlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    selMat.colorNode = mix(st.xyz, color(INK.surface), rimS.mul(0.85));
    selMat.opacityNode = max(fillS.mul(0.85), rimS.mul(0.9)).mul(st.w).mul(sin(time.mul(5)).mul(0.1).add(0.9));
    this.sel = new InstancedMesh(new RingGeometry(0.36, 0.58, 48).rotateX(-Math.PI / 2), selMat, 256);
    this.sel.count = 0;
    this.sel.frustumCulled = false;
    this.sel.renderOrder = 60;
    this.overlays.add(this.sel);

    // team dabs: a watercolour wash with a noisy edge, pigment pooling darker at the rim, a thin ink line around it
    this.dabTint = new InstancedBufferAttribute(new Float32Array(DAB_CAP * 4), 4);
    this.dabTint.setUsage(DynamicDrawUsage);
    const dt = instancedDynamicBufferAttribute<'vec4'>(this.dabTint, 'vec4');
    const dq = uv().sub(0.5).mul(2);
    const dr = dq.length().add(mx_noise_float(vec3(dq.mul(2.5), dt.w.floor().mul(0.37))).mul(0.22));
    const body = float(1).sub(smoothstep(0.62, 0.9, dr));
    const pool = smoothstep(0.45, 0.82, dr).mul(body);
    const inkRim = float(1).sub(smoothstep(0.015, 0.05, abs(dr.sub(0.86))));
    const dabMat = overlay(new MeshBasicNodeMaterial());
    dabMat.colorNode = mix(dt.xyz.mul(float(1).sub(pool.mul(0.3))), color(INK.surface), inkRim.mul(0.6));
    dabMat.opacityNode = max(body.mul(0.42).add(pool.mul(0.3)), inkRim.mul(0.45)).mul(fract(dt.w));
    dabMat.polygonOffset = true;
    dabMat.polygonOffsetFactor = -2;
    dabMat.polygonOffsetUnits = -2;
    this.dabs = new InstancedMesh(new PlaneGeometry(2, 2).rotateX(-Math.PI / 2), dabMat, DAB_CAP);
    this.dabs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dabs.count = 0;
    this.dabs.frustumCulled = false;
    this.dabs.renderOrder = 39;
    this.root.add(this.dabs);
    this.selectionContours = new SelectionContours(terrain, fogField);
    this.overlays.add(this.selectionContours.mesh);
    this.trenches = new Trenches(fogField);
    this.root.add(this.trenches.mesh);

    // Star-atlas shield hits: hollow, shimmering ellipses, never a permanent opaque bubble.
    this.shieldTint = new InstancedBufferAttribute(new Float32Array(SHIELD_CAP * 4), 4);
    this.shieldTint.setUsage(DynamicDrawUsage);
    const sh = instancedDynamicBufferAttribute<'vec4'>(this.shieldTint, 'vec4');
    const shieldMat = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    shieldMat.colorNode = mix(sh.xyz, color('#a4ddff'), 0.75);
    const shimmer = sin(time.mul(19).add(uv().x.mul(24))).mul(0.16).add(0.84);
    shieldMat.opacityNode = sh.w.mul(shimmer).mul(0.48);
    this.shields = new InstancedMesh(new RingGeometry(0.95, 1, 48).rotateX(-Math.PI / 2), shieldMat, SHIELD_CAP);
    this.shields.name = 'shield-hit-ellipses';
    this.shields.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shields.count = 0;
    this.shields.frustumCulled = false;
    this.shields.renderOrder = 54;
    this.root.add(this.shields);

    // flyer altitude stalks: a thin ink line from the flyer down to its dab
    this.stalkTint = new InstancedBufferAttribute(new Float32Array(STALK_CAP * 4), 4);
    this.stalkTint.setUsage(DynamicDrawUsage);
    const kt = instancedDynamicBufferAttribute<'vec4'>(this.stalkTint, 'vec4');
    const stalkMat = overlay(new MeshBasicNodeMaterial());
    stalkMat.colorNode = mix(color(INK.sky), kt.xyz, 0.3);
    stalkMat.opacityNode = kt.w.mul(float(0.55).add(positionGeometry.y.mul(0.35)));
    this.stalks = new InstancedMesh(new CylinderGeometry(1, 1, 1, 5, 1, true).translate(0, 0.5, 0), stalkMat, STALK_CAP);
    this.stalks.instanceMatrix.setUsage(DynamicDrawUsage);
    this.stalks.count = 0;
    this.stalks.frustumCulled = false;
    this.stalks.renderOrder = 39;
    this.root.add(this.stalks);

    // Gunship rotor wash: a pale downdraft column under each fan whose streaks pour downward, and rings rippling out
    // where it meets the deck below. One tint record per fan (rgb team, w = seed + opacity) feeds both draws.
    this.washTint = new InstancedBufferAttribute(new Float32Array(WASH_CAP * 4), 4);
    this.washTint.setUsage(DynamicDrawUsage);
    const wt = instancedDynamicBufferAttribute<'vec4'>(this.washTint, 'vec4');
    const washMat = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    washMat.colorNode = mix(wt.xyz, color('#f4f8ff'), 0.75);
    // positionGeometry.y: 0 at the deck … 1 at the fan; a constant phase moves down as time grows
    const fall = positionGeometry.y;
    const streak = sin(atan(positionGeometry.x, positionGeometry.z).mul(7).add(fall.mul(16)).add(time.mul(14)).add(wt.w.floor())).mul(0.5).add(0.5);
    washMat.opacityNode = fract(wt.w).mul(smoothstep(0.35, 1, streak).mul(0.5).add(0.08)).mul(fall.mul(0.75).add(0.1)).mul(0.55);
    this.washColumns = new InstancedMesh(new CylinderGeometry(1, 1.9, 1, 14, 1, true).translate(0, 0.5, 0), washMat, WASH_CAP);
    this.washColumns.name = 'gunship-rotor-wash';
    this.washColumns.instanceMatrix.setUsage(DynamicDrawUsage);
    this.washColumns.count = 0;
    this.washColumns.frustumCulled = false;
    this.washColumns.renderOrder = 39;
    const ripple = uv().sub(0.5).mul(2).length();
    const rings = fract(ripple.mul(3).sub(time.mul(1.6)).add(wt.w.floor().mul(0.13)));
    const rippleMat = overlay(new MeshBasicNodeMaterial());
    rippleMat.colorNode = mix(wt.xyz, color('#f4f8ff'), 0.6);
    rippleMat.opacityNode = fract(wt.w).mul(smoothstep(0.55, 0.85, rings).mul(float(1).sub(smoothstep(0.85, 1, rings)))).mul(float(1).sub(smoothstep(0.55, 1, ripple))).mul(0.7);
    this.washRipples = new InstancedMesh(new PlaneGeometry(2, 2).rotateX(-Math.PI / 2), rippleMat, WASH_CAP);
    this.washRipples.name = 'gunship-rotor-ripples';
    this.washRipples.instanceMatrix.setUsage(DynamicDrawUsage);
    this.washRipples.count = 0;
    this.washRipples.frustumCulled = false;
    this.washRipples.renderOrder = 39;
    this.root.add(this.washColumns, this.washRipples);

    // Ascent is a public, two-plane telegraph: a tapered exhaust column and its Orbit arrival ring.
    this.ascentTint = new InstancedBufferAttribute(new Float32Array(TRAIL_CAP * 4), 4);
    this.ascentTint.setUsage(DynamicDrawUsage);
    const at = instancedDynamicBufferAttribute<'vec4'>(this.ascentTint, 'vec4');
    const trailMat = aboveStorm(new MeshBasicNodeMaterial({ side: DoubleSide }));
    trailMat.colorNode = mix(at.xyz, color('#e8f4ff'), 0.65);
    // positionLocal includes the instance's altitude/height; the exhaust gradient needs the cylinder's original 0–1 y.
    trailMat.opacityNode = at.w.mul(positionGeometry.y.mul(0.6).add(0.25)).mul(sin(time.mul(12).sub(positionGeometry.y.mul(20))).mul(0.15).add(0.85));
    this.contrails = new InstancedMesh(new CylinderGeometry(0.06, 0.22, 1, 8, 1, true).translate(0, 0.5, 0), trailMat, TRAIL_CAP);
    this.contrails.instanceMatrix.setUsage(DynamicDrawUsage);
    this.contrails.count = 0;
    this.contrails.frustumCulled = false;
    this.contrails.renderOrder = 55;
    const markMat = aboveStorm(new MeshBasicNodeMaterial({ side: DoubleSide }));
    markMat.colorNode = mix(at.xyz, color('#e8f4ff'), 0.4);
    markMat.opacityNode = at.w.mul(sin(time.mul(6)).mul(0.15).add(0.7));
    this.ascentMarks = new InstancedMesh(new RingGeometry(0.7, 0.82, 24).rotateX(-Math.PI / 2), markMat, TRAIL_CAP);
    this.ascentMarks.instanceMatrix.setUsage(DynamicDrawUsage);
    this.ascentMarks.count = 0;
    this.ascentMarks.frustumCulled = false;
    this.ascentMarks.renderOrder = 55;
    this.overlays.add(this.contrails, this.ascentMarks);

    // A timed visit running out: a team-tinted countdown arc around the unit, emptying toward the return, pulsing.
    this.returnTint = new InstancedBufferAttribute(new Float32Array(RETURN_CAP * 4), 4);
    this.returnTint.setUsage(DynamicDrawUsage);
    const rw = instancedDynamicBufferAttribute<'vec4'>(this.returnTint, 'vec4');
    const left = float(1).sub(rw.w.sub(fract(rw.w)).div(64));
    // 0 … 1 around the ring from the page's top (−z)
    const around = fract(atan(positionGeometry.x, positionGeometry.z.negate()).div(Math.PI * 2).add(1));
    const lit = step(around, left);
    const arcMat = aboveStorm(new MeshBasicNodeMaterial({ side: DoubleSide }));
    arcMat.colorNode = mix(color(INK.sky), mix(rw.xyz, color('#fff8e8'), 0.25), lit);
    arcMat.opacityNode = fract(rw.w).mul(lit.mul(0.75).add(0.2)).mul(sin(time.mul(10)).mul(0.2).add(0.8));
    this.returnArcs = new InstancedMesh(new RingGeometry(0.88, 1.04, 48).rotateX(-Math.PI / 2), arcMat, RETURN_CAP);
    this.returnArcs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.returnArcs.count = 0;
    this.returnArcs.frustumCulled = false;
    this.returnArcs.renderOrder = 56;
    this.overlays.add(this.returnArcs);

    // order lines
    const maxSeg = 512;
    this.linePos = new Float32Array(maxSeg * 6);
    this.lineCol = new Float32Array(maxSeg * 6);
    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(this.linePos, 3).setUsage(DynamicDrawUsage));
    lg.setAttribute('color', new BufferAttribute(this.lineCol, 3).setUsage(DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    const lm = commandOverlay(new LineBasicNodeMaterial({ vertexColors: true }));
    this.lines = new LineSegments(lg, lm);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 60;
    this.overlays.add(this.lines);

    // relay vision cones (sky → surface)
    this.coneTint = new InstancedBufferAttribute(new Float32Array(32 * 4), 4);
    this.coneTint.setUsage(DynamicDrawUsage);
    const ct = instancedDynamicBufferAttribute<'vec4'>(this.coneTint, 'vec4');
    const coneMat = aboveStorm(new MeshBasicNodeMaterial({ side: DoubleSide }));
    const h = positionLocal.y.add(0.5); // 0 bottom … 1 top
    coneMat.colorNode = ct.xyz;
    coneMat.opacityNode = ct.w.mul(this.coneAlpha).mul(float(1).sub(h).mul(0.7).add(0.05));
    this.cones = new InstancedMesh(new CylinderGeometry(0.08, 1, 1, 24, 1, true), coneMat, 32);
    this.cones.count = 0;
    this.cones.frustumCulled = false;
    this.cones.renderOrder = 55;
    this.overlays.add(this.cones);

    // Tesla windings and the live island tether share one retained GPU-animated discharge material.
    this.mooringTint = new InstancedBufferAttribute(new Float32Array(256 * 4), 4).setUsage(DynamicDrawUsage);
    const mt = instancedDynamicBufferAttribute<'vec4'>(this.mooringTint, 'vec4');
    const fieldMat = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    const bend = sin(uv().y.mul(37).add(time.mul(7))).mul(0.035).add(sin(uv().y.mul(83).sub(time.mul(11))).mul(0.018));
    const discharge = abs(sin(uv().x.add(bend).mul(Math.PI * 12)));
    const sparks = float(1).sub(smoothstep(0.04, 0.18, discharge));
    fieldMat.colorNode = mix(mt.xyz, color('#e5faff'), sparks.mul(0.7));
    fieldMat.opacityNode = mt.w.mul(sparks.mul(0.75).add(0.025)).mul(seen('surface', fogField));
    const fieldGeo = new CylinderGeometry(1, 1, 1, 24, 1, true);
    this.mooringFields = new InstancedMesh(fieldGeo, fieldMat, 256);
    this.mooringTethers = new InstancedMesh(fieldGeo, fieldMat, 256);
    this.mooringFields.name = 'mooring-tesla-fields';
    this.mooringTethers.name = 'mooring-island-tethers';
    for (const mesh of [this.mooringFields, this.mooringTethers]) {
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 56;
      this.root.add(mesh);
    }

    this.spires = new Spires(this.size, listedOnly, fogField, terrain);
    this.root.add(this.spires.root);
    this.overlays.add(this.spires.aboveStorm);
    this.shaderTemplates = [...prepared.draws, this.lines, this.mooringFields, this.mooringTethers, this.selectionContours.mesh, islandOreTemplate(), ...this.spires.shaderTemplates];
  }

  /** Forget the current match before a lobby reset, team switch, or rewound stream. */
  reset(): void {
    this.snapshot = undefined;
    this.tracks.clear();
    this.selectionContours.reset();
    for (const { terrain, grove, ore } of this.islands.values()) {
      terrain.mesh.removeFromParent();
      terrain.mesh.geometry.dispose();
      (terrain.mesh.material as MeshBasicNodeMaterial).dispose();
      grove.dispose();
      ore?.dispose();
    }
    this.islands.clear();
    this.memory = [];
    this.depthKnowledge = [];
    this.carryMax = this.ascentClimb = this.rampStart = this.sunHalf = 0;
    this.sunWedges = 1;
    this.clock = this.lastTick = this.rateTick = this.deliveryTick = -1;
    this.lastArrival = this.rateArrival = this.lastFrame = 0;
    this.msPerTick = 1000 / TICK_RATE;
    this.gap = 1;
    this.hopN = 0;
    this.mooringFields.count = this.mooringTethers.count = 0;
    this.spires.reset();
  }
  /** Resolve/reset once before preparation so the subsequent ingest retains its prepared island draws. */
  private resolveView(incoming: View): MatchView | undefined {
    const view = matchView(incoming, this.snapshot);
    if (view && this.snapshot && (view.army !== this.snapshot.army || view.rulesHash !== this.snapshot.rulesHash || view.tick < this.snapshot.tick))
      this.reset();
    return view;
  }

  /** Prepare match-specific recipes without advancing snapshots, interpolation or presentation clocks. */
  async prepareView(incoming: View): Promise<void> {
    const view = this.resolveView(incoming);
    if (!view || !view.entities.some(e => e.kind === 'island' && !this.islands.has(e.id))) return;
    await prepareIslandGroves();
    await prepareStartup(this.viewIslands(view));
  }

  private *viewIslands(view: MatchView): Generator<void> {
    // KindMesh compares against the canonical model; don't fold that first recipe into the first island task.
    model('island');
    yield;
    for (const e of view.entities) {
      if (e.kind !== 'island' || this.islands.has(e.id)) continue;
      this.addIsland(e, view.match.symmetry === 'C4' ? 4 : 2, view.match.rules.sky.islandHardpoints > 0);
      yield;
    }
  }

  /**
   * Shared by async first-view preparation and the synchronous ingest path for newly encountered islands; `sides` is
   * the map's slot count (islands come in rotated sets of one per slot), `hardpoint` whether islands carry the rim pad.
   */
  private addIsland(e: Entity, sides: number, hardpoint: boolean): void {
    const id = e.id;
    if (this.islands.has(id)) return;
    const { seed, turns } = islandIdentity(id, sides);
    // Ore crags are a distinct public phenotype (initial capacity only, never depletion): stone cap, sparse scrub.
    const mineral = (e.oreCapacity ?? 0) > 0;
    const grove = new IslandGrove(seed, turns, mineral);
    grove.group.name = `island-grove-${id}`;
    const geometry = islandModel(seed, turns, hardpoint, mineral);
    const ore = mineral ? new IslandOre(id, geometry, seed, turns) : undefined;
    const terrain = new KindMesh('island', geometry, false, grove.storm, ore);
    terrain.mesh.name = `island-terrain-${id}`;
    // Prepared scenery must not leak through fog or appear at the origin before its first entity frame.
    terrain.mesh.visible = false;
    grove.group.visible = false;
    const pad = hardpointOffset(turns, { x: 0, y: 0 });
    this.islands.set(id, { terrain, grove, ore, padX: pad.x, padY: pad.y });
    this.root.add(terrain.mesh, grove.group);
    if (ore) this.root.add(ore.mesh);
  }


  /**
   * A Gunship and the Gun Platform it emplaces into (or packs back out of) are two sim entities: a new one of the pair
   * standing where a same-side track of the other kind is drawn plays the swap instead of popping in.
   */
  private swapPartner(e: Entity): boolean {
    const other = e.kind === 'gunship' ? 'gun_platform' : 'gunship';
    for (const tr of this.tracks.values())
      if (tr.e.kind === other && tr.e.side === e.side && Math.abs(tr.x - e.x) + Math.abs(tr.y - e.y) <= EMPLACE_SWAP.reach) return true;
    return false;
  }

  /** New authoritative view arrived: append a snapshot per entity, keyed by server tick. */
  ingest(incoming: View, now: number): void {
    const view = this.resolveView(incoming);
    if (!view) return;
    this.selectionContours.reserve(view.entities.length);
    if (view.match !== this.snapshot?.match) {
      this.spires.place(view.match.armies);
      this.carryMax = diggerCarryMax(view.match.rules);
      this.ascentClimb = view.match.rules.ascent.climb * TICK_RATE;
      this.rampStart = view.match.rules.orbit.solarRampStart;
      this.sunHalf = view.match.sun.half;
      this.sunWedges = view.match.sun.wedges;
    }
    this.snapshot = view;
    this.depthKnowledge = view.depths;
    this.viewArmy = view.army;
    const T = view.tick;
    if (this.lastTick >= 0 && T > this.lastTick)
      this.gap = this.gap * 0.9 + Math.min(10, T - this.lastTick) * 0.1;
    this.lastTick = T;
    this.lastArrival = now;
    const seen = this.seen;
    seen.clear();
    const opening = this.tracks.size === 0;
    for (const e of view.entities) {
      seen.add(e.id);
      let tr = this.tracks.get(e.id);
      if (!tr) {
        const phase = idPhase(e.id);
        if (e.kind === 'island') this.addIsland(e, view.match.symmetry === 'C4' ? 4 : 2, view.match.rules.sky.islandHardpoints > 0);
        tr = {
          e, x: e.x, y: e.y, st: new Float64Array(HIST), sx: new Float32Array(HIST), sy: new Float32Array(HIST), sh: new Float32Array(HIST), elevation: e.elevation ?? 0, n: 0, heading: e.heading ?? phase, goal: e.heading ?? phase, towHeading: e.heading ?? phase, phase, rx: e.x, ry: e.y,
          // standing height before the first frame places it: a shot can target a track the frame has not seen yet
          wy: unitY(e.plane) + hover(e.kind, e.plane) + (e.elevation ?? 0) + (e.plane === 'surface' ? this.standAt(e.kind, e.x, e.y) : 0), visible: true,
          fireAt: -1e9, hitAt: -1e9, shieldAt: -1e9, aim: e.aim ?? e.heading ?? phase, mountPitch: 0, aimUntil: -Infinity, aimX: 0, aimY: 0, aimZ: 0,
          bank: 0, pitch: 0, speed: 0, accel: 0, turn: 0, odo: phase, roll: 0, dive: 0, diveFrom: e.plane,
          scale: 1, motionEpoch: 0, wakeSlot: -1,
          // a unit appearing mid-match grows in (`arrivalScale`); the opening snapshot's entities are simply there
          bornAt: opening ? -Infinity : this.tickTime(T, now),
          haul: dropoffKind(e) ? { pressure: 0, phase: 0, until: 0 } : undefined,
        };
        this.tracks.set(e.id, tr);
        if (e.state === 'launching') tr.launchAt = tr.bornAt;
        if (!opening && (e.kind === 'gun_platform' || e.kind === 'gunship') && this.swapPartner(e)) tr.swapAt = tr.bornAt;
      } else {
        // a timed visit that just ended: the unit dives home on screen, and its departure/arrival marks play
        const hop = returnHop(tr.e, e, T);
        if (hop) {
          tr.dive = hop.tick;
          tr.diveFrom = hop.from;
          this.addHop(hop, tr.e);
        }
        if (tr.e.plane !== e.plane || Math.abs(e.x - tr.x) + Math.abs(e.y - tr.y) > TELEPORT) {
          tr.n = 0; // teleport: snap position and retire the previous plane's engine wake
          tr.motionEpoch++;
          // a plane change arrives with the grow-in and one flinch squash, not a one-frame pop
          if (tr.e.plane !== e.plane) tr.bornAt = tr.hitAt = this.tickTime(T, now);
        }
      }
      if (e.kind === 'island') this.islands.get(e.id)?.ore?.observe(e);
      if (tr.n > 0 && tr.st[tr.n - 1]! >= T) tr.n--; // duplicate tick: replace
      pushSample(tr, T, e.x, e.y, e.elevation ?? 0);
      tr.x = e.x;
      tr.y = e.y;
      // a hit flinches when this snapshot reaches the screen
      if (e.hp < tr.e.hp) tr.hitAt = this.tickTime(T, now);
      if (e.state === 'launching' && tr.e.state !== 'launching') tr.launchAt = this.tickTime(T, now);
      if (e.state === 'hangared' && tr.e.state !== 'hangared') tr.dockAt = this.tickTime(T, now);
      // an aerie drop squashes once as it touches down
      if (e.plane === 'sky' && e.transit?.to === 'surface' && e.transit.at > 0 && e.transit.at !== tr.e.transit?.at) tr.hitAt = this.tickTime(e.transit.at, now);
      if (e.plane === 'orbit' && tr.e.plane === 'orbit' && (e.maxShield ?? 0) > 0 && (e.shield ?? 0) < (tr.e.shield ?? 0))
        tr.shieldAt = this.tickTime(T, now);
      tr.e = e;
    }
    for (const tr of this.tracks.values()) {
      if (seen.has(tr.e.id)) continue;
      // gone from this view at its return tick: only the departure on the plane it was seen leaving plays
      const hop = returnHop(tr.e, undefined, T);
      if (hop) this.addHop(hop, tr.e);
      // gone with a death record this view lists: the model stays for its death, gliding to where it died
      const death = this.deaths ? deathOf(view.fx, tr) : undefined;
      if (death && this.deaths!.adopt(death, tr)) pushSample(tr, death.tick, death.x, death.y, death.sourceElevation ?? tr.sh[tr.n - 1] ?? 0);
      this.tracks.delete(tr.e.id);
    }
    this.presentations.ingest(view, this.tracks);
    for (const tr of this.tracks.values()) {
      tr.presentation = this.presentations.get(tr.e.id);
      if (tr.presentation && STATE_VISUALS[tr.e.kind]?.heading !== 'unit') tr.heading = tr.goal = tr.presentation.yaw;
    }
    if (!this.listedOnly) this.memory = view.memory;
    // FX are already fog-filtered. Repeated snapshot tails cannot restart an otherwise parked cable.
    let newestDeliveryTick = this.deliveryTick;
    for (const fx of view.fx) {
      if (fx.tick <= this.deliveryTick || fx.kind !== 'deliver') continue;
      newestDeliveryTick = Math.max(newestDeliveryTick, fx.tick);
      let destination: Track | undefined;
      let distance = Infinity;
      for (const tr of this.tracks.values()) {
        if (!tr.haul || !receivesDelivery(tr.e, fx)) continue;
        const d = Math.hypot(tr.x - fx.x, tr.y - fx.y);
        if (d < distance) { destination = tr; distance = d; }
      }
      if (destination?.haul) delivered(destination.haul, this.tickTime(fx.tick, now));
    }
    this.deliveryTick = newestDeliveryTick;

    this.spires.ingest(view);
  }

  /**
   * A shot recoils at its on-screen tick (`at`). Optional fogged FX endpoints resolve a currently visible target track.
   * Without an fx source id, match the turret-bearing shooter at the shot origin. A shot leaving its plane, or at a
   * falling rock, holds the mount's elevation toward the same 3D point its tracer flies to (`aim.ts`); a shot on its
   * own plane at an ordinary target lowers the barrels again.
   */
  fire(f: View['fx'][number], at: number, impacts: View['impacts']): void {
    let best = f.src ? this.tracks.get(f.src) : undefined;
    if (!best) {
      let bd = 0.6;
      for (const tr of this.tracks.values()) {
        if (tr.e.plane !== f.plane || !isStatKind(tr.e.kind) || STATS[tr.e.kind].mount?.kind !== 'turret') continue;
        const d = Math.abs(tr.x - f.x) + Math.abs(tr.y - f.y) + (f.sourceElevation === undefined ? 0 : Math.abs((tr.e.elevation ?? 0) - f.sourceElevation));
        if (d < bd) {
          bd = d;
          best = tr;
        }
      }
    }
    if (!best) return;
    best.fireAt = at;
    best.mountTarget = undefined;
    if (f.tp !== undefined && f.tx !== undefined && f.ty !== undefined) {
      for (const target of this.tracks.values()) {
        if (!target.visible || target.e.side === best.e.side || target.e.plane !== f.tp) continue;
        if (Math.abs(target.x - f.tx) > 1 / 256 || Math.abs(target.y - f.ty) > 1 / 256) continue;
        if (f.targetElevation !== undefined && Math.abs((target.e.elevation ?? 0) - f.targetElevation) > 1 / 256) continue;
        // FX carries an endpoint, not a target id: co-located contacts must remain ambiguous.
        if (best.mountTarget !== undefined) { best.mountTarget = undefined; break; }
        best.mountTarget = target.e.id;
      }
    }
    const kind = best.e.kind;
    if (!isStatKind(kind) || !RIG[kind].elevate) return;
    if (!crossPlaneAim(AIM, f, impacts, this.tracks, this.size, this.terrain)) { best.aimUntil = -Infinity; return; }
    best.aimX = AIM.x; best.aimY = AIM.y; best.aimZ = AIM.z;
    best.aimFall = AIM.fall;
    best.aimTarget = AIM.target?.e.id;
    best.aimUntil = at + Math.max(AIM_HOLD_MS, STATS[kind].cooldown * this.msPerTick * AIM_HOLD_COOLDOWNS);
  }

  /** Record a return hop at `e`'s last seen spot (the server hops in place); a full pool drops the newest. */
  private addHop(hop: ReturnHop, e: Entity): void {
    const side = e.side === 'neutral' ? -1 : ARMIES.indexOf(e.side);
    if (this.hopN >= HOP_CAP || side < 0) return;
    const i = this.hopN++;
    this.hopTick[i] = hop.tick;
    this.hopX[i] = e.x;
    this.hopY[i] = e.y;
    this.hopFrom[i] = PLANES.indexOf(hop.from);
    this.hopTo[i] = PLANES.indexOf(hop.to);
    this.hopLiftFrom[i] = hover(e.kind, hop.from);
    this.hopLiftTo[i] = hover(e.kind, hop.to);
    this.hopSide[i] = side;
    this.hopSeen[i] = hop.seen ? 1 : 0;
  }

  private dropHop(i: number): void {
    const j = --this.hopN;
    this.hopTick[i] = this.hopTick[j]!;
    this.hopX[i] = this.hopX[j]!;
    this.hopY[i] = this.hopY[j]!;
    this.hopFrom[i] = this.hopFrom[j]!;
    this.hopTo[i] = this.hopTo[j]!;
    this.hopLiftFrom[i] = this.hopLiftFrom[j]!;
    this.hopLiftTo[i] = this.hopLiftTo[j]!;
    this.hopSide[i] = this.hopSide[j]!;
    this.hopSeen[i] = this.hopSeen[j]!;
  }

  /** Render delay in ticks: ≥ 2 ticks and ≥ 1.6 view intervals, so there is always a newer snapshot to blend toward. */
  private delay(): number {
    return Math.max(2, this.gap * DELAY_SNAPS);
  }

  /** performance.now() at which server tick `tick` will be on screen (effects stay in sync with interpolated units). */
  tickTime(tick: number, now: number): number {
    return now + (tick - this.renderTick) * this.msPerTick;
  }

  /** The (fractional) server tick on screen right now. */
  get renderTick(): number {
    return this.clock < 0 ? this.lastTick - this.delay() : this.clock;
  }

  /** Advance the render clock (server ticks) smoothly toward `newest tick − DELAY` without ever jumping back. */
  private stepClock(now: number): number {
    const dt = this.lastFrame ? Math.min(250, now - this.lastFrame) : 0;
    this.lastFrame = now;
    if (this.lastTick < 0) return 0;
    // A blocked client receives consecutive deltas together. Measure the whole batch's elapsed time and tick
    // progress once, rather than assigning its wait to the first delta and discarding the near-zero gaps after it.
    if (this.lastTick > this.rateTick) {
      if (this.rateTick >= 0) {
        const msPerTick = (this.lastArrival - this.rateArrival) / (this.lastTick - this.rateTick);
        if (msPerTick > 5 && msPerTick < 1000) this.msPerTick = this.msPerTick * 0.9 + msPerTick * 0.1;
      }
      this.rateTick = this.lastTick;
      this.rateArrival = this.lastArrival;
    }
    const target = this.lastTick + (now - this.lastArrival) / this.msPerTick - this.delay();
    if (this.clock < 0 || Math.abs(target - this.clock) > 8 * this.gap) this.clock = target;
    else {
      // run at the observed tick rate, nudged ≤10% toward the target so arrival jitter is absorbed, never reversed
      const err = target - this.clock;
      const rate = 1 + clamp(err * 0.5, -0.1, 0.1);
      this.clock += (dt / this.msPerTick) * rate;
    }
    return this.clock;
  }

  private frameDt(now: number): number {
    const d = this.lastDt ? (now - this.lastDt) / 1000 : 0;
    this.lastDt = now;
    return d;
  }

  /** Interpolated position at render tick `rt`; extrapolates ≤ 1 tick past the newest snapshot, then holds. */
  private sample(tr: Track, rt: number): void {
    const n = tr.n;
    if (n <= 1 || rt <= tr.st[0]!) {
      tr.rx = n ? tr.sx[0]! : tr.x;
      tr.ry = n ? tr.sy[0]! : tr.y;
      tr.elevation = n ? tr.sh[0]! : tr.e.elevation ?? 0;
      this.vel = 0;
      return;
    }
    let i = n - 2;
    while (i > 0 && tr.st[i]! > rt) i--;
    const t0 = tr.st[i]!;
    const t1 = tr.st[i + 1]!;
    const span = Math.max(1e-6, t1 - t0);
    const k = Math.min((rt - t0) / span, 1 + 1 / span);
    const vx = (tr.sx[i + 1]! - tr.sx[i]!) / span;
    const vy = (tr.sy[i + 1]! - tr.sy[i]!) / span;
    tr.rx = tr.sx[i]! + vx * span * k;
    tr.ry = tr.sy[i]! + vy * span * k;
    tr.elevation = tr.sh[i]! + (tr.sh[i + 1]! - tr.sh[i]!) * Math.min(k, 1);
    // Positions are rounded to 0.01 tiles on the wire. A single segment's slope amplifies that
    // rounding into visible yaw changes. Blend centered tangents across this segment instead.
    const before = Math.max(0, i - 1);
    const after = Math.min(n - 1, i + 2);
    const startSpan = tr.st[i + 1]! - tr.st[before]!;
    const endSpan = tr.st[after]! - tr.st[i]!;
    const startX = (tr.sx[i + 1]! - tr.sx[before]!) / startSpan;
    const startY = (tr.sy[i + 1]! - tr.sy[before]!) / startSpan;
    const endX = (tr.sx[after]! - tr.sx[i]!) / endSpan;
    const endY = (tr.sy[after]! - tr.sy[i]!) / endSpan;
    const blend = Math.min(k, 1);
    this.vx = startX + (endX - startX) * blend;
    this.vy = startY + (endY - startY) * blend;
    // A stopped segment must not inherit a heading from earlier travel or a later correction.
    this.vel = Math.hypot(vx, vy);
  }

  private pushLine(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, c: Color, k: number): void {
    const lp = this.linePos;
    const lc = this.lineCol;
    if (this.seg >= lp.length / 6) return;
    const o = this.seg * 6;
    lp[o] = x1; lp[o + 1] = y1; lp[o + 2] = z1; lp[o + 3] = x2; lp[o + 4] = y2; lp[o + 5] = z2;
    lc[o] = c.r * k; lc[o + 1] = c.g * k; lc[o + 2] = c.b * k; lc[o + 3] = c.r * k; lc[o + 4] = c.g * k; lc[o + 5] = c.b * k;
    this.seg++;
  }

  /** Waypoint polyline for a selected own unit: current target, then queued destinations. */
  private waypoints(tr: Track): void {
    const e = tr.e;
    const y = tr.wy + 0.1;
    let px = wx(tr.rx, this.size);
    let pz = wz(tr.ry, this.size);
    const c = e.state === 'attacking' ? ATTACK_C : ORDER_C;
    if (e.tx !== undefined && e.ty !== undefined) {
      this.pushLine(px, y, pz, wx(e.tx, this.size), y, wz(e.ty, this.size), c, 0.7);
      px = wx(e.tx, this.size);
      pz = wz(e.ty, this.size);
    }
    if (!e.wp) return;
    for (const w of e.wp) {
      this.pushLine(px, y, pz, wx(w.x, this.size), y, wz(w.y, this.size), QUEUE_C, 0.55);
      px = wx(w.x, this.size);
      pz = wz(w.y, this.size);
    }
  }

  /** Only observed tower/island pairs get a tether; a remembered enemy tower never projects a field. */
  private moorings(selected: ReadonlySet<string>): void {
    let n = 0;
    const rules = this.snapshot?.match.rules.surface;
    const alpha = Math.max(fadeValue.surface, fadeValue.sky);
    if (rules && alpha > 0.03) for (const tower of this.tracks.values()) {
      const e = tower.e;
      if (e.kind !== 'mooring_tower' || e.hp <= 0 || e.state === 'constructing' || n >= 256) continue;
      const active = e.mooringState === 'held' || e.mooringState === 'lowering' || e.mooringState === 'raising';
      const waiting = e.mooringState === 'waiting';
      const obscured = !e.mooringState && e.mooringGrace !== undefined;
      if (!active && !waiting && !obscured && !selected.has(e.id)) continue;
      const c = sideColor(e.side);
      const warning = (active || obscured) && e.mooringState !== 'raising' && e.mooringGrace !== undefined && e.mooringGrace < rules.mooringGraceTime * TICK_RATE;
      this.mooringTint.setXYZW(n, warning ? 1 : c.r, warning ? 0.48 : c.g, warning ? 0.12 : c.b, alpha * (active ? 0.85 : waiting || obscured ? 0.3 : 0.12));
      const crown = tower.wy + 2.1 * tower.scale;
      tmp.position.set(wx(tower.rx, this.size), crown, wz(tower.ry, this.size));
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(0.85 * tower.scale, 1.1 * tower.scale, 0.85 * tower.scale);
      tmp.updateMatrix();
      this.mooringFields.setMatrixAt(n, tmp.matrix);
      let island = e.mooringTarget ? this.tracks.get(e.mooringTarget) : undefined;
      if (!island && active) for (const candidate of this.tracks.values()) {
        if (candidate.e.kind === 'island' && candidate.e.mooringTower === e.id) { island = candidate; break; }
      }
      if (active && island?.e.kind === 'island' && island.visible && fadeValue.sky > 0.03) {
        const dx = island.rx - tower.rx, dy = island.wy - crown, dz = island.ry - tower.ry;
        const length = Math.hypot(dx, dy, dz);
        tmp.position.set(wx((tower.rx + island.rx) / 2, this.size), crown + dy / 2, wz((tower.ry + island.ry) / 2, this.size));
        tmp.quaternion.setFromUnitVectors(this.mooringUp, this.mooringDirection.set(dx, dy, dz).normalize());
        tmp.scale.set(0.18, length, 0.18);
      } else tmp.scale.set(0, 0, 0);
      tmp.updateMatrix();
      this.mooringTethers.setMatrixAt(n++, tmp.matrix);
    }
    this.mooringFields.count = this.mooringTethers.count = n;
    this.mooringFields.instanceMatrix.needsUpdate = this.mooringTethers.instanceMatrix.needsUpdate = true;
    this.mooringTint.needsUpdate = true;
  }

  /** Write a second, Depths-local instance without duplicating a gameplay entity or consulting hidden state. */
  private landing(e: Pick<Entity, 'kind' | 'plane' | 'side' | 'x' | 'y'> & Partial<Pick<Entity, 'state'>>, remembered: boolean, work = 0, cycle = 0): void {
    const kind = landingKind(e);
    if (!kind || fadeValue.depths < 0.03) return;
    // Surface sight/memory alone cannot reveal an enemy's underground counterpart.
    if (e.side !== this.viewArmy && (this.depthKnowledge[Math.floor(e.y) * this.size + Math.floor(e.x)] ?? CELL.unknown) === CELL.unknown) return;
    const km = (remembered ? this.dropoffGhosts : this.dropoffs).get(kind)!;
    this.staticInstance(e, km, 'depths', work, cycle);
  }

  /**
   * A dying unit's model, kept by the death player: its last pose glides to the death spot by the death's tick, then
   * its death stage poses it (`DeathSlot`: tilt, sink, squash, shrink, char, fade, or the wreck's fall).
   */
  private corpse(d: DeathSlot, tr: Track, rt: number, counts: Map<Kind, number>): void {
    const e = tr.e;
    const km = this.kinds.get(e.kind);
    if (!km) return;
    this.sample(tr, rt);
    const pad = isHardpointKind(e.kind) && e.link ? this.islands.get(e.link) : undefined;
    if (pad) {
      tr.rx += pad.padX;
      tr.ry += pad.padY;
    }
    tr.wy = unitY(e.plane) + hover(e.kind, e.plane) + tr.elevation + (e.plane === 'surface' ? groundAt(tr.rx, tr.ry, this.terrain) : 0);
    const x = wx(tr.rx, this.size), z = wz(tr.ry, this.size);
    this.deaths!.place(d, x, tr.wy + BODY_LIFT * tr.scale, z, tr.scale);
    const fade = (d.below ? Math.max(fadeValue[e.plane], fadeValue[d.below]) : fadeValue[e.plane]) * d.alpha;
    const i = counts.get(e.kind) ?? 0;
    if (fade < 0.01 || i >= km.cap) return;
    counts.set(e.kind, i + 1);
    const c = sideColor(e.side);
    const k = tr.scale * d.scaleK;
    const px = x + d.ox, py = tr.wy + d.oy, pz = z + d.oz;
    km.set(i, REC.x, px);
    km.set(i, REC.y, py);
    km.set(i, REC.z, pz);
    km.set(i, REC.yaw, -(tr.heading + d.yaw));
    km.set(i, REC.scale, k);
    km.set(i, REC.build, e.state === 'constructing' && STRUCT.has(e.kind) ? buildRecord(e) : d.build);
    km.set(i, REC.bank, tr.bank + d.bank);
    km.set(i, REC.pitch, tr.pitch + d.pitch);
    km.set(i, REC.r, c.r + (CHAR.r - c.r) * d.char);
    km.set(i, REC.g, c.g + (CHAR.g - c.g) * d.char);
    km.set(i, REC.b, c.b + (CHAR.b - c.b) * d.char);
    km.set(i, REC.fade, fade);
    km.set(i, REC.look, PIDX[e.plane] + Math.min(0.999, focusValue[e.plane]));
    km.set(i, REC.fire, clockAt(tr.fireAt));
    km.set(i, REC.hit, clockAt(tr.hitAt));
    km.set(i, REC.gait, tr.odo);
    km.set(i, REC.drive, 0);
    km.set(i, REC.work, stateVisualChannel(e, 'work', this.carryMax, 0, 0, tr.presentation));
    km.set(i, REC.phase, tr.phase);
    km.set(i, REC.fill, isStatKind(e.kind) && STATS[e.kind].mount?.kind === 'turret' ? packMount(-angleDelta(tr.heading, tr.aim), tr.mountPitch)
      : stateVisualChannel(e, 'fill', this.carryMax, 0, 0, tr.presentation));
    km.commit(i, px, py, pz, k);
  }

  /** Surface height a body stands at: structures keep their footing over a hole (TerrainField.footingAt), units the ground. */
  private standAt(kind: Kind, x: number, y: number): number {
    return STRUCT.has(kind) ? this.terrain.footingAt(x, y) : groundAt(x, y, this.terrain);
  }

  private staticInstance(e: Pick<Entity, 'kind' | 'side' | 'x' | 'y'>, km: KindMesh, plane: Plane, work = 0, fill = 0, yaw = 0, zoomScale = 1, elevation = 0): void {
    if (km.count >= km.cap || fadeValue[plane] < 0.03) return;
    const i = km.count++;
    const c = sideColor(e.side);
    const x = wx(e.x, this.size), y = unitY(plane) + elevation + (plane === 'surface' ? this.standAt(e.kind, e.x, e.y) : plane === 'sky' ? 0.05 : e.kind === 'geothermal' ? DEPTHS_ROCK_HEIGHT : 0), z = wz(e.y, this.size);
    km.set(i, REC.x, x);
    km.set(i, REC.y, y);
    km.set(i, REC.z, z);
    km.set(i, REC.yaw, -yaw);
    km.set(i, REC.scale, km.footprintScale * (e.kind === 'gun_platform' ? zoomScale : 1));
    km.set(i, REC.build, 1);
    km.set(i, REC.r, c.r);
    km.set(i, REC.g, c.g);
    km.set(i, REC.b, c.b);
    km.set(i, REC.fade, fadeValue[plane]);
    km.set(i, REC.look, PIDX[plane] + Math.min(0.999, focusValue[plane]));
    km.set(i, REC.fire, -1e9);
    km.set(i, REC.hit, -1e9);
    km.set(i, REC.work, q(work, 1 / 255));
    km.set(i, REC.fill, q(fill, 1 / 1024));
    km.commit(i, x, y, z, km.footprintScale);
  }

  /** `sun` = the orbit's lit-wedge bearing (rad): solar arrays roll their panels toward it. */
  frame(now: number, t: number, selected: ReadonlySet<string>, hovered: string | undefined, army: ArmyId, focus: Plane, zoom: number, sun = 0): void {
    const rt = this.stepClock(now);
    const elapsed = Math.min(1, this.frameDt(now));
    const dt = Math.min(0.1, elapsed);
    this.presentations.frame(elapsed, this.motion?.matches ?? false);
    const facingBlend = -Math.expm1(-dt / FACING_RESPONSE);
    const turnLimit = SLEW * dt;
    const counts = this.counts;
    counts.clear();
    this.trenches.begin();
    this.selectionContours.begin(dt, this.motion?.matches ?? false);
    this.mounted.clear();
    let nw = 0;
    const washArr = this.washColumns.instanceMatrix.array as Float32Array;
    const rippleArr = this.washRipples.instanceMatrix.array as Float32Array;
    const washTint = this.washTint.array as Float32Array;
    for (const km of this.dropoffs.values()) km.count = 0;
    for (const km of this.dropoffGhosts.values()) km.count = 0;
    for (const { terrain, grove, ore } of this.islands.values()) {
      terrain.count = 0;
      grove.group.visible = false;
      if (ore) ore.mesh.visible = false;
    }
    let sc = 0;
    this.seg = 0;
    let cones = 0;
    let nd = 0;
    let nk = 0;
    let na = 0;
    let nr = 0;
    let ns = 0;
    const arcArr = this.returnArcs.instanceMatrix.array as Float32Array;
    const trailArr = this.contrails.instanceMatrix.array as Float32Array;
    const markArr = this.ascentMarks.instanceMatrix.array as Float32Array;
    const dabArr = this.dabs.instanceMatrix.array as Float32Array;
    const dabTint = this.dabTint.array as Float32Array;
    const stalkArr = this.stalks.instanceMatrix.array as Float32Array;
    const stalkTint = this.stalkTint.array as Float32Array;
    // Units and emplaced airframes grow with zoom; footprint-fitted structures keep their rigid scale.
    const zs = unitZoomScale(zoom);
    const ease = dt > 0 ? -Math.expm1(-dt / 0.12) : 0;
    const slow = dt > 0 ? -Math.expm1(-dt / 0.4) : 0;
    const ticksPerS = 1000 / this.msPerTick;

    for (const tr of this.tracks.values()) {
      const e = tr.e;
      const hauling = tr.haul ? stepHaul(tr.haul, now, elapsed, this.motion?.matches ?? false) : 0;
      this.landing(e, false, hauling, tr.haul?.phase ?? 0);
      this.sample(tr, rt);
      if ((e.kind === 'asteroid' || e.kind === 'core') && e.state === 'towed' && e.link) {
        const tug = this.tracks.get(e.link);
        if (tug) {
          tr.rx = tug.rx - Math.cos(tug.towHeading) * TOW_LEN;
          tr.ry = tug.ry - Math.sin(tug.towHeading) * TOW_LEN;
        }
      }
      // A hardpoint attachment rides its island's centre in the sim; it is drawn on that island's rim pad, facing out.
      const pad = isHardpointKind(e.kind) && e.link ? this.islands.get(e.link) : undefined;
      if (pad) {
        tr.rx += pad.padX;
        tr.ry += pad.padY;
        this.mounted.add(e.link!);
      }
      // Orbit ships can coast while idle: their visible snapshot motion, not their order state, drives the rig.
      const moving = e.state !== 'idle' || (e.plane === 'orbit' && e.heading !== undefined);
      const travelling = moving && this.vel > TURN_SPEED && Math.hypot(this.vx, this.vy) > TURN_SPEED;
      const travel = travelling ? Math.atan2(this.vy, this.vx) : undefined;
      if (e.kind === 'tug' && travel !== undefined)
        tr.towHeading += clamp(angleDelta(tr.towHeading, travel) * facingBlend, -turnLimit, turnLimit);
      const work = workHeading(e, army, this.tracks, tr.towHeading);
      // Authoritative mounted hulls stay independent of turret aim; workers use the same damped turn.
      if (e.heading !== undefined) tr.goal = e.heading;
      else if (work !== undefined) tr.goal = work;
      else if (travel !== undefined) tr.goal += angleDelta(tr.goal, travel) * facingBlend;
      const d = angleDelta(tr.heading, tr.goal);
      const turned = clamp(d * facingBlend, -turnLimit, turnLimit);
      tr.heading += turned;
      // Gates and spans keep their knowledge-derived pose (Presentations); other structures face their pad or north.
      if (STRUCT.has(e.kind) && !STATE_VISUALS[e.kind]?.pose) tr.heading = pad ? Math.atan2(pad.padY, pad.padX) : 0;
      if (tr.mountTarget && (!this.tracks.get(tr.mountTarget)?.visible || e.state === 'idle')) tr.mountTarget = undefined;
      tr.wy = unitY(e.plane) + hover(e.kind, e.plane) + tr.elevation + (e.plane === 'surface' ? this.standAt(e.kind, tr.rx, tr.ry) : 0);
      const climbing = (e.transit?.at ?? 0) > 0 && e.plane === 'sky' && e.transit?.to === 'orbit';
      const dropping = (e.transit?.at ?? 0) > 0 && e.plane === 'sky' && e.transit?.to === 'surface';
      const raiding = (e.transit?.until ?? 0) > 0 && e.plane === 'orbit';
      const climb = climbing ? clamp(1 - ((e.transit?.at ?? 0) - rt) / Math.max(1, this.ascentClimb), 0, 1) : 0;
      if (climbing) tr.wy += (unitY('orbit') + 0.2 - tr.wy) * climb;
      if (dropping) {
        const duration = Math.max(1, (this.snapshot?.match.rules.sky.aerieDropTravel ?? 0) * TICK_RATE);
        const progress = clamp(1 - (e.transit!.at - rt) / duration, 0, 1);
        const landingY = unitY('surface') + hover(e.kind, 'surface') + groundAt(tr.rx, tr.ry, this.terrain);
        // an eased descent that flares onto the ground (the touchdown flinch is scheduled at ingest)
        tr.wy += (landingY - tr.wy) * (1 - (1 - progress) ** 3);
      }
      // presentation-only dive after a timed visit's instant hop home: it falls from the plane it visited, eased in
      if (tr.dive > 0 && rt >= tr.dive + RETURN_DIVE) tr.dive = 0;
      const diving = tr.dive > 0;
      const dive = diving ? diveProgress(rt, tr.dive) : 1;
      if (diving) {
        const top = unitY(tr.diveFrom) + hover(e.kind, tr.diveFrom);
        tr.wy = top + (tr.wy - top) * dive;
      }
      if (e.state === 'launching') {
        // Rolled out of the hangar mouth and lifted off the deck over the launch window, ending where flight resumes.
        const p = clamp((now - (tr.launchAt ?? now)) / (ECON.aerieLaunchTicks * this.msPerTick), 0, 1);
        const deck = unitY('sky') + AERIE_LAUNCH.deck;
        tr.wy = deck + (tr.wy - deck) * easeWindow([AERIE_LAUNCH.liftFrom, 1], p);
        tr.rx += AERIE_LAUNCH.roll * Math.sin(Math.PI * p);
      }
      // housed this moment: it settles onto the deck and shrinks into the hangar instead of vanishing
      const docking = e.state === 'hangared' && tr.dockAt !== undefined && now - tr.dockAt < AERIE_DOCK.seconds * 1000;
      let docked = 1;
      if (docking) {
        const p = clamp((now - tr.dockAt!) / (AERIE_DOCK.seconds * 1000), 0, 1);
        const deck = unitY('sky') + AERIE_LAUNCH.deck;
        tr.wy += (deck - tr.wy) * p;
        docked = 1 - p * p * p;
      }
      // the emplace swap's pair animates its own transition instead of growing in
      const k = (e.kind === 'asteroid' ? rockScale(e) : e.kind === 'core' ? CORE_SCALE * zs : e.kind === 'island' || e.kind === 'spire' ? 1 : STRUCT.has(e.kind) ? this.kinds.get(e.kind)!.footprintScale * (e.kind === 'gun_platform' ? zs : 1) : UNIT_SCALE * (e.plane === 'sky' || e.plane === 'orbit' ? AIR_SCALE : 1) * zs)
        * (e.kind === 'island' || tr.swapAt !== undefined ? 1 : arrivalScale((now - (tr.bornAt ?? -Infinity)) / 1000)) * docked;
      tr.scale = k;
      // after its height and scale: the barrels elevate from the mount's own trunnion height
      stepMountAim(tr, dt, now, rt, this.size, this.tracks);
      // motion for the rig: real travel only (idle position corrections neither walk nor bank a unit)
      if (dt > 0) {
        const heldOrbit = e.plane === 'orbit' && rt > tr.st[tr.n - 1]! + 1;
        const speed = moving && !heldOrbit && this.vel > TURN_SPEED ? this.vel * ticksPerS : 0;
        const prev = tr.speed;
        tr.speed += (speed - tr.speed) * ease;
        // acceleration from a differentiated, wire-rounded speed is noisy: slow it down for the attitude below
        tr.accel += ((tr.speed - prev) / dt - tr.accel) * slow;
        tr.turn += (turned / dt - tr.turn) * slow;
        // turning on the spot still walks the running gear: each side's track covers its half-gauge arc
        tr.odo = (tr.odo + (tr.speed * dt) / k + Math.abs(turned) * TURN_GAUGE) % 512;
        if (e.kind === 'solar') tr.roll += (0.45 * Math.cos(sun - tr.heading) - tr.roll) * ease * 0.1;
      }
      const fade = climbing ? Math.max(fadeValue.sky, fadeValue.orbit) : diving ? Math.max(fadeValue[tr.diveFrom], fadeValue[e.plane]) : fadeValue[e.plane];
      tr.visible = fade > 0.03 && e.state !== 'falling' && (e.state !== 'hangared' || docking);
      if (!tr.visible || e.kind === 'spire') continue;
      const island = e.kind === 'island' ? this.islands.get(e.id) : undefined;
      const km = island?.terrain ?? this.kinds.get(e.kind);
      if (!km) continue;
      const i = island ? 0 : counts.get(e.kind) ?? 0;
      if (i >= km.cap) {
        if (e.plane === 'orbit') tr.visible = false;
        continue;
      }
      if (island) {
        km.count = 1;
        island.grove.group.visible = true;
        island.grove.group.position.set(wx(tr.rx, this.size), tr.wy, wz(tr.ry, this.size));
        island.grove.updateWeather(this.snapshot!.weather, tr, this.size, this.fogField, this.motion?.matches ?? false, dt);
        island.ore?.weather(island.grove.storm.value.x);
        if (island.ore) {
          island.ore.mesh.position.copy(island.grove.group.position);
          island.ore.mesh.visible = island.ore.mesh.count > 0;
        }
      } else counts.set(e.kind, i + 1);
      const c = sideColor(e.side);
      const x = wx(tr.rx, this.size);
      const z = wz(tr.ry, this.size);
      if ((climbing || raiding) && na < TRAIL_CAP) {
        const trailY = unitY('sky') + (climbing ? hover(e.kind, 'sky') : 0);
        putFlat(trailArr, na, x, trailY, z, zs, climbing ? Math.max(0.01, tr.wy - trailY) : 0);
        putFlat(markArr, na, x, unitY('orbit') + 0.24, z, zs, 1);
        this.ascentTint.setXYZW(na, c.r, c.g, c.b, fade * (climbing ? 1 : 0.65));
        na++;
      }
      const warn = returnWarning(e, rt);
      if (warn >= 0 && nr < RETURN_CAP) {
        putFlat(arcArr, nr, x, tr.wy + 0.06, z, zs * 1.3, 1);
        this.returnTint.setXYZW(nr, c.r, c.g, c.b, Math.floor(warn * 64) + Math.min(0.999, fade));
        nr++;
      }
      // attitude: flyers bank into turns and dip the nose with speed and sustained acceleration; ground vehicles lean
      // out and squat. Islands, asteroids and structures never tilt (an island's drift is not a manoeuvre).
      let bank = 0;
      let pitch = 0;
      const surge = Math.sign(tr.accel) * Math.max(0, Math.abs(tr.accel) - ACCEL_DEADBAND);
      // banking needs a real turn at speed: slow station-keeping (a flyer holding over a drifting island) follows a
      // noisy travel direction whose wobble must not read as rolling
      const veer = Math.sign(tr.turn) * Math.max(0, Math.abs(tr.turn) - TURN_DEADBAND) * clamp((tr.speed - 0.5) / 1.5, 0, 1);
      const tilts = !isNeutralKind(e.kind) && !STRUCT.has(e.kind);
      if (tilts && e.plane === 'sky') {
        const limit = SKY_BANK[e.kind] ?? 0.6;
        bank = clamp(veer * 0.3, -limit, limit);
        pitch = clamp(-surge * 0.05 - tr.speed * 0.015, -0.2, 0.12);
      } else if (tilts && e.plane === 'orbit') {
        const limit = ORBIT_BANK[e.kind] ?? 0.08;
        bank = clamp(veer * 0.2, -limit, limit);
      } else if (tilts) {
        bank = clamp(veer * (e.kind === 'trooper' ? 0.05 : -0.04), -0.07, 0.07);
        pitch = clamp(surge * 0.04, -0.06, 0.06);
      }
      if (climbing) pitch = Math.sin(climb * Math.PI) * 0.8;
      else if (diving) pitch = -Math.sin(Math.sqrt(dive) * Math.PI) * 0.7;
      tr.bank = q(bank, 0.002);
      tr.pitch = q(pitch, 0.002);
      km.set(i, REC.x, x);
      km.set(i, REC.y, tr.wy);
      km.set(i, REC.z, z);
      km.set(i, REC.yaw, e.kind === 'island' ? 0 : -tr.heading);
      km.set(i, REC.scale, k);
      km.set(i, REC.build, buildRecord(e));
      km.set(i, REC.bank, q(bank, 0.002));
      km.set(i, REC.pitch, q(pitch, 0.002));
      km.set(i, REC.r, c.r);
      km.set(i, REC.g, c.g);
      km.set(i, REC.b, c.b);
      km.set(i, REC.fade, fade * (e.cloaked ? 0.28 : 1));
      km.set(i, REC.look, PIDX[e.plane] + Math.min(0.999, focusValue[e.plane]));
      km.set(i, REC.fire, clockAt(tr.fireAt));
      km.set(i, REC.hit, clockAt(tr.hitAt));
      km.set(i, REC.gait, tr.odo);
      km.set(i, REC.drive, q(tr.speed, 0.02));
      km.set(i, REC.work, e.kind === 'bastion' ? q(clamp((e.shield ?? 0) / Math.max(1, e.maxShield ?? STATS.bastion.shield!), 0, 1), 1 / 255)
        : e.kind === 'asteroid' ? q(rockFuseGlow(e, rt, this.snapshot!.match.rules.orbit.volatileFuse), 1 / 255)
        : e.kind === 'core' ? q((e.heat ?? 0) / 100, 1 / 255)
        : e.kind === 'solar' ? q(tr.roll, 0.005)
        : tr.swapAt !== undefined && (e.kind === 'gun_platform' || e.kind === 'gunship') ? q(1 - easeWindow([0, 1], (now - tr.swapAt) / (EMPLACE_SWAP.seconds * 1000)), 1 / 255)
        : stateVisualChannel(e, 'work', this.carryMax, hauling, tr.haul?.phase ?? 0, tr.presentation));
      km.set(i, REC.phase, tr.phase);
      km.set(i, REC.fill, e.kind === 'asteroid' ? rockResource(e)
        : e.kind === 'core' ? (e.heat === undefined ? 0 : 1)
        : e.kind === 'solar' ? packSolar(e, this.rampStart, clamp(0.5 + (this.sunHalf - Math.abs(sunOffset(e.x, e.y, sun, this.size, this.sunWedges))) / SOLAR_DUSK, 0, 1))
        : isStatKind(e.kind) && STATS[e.kind].mount?.kind === 'turret'
          ? packMount(-angleDelta(tr.heading, tr.aim), tr.mountPitch)
          : q(stateVisualChannel(e, 'fill', this.carryMax, hauling, tr.haul?.phase ?? 0, tr.presentation), tr.haul ? 1 / 1024 : 1 / 255));
      km.commit(i, x, tr.wy, z, k);
      if (e.kind === 'trooper' && e.plane === 'surface' && e.side !== 'neutral') this.trenches.add(x, tr.wy, z, e.side, stateVisualChannel(e, 'work', this.carryMax), k);

      // Only currently visible, shield-bearing Orbit ships can carry a shield hit out of a snapshot.
      const shieldAge = (now - tr.shieldAt) / SHIELD_LINGER;
      if (e.plane === 'orbit' && (e.maxShield ?? 0) > 0 && shieldAge >= 0 && shieldAge < 1 && ns + 2 <= SHIELD_CAP) {
        const expand = 1 + shieldAge * 0.22;
        for (let ring = 0; ring < 2; ring++) {
          tmp.position.set(x, tr.wy + 0.08 + ring * 0.05, z);
          tmp.rotation.set(ring * 0.65, -tr.heading, 0, 'YXZ');
          tmp.scale.set((km.halfX + 0.14) * k * expand, k * 0.65, (km.halfZ + 0.14) * k * expand);
          tmp.updateMatrix();
          this.shields.setMatrixAt(ns, tmp.matrix);
          this.shieldTint.setXYZW(ns, c.r, c.g, c.b, fade * (1 - shieldAge) * (ring ? 0.55 : 1));
          ns++;
        }
      }

      let selectedRing = 1;
      // the dab under it (own and enemy alike; neutral rocks have none), and a stalk down to it for flyers
      if (e.side !== 'neutral' && !isNeutralKind(e.kind)) {
        const footY = e.plane === 'surface' ? PLANE_Y.surface + this.standAt(e.kind, tr.rx, tr.ry) + 0.04 : unitY(e.plane) + tr.elevation + (e.kind === 'geothermal' ? DEPTHS_ROCK_HEIGHT : 0) + 0.02;
        const dr = (BIG[e.kind] ? 0.6 : 0.42) * k;
        const a = fade * (0.35 + 0.65 * focusValue[e.plane]);
        const merged = contourEligible(e, selected, tr.visible) && (!this.fogField || this.fogField.tileVisible(e.plane, tr.rx, tr.ry));
        const normalDab = merged ? this.selectionContours.add(e, tr.rx, tr.ry, footY, dr, tr.elevation, c, a) : 1;
        if (e.side === army) selectedRing = normalDab;
        if (normalDab > 0 && nd < DAB_CAP) {
          putFlat(dabArr, nd, wx(tr.rx, this.size), footY, wz(tr.ry, this.size), dr, 1);
          const o = nd * 4;
          dabTint[o] = c.r; dabTint[o + 1] = c.g; dabTint[o + 2] = c.b; dabTint[o + 3] = Math.floor(tr.phase * 15) + Math.min(0.999, a * normalDab);
          nd++;
        }
        if (e.plane === 'sky' && !STRUCT.has(e.kind) && nk < STALK_CAP && tr.wy > footY) {
          putFlat(stalkArr, nk, wx(tr.rx, this.size), footY, wz(tr.ry, this.size), 0.022 * zs, tr.wy - footY);
          const s = nk * 4;
          stalkTint[s] = c.r; stalkTint[s + 1] = c.g; stalkTint[s + 2] = c.b; stalkTint[s + 3] = a;
          nk++;
        }
        // rotor wash: a downdraft column under each ducted fan and a ripple ring where it meets the deck below
        if (e.kind === 'gunship' && e.plane === 'sky' && nw + 2 <= WASH_CAP && tr.wy > footY + 0.3) {
          const ch = Math.cos(tr.heading), sh = Math.sin(tr.heading);
          for (const side of WASH_SIDES) {
            const fx = GUNSHIP.fan.x * k, fz = side * GUNSHIP.fan.z * k;
            const wxp = wx(tr.rx, this.size) + fx * ch - fz * sh, wzp = wz(tr.ry, this.size) + fx * sh + fz * ch;
            putFlat(washArr, nw, wxp, footY + 0.02, wzp, GUNSHIP.fan.r * k * 0.85, tr.wy - footY - 0.06 * k);
            putFlat(rippleArr, nw, wxp, footY + 0.03, wzp, GUNSHIP.fan.r * k * 2.6, 1);
            const w = nw * 4;
            washTint[w] = c.r; washTint[w + 1] = c.g; washTint[w + 2] = c.b; washTint[w + 3] = Math.floor(tr.phase * 15) + Math.min(0.999, a);
            nw++;
          }
        }
      }

      const isSel = selected.has(e.id);
      if (!STRUCT.has(e.kind) && (isSel || hovered === e.id) && sc < 256 && fade > 0.5) {
        const rel = relation(army, e.side);
        // The group contour replaces own selected loops too: otherwise their coincident rims
        // conceal the union. Hover and every non-own cue retain their existing marker.
        const alpha = (hovered === e.id ? 1 : selectedRing) * (isSel ? 0.9 : 0.55);
        if (alpha > 0) {
          const r = e.kind === 'island' ? 5 : e.kind === 'tank' || e.kind === 'bomber' || e.kind === 'gunship' ? 2 * zs : e.kind === 'asteroid' ? 2.2 * k : e.kind === 'core' ? 1.6 * k : 1.3 * zs;
          tmp.position.set(wx(tr.rx, this.size), tr.wy + (e.kind === 'island' ? 0.1 : 0.04), wz(tr.ry, this.size));
          tmp.rotation.set(0, 0, 0);
          tmp.scale.set(r, 1, r);
          tmp.updateMatrix();
          this.sel.setMatrixAt(sc, tmp.matrix);
          const sel = rel === 'own' ? (isSel ? SEL_OWN : HOVER_OWN) : rel === 'allied' ? SEL_ALLIED : rel === 'neutral' ? SEL_NEUTRAL : SEL_HOSTILE;
          this.selTint.setXYZW(sc, sel.r, sel.g, sel.b, alpha);
          sc++;
        }
        // order line to the current destination
        if (isSel && rel === 'own' && e.plane === focus) this.waypoints(tr);
      }

      if (e.kind === 'relay' && cones < 32) {
        tmp.position.set(wx(tr.rx, this.size), (tr.wy + PLANE_Y.surface) / 2, wz(tr.ry, this.size));
        tmp.rotation.set(0, 0, 0);
        tmp.scale.set(8, tr.wy - PLANE_Y.surface, 8);
        tmp.updateMatrix();
        this.cones.setMatrixAt(cones, tmp.matrix);
        this.coneTint.setXYZW(cones, c.r, c.g, c.b, e.state === 'constructing' ? 0.3 : 1);
        cones++;
      }
    }
    if (this.deaths) for (let i = 0; i < this.deaths.slots.length; i++) {
      const d = this.deaths.slots[i]!;
      if (d.live && d.corpse) this.corpse(d, d.corpse, rt, counts);
    }
    this.moorings(selected);

    // Return hops: a dive trail hanging from the plane left, a departure ring widening there, and (only when the unit
    // is visible where it lands) the climb's arrival ring on the return plane.
    for (let i = 0; i < this.hopN;) {
      const tick = this.hopTick[i]!;
      if (rt >= tick + RETURN_DIVE + RETURN_LINGER) {
        this.dropHop(i);
        continue;
      }
      if (na + 2 <= TRAIL_CAP) {
        const from = PLANES[this.hopFrom[i]!]!, to = PLANES[this.hopTo[i]!]!;
        const seen = this.hopSeen[i] === 1;
        const a = hopFade(rt, tick);
        const c = sideColor(ARMIES[this.hopSide[i]!]!);
        const hx = this.hopX[i]!, hy = this.hopY[i]!;
        const x = wx(hx, this.size), z = wz(hy, this.size);
        const fromY = unitY(from) + (from === 'surface' ? groundAt(hx, hy, this.terrain) : 0);
        const toY = unitY(to) + (to === 'surface' ? groundAt(hx, hy, this.terrain) : 0);
        const top = fromY + this.hopLiftFrom[i]!;
        // an unseen landing stops the trail part-way: the fall is visible on the plane it left, the landing is not
        const head = top + (toY + this.hopLiftTo[i]! - top) * diveProgress(rt, tick) * (seen ? 1 : 0.35);
        putFlat(trailArr, na, x, top, z, zs, Math.min(-0.01, head - top));
        putFlat(markArr, na, x, fromY + 0.24, z, zs * (1.6 - 0.6 * a), 1);
        this.ascentTint.setXYZW(na, c.r, c.g, c.b, a * Math.max(fadeValue[from], seen ? fadeValue[to] : 0));
        na++;
        if (seen) {
          putFlat(trailArr, na, x, toY, z, zs, 0);
          putFlat(markArr, na, x, toY + this.hopLiftTo[i]! + 0.04, z, zs * 1.4, 1);
          this.ascentTint.setXYZW(na, c.r, c.g, c.b, fadeValue[to] * Math.min(1, a * 1.6));
          na++;
        }
      }
      i++;
    }
    this.returnArcs.count = nr;
    this.returnArcs.instanceMatrix.needsUpdate = true;
    this.returnTint.needsUpdate = true;

    // fog memory: where enemy structures were last seen
    for (const g of this.ghosts.values()) g.count = 0;
    for (const m of this.memory) {
      // a remembered hardpoint attachment rode a drifting island: the public pass below places it on today's pad
      if (this.tracks.has(m.id) || isHardpointKind(m.kind)) continue;
      this.landing(m, true);
      const g = this.ghosts.get(m.kind);
      if (!g) continue;
      const state = this.presentations.get(m.id);
      this.staticInstance(m, g, m.plane, 0, state?.fill ?? 0, state?.yaw ?? 0, 1, m.elevation ?? 0);
    }
    // A public hardpoint occupant (`islands[].hardpoint`) whose entity this view does not list: drawn from memory on
    // its (always public) island's pad, like a remembered structure.
    if (this.snapshot) for (const p of this.snapshot.islands) {
      if (!p.hardpoint || this.mounted.has(p.id)) continue;
      const isle = this.tracks.get(p.id), pad = this.islands.get(p.id), g = this.ghosts.get(p.hardpoint.kind);
      if (!isle?.visible || !pad || !g) continue;
      const spot = this.mountSpot;
      spot.kind = p.hardpoint.kind;
      spot.side = p.hardpoint.side;
      spot.x = isle.rx + pad.padX;
      spot.y = isle.ry + pad.padY;
      this.staticInstance(spot, g, 'sky', 0, 0, Math.atan2(pad.padY, pad.padX), zs, isle.elevation);
    }
    for (const g of this.ghosts.values()) g.publish(g.count);

    for (const [k, km] of this.kinds) km.publish(counts.get(k) ?? 0);
    for (const { terrain } of this.islands.values()) terrain.publish(terrain.count);
    for (const km of this.dropoffs.values()) km.publish(km.count);
    for (const km of this.dropoffGhosts.values()) km.publish(km.count);
    this.sel.count = sc;
    this.sel.instanceMatrix.needsUpdate = true;
    this.selTint.needsUpdate = true;
    this.dabs.count = nd;
    this.selectionContours.publish();
    this.trenches.publish();
    this.dabs.instanceMatrix.needsUpdate = true;
    this.dabTint.needsUpdate = true;
    this.stalks.count = nk;
    this.stalks.instanceMatrix.needsUpdate = true;
    this.stalkTint.needsUpdate = true;
    this.washColumns.count = this.washRipples.count = nw;
    this.washColumns.instanceMatrix.needsUpdate = true;
    this.washRipples.instanceMatrix.needsUpdate = true;
    this.washTint.needsUpdate = true;
    this.shields.count = ns;
    this.shields.instanceMatrix.needsUpdate = true;
    this.shieldTint.needsUpdate = true;
    this.contrails.count = na;
    this.contrails.instanceMatrix.needsUpdate = true;
    this.ascentMarks.count = na;
    this.ascentMarks.instanceMatrix.needsUpdate = true;
    this.ascentTint.needsUpdate = true;
    this.cones.count = cones;
    this.cones.instanceMatrix.needsUpdate = true;
    this.coneTint.needsUpdate = true;
    this.coneAlpha.value = Math.max(fadeValue.surface * (focus === 'surface' || focus === 'sky' ? 0.22 : 0.08), 0);
    const lg = this.lines.geometry;
    lg.setDrawRange(0, this.seg * 2);
    this.lines.visible = this.seg > 0;
    (lg.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (lg.getAttribute('color') as BufferAttribute).needsUpdate = true;

    this.spires.frame(rt, t, this.motion?.matches ?? false, !this.snapshot);
  }
}
