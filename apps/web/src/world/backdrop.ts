/**
 * Distant Field Journal scenery, never terrain: one opaque, unlit dome behind the entire stack and one instanced
 * Orbit starfield draw with three size tiers. No match/fog/entity inputs, clocks, textures, lights or per-frame geometry updates.
 */
import { BackSide, Group, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, PointsNodeMaterial, SphereGeometry, Sprite } from 'three/webgpu';
import { abs, color, float, Fn, If, instancedBufferAttribute, mix, mx_noise_float, normalize, positionLocal, screenUV, sin, smoothstep, vec3 } from 'three/tsl';
import { FADE, focusValue } from './fade.ts';
import { hash2 } from './common.ts';
import { NO_LINES, overlay } from './materials.ts';
import { VIEW } from './palette.ts';

/** Shared immutable geometry: world-size bundles reuse it; the enclosing sphere stays inside CameraRig's far clip. */
const domeGeometry = new SphereGeometry(600, 32, 16);

function distantPaint() {
  return Fn(() => {
    const paper = mix(VIEW.bgBottom, VIEW.bgTop, screenUV.y.oneMinus().pow(0.8));
    const painted = paper.toVar();
    // Sampling a direction, rather than UVs, has neither a longitude seam nor a polar pinch. The fixed dome allows
    // gentle perspective parallax on pan/zoom without chasing the camera or animating the landscape in reduced motion.
    const d = normalize(positionLocal).toVar();
    const broad = mx_noise_float(d.mul(4.1).add(vec3(7.2, 1.9, 3.4))).toVar();
    const detail = mx_noise_float(d.mul(11.7).add(vec3(2.3, 8.1, 5.6))).toVar();
    const relief = broad.mul(0.72).add(detail.mul(0.16)).toVar();

    If(FADE.depths.focus.greaterThan(0), () => {
      // A geological section continuing into darkness: thick folded strata, no tunnel/ore-shaped markings.
      const fold = d.y.mul(9).add(d.x.mul(1.6)).add(relief.mul(1.8));
      const beds = sin(fold).mul(0.5).add(0.5);
      const seam = smoothstep(0.72, 0.83, beds).mul(0.12);
      const stone = mix(color('#191923'), color('#48404b'), smoothstep(0.22, 0.72, beds));
      const cavern = smoothstep(-0.32, 0.4, relief.add(d.y.mul(0.22)));
      const strata = mix(stone, color('#171720'), cavern.mul(0.65)).add(color('#8b7566').mul(seam));
      painted.assign(mix(painted, strata, FADE.depths.focus.mul(0.76)));
    });
    If(FADE.surface.focus.greaterThan(0), () => {
      // Large, desaturated ridge shoulders seen through warm haze. Unlike the board there are no cells, trees,
      // plateaux, hard outlines or reachable ledges. Three tonal terraces describe distance, not extra play space.
      const ridge = d.y.add(relief.mul(0.8)).add(d.z.mul(0.18));
      const far = smoothstep(-0.58, -0.49, ridge);
      const middle = smoothstep(-0.78, -0.69, ridge);
      const near = smoothstep(-0.95, -0.86, ridge);
      const terrain = mix(color('#aaa99b'), color('#c2c3ad'), near);
      const hills = mix(mix(terrain, color('#d2cfbb'), middle), color('#e7dcc5'), far);
      painted.assign(mix(painted, hills, FADE.surface.focus.mul(0.85)));
    });
    If(FADE.sky.focus.greaterThan(0), () => {
      // Broad pearl-and-blue cloud shelves, not repeated puff meshes or a second weather simulation.
      const shelf = relief.add(d.y.mul(0.16));
      const shade = smoothstep(-0.32, -0.04, shelf);
      const crown = smoothstep(0.03, 0.16, shelf);
      const clouds = mix(mix(color('#aebfd0'), color('#d7e1e6'), shade), color('#f1f2e7'), crown);
      painted.assign(mix(painted, clouds, FADE.sky.focus.mul(0.83)));
    });
    If(FADE.orbit.focus.greaterThan(0), () => {
      // One broken diagonal pigment veil: lower contrast than stars, never emissive or time-modulated.
      const lane = abs(d.x.mul(0.66).sub(d.z.mul(0.47)).add(d.y.mul(0.12)).add(relief.mul(0.24)));
      const haze = float(1).sub(smoothstep(0.07, 0.39, lane));
      const dust = smoothstep(-0.4, 0.42, broad).mul(haze);
      const tint = mix(color('#353b65'), color('#66516d'), smoothstep(-0.1, 0.35, detail));
      painted.assign(mix(painted, tint, dust.mul(0.43).mul(FADE.orbit.focus)));
    });
    return painted;
  })();
}

/** Star tiers as {count, pixel size, inner radius, brightness, hash seed}; drawn larger/brighter nearer the camera. */
const TIERS = [[1600, 0.9, 530, 0.25, 31], [360, 1.5, 460, 0.5, 41], [48, 2.2, 390, 0.78, 51]] as const;

/** WebGPU (and three's WebGL fallback for `Points`) rasterises point primitives at exactly 1px, so every tier is an
 * instanced screen-space quad with a per-star size attribute: one draw, one immutable upload, no clock. */
function stars(): Sprite {
  let count = 0;
  for (const [n] of TIERS) count += n;
  const positions = new Float32Array(count * 3);
  const colours = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  let i = 0;
  for (const [n, size, radius, brightness, seed] of TIERS) for (let j = 0; j < n; j++, i++) {
    const u = hash2(j, seed) * 2 - 1;
    const angle = hash2(j, seed + 1) * Math.PI * 2;
    const r = radius + hash2(j, seed + 2) * 30;
    const s = Math.sqrt(1 - u * u);
    positions[i * 3] = Math.cos(angle) * s * r;
    positions[i * 3 + 1] = u * r;
    positions[i * 3 + 2] = Math.sin(angle) * s * r;
    sizes[i] = size;
    const b = brightness * (0.65 + hash2(j, seed + 3) * 0.35);
    const tint = hash2(j, seed + 4);
    // Mostly neutral chalk, occasional blue/old-gold depth. Linear colours remain well below bloom.
    colours[i * 3] = b * (tint < 0.16 ? 0.69 : 1);
    colours[i * 3 + 1] = b * (tint > 0.86 ? 0.82 : 0.93);
    colours[i * 3 + 2] = b * (tint > 0.86 ? 0.6 : 1);
  }
  const material = overlay(new PointsNodeMaterial({ sizeAttenuation: false }));
  material.positionNode = instancedBufferAttribute(new InstancedBufferAttribute(positions, 3), 'vec3');
  material.colorNode = instancedBufferAttribute(new InstancedBufferAttribute(colours, 3), 'vec3');
  material.sizeNode = instancedBufferAttribute(new InstancedBufferAttribute(sizes, 1), 'float');
  material.opacityNode = FADE.orbit.focus;
  const sprite = new Sprite(material);
  sprite.count = count;
  sprite.name = 'off-map-stars';
  sprite.frustumCulled = false;
  sprite.raycast = () => {};
  return sprite;
}

export class PlaneBackdrop {
  readonly group = new Group();
  private readonly stars = stars();

  constructor() {
    const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, depthTest: false });
    material.colorNode = distantPaint();
    material.mrtNode = NO_LINES;
    const dome = new Mesh(domeGeometry, material);
    dome.name = 'distant-plane-pigment';
    dome.frustumCulled = false;
    dome.raycast = () => {};
    // Opaque dome first, then stars before every transparent map overlay. Nothing writes depth or ink normals.
    this.group.renderOrder = -100;
    this.group.name = 'off-map-backdrop';
    this.group.add(dome, this.stars);
  }

  frame(): void {
    this.stars.visible = focusValue.orbit > 0;
  }
}
