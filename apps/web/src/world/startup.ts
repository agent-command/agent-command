/** Startup-only cooperative work; never used by the render loop. */
const SLICE_MS = 4;

/** Let input and the loading UI run before continuing CPU preparation. */
export function yieldStartup(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } }).scheduler;
  if (scheduler) return scheduler.yield();
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

/** Continue in a new task after the next rendered frame, for work sharing the main thread with a running render loop.
 *  A hidden tab renders no frames: a 100 ms timer bounds the wait. */
export function afterFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 100);
  requestAnimationFrame(() => setTimeout(() => {
    clearTimeout(timer);
    resolve();
  }, 0));
  return promise;
}

/** Each generator step is one bounded construction task, not a whole scene constructor. */
export async function prepareStartup<T>(tasks: Generator<void, T>): Promise<T> {
  await yieldStartup();
  let deadline = performance.now() + SLICE_MS;
  for (;;) {
    const next = tasks.next();
    if (next.done) return next.value;
    if (performance.now() >= deadline) {
      await yieldStartup();
      deadline = performance.now() + SLICE_MS;
    }
  }
}
