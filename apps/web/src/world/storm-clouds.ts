/** The Sky's storms as toon hurricanes: opaque advecting 3D packets (eyewall, dense overcast, trailing spiral arms,
 * scalloping billows) and inflow wind trails fuse in one reduced-resolution target (the tier's `stormScale`); the full-resolution composite
 * quantises their light into cel bands, inks the fused silhouette and folds, and thins the island and aircraft
 * cutaways into wisps. Lightning is the inked bolt drawn after the storms (`aboveStorm`). One per World: each frame it
 * copies the active map's public cloud field, admitted
 * island clearance and visible aircraft openings (`sync`). The resolve filters cloud data, never scene depth or island
 * clearance. No noise texture, temporal history, readback, or per-frame allocation. */
import { Color, DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial, NoBlending, NodeUpdateType, PassNode, Scene, SphereGeometry, Vector3, Vector4, type Node, type PerspectiveCamera, type TextureNode, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, Loop, abs, atan, color, cos, dot, float, getViewPosition, instanceIndex, instancedBufferAttribute, mix, perspectiveDepthToViewZ, positionGeometry, positionView, positionWorld, screenSize, screenUV, sin, smoothstep, uniform, uniformArray, uv, varying, vec2, vec3, vec4, viewZToPerspectiveDepth } from 'three/tsl';
import { MOORING_DEPTH } from '@agent-command/game/contract';
import { FADE, fadeValue } from './fade.ts';
import { fogEdgeNoise } from './fog.ts';
import { CELL_CAP, CUTAWAY_CAP, UNIT_CAP, boltGeometry, islandClearance, streakGeometry, type WeatherLayer } from './weather.ts';
import { VIEW } from './palette.ts';
import { STORM_CLOUD, STORM_LIVE, clock, overlay, SUN, type F1, type V3 } from './materials.ts';
import { QUALITY } from './quality.ts';

/** Cutaway edge breakup in the fog edge's noise family (`fogEdgeNoise`): `wobble` (about −1..1) moves the boundary,
 * `grain` (0.1..0.9) is the threshold that dissolves its band into wisps. The field drifts slowly with storm time
 * (`motion`, still under reduced motion), so the rim breathes. Island (composite) and aircraft (pass) cutaways share it. */
function cutawayEdge(p: V3, time: F1): { wobble: F1; grain: F1 } {
  const drift = vec3(0, time.mul(0.12), time.mul(0.05));
  return {
    wobble: fogEdgeNoise(p.add(drift)).x as F1,
    grain: fogEdgeNoise(p.mul(3.3).add(drift.mul(2.5))).y.mul(0.4).add(0.5).clamp(0.1, 0.9) as F1,
  };
}
/** Cutaways never remove the storm whole: the grain leaves this much of it (cut threshold) at an opening's rim, as
 * blotches, so the storm still reads over the island or aircraft it reveals. Only right at the centre does the floor
 * fall toward a core floor, so the thing peeking through reads where the eye lands without hollowing the bank. */
const STORM_LEFT = 0.42;
/** Floor at an island's centre, and at an aircraft's: kept higher for aircraft so a crowded storm keeps its body. */
const ISLAND_CORE = 0.16, AIRCRAFT_CORE = 0.3;
/** Thins from the rim floor to `core` only over the innermost part of the opening (depth 0 centre, 1 edge). */
const coreFloor = (depth: F1, core: number, reach: number): F1 => mix(float(core), float(STORM_LEFT), smoothstep(0.05, reach, depth)) as F1;
/** The x-ray line drawn through that leftover storm along an island's or aircraft's scene ink. */
const XRAY = color('#e6eeff');

/** One storm's packets: [angle rad, radius, height, spin rad/s] and [length, half-height, width, pitch rad].
 * Radius, length and width are in storm radii; height is a share of HEIGHT; half-height is in world units. */
type Packet = readonly [number, number, number, number, number, number, number, number];
const ARMS = 3;
function hurricane(): Packet[] {
  const out: Packet[] = [];
  const ring = (n: number, phase: number, radius: number, height: number, spin: number, length: number, half: number, width: number) => {
    for (let i = 0; i < n; i++) out.push([(i + phase) / n * Math.PI * 2, radius, height, spin, length, half, width, 0]);
  };
  ring(8, 0, 0.2, 0.97, 0.34, 0.24, 1.8, 0.2); // eyewall
  ring(8, 0.5, 0.15, 1.02, 0.34, 0.11, 1.5, 0.11); // hot towers billowing round the eye
  ring(10, 0.31 / (Math.PI * 2) * 10, 0.45, 0.92, 0.22, 0.3, 1.45, 0.22); // dense overcast
  ring(14, 0, 0.61, 0.94, 0.22, 0.12, 1.1, 0.12); // overcast billows scallop its edge
  // Arms trail the counter-clockwise rotation: their angle falls as they reach outward, like the inflow trails.
  for (let arm = 0; arm < ARMS; arm++) for (let k = 0; k < 8; k++) {
    const a = k / 7, b = (k + 0.5) / 8, at = (t: number) => arm * Math.PI * 2 / ARMS + 0.9 - t * 2.3;
    out.push([at(a), 0.55 + 0.55 * a, 0.87 - 0.14 * a, 0.15, 0.42 - 0.18 * a, 1.2 - 0.5 * a, 0.2 - 0.08 * a, 0.3]);
    out.push([at(b), 0.72 + 0.49 * b, 0.89 - 0.14 * b, 0.15, 0.13 - 0.06 * b, 1 - 0.4 * b, 0.13 - 0.06 * b, 0]);
  }
  return out;
}
const LAYOUT = hurricane();
const PACKETS = LAYOUT.length;
const TRAILS = 9;
/** Illumination marker above the cel ramp (≤ ~0.9): wind highlights. */
const WIND_LIGHT = 3;
const HEIGHT = MOORING_DEPTH + 5.2;

/** The storm pass renders (at reduced resolution) only while a storm is drawn; with none it costs nothing. Its frame
 * registration is the build-time `updateBeforeType`, so skipping is decided per frame here. */
class StormPass extends PassNode {
  live = false;
  override getUpdateBeforeType(): NodeUpdateType {
    return this.live ? NodeUpdateType.FRAME : NodeUpdateType.NONE;
  }
}

export class StormClouds {
  readonly scene = new Scene();
  readonly pass: StormPass;
  readonly packets: InstancedMesh;
  readonly trails: InstancedMesh;
  /** Lightning, drawn by the ink overlay pass after the storms (`World` adds it to that scene). */
  readonly aboveStorm = new Group();
  readonly bolts: InstancedMesh;
  /** Whether a bolt strikes this frame (the ink overlay pass is skipped otherwise). */
  boltsShown = false;
  /** Openings around visible Sky aircraft (`WeatherLayer.units`). */
  readonly holes: InstancedMesh;
  /** Visible aircraft openings (world x, y, z, radius), the first `unitCount` live: placed by the holes, and the
   * composite keeps the fused silhouette's ink off their dissolving edge. */
  private readonly units = Array.from({ length: UNIT_CAP }, () => new Vector4());
  private readonly unitsNode = uniformArray<'vec4'>(this.units, 'vec4');
  private readonly unitCount = uniform(0, 'int');
  private readonly camera: PerspectiveCamera;
  private readonly centres = Array.from({ length: CELL_CAP }, () => new Vector4());
  private readonly states = Array.from({ length: CELL_CAP }, () => new Vector4());
  private readonly strikes = Array.from({ length: CELL_CAP }, () => new Vector4());
  private readonly islands = Array.from({ length: CUTAWAY_CAP }, () => new Vector4());
  private readonly islandAxes = Array.from({ length: CUTAWAY_CAP }, () => new Vector4(1, 1, 1, 0));
  private readonly islandCount = uniform(0, 'int');
  private readonly motion = uniform(1);
  private readonly active = uniform(0);
  private readonly eye = uniform(new Vector3());
  private readonly near = uniform(0.5);
  private readonly far = uniform(900);
  private readonly inverseProjection;
  private readonly cameraWorld;

  /** `resolutionScale`: the storm target's share of the drawing buffer's width and height (`Quality.stormScale`). */
  constructor(camera: PerspectiveCamera, resolutionScale = QUALITY.full.stormScale) {
    this.camera = camera;
    this.near.value = camera.near;
    this.far.value = camera.far;
    this.inverseProjection = uniform(camera.projectionMatrixInverse);
    this.cameraWorld = uniform(camera.matrixWorld);
    const centres = uniformArray<'vec4'>(this.centres, 'vec4');
    const states = uniformArray<'vec4'>(this.states, 'vec4');
    const cell = centres.element(instanceIndex.div(PACKETS).toInt());
    const state = varying(states.element(instanceIndex.div(PACKETS).toInt()));
    const centre = varying(cell);
    const time = clock.mul(this.motion);
    // Static per-instance layout, written once: every storm slot repeats the same hurricane.
    const placeData = new InstancedBufferAttribute(new Float32Array(CELL_CAP * PACKETS * 4), 4);
    const sizeData = new InstancedBufferAttribute(new Float32Array(CELL_CAP * PACKETS * 4), 4);
    for (let i = 0; i < placeData.count; i++) {
      const [angle, radius, height, spin, length, half, width, pitch] = LAYOUT[i % PACKETS]!;
      placeData.setXYZW(i, angle, radius, height, spin);
      sizeData.setXYZW(i, length, half, width, pitch);
    }
    const place = instancedBufferAttribute<'vec4'>(placeData, 'vec4');
    const size = instancedBufferAttribute<'vec4'>(sizeData, 'vec4');
    const opacity = varying(state.x);
    const seed = instanceIndex.mod(PACKETS).toFloat();
    const angle = place.x.add(time.mul(place.w)).add(state.z);
    const radial = place.y.add(sin(time.mul(0.18).add(seed.mul(1.7))).mul(0.015));
    const height = place.z;
    const pulse = sin(time.mul(0.22).add(seed.mul(0.9))).mul(0.03).add(1);
    const sx = size.x.mul(cell.w).mul(pulse), sy = size.y.mul(pulse), sz = size.z.mul(cell.w).mul(pulse);
    // Long axis on the tangent, turned by the arm's spiral pitch.
    const turn = angle.add(Math.PI / 2).add(size.w);
    const p = positionGeometry;
    const x = p.x.mul(sx).mul(cos(turn)).sub(p.z.mul(sz).mul(sin(turn)));
    const z = p.x.mul(sx).mul(sin(turn)).add(p.z.mul(sz).mul(cos(turn)));
    const normal = vec3(p.x.div(sx).mul(cos(turn)).sub(p.z.div(sz).mul(sin(turn))), p.y.div(sy),
      p.x.div(sx).mul(sin(turn)).add(p.z.div(sz).mul(cos(turn)))).normalize();
    const shade = varying(smoothstep(-0.35, 0.75, dot(normal, SUN)).mul(0.62).add(normal.y.max(0).mul(0.16)).add(height.mul(0.38)).sub(0.02));
    const material = new MeshBasicNodeMaterial();
    material.blending = NoBlending;
    material.positionNode = vec3(cell.x.add(cos(angle).mul(radial).mul(cell.w)).add(x), cell.y.add(height.mul(HEIGHT)).add(p.y.mul(sy)),
      cell.z.add(sin(angle).mul(radial).mul(cell.w)).add(z));
    // R=illumination, G=opacity, B=emission, A=linear view depth. The target is RGBA16F, not display colour.
    material.toneMapped = false;
    material.fragmentNode = Fn(() => {
      opacity.lessThan(0.005).discard();
      // Trailing spiral rain bands rotate through the whole fused mass, so circulation reads in a still frame.
      const d = positionWorld.xz.sub(centre.xz).div(centre.w);
      const band = sin(atan(d.y, d.x).mul(ARMS).add(d.length().mul(7.5)).sub(time.mul(0.45))).mul(0.5).add(0.5);
      return vec4(shade.sub(smoothstep(0.6, 0.85, band).mul(0.24)), opacity, state.y, positionView.z.negate());
    })();
    // The fused target keeps only the nearest packet, so a faint storm (forecast, forming) in front of a denser peer
    // would replace that peer's coverage and carve it away. Depth-sort fainter packets behind by their transparency
    // (world units): overlapping storms fuse into the denser one; the stored view depth (A) stays true.
    material.depthNode = viewZToPerspectiveDepth(positionView.z.sub(float(1).sub(opacity).mul(200)), this.near, this.far);
    this.packets = new InstancedMesh(new SphereGeometry(1, 12, 8), material, CELL_CAP * PACKETS);
    this.packets.name = 'fused-storm-packets';
    this.packets.frustumCulled = false;
    this.packets.count = 0;
    this.scene.add(this.packets);

    const trailIndex = instanceIndex.div(TRAILS).toInt();
    const trailSeed = instanceIndex.mod(TRAILS).toFloat();
    const tc = centres.element(trailIndex), ts = varying(states.element(trailIndex));
    const phase = time.mul(0.13).add(trailSeed.mul(0.173)).add(ts.z).fract();
    const travel = phase.sub(uv().x.mul(0.16));
    const radius = float(0.95).sub(travel.mul(0.6));
    const bearing = ts.z.add(trailSeed.mul(2.39996)).add(time.mul(0.36)).sub(uv().x.mul(0.45)).add(travel.mul(1.5));
    const taper = sin(uv().x.mul(Math.PI)).max(0);
    const envelope = varying(smoothstep(0, 0.14, phase).mul(float(1).sub(smoothstep(0.82, 1, phase))).mul(ts.x).mul(ts.w));
    const wind = new MeshBasicNodeMaterial({ side: DoubleSide });
    wind.forceSinglePass = true;
    wind.blending = NoBlending;
    wind.positionNode = vec3(tc.x.add(cos(bearing).mul(radius).mul(tc.w)),
      tc.y.add(HEIGHT).add(1.2).sub(travel.mul(0.9)).add(uv().y.sub(0.5).mul(taper).mul(envelope).mul(0.34)),
      tc.z.add(sin(bearing).mul(radius).mul(tc.w)));
    wind.toneMapped = false;
    wind.fragmentNode = Fn(() => {
      envelope.lessThan(0.01).discard();
      // Illumination above the cel ramp marks wind; it fades through its width, never through cloud opacity.
      return vec4(float(WIND_LIGHT), ts.x, ts.y, positionView.z.negate());
    })();
    this.trails = new InstancedMesh(streakGeometry(), wind, CELL_CAP * TRAILS);
    this.trails.name = 'fused-storm-wind';
    this.trails.frustumCulled = false;
    this.trails.count = 0;
    this.scene.add(this.trails);

    // Lightning: the inked bolt the Sky had before the storms fused, drawn after them over the crowns (no depth test,
    // as before): a thin jagged white-hot core in a violet halo that blooms, crawling across the overcast as a chord
    // through the public strike point. It strikes only on the painted (focused) Sky, never on its ghost page.
    const strikes = uniformArray<'vec4'>(this.strikes, 'vec4');
    const strike = strikes.element(instanceIndex), bc = centres.element(instanceIndex);
    const flash = varying(strike.w.mul(FADE.sky.focus));
    const bp = positionGeometry;
    const reach = bc.w.mul(0.65);
    const chord = strike.z.add(Math.PI / 2);
    const bx = bp.x.sub(0.45);
    const bolt = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    bolt.depthTest = false;
    bolt.positionNode = vec3(strike.x.add(bx.mul(cos(chord)).sub(bp.z.mul(sin(chord))).mul(reach)),
      bc.y.add(HEIGHT).add(1.6).add(bp.y.mul(2)),
      strike.y.add(bx.mul(sin(chord)).add(bp.z.mul(cos(chord))).mul(reach)));
    const across = abs(uv().y.sub(0.5)).mul(2);
    bolt.colorNode = mix(color('#9d8fff').mul(1.3), color('#ffffff').mul(3.5), float(1).sub(smoothstep(0.1, 0.4, across)));
    bolt.opacityNode = float(1).sub(smoothstep(0.5, 1, across)).mul(flash).mul(FADE.sky.alpha);
    this.bolts = new InstancedMesh(boltGeometry(5), bolt, CELL_CAP);
    this.bolts.name = 'storm-lightning';
    this.bolts.frustumCulled = false;
    this.bolts.count = 0;
    this.aboveStorm.add(this.bolts);
    // Visible aircraft open small gaps drawn last over every packet: a thinned core round the body (the grain keeps
    // `STORM_LEFT` of the cloud as blotches), then a band where it dithers back to full cloud in wisps. A texel is
    // cleared whole or kept untouched: the resolve's peak-normalised coverage stays exact.
    const unit = this.unitsNode.element(instanceIndex);
    const opening = varying(unit);
    const cut = new MeshBasicNodeMaterial();
    cut.blending = NoBlending;
    cut.depthTest = false;
    cut.toneMapped = false;
    cut.positionNode = unit.xyz.add(positionGeometry.mul(unit.w));
    cut.fragmentNode = Fn(() => {
      // Distance of the view ray from the aircraft, in opening radii.
      const ray = positionWorld.sub(this.eye).normalize();
      const delta = opening.xyz.sub(this.eye);
      const off = delta.sub(ray.mul(dot(delta, ray))).length().div(opening.w);
      const edge = cutawayEdge(positionWorld as V3, time as F1);
      smoothstep(0.45, 0.85, off.add(edge.wobble.mul(0.1))).max(coreFloor(off as F1, AIRCRAFT_CORE, 0.3)).greaterThan(edge.grain).discard();
      return vec4(0, 0, 0, 1);
    })();
    this.holes = new InstancedMesh(new SphereGeometry(1, 10, 6), cut, UNIT_CAP);
    this.holes.name = 'fused-storm-aircraft-openings';
    this.holes.frustumCulled = false;
    this.holes.renderOrder = 2;
    this.holes.count = 0;
    this.scene.add(this.holes);
    // An opaque colour background clears RGB to 0 and alpha (depth) to 1: the resolve unmixes depth accordingly.
    this.scene.background = new Color(0);
    this.pass = new StormPass(PassNode.COLOR, this.scene, camera, { samples: 0 });
    this.pass.setResolutionScale(resolutionScale);
    STORM_CLOUD.value = this.pass.getTexture('output');
  }

  /** Copy the active map's public storm field, admitted island clearance and visible aircraft openings; call after its
   * Sky layer's frame. */
  sync(layer: WeatherLayer): void {
    const field = layer.cloudField;
    const count = fadeValue.sky > 0.02 ? field.count : 0;
    for (let i = 0; i < count; i++) {
      this.centres[i]!.copy(field.centres[i]!);
      this.states[i]!.copy(field.states[i]!);
      this.strikes[i]!.copy(field.strikes[i]!);
    }
    const islands = layer.islandCount.value;
    for (let i = 0; i < islands; i++) {
      this.islands[i]!.copy(layer.islands[i]!);
      this.islandAxes[i]!.copy(layer.islandAxes[i]!);
    }
    this.islandCount.value = islands;
    this.motion.value = field.motion;
    this.packets.count = count * PACKETS;
    this.trails.count = count * TRAILS;
    this.bolts.count = count;
    let striking = false;
    for (let i = 0; i < count; i++) striking ||= this.strikes[i]!.w * FADE.sky.focus.value > 0.02;
    this.boltsShown = striking;
    const units = count ? layer.unitCount : 0;
    for (let i = 0; i < units; i++) this.units[i]!.copy(layer.units[i]!);
    this.unitCount.value = units;
    this.holes.count = units;
    this.active.value = count;
    this.pass.live = count > 0;
    STORM_LIVE.value = this.pass.live ? 1 : 0;
    this.camera.getWorldPosition(this.eye.value);
    this.near.value = this.camera.near;
    this.far.value = this.camera.far;
  }

  /** Compile the pass's cloud programs against its own target before a storm first appears. Only while no frame
   * renders: instance counts are borrowed and restored to empty (the next `sync` refills them). */
  async compile(renderer: WebGPURenderer): Promise<void> {
    const meshes = [this.packets, this.trails, this.holes];
    for (const mesh of meshes) mesh.count = 1;
    const target = renderer.getRenderTarget(), mrt = renderer.getMRT();
    renderer.setRenderTarget(this.pass.renderTarget);
    renderer.setMRT(null);
    try {
      await renderer.compileAsync(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(target);
      renderer.setMRT(mrt);
      for (const mesh of meshes) mesh.count = 0;
    }
  }

  /** Nine fused cloud taps, each tested against the original full-resolution scene depth. The target clears RGB to
   * zero and each storm writes one opacity, so the neighbourhood peak recovers smooth bilinear coverage (every colour
   * premultiplied by it); faint forecasts keep the same crisp inked silhouette. Clearance is applied after
   * filtering: an island-following thinning whose wobbled edge dissolves into uninked wisps. `inkEdge` is the ink
   * pass's scene line strength: inside island and aircraft cutaways it draws their outline through the storm. */
  composite(base: V3, sceneDepth: TextureNode, inkEdge: F1): V3 {
    const cloud = this.pass.getTextureNode('output');
    const islands = uniformArray<'vec4'>(this.islands, 'vec4'), axes = uniformArray<'vec4'>(this.islandAxes, 'vec4');
    return Fn(() => {
      const result = base.toVar();
      If(this.active.greaterThan(0), () => {
        const taps: Node<'vec4'>[] = [];
        const peak = float(0).toVar();
        for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
          const sample = cloud.sample(screenUV.add(vec2(x, y).mul(3).div(screenSize))).toVar();
          taps.push(sample);
          peak.assign(peak.max(sample.g));
        }
        If(peak.greaterThan(0.001), () => {
          const sceneDepthSample = sceneDepth.sample(screenUV).r;
          const solidDepth = perspectiveDepthToViewZ(sceneDepthSample, this.near, this.far).negate();
          const shape = float(0).toVar(), light = float(0).toVar(), emission = float(0).toVar();
          const front = this.far.toVar();
          const depths: F1[] = [];
          for (let i = 0; i < taps.length; i++) {
            const sample = taps[i]!, x = i % 3 - 1, y = Math.floor(i / 3) - 1;
            const cover = sample.g.div(peak);
            // Bilinear coverage mixes each texel with the clear (0, 0, 0, 1): depth = (a − (1 − cover)) / cover.
            const depth = sample.a.sub(float(1).sub(cover)).div(cover.max(1e-4));
            const admitted = cover.greaterThan(0.002).and(depth.lessThan(solidDepth.sub(0.01)));
            const weight = admitted.select(float((x === 0 ? 2 : 1) * (y === 0 ? 2 : 1) / 16), float(0));
            shape.addAssign(cover.mul(weight));
            light.addAssign(sample.r.min(WIND_LIGHT).mul(weight));
            emission.addAssign(sample.b.mul(weight));
            front.assign(front.min(admitted.select(depth, this.far)));
            depths.push(admitted.and(cover.greaterThan(0.9)).select(depth, float(0)));
          }
          If(shape.greaterThan(0.002), () => {
            const depth = viewZToPerspectiveDepth(front.negate(), this.near, this.far);
            const view = getViewPosition(screenUV, depth, this.inverseProjection);
            const point = this.cameraWorld.mul(vec4(view, 1)).xyz as V3;
            // The fog edge's wobble moves the boundary (±0.2 ellipsoid radii, never into the island's own extent) and its
            // grain dissolves a half-radius band into wisps, so no clean ring and no ink round the opening. The storm is
            // never cut away whole: inside, the same grain leaves blotches of cloud (`STORM_LEFT`).
            const edge = cutawayEdge(point, clock.mul(this.motion) as F1);
            const opening = islandClearance(islands, axes, this.islandCount, point, this.eye as V3, edge.wobble.mul(0.2) as F1, 0.5);
            const cut = smoothstep(edge.grain.sub(0.15), edge.grain.add(0.15), opening.max(coreFloor(opening as F1, ISLAND_CORE, 0.4)));
            // A flash lifts the whole bank up the same cel ramp rather than washing it flat; only on the painted Sky.
            const focus = FADE.sky.focus;
            const flash = emission.div(shape).mul(focus);
            const lum = light.div(shape).add(flash.mul(0.06));
            const strength = peak.mul(FADE.sky.alpha).clamp(0, 1);
            // Cel ramp: storm shadow, slate body, cool lit tops, wind highlights. Darker and bluer than the white deck.
            const cel = mix(color('#232c45'), color('#3f4d6c'), smoothstep(0.34, 0.37, lum)).toVar();
            cel.assign(mix(cel, color('#6f82a6'), smoothstep(0.58, 0.61, lum)));
            cel.assign(mix(cel, color('#c4d2ea'), smoothstep(1.0, 1.06, lum)));
            const painted = cel.add(color('#5a64c8').mul(flash.mul(0.12)));
            // Ghosted Sky (viewed from Orbit, or mid-dive): the same construction-pencil sketch on the viewed paper as
            // every other Sky material (`finish`), with ghost-pencil ink at the ink pass's ghost weight.
            const band = smoothstep(0.3, 0.5, lum).add(smoothstep(0.6, 0.8, lum)).mul(0.5);
            const ghost = mix(VIEW.paper, VIEW.ghostPencil, float(1).sub(band).mul(0.2).add(0.07));
            const paint = mix(ghost, painted, focus);
            const line = mix(VIEW.ghostPencil, VIEW.line, focus);
            // Hard cel silhouette from the fused shape; ink on its outer edge and where banks overlap, not round cutaways.
            const body = smoothstep(0.46, 0.54, shape).mul(strength);
            const silhouette = smoothstep(0.2, 0.3, shape).mul(float(1).sub(smoothstep(0.46, 0.52, shape)));
            // Aircraft gaps are carved in the pass, so their edge reads as silhouette: keep it uninked like the island's.
            // X-ray: a scene line on an admitted island or aircraft (the scene point inside its clearance) draws light
            // through the storm left over it. Only silhouette and scene-line pixels walk the openings.
            const unitInk = float(1).toVar(), xray = float(0).toVar();
            If(silhouette.greaterThan(0.001).or(inkEdge.greaterThan(0.02)), () => {
              const ray = point.sub(this.eye).normalize();
              const scene = this.cameraWorld.mul(vec4(getViewPosition(screenUV, sceneDepthSample, this.inverseProjection), 1)).xyz as V3;
              Loop(this.unitCount, ({ i }) => {
                const u = this.unitsNode.element(i);
                const delta = u.xyz.sub(this.eye);
                unitInk.assign(unitInk.min(smoothstep(1, 1.5, delta.sub(ray.mul(dot(delta, ray))).length().div(u.w))));
                xray.assign(xray.max(float(1).sub(smoothstep(0.9, 1.2, u.xyz.sub(scene).length().div(u.w)))));
              });
              If(inkEdge.greaterThan(0.02), () => {
                xray.assign(xray.max(float(1).sub(islandClearance(islands, axes, this.islandCount, scene, this.eye as V3))));
              });
            });
            const [z0, zl, zr, zu, zd] = [depths[4]!, depths[3]!, depths[5]!, depths[1]!, depths[7]!];
            const solid = z0.greaterThan(0).and(zl.greaterThan(0)).and(zr.greaterThan(0)).and(zu.greaterThan(0)).and(zd.greaterThan(0));
            const fold = solid.select(smoothstep(0.012, 0.03, zl.add(zr).sub(z0.mul(2)).abs().add(zu.add(zd).sub(z0.mul(2)).abs()).div(z0)), float(0));
            const weight = mix(float(0.42), float(1), focus);
            const ink = VIEW.lineK.mul(strength).mul(weight);
            result.assign(mix(result, line, silhouette.mul(cut).mul(unitInk).mul(ink)));
            const cloudLeft = body.mul(cut);
            result.assign(mix(result, mix(paint, line, fold.mul(0.75).mul(weight)), cloudLeft));
            result.assign(mix(result, XRAY, inkEdge.clamp(0, 1).mul(xray).mul(cloudLeft).mul(0.9)));
          });
        });
      });
      return result;
    })() as V3;
  }

  dispose(): void {
    this.pass.dispose();
    for (const mesh of [this.packets, this.trails, this.bolts, this.holes]) {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicNodeMaterial).dispose();
      mesh.dispose();
    }
    this.scene.clear();
  }
}
