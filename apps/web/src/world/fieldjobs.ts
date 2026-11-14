/**
 * Keeps a `HeightField` and its `FieldMesh` in step with wanted per-cell inputs: full builds run in the field worker
 * (match start never hitches), everything after is patched in windows (changed cells ±2, clustered) on the main
 * thread — holes and chasms on the Surface, digs, scans and floods in the Depths. A shore field (the Surface water's
 * coast) bakes in the worker with each full build; its owner re-bakes patched windows itself.
 */
import { HeightField, type FieldBake, type FieldJob } from './field.ts';
import { FieldMesh } from './fieldmesh.ts';
import type { ShoreField, ShoreSource } from './shore.ts';

/** Changed cells above which a patch becomes a full (worker) build instead. */
const FULL_ABOVE = 600;
/** Cells a patch window reaches past its changed cells: the blur and normals of the field read that far. */
export const PATCH_PAD = 2;
/** Main-thread time per frame spent copying a finished bake into the mesh, and rows copied per step. */
const UPLOAD_BUDGET_MS = 6;
const UPLOAD_ROWS = 16;

export class FieldBuilder {
  readonly field: HeightField;
  readonly mesh: FieldMesh;
  /** Inputs wanted per cell (row-major): set them, then `full()` or `patch()`. */
  readonly level: Float32Array;
  readonly cls: Uint8Array;
  /**
   * Called after the mesh changed, to re-place what stands on the field: with the patched cell boxes (x0, y0, x1, y1
   * per cluster, before the window's padding) after a patch, with none after a full build.
   */
  private readonly changed: (boxes?: readonly number[]) => void;
  private readonly sun: [number, number, number] = [0, 1, 0];
  private readonly boxes: number[] = [];
  private worker: Worker | undefined;
  private job = 0;
  private pending = false;
  private failure: Error | undefined;
  private readonly waiters: { resolve(): void; reject(error: Error): void }[] = [];
  private readonly shore: { field: ShoreField; source: ShoreSource } | undefined;

  /** The first frame waits for the latest full bake, including any inputs changed while the worker ran. */
  ready(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.pending) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.waiters.push({ resolve, reject });
    return promise;
  }

  private settled(): void {
    if (this.pending) return;
    for (const waiter of this.waiters) {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve();
    }
    this.waiters.length = 0;
  }

  /** `skirt`: local y the map edge is cut down to; `shore`: a shore field to bake with every full build. */
  constructor(field: HeightField, skirt: number, changed: (boxes?: readonly number[]) => void, shore?: { field: ShoreField; source: ShoreSource }) {
    this.field = field;
    this.mesh = new FieldMesh(field, skirt);
    const cells = field.spec.size * field.spec.size;
    this.level = new Float32Array(cells);
    this.cls = new Uint8Array(cells);
    this.changed = changed;
    this.shore = shore;
  }

  /** Full build of the wanted inputs, lit from `sun` (ignored when the spec bakes no sun). */
  full(sunX = 0, sunY = 1, sunZ = 0): void {
    const f = this.field;
    this.failure = undefined;
    this.sun[0] = sunX;
    this.sun[1] = sunY;
    this.sun[2] = sunZ;
    f.level.set(this.level);
    f.cls.set(this.cls);
    f.setSun(sunX, sunY, sunZ);
    if (typeof Worker === 'undefined') {
      f.build(f.full());
      this.shore?.field.build(this.shore.source);
      this.mesh.upload();
      this.changed();
      return;
    }
    this.worker ??= this.spawn();
    const s = this.shore;
    const shore = s && { res: s.field.res, cells: s.source.cells.slice(), levels: [s.source.levels[0], s.source.levels[1]] as [number, number], drift: [s.field.drift[0], s.field.drift[1]] as [number, number] };
    const job: FieldJob = { id: ++this.job, spec: f.spec, level: this.level.slice(), cls: this.cls.slice(), sun: [sunX, sunY, sunZ], shore };
    this.pending = true;
    this.worker.postMessage(job, shore ? [job.level.buffer, job.cls.buffer, shore.cells.buffer] : [job.level.buffer, job.cls.buffer]);
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./field.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; bake: FieldBake; shore?: Uint8Array }>) => {
      if (e.data.id !== this.job) return; // superseded by a newer full build
      // Inputs can gain lodes/holes during the base bake: reconcile in the worker, not a blocking completion patch.
      for (let i = 0; i < this.level.length; i++) {
        if (this.field.level[i] === this.level[i] && this.field.cls[i] === this.cls[i]) continue;
        this.full(this.sun[0], this.sun[1], this.sun[2]);
        return;
      }
      this.field.adopt(e.data.bake);
      if (e.data.shore) this.shore?.field.data.set(e.data.shore);
      this.uploadBands(e.data.id, 0);
    };
    w.onerror = (event) => {
      this.pending = false;
      this.failure = new Error(event.message || 'Terrain worker failed');
      this.settled();
    };
    return w;
  }

  /**
   * Copy a full bake into the mesh in row bands, at most UPLOAD_BUDGET_MS of main-thread work per task: each band's
   * rows are contiguous in every attribute, so a band is one bounded buffer upload, never one map-sized stall. The
   * mesh shows the previous bake below the band edge until the last band lands; a newer job abandons this one.
   */
  private uploadBands(id: number, j0: number): void {
    if (id !== this.job) return;
    const n = this.field.n;
    const start = performance.now();
    let j = j0;
    while (j < n && performance.now() - start < UPLOAD_BUDGET_MS) {
      const j1 = Math.min(n - 1, j + UPLOAD_ROWS - 1);
      this.mesh.upload({ i0: 0, j0: j, i1: n - 1, j1 });
      j = j1 + 1;
    }
    if (j < n) {
      // A task, not a frame callback: hidden tabs (match start in the background) keep uploading.
      setTimeout(() => this.uploadBands(id, j), 0);
      return;
    }
    this.pending = false;
    this.changed();
    this.settled();
  }

  /**
   * Rebuild the field where the wanted inputs differ from the built ones. Returns whether the mesh changed; false while
   * a full build is in flight (its arrival patches whatever changed meanwhile).
   */
  patch(): boolean {
    if (this.pending) return false;
    const f = this.field;
    const S = f.spec.size;
    const boxes = this.boxes; // x0, y0, x1, y1 per cluster
    boxes.length = 0;
    let changed = 0;
    for (let i = 0; i < S * S; i++) if (f.level[i] !== this.level[i] || f.cls[i] !== this.cls[i]) changed++;
    if (!changed) return false;
    if (changed > FULL_ABOVE) {
      this.full(this.sun[0], this.sun[1], this.sun[2]);
      return false;
    }
    for (let i = 0; i < S * S; i++) {
      if (f.level[i] === this.level[i] && f.cls[i] === this.cls[i]) continue;
      f.level[i] = this.level[i]!;
      f.cls[i] = this.cls[i]!;
      const x = i % S;
      const y = (i / S) | 0;
      let k = 0;
      for (; k < boxes.length; k += 4)
        if (x >= boxes[k]! - 4 && x <= boxes[k + 2]! + 4 && y >= boxes[k + 1]! - 4 && y <= boxes[k + 3]! + 4) {
          boxes[k] = Math.min(boxes[k]!, x);
          boxes[k + 1] = Math.min(boxes[k + 1]!, y);
          boxes[k + 2] = Math.max(boxes[k + 2]!, x);
          boxes[k + 3] = Math.max(boxes[k + 3]!, y);
          break;
        }
      if (k >= boxes.length) boxes.push(x, y, x, y);
    }
    for (let k = 0; k < boxes.length; k += 4) {
      const w = f.windowOf(boxes[k]!, boxes[k + 1]!, boxes[k + 2]!, boxes[k + 3]!, PATCH_PAD);
      f.build(w);
      this.mesh.upload(w);
    }
    this.changed(boxes);
    return true;
  }
}
