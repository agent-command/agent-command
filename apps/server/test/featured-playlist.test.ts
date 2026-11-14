import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERSONALITY_SEED_MAX, resolveRules, type MatchOptions } from '@agent-command/game';
import { validateMatch } from '../src/arena-input.ts';
import {
  ADAPT_MIN_SAMPLES, armyRating, FeaturedPlaylist, featuredBotSeats, featuredRules, LOPSIDED_WEIGHT, MAX_RATING_GAP, RECENT_WINDOW, SHORT_GAME_MS,
  SHORT_WEIGHT, SHOWCASES, withinGate, type PlaylistEntry,
} from '../src/featured-playlist.ts';

const draw = (seed: number, count: number) => {
  const playlist = new FeaturedPlaylist({ seed });
  return Array.from({ length: count }, () => playlist.next());
};
const novices = (army: PlaylistEntry['armies'][number]) => Object.values(army.planes).filter((value) => value === 'novice').length;
const all = (value: 'novice' | 'standard' | 'veteran') => ({ depths: value, surface: value, sky: value, orbit: value });

describe('featured playlist', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    expect(draw(1, 40)).toEqual(draw(1, 40));
    expect(draw(2, 40).map((entry) => entry.key)).not.toEqual(draw(1, 40).map((entry) => entry.key));
  });

  it('admits only pairings within the balance gap', () => {
    expect(withinGate([armyRating({ planes: all('veteran'), aggressionShift: 0.2 }), armyRating({ planes: all('standard'), aggressionShift: 0 })])).toBe(true);
    expect(withinGate([armyRating({ planes: all('standard'), aggressionShift: 0.2 }), armyRating({ planes: all('novice'), aggressionShift: 0 })])).toBe(false);
    expect(withinGate([armyRating({ planes: { ...all('standard'), orbit: 'novice' }, aggressionShift: 0 }), armyRating({ planes: all('veteran'), aggressionShift: 0 })])).toBe(false);
    for (const seed of [1, 7, 99]) {
      for (const entry of draw(seed, 200)) {
        const ratings = entry.armies.map((army) => army.rating);
        expect(Math.max(...ratings) - Math.min(...ratings)).toBeLessThanOrEqual(MAX_RATING_GAP + 1e-9);
        for (const army of entry.armies) expect(army.rating).toBeCloseTo(armyRating(army));
        // A mostly-Novice army only ever meets mostly-Novice armies (Standard beats Novice in every sweep).
        if (entry.armies.some((army) => novices(army) >= 3)) expect(entry.armies.every((army) => novices(army) >= 3)).toBe(true);
      }
    }
  });

  it('varies: no immediate repeats, FFA between 1 in 4 and 1 in 3, maps, showcases and profiles all move', () => {
    for (const seed of [1, 7, 99]) {
      const entries = draw(seed, 200);
      for (const [index, entry] of entries.entries()) {
        const recent = entries.slice(Math.max(0, index - RECENT_WINDOW), index);
        expect(recent.map((other) => other.key)).not.toContain(entry.key);
        if (index > 0) expect(entry.armies.length > 2 && entries[index - 1]!.armies.length > 2).toBe(false);
      }
      const ffa = entries.filter((entry) => entry.armies.length === 4).length / entries.length;
      expect(ffa).toBeGreaterThanOrEqual(0.25);
      expect(ffa).toBeLessThanOrEqual(1 / 3);
      expect(new Set(entries.map((entry) => entry.mapId)).size).toBeGreaterThanOrEqual(10);
      expect(new Set(entries.map((entry) => entry.showcase)).size).toBe(SHOWCASES.length);
      expect(new Set(entries.map((entry) => entry.size)).size).toBe(3);
      const armies = entries.flatMap((entry) => entry.armies);
      expect(armies.some((army) => army.aggressionShift > 0) && armies.some((army) => army.aggressionShift < 0)).toBe(true);
      expect(armies.some((army) => new Set(Object.values(army.planes)).size > 1)).toBe(true);
      expect(entries.some((entry) => new Set(entry.armies.map((army) => army.profile)).size > 1)).toBe(true);
    }
  });

  it('plays duels only while an FFA does not fit', () => {
    const playlist = new FeaturedPlaylist({ seed: 3 });
    for (let i = 0; i < 30; i++) expect(playlist.next({ maxArmies: 2 }).armies).toHaveLength(2);
    // The owed share is capped: freed capacity brings FFAs back without an FFA run.
    const after = Array.from({ length: 10 }, () => playlist.next());
    expect(after.filter((entry) => entry.armies.length === 4).length).toBeGreaterThan(0);
    expect(after.filter((entry) => entry.armies.length === 4).length).toBeLessThanOrEqual(5);
  });

  it('down-weights a pairing class that keeps ending lopsided or very short, and draws it less', () => {
    const baseline = draw(5, 300);
    const counts = new Map<string, number>();
    for (const entry of baseline) if (entry.armies.length === 2 && entry.armies[0]!.profile !== entry.armies[1]!.profile) counts.set(entry.pairing, (counts.get(entry.pairing) ?? 0) + 1);
    const [pairing, before] = [...counts].toSorted((a, b) => b[1] - a[1])[0]!;
    const sample = baseline.find((entry) => entry.pairing === pairing)!;
    const favourite = sample.armies.toSorted((a, b) => b.rating - a.rating)[0]!;
    const underdog = sample.armies.find((army) => army !== favourite)!;
    const won = (winner: string, durationMs = SHORT_GAME_MS * 2) => ({ outcomes: Object.fromEntries(sample.armies.map((army) => [army.id, army.id === winner ? 'win' : 'loss'] as const)), durationMs });

    const lopsided = new FeaturedPlaylist({ seed: 5 });
    for (let i = 0; i < ADAPT_MIN_SAMPLES - 1; i++) lopsided.record(sample, won(favourite.id));
    expect(lopsided.weight(pairing)).toBe(1);
    lopsided.record(sample, won(favourite.id));
    expect(lopsided.weight(pairing)).toBe(LOPSIDED_WEIGHT);
    const after = Array.from({ length: 300 }, () => lopsided.next()).filter((entry) => entry.pairing === pairing).length;
    expect(after).toBeLessThan(before / 2);

    // An even record keeps the class; a run of very short matches down-weights it on its own.
    const even = new FeaturedPlaylist({ seed: 5 });
    for (let i = 0; i < ADAPT_MIN_SAMPLES; i++) even.record(sample, won(i % 2 ? favourite.id : underdog.id));
    expect(even.weight(pairing)).toBe(1);
    const short = new FeaturedPlaylist({ seed: 5 });
    for (let i = 0; i < ADAPT_MIN_SAMPLES; i++) short.record(sample, won(i % 2 ? favourite.id : underdog.id, SHORT_GAME_MS / 2));
    expect(short.weight(pairing)).toBe(SHORT_WEIGHT);
  });

  it('resolves every entry to valid match rules and exact bot seats', () => {
    const entries = draw(11, 120);
    for (const showcase of SHOWCASES) expect(entries.some((entry) => entry.showcase === showcase.id)).toBe(true);
    for (const entry of entries) {
      const rules = resolveRules(featuredRules(entry, undefined) as MatchOptions);
      expect(rules.map.size).toBe(entry.size);
      const seats = featuredBotSeats(entry);
      expect(seats).toHaveLength(entry.armies.length * 4);
      for (const seat of seats) {
        const army = entry.armies.find((item) => item.id === seat.team)!;
        expect(seat.level).toBe(army.planes[seat.role]);
        expect(seat.options.aggression === undefined).toBe(army.aggressionShift === 0);
        expect(seat.options.personality).toBe(army.personality);
      }
    }
    const lava = entries.find((entry) => entry.showcase === 'lava-fields')!;
    expect(resolveRules(featuredRules(lava, undefined)).map.lavaLakes.lakes).toBe(3);
  });

  it('gives every army its own personality, so a mirror is two styles, and labels it honestly', () => {
    const entries = draw(13, 300);
    for (const entry of entries) {
      for (const army of entry.armies) {
        expect(Number.isSafeInteger(army.personality)).toBe(true);
        expect(army.personality).toBeGreaterThanOrEqual(1);
        expect(army.personality).toBeLessThanOrEqual(PERSONALITY_SEED_MAX);
      }
      expect(new Set(entry.armies.map((army) => army.personality)).size).toBe(entry.armies.length);
    }
    const mirrors = entries.filter((entry) => entry.armies.every((army) => army.profile === entry.armies[0]!.profile));
    expect(mirrors.length).toBeGreaterThan(0);
    // Mirrors are the minority now (MIRROR_SHARE plus the gate's Standard fallback).
    expect(mirrors.length / entries.length).toBeLessThan(0.3);
    for (const entry of mirrors) expect(entry.label).toContain(entry.armies.length > 2 ? ' · different styles' : 'mirror · different styles');
    // The same seed draws the same personalities.
    expect(draw(13, 40).map((entry) => entry.armies.map((army) => army.personality))).toEqual(entries.slice(0, 40).map((entry) => entry.armies.map((army) => army.personality)));
  });

  it('sets personalities only for Watch live: no other seat builder names them, and arena entrants cannot', () => {
    // Lobbies, practice, ranked and gauntlet seats, ACBench rosters, the web lobby and the game's lobby and arena
    // helpers build bot seats from the public knobs only; featuredBotSeats is the one place a personality is set.
    const root = new URL('../../../', import.meta.url);
    const sources = ['apps/server/src', 'apps/web/src', 'bench', 'packages/game/src/lobby', 'packages/game/src/agent', 'tools']
      .flatMap((dir) => readdirSync(new URL(dir, root), { recursive: true, withFileTypes: true })
        .filter((file) => file.isFile() && /\.(ts|js|mjs)$/.test(file.name) && !file.parentPath.includes('node_modules'))
        .map((file) => `${file.parentPath}/${file.name}`.slice(new URL(root).pathname.length)));
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.filter((path) => /personality/i.test(readFileSync(new URL(path, root), 'utf8')))).toEqual(['apps/server/src/arena-input.ts', 'apps/server/src/featured-playlist.ts']);

    const spec = (options: Record<string, number>) => ({
      format: 'playerthree.match', version: 1, game: 'agent-command', gameVersion: 'build', surfaceHash: 'surface', rulesHash: '', seed: 1,
      map: { id: 'duel', identity: '', seed: 1, layout: 'duel' }, options: {},
      sides: [{ id: 'nw', spawnSlot: 'nw', alliance: 'blue', seats: [{ role: 'surface', occupant: { kind: 'bot', level: 'standard', options } }] }],
      bindings: [{ seat: { team: 'nw', role: 'surface' }, entrantId: 'a' }], observerPolicy: { allowOmniscient: false, minDelayMs: 0 },
      rules: { ranked: false, coaching: 'off', practiceReasons: [] },
    });
    expect(() => validateMatch(spec({ aggression: 0.6 }))).not.toThrow();
    expect(() => validateMatch(spec({ personality: 5 }))).toThrow(expect.objectContaining({ code: 'bad_bot_options' }));
  });
});
