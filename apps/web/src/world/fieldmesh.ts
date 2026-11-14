/**
 * GPU side of a `HeightField`: one indexed mesh (grid + a diorama skirt around the map edge) whose vertex buffers are
 * patched in place for a window of samples (holes, chasms, digs), with per-row update ranges.
 * Attributes: `position`, `normal`, `sun`, `ao`, `m` (class masks 0–3), `m2` (class masks 4–5).
 */
import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three/webgpu';
import { CLASS_BITS, type HeightField, type Window } from './field.ts';

/** Retain all writes until Three consumes them; merge overlaps so hidden planes do not accumulate duplicate ranges. */
function queueRange(attribute: BufferAttribute, start: number, count: number): void {
  const ranges = attribute.updateRanges;
  let end = start + count;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!;
    const rEnd = r.start + r.count;
    if (r.start <= start && rEnd >= end) return;
    if (rEnd < start || r.start > end) continue;
    start = Math.min(start, r.start);
    end = Math.max(end, rEnd);
    ranges[i] = ranges[ranges.length - 1]!;
    ranges.pop();
    i--;
  }
  attribute.addUpdateRange(start, end - start);
}

export class FieldMesh {
  readonly geometry = new BufferGeometry();
  private readonly field: HeightField;
  private readonly pos: BufferAttribute;
  private readonly nor: BufferAttribute;
  private readonly sun: BufferAttribute;
  private readonly ao: BufferAttribute;
  private readonly m: BufferAttribute;
  private readonly m2: BufferAttribute;
  private readonly index: BufferAttribute;
  /** first skirt vertex */
  private readonly skirtV: number;
  /** border sample per skirt column (4 edges × n) */
  private readonly border: Uint32Array;

  /** `skirt`: local y the map edge is cut down to. */
  constructor(field: HeightField, skirt: number) {
    this.field = field;
    const n = field.n;
    const res = field.spec.res;
    const half = field.spec.size / 2;
    const grid = n * n;
    const sv = 4 * n * 2;
    const verts = grid + sv;
    const pos = new Float32Array(verts * 3);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 3;
        pos[o] = i / res - half;
        pos[o + 2] = j / res - half;
      }
    // skirt: edges N (j=0), E (i=n-1), S (j=n-1), W (i=0), each walked so its quads face outward
    this.border = new Uint32Array(4 * n);
    for (let k = 0; k < n; k++) {
      this.border[k] = n - 1 - k; // north, east → west
      this.border[n + k] = (n - 1 - k) * n + (n - 1); // east, south → north
      this.border[2 * n + k] = (n - 1) * n + k; // south, west → east
      this.border[3 * n + k] = k * n; // west, north → south
    }
    const nor = new Float32Array(verts * 3);
    const edgeN = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const;
    for (let e = 0; e < 4; e++)
      for (let k = 0; k < n; k++) {
        const s = this.border[e * n + k]!;
        for (let t = 0; t < 2; t++) {
          const v = grid + (e * n + k) * 2 + t;
          pos[v * 3] = pos[s * 3]!;
          pos[v * 3 + 1] = skirt;
          pos[v * 3 + 2] = pos[s * 3 + 2]!;
          nor[v * 3] = edgeN[e]![0];
          nor[v * 3 + 2] = edgeN[e]![1];
        }
      }
    const quads = (n - 1) * (n - 1);
    const idx = new Uint32Array(quads * 6 + 4 * (n - 1) * 6);
    for (let e = 0; e < 4; e++)
      for (let k = 0; k < n - 1; k++) {
        const a = grid + (e * n + k) * 2; // top, bottom
        const b = a + 2;
        const o = quads * 6 + (e * (n - 1) + k) * 6;
        idx[o] = a;
        idx[o + 1] = a + 1;
        idx[o + 2] = b;
        idx[o + 3] = b;
        idx[o + 4] = a + 1;
        idx[o + 5] = b + 1;
      }
    this.skirtV = grid;
    this.pos = new BufferAttribute(pos, 3);
    this.nor = new BufferAttribute(nor, 3);
    this.sun = new BufferAttribute(new Float32Array(verts).fill(0.4), 1);
    this.ao = new BufferAttribute(new Float32Array(verts).fill(0.7), 1);
    this.m = new BufferAttribute(new Float32Array(verts * 4), 4);
    this.m2 = new BufferAttribute(new Float32Array(verts * 2), 2);
    this.index = new BufferAttribute(idx, 1);
    const g = this.geometry;
    g.setAttribute('position', this.pos);
    g.setAttribute('normal', this.nor);
    g.setAttribute('sun', this.sun);
    g.setAttribute('ao', this.ao);
    g.setAttribute('m', this.m);
    g.setAttribute('m2', this.m2);
    g.setIndex(this.index);
    g.boundingSphere = new Sphere(new Vector3(0, 0, 0), half * 1.5);
    this.upload();
  }

  /** Copy the field's samples in `w` (default: all) into the vertex buffers and re-split the quads there. */
  upload(w: Window = this.field.full()): void {
    const f = this.field;
    const n = f.n;
    const all = w.i0 === 0 && w.j0 === 0 && w.i1 === n - 1 && w.j1 === n - 1;
    const pos = this.pos.array as Float32Array;
    const nor = this.nor.array as Float32Array;
    const sun = this.sun.array as Float32Array;
    const ao = this.ao.array as Float32Array;
    const m = this.m.array as Float32Array;
    const m2 = this.m2.array as Float32Array;
    const idx = this.index.array as Uint32Array;
    const h = f.h;
    // A full write must remain explicit: an empty range list means "all" to Three, but a later patch would narrow it.
    if (all) for (const a of [this.pos, this.nor, this.sun, this.ao, this.m, this.m2, this.index]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, a.array.length);
    }
    for (let j = w.j0; j <= w.j1; j++) {
      for (let i = w.i0; i <= w.i1; i++) {
        const q = j * n + i;
        pos[q * 3 + 1] = h[q]!;
        nor[q * 3] = f.normal[q * 3]!;
        nor[q * 3 + 1] = f.normal[q * 3 + 1]!;
        nor[q * 3 + 2] = f.normal[q * 3 + 2]!;
        sun[q] = f.sun[q]!;
        ao[q] = f.ao[q]!;
        const c = q * CLASS_BITS;
        m[q * 4] = f.mask[c]!;
        m[q * 4 + 1] = f.mask[c + 1]!;
        m[q * 4 + 2] = f.mask[c + 2]!;
        m[q * 4 + 3] = f.mask[c + 3]!;
        m2[q * 2] = f.mask[c + 4]!;
        m2[q * 2 + 1] = f.mask[c + 5]!;
      }
      if (!all) {
        const s = j * n + w.i0;
        const cnt = w.i1 - w.i0 + 1;
        queueRange(this.pos, s * 3, cnt * 3);
        queueRange(this.nor, s * 3, cnt * 3);
        queueRange(this.sun, s, cnt);
        queueRange(this.ao, s, cnt);
        queueRange(this.m, s * 4, cnt * 4);
        queueRange(this.m2, s * 2, cnt * 2);
      }
    }
    // quads touching the window: split along the shorter diagonal (fewer slivers on walls)
    const qi0 = Math.max(0, w.i0 - 1);
    const qj0 = Math.max(0, w.j0 - 1);
    const qi1 = Math.min(n - 2, w.i1);
    const qj1 = Math.min(n - 2, w.j1);
    for (let j = qj0; j <= qj1; j++) {
      for (let i = qi0; i <= qi1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        const o = (j * (n - 1) + i) * 6;
        if (Math.abs(h[a]! - h[d]!) < Math.abs(h[b]! - h[c]!)) {
          idx[o] = a; idx[o + 1] = c; idx[o + 2] = d; idx[o + 3] = a; idx[o + 4] = d; idx[o + 5] = b;
        } else {
          idx[o] = a; idx[o + 1] = c; idx[o + 2] = b; idx[o + 3] = b; idx[o + 4] = c; idx[o + 5] = d;
        }
      }
      if (!all) queueRange(this.index, (j * (n - 1) + qi0) * 6, (qi1 - qi0 + 1) * 6);
    }
    // skirt tops follow the border heights
    if (all || w.i0 === 0 || w.j0 === 0 || w.i1 === n - 1 || w.j1 === n - 1) {
      const g = this.skirtV;
      for (let k = 0; k < 4 * n; k++) {
        const s = this.border[k]!;
        const v = g + k * 2;
        pos[v * 3 + 1] = h[s]!;
        const c = s * CLASS_BITS;
        for (let t = 0; t < 2; t++) {
          m[(v + t) * 4] = f.mask[c]!;
          m[(v + t) * 4 + 1] = 1; // the cut reads as rock
          m[(v + t) * 4 + 2] = f.mask[c + 2]!;
        }
      }
      if (!all) {
        queueRange(this.pos, g * 3, 4 * n * 2 * 3);
        queueRange(this.m, g * 4, 4 * n * 2 * 4);
      }
    }
    for (const a of [this.pos, this.nor, this.sun, this.ao, this.m, this.m2, this.index]) a.needsUpdate = true;
  }
}
