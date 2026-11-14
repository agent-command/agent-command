import { describe, expect, it } from 'vitest';
import type { Color, InstancedMesh } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { TICK_RATE, type View } from '@agent-command/game/contract';
import { ChargeModels, PIPS_MAX, STICKS_MAX, chargeBlink, chargeBlinkPhase, chargeBlinkRate, chargeElapsed, chargeHeat, chargePips, chargeSticks } from '../src/world/charges.ts';
import { Telegraphs } from '../src/world/telegraphs.ts';
import { Combat } from '../src/world/combat.ts';
import { applyFade } from '../src/world/fade.ts';
import { THREAT_COLOR, sideColor } from '../src/world/common.ts';

const MS = 1000 / TICK_RATE;
/** Server tick → screen ms: tick t is on screen at t × 50 ms. */
const at = (tick: number): number => tick * MS;
/** A colour as the instance buffers store it (float32), and the colour at instance `i` of a buffer of `stride`. */
const f32 = (c: Color): number[] => Array.from(Float32Array.of(c.r, c.g, c.b));
const rgbAt = (a: Float32Array, i: number, stride: number): number[] => Array.from(a.subarray(i * stride, i * stride + 3));

function setup(charges: View['charges']) {
  applyFade(0); // focused on the Depths
  const view = createGame({ seed: 1 }).view('nw');
  view.tick = 100;
  view.charges = charges;
  const models = new ChargeModels(48);
  const mesh = (name: string) => models.root.getObjectByName(name) as InstancedMesh;
  const show = (v: View, now: number) => {
    models.ingest(v, at(v.tick), MS);
    models.frame(now, 1 / 60);
  };
  return { view, models, mesh, show };
}

describe('charge view logic', () => {
  it('adds sticks and pips per sapper on a stack, capped', () => {
    expect(chargeSticks(undefined)).toBe(3);
    expect([1, 2, 3, 4].map(chargeSticks)).toEqual([3, 5, 7, 9]);
    expect(chargeSticks(40)).toBe(STICKS_MAX);
    // a hostile charge's stack is unknown: no pips; a lone charge needs none
    expect(chargePips(undefined)).toBe(0);
    expect(chargePips(1)).toBe(0);
    expect(chargePips(3)).toBe(3);
    expect(chargePips(40)).toBe(PIPS_MAX);
  });

  it('blinks faster and faster as the detonation tick nears, with a continuous phase', () => {
    let rate = 0, phase = -Infinity;
    for (let left = 30; left >= 0; left -= 0.5) {
      expect(chargeBlinkRate(left)).toBeGreaterThan(rate);
      expect(chargeBlinkPhase(left)).toBeGreaterThan(phase);
      const b = chargeBlink(left);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
      rate = chargeBlinkRate(left);
      phase = chargeBlinkPhase(left);
    }
    expect(chargeBlinkRate(0)).toBeGreaterThan(5 * chargeBlinkRate(20));
    // the phase is the rate's integral: its slope over a short step is the rate there
    const dt = 1e-3;
    expect((chargeBlinkPhase(4 - dt) - chargeBlinkPhase(4)) / dt).toBeCloseTo(chargeBlinkRate(4), 2);
  });

  it('fills the countdown toward detonation and heats up in the public window', () => {
    expect(chargeElapsed(10, 10)).toBe(0);
    expect(chargeElapsed(5, 10)).toBeCloseTo(0.5);
    expect(chargeElapsed(0, 10)).toBe(1);
    expect(chargeElapsed(12, 10)).toBe(0);
    expect(chargeHeat(8, 5)).toBe(0);
    expect(chargeHeat(5, 5)).toBe(0);
    expect(chargeHeat(4, 5)).toBe(1);
    expect(chargeHeat(0, 5)).toBe(0);
  });
});

describe('charge models', () => {
  it('draws only the listed charges: a bundle per charge, more sticks and pips on a stack, the band in the planter colour', () => {
    const { view, models, mesh, show } = setup([
      { x: 10, y: 12, tick: 300, side: 'nw', stack: 3 },
      { x: 18, y: 12, tick: 260, side: 'se' },
    ]);
    show(view, at(view.tick));
    expect(models.drawn).toBe(2);
    expect(mesh('charge-sticks').count).toBe(7 + 3);
    expect(mesh('charge-bands').count).toBe(7 + 3);
    expect(mesh('charge-pips').count).toBe(3);
    expect(mesh('charge-fuses').count).toBe(2);
    expect(mesh('charge-sparks').count).toBe(2);
    const band = models['bandTint'].array as Float32Array;
    const se = sideColor('se'), nw = sideColor('nw');
    expect(rgbAt(band, 0, 3)).toEqual(f32(nw));
    expect(rgbAt(band, 7, 3)).toEqual(f32(se));
    // the hostile charge's dial is in threat amber
    const dial = models['dialTint'].array as Float32Array;
    expect(rgbAt(dial, 1, 4)).toEqual(f32(THREAT_COLOR));

    // nothing for an empty list
    view.charges = [];
    show(view, at(view.tick));
    expect(models.drawn).toBe(0);
    expect(mesh('charge-sticks').count).toBe(0);
  });

  it('removes a charge at its detonation tick on screen, and one that leaves the list (defused, or out of knowledge)', () => {
    const { view, models, show } = setup([
      { x: 10, y: 12, tick: 140, side: 'nw', stack: 1 },
      { x: 18, y: 12, tick: 400, side: 'se' },
    ]);
    show(view, at(view.tick));
    expect(models.drawn).toBe(2);
    // the first blows at tick 140 on screen: the collapse effect takes over
    models.frame(at(140), 1 / 60);
    expect(models.drawn).toBe(1);
    // the next view no longer lists the hostile one (defused, or a hostile charge we stop knowing): gone at once
    view.tick = 150;
    view.charges = [{ x: 10, y: 12, tick: 140, side: 'nw', stack: 1 }];
    show(view, at(150));
    expect(models.drawn).toBe(0);
  });

  it('burns the fuse down as the countdown runs', () => {
    const { view, mesh, show, models } = setup([{ x: 10, y: 12, tick: 300, side: 'nw', stack: 1 }]);
    const fuseLen = () => mesh('charge-fuses').instanceMatrix.array[5]!;
    show(view, at(view.tick));
    const early = fuseLen();
    models.frame(at(290), 1 / 60);
    expect(fuseLen()).toBeLessThan(early);
  });

  it('hides everything while the Depths is not drawn', () => {
    const { view, models, show } = setup([{ x: 10, y: 12, tick: 300, side: 'nw', stack: 1 }]);
    applyFade(3);
    show(view, at(view.tick));
    expect(models.drawn).toBe(0);
  });
});

describe('Surface charge telegraph', () => {
  it('is a dashed charge stamp on the collapse radius, faint until the public window', () => {
    applyFade(1); // focused on the Surface
    const view = createGame({ seed: 1 }).view('nw');
    view.tick = 100;
    view.fx = [];
    view.charges = [{ x: 20, y: 20, tick: 100 + 8 * TICK_RATE, side: 'se' }];
    const tg = new Telegraphs(new Combat(undefined, 48), 48);
    const stamps = tg['stamps'] as InstancedMesh;
    const data = tg['stampData'].array as Float32Array;
    const tint = tg['stampTint'].array as Float32Array;
    tg.ingest(view, at, at(view.tick));
    tg.frame(at(view.tick), 'nw');
    expect(stamps.count).toBe(1);
    const { collapseRadius, chargePublicTime } = view.match!.rules.depths;
    // ring band at 0.84 of the stamp radius: on the collapse edge
    expect(stamps.instanceMatrix.array[0]! * 0.84).toBeCloseTo(collapseRadius);
    expect(data[3]).toBe(0);
    const faint = tint[3]!;
    expect(rgbAt(tint, 0, 4)).toEqual(f32(THREAT_COLOR));
    // inside the public window: full heat, stronger
    tg.frame(at(view.tick + (8 - chargePublicTime + 1) * TICK_RATE), 'nw');
    expect(data[3]).toBe(1);
    expect(tint[3]!).toBeGreaterThan(faint);
    // blown: gone
    tg.frame(at(view.tick + 8 * TICK_RATE), 'nw');
    expect(stamps.count).toBe(0);
  });
});
