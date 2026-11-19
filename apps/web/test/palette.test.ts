import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COLOURS, type Colour } from '@agent-command/game/contract';
import { SIDE_HEX, THREAT_HEX } from '../src/world/common.ts';
import { ACCESSIBLE_HEX } from '../src/observer.ts';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const tokens = new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
function color(name: string): string {
  const value = tokens.get(name);
  if (!value) throw new Error(`Missing palette token ${name}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias ? color(alias[1]!) : value;
}
function luminance(hex: string): number {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected opaque sRGB colour: ${hex}`);
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
function contrast(a: string, b: string): number {
  const x = luminance(color(a));
  const y = luminance(color(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('logo-derived dark GUI palette', () => {
  for (const face of ['--paper', '--paper-hi', '--paper-shade', '--paper-deep', '--paper-on', '--chrome-hover']) {
    const armyInks = COLOURS.flatMap((colour) => [`--army-${colour}-ink`, `--army-${colour}-ink-accessible`]);
    for (const ink of ['--ink', '--ink-soft', '--muted', ...armyInks, '--good', '--bad', '--warn', '--alloy-ink', '--energy-ink']) {
      it(`${ink} on ${face} meets WCAG AA for normal text`, () => {
        expect(contrast(ink, face)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  for (const face of ['--brand-gold', '--brand-amber']) {
    it(`on-gold action text on ${face} meets AA`, () => expect(contrast('--on-gold', face)).toBeGreaterThanOrEqual(4.5));
  }
  it('chrome faces are dark', () => {
    for (const face of ['--paper', '--paper-hi', '--paper-shade', '--paper-deep', '--paper-on']) expect(luminance(color(face))).toBeLessThan(0.05);
  });
  it('keeps brand and gameplay red distinct', () => {
    expect(color('--brand-red')).toBe('#e30000');
    expect(color('--army-red')).toBe('#ff4f5e');
    expect(color('--army-blue')).toBe('#3aa8ff');
    expect(contrast('--chrome-white', '--brand-maroon')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('--chrome-white', '--brand-red')).toBeGreaterThanOrEqual(4.5);
  });
  it('the splash line keeps AA against its black outline', () => expect(contrast('--splash-ink', '--chrome-black')).toBeGreaterThanOrEqual(4.5));
});

/**
 * Colour-vision deficiency: each colour simulated as a full dichromat sees it (Machado, Oliveira & Fernandes 2009,
 * severity 1.0, applied to linear sRGB), then compared in CIELAB (ΔE*ab, D65).
 */
const DICHROMACY: Readonly<Record<string, readonly (readonly number[])[]>> = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
function lab(hex: string, vision: readonly (readonly number[])[]): [number, number, number] {
  const linear = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = vision.map((row) => Math.min(1, Math.max(0, row[0]! * linear[0]! + row[1]! * linear[1]! + row[2]! * linear[2]!)));
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const x = f((0.4124 * r! + 0.3576 * g! + 0.1805 * b!) / 0.95047), y = f(0.2126 * r! + 0.7152 * g! + 0.0722 * b!), z = f((0.0193 * r! + 0.1192 * g! + 0.9505 * b!) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a: string, b: string, vision: readonly (readonly number[])[]): number => {
  const p = lab(a, vision), q = lab(b, vision);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};
/**
 * Armies are told apart at a glance on small, scattered marks (units, rings, minimap pips), never side by side. ΔE*ab
 * ≈ 2.3 is one just-noticeable difference for adjacent patches; ≥ 20 (about ten JNDs, the margin categorical map
 * palettes use) keeps two colours reading as different categories at a glance. The drawn army colours (also the
 * swatches), the standard text inks and the observer's accessible inks must each hold it under every dichromacy.
 */
const CATEGORICAL_DELTA_E = 20;

describe('army colours under colour-vision deficiency', () => {
  it('draws exactly the CSS army swatches and accessible inks', () => {
    for (const colour of COLOURS) {
      expect(SIDE_HEX[colour]).toBe(color(`--army-${colour}`));
      expect(ACCESSIBLE_HEX[colour]).toBe(color(`--army-${colour}-ink-accessible`));
    }
    expect(THREAT_HEX).toBe(color('--threat'));
  });
  for (const [vision, matrix] of Object.entries(DICHROMACY)) {
    it(`keeps every pair of army colours, text inks and accessible inks apart (${vision})`, () => {
      const short: string[] = [];
      const ink = Object.fromEntries(COLOURS.map((colour) => [colour, color(`--army-${colour}-ink`)])) as Record<Colour, string>;
      for (const [set, hex] of [['drawn', SIDE_HEX], ['ink', ink], ['accessible', ACCESSIBLE_HEX]] as const) {
        for (let i = 0; i < COLOURS.length; i++) for (let j = i + 1; j < COLOURS.length; j++) {
          const a = COLOURS[i]!, b = COLOURS[j]!;
          const d = deltaE(hex[a], hex[b], matrix);
          if (d < CATEGORICAL_DELTA_E) short.push(`${set} ${a}/${b}: ${d.toFixed(1)}`);
        }
      }
      // Threat telegraphs (charges, breaches) stand apart from every army colour too (world/common.ts THREAT_HEX).
      for (const colour of COLOURS) {
        const d = deltaE(THREAT_HEX, SIDE_HEX[colour], matrix);
        if (d < CATEGORICAL_DELTA_E) short.push(`threat/${colour}: ${d.toFixed(1)}`);
      }
      expect(short).toEqual([]);
    });
  }
});

describe('dark chrome regressions', () => {
  const dir = new URL('../src/', import.meta.url);
  const sheets = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')] as const);
  it('chrome stylesheets use palette tokens: no hard-coded colours outside the :root palette', () => {
    const offenders: string[] = [];
    for (const [file, text] of sheets) {
      const body = file === 'style.css' ? text.replace(/:root\s*\{[\s\S]*?\n\}/, '') : text;
      for (const m of body.matchAll(/#[\da-f]{3,8}\b(?![\w-])|\b(?:rgba?|hsla?)\(/gi)) offenders.push(`${file}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
  it('the outcome title is drawn on its own face, never multiplied into the dark backdrop', () => {
    const rule = /\.outcome-title\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).not.toMatch(/mix-blend-mode/);
    expect(rule).toMatch(/background:\s*var\(--paper-deep\)/);
  });
  it('placeholders use the muted ink, not the UA grey', () => {
    expect(/::placeholder\s*\{([^}]*)\}/.exec(css)?.[1]).toMatch(/color:\s*var\(--muted\)/);
  });
});
