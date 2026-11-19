import { vi, type Mock } from 'vitest';
import type { AudioListener } from '../src/audio/engine.ts';

/** A fake buffer source as the engine drives it: its output connection, disconnects and stops. */
interface FakeSource {
  readonly connect: Mock;
  readonly disconnect: Mock;
  readonly stop: Mock;
  readonly loop: boolean;
}

type Automation = { kind: 'set' | 'target' | 'linear'; t: number; v: number; tau: number };

/** Value at `time` of automation `events` (time order) from `init` (Web Audio semantics). */
function automated(init: number, events: readonly Automation[], time: number): number {
  // the value at the last processed event's time, and the setTarget running from it
  let v = init, vt = 0;
  let target: Automation | undefined;
  const at = (x: number): number => (target ? target.v + (v - target.v) * Math.exp(-(x - vt) / target.tau) : v);
  for (const e of events) {
    if (e.t > time) return e.kind === 'linear' ? at(vt) + (e.v - at(vt)) * (time - vt) / (e.t - vt) : at(time);
    v = e.kind === 'target' ? at(e.t) : e.v;
    vt = e.t;
    target = e.kind === 'target' ? e : undefined;
  }
  return at(time);
}

/** The automation methods of a fake AudioParam, as recorded mocks. */
interface ParamCalls {
  readonly setTargetAtTime: Mock;
  readonly setValueAtTime: Mock;
  readonly linearRampToValueAtTime: Mock;
  readonly cancelScheduledValues: Mock;
  readonly cancelAndHoldAtTime: Mock;
}

/**
 * The automation timeline of a param, replayed from its recorded calls in call order (the mocks stay plain, so tests
 * that build hundreds of engines keep no per-param closures alive).
 */
function timeline(init: number, p: ParamCalls): Automation[] {
  const calls: { order: number; method: keyof ParamCalls; args: number[] }[] = [];
  for (const method of ['setTargetAtTime', 'setValueAtTime', 'linearRampToValueAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime'] as const) {
    const mock = p[method].mock;
    for (let i = 0; i < mock.calls.length; i++) calls.push({ order: mock.invocationCallOrder[i]!, method, args: mock.calls[i] as number[] });
  }
  calls.sort((a, b) => a.order - b.order);
  const events: Automation[] = [];
  // after events at the same or an earlier time (Web Audio insertion order)
  const add = (e: Automation): void => {
    const i = events.findIndex((o) => o.t > e.t);
    events.splice(i < 0 ? events.length : i, 0, e);
  };
  for (const { method, args: [a = 0, b = 0, c = 0] } of calls) {
    if (method === 'setTargetAtTime') add({ kind: 'target', t: b, v: a, tau: c });
    else if (method === 'setValueAtTime') add({ kind: 'set', t: b, v: a, tau: 0 });
    else if (method === 'linearRampToValueAtTime') add({ kind: 'linear', t: b, v: a, tau: 0 });
    else {
      const held = automated(init, events, a);
      for (let i = events.length - 1; i >= 0; i--) if (events[i]!.t >= a) events.splice(i, 1);
      if (method === 'cancelAndHoldAtTime') add({ kind: 'set', t: a, v: held, tau: 0 });
    }
  }
  return events;
}

/**
 * A fake AudioParam: `value` reads its automation at the context's current time, `at(t)` at any time, as a browser
 * renders it. Built outside fakeContext and reading a plain time holder, so a retained mock never keeps a context (its
 * decoder, its engine and their buffers) alive.
 */
function fakeParam(time: { currentTime: number }) {
  let intrinsic = 1;
  const p = {
    get value(): number {
      return automated(intrinsic, timeline(intrinsic, p), time.currentTime);
    },
    set value(v: number) {
      intrinsic = v;
    },
    at: (t: number): number => automated(intrinsic, timeline(intrinsic, p), t),
    setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), cancelAndHoldAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(),
  };
  return p;
}

/**
 * Minimal AudioContext stand-in: nodes record connections and parameter automation (fakeParam), sources record when
 * they start; decoding is stubbed.
 */
export function fakeContext(decode: (b: ArrayBuffer) => Promise<AudioBuffer>, level = 0) {
  const started: AudioBuffer[] = [];
  const starts: { buffer: AudioBuffer; when: number; offset: number; duration: number | undefined; src: FakeSource }[] = [];
  const time = { currentTime: 0 };
  const param = () => fakeParam(time);
  const node = () => ({ connect: vi.fn((n: unknown) => n), disconnect: vi.fn(), gain: param(), pan: param(), frequency: param(), Q: param(), type: '' });
  const compressor = { ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() };
  const ctx = {
    state: 'running', sampleRate: 48000, destination: node(),
    get currentTime(): number {
      return time.currentTime;
    },
    set currentTime(t: number) {
      time.currentTime = t;
    },
    createGain: node, createStereoPanner: node, createBiquadFilter: node,
    createDynamicsCompressor: () => compressor,
    createAnalyser: () => ({ ...node(), fftSize: 2048, getFloatTimeDomainData: (b: Float32Array) => b.fill(level) }),
    createBufferSource: () => {
      const n = {
        ...node(), playbackRate: param(), buffer: null as AudioBuffer | null, loop: false, loopStart: 0, loopEnd: 0,
        start: vi.fn((when?: number, offset?: number, duration?: number) => { if (n.buffer) { started.push(n.buffer); starts.push({ buffer: n.buffer, when: when ?? 0, offset: offset ?? 0, duration, src: n }); } }),
        stop: vi.fn(),
      };
      return n;
    },
    decodeAudioData: decode, resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  };
  return { ctx: ctx as unknown as AudioContext, started, starts, clock: ctx, compressor };
}

/**
 * A decoded buffer stand-in of `seconds` (mono, 48 kHz). Its samples are allocated on first read only: an engine
 * decodes every effect and bed of a match (dozens of 95 s fakes, ~18 MB each), and allocating them all per test case
 * grew a worker past 5 GB.
 */
export function fakeBuffer(seconds: number): AudioBuffer {
  const length = Math.round(seconds * 48000);
  let data: Float32Array | undefined;
  return { duration: seconds, numberOfChannels: 1, sampleRate: 48000, length, getChannelData: () => (data ??= new Float32Array(length)) } as unknown as AudioBuffer;
}

export const fakeListener = (): AudioListener => ({ plane: 'surface', x: 24, y: 24, level: 1, rightX: 1, rightY: 0, dist: 30 });
