/**
 * Full heightfield builds off the main thread (≈70–120 ms for the 48² Surface), so match start never hitches; the
 * Surface's shore field bakes here too, on the heights just built.
 */
import { HeightField, type FieldBake, type FieldJob } from './field.ts';
import { ShoreField } from './shore.ts';

/** The dedicated-worker global (the app compiles against the DOM lib, where `self` is a Window). */
const scope = self as unknown as { onmessage: ((e: MessageEvent<FieldJob>) => void) | null; postMessage(m: { id: number; bake: FieldBake; shore?: Uint8Array }, transfer: Transferable[]): void };

scope.onmessage = (e) => {
  const job = e.data;
  const f = new HeightField(job.spec);
  f.level.set(job.level);
  f.cls.set(job.cls);
  f.setSun(job.sun[0], job.sun[1], job.sun[2]);
  f.build(f.full());
  const bake = f.bakeData();
  const transfer: Transferable[] = [bake.h.buffer, bake.sun.buffer, bake.ao.buffer, bake.mask.buffer, bake.normal.buffer];
  let shore: Uint8Array | undefined;
  if (job.shore) {
    const s = new ShoreField(job.spec.size, job.shore.drift, job.shore.res);
    s.build({ size: job.spec.size, cells: job.shore.cells, levels: job.shore.levels, heightAt: (x, y) => f.heightAt(x, y) });
    shore = s.data;
    transfer.push(shore.buffer);
  }
  scope.postMessage({ id: job.id, bake, shore }, transfer);
};
