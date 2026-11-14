/**
 * Forward posts (DESIGN §4.2 Outposts): home posts and contested points. Placement (recipe and authored), capture,
 * vision, build radius, the healing pool, the time-cap score, rally safety reset, fog, bots.
 */
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { CELL, DEFAULT_RULES, isSurfaceBlocked, matchDataSchema, observationSchema, resolveRules, SURFACE, TERRAIN_PRESETS, TICK_RATE, type ArmyId, type MatchOptions, type TerrainPreset } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { ARMY_FIRST_OPENING, TIERS } from '../src/bots/tuning.ts';
import type { Ent } from '../src/sim/ent.ts';
import { entityData, mapEntities, validateMapDocument } from '../src/maps/document.ts';
import { generateMapDocument } from '../src/maps/maps.ts';
import { crowdsPost, flankAnchor, recipePosts } from '../src/maps/posts.ts';
import { slotSpires } from '../src/maps/templates.ts';
import { LODE_APRON, LODE_POCKET, placeLodes, prepareLodeSites } from '../src/maps/world.ts';
import { Rng } from '../src/util/rng.ts';
import { Sim } from '../src/sim/sim.ts';
import { canonX, canonY, NEUTRAL, rotX, rotY, slotOfArmyId, type Army } from '../src/util/teams.ts';
import { orbitAsymmetry } from './mirror.ts';

const BLUE = slotOfArmyId('nw', 2);
const RED = slotOfArmyId('se', 2);
const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
const generated = (terrain: TerrainPreset, size: number, slots: 2 | 4): MatchOptions => ({ terrain, map: { params: { size, slots } } });
/** Army `a`'s home post k (spawnPosts: home posts in army order, then the contested points). */
const postOf = (s: Sim, a: Army, k: number): Ent => s.posts.filter((_, i) => s.postHome[i] === a)[k]!;
/** The contested points, in spawn order (the centre first, then the flank orbit). */
const points = (s: Sim): Ent[] => s.posts.filter((_, i) => s.postHome[i]! < 0);
const isCentre = (s: Sim, p: Ent): boolean => p.x === s.size / 2 && p.y === s.size / 2;
/** Army `a`'s troopers headed for the centre point: a move onto it or an attack on it. */
const toCentre = (s: Sim, a: Army): number => {
  const centre = points(s).find((p) => isCentre(s, p))!;
  return s.ents.filter((e) => e.side === a && e.kind === 'trooper' && (e.order.k === 'attack' && e.order.target === centre.id
    || e.order.k === 'move' && Math.hypot(e.order.x - centre.x, e.order.y - centre.y) <= s.econ.postCaptureRadius)).length;
};

/** Walkable Surface cells reachable from (x, y). */
function reachable(s: Sim, x: number, y: number): Uint8Array {
  const seen = new Uint8Array(s.n);
  const start = Math.floor(y) * s.size + Math.floor(x);
  const queue = [start];
  seen[start] = 1;
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]!;
    const cx = c % s.size;
    for (const d of [cx > 0 ? c - 1 : -1, cx < s.size - 1 ? c + 1 : -1, c - s.size, c + s.size]) {
      if (d < 0 || d >= s.n || seen[d] || isSurfaceBlocked(s.terrain[d]!)) continue;
      seen[d] = 1;
      queue.push(d);
    }
  }
  return seen;
}

/** Spires and posts only (every start unit removed); home posts start held by their armies (homePostsOwned). */
function arena(options: MatchOptions = {}) {
  const g = createGame({ seed: 5, options });
  const s = g.sim;
  for (const e of s.ents) if (e.unit) e.hp = 0;
  g.step();
  return { g, s };
}

/** `n` hardy `army` troopers holding still at (x, y) (the Spires' fire must not matter). */
function troopers(g: AgentCommandGame, army: Army, x: number, y: number, n = 1): Ent[] {
  const units = Array.from({ length: n }, () => g.sim.spawnUnit(army, 'trooper', 'surface'));
  for (const u of units) {
    u.x = x;
    u.y = y;
    u.hp = u.maxHp = 50_000;
  }
  const team = g.sim.armyIds[army]!;
  expect(g.apply({ team, role: 'surface' }, { kind: 'stance', units: units.map((u) => id(g, team, u)), stance: 'hold' })).toEqual({ ok: true });
  return units;
}

describe('forward post placement', () => {
  const cases: [TerrainPreset, number, 2 | 4][] = [
    ...TERRAIN_PRESETS.map((p): [TerrainPreset, number, 2 | 4] => [p, 48, 2]),
    ...TERRAIN_PRESETS.map((p): [TerrainPreset, number, 2 | 4] => [p, 64, 4]),
    ['ridges', 80, 2], ['canyons', 80, 4], ['open', 64, 2], ['highlands', 80, 4],
  ];
  it.each(cases)('%s S%i, %i slots: postCount home posts per army on open, reachable ground, one toward each flank, and rotation-closed contested points', (preset, size, slots) => {
    const g = createGame({ seed: 11, options: generated(preset, size, slots) });
    const s = g.sim;
    const rules = s.rules.map;
    for (const a of s.allArmies) {
      const home = s.spireAt[a]!;
      const frame = s.armyFrame[a]!;
      const walk = reachable(s, home.x, home.y);
      const bearings: number[] = [];
      expect(s.posts.filter((_, i) => s.postHome[i] === a).length).toBe(rules.postCount);
      for (let k = 0; k < rules.postCount; k++) {
        const p = postOf(s, a, k);
        expect(p.kind).toBe('post');
        expect(p.plane).toBe('surface');
        const c = Math.floor(p.y) * size + Math.floor(p.x);
        expect([SURFACE.ground, SURFACE.high]).toContain(s.terrain[c]);
        expect(walk[c]).toBe(1);
        // Signed distance off the Spire→centre line (the canonical diagonal) in this army's frame.
        const off = (x: number, y: number): number => (canonY(frame, x, y, size) - canonX(frame, x, y, size)) / Math.SQRT2;
        expect(Math.abs(off(p.x, p.y))).toBeGreaterThanOrEqual(rules.postClearance);
        // The distance band is a preference among unreserved cells; public lode capacity now also excludes sites.
        for (const l of s.lodes) expect(Math.max(Math.abs(p.x - (l.c % size + 0.5)), Math.abs(p.y - (Math.floor(l.c / size) + 0.5)))).toBeGreaterThan(LODE_POCKET + LODE_APRON);
        // Exactly army 0's post k turned into this army's frame.
        const lead = postOf(s, 0, k);
        expect([p.x, p.y]).toEqual([rotX(frame, lead.x, lead.y, size), rotY(frame, lead.x, lead.y, size)]);
        // Bearing off the Spire→centre line in this army's frame (C2/C4: the NW corner, centre line at 45°).
        const cx = canonX(frame, p.x, p.y, size) - canonX(frame, home.x, home.y, size);
        const cy = canonY(frame, p.x, p.y, size) - canonY(frame, home.x, home.y, size);
        bearings.push(Math.atan2(cy, cx) - Math.PI / 4);
      }
      // One toward each flank.
      expect(Math.sign(bearings[0]!)).toBe(-1);
      expect(Math.sign(bearings[1]!)).toBe(1);
    }
    // Contested points: at most the centre plus one flank point per slot, rotation-closed, on ground every Spire reaches.
    const contested = points(s);
    const flanks = contested.filter((p) => !isCentre(s, p));
    expect(contested.length - flanks.length).toBeLessThanOrEqual(1);
    expect(flanks.length).toBe(slots);
    const walks = s.allArmies.map((a) => reachable(s, s.spireAt[a]!.x, s.spireAt[a]!.y));
    for (const p of flanks) {
      const c = Math.floor(p.y) * size + Math.floor(p.x);
      expect([SURFACE.ground, SURFACE.high, SURFACE.ford]).toContain(s.terrain[c]);
      for (const walk of walks) expect(walk[c]).toBe(1);
      for (let r = 4 / slots; r < 4; r += 4 / slots) expect(flanks.some((q) => q.x === rotX(r, p.x, p.y, size) && q.y === rotY(r, p.x, p.y, size))).toBe(true);
    }
    const team = s.armyIds[0]!;
    const data = g.matchData({ team, role: 'surface' });
    expect(validate(matchDataSchema, data).ok).toBe(true);
    expect(data.posts).toEqual(s.posts.map((p, i) => (s.postHome[i]! < 0
      ? { id: id(g, team, p), x: p.x, y: p.y, kind: 'contested' }
      : { id: id(g, team, p), x: p.x, y: p.y, kind: 'home', home: s.armyIds[s.postHome[i]!] })));
  });

  it('contested points: the centre plus one flank pair on C2 (3), the centre plus one flank quad on C4 (5), toward the centre from the flank lode anchors', () => {
    for (const slots of [2, 4] as const) {
      const s = createGame({ seed: 4, options: generated('open', 48, slots) }).sim;
      const contested = points(s);
      expect(contested.length).toBe(1 + slots);
      expect(isCentre(s, contested[0]!)).toBe(true);
      const anchor = flankAnchor(s.size, slots);
      // Slot 0's flank point: within a tile of contestedPostOffset from the anchor toward the centre (open ground).
      const half = s.size / 2;
      const t = s.rules.map.contestedPostOffset / Math.hypot(half - anchor.x, half - anchor.y);
      const [tx, ty] = [anchor.x + (half - anchor.x) * t, anchor.y + (half - anchor.y) * t];
      expect(Math.min(...contested.slice(1).map((p) => Math.hypot(p.x - tx, p.y - ty)))).toBeLessThanOrEqual(1);
      // Every army starts equally far from its nearest contested point (rotational fairness).
      const nearest = s.allArmies.map((a) => Math.min(...contested.map((p) => Math.hypot(p.x - s.spireAt[a]!.x, p.y - s.spireAt[a]!.y))));
      expect(new Set(nearest).size).toBe(1);
    }
    const none = createGame({ seed: 4, options: { map: { params: { contestedPosts: [] } } } }).sim;
    expect(points(none)).toEqual([]);
    const centre = createGame({ seed: 4, options: { map: { params: { contestedPosts: ['centre'] } } } }).sim;
    expect(points(centre).map((p) => [p.x, p.y])).toEqual([[24, 24]]);
  });

  it('home posts start held by their army (homePostsOwned), contested points neutral; off: every post starts neutral', () => {
    for (const slots of [2, 4] as const) {
      const s = createGame({ seed: 6, options: generated('ridges', 48, slots) }).sim;
      s.posts.forEach((p, i) => expect(p.side).toBe(s.postHome[i]! < 0 ? NEUTRAL : s.postHome[i]));
      expect(s.armies.every((t) => t.stats.postsCaptured === 0)).toBe(true);
      const off = createGame({ seed: 6, options: { ...generated('ridges', 48, slots), surface: { homePostsOwned: false } } }).sim;
      expect(off.posts.every((p) => p.side === NEUTRAL)).toBe(true);
      expect(off.posts.map((p) => [p.x, p.y])).toEqual(s.posts.map((p) => [p.x, p.y]));
    }
  });

  it('postsEnabled false places none (matchData.posts empty) and leaves the map unchanged; the recipe moves them', () => {
    const on = createGame({ seed: 3 });
    const off = createGame({ seed: 3, options: { surface: { postsEnabled: false } } });
    expect(off.sim.posts).toEqual([]);
    expect(off.sim.ents.some((e) => e.kind === 'post')).toBe(false);
    expect(off.matchData({ team: 'nw', role: 'surface' }).posts).toEqual([]);
    // Placement is a map recipe: the map (lodes included) is the same with posts switched off.
    expect(off.sim.mapHash).toBe(on.sim.mapHash);
    expect(off.sim.lodes.map((l) => l.c)).toEqual(on.sim.lodes.map((l) => l.c));
    const three = createGame({ seed: 3, options: { map: { params: { postCount: 3, postDistanceMin: 13, postDistanceMax: 14 } } } }).sim;
    expect(three.posts.length).toBe(6 + points(three).length);
    for (const a of three.allArmies) for (let k = 0; k < 3; k++) {
      const d = Math.hypot(postOf(three, a, k).x - three.spireAt[a]!.x, postOf(three, a, k).y - three.spireAt[a]!.y);
      expect(d).toBeGreaterThanOrEqual(13);
      expect(d).toBeLessThanOrEqual(14);
    }
  });

  it('post positions never depend on the secret lodes: two secrets, one public map, the same posts', () => {
    for (const sides of [2, 4] as const) {
      const [a, b] = [5, 2 ** 31 + 35].map((secret) => new Sim(5, {}, generateMapDocument(5, 'ridges', DEFAULT_RULES.map, sides, secret)));
      expect(a!.lodes.map((l) => l.c)).not.toEqual(b!.lodes.map((l) => l.c));
      expect(a!.posts.map((p) => [p.x, p.y])).toEqual(b!.posts.map((p) => [p.x, p.y]));
    }
  });

  it('public resource reservations redirect flags without deleting them or reading secret placements', () => {
    const size = DEFAULT_RULES.map.size;
    const terrain = new Uint8Array(size * size);
    const home = slotSpires(DEFAULT_RULES.map, 2)[0]!;
    const before = recipePosts(terrain, size, 2, home, DEFAULT_RULES.map);
    const reserved = new Uint8Array(size * size);
    for (const p of before.filter((p) => p.kind === 'home')) {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      for (let dy = -LODE_POCKET - LODE_APRON; dy <= LODE_POCKET + LODE_APRON; dy++) {
        for (let dx = -LODE_POCKET - LODE_APRON; dx <= LODE_POCKET + LODE_APRON; dx++) reserved[(y + dy) * size + x + dx] = 1;
      }
    }
    const after = recipePosts(terrain, size, 2, home, DEFAULT_RULES.map, reserved);
    expect(after).toHaveLength(before.length);
    expect(after).not.toEqual(before);
    for (const p of after) expect(reserved[Math.floor(p.y) * size + Math.floor(p.x)]).toBe(0);
    expect(recipePosts(terrain, size, 2, home, DEFAULT_RULES.map, reserved)).toEqual(after);
  });

  it.each([48, 64, 80])('generated S%i flags never intersect lode footprints/aprons, including narrow home bands', (size) => {
    for (const terrain of ['ridges', 'highlands'] as const) for (const slots of [2, 4] as const) {
      const g = createGame({ seed: 21, options: generated(terrain, size, slots) });
      const s = g.sim;
      expect(s.lodes.filter((l) => !l.rich)).toHaveLength(slots * s.rules.map.homeLodes);
      expect(s.posts.filter((_, i) => s.postHome[i]! >= 0)).toHaveLength(slots * s.rules.map.postCount);
      for (const l of s.lodes) for (const p of s.posts) {
        expect(Math.max(Math.abs(p.x - (l.c % size + 0.5)), Math.abs(p.y - (Math.floor(l.c / size) + 0.5))), `${terrain}/${slots}/${l.c}`).toBeGreaterThan(LODE_POCKET + LODE_APRON);
      }
    }
  });

  it('the lode generator keeps outcrops and aprons off the public posts when the band has room (open ground)', () => {
    const map = resolveRules({ map: { params: { contestedZones: [] } } }).map;
    const size = map.size;
    const n = size * size;
    const terrain = new Uint8Array(n);
    const spires = slotSpires(map, 2);
    const posts = recipePosts(terrain, size, 2, spires[0]!, map);
    expect(posts.length).toBe(2 * map.postCount + 3);
    for (const seed of [1, 2, 3, 4, 5]) {
      const placement = placeLodes(map, new Rng(seed), { cells: new Uint8Array(n).fill(CELL.rock), ore: new Uint8Array(n), magma: new Uint8Array(n), terrain }, 2, prepareLodeSites(map, terrain, new Uint8Array(n), 2), posts);
      expect(placement.lodes.length).toBe(2 * map.homeLodes);
      // The home band (6.5–10) and the post band (9–11) overlap, so postClearance itself is only a preference; never
      // covering a post is what open ground always allows.
      for (const l of placement.lodes) expect(crowdsPost(l.c, LODE_POCKET + LODE_APRON, posts, size, 0), `seed ${seed} lode ${l.c}`).toBe(false);
    }
  });
});

describe('authored forward posts', () => {
  const postEntities = (doc: ReturnType<typeof generateMapDocument>) => mapEntities(doc).filter((e) => e.__identifier === 'Post');

  it('a generated document stores its posts (one Post entity per orbit, the centre once) and the match spawns those', () => {
    // Seed 3 canyons keeps its centre reachable at both slot counts. (Seed 9's four-slot canyons centre is a sealed
    // cliff block (streams stop at cliffs), so its recipe rightly places no centre point.)
    for (const sides of [2, 4] as const) {
      const doc = generateMapDocument(3, 'canyons', DEFAULT_RULES.map, sides, 3);
      const half = doc.size / 2;
      const centre = (e: { px: number[] }) => e.px[0] === half && e.px[1] === half;
      const entities = postEntities(doc);
      expect(entities.filter((e) => entityData(e).kind === 'home').length).toBe(DEFAULT_RULES.map.postCount);
      expect(entities.filter((e) => entityData(e).kind === 'contested' && centre(e)).length).toBe(1);
      const s = new Sim(3, { map: { params: { slots: sides } } }, doc);
      expect(s.posts.length).toBe(entities.reduce((n, e) => n + (centre(e) ? 1 : sides), 0));
    }
  });

  it('a generated centre walled off from every Spire gets no centre point', () => {
    const doc = generateMapDocument(9, 'canyons', DEFAULT_RULES.map, 4, 9);
    const half = doc.size / 2;
    const s = new Sim(9, { map: { params: { slots: 4 } } }, doc);
    for (const c of [(half - 1) * s.size + half - 1, (half - 1) * s.size + half, half * s.size + half - 1, half * s.size + half]) expect(isSurfaceBlocked(s.terrain[c]!)).toBe(true);
    expect(postEntities(doc).some((e) => e.px[0] === half && e.px[1] === half)).toBe(false);
    expect(s.posts.some((p) => p.x === half && p.y === half)).toBe(false);
  });

  it('an authored document places its own posts; one with none gets the recipe', () => {
    const doc = generateMapDocument(5, 'open', DEFAULT_RULES.map, 2, 5);
    const recipe = new Sim(5, {}, structuredClone(doc)).posts.map((p) => [p.x, p.y]);
    const entities = mapEntities(doc);
    const home = postEntities(doc).find((e) => entityData(e).kind === 'home')!;
    // One home post moved a cell along x, the contested points dropped.
    const world = new Sim(5, {}, structuredClone(doc));
    const [x, y] = [home.__grid[0] + 1, home.__grid[1]];
    expect([SURFACE.ground, SURFACE.high]).toContain(world.terrain[y * world.size + x]);
    home.__grid = [x, y];
    home.px = [x + 0.5, y + 0.5];
    entities.splice(0, entities.length, ...entities.filter((e) => e.__identifier !== 'Post' || entityData(e).kind === 'home'));
    expect(validateMapDocument(doc).valid).toBe(true);
    const authored = new Sim(5, {}, doc);
    expect(points(authored)).toEqual([]);
    expect([postOf(authored, BLUE, 0).x, postOf(authored, BLUE, 0).y]).toEqual([x + 0.5, y + 0.5]);
    expect([postOf(authored, RED, 0).x, postOf(authored, RED, 0).y]).toEqual([rotX(2, x + 0.5, y + 0.5, 48), rotY(2, x + 0.5, y + 0.5, 48)]);
    expect(orbitAsymmetry(authored)).toBeUndefined();
    // Without any Post entity the match fills the recipe's posts.
    entities.splice(0, entities.length, ...entities.filter((e) => e.__identifier !== 'Post'));
    expect(new Sim(5, {}, doc).posts.map((p) => [p.x, p.y])).toEqual(recipe);
  });

  it('validation: a home post names its slot, a contested point none; a known kind; on reachable ground', () => {
    const doc = generateMapDocument(5, 'open', DEFAULT_RULES.map, 2, 5);
    const post = postEntities(doc).find((e) => entityData(e).kind === 'home')!;
    const slot = post.fieldInstances.find((f) => f.__identifier === 'slot')!;
    const kind = post.fieldInstances.find((f) => f.__identifier === 'kind')!;
    post.fieldInstances = [kind];
    expect(validateMapDocument(doc).errors).toContain('A home post names its slot; a contested point names none');
    kind.__value = 'contested';
    post.fieldInstances = [kind, slot];
    expect(validateMapDocument(doc).errors).toContain('A home post names its slot; a contested point names none');
    kind.__value = 'mid';
    expect(validateMapDocument(doc).errors).toContain('Invalid post kind');
  });
});

describe('forward post capture', () => {
  it(`a home post: a raid takes it in ${DEFAULT_RULES.surface.postCaptureTime} s uncontested and counts in team stats (mirrored)`, () => {
    const { g, s } = arena();
    // Blue raids Red's flank post while Red raids its twin: every tick the two captures are exact mirrors.
    const mine = postOf(s, RED, 0);
    const twin = postOf(s, BLUE, 0);
    troopers(g, BLUE, mine.x, mine.y);
    troopers(g, RED, twin.x, twin.y);
    for (let t = 1; t < s.econ.postCaptureTicks; t++) {
      g.step();
      expect(mine.state).toBe('capturing');
      expect(mine.progress).toBe(twin.progress);
      expect(mine.progress).toBeCloseTo(t / s.econ.postCaptureTicks, 9);
      expect(orbitAsymmetry(s)).toBeUndefined();
    }
    expect(mine.side).toBe(RED);
    g.step();
    expect(mine.side).toBe(BLUE);
    expect(twin.side).toBe(RED);
    expect(mine.state).toBe('idle');
    expect(s.armies[BLUE]!.stats.postsCaptured).toBe(1);
    expect(s.armies[RED]!.stats.postsCaptured).toBe(1);
    expect(orbitAsymmetry(s)).toBeUndefined();
    const events = g.observe({ team: 'nw', role: 'surface' }, 0).events;
    expect(events.some((e) => e.kind === 'post_captured' && e.side === 'nw')).toBe(true);
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).events.some((e) => e.kind === 'post_lost')).toBe(true);
    expect(s.econ.postCaptureTicks).toBe(DEFAULT_RULES.surface.postCaptureTime * TICK_RATE);
  });

  it(`a contested point takes ${DEFAULT_RULES.surface.contestedCaptureTime} s uncontested (mirrored, C2 and C4)`, () => {
    for (const slots of [2, 4] as const) {
      const { g, s } = arena(generated('open', 48, slots));
      const flanks = points(s).filter((p) => !isCentre(s, p));
      // Each army takes "its" flank point (the k-th, turned with the army).
      for (const a of s.allArmies) troopers(g, a, flanks[s.armySlot[a]!]!.x, flanks[s.armySlot[a]!]!.y);
      const needed = s.econ.contestedCaptureTicks;
      expect(needed).toBe(DEFAULT_RULES.surface.contestedCaptureTime * TICK_RATE);
      expect(needed).toBeGreaterThan(s.econ.postCaptureTicks);
      for (let t = 1; t < needed; t++) {
        g.step();
        expect(flanks[0]!.state).toBe('capturing');
        expect(flanks[0]!.progress).toBeCloseTo(t / needed, 9);
        expect(orbitAsymmetry(s)).toBeUndefined();
      }
      expect(flanks.every((p) => p.side === NEUTRAL)).toBe(true);
      g.step();
      for (const a of s.allArmies) expect(flanks[s.armySlot[a]!]!.side).toBe(a);
      expect(s.armies.every((t) => t.stats.postsCaptured === 1)).toBe(true);
      // Held contested points count toward the score; home posts do not.
      steps(g, 3);
      expect(s.armies.every((t) => t.stats.pointTicks === 3)).toBe(true);
      expect(orbitAsymmetry(s)).toBeUndefined();
    }
  });

  it('two hostile alliances on a held post freeze the capture; a neutral contested point makes no progress', () => {
    const { g, s } = arena();
    const post = postOf(s, RED, 1);
    const [raider] = troopers(g, BLUE, post.x, post.y);
    steps(g, s.econ.postCaptureTicks / 2);
    const progress = post.progress;
    expect(post.state).toBe('capturing');
    const [guard] = troopers(g, RED, post.x, post.y);
    steps(g, s.econ.postCaptureTicks);
    expect(post.state).toBe('contested');
    expect(post.side).toBe(RED);
    expect(post.progress).toBe(progress);
    // The defender leaves: the capture resumes where it stopped.
    guard!.hp = 0;
    steps(g, 2);
    expect(post.state).toBe('capturing');
    expect(post.progress).toBeGreaterThan(progress);
    raider!.hp = 0;
    // Neutral: hostile units together never advance a capture.
    const neutral = points(s).find((p) => isCentre(s, p))!;
    troopers(g, BLUE, neutral.x, neutral.y);
    troopers(g, RED, neutral.x, neutral.y);
    steps(g, s.econ.contestedCaptureTicks * 2);
    expect(neutral.side).toBe(NEUTRAL);
    expect(neutral.state).toBe('contested');
    expect(neutral.progress).toBe(-1);
  });

  it('a lost post tells its holder (post_lost), and a Surface rally set there resets to the default (safety, not a feature)', () => {
    const { g, s } = arena();
    const post = postOf(s, BLUE, 0);
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'rally', x: post.x, y: post.y })).toEqual({ ok: true });
    troopers(g, RED, post.x, post.y);
    steps(g, s.econ.postCaptureTicks);
    expect(post.side).toBe(RED);
    expect(s.armies[BLUE]!.rally.surface).toEqual(s.defaultRally(BLUE, 'surface'));
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).events.some((e) => e.kind === 'post_lost')).toBe(true);
    expect(g.observe({ team: 'se', role: 'surface' }, 0).events.some((e) => e.kind === 'post_lost')).toBe(false);
  });

  it('posts are never damaged, never targeted, and turn neutral when their holder is eliminated', () => {
    const { g, s } = arena();
    const post = postOf(s, BLUE, 0);
    expect(post.side).toBe(BLUE);
    s.damage(post, 1e9, RED, true, 'impact');
    expect(post.hp).toBe(post.maxHp);
    const [u] = troopers(g, RED, post.x + 1, post.y);
    expect(s.isTarget(u!, post)).toBe(false);
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'move', units: [id(g, 'nw', post)], x: 1, y: 1 })).toEqual({ ok: false, code: 'not_your_unit' });
    s.eliminate(BLUE);
    expect(post.side).toBe(NEUTRAL);
    expect(post.dead).toBe(false);
  });
});

describe('held forward posts', () => {
  it(`see ${DEFAULT_RULES.surface.postVision} tiles over cliffs and onto high ground, for the holder only (mirrored)`, () => {
    for (const preset of ['ridges', 'canyons', 'highlands'] as const) {
      const g = createGame({ seed: 2, options: { terrain: preset, surface: { homePostsOwned: false } } });
      const s = g.sim;
      for (const e of s.ents) if (e.unit) e.hp = 0;
      g.step();
      const r = s.econ.postVision;
      const mine = postOf(s, BLUE, 0);
      const twin = postOf(s, RED, 0);
      const disc = (p: Ent, from: number, to: number): number[] => {
        const out: number[] = [];
        for (let y = 0; y < s.size; y++) for (let x = 0; x < s.size; x++) {
          const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
          if (d >= from && d <= to) out.push(y * s.size + x);
        }
        return out;
      };
      // A plateau ring (both twins) around low-ground posts: low ground never sees high ground.
      for (const p of [mine, twin]) {
        s.terrain[Math.floor(p.y) * s.size + Math.floor(p.x)] = SURFACE.ground;
        for (const c of disc(p, 3, 4)) if (s.terrain[c] === SURFACE.ground) s.terrain[c] = SURFACE.high;
      }
      const blind = (army: Army, p: Ent): number[] => disc(p, 0, r - 0.5).filter((c) => !(s.vis[1]![c]! & s.armies[army]!.group.bit));
      const plateau = disc(mine, 3, 4).filter((c) => s.terrain[c] === SURFACE.high);
      expect(plateau.length).toBeGreaterThan(0);
      // A Blue trooper standing on the neutral post does not see the plateau.
      const [eye] = troopers(g, BLUE, mine.x, mine.y);
      s.computeVision();
      const low = blind(BLUE, mine);
      expect(plateau.every((c) => low.includes(c))).toBe(true);
      eye!.x = s.spireAt[BLUE]!.x;
      eye!.y = s.spireAt[BLUE]!.y;
      s.capturePost(mine, BLUE);
      s.capturePost(twin, RED);
      s.computeVision();
      expect(blind(BLUE, mine)).toEqual([]);
      expect(blind(RED, twin)).toEqual([]);
      // The other army gains nothing from it.
      expect(blind(RED, mine).length).toBeGreaterThan(0);
    }
  });

  it(`a home post projects a ${DEFAULT_RULES.surface.postBuildRadius}-tile build radius while held; a contested point ${DEFAULT_RULES.surface.contestedPostBuildRadius} (mirrored)`, () => {
    const { g, s } = arena({ surface: { homePostsOwned: false } });
    for (const army of [BLUE, RED]) {
      const post = postOf(s, army, 0);
      const home = s.spireAt[army]!;
      const d = Math.hypot(post.x - home.x, post.y - home.y);
      // Beyond the post, away from the Spire: outside the Spire radius, inside the post's.
      const reach = s.econ.postBuildRadius - 1;
      const x = post.x + ((post.x - home.x) / d) * reach;
      const y = post.y + ((post.y - home.y) / d) * reach;
      expect(Math.hypot(x - home.x, y - home.y)).toBeGreaterThan(s.econ.buildRadiusSpire);
      expect(s.buildSiteError(army, 'turret', x, y)).toBe('out_of_radius');
      s.capturePost(post, army);
      expect(s.buildSiteError(army, 'turret', x, y)).toBeNull();
      expect(s.buildSiteError(army === BLUE ? RED : BLUE, 'turret', x, y)).not.toBeNull();
    }
    // Held contested points project nothing by default, their own radius when the rule gives one.
    const centre = points(s).find((p) => isCentre(s, p))!;
    s.capturePost(centre, BLUE);
    expect(s.buildSiteError(BLUE, 'turret', centre.x + 1, centre.y + 1)).toBe('out_of_radius');
    const wide = arena({ surface: { contestedPostBuildRadius: 5 } }).s;
    const point = points(wide).find((p) => isCentre(wide, p))!;
    wide.capturePost(point, BLUE);
    expect(wide.buildSiteError(BLUE, 'turret', point.x + 1, point.y + 1)).toBeNull();
    expect(wide.buildSiteError(BLUE, 'turret', point.x + 5, point.y + 1)).toBe('out_of_radius');
    const data = g.matchData({ team: 'nw', role: 'surface' });
    expect(data.buildRadius.sources).toContainEqual({ kind: 'post', radius: s.econ.postBuildRadius });
    expect(data.buildRadius.contestedPost).toBe(s.econ.contestedPostBuildRadius);
  });

  it(`heal the wounded within ${DEFAULT_RULES.surface.postHealRadius} tiles from a ${DEFAULT_RULES.surface.postHealPool} HP/s pool, at most ${DEFAULT_RULES.surface.postHealRate} HP/s each, and nobody else`, () => {
    const { g, s } = arena();
    const post = postOf(s, BLUE, 0);
    const [near] = troopers(g, BLUE, post.x + s.econ.postCaptureRadius - 0.1, post.y);
    const [far] = troopers(g, BLUE, post.x + s.econ.postHealRadius + 1, post.y);
    const [foe] = troopers(g, RED, post.x - s.econ.postCaptureRadius - 0.5, post.y);
    for (const u of [near!, far!, foe!]) u.hp = 100;
    steps(g, TICK_RATE);
    // One wounded unit: the per-unit cap.
    expect(near!.hp).toBeCloseTo(100 + s.econ.postHealRate, 6);
    expect(far!.hp).toBe(100);
    expect(foe!.hp).toBeLessThanOrEqual(100);
    foe!.hp = 0;
    // Eight wounded share the pool: postHealPool / 8 each, the pool in all.
    const crowd = [near!, ...troopers(g, BLUE, post.x + 1, post.y + 1, 7)];
    g.step();
    for (const u of crowd) u.hp = 100;
    steps(g, TICK_RATE);
    const share = s.econ.postHealPool / crowd.length;
    expect(share).toBeLessThan(s.econ.postHealRate);
    for (const u of crowd) expect(u.hp).toBeCloseTo(100 + share, 6);
    expect(crowd.reduce((sum, u) => sum + u.hp - 100, 0)).toBeCloseTo(s.econ.postHealPool, 6);
    near!.hp = near!.maxHp - 0.01;
    g.step();
    expect(near!.hp).toBe(near!.maxHp);
  });

  it('a unit two held posts cover takes the larger share, never both', () => {
    const { g, s } = arena();
    const [a, b] = [postOf(s, BLUE, 0), postOf(s, BLUE, 1)];
    // Move the second post beside the first (tests only: posts never move).
    b.x = a.x + 5;
    b.y = a.y;
    // `both` stands between them; the crowd (shoved apart a little) only within post a's radius.
    const [both] = troopers(g, BLUE, a.x + 2.5, a.y);
    const crowd = troopers(g, BLUE, a.x - 1.5, a.y, 7);
    for (const u of [both!, ...crowd]) u.hp = 100;
    steps(g, TICK_RATE);
    // Post a splits its pool eight ways; post b heals `both` alone, at the per-unit cap.
    expect(both!.hp).toBeCloseTo(100 + Math.min(s.econ.postHealRate, s.econ.postHealPool), 6);
    for (const u of crowd) expect(u.hp).toBeCloseTo(100 + s.econ.postHealPool / 8, 6);
  });
});

describe('contested point score', () => {
  const capped = (options: MatchOptions, blue: number, red: number, redHpLoss = 0) => {
    const s = new Sim(4, options);
    s.armies[BLUE]!.stats.pointTicks = blue;
    s.armies[RED]!.stats.pointTicks = red;
    s.armies[RED]!.spire.depths.hp -= redHpLoss;
    s.tick = s.timeCap - 1;
    s.step();
    return s.result;
  };

  it('breaks a total Spire HP tie at the time cap, after Spire HP; postScore 0 keeps the draw', () => {
    expect(capped({}, 100, 40)).toEqual({ outcome: ['win', 'loss'], rank: [1, 2] });
    expect(capped({}, 40, 100)).toEqual({ outcome: ['loss', 'win'], rank: [2, 1] });
    expect(capped({}, 40, 40)).toEqual({ outcome: ['draw', 'draw'], rank: [1, 1] });
    // Spire HP first: a point lost outweighs any score.
    expect(capped({}, 0, 1e6, 1)).toEqual({ outcome: ['win', 'loss'], rank: [1, 2] });
    expect(capped({ surface: { postScore: 0 } }, 100, 40)).toEqual({ outcome: ['draw', 'draw'], rank: [1, 1] });
  });

  it('never decides a match before the cap: both Surfaces falling on one tick with equal HP still draw', () => {
    const s = new Sim(4);
    s.armies[BLUE]!.stats.pointTicks = 500;
    for (const a of [BLUE, RED]) s.armies[a]!.spire.surface.hp = 0;
    s.step();
    expect(s.result).toEqual({ outcome: ['draw', 'draw'], rank: [1, 1] });
  });

  it('report stats carry the contested-point ticks', () => {
    const { g, s } = arena();
    const centre = points(s).find((p) => isCentre(s, p))!;
    s.capturePost(centre, RED);
    steps(g, 5);
    expect(s.armies[RED]!.stats.pointTicks).toBe(5);
    expect(s.armies[BLUE]!.stats.pointTicks).toBe(0);
    expect(g.report('se').armies.find((a) => a.army === 'se')!.stats.pointTicks).toBe(5);
  });
});

describe('forward post fog', () => {
  it('a contested point: holder public; a hidden capture by another army is indistinguishable from none (twin worlds)', () => {
    const sees = (withBlue: boolean) => {
      const { g, s } = arena();
      const post = points(s).find((p) => !isCentre(s, p))!;
      if (withBlue) troopers(g, BLUE, post.x, post.y);
      steps(g, 10);
      expect(s.seesCell(RED, 'surface', Math.floor(post.y) * s.size + Math.floor(post.x))).toBe(false);
      if (withBlue) expect(post.state).toBe('capturing');
      const obs = g.observe({ team: 'se', role: 'surface' }, 0);
      expect(validate(observationSchema, obs).ok).toBe(true);
      return { alerts: obs.alerts, post: obs.entities.find((e) => e.id === id(g, 'se', post)) };
    };
    const seen = sees(true);
    expect(seen.post).toMatchObject({ kind: 'post', side: 'neutral', state: 'idle' });
    expect(seen.post?.progress).toBeUndefined();
    expect(seen).toEqual(sees(false));
  });

  it('the capturer and the holder follow the capture from anywhere; the holder gets post_contested', () => {
    const { g, s } = arena();
    const post = postOf(s, RED, 1);
    troopers(g, BLUE, post.x, post.y);
    steps(g, 10);
    for (const team of ['nw', 'se'] as const satisfies ArmyId[]) {
      const obs = g.observe({ team, role: 'surface' }, 0);
      expect(obs.entities.find((e) => e.id === id(g, team, post))).toMatchObject({ side: 'se', state: 'capturing', progress: expect.any(Number) });
    }
    const alerts = g.observe({ team: 'se', role: 'surface' }, 0).alerts.filter((a) => a.plane === 'surface');
    expect(alerts[0]).toEqual({ plane: 'surface', kind: 'post_contested', x: Math.floor(post.x) + 0.5, y: Math.floor(post.y) + 0.5 });
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).alerts.some((a) => a.kind === 'post_contested')).toBe(false);
  });
});

describe('forward post intents', () => {
  it('attack on a post sends Surface units onto it; recapture spreads the army over posts not held', () => {
    const { g, s } = arena({ surface: { homePostsOwned: false } });
    const post = postOf(s, BLUE, 0);
    const units = troopers(g, BLUE, s.spireAt[BLUE]!.x + 2, s.spireAt[BLUE]!.y + 2, 2);
    for (const u of units) u.stance = 'aggressive';
    const named = units.map((u) => id(g, 'nw', u));
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'attack', units: named, target: id(g, 'nw', post) })).toEqual({ ok: true });
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'attack', units: named, target: id(g, 'nw', post) })).toEqual({ ok: false, code: 'wrong_plane' });
    steps(g, TICK_RATE * 20);
    expect(post.side).toBe(BLUE);
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'macro', action: 'recapture' })).toEqual({ ok: true });
    for (const u of units) expect(u.order.k).toBe('move');
  });
});

describe('forward posts with bots', () => {
  it('standard bots keep their home posts and race a squad for the nearest contested point from 0:05; exactly symmetric and deterministic', () => {
    const run = () => {
      let broken: string | undefined;
      const held: number[][] = [];
      const racing: number[] = [];
      const r = playBotMatch({
        seed: 7, levels: { nw: 'standard', se: 'standard' }, maxTicks: TICK_RATE * 75,
        onTick: (game) => {
          const s = game.sim;
          broken ??= orbitAsymmetry(s);
          // The centre is each army's nearest contested point on a C2 map: from 0:05 three troopers per army head there.
          if (game.tick === TICK_RATE * 4 || game.tick === TICK_RATE * 8) racing.push(...s.allArmies.map((a) => toCentre(s, a)));
          if (game.tick === TICK_RATE * 60) held.push(...s.allArmies.map((a) => [postOf(s, a, 0).side, postOf(s, a, 1).side]));
        },
      });
      return { r, broken, held, racing };
    };
    const { r, broken, held, racing } = run();
    expect(broken).toBeUndefined();
    const s = r.game.sim;
    expect(racing).toEqual([0, 0, 3, 3]);
    // Home posts start held and stay so in the first minute.
    expect(held).toEqual(s.allArmies.map((a) => [a, a]));
    expect(run().r.game.sim.hash()).toBe(s.hash());
  });

  it(`veteran bots keep their home posts, send no point squad before army first ends (${TIERS.veteran.armyFirst} Surface fighters, ${ARMY_FIRST_OPENING / TICK_RATE} s at the latest) and race one for the nearest contested point within 0.5 s after; exactly symmetric and deterministic`, () => {
    const fighters = new Set(['trooper', 'tank', 'flak', 'breacher']);
    const run = () => {
      let broken: string | undefined;
      const held: number[][] = [];
      // Per army: the tick its army first ended (the army stood, or the opening ran out), the ticks troopers headed for
      // the centre before that, and the tick a whole squad first did.
      const stood: number[] = [], early: number[][] = [], raced: number[] = [];
      const r = playBotMatch({
        seed: 7, levels: { nw: 'veteran', se: 'veteran' }, maxTicks: TICK_RATE * 120,
        onTick: (game) => {
          const s = game.sim;
          broken ??= orbitAsymmetry(s);
          for (const a of s.allArmies) {
            const army = s.ents.filter((e) => e.side === a && e.plane === 'surface' && !e.dead && e.hp > 0 && fighters.has(e.kind)).length;
            if (army >= TIERS.veteran.armyFirst || game.tick >= ARMY_FIRST_OPENING) stood[a] ??= game.tick;
            const n = toCentre(s, a);
            if (stood[a] === undefined && n > 0) (early[a] ??= []).push(game.tick);
            if (n >= 3) raced[a] ??= game.tick;
          }
          if (game.tick === TICK_RATE * 60) held.push(...s.allArmies.map((a) => [postOf(s, a, 0).side, postOf(s, a, 1).side]));
        },
      });
      return { r, broken, held, stood, early, raced };
    };
    const { r, broken, held, stood, early, raced } = run();
    expect(broken).toBeUndefined();
    const s = r.game.sim;
    expect(early).toEqual([]);
    for (const a of s.allArmies) {
      expect(stood[a], `army ${a}`).toBeDefined();
      expect(raced[a]! - stood[a]!, `army ${a}`).toBeGreaterThanOrEqual(0);
      expect(raced[a]! - stood[a]!, `army ${a}`).toBeLessThanOrEqual(TICK_RATE / 2);
    }
    expect(raced[RED]).toBe(raced[BLUE]);
    // Home posts start held and stay so in the first minute.
    expect(held).toEqual(s.allArmies.map((a) => [a, a]));
    expect(run().r.game.sim.hash()).toBe(s.hash());
  });

  it('bots leave posts alone when postsEnabled is false', () => {
    const r = playBotMatch({ seed: 7, levels: { nw: 'standard', se: 'veteran' }, options: { surface: { postsEnabled: false } }, maxTicks: TICK_RATE * 20 });
    expect(r.game.sim.posts).toEqual([]);
  });
});
