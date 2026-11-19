/**
 * The home preview's maps: the public map a match with these options would play on (generated from the public map
 * seed and size, or a bundled classic). Generation takes 150–250 ms, so this runs in preview.worker.ts (via
 * preview-client.ts); the main thread only receives plain data.
 *
 * A generated map's Depths, ore, magma and lodes come from each match's secret seed, so a preview cannot know them:
 * thumbnails draw lodes for authored maps only, and the home backdrop's Depths are a representative illustration
 * (hidden seed 0), not any match's truth. `buildPreviewView` is a local, map-only View: the public match bootstrap,
 * the islands and Spires at tick 0 and that illustration, with nothing fogged. It never runs a sim and never leaves
 * this browser: no network or agent surface carries it.
 */
import {
  CELL,
  COLOURS,
  PLANES,
  TICK_RATE,
  UPGRADES,
  VISION_BITS_PER_WORD,
  armyIdOfSlot,
  buildRadiusData,
  derelictGeometry,
  frameOf,
  compileRules,
  hashRules,
  islandAt,
  packTerrain,
  rotCell,
  resolveRules,
  resolveUpgrade,
  sunAngleAt,
  sunHalfWidth,
  upgradeBeneficiaries,
  type Entity,
  type MatchData,
  type MatchOptions,
  type Rules,
  type View,
} from '@agent-command/game/contract';
import { expandMapDocument, hashMapDocument, publicMapDocument, resolveMapDocument } from '@agent-command/game/maps';
import { matchPosts } from '@agent-command/game/posts';
import { SkyWeather } from '@agent-command/game/weather';
import type { MatchView } from './match-view.ts';

/** A map-card thumbnail: Surface codes, and lodes when the map is authored (a generated map's lodes are secret). */
export interface PreviewMap {
  size: number;
  /** SURFACE code per cell */
  terrain: Uint8Array;
  lodes: View['lodes'];
}

/** The match seed only fills a generated map's hidden layers here (an illustration); every TerrainChoice names a map. */
const documentOf = (options: MatchOptions, rules: Rules) => resolveMapDocument(0, rules.terrain, rules.map, options.map);
const generated = (options: MatchOptions): boolean => options.map?.name === undefined && options.map?.document === undefined;

export function buildPreview(options: MatchOptions): PreviewMap {
  const { world } = expandMapDocument(documentOf(options, resolveRules(options)));
  const lodes = generated(options) ? [] : world.lodes.map((l) => ({ x: l.c % world.size, y: Math.floor(l.c / world.size), rich: l.rich, loads: l.loads, open: false }));
  return { size: world.size, terrain: world.terrain, lodes };
}

/** Every cell of a plane visible: the preview shows the whole map, so nothing is veiled. */
function allVisible(n: number): number[] {
  const words = new Array<number>(Math.ceil(n / VISION_BITS_PER_WORD)).fill(2 ** VISION_BITS_PER_WORD - 1);
  const tail = n % VISION_BITS_PER_WORD;
  if (tail) words[words.length - 1] = 2 ** tail - 1;
  return words;
}

export function buildPreviewView(options: MatchOptions): MatchView {
  const resolved = resolveRules(options);
  const document = documentOf(options, resolved);
  const { world, starts } = expandMapDocument(document);
  // The document fixes size, Spire inset and preset, exactly as a match on it resolves them (Sim constructor).
  const rules: Rules = { ...resolved, terrain: document.preset, map: { ...resolved.map, size: document.size, spireInset: document.spireInset } };
  const size = rules.map.size;
  const n = size * size;
  const tables = compileRules(rules);
  // One army per slot of the map, coloured in slot order: the default match on this map (Sim constructor).
  const armies: MatchData['armies'] = starts.map((at, slot) => {
    const id = armyIdOfSlot(slot, document.sides);
    return { id, slot, frame: frameOf(id), colour: COLOURS[slot]!, spireAt: { x: at.x, y: at.y } };
  });
  // Jets and fog paths are fixed geometry of the rules and size; natural storms are a secret future, never previewed.
  const weather = new SkyWeather(tables.econ, 0, armies.map((a) => a.spireAt), tables.stats.spire.range, size, document.sides).data;
  // Forward posts come from the document (or the recipe from public data alone), exactly as the match spawns them, and
  // are named as every army names them (game sim/aliases.ts: the islands first, then the posts, both in spawn order).
  const mapPosts = rules.surface.postsEnabled ? matchPosts(world, document.sides, starts[0]!, rules.map, armies.map((a) => a.slot)) : [];
  const posts: MatchData['posts'] = mapPosts.map((p, i) => {
    const id = `e_${world.islands.length + 1 + i}`;
    return p.kind === 'home' ? { id, x: p.x, y: p.y, kind: 'home', home: armies[p.slot!]!.id } : { id, x: p.x, y: p.y, kind: 'contested' };
  });
  const match: MatchData = {
    rules,
    rulesHash: hashRules(rules),
    upgrades: Object.values(UPGRADES).map((upgrade) => {
      const cost = resolveUpgrade(rules, upgrade.id);
      return { id: upgrade.id, at: upgrade.at, alloy: cost.alloy, energy: cost.energy, units: upgradeBeneficiaries(upgrade.id) };
    }),
    preset: rules.terrain,
    mapId: document.id,
    mapSeed: document.seed,
    mapHash: hashMapDocument(generated(options) ? publicMapDocument(document) : document),
    terrain: packTerrain(world.terrain),
    faults: world.faults.map((f) => ({ cells: f.map((c) => ({ x: c % size, y: Math.floor(c / size) })) })),
    armies,
    posts,
    symmetry: document.symmetry,
    buildRadius: buildRadiusData(tables.econ),
    // One lit wedge per map slot: every corner starts in daylight.
    sun: { speed: tables.sunSpeed, half: sunHalfWidth(document.sides), wedges: document.sides },
    orbitRegions: world.orbitRegions.map((region) => ({ ...region })),
    jets: weather.jets.map((lane) => ({ ...lane })),
    fogPaths: weather.fog.map((cell) => ({ ...cell.path })),
    // The derelict ruin is fixed public geometry of the rules, size and Spire inset, as in a match.
    ...(tables.econ.derelictEnabled ? { derelict: derelictGeometry(tables.econ, tables.stats, tables.spires, size) } : {}),
  };
  // Islands take the first names in document order, as in a match (their art is keyed on that identity).
  const islands: View['islands'] = world.islands.map((o, i) => ({ id: `e_${i + 1}`, cx: size / 2, cy: size / 2, r: o.r, phase: o.a0, speed: o.w * TICK_RATE, ...(o.oreCapacity > 0 ? { oreCapacity: o.oreCapacity } : {}) }));
  // Public initial deposit only, as a match's entity carries it; never a remaining amount.
  const entities: Entity[] = islands.map((p) => ({ id: p.id, kind: 'island', side: 'neutral', plane: 'sky', ...islandAt(p, 0), hp: 1, maxHp: 1, state: 'drifting', ...(p.oreCapacity ? { oreCapacity: p.oreCapacity } : {}) }));
  // The Spires of this unfogged illustration take names after the posts'.
  let spire = islands.length + posts.length;
  for (const army of armies) for (const plane of PLANES) {
    const hp = tables.spireHp[plane];
    entities.push({ id: `e_${++spire}`, kind: 'spire', side: army.id, plane, ...army.spireAt, hp, maxHp: hp, state: 'active' });
  }
  // Home posts start held by their armies (rules.surface.homePostsOwned), as in a match.
  for (const p of posts) entities.push({ id: p.id, kind: 'post', side: p.home !== undefined && rules.surface.homePostsOwned ? p.home : 'neutral', plane: 'surface', x: p.x, y: p.y, hp: 1, maxHp: 1, state: 'idle' });
  // Depths illustration (a generated map's real layers are secret per match): sealed magma shows as a located pocket does.
  const depths = Array.from(world.cells, (cell, c) => (world.magma[c] ? CELL.magma : cell));
  const pockets: View['pockets'] = [];
  for (let c = 0; c < n; c++) if (world.magma[c]) pockets.push({ x: c % size, y: Math.floor(c / size), id: world.magma[c]! });
  const vision = allVisible(n);
  const none = new Array<number>(vision.length).fill(0);
  const planeIncome = { alloy: 0, energy: 0, upkeep: 0 };
  return {
    tick: 0,
    army: armies[0]!.id,
    eliminated: [],
    outcome: 'running',
    rulesHash: match.rulesHash,
    match,
    res: { alloy: 0, energy: 0, freeAlloy: 0, freeEnergy: 0, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0, upkeepHeld: 0, alloyRate: 0, energyRate: 0, solarRate: 0, energyCap: 0, energyBank: 0, upkeep: 0, income: { depths: planeIncome, surface: planeIncome, sky: planeIncome, orbit: planeIncome }, scanReadyAt: 0, rebuilds: match.rules.spire.rebuilds },
    sun: { angle: sunAngleAt(0, match.sun.speed) },
    islands,
    weather: { storms: [], forecast: [], fog: weather.fog.map((c) => ({ x: c.x, y: c.y, radius: c.radius })), seeded: [], seedWarnings: [] },
    schedule: [],
    seats: [],
    spire: PLANES.map((plane) => ({ plane, hp: tables.spireHp[plane], maxHp: tables.spireHp[plane] })),
    queue: [],
    research: { available: [], inProgress: [], completed: [], seen: [] },
    entities,
    holes: [],
    impacts: [],
    oreCaches: [],
    scorches: [],
    events: [],
    depths,
    fx: [],
    vision: { depths: vision, surface: vision, sky: vision, orbit: vision },
    memory: [],
    charges: [],
    flares: [],
    lodes: world.lodes.map((l) => ({ x: l.c % size, y: Math.floor(l.c / size), rich: l.rich, loads: l.loads, open: false })),
    pockets,
    cracks: [],
    tremors: [],
    alerts: [],
    designations: { normal: none, urgent: none },
    rally: [],
    signals: [],
  };
}
