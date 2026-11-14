import { vi } from 'vitest';
import type { AudioListener } from '../src/audio/engine.ts';

/** Minimal AudioContext stand-in: nodes record connections and parameter automation, decoding is stubbed. */
export function fakeContext(decode: (b: ArrayBuffer) => Promise<AudioBuffer>, level = 0) {
  const started: AudioBuffer[] = [];
  const starts: { buffer: AudioBuffer; when: number; offset: number; duration: number | undefined; src: { connect: ReturnType<typeof vi.fn> } }[] = [];
  const param = () => ({ value: 1, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), cancelAndHoldAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
  const node = () => ({ connect: vi.fn((n: unknown) => n), disconnect: vi.fn(), gain: param(), pan: param(), frequency: param(), Q: param(), type: '' });
  const compressor = { ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() };
  const ctx = {
    state: 'running', currentTime: 0, sampleRate: 48000, destination: node(),
    createGain: node, createStereoPanner: node, createBiquadFilter: node,
    createDynamicsCompressor: () => compressor,
    createAnalyser: () => ({ ...node(), fftSize: 2048, getFloatTimeDomainData: (b: Float32Array) => b.fill(level) }),
    createBufferSource: () => {
      const n = { ...node(), playbackRate: param(), buffer: null as AudioBuffer | null, loop: false, loopStart: 0, loopEnd: 0, start: vi.fn((when?: number, offset?: number, duration?: number) => { if (n.buffer) { started.push(n.buffer); starts.push({ buffer: n.buffer, when: when ?? 0, offset: offset ?? 0, duration, src: n }); } }), stop: vi.fn() };
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
