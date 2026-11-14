/**
 * Forward-post ground beds: the battle-scarred earth a post's mound sinks into. Disturbed dirt and patchy soot feather
 * out into whatever terrain lies beneath (grass, dirt, a plateau top), with a faint shell-crater ring and debris
 * flecks settled into the dirt, so the post reads as part of the battlefield instead of a model set on the ground.
 *
 * One merged mesh: a terrain-conforming disc per public post (`matchData.posts`, static per match), built when the
 * posts change and re-seated only when the Surface field re-bakes (holes). Each vertex keeps the bed only on the
 * post's own level (`keep`), so a post by a plateau edge never paints the cliff or the ground below it. The pattern
 * is sized in post-model units and follows the units' zoom enlargement through one uniform, so the bed always matches
 * the post model's size; nothing is allocated per frame.
 */
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { abs, attribute, color, float, max, mix, mx_noise_float, normalWorld, smoothstep, uniform, vec3 } from 'three/tsl';
import { PLANE_Y } from '@agent-command/game/contract';
import { FADE } from './fade.ts';
import { hash2, wx, wz } from './common.ts';
import { cel, emptyGeometry, finish, overlay, type F1, type V3 } from './materials.ts';
import { SHADOW } from './palette.ts';
import { UNIT_SCALE } from './models.ts';
import { unitZoomScale } from './rig.ts';
import type { FogField } from './fog.ts';

/** Bed radius in post-model units (the mound meets the ground about 0.45 out): world radius = BED_R × post scale. */
export const BED_R = 1.05;
/** The post's largest drawn scale (entities: UNIT_SCALE × the zoom enlargement cap); the disc is built this wide. */
const MAX_SCALE = UNIT_SCALE * unitZoomScale(Infinity);
/** The widest bed's radius (tiles): ground detail keeps clear of it. */
export const BED_REACH = BED_R * MAX_SCALE;
const RINGS = 14;
const SEGS = 32;
/** Vertices per post: the centre and RINGS rings of SEGS. */
export const BED_VERTS = 1 + RINGS * SEGS;
/** Lift over the field so the conforming disc never dips under the baked terrain triangles. */
const LIFT = 0.03;
/** Height difference (tiles) from the post's own ground over which the bed fades out: plateau edges, crags, pits. */
const LEVEL_FADE: readonly [number, number] = [0.08, 0.28];

// Earth tones of the mound (models.ts MOUND) and its scorch, a touch lighter where the dirt is loose and dry.
const EARTH = '#8a7458';
const LOOSE = '#a08a66';
const SOOT = '#544840';
const WALL = '#655341';
const LIP = '#b9a37c';
const FLECK = '#3f3630';

export interface PostSite {
  readonly x: number;
  readonly y: number;
}

export class PostBeds {
  readonly size: number;
  readonly mesh: Mesh;
  /** Post-model → world scale of the pattern (UNIT_SCALE × the units' zoom enlargement). */
  private readonly scale = uniform(UNIT_SCALE);
  private sites: readonly PostSite[] = [];

  constructor(size: number, fogField?: FogField) {
    this.size = size;
    this.mesh = new Mesh(emptyGeometry(), this.material(fogField));
    this.mesh.name = 'surface-post-beds';
    this.mesh.frustumCulled = false;
    // Surface group: over the water sheet (2), under island shadows (7) and scorches (8).
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
  }

  private material(fogField: FogField | undefined): MeshBasicNodeMaterial {
    const m = overlay(new MeshBasicNodeMaterial());
    const bed = attribute<'vec3'>('bed', 'vec3');
    const keep = attribute<'float'>('keep', 'float') as F1;
    // Model-unit offset from the staff, plus a per-post seed: the same pattern at every zoom, different per post.
    const d = bed.xy.div(this.scale);
    const q = vec3(d.x, bed.z, d.y);
    const r = d.length();
    const broad = mx_noise_float(q.mul(2.2));
    const grain = mx_noise_float(q.mul(7));
    const rr = r.add(broad.mul(0.13)).add(grain.mul(0.03));
    // Disturbed earth: solid out past the crater, feathered into the terrain colour by the edge.
    const earth = float(1).sub(smoothstep(0.6, 1, rr));
    // Soot in patches, strongest around the mound.
    const soot = float(1).sub(smoothstep(0.22, 0.62, rr)).mul(smoothstep(-0.3, 0.1, mx_noise_float(q.mul(3.1))));
    // The old shell crater: a shadowed inner wall, then a sunlit lip, in crisp toon bands broken by the grain.
    const wall = float(1).sub(smoothstep(0.02, 0.04, abs(rr.sub(0.6)))).mul(smoothstep(-0.45, -0.2, broad));
    const lip = float(1).sub(smoothstep(0.015, 0.035, abs(rr.sub(0.67)))).mul(smoothstep(-0.45, -0.2, broad));
    // Debris flecks settled in the dirt, thinning outward.
    const fleck = smoothstep(0.42, 0.47, mx_noise_float(q.mul(13))).mul(float(1).sub(smoothstep(0.5, 0.95, rr)));
    let col = mix(color(LOOSE), color(EARTH), float(1).sub(smoothstep(0.35, 0.8, rr))) as V3;
    col = mix(col, color(SOOT), soot.mul(0.75)) as V3;
    col = mix(col, color(WALL), wall.mul(0.8)) as V3;
    col = mix(col, color(LIP), lip.mul(0.6)) as V3;
    col = mix(col, color(FLECK), fleck.mul(0.85)) as V3;
    const lit = cel(col, SHADOW.surface);
    m.colorNode = finish(lit, 'surface', { fogField, tone: lit });
    // Flat ground only: a disc triangle spanning a cliff lip fades out with its slope.
    const flat = smoothstep(0.7, 0.92, normalWorld.y);
    m.opacityNode = max(earth.mul(0.92), fleck.mul(0.85)).mul(keep).mul(flat).mul(FADE.surface.alpha);
    return m;
  }

  /** The match's public posts; rebuilds the disc topology only when their count changes. Seat afterwards. */
  set(sites: readonly PostSite[]): void {
    const geo = this.mesh.geometry;
    if (sites.length !== this.sites.length || !geo.getAttribute('bed')) {
      const n = sites.length;
      geo.setAttribute('position', new BufferAttribute(new Float32Array(n * BED_VERTS * 3), 3));
      geo.setAttribute('bed', new BufferAttribute(new Float32Array(n * BED_VERTS * 3), 3));
      geo.setAttribute('keep', new BufferAttribute(new Float32Array(n * BED_VERTS), 1));
      const index = new Uint16Array(n * SEGS * (3 + (RINGS - 1) * 6));
      let k = 0;
      for (let p = 0; p < n; p++) {
        const o = p * BED_VERTS;
        const at = (ring: number, s: number) => o + 1 + (ring - 1) * SEGS + (s % SEGS);
        for (let s = 0; s < SEGS; s++) {
          index[k++] = o; index[k++] = at(1, s + 1); index[k++] = at(1, s);
          for (let ring = 1; ring < RINGS; ring++) {
            const a = at(ring, s), b = at(ring, s + 1), c = at(ring + 1, s), e = at(ring + 1, s + 1);
            index[k++] = a; index[k++] = b; index[k++] = c;
            index[k++] = b; index[k++] = e; index[k++] = c;
          }
        }
      }
      geo.setIndex(new BufferAttribute(index, 1));
    }
    this.sites = sites;
    const bed = geo.getAttribute('bed') as BufferAttribute;
    const b = bed.array as Float32Array;
    for (let p = 0; p < sites.length; p++) {
      const seed = hash2(Math.floor(sites[p]!.x * 2), Math.floor(sites[p]!.y * 2)) * 50;
      for (let v = 0; v < BED_VERTS; v++) {
        const o = (p * BED_VERTS + v) * 3;
        b[o] = OFFSETS[v * 2]!; b[o + 1] = OFFSETS[v * 2 + 1]!; b[o + 2] = seed;
      }
    }
    bed.needsUpdate = true;
    this.mesh.visible = false;
  }

  /** Seat every disc on the finished field: heights follow the ground, the bed stays on its post's level. */
  seat(groundAt: (x: number, y: number) => number): void {
    const geo = this.mesh.geometry;
    const pos = geo.getAttribute('position') as BufferAttribute | undefined;
    if (!pos || !this.sites.length) {
      this.mesh.visible = false;
      return;
    }
    const keep = geo.getAttribute('keep') as BufferAttribute;
    const P = pos.array as Float32Array, K = keep.array as Float32Array;
    for (let p = 0; p < this.sites.length; p++) {
      const { x, y } = this.sites[p]!;
      const h0 = groundAt(x, y);
      for (let v = 0; v < BED_VERTS; v++) {
        const dx = OFFSETS[v * 2]!, dy = OFFSETS[v * 2 + 1]!;
        const h = groundAt(x + dx, y + dy);
        const i = p * BED_VERTS + v;
        P[i * 3] = wx(x + dx, this.size);
        P[i * 3 + 1] = PLANE_Y.surface + h + LIFT;
        P[i * 3 + 2] = wz(y + dy, this.size);
        const t = Math.min(1, Math.max(0, (Math.abs(h - h0) - LEVEL_FADE[0]) / (LEVEL_FADE[1] - LEVEL_FADE[0])));
        K[i] = 1 - t * t * (3 - 2 * t);
      }
    }
    pos.needsUpdate = true;
    keep.needsUpdate = true;
    geo.computeVertexNormals();
    this.mesh.visible = true;
  }

  /** Follow the units' zoom enlargement (`unitZoomScale`), as the post model does. */
  zoom(scale: number): void {
    this.scale.value = UNIT_SCALE * scale;
  }
}

/** Tile offset of disc vertex `v` from its post: rings denser near the mound, out to the largest drawn bed. */
const OFFSETS = (() => {
  const out = new Float32Array(BED_VERTS * 2);
  for (let ring = 1; ring <= RINGS; ring++) {
    const r = BED_R * MAX_SCALE * (ring / RINGS) ** 1.35;
    for (let s = 0; s < SEGS; s++) {
      const a = (s / SEGS) * Math.PI * 2;
      const v = 1 + (ring - 1) * SEGS + s;
      out[v * 2] = Math.cos(a) * r;
      out[v * 2 + 1] = Math.sin(a) * r;
    }
  }
  return out;
})();
