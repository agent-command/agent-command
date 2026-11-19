import { describe, expect, it } from 'vitest';
import { CELL, DEFAULT_RULES, FLANK_ANCHOR, MAP_SIZES, STATS, STRUCTURE_SPACING, SURFACE, TERRAIN_PRESETS, isSurfaceHigh, surfaceFeature, checkRules, footprintMinX, footprintMinY, resolveRules, spirePositions } from '../src/rules/contract.ts';
import { Rng } from '../src/util/rng.ts';
import { LODE_APRON, LODE_POCKET, generateTerrain, generateWorld, placeLodes, prepareLodeSites } from '../src/maps/world.ts';
import { generateMapDocument, publicMapDocument } from '../src/maps/maps.ts';
import { mapEntities } from '../src/maps/document.ts';
import { surfaceSiteLevel } from '../src/rules/stats.ts';
import { mirrorCell } from '../src/util/grid.ts';
import { isTemplatePreset, templateTerrain } from '../src/maps/templates.ts';
import { flankAnchor } from '../src/maps/posts.ts';

/** Spire centres under the default rules (every match here uses them). */
const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);
/** Cells of the default-size grids the placement fixtures below build. */
const N = DEFAULT_RULES.map.size * DEFAULT_RULES.map.size;

describe('lode zone recipes', () => {
  it('derives lode preparation from the complete Headframe and mirrors integer Spire sites', () => {
    expect(LODE_POCKET * 2 + 1).toBe(STATS.headframe.footprint.w);
    expect(LODE_POCKET * 2 + 1).toBe(STATS.headframe.footprint.h);
    expect(LODE_APRON).toBe(STRUCTURE_SPACING);
    const blue = DEFAULT_SPIRES.nw;
    const red = DEFAULT_SPIRES.se;
    const f = STATS.spire.footprint;
    expect(Number.isInteger(footprintMinX('spire', blue.x))).toBe(true);
    expect(Number.isInteger(footprintMinY('spire', blue.y))).toBe(true);
    expect(footprintMinX('spire', red.x)).toBe(DEFAULT_RULES.map.size - f.w - footprintMinX('spire', blue.x));
    expect(footprintMinY('spire', red.y)).toBe(DEFAULT_RULES.map.size - f.h - footprintMinY('spire', blue.y));
  });
  it('prepares a connected loading apron around each solid Spire root', () => {
    const map = DEFAULT_RULES.map;
    const world = generateWorld(1, generateTerrain(1, 'ridges', map, 2), map, 2, 1);
    for (const p of [DEFAULT_SPIRES.nw, DEFAULT_SPIRES.se]) {
      const f = STATS.spire.footprint;
      for (let y = p.y - f.h / 2 - 1; y < p.y + f.h / 2 + 1; y++) {
        for (let x = p.x - f.w / 2 - 1; x < p.x + f.w / 2 + 1; x++) expect(world.cells[y * world.size + x]).toBe(CELL.tunnel);
      }
    }
  });
  for (const terrain of TERRAIN_PRESETS) {
    it(`${terrain}: 100 seeds respect zones, loads, mirrored pairs and spacing`, () => {
      let richPairs = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const map = DEFAULT_RULES.map;
        const world = generateWorld(seed, generateTerrain(seed, terrain, map, 2), map, 2, seed);
        const size = world.size;
        expect(world.lodes, `${terrain}/${seed}: full default economy`).toHaveLength(6);
        expect(world.generation.lodes.reduce((n, z) => n + z.placed * 2, 0)).toBe(world.lodes.length);
        for (const z of world.generation.lodes) expect(z.placed + z.missing).toBe(z.requested);
        const edits = world.generation.terrainEdits;
        for (const edit of edits) {
          // Sites are levelled onto the plateau they touch or onto plain ground, never carved down from high ground.
          expect(edit.before, `${terrain}/${seed} edit ${edit.c}`).not.toBe(SURFACE.high);
          if (isSurfaceHigh(edit.before)) expect(edit.after).toBe(SURFACE.high);
          expect([SURFACE.ground, SURFACE.high]).toContain(edit.after);
          expect(edit.after).toBe(world.terrain[edit.c]);
          expect(surfaceFeature(edit.before)).not.toBe(SURFACE.fault);
          expect(edits).toContainEqual({ ...edit, c: mirrorCell(edit.c, size) });
          const x = edit.c % size;
          const y = Math.floor(edit.c / size);
          // Outside both Spire clearings (a two-slot map: the other corners are free ground).
          const spire = Math.min(...[DEFAULT_SPIRES.nw, DEFAULT_SPIRES.se].map((p) => Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y)));
          expect(spire).toBeGreaterThan(6.5);
          // Only home sites level cliffs (out to the fallback radius, apron included).
          if (edit.before === SURFACE.cliff) expect(spire).toBeLessThanOrEqual(map.homeLodeFallbackRadius + Math.SQRT2 * (LODE_POCKET + LODE_APRON) + 1);
          // Every edit belongs to a public site that now fits the Headframe rule, whether or not a lode took it.
          const reach = LODE_POCKET + LODE_APRON;
          let site = false;
          for (let dy = -reach; dy <= reach && !site; dy++) for (let dx = -reach; dx <= reach && !site; dx++) {
            site = surfaceSiteLevel(world.terrain, size, x + dx - LODE_POCKET, y + dy - LODE_POCKET, 2 * LODE_POCKET + 1, 2 * LODE_POCKET + 1) >= 0;
          }
          expect(site, `${terrain}/${seed} edit ${edit.c}`).toBe(true);
        }
        const seen = new Uint8Array(size * size);
        const queue = [Math.floor(DEFAULT_SPIRES.nw.y) * size + Math.floor(DEFAULT_SPIRES.nw.x)];
        seen[queue[0]!] = 1;
        for (let i = 0; i < queue.length; i++) {
          const c = queue[i]!;
          for (const n of [c % size ? c - 1 : -1, c % size < size - 1 ? c + 1 : -1, c - size, c + size]) {
            if (n < 0 || n >= size * size || seen[n] || world.terrain[n] === SURFACE.cliff || world.terrain[n] === SURFACE.water) continue;
            seen[n] = 1;
            queue.push(n);
          }
        }
        expect(world.terrain.every((value, c) => value === SURFACE.cliff || value === SURFACE.water || seen[c])).toBe(true);
        for (let i = 0; i < world.lodes.length; i += 2) {
          const l = world.lodes[i]!;
          expect(world.lodes[i + 1]).toEqual({ ...l, c: mirrorCell(l.c, size) });
          const x = l.c % size + 0.5;
          const y = Math.floor(l.c / size) + 0.5;
          if (l.rich) {
            richPairs++;
            const zone = map.contestedZones[0]!;
            expect(Math.hypot(x - FLANK_ANCHOR.x, y - FLANK_ANCHOR.y)).toBeLessThanOrEqual(zone.maxRadius);
            expect(Math.abs(Math.hypot(x - DEFAULT_SPIRES.nw.x, y - DEFAULT_SPIRES.nw.y) - Math.hypot(x - DEFAULT_SPIRES.se.x, y - DEFAULT_SPIRES.se.y))).toBeLessThanOrEqual(zone.maxSkew);
            expect(l.loads).toBe(zone.loads);
          } else {
            const radius = Math.hypot(x - DEFAULT_SPIRES.nw.x, y - DEFAULT_SPIRES.nw.y);
            expect(radius).toBeGreaterThanOrEqual(map.homeLodeMinRadius);
            expect(radius).toBeLessThanOrEqual(map.homeLodeMaxRadius);
            expect(l.loads).toBe(map.homeLodeLoads);
          }
        }
        for (let i = 0; i < world.lodes.length; i++) {
          const c = world.lodes[i]!.c;
          const radius = LODE_POCKET + LODE_APRON;
          expect([SURFACE.ground, SURFACE.high]).toContain(world.terrain[c]);
          for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
            expect(world.terrain[c + dy * size + dx], `${terrain}/${seed} outcrop ${c} apron ${dx},${dy}`).toBe(world.terrain[c]);
          }
          for (let j = i + 1; j < world.lodes.length; j++) {
            const a = world.lodes[i]!.c;
            const b = world.lodes[j]!.c;
            expect(Math.hypot(a % size - b % size, Math.floor(a / size) - Math.floor(b / size))).toBeGreaterThanOrEqual(map.lodeSpacing);
          }
        }
      }
      expect(richPairs).toBe(100);
    });
  }

  it('never carves a plateau for a lode site: no new ground inside a high region, over presets, sizes and zones', () => {
    let onPlateau = 0;
    for (const size of MAP_SIZES) {
      const recipes = [
        resolveRules({ map: { params: { size } } }).map,
        resolveRules({ map: { params: { size, contestedZones: [{ kind: 'centre', sets: 1, loads: 150, minRadius: 4, maxRadius: 13, maxSkew: 10 }] } } }).map,
      ];
      for (const map of recipes) {
        const spires = spirePositions(map.spireInset, size);
        for (const terrain of TERRAIN_PRESETS) for (let seed = 1; seed <= 8; seed++) {
          // The recipe's own surface before any lode or anchor site was levelled (the Spire clearing aside).
          const before = isTemplatePreset(terrain) ? templateTerrain(seed, terrain, map, 2) : generateTerrain(seed, terrain, map, 2).terrain;
          const world = generateWorld(seed, generateTerrain(seed, terrain, map, 2), map, 2, seed);
          for (let c = 0; c < size * size; c++) {
            if (before[c] !== SURFACE.high || world.terrain[c] !== SURFACE.ground) continue;
            const x = c % size + 0.5;
            const y = Math.floor(c / size) + 0.5;
            const spire = Math.min(Math.hypot(x - spires.nw.x, y - spires.nw.y), Math.hypot(x - spires.se.x, y - spires.se.y));
            expect(spire, `${terrain}/${size}/${seed}: plateau cell ${c} carved to ground`).toBeLessThanOrEqual(6.5);
          }
          for (const l of world.lodes) if (world.terrain[l.c] === SURFACE.high) onPlateau++;
        }
      }
    }
    // Plateau lodes are real: highlands puts its outcrops on top of its ridges.
    expect(onPlateau).toBeGreaterThan(0);
  });

  it('keeps centre selectable and replaces zone lists rather than merging array indices', () => {
    const zone = { kind: 'centre' as const, sets: 2, loads: 280, minRadius: 4, maxRadius: 13, maxSkew: 10 };
    const map = resolveRules({ map: { params: { contestedZones: [zone] } } }).map;
    expect(map.contestedZones).toEqual([zone]);
    expect(resolveRules({ map: { params: { contestedZones: [] } } }).map.contestedZones).toEqual([]);
    let placed = 0;
    for (const terrain of TERRAIN_PRESETS) for (let seed = 1; seed <= 30; seed++) {
      const w = generateWorld(seed, generateTerrain(seed, terrain, map, 2), map, 2, seed);
      for (const l of w.lodes.filter((l) => l.rich)) {
        const radius = Math.hypot(l.c % w.size + 0.5 - 24, Math.floor(l.c / w.size) + 0.5 - 24);
        expect(radius).toBeGreaterThanOrEqual(4);
        expect(radius).toBeLessThanOrEqual(13);
        expect(l.loads).toBe(280);
        placed++;
      }
    }
    expect(placed).toBeGreaterThan(180);
  });

  it('widens deterministically within bounds and reports impossible pairs without relocating them', () => {
    const map = resolveRules({ map: { params: { homeLodes: 0, contestedZones: [{ kind: 'flanks', sets: 1, loads: 150, minRadius: 0, maxRadius: 9, maxSkew: 10 }] } } }).map;
    const place = (blocked: boolean) => {
      const cells = new Uint8Array(N).fill(blocked ? CELL.bedrock : CELL.rock);
      if (!blocked) for (let y = 5; y <= 10; y++) for (let x = 37; x <= 42; x++) cells[y * map.size + x] = cells[mirrorCell(y * map.size + x, map.size)] = CELL.bedrock;
      const terrain = new Uint8Array(N);
      return placeLodes(map, new Rng(77), { cells, ore: new Uint8Array(N), magma: new Uint8Array(N), terrain }, 2, prepareLodeSites(map, terrain, new Uint8Array(N), 2), []);
    };
    const a = place(false);
    expect(a).toEqual(place(false));
    expect(a.summary).toEqual([{ zone: 'home', requested: 0, placed: 0, widened: 0, prepared: 0, cliffPrepared: 0, fallback: 0, missing: 0 }, { zone: 'flanks', requested: 1, placed: 1, widened: 1, prepared: 0, cliffPrepared: 0, fallback: 0, missing: 0 }]);
    const b = place(true);
    expect(b.lodes).toEqual([]);
    expect(b.summary[1]).toEqual({ zone: 'flanks', requested: 1, placed: 0, widened: 0, prepared: 0, cliffPrepared: 0, fallback: 0, missing: 1 });
  });

  it('prepares dry, level public sites without modifying faults, water or stranded cliffs; the secret placement only takes them', () => {
    const map = resolveRules({ map: { params: { homeLodes: 0 } } }).map;
    const place = (terrain: Uint8Array) => {
      const sites = prepareLodeSites(map, terrain, new Uint8Array(N), 2);
      const surface = terrain.slice();
      const placement = placeLodes(map, new Rng(1), { cells: new Uint8Array(N).fill(CELL.rock), ore: new Uint8Array(N), magma: new Uint8Array(N), terrain }, 2, sites, []);
      expect(terrain).toEqual(surface);
      return { sites, placement };
    };
    for (const surface of [SURFACE.fault, SURFACE.highFault, SURFACE.water, SURFACE.highWater, SURFACE.cliff]) {
      const { sites, placement } = place(new Uint8Array(N).fill(surface));
      expect(sites.terrainEdits).toEqual([]);
      expect(placement.lodes).toEqual([]);
      expect(placement.summary[1]?.missing).toBe(1);
    }
    const terrain = new Uint8Array(N);
    for (let c = 0; c < N; c++) terrain[c] = c % 2 ? SURFACE.high : SURFACE.ground;
    const raised = place(terrain);
    expect(raised.placement.lodes).toHaveLength(2);
    // The zone's one set plus its spares, each lodeSpacing apart.
    expect(raised.placement.summary[1]?.prepared).toBe(1 + map.lodeSpares);
    expect(raised.sites.sites).toHaveLength(1 + map.lodeSpares);
    // A site touching high ground is raised onto it, never carved down.
    for (const lode of raised.placement.lodes) expect(terrain[lode.c]).toBe(SURFACE.high);
    expect(raised.sites.terrainEdits.every((edit) => edit.before === SURFACE.ground && edit.after === SURFACE.high)).toBe(true);
    for (const surface of [SURFACE.forest, SURFACE.ford, SURFACE.highForest, SURFACE.highFord]) {
      terrain.fill(surface);
      const cleared = place(terrain);
      expect(cleared.placement.summary[1]?.prepared).toBe(1 + map.lodeSpares);
      for (const lode of cleared.placement.lodes) expect(terrain[lode.c]).toBe(isSurfaceHigh(surface) ? SURFACE.high : SURFACE.ground);
    }
    terrain.fill(SURFACE.high);
    const plateau = place(terrain);
    expect(plateau.sites.terrainEdits).toEqual([]);
    expect(plateau.placement.lodes).toHaveLength(2);
  });

  it('levels cliffs for a contested band only as a last resort, when it holds no site otherwise', () => {
    const map = resolveRules({ map: { params: { homeLodes: 0 } } }).map;
    // A ground map whose flank bands are solid cliff (with the corner beyond each anchor, so no ground is cut off):
    // every band site's footprint or apron touches a cliff (a canyon flank crossed by faults leaves the same).
    const anchor = flankAnchor(map.size, 2);
    const band = map.contestedZones.find((zone) => zone.kind === 'flanks')!.maxRadius;
    const terrain = new Uint8Array(N);
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (Math.hypot(x + 0.5 - anchor.x, y + 0.5 - anchor.y) <= band || (x + 0.5 >= anchor.x && y + 0.5 <= anchor.y)) terrain[y * map.size + x] = terrain[mirrorCell(y * map.size + x, map.size)] = SURFACE.cliff;
    }
    const sites = prepareLodeSites(map, terrain, new Uint8Array(N), 2);
    const placement = placeLodes(map, new Rng(1), { cells: new Uint8Array(N).fill(CELL.rock), ore: new Uint8Array(N), magma: new Uint8Array(N), terrain }, 2, sites, []);
    expect(placement.summary[1]).toMatchObject({ zone: 'flanks', placed: 1, missing: 0 });
    expect(placement.summary[1]!.cliffPrepared).toBeGreaterThan(0);
    expect(placement.summary[1]!.cliffPrepared).toBe(placement.summary[1]!.prepared);
    expect(sites.terrainEdits.every((edit) => edit.before === SURFACE.cliff && edit.after === SURFACE.ground)).toBe(true);
  });

  it('keeps prepared site seals off the tunnels the public map implies', () => {
    const map = resolveRules({ map: { params: { homeLodes: 0 } } }).map;
    const terrain = new Uint8Array(N).fill(SURFACE.forest);
    // Known tunnels everywhere but one 9×9 patch (and its mirror) inside the flank zone.
    const dug = new Uint8Array(N).fill(1);
    for (let y = 5; y <= 13; y++) for (let x = 33; x <= 41; x++) dug[y * map.size + x] = dug[mirrorCell(y * map.size + x, map.size)] = 0;
    const sites = prepareLodeSites(map, terrain, dug, 2);
    expect(sites.sites.length).toBeGreaterThan(0);
    for (const site of sites.sites) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) expect(dug[site + dy * map.size + dx]).toBe(0);
    for (const edit of sites.terrainEdits) expect(dug[edit.c]).toBe(0);
  });

  it('records last-resort home widening only after preferred-band sites are exhausted', () => {
    const map = resolveRules({ map: { params: { spireInset: 8, homeLodes: 1, contestedZones: [] } } }).map;
    const cells = new Uint8Array(N).fill(CELL.bedrock);
    for (let y = 5; y <= 11; y++) for (let x = 17; x <= 23; x++) cells[y * map.size + x] = cells[mirrorCell(y * map.size + x, map.size)] = CELL.rock;
    const terrain = new Uint8Array(N);
    const placement = placeLodes(map, new Rng(17), { cells, ore: new Uint8Array(N), magma: new Uint8Array(N), terrain }, 2, prepareLodeSites(map, terrain, new Uint8Array(N), 2), []);
    expect(placement.lodes).toHaveLength(2);
    expect(placement.summary[0]).toMatchObject({ placed: 1, fallback: 1, missing: 0 });
    const lode = placement.lodes[0]!;
    const home = spirePositions(map.spireInset, map.size).nw;
    const radius = Math.hypot(lode.c % map.size + 0.5 - home.x, Math.floor(lode.c / map.size) + 0.5 - home.y);
    expect(radius).toBeGreaterThan(map.homeLodeMaxRadius);
    expect(radius).toBeLessThanOrEqual(map.homeLodeFallbackRadius);
  });

  it('never lets the secret seed reach the public map: two secrets give byte-identical public layers', () => {
    let differentLodes = 0;
    for (const terrain of TERRAIN_PRESETS) for (const size of MAP_SIZES) for (const sides of [2, 4] as const) {
      const map = resolveRules({ terrain, map: { params: { size } } }).map;
      for (let seed = 1; seed <= 3; seed++) {
        const [a, b] = [seed, 2 ** 31 + 7 * seed].map((secret) => generateMapDocument(seed, terrain, map, sides, secret));
        const label = `${terrain}/${size}/${sides}/${seed}`;
        expect(JSON.stringify(publicMapDocument(b!)), label).toBe(JSON.stringify(publicMapDocument(a!)));
        // Lode preparation is public (prepared before any hidden stage); only the lodes themselves are secret.
        expect(b!.generation.terrainEdits, label).toEqual(a!.generation.terrainEdits);
        const lodes = (document: typeof a) => JSON.stringify(mapEntities(document!).filter((entity) => entity.__identifier === 'Lode'));
        if (lodes(a) !== lodes(b)) differentLodes++;
      }
    }
    expect(differentLodes).toBeGreaterThan(100);
  });

  it('validates bounds, field names, zone kinds, and ordered bands', () => {
    for (const map of [
      { homeLodeMinRadius: 6 }, { homeLodeMaxRadius: 21 }, { homeLodeMinRadius: 12, homeLodeMaxRadius: 10 },
      { homeLodeFallbackRadius: 6 }, { homeLodeFallbackRadius: 21 },
      { lodeSpacing: 5 }, { lodeSpacing: 21 }, { lodeSpares: -1 }, { lodeSpares: 4 }, { lodeSpares: 1.5 }, { contestedLodes: 1 }, { richLodeLoads: 150 },
      ...['kind', 'sets', 'loads', 'minRadius', 'maxRadius', 'maxSkew'].map((key) => ({ contestedZones: [{ ...DEFAULT_RULES.map.contestedZones[0], [key]: key === 'kind' ? 'elsewhere' : 3000 }] })),
      { contestedZones: [{ ...DEFAULT_RULES.map.contestedZones[0], minRadius: 10, maxRadius: 9 }] },
      { contestedZones: Array.from({ length: 5 }, () => DEFAULT_RULES.map.contestedZones[0]) },
    ]) expect(checkRules({ map: { params: map } }).ok, JSON.stringify(map)).toBe(false);
    expect(checkRules({ map: { params: { contestedZones: [] } } }).ok).toBe(true);
    expect(checkRules({ map: { params: { contestedZones: [{ ...DEFAULT_RULES.map.contestedZones[0], loads: 3000 }] } } })).toEqual({ ok: false, error: 'rules.map.params.contestedZones.0.loads: must be an integer from 8 to 2000' });
  });
});
