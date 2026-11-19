/**
 * The bots' deterministic Math (src/util/fdlibm.js) is PlayerThree's fdlibm port, vendored: the copy holds P3's source
 * verbatim and gives bit-identical results to the port P3's policy runtimes install, on a large seeded input set. A P3
 * update that changes the port fails here until the copy is re-vendored (and the bot packages rebuilt).
 */
import { readFileSync } from 'node:fs';
import { DETERMINISTIC_MATH_FUNCTIONS, DETERMINISTIC_MATH_SOURCE } from 'playerthree/policy';
import { describe, expect, it } from 'vitest';
import { botLibrary } from '../src/bots/library.ts';
import { dmath } from '../src/util/fdlibm.js';

type MathFn = (...args: number[]) => number;

/** P3's port as its runtimes install it: the source string evaluated over a Math-like object. */
const p3: Record<string, MathFn> = { sqrt: Math.sqrt };
(new Function(`return ${DETERMINISTIC_MATH_SOURCE}`)() as (m: object) => void)(p3);
const ours = dmath as unknown as Record<string, MathFn>;

/** Inputs per function (pairs for the binary ones). */
const INPUTS = 50_000;
const BINARY: readonly string[] = ['atan2', 'pow', 'hypot'];
const SPECIAL = [0, -0, 1, -1, Infinity, -Infinity, NaN, 0.5, -0.5, 2, -2, 1e-300, 5e-324, -5e-324, 2.2250738585072014e-308,
  1.7976931348623157e308, 1e22, 709.782712893384, -745.1332191019411, Math.PI / 2, Math.PI, 2 * Math.PI];

/** Seeded inputs: special values, raw bit patterns over every exponent, and game-scale magnitudes (angles, tiles). */
function inputs(seed: number, n: number): Float64Array {
  let s = seed | 0;
  const next = (): number => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  const f = new Float64Array(1), w = new Uint32Array(f.buffer);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (i < SPECIAL.length) { out[i] = SPECIAL[i]!; continue; }
    switch (i % 3) {
      case 0: w[0] = next(); w[1] = next(); out[i] = f[0]!; break;
      case 1: out[i] = (next() / 0x1_0000_0000 - 0.5) * 4 * Math.PI; break;
      default: out[i] = (next() / 0x1_0000_0000 - 0.5) * 2 * 256 + next() / 0x1_0000_0000 / 1024;
    }
  }
  return out;
}

describe('deterministic Math (util/fdlibm.js)', () => {
  it('vendors P3 DETERMINISTIC_MATH_SOURCE verbatim', () => {
    expect(readFileSync(new URL('../src/util/fdlibm.js', import.meta.url), 'utf8')).toContain(DETERMINISTIC_MATH_SOURCE);
  });

  it('is the only transcendental Math in the bot library', () => {
    const native = new RegExp(`\\bMath\\.(${DETERMINISTIC_MATH_FUNCTIONS.join('|')})\\b`);
    // `a ** b` is the engine's pow, which differs between engines like Math.pow.
    const power = /[\w)\]]\s*\*\*\s*[\w(.-]/;
    const offenders: string[] = [];
    for (const [path, text] of botLibrary().plain) {
      if (path.endsWith('/util/fdlibm.js')) continue;
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const line of code.split('\n')) if (native.test(line) || power.test(line)) offenders.push(`${path}: ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it.each(DETERMINISTIC_MATH_FUNCTIONS)('%s equals P3 bit for bit', (name) => {
    const a = inputs(0x9e3779b9 ^ DETERMINISTIC_MATH_FUNCTIONS.indexOf(name), INPUTS);
    const b = inputs(0x85ebca6b ^ DETERMINISTIC_MATH_FUNCTIONS.indexOf(name), INPUTS);
    const mine = ours[name]!, theirs = p3[name]!, binary = BINARY.includes(name);
    let diffs = 0, first = '';
    for (let i = 0; i < INPUTS; i++) {
      const x = binary ? mine(a[i]!, b[i]!) : mine(a[i]!);
      const y = binary ? theirs(a[i]!, b[i]!) : theirs(a[i]!);
      if (!Object.is(x, y)) { diffs++; first ||= `${name}(${a[i]}${binary ? `, ${b[i]}` : ''}) = ${x} ≠ ${y}`; }
    }
    expect(first).toBe('');
    expect(diffs).toBe(0);
  });
});
