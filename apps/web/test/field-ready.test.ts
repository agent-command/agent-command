import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeightField, type FieldJob, type FieldSpec } from '../src/world/field.ts';
import { FieldBuilder } from '../src/world/fieldjobs.ts';

const SPEC: FieldSpec = { size: 4, res: 2, blur: 0.28, sharp: 0.2, rough: 0.06, swell: 0, levels: [0, 1], sun: false };
class FieldWorker {
  static current: FieldWorker;
  onmessage: ((event: MessageEvent) => void) | undefined;
  onerror: ((event: ErrorEvent) => void) | undefined;
  readonly jobs: FieldJob[] = [];
  constructor() { FieldWorker.current = this; }
  postMessage(job: FieldJob): void { this.jobs.push(job); }
  finish(index: number): void {
    const job = this.jobs[index]!;
    const field = new HeightField(job.spec);
    field.level.set(job.level);
    field.cls.set(job.cls);
    field.setSun(...job.sun);
    field.build(field.full());
    this.onmessage?.({ data: { id: job.id, bake: field.bakeData() } } as MessageEvent);
  }
}
afterEach(() => vi.unstubAllGlobals());

describe('terrain first-frame readiness', () => {
  it('waits for the latest bake and reconciles changed inputs in the worker, not a synchronous patch', async () => {
    vi.stubGlobal('Worker', FieldWorker);
    const changed = vi.fn();
    const builder = new FieldBuilder(new HeightField(SPEC), -1, changed);
    builder.full();
    const worker = FieldWorker.current;
    const patch = vi.spyOn(builder, 'patch');
    let ready = false;
    const waiting = builder.ready().then(() => { ready = true; });
    builder.level[5] = 1;
    worker.finish(0);
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(worker.jobs).toHaveLength(2);
    expect(changed).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    worker.finish(1);
    await waiting;
    expect(changed).toHaveBeenCalledOnce();
    expect(builder.field.level[5]).toBe(1);
    expect(patch).not.toHaveBeenCalled();
  });

  it('ignores superseded bakes and propagates worker failure to the loader', async () => {
    vi.stubGlobal('Worker', FieldWorker);
    const builder = new FieldBuilder(new HeightField(SPEC), -1, vi.fn());
    builder.full();
    builder.level[3] = 1;
    builder.full();
    const worker = FieldWorker.current;
    const ready = builder.ready();
    const failure = expect(ready).rejects.toThrow('terrain failed');
    worker.finish(0);
    expect(worker.jobs).toHaveLength(2);
    worker.onerror?.({ message: 'terrain failed' } as ErrorEvent);
    await failure;
    await expect(builder.ready()).rejects.toThrow('terrain failed');
  });
});
