/**
 * Spire rendering: one faceted crystal segment per army per plane, plus the connectors between planes. Locations are
 * public landmarks; health comes only from this view's own/visible segments or fog-filtered deaths.
 */
import { BufferGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, Object3D, PlaneGeometry, type UniformNode } from 'three/webgpu';
import { abs, attribute, cameraPosition, color, cos, dot, float, floor, fract, max, mix, modelWorldMatrix, normalWorld, positionLocal, positionView, positionWorld, reflect, smoothstep, step, uniform, vec3, vec4 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARMIES, DEFAULT_RULES, PLANES, PLANE_Y, VISION_BITS_PER_WORD, spirePositions, type ArmyId, type Colour, type Plane, type View } from '@agent-command/game/contract';
import { SIDE_COLOR, clamp, wx, wz } from './common.ts';
import { fadeValue, FADE } from './fade.ts';
import { SUN, aboveStorm, inkMaterial, type V3 } from './materials.ts';
import { INK } from './palette.ts';
import type { FogField } from './fog.ts';
import { PLANE_ACCENT } from '../dom.ts';
import type { TerrainField } from './terrain.ts';
import { spireGem } from './models.ts';

/** Bucket slots of the four armies and planes (`Spires.ingest`). */
const ARMY_SLOT = Object.fromEntries(ARMIES.map((a, i) => [a, i])) as Record<ArmyId, number>;
const PLANE_SLOT = Object.fromEntries(PLANES.map((p, i) => [p, i])) as Record<Plane, number>;

/** One crystal scale on every plane; nominal muzzle centre and picking extent include the gentle bob. */
export const SPIRE_HEIGHT: Record<Plane, number> = { depths: 2.5, surface: 2.5, sky: 2.5, orbit: 2.5 };
export const SPIRE_SPAN: Record<Plane, readonly [number, number]> = { depths: [0, 4.8], surface: [0, 4.8], sky: [0, 4.8], orbit: [0, 4.8] };

/** Seat Surface objectives on their terrain support, matching unit, muzzle and picking coordinates. */
export function spireBaseY(plane: Plane, x: number, y: number, terrain?: TerrainField): number {
  return PLANE_Y[plane] + (plane === 'surface' && terrain ? terrain.groundAt(x, y) : 0);
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!geometry) throw new Error('Incompatible Spire geometry');
  return geometry;
}

/** Three studio keys on the horizon: the sun's azimuth and two turned by 120°. A tall gem mirrors the horizon from the
 * RTS pitch, and a single world key would leave every facet dark whenever the sun sits behind the crystal. Following
 * SUN keeps them turning with each army's camera frame. */
function horizonKey(turn: number) {
  const c = Math.cos(turn), s = Math.sin(turn);
  return vec3(SUN.x.mul(c).sub(SUN.z.mul(s)), 0.08, SUN.x.mul(s).add(SUN.z.mul(c))).normalize();
}

type SegmentState = { health: UniformNode<'float'>; knowledge: UniformNode<'float'>; flash: UniformNode<'float'> };

/** Read from the drawn crystal's own segment: every army's crystal on a plane shares one material and program. */
const crystalState = new WeakMap<Object3D, SegmentState>();
const segmentValue = (key: keyof SegmentState) => uniform(0).onObjectUpdate(({ object }) => crystalState.get(object!)?.[key].value);

/**
 * Cut-gem toon reflection, after the solar glass: the key light reflected about each flat facet normal. A facet
 * flashes whole as its mirror angle crosses a toon threshold, staggered per facet so turning the camera (or the
 * crystal's slow spin) walks the flash from face to face instead of sliding stripes across the surface. A faint
 * thin-film spectrum keyed to facet and view angle tints the plane colour; no clock, so reduced motion stays static.
 */
function crystalMaterial(plane: Plane, fog: FogField | undefined): MeshBasicNodeMaterial {
  const health = segmentValue('health'), knowledge = segmentValue('knowledge'), flash = segmentValue('flash');
  const nw = normalWorld.normalize();
  // View to the crystal's centre, not per fragment: mirror angle, toon step and flash are then one value per facet,
  // so a facet flashes whole and no step edge can cross a face.
  const view = cameraPosition.sub(modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz).normalize();
  const mirror = reflect(view.negate(), nw);
  const glint = max(max(dot(mirror, horizonKey(0)), dot(mirror, horizonKey(2.094)).mul(0.92)), max(dot(mirror, horizonKey(4.189)).mul(0.86), dot(mirror, SUN)));
  // Facet identity is a per-face attribute baked into the cut-gem geometry (`spireGem`): every face of a facet shares
  // one value, so the toon steps and cracks pick whole facets with no interpolation speckle.
  const facet = attribute<'float'>('facet', 'float');
  const facing = abs(dot(view, nw));
  const film = float(1).sub(facing);
  const spectrum = cos(vec3(0, 2.094, 4.189).add(dot(mirror, vec3(0.35, 1.2, 0.45)).mul(2.6).add(facet.mul(3.1)).add(film.mul(2.4)))).mul(0.5).add(0.5);
  const lit = knowledge.mul(health.mul(0.65).add(0.35));
  // Toon steps of the mirror angle, offset per facet: neighbouring faces sit on different steps and swap as the view
  // turns, so the gem reads cut and angular. The brightest step is the flash itself.
  const angle = glint.mul(0.5).add(0.5);
  const steps = floor(angle.mul(3).add(facet.mul(0.9))).div(3).clamp(0, 1);
  const threshold = facet.mul(0.1).add(0.86);
  const toon = smoothstep(threshold, threshold.add(0.03), glint).mul(lit);
  const pigment = color(PLANE_ACCENT[plane]);
  const glass = mix(pigment, mix(pigment, spectrum, 0.7), film.mul(0.45).add(0.22).mul(knowledge));
  // A flash is the plane's own colour lifted toward white, spectrally edged: never a cream panel replacing the hue.
  const sparkle = mix(mix(pigment, color('#fbf6e8'), 0.55), spectrum, 0.3);
  // Damage cracks whole facets dark (and stops them catching light), never a painted pattern across faces.
  const cracked = step(facet, float(1).sub(health).mul(0.6)).mul(knowledge);
  // Facets approaching their mirror angle warm through the thin-film colour before they flash: the iridescence moves
  // from face to face with the view, ahead of the white-lifted flash itself.
  const halo = smoothstep(threshold.sub(0.4), threshold, glint).mul(lit);
  const fire = mix(pigment, spectrum, 0.65).mul(1.2);
  let paint = mix(mix(color('#99939b'), glass, knowledge), fire, halo.mul(0.5));
  paint = mix(paint, sparkle, max(toon.mul(0.7), steps.mul(0.25).mul(lit)).mul(float(1).sub(cracked)));
  paint = mix(paint, color(INK[plane]), cracked.mul(0.4));
  paint = mix(paint, color('#fbf6e8'), flash);
  const glow = sparkle.mul(toon.mul(0.35)).mul(float(1).sub(cracked)) as unknown as V3;
  return inkMaterial(plane, paint as unknown as V3, { glow, fog: plane === 'depths', fogField: fog });
}

/** Public landmark locations, but health only from this view's own/visible segments or fog-filtered deaths. */
export class Spires {
  /** Object3D, not Group: a Group would reset the entity root's groupOrder (40) to 0 and let veils paint over the
   * connectors. Segment bodies stay Groups at 45, after every plane layer, so opaque crystals keep their depth. */
  readonly root = new Object3D();
  /** The connectors between planes, drawn after the Sky's storms (`aboveStorm`): a beam rising past a storm stays on
   * top of it wherever no cloud lies in front. */
  readonly aboveStorm = new Object3D();
  /** Whether a connector draws this frame (the ink overlay pass is skipped otherwise). */
  connectorsShown = false;
  readonly shaderTemplates: Mesh[] = [];
  private readonly motion = uniform(0);
  private motionTime = 0;
  private lastMotionTime: number | undefined;
  private readonly size: number;
  private readonly listedOnly: boolean;
  private readonly terrain: TerrainField | undefined;
  /** Per-snapshot (army × plane) buckets, allocated once (`ingest`). */
  private readonly slots = {
    entities: new Array<View['entities'][number] | undefined>(ARMIES.length * PLANES.length),
    own: new Array<View['spire'][number] | undefined>(ARMIES.length * PLANES.length),
    deaths: new Array<View['fx'][number] | undefined>(ARMIES.length * PLANES.length),
    remembered: new Uint8Array(ARMIES.length * PLANES.length),
  };
  private readonly armies = ARMIES.map(army => ({
    army, phase: ARMIES.indexOf(army) * 0.8, present: false, x: 0, y: 0, tint: uniform(SIDE_COLOR.neutral),
    segments: PLANES.map(plane => ({ plane, hp: 1, shown: 1, tick: -1, observedTick: -1, hitTick: -Infinity, visible: false, known: false,
      health: uniform(1), knowledge: uniform(0), flash: uniform(0), body: new Group(), core: undefined as Mesh | undefined, casing: undefined as Mesh | undefined })),
    links: [] as Mesh[],
  }));

  constructor(size: number, listedOnly: boolean, fog?: FogField, terrain?: TerrainField) {
    this.size = size;
    this.listedOnly = listedOnly;
    this.terrain = terrain;
    // Two crossed strokes, not a closed tube: no camera can enter an enclosing wall. Depth testing stays enabled.
    const strokes = merged([new PlaneGeometry(0.12, 1), new PlaneGeometry(0.12, 1).rotateY(Math.PI / 2)]);
    const crystalGeometry = spireGem();
    const coreMaterials: Partial<Record<Plane, MeshBasicNodeMaterial>> = {};
    for (const army of this.armies) {
      for (const segment of army.segments) {
        const { plane, health, body } = segment;
        body.name = `spire-${army.army}-${plane}`;
        const height = SPIRE_HEIGHT[plane];
        const core = new Mesh(crystalGeometry, coreMaterials[plane] ??= crystalMaterial(plane, fog));
        crystalState.set(core, segment);
        core.position.y = height;
        core.name = `${body.name}-core`;
        // Ownership belongs to the low plinth and connector, never to the plane-coloured crystal.
        // Only the functional ore landing needs a narrower base; all four crystals remain identical.
        const radius = plane === 'depths' ? 0.7 : 1.2;
        const casing = new Mesh(new CylinderGeometry(radius * 0.9, radius, 0.22, 8).translate(0, 0.11, 0),
          inkMaterial(plane, mix(color('#3d4149'), army.tint, smoothstep(0.08, 0.1, positionLocal.y).mul(health.mul(0.55).add(0.1))) as unknown as V3,
            { fog: plane === 'depths', fogField: fog }));
        casing.name = `${body.name}-casing`;
        body.position.y = PLANE_Y[plane];
        body.add(casing, core);
        body.renderOrder = 45;
        segment.core = core; segment.casing = casing;
        this.root.add(body);
        this.shaderTemplates.push(core, casing);
      }
      for (let i = 0; i < PLANES.length - 1; i++) {
        const lower = PLANES[i]!, upper = PLANES[i + 1]!;
        const bottom = PLANE_Y[lower] + SPIRE_SPAN[lower][1] + 0.3;
        const top = PLANE_Y[upper] - 0.35;
        const material = aboveStorm(new MeshBasicNodeMaterial({ side: DoubleSide }));
        material.forceSinglePass = true;
        const near = smoothstep(2, 7, positionView.z.negate()).mul(smoothstep(0.7, 2.2, positionWorld.sub(cameraPosition).length()));
        const dash = smoothstep(0.12, 0.22, fract(positionWorld.y.mul(0.55).sub(this.motion))).mul(0.34);
        material.colorNode = army.tint;
        material.opacityNode = dash.mul(near).mul(smoothstep(0, 0.06, float(0.5).sub(abs(positionLocal.y)))).mul(FADE[lower].alpha.max(FADE[upper].alpha));
        const link = new Mesh(strokes, material);
        link.name = `spire-${army.army}-${lower}-link`;
        link.position.y = (bottom + top) / 2;
        link.scale.y = top - bottom;
        link.renderOrder = 46;
        army.links.push(link);
        this.aboveStorm.add(link);
        this.shaderTemplates.push(link);
      }
    }
    this.reset();
  }

  place(armies: readonly { id: ArmyId; colour: Colour; spireAt: { x: number; y: number } }[]): void {
    for (const s of this.armies) {
      const army = armies.find(a => a.id === s.army);
      s.present = !!army;
      if (army) {
        s.tint.value = SIDE_COLOR[army.colour]; s.x = army.spireAt.x; s.y = army.spireAt.y;
      }
      for (const segment of s.segments) {
        segment.body.position.x = wx(s.x, this.size); segment.body.position.z = wz(s.y, this.size);
        segment.body.visible = s.present;
      }
      for (const link of s.links) {
        link.position.x = wx(s.x, this.size); link.position.z = wz(s.y, this.size); link.visible = s.present && !this.listedOnly;
      }
    }
  }

  reset(): void {
    this.motionTime = this.motion.value = 0;
    this.lastMotionTime = undefined;
    for (const s of this.armies) for (const segment of s.segments) {
      segment.hp = segment.shown = segment.health.value = 1;
      segment.tick = segment.observedTick = -1; segment.hitTick = -Infinity; segment.flash.value = segment.knowledge.value = 0;
      segment.visible = segment.known = false;
      segment.core!.visible = true; segment.casing!.scale.y = 1;
      segment.core!.position.y = SPIRE_HEIGHT[segment.plane] + Math.sin(s.phase) * 0.07;
      segment.core!.rotation.y = s.phase;
    }
    const sites = spirePositions(DEFAULT_RULES.map.spireInset, this.size);
    this.place([{ id: 'nw', colour: 'blue', spireAt: sites.nw }, { id: 'se', colour: 'red', spireAt: sites.se }]);
  }

  ingest(view: View): void {
    // One pass over the view buckets every Spire record, remembered Spire and Spire death by (army, plane) slot.
    const { entities: byEntity, own: byOwn, deaths: byDeath, remembered } = this.slots;
    byEntity.fill(undefined); byOwn.fill(undefined); byDeath.fill(undefined); remembered.fill(0);
    for (const e of view.entities) {
      const a = e.kind === 'spire' ? ARMY_SLOT[e.side as ArmyId] : undefined;
      if (a !== undefined) byEntity[a * PLANES.length + PLANE_SLOT[e.plane]] ??= e;
    }
    for (const e of view.memory) {
      const a = e.kind === 'spire' ? ARMY_SLOT[e.side as ArmyId] : undefined;
      if (a !== undefined) remembered[a * PLANES.length + PLANE_SLOT[e.plane]] = 1;
    }
    const mine = ARMY_SLOT[view.army as ArmyId];
    if (mine !== undefined) for (const g of view.spire) byOwn[mine * PLANES.length + PLANE_SLOT[g.plane]] ??= g;
    for (const f of view.fx) {
      if (f.kind !== 'death' || f.subject !== 'spire') continue;
      for (let a = 0; a < this.armies.length; a++) {
        const s = this.armies[a]!;
        if (Math.abs(f.x - s.x) >= 0.01 || Math.abs(f.y - s.y) >= 0.01) continue;
        const slot = a * PLANES.length + PLANE_SLOT[f.plane];
        if (!byDeath[slot] && f.tick >= s.segments[PLANE_SLOT[f.plane]]!.observedTick) byDeath[slot] = f;
      }
    }
    for (let a = 0; a < this.armies.length; a++) {
      const s = this.armies[a]!;
      if (!s.present) continue;
      const eliminated = view.eliminated.includes(s.army);
      const cell = Math.floor(s.y) * this.size + Math.floor(s.x);
      for (let p = 0; p < s.segments.length; p++) {
        const segment = s.segments[p]!;
        const plane = segment.plane;
        const slot = a * PLANES.length + p;
        const own = s.army === view.army;
        const entity = byEntity[slot];
        const visible = own || !!entity || !!((view.vision[plane][Math.floor(cell / VISION_BITS_PER_WORD)] ?? 0) & (1 << (cell % VISION_BITS_PER_WORD)));
        const death = byDeath[slot];
        const record = own ? byOwn[slot] : entity;
        const hp = eliminated ? 0 : record ? clamp(record.hp / record.maxHp, 0, 1) : death || visible ? 0 : segment.hp;
        if (hp !== segment.hp) {
          if (hp < segment.hp && segment.visible && visible) segment.hitTick = view.tick;
          segment.hp = hp; segment.tick = hp === 0 && death ? death.tick : view.tick;
        }
        // Reacquiring sight must not replay damage suffered under fog.
        if (!visible) segment.hitTick = -Infinity;
        segment.visible = visible;
        if (visible) segment.observedTick = view.tick;
        segment.known ||= visible || remembered[slot] === 1;
        if (segment.tick < 0) segment.shown = hp;
      }
    }
  }

  frame(renderTick: number, t: number, reducedMotion: boolean, lobby: boolean): void {
    if (this.lastMotionTime !== undefined && !reducedMotion) this.motionTime += Math.min(0.1, Math.max(0, t - this.lastMotionTime));
    this.lastMotionTime = t;
    this.motion.value = this.motionTime * 0.22;
    let shown = false;
    for (const s of this.armies) {
      for (const segment of s.segments) {
        segment.body.position.y = spireBaseY(segment.plane, s.x, s.y, this.terrain);
        if (renderTick >= segment.tick) segment.shown = segment.hp;
        const alive = segment.shown > 0;
        segment.health.value = segment.shown;
        segment.knowledge.value = lobby || segment.visible ? 1 : 0;
        const age = renderTick - segment.hitTick;
        segment.flash.value = !reducedMotion && segment.visible && age >= 0 && age < 5 ? (1 - age / 5) * 0.65 : 0;
        segment.core!.visible = alive;
        segment.core!.position.y = SPIRE_HEIGHT[segment.plane] + Math.sin(this.motionTime * 0.85 + s.phase) * 0.07;
        segment.core!.rotation.y = s.phase + this.motionTime * 0.14;
        segment.casing!.scale.y = alive ? 1 : 0.24;
        segment.body.visible = s.present && fadeValue[segment.plane] > 0.03 &&
          (lobby || (segment.plane === 'depths' ? segment.known : !this.listedOnly || segment.visible));
      }
      for (let i = 0; i < s.links.length; i++) {
        const a = s.segments[i]!, b = s.segments[i + 1]!;
        const bottom = a.body.position.y + SPIRE_SPAN[a.plane][1] + 0.3;
        const top = b.body.position.y - 0.35;
        s.links[i]!.position.y = (bottom + top) / 2;
        s.links[i]!.scale.y = top - bottom;
        s.links[i]!.visible = s.present && !this.listedOnly && a.shown > 0 && b.shown > 0 &&
          (lobby || i !== 0 || a.known) && Math.max(fadeValue[a.plane], fadeValue[b.plane]) > 0.03;
        shown ||= s.links[i]!.visible;
      }
    }
    this.connectorsShown = shown;
  }

  /** World bundles retain these fixed draws across resets; explicit teardown releases each shared geometry once. */
  dispose(): void {
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<MeshBasicNodeMaterial>();
    for (const mesh of this.shaderTemplates) { geometries.add(mesh.geometry); materials.add(mesh.material as MeshBasicNodeMaterial); }
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    this.root.clear();
    this.aboveStorm.clear();
  }
}
