// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDiveEffects } from '../src/motion.ts';
import { CameraRig } from '../src/world/camera.ts';
import { DIVES, diveLook, diveStyle, inkActive, restingLook, type DiveStyle } from '../src/world/dive.ts';

const reduceMotion = (on: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: on && query.includes('reduce'), media: query }));
afterEach(() => {
  vi.unstubAllGlobals();
  setDiveEffects(true);
});

describe('dive style', () => {
  it('inks chosen planes and the tour, never a tracked unit; the setting turns the ink off; reduced motion always crossfades', () => {
    reduceMotion(false);
    expect([diveStyle('jump'), diveStyle('tour'), diveStyle('track')]).toEqual(['ink', 'ink', 'plain']);
    setDiveEffects(false);
    expect(localStorage.getItem('agent-command.dive-fx')).toBe('off');
    expect([diveStyle('jump'), diveStyle('tour'), diveStyle('track')]).toEqual(['plain', 'plain', 'plain']);
    reduceMotion(true);
    expect([diveStyle('jump'), diveStyle('tour'), diveStyle('track')]).toEqual(['fade', 'fade', 'fade']);
    setDiveEffects(true);
    expect([diveStyle('jump'), diveStyle('tour'), diveStyle('track')]).toEqual(['fade', 'fade', 'fade']);
  });
});

describe('dive look', () => {
  const look = restingLook();
  it('starts and lands on the unaltered frame in every style', () => {
    for (const style of ['ink', 'plain', 'fade'] as DiveStyle[]) {
      for (const k of [0, 1]) {
        diveLook(look, k, 1, style, 1);
        expect(inkActive(look), `${style} at ${k}`).toBe(false);
        expect(look.wash).toBeCloseTo(0, 12);
        expect(look.swing).toBeCloseTo(0, 12);
        expect(look.fov).toBeCloseTo(0, 12);
        expect(look.ease).toBe(k);
      }
    }
  });
  it('ink peaks mid-dive (smear, chromatic split, lines), leads into the destination tint late and punches on landing', () => {
    diveLook(look, 0.5, 1, 'ink', 1);
    expect(look.smear).toBeCloseTo(1, 6);
    expect(look.chroma).toBeCloseTo(1, 6);
    expect(look.lines).toBe(1);
    expect(look.grain).toBeCloseTo(1, 6);
    expect(look.wash).toBe(0);
    const mid = look.tint;
    diveLook(look, 0.8, 1, 'ink', 1);
    expect(look.tint).toBeGreaterThan(mid);
    expect(look.chroma).toBeLessThan(0.2);
    // The landing kick narrows the view below the plain swing.
    expect(look.fov).toBeLessThan(look.swing * 16 - 1);
  });
  it('plain keeps the camera swing without any ink; the tour is faint', () => {
    diveLook(look, 0.5, 1, 'plain', 1);
    expect(look.swing).toBe(1);
    expect(inkActive(look)).toBe(false);
    diveLook(look, 0.5, 1, 'ink', DIVES.tour.fx);
    expect(look.lines).toBeLessThan(0.4);
    expect(DIVES.track.fx).toBe(0);
  });
  it('fade never moves the camera and swaps planes only while the page wash covers the frame', () => {
    for (let k = 0; k <= 1; k += 0.01) {
      diveLook(look, k, 3, 'fade', 1);
      expect(look.swing).toBe(0);
      expect(look.fov).toBe(0);
      expect(look.lines + look.smear + look.chroma + look.tint + look.grain).toBe(0);
    }
    diveLook(look, 0.49, 1, 'fade', 1);
    expect([look.ease, look.wash]).toEqual([0, 1]);
    diveLook(look, 0.51, 1, 'fade', 1);
    expect([look.ease, look.wash]).toEqual([1, 1]);
  });
});

describe('camera rig dives', () => {
  const ms = DIVES.jump.ms;
  it('a chosen plane lands within the short jump, inked; choosing it again mid-dive lands at once', () => {
    reduceMotion(false);
    expect(ms).toBeLessThanOrEqual(450);
    const rig = new CameraRig(48);
    rig.goTo('sky', 0, 'jump');
    rig.update(ms / 2, 0, 0);
    expect(rig.diving).toBe(true);
    expect(rig.diveDir).toBe(1);
    expect(rig.level).toBeCloseTo(1.5, 6);
    expect(inkActive(rig.look)).toBe(true);
    rig.goTo('sky', ms / 2, 'jump');
    expect(rig.diving).toBe(false);
    expect(rig.level).toBe(2);
    expect(inkActive(rig.look)).toBe(false);
    rig.goTo('depths', 1000, 'jump');
    rig.update(1000 + ms / 4, 0, 0);
    expect(rig.diveDir).toBe(-1);
    rig.update(1000 + ms, 0, 0);
    expect(rig.diving).toBe(false);
    expect(rig.level).toBe(0);
    expect(rig.camera.fov).toBe(50);
  });
  it('reduced motion holds the camera and swaps the plane under the wash', () => {
    reduceMotion(true);
    const rig = new CameraRig(48);
    rig.goTo('sky', 0, 'jump');
    rig.update(ms * 0.4, 0, 0);
    expect([rig.level, rig.camera.fov, rig.look.wash]).toEqual([1, 50, 1]);
    expect(inkActive(rig.look)).toBe(false);
    rig.update(ms * 0.6, 0, 0);
    expect([rig.level, rig.camera.fov, rig.look.wash]).toEqual([2, 50, 1]);
    rig.update(ms, 0, 0);
    expect(rig.diving).toBe(false);
    expect(rig.look.wash).toBe(0);
  });
  it('the setting off keeps the camera dive without ink; tracking a unit glides without ink', () => {
    reduceMotion(false);
    setDiveEffects(false);
    const rig = new CameraRig(48);
    rig.goTo('orbit', 0, 'jump');
    rig.update(ms / 2, 0, 0);
    expect(rig.look.swing).toBe(1);
    expect(inkActive(rig.look)).toBe(false);
    setDiveEffects(true);
    rig.update(ms, 0, 0);
    rig.goTo('surface', 0, 'track');
    rig.update(ms, 0, 0);
    expect(rig.diving).toBe(true);
    expect(inkActive(rig.look)).toBe(false);
    rig.update(DIVES.track.ms, 0, 0);
    expect(rig.level).toBe(1);
  });
});
