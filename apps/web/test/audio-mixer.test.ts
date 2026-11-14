import { describe, expect, it } from 'vitest';
import { ALERT_CUES, SFX, SFX_CATEGORIES } from '../src/audio/catalog.ts';
import { AlertGate, MIN_LEVEL, VOICES, VoicePool } from '../src/audio/mixer.ts';

describe('audio: effect voice limiting', () => {
  it('reserves alert capacity independently of simultaneous economy receipts', () => {
    const pool = new VoicePool();
    expect(pool.claim('construction', 0.9, 0, 0, 2)).toBeGreaterThanOrEqual(0);
    expect(pool.claim('research', 0.9, 0, 0, 2)).toBeGreaterThanOrEqual(0);
    expect(pool.claim('cargo_unload', 0.6, 0, 0, 2)).toBe(-1);
    expect(pool.claim('alert', 0.7, 0, 0, 1)).toBeGreaterThanOrEqual(0);
    expect(pool.count(0, 'alert')).toBe(1);
    expect(Object.values(SFX_CATEGORIES).reduce((n, c) => n + c.max, 0)).toBeLessThanOrEqual(VOICES);
  });

  it('caps a 40-ship brawl at the weapon category limit', () => {
    const pool = new VoicePool();
    const kinds = ['w_rifle', 'w_cannon', 'w_flak', 'w_missile', 'w_beam', 'w_skiff', 'w_bastion_pd', 'w_pd', 'w_bomb', 'w_turret'] as const;
    let played = 0;
    // 40 ships firing within one 50 ms tick, staggered starts so per-sound gaps don't hide the category cap
    for (let i = 0; i < 40; i++) if (pool.claim(kinds[i % kinds.length]!, 0.5, 0, 0.001 * i + Math.floor(i / 10) * 0.2, 2) >= 0) played++;
    expect(pool.count(0.05, 'weapon')).toBeLessThanOrEqual(SFX_CATEGORIES.weapon.max);
    expect(played).toBeGreaterThan(0);
    expect(pool.count(0.05)).toBeLessThanOrEqual(VOICES);
  });

  it('limits concurrent copies of one sound and their retrigger rate', () => {
    const pool = new VoicePool();
    const max = SFX.w_cannon.max;
    let n = 0;
    for (let i = 0; i < 20; i++) if (pool.claim('w_cannon', 0.5, i * 0.1, i * 0.1, 5) >= 0) n++;
    expect(pool.count(2, undefined, 'w_cannon')).toBeLessThanOrEqual(max);
    // a second start within the gap is dropped
    const p2 = new VoicePool();
    expect(p2.claim('w_rifle', 0.5, 0, 0, 0.3)).toBeGreaterThanOrEqual(0);
    expect(p2.claim('w_rifle', 0.5, 0, 0.01, 0.3)).toBe(-1);
    expect(p2.claim('w_rifle', 0.5, 0.1, 0.1, 0.3)).toBeGreaterThanOrEqual(0);
  });

  it('steals the quietest voice for a louder sound and drops quieter newcomers', () => {
    const pool = new VoicePool();
    const max = SFX_CATEGORIES.explosion.max;
    const ids = ['imp_small', 'exp_large', 'collapse', 'asteroid_impact', 'volatile', 'imp_small'] as const;
    for (let i = 0; i < max; i++) expect(pool.claim(ids[i]!, 0.2 + i * 0.01, 0, i * 0.1, 10)).toBeGreaterThanOrEqual(0);
    expect(pool.count(1, 'explosion')).toBe(max);
    expect(pool.claim('exp_large', 0.1, 1, 1, 2)).toBe(-1);
    expect(pool.claim('exp_large', 0.9, 1, 1, 2)).toBeGreaterThanOrEqual(0);
    expect(pool.stolen).toBe(true);
    expect(pool.count(1, 'explosion')).toBe(max);
  });

  it('skips inaudible sounds', () => {
    expect(new VoicePool().claim('w_rifle', MIN_LEVEL / 2, 0, 0, 1)).toBe(-1);
  });
});

describe('audio: alert chirp rate limiting', () => {
  it('limits each important-moment cue by its own cooldown', () => {
    const a = new AlertGate();
    expect(a.allow('base_under_attack', 0)).toBe(true);
    expect(a.allow('base_under_attack', 5000)).toBe(false);
    expect(a.allow('base_under_attack', ALERT_CUES.base_under_attack + 1)).toBe(true);
  });

  it('keeps simultaneous different alerts from stacking', () => {
    const a = new AlertGate();
    expect(a.allow('asteroid_incoming', 0)).toBe(true);
    expect(a.allow('breakthrough', 100)).toBe(false);
    expect(a.allow('breakthrough', 1300)).toBe(true);
    a.reset();
    expect(a.allow('asteroid_incoming', 1400)).toBe(true);
  });
});
