/**
 * Match rules (DESIGN §2.1). Every gameplay and map number in the rules/ tables (ECON, STATS, SPIRE_HP, the map
 * defaults) is a default: a match's rules are its
 * `matchOptions` (every field optional and bounded; omitted fields use the host's defaults, then these), the same for
 * both teams, recorded in replays with the seed, and carried in full by every observation (`rules`). Durations in the
 * rules are seconds; the sim runs on `compileRules(rules)`, the shape of ECON/STATS (ticks).
 */
import { type BoolS, type Infer, type IntS, type NumS, type ObjS, type OptS, type Schema, t, validate } from 'playerthree/schema';
import { INLINE_MAP_DOCUMENT_BYTES, type MapDocument, validateMapDocument } from '../maps/document.ts';
import { mapDescriptor } from '../maps/registry.ts';
import { fnv1a } from '../util/fnv.ts';
import { derelictGeometry, passWidth, widestOrbitShip } from './derelict.ts';
import { type Econ, ECON } from './econ.ts';
import { CROWNS_SPIRE_HP, SPIRE_CORNER, SPIRE_HP, type StatKind, type Stats, STATS } from './stats.ts';
import { FLANK_ANCHOR, MOTHER_LODE_MAX_CELLS, SPIRE_INSET_MAX, SPIRE_INSET_MIN, spirePositions, type SpirePositions } from './terrain.ts';
import { type ArmyId, DEFAULT_TERRAIN, LOSS_RULES, MAP_SIZES, MAX_ARMIES, MAX_MAP_SIZE, MAX_POST_COUNT, PLANES, type Plane, TERRAIN_PRESETS, TICK_RATE, toTicks } from './vocabulary.ts';
import { compileRules, isStatSeconds, SCALAR_GROUPS, type ScalarSpec } from './rule-tables.ts';

/** Ticks → seconds (exact for whole tick counts; `toTicks` maps it back). */
const sec = (ticks: number): number => ticks / TICK_RATE;
/** Default match length cap (seconds). */
const TIME_CAP = 30 * 60;

type ScalarFields<S extends ScalarSpec> = { readonly [K in keyof S]: OptS<S[K][1] extends 'int' ? IntS : S[K][1] extends 'bool' ? BoolS : NumS> };
function scalarGroup<S extends ScalarSpec>(spec: S, doc: string): ObjS<ScalarFields<S>> {
  const fields: Record<string, Schema> = {};
  for (const [key, [econ, unit, min, max, text]] of Object.entries(spec)) {
    const value = unit === 'sec' ? `${sec(ECON[econ] as number)} s` : `${ECON[econ]}`;
    fields[key] = t.opt(unit === 'bool' ? t.bool(`${text} Default ${value}.`) : unit === 'int' ? t.int(min, max, `${text} Default ${value}.`) : t.num(min, max, `${text} Default ${value}.`));
  }
  return t.obj(fields, doc) as ObjS<ScalarFields<S>>;
}


const MAP_DEFAULTS = {
  size: 48,
  slots: 2,
  spireInset: 3,
  spirePocketRadius: 2.6,
  spireClearing: 6.5,
  featureMargin: 4,
  faultSets: 2,
  centralFault: 0.5,
  islandRings: 3,
  islandClearance: 6,
  islandMaxRings: 8,
  islandOreRings: 1,
  islandOreAmount: 240,
  caverns: true,
  cavernChambers: 2,
  magmaPockets: 3,
  bedrockOutcrops: 4,
  homeVeins: 2,
  contestedVeins: 10,
  oreRim: 5,
  oreCentre: 16,
  oreFalloff: 16,
  homeLodes: 2,
  homeLodeLoads: 80,
  homeLodeMinRadius: 6.5,
  homeLodeMaxRadius: 10,
  homeLodeFallbackRadius: 16,
  lodeSpacing: 6,
  lodeSpares: 1,
  motherLode: { enabled: true, cells: 4, placement: 'centre', radius: 8, ringWidth: 1, knownAtStart: true },
  lavaLakes: { enabled: true, moatWidth: 2, channels: 1, channelWidth: 2, channelLength: 8, channelDistance: 13, lakes: 1, lakeRadius: 3.2, islandRadius: 1.2, margin: 4 },
  richOre: { enabled: true, clusters: 2, cells: 3, loads: 8, radius: 11, bearing: 28, knownAtStart: true },
  postCount: 2,
  postDistanceMin: 9,
  postDistanceMax: 11,
  postSpread: 30,
  postClearance: 2.5,
  contestedPosts: ['centre', 'flanks'],
  contestedPostOffset: 6,
  contestedZones: [{ kind: 'flanks', sets: 1, loads: 150, minRadius: 0, maxRadius: 9, maxSkew: 10 }],
  islandRingLayout: [{ radius: 8, period: 70 }, { radius: 14, period: 100 }, { radius: 20, period: 140 }],
  template: {
    passWidth: 3, flankWidth: 6, barrierThickness: 2, lakeRadius: 4, lakeSpacing: 12, plateauRadius: 7,
    rampWidth: 3, riverWidth: 3, fordSpacing: 12, highlandWidth: 6, jitter: 1,
    orbitWidth: 12, orbitLength: 18, orbitSpread: 0.25,
    orbitHomeWeight: 1, orbitFlankWeight: 1, orbitCentreWeight: 1,
  },
  plateau: { rim: 1.2, rampReach: 1.6 },
  stream: { steps: 40, clearance: 2 },
  open: { forests: 7, forestClear: 9, forestRadius: 1.2, forestSpan: 1.4, hills: 2, hillClear: 11, hillMargin: 8, hillRadius: 1.8, hillSpan: 0.8 },
  ridges: {
    walls: 3, wallClear: 10, wallLength: 6, wallLengthSpan: 5, wallGaps: 1, wallThickness: 1,
    plateaus: 2, plateauClear: 12, plateauMargin: 8, plateauRadius: 2, plateauSpan: 1.2, ramps: 2, rampsSpan: 2,
    forests: 5, forestClear: 9, forestRadius: 1, forestSpan: 1.3,
  },
  canyons: {
    wallOffset: 6, wallOffsetSpan: 2, wallStart: 9, wallStartSpan: 3, wallLength: 24, wallLengthSpan: 6, wallGaps: 2, wallThickness: 2,
    mesa: 30, mesaSpan: 6, mesaRadius: 3, mesaRadiusSpan: 1, mesaRamps: 2,
    forests: 6, forestClear: 9, forestRadius: 1, forestSpan: 1.2,
  },
  fault: { clearance: 9, edge: 2, centralHalf: 9, centralMin: 6, margin: 6, length: 14, lengthSpan: 6, minLength: 8 },
  bedrock: { margin: 4, radius: 1, radiusSpan: 1.2 },
  cavern: { chamberFirst: 4, chamberSpacing: 7, edge: 2, centreRadius: 2.2, sharedSkew: 6 },
  magma: { margin: 4, cells: 3 },
  vein: {
    edge: 2, homeDistance: 5, homeDistanceSpan: 2.5, homeLength: 7, homeLengthSpan: 4,
    contestedMargin: 3, contestedClear: 6, contestedLength: 6, contestedLengthSpan: 6,
    centreOffset: 1, centreLength: 8, satellites: 2, satelliteOffset: 6, satelliteLength: 5, satelliteLengthSpan: 3,
  },
} as const;
const M = MAP_DEFAULTS;
// Lengths marked "S48 tiles" scale by map.size/48; plain "tiles" are physical cells on every size. "Span": the most a
// seeded draw adds to its base value (whole cells for counts and lengths).
const mapRules = t.obj(
  {
    size: t.opt(t.int(MAP_SIZES[0], MAX_MAP_SIZE, 'Square map side: 48 (S), 64 (M), or 80 (L). Default 48.')),
    slots: t.opt(t.int(2, MAX_ARMIES, `Army slots (corners) of a generated map: 2 = nw/se, point-symmetric (C2); 4 = all four corners, quarter-turn symmetric (C4). 3 is invalid. Authored maps carry their own slots. Default ${M.slots}.`)),
    spireInset: t.opt(t.int(SPIRE_INSET_MIN, SPIRE_INSET_MAX, `Cells from both edges of its corner to each Spire footprint's centre cell: the nw Spire stands at (inset + 0.5, inset + 0.5), the others at its quarter turns about the map centre (se: size − inset − 0.5 on both axes). The home pocket, home lodes, cavern and spawns are laid out around it. Default ${M.spireInset} (centres ${M.spireInset + 0.5}/${M.size - M.spireInset - 0.5} on S${M.size}).`)),
    spirePocketRadius: t.opt(t.num(0, 5, `Radius in tiles of the pre-dug Depths tunnel pocket around each Spire root (it always includes the root footprint and its one-cell loading apron). Default ${M.spirePocketRadius}.`)),
    spireClearing: t.opt(t.num(4, 16, `Surface radius in tiles around each Spire that terrain leaves as plain ground (room to build and spawn); lode sites are never prepared inside it. Default ${M.spireClearing}.`)),
    featureMargin: t.opt(t.num(1, 16, `Least distance in tiles from the map edge to open/ridges/canyons feature spots (forests, ridge walls); hills and ridge plateaus use their own margins. Default ${M.featureMargin}.`)),
    faultSets: t.opt(t.int(0, 3, `Fault-line budget in symmetric sets (one line per slot sector: a pair on two-slot maps, four on four-slot maps); a fault through the centre (invariant under the map's turns) uses one set. Default ${M.faultSets}.`)),
    centralFault: t.opt(t.num(0, 1, `Chance of a fault through the map centre (needs faultSets ≥ 1; on four-slot maps a centre cross). Default ${M.centralFault}.`)),
    islandRings: t.opt(t.int(0, 8, `Sky island rings on S48, one island per slot on each ring (an orbit of the map's turns). Larger maps add outer rings (round(rings × size/48), as many as fit at islandClearance spacing), never more islands per ring. Default ${M.islandRings}.`)),
    islandClearance: t.opt(t.num(4, 16, `Minimum distance in tiles between any two island centres at any tick (two island radii plus margin): adjacent rings are at least this far apart radially and the innermost ring's islands at least this far apart across it (90° apart on four-slot maps). Default ${M.islandClearance}.`)),
    islandMaxRings: t.opt(t.int(0, 8, `Most Sky island rings on any map size, whatever islandRings asks for. Default ${M.islandMaxRings}.`)),
    islandOreRings: t.opt(t.int(0, 8, `Outermost complete Sky island rings that actually fit to receive finite ore deposits, one equal deposit per slot on each selected ring. 0 disables island deposits without changing orbits. Default ${M.islandOreRings}.`)),
    islandOreAmount: t.opt(t.int(0, 100000, `Initial ore per island on the selected islandOreRings; 0 disables deposits. Static public capacity, not extracted cargo. Default ${M.islandOreAmount}.`)),
    caverns: t.opt(t.bool(`Natural caverns: a winding tunnel from each Spire root to a chamber at the centre; each army starts knowing its own arm. Default ${M.caverns}.`)),
    cavernChambers: t.opt(t.int(0, 6, `Side chambers along each cavern. Default ${M.cavernChambers}.`)),
    magmaPockets: t.opt(t.int(0, 6, `Hidden magma pockets, in symmetric sets. Default ${M.magmaPockets}.`)),
    bedrockOutcrops: t.opt(t.int(0, 12, `Bedrock outcrop attempts (symmetric; tunnels route around them). Default ${M.bedrockOutcrops}.`)),
    homeVeins: t.opt(t.int(0, 6, `Ore veins a short dig from each Spire. Default ${M.homeVeins}.`)),
    contestedVeins: t.opt(t.int(0, 30, `Ore vein attempts away from the Spires (symmetric). Default ${M.contestedVeins}.`)),
    oreRim: t.opt(t.int(1, 60, `Ore loads per ore cell near the bases. Default ${M.oreRim}.`)),
    oreCentre: t.opt(t.int(1, 60, `Ore loads per ore cell at the map centre (linear in between). Default ${M.oreCentre}.`)),
    oreFalloff: t.opt(t.num(1, 60, `Distance from the map centre in S48 tiles over which an ore cell's loads fall from oreCentre to oreRim; scales with map size. Default ${M.oreFalloff}.`)),
    homeLodes: t.opt(t.int(0, 4, `Lodes near each base (sealed ore pockets a Headframe opens; symmetric). Default ${M.homeLodes}.`)),
    homeLodeLoads: t.opt(t.int(8, 2000, `Ore loads in a home lode pocket (× economy.oreLoad alloy). Default ${M.homeLodeLoads}.`)),
    homeLodeMinRadius: t.opt(t.num(6.5, 20, `Inner distance from the home Spire to a lode outcrop centre. Default ${M.homeLodeMinRadius}.`)),
    homeLodeMaxRadius: t.opt(t.num(6.5, 20, `Outer preferred home distance; placement widens and prepares sites inside this band before using homeLodeFallbackRadius. Must be ≥ homeLodeMinRadius. Default ${M.homeLodeMaxRadius}.`)),
    homeLodeFallbackRadius: t.opt(t.num(6.5, 20, `Last-resort home radius after all preferred-band sites fail, reported in generator accounting. Values below homeLodeMaxRadius disable extra widening. Default ${M.homeLodeFallbackRadius}.`)),
    lodeSpacing: t.opt(t.num(6, 20, `Minimum distance between all outcrops, including symmetric twins. Default ${M.lodeSpacing}.`)),
    lodeSpares: t.opt(t.int(0, 3, `Spare public lode sites per zone: where the Surface offers fewer than a zone's requested lodes plus this many sites (each lodeSpacing from the others) inside its preferred band, the public map levels the least-changed extra sites, so the secret placement still chooses among them. Default ${M.lodeSpares}.`)),
    postCount: t.opt(t.int(1, MAX_POST_COUNT, `Forward posts per army (rules.surface.postsEnabled), spread across postSpread either side of its Spire→centre line, one per side when 2. Default ${M.postCount}.`)),
    postDistanceMin: t.opt(t.num(3, 40, `Nearest a forward post stands to its army's Spire centre (tiles). At most postDistanceMax. Default ${M.postDistanceMin}.`)),
    postDistanceMax: t.opt(t.num(3, 40, `Farthest a forward post stands from its army's Spire centre (tiles); a post falls back to the nearest free ground outside the band only when its flank has none. Default ${M.postDistanceMax}.`)),
    postSpread: t.opt(t.num(0, 45, `Bearing (degrees) of the outermost forward posts either side of the Spire→map-centre line, toward the flanks. Default ${M.postSpread}.`)),
    postClearance: t.opt(t.num(0, 8, `Tiles a forward post keeps from its army's Spire→centre line (where the default rally and the army form up), and the clearance lode outcrops and aprons prefer to keep from every post (the secret placement takes a site this clear, else one not covering a post, inside the home band before any other). Default ${M.postClearance}.`)),
    contestedPosts: t.opt(t.list(t.enum(['centre', 'flanks'], 'centre: one contested point on the map centre (the point every turn of the map fixes; skipped when none of its four cells is reachable open ground). flanks: one per map slot, contestedPostOffset from each flank lode anchor (the contestedZones flank anchors) toward the centre.'), 2, `Contested points (rules.surface.postsEnabled), each kind at most once: neutral Surface posts every army can race for, beside the home posts. Default ${M.contestedPosts.join(' + ')} (3 on two-slot maps, 5 on four-slot maps). Empty: none. Authored maps place their own.`)),
    contestedPostOffset: t.opt(t.num(0, 16, `S48 tiles from each flank lode anchor toward the map centre to a flank contested point (the open, reachable cell nearest that spot); scales with map size. Default ${M.contestedPostOffset}.`)),
    contestedZones: t.opt(t.list(t.obj({
      kind: t.enum(['flanks', 'centre'], `flanks: Spire-free contested ground between neighbouring corners (S48 two-slot: (${FLANK_ANCHOR.x},${FLANK_ANCHOR.y})/(${FLANK_ANCHOR.y},${FLANK_ANCHOR.x}); four-slot: the edge midpoints); centre: the map midpoint.`),
      sets: t.int(0, 3, 'Requested symmetric lode sets in this zone (one lode per slot sector per set).'),
      loads: t.int(8, 2000, 'Ore loads per contested pocket (all contested lodes are marked rich).'),
      minRadius: t.num(0, 16, 'Inner distance from the zone anchor to the outcrop centre.'),
      maxRadius: t.num(0, 16, 'Outer distance from the anchor; must be ≥ minRadius. Widening never exceeds this bound.'),
      maxSkew: t.num(0, 16, 'Maximum difference in distances to the two nearest Spires; 0 requires exactly equidistant sites.'),
    }), 4, 'Contested zones, placed in list order. Default: one rich flank set, 150 loads each, radius 0–9, Spire distance skew ≤10. Empty disables contested lodes. Centre equivalent: radius 4–13, skew ≤10.')),
    motherLode: t.opt(t.obj({
      enabled: t.opt(t.bool(`Place the Mother Lode. Default ${M.motherLode.enabled}.`)),
      cells: t.opt(t.int(0, MOTHER_LODE_MAX_CELLS, `Mother Lode cells, rounded down to whole orbits of the map's turns (two slots: pairs; four slots: fours); centre placement holds at most the 4 centre cells. Default ${M.motherLode.cells}.`)),
      placement: t.opt(t.enum(['centre', 'ring'], `centre: the centre 2×2 cells (two slots: the pair through (size/2 − 1, size/2 − 1) first, then the pair through (size/2, size/2 − 1)); ring: evenly spaced at radius from the map centre, half a spacing off the Spire bearings. Default ${M.motherLode.placement}.`)),
      radius: t.opt(t.num(4, 12, `Ring placement: distance in S48 tiles from the map centre to the lode cells; scales with map size. At least 4, so even eight lode cells never touch and wall in the cells between them. Default ${M.motherLode.radius}.`)),
      ringWidth: t.opt(t.int(1, 3, `Open tunnel in tiles (Chebyshev) around every lode cell. Default ${M.motherLode.ringWidth}.`)),
      knownAtStart: t.opt(t.bool(`Every army knows the lode cells and their tunnel ring from the start; otherwise they are found like other cells. Default ${M.motherLode.knownAtStart}.`)),
    }, 'The Mother Lode: solid lode cells (Depths code 8: mined from beside, never dug; mining rules in rules.depths.motherLode*) ringed by open tunnel. A public map stage: placed from these rules alone before any secret layer (magma, ore, lodes and caverns generate around it). An orbit whose cells or ring would leave the inner map or touch a Spire pocket is skipped. Authored maps carry their own or none.')),
    lavaLakes: t.opt(t.obj({
      enabled: t.opt(t.bool(`Generate permanent lava lakes (Depths code 11: burns like magma, never cools; a hidden layer, fogged until seen). Off reproduces maps without them exactly. Default ${M.lavaLakes.enabled}.`)),
      moatWidth: t.opt(t.int(0, 4, `Width in tiles of the lava moat around each green rich-ore cluster (map.richOre), one rock tile out from its cells; 0: no moats. Default ${M.lavaLakes.moatWidth}.`)),
      channels: t.opt(t.int(0, 1, `Lava channels across each army's cavern arm (free-form and template caverns): a short bridged crossing beats the dry detour carved round the channel's end. Default ${M.lavaLakes.channels}.`)),
      channelWidth: t.opt(t.int(1, 4, `Channel width in tiles along the cavern (the bridge span a crossing needs). Default ${M.lavaLakes.channelWidth}.`)),
      channelLength: t.opt(t.num(2, 24, `Channel length in S48 tiles across the cavern; scales with map size. Default ${M.lavaLakes.channelLength}.`)),
      channelDistance: t.opt(t.num(4, 30, `Distance in S48 tiles from the Spire to the cavern cell the channel crosses; scales with map size. Default ${M.lavaLakes.channelDistance}.`)),
      lakes: t.opt(t.int(0, 4, `Lava lakes with an ore island in the middle, in symmetric sets (placement tries are seeded; a lake that fits nowhere is skipped). Default ${M.lavaLakes.lakes}.`)),
      lakeRadius: t.opt(t.num(1.5, 6, `Lake radius in tiles. Default ${M.lavaLakes.lakeRadius}.`)),
      islandRadius: t.opt(t.num(0, 4, `Radius in tiles of the ore island in a lake's middle (below lakeRadius). Default ${M.lavaLakes.islandRadius}.`)),
      margin: t.opt(t.int(1, 12, `Least distance in tiles from the map edge to a lake. Default ${M.lavaLakes.margin}.`)),
    }, 'Permanent lava lakes in the Depths: burning magma that never cools, crossed by lava bridges (rules.depths.lavaBridge*). A hidden map stage with its own seeded stream, drawn after the caverns and lodes and turned onto every slot.')),
    richOre: t.opt(t.obj({
      enabled: t.opt(t.bool(`Place green rich ore (Depths code 10). Off reproduces maps without it exactly. Default ${M.richOre.enabled}.`)),
      clusters: t.opt(t.int(1, 4, `Rich clusters per slot sector. Default ${M.richOre.clusters}.`)),
      cells: t.opt(t.int(1, 5, `Rich cells per cluster (its centre, then its canonical neighbours). Default ${M.richOre.cells}.`)),
      loads: t.opt(t.int(1, 200, `Loads per rich cell (× rules.depths.richLoad alloy). Default ${M.richOre.loads}.`)),
      radius: t.opt(t.num(4, 20, `Distance in S48 tiles from the map centre to a cluster's aim (it takes the nearest centre clear of the lode sites); scales with map size. Default ${M.richOre.radius}.`)),
      bearing: t.opt(t.num(5, 60, `Degrees between the Spire→centre line and each cluster's bearing from the centre (clusters alternate sides, spreading by this much more each pair). Default ${M.richOre.bearing}.`)),
      knownAtStart: t.opt(t.bool(`Every army knows the rich cells from the start (a public map feature; the moats around them stay hidden). Default ${M.richOre.knownAtStart}.`)),
    }, 'Green rich ore: a few richer, deliberately hard-to-reach cells (moated with map.lavaLakes on). A public map stage from these rules and the public lode sites (each cluster takes the fitting spot nearest its aim, clear of every lode site); authored maps carry RichOre entities.')),
    islandRingLayout: t.opt(t.list(t.obj({
      radius: t.num(1, 40, 'Ring radius around the map centre in S48 tiles; stretched with the map (route templates set their own radii).'),
      period: t.num(1, 600, 'Orbital period of the ring\'s islands on S48, in seconds; outer rings on larger maps keep this ring\'s linear speed.'),
    }), 8, `S48 Sky island rings, inner to outer (at least one, radii increasing); further rings continue outward at the last spacing (one ring: at its radius) with the outermost ring's linear speed. Default: radii ${M.islandRingLayout.map((ring) => ring.radius).join('/')}, periods ${M.islandRingLayout.map((ring) => ring.period).join('/')} s.`)),
    template: t.opt(t.obj({
      passWidth: t.opt(t.num(1, 20, 'Chokepoint pass width in S48 tiles; scales with map size. Default 3.')),
      flankWidth: t.opt(t.num(1, 20, 'Chokepoint flank route width in S48 tiles. Default 6.')),
      barrierThickness: t.opt(t.num(1, 20, 'Terrain barrier thickness in S48 tiles. Default 2.')),
      lakeRadius: t.opt(t.num(1, 20, 'Archipelago lake radius in S48 tiles. Default 4.')),
      lakeSpacing: t.opt(t.num(1, 20, 'Archipelago lake spacing in S48 tiles. Default 12.')),
      plateauRadius: t.opt(t.num(1, 20, 'Fortress plateau radius in S48 tiles. Default 7.')),
      rampWidth: t.opt(t.num(1, 20, 'Fortress ramp width in S48 tiles. Default 3.')),
      riverWidth: t.opt(t.num(1, 20, 'River width in S48 tiles. Default 3.')),
      fordSpacing: t.opt(t.num(1, 20, 'River crossing spacing in S48 tiles. Default 12.')),
      highlandWidth: t.opt(t.num(1, 20, 'Highland ridge width in S48 tiles. Default 6.')),
      jitter: t.opt(t.num(0, 4, 'Seeded template coordinate variation in S48 tiles. Default 1.')),
      orbitWidth: t.opt(t.num(0.5, 40, 'Orbit placement region width in S48 tiles; scales with map size. Default 12.')),
      orbitLength: t.opt(t.num(0.5, 40, 'Orbit placement region length in S48 tiles; scales with map size. Default 18.')),
      orbitSpread: t.opt(t.num(0, 1, 'Orbit placement scatter within each generated region. Default 0.25.')),
      orbitHomeWeight: t.opt(t.num(0.01, 100, 'Relative asteroid placement weight of home Orbit regions. Default 1.')),
      orbitFlankWeight: t.opt(t.num(0.01, 100, 'Relative asteroid placement weight of flank Orbit regions. Default 1.')),
      orbitCentreWeight: t.opt(t.num(0.01, 100, 'Relative asteroid placement weight of central Orbit regions. Default 1.')),
    }, 'Template geometry in S48 tiles, scaled by map.size/48.')),
    plateau: t.opt(t.obj({
      rim: t.opt(t.num(0.5, 4, `Cliff rim width around a ridges plateau or canyons mesa, in S48 tiles. Default ${M.plateau.rim}.`)),
      rampReach: t.opt(t.num(0.5, 6, `How far a ramp reaches past the plateau edge, in S48 tiles. Default ${M.plateau.rampReach}.`)),
    }, 'Ridges plateaus and the canyons mesa: high ground inside a cliff rim, reached by ramps.')),
    stream: t.opt(t.obj({
      steps: t.opt(t.num(0, 120, `Most steps of the centre ford stream walk (open, canyons) on S48; scales with map size. Default ${M.stream.steps}.`)),
      clearance: t.opt(t.num(0, 16, `Ford-free distance in tiles beyond spireClearing around either Spire. Default ${M.stream.clearance}.`)),
    }, 'The sinuous ford stream through the centre, roughly along the anti-diagonal.')),
    open: t.opt(t.obj({
      forests: t.opt(t.int(0, 30, `Forest discs (turned onto every slot). Default ${M.open.forests}.`)),
      forestClear: t.opt(t.num(0, 30, `Least distance in tiles from either Spire to a forest centre. Default ${M.open.forestClear}.`)),
      forestRadius: t.opt(t.num(0.5, 6, `Forest radius in S48 tiles, plus up to forestSpan. Default ${M.open.forestRadius}.`)),
      forestSpan: t.opt(t.num(0, 6, `Seeded extra forest radius in S48 tiles. Default ${M.open.forestSpan}.`)),
      hills: t.opt(t.int(0, 8, `Raised hills (turned onto every slot). Default ${M.open.hills}.`)),
      hillClear: t.opt(t.num(0, 30, `Least distance in tiles from either Spire to a hill centre. Default ${M.open.hillClear}.`)),
      hillMargin: t.opt(t.num(1, 16, `Least distance in tiles from the map edge to a hill centre. Default ${M.open.hillMargin}.`)),
      hillRadius: t.opt(t.num(0.5, 6, `Hill radius in S48 tiles, plus up to hillSpan. Default ${M.open.hillRadius}.`)),
      hillSpan: t.opt(t.num(0, 6, `Seeded extra hill radius in S48 tiles. Default ${M.open.hillSpan}.`)),
    }, 'The open preset: scattered forests, raised hills and the centre stream.')),
    ridges: t.opt(t.obj({
      walls: t.opt(t.int(0, 10, `Cliff walls across the base-to-base line (turned onto every slot). Default ${M.ridges.walls}.`)),
      wallClear: t.opt(t.num(0, 30, `Least distance in tiles from either Spire to a wall start. Default ${M.ridges.wallClear}.`)),
      wallLength: t.opt(t.int(1, 40, `Wall length in S48 tiles, plus up to wallLengthSpan − 1. Default ${M.ridges.wallLength}.`)),
      wallLengthSpan: t.opt(t.int(0, 20, `Seeded extra wall length: a whole number of S48 tiles below this. Default ${M.ridges.wallLengthSpan}.`)),
      wallGaps: t.opt(t.int(0, 6, `Two-tile gaps per wall. Default ${M.ridges.wallGaps}.`)),
      wallThickness: t.opt(t.int(1, 4, `Wall thickness in tiles. Default ${M.ridges.wallThickness}.`)),
      plateaus: t.opt(t.int(0, 6, `Ramped plateaus (turned onto every slot). Default ${M.ridges.plateaus}.`)),
      plateauClear: t.opt(t.num(0, 30, `Least distance in tiles from either Spire to a plateau centre. Default ${M.ridges.plateauClear}.`)),
      plateauMargin: t.opt(t.num(1, 16, `Least distance in tiles from the map edge to a plateau centre. Default ${M.ridges.plateauMargin}.`)),
      plateauRadius: t.opt(t.num(0.5, 8, `Plateau radius in S48 tiles, plus up to plateauSpan. Default ${M.ridges.plateauRadius}.`)),
      plateauSpan: t.opt(t.num(0, 6, `Seeded extra plateau radius in S48 tiles. Default ${M.ridges.plateauSpan}.`)),
      ramps: t.opt(t.int(0, 8, `Ramps per plateau, plus up to rampsSpan − 1. Default ${M.ridges.ramps}.`)),
      rampsSpan: t.opt(t.int(0, 8, `Seeded extra ramps per plateau: a whole number below this. Default ${M.ridges.rampsSpan}.`)),
      forests: t.opt(t.int(0, 30, `Forest discs on plain ground (turned onto every slot). Default ${M.ridges.forests}.`)),
      forestClear: t.opt(t.num(0, 30, `Least distance in tiles from either Spire to a forest centre. Default ${M.ridges.forestClear}.`)),
      forestRadius: t.opt(t.num(0.5, 6, `Forest radius in S48 tiles, plus up to forestSpan. Default ${M.ridges.forestRadius}.`)),
      forestSpan: t.opt(t.num(0, 6, `Seeded extra forest radius in S48 tiles. Default ${M.ridges.forestSpan}.`)),
    }, 'The ridges preset: gapped cliff walls across the lanes, ramped plateaus and forests.')),
    canyons: t.opt(t.obj({
      wallOffset: t.opt(t.num(0, 20, `Offset of each long wall from the base diagonal in S48 tiles, plus up to wallOffsetSpan. Default ${M.canyons.wallOffset}.`)),
      wallOffsetSpan: t.opt(t.num(0, 10, `Seeded extra wall offset in S48 tiles. Default ${M.canyons.wallOffsetSpan}.`)),
      wallStart: t.opt(t.num(0, 30, `Wall start along the base diagonal in S48 tiles per axis, plus up to wallStartSpan. Default ${M.canyons.wallStart}.`)),
      wallStartSpan: t.opt(t.num(0, 20, `Seeded extra wall start in S48 tiles. Default ${M.canyons.wallStartSpan}.`)),
      wallLength: t.opt(t.int(1, 60, `Wall length in S48 tiles, plus up to wallLengthSpan − 1. Default ${M.canyons.wallLength}.`)),
      wallLengthSpan: t.opt(t.int(0, 20, `Seeded extra wall length: a whole number of S48 tiles below this. Default ${M.canyons.wallLengthSpan}.`)),
      wallGaps: t.opt(t.int(0, 6, `Two-tile gaps per wall. Default ${M.canyons.wallGaps}.`)),
      wallThickness: t.opt(t.int(1, 4, `Wall thickness in tiles. Default ${M.canyons.wallThickness}.`)),
      mesa: t.opt(t.num(0, 40, `Corner mesa centre at (m, size − m): m in S48 tiles, plus up to mesaSpan. Default ${M.canyons.mesa}.`)),
      mesaSpan: t.opt(t.num(0, 20, `Seeded extra mesa position in S48 tiles. Default ${M.canyons.mesaSpan}.`)),
      mesaRadius: t.opt(t.num(0.5, 8, `Mesa radius in S48 tiles, plus up to mesaRadiusSpan. Default ${M.canyons.mesaRadius}.`)),
      mesaRadiusSpan: t.opt(t.num(0, 4, `Seeded extra mesa radius in S48 tiles. Default ${M.canyons.mesaRadiusSpan}.`)),
      mesaRamps: t.opt(t.int(0, 8, `Ramps up the mesa. Default ${M.canyons.mesaRamps}.`)),
      forests: t.opt(t.int(0, 30, `Forest discs on plain ground (turned onto every slot). Default ${M.canyons.forests}.`)),
      forestClear: t.opt(t.num(0, 30, `Least distance in tiles from either Spire to a forest centre. Default ${M.canyons.forestClear}.`)),
      forestRadius: t.opt(t.num(0.5, 6, `Forest radius in S48 tiles, plus up to forestSpan. Default ${M.canyons.forestRadius}.`)),
      forestSpan: t.opt(t.num(0, 6, `Seeded extra forest radius in S48 tiles. Default ${M.canyons.forestSpan}.`)),
    }, 'The canyons preset: two long gapped walls parallel to the base diagonal (three lanes), a corner mesa, the centre stream and forests.')),
    fault: t.opt(t.obj({
      clearance: t.opt(t.num(0, 20, `Least distance in tiles from either Spire to a fault cell (never inside the home lode band and its seal). Default ${M.fault.clearance}.`)),
      edge: t.opt(t.int(1, 8, `Fault-free border in tiles along the map edge. Default ${M.fault.edge}.`)),
      centralHalf: t.opt(t.int(1, 24, `Most cells on each half of the central fault. Default ${M.fault.centralHalf}.`)),
      centralMin: t.opt(t.int(1, 48, `Shortest central fault kept, in cells. Default ${M.fault.centralMin}.`)),
      margin: t.opt(t.num(1, 16, `Least distance in tiles from the map edge to a fault pair's start. Default ${M.fault.margin}.`)),
      length: t.opt(t.int(1, 40, `Most cells per paired fault, plus up to lengthSpan − 1. Default ${M.fault.length}.`)),
      lengthSpan: t.opt(t.int(0, 20, `Seeded extra paired fault cells: a whole number below this. Default ${M.fault.lengthSpan}.`)),
      minLength: t.opt(t.int(1, 40, `Shortest paired fault kept, in cells. Default ${M.fault.minLength}.`)),
    }, 'Fault lines: wandering walks over open ground, in tiles on every map size.')),
    bedrock: t.opt(t.obj({
      margin: t.opt(t.int(1, 12, `Least distance in tiles from the map edge to an outcrop centre. Default ${M.bedrock.margin}.`)),
      radius: t.opt(t.num(0.5, 4, `Outcrop radius in tiles, plus up to radiusSpan. Default ${M.bedrock.radius}.`)),
      radiusSpan: t.opt(t.num(0, 4, `Seeded extra outcrop radius in tiles. Default ${M.bedrock.radiusSpan}.`)),
    }, 'Bedrock outcrops in the Depths, in tiles on every map size.')),
    cavern: t.opt(t.obj({
      chamberFirst: t.opt(t.int(0, 40, `Cavern steps (one tile each) before the first side chamber on free-form maps. Default ${M.cavern.chamberFirst}.`)),
      chamberSpacing: t.opt(t.int(1, 30, `Cavern steps (one tile each) between side chambers on free-form maps. Default ${M.cavern.chamberSpacing}.`)),
      edge: t.opt(t.int(1, 8, `Cavern-free border in tiles along the map edge on free-form maps. Default ${M.cavern.edge}.`)),
      centreRadius: t.opt(t.num(1, 6, `Radius in tiles of the centre chamber on free-form maps (at least 1, so both teams' tunnels meet in it). Default ${M.cavern.centreRadius}.`)),
      sharedSkew: t.opt(t.num(0, 20, `Cavern cells up to this many tiles nearer the enemy Spire still start in a team's knowledge (the centre chamber both teams know). Default ${M.cavern.sharedSkew}.`)),
    }, 'Natural caverns (map.caverns). Route templates carve them along their surface route instead.')),
    magma: t.opt(t.obj({
      margin: t.opt(t.int(1, 12, `Least distance in tiles from the map edge to a magma pocket. Default ${M.magma.margin}.`)),
      cells: t.opt(t.int(1, 4, `Most cells per magma pocket. Default ${M.magma.cells}.`)),
    }, 'Hidden magma pockets (map.magmaPockets).')),
    vein: t.opt(t.obj({
      edge: t.opt(t.int(1, 8, `Ore-free border in tiles along the map edge. Default ${M.vein.edge}.`)),
      homeDistance: t.opt(t.num(2, 16, `Home vein start distance in tiles from the Spire, plus up to homeDistanceSpan. Default ${M.vein.homeDistance}.`)),
      homeDistanceSpan: t.opt(t.num(0, 8, `Seeded extra home vein distance in tiles. Default ${M.vein.homeDistanceSpan}.`)),
      homeLength: t.opt(t.int(0, 30, `Home vein steps, plus up to homeLengthSpan − 1. Default ${M.vein.homeLength}.`)),
      homeLengthSpan: t.opt(t.int(0, 20, `Seeded extra home vein steps: a whole number below this. Default ${M.vein.homeLengthSpan}.`)),
      contestedMargin: t.opt(t.int(1, 16, `Least distance in tiles from the map edge to a contested vein start. Default ${M.vein.contestedMargin}.`)),
      contestedClear: t.opt(t.num(0, 30, `Contested veins start more than this many tiles from either Spire. Default ${M.vein.contestedClear}.`)),
      contestedLength: t.opt(t.int(0, 30, `Contested vein steps, plus up to contestedLengthSpan − 1. Default ${M.vein.contestedLength}.`)),
      contestedLengthSpan: t.opt(t.int(0, 20, `Seeded extra contested vein steps: a whole number below this. Default ${M.vein.contestedLengthSpan}.`)),
      centreOffset: t.opt(t.int(0, 8, `The centre vein starts at least this many tiles up-left of the map centre (per axis). Default ${M.vein.centreOffset}.`)),
      centreLength: t.opt(t.int(0, 40, `Centre vein steps. Default ${M.vein.centreLength}.`)),
      satellites: t.opt(t.int(0, 8, `Satellite veins around the centre vein (turned onto every slot). Default ${M.vein.satellites}.`)),
      satelliteOffset: t.opt(t.int(0, 16, `Satellite veins start at most this many tiles up-left of the map centre (per axis). Default ${M.vein.satelliteOffset}.`)),
      satelliteLength: t.opt(t.int(0, 30, `Satellite vein steps, plus up to satelliteLengthSpan − 1. Default ${M.vein.satelliteLength}.`)),
      satelliteLengthSpan: t.opt(t.int(0, 20, `Seeded extra satellite vein steps: a whole number below this. Default ${M.vein.satelliteLengthSpan}.`)),
    }, 'Ore veins: random walks of one tile per step (ore loads per cell: oreRim, oreCentre, oreFalloff), in tiles on every map size.')),
  },
  'Map generation: seeded and symmetric under the turns of its slots (two slots: the point mirror; four slots: quarter turns), every placement turned onto every slot, never per army. Sizes: 48×48, 64×64, 80×80.',
);

const statCost = (k: StatKind) => ({
  hp: t.opt(t.int(1, 100_000, `Hit points. Default ${STATS[k].hp}.`)),
  alloy: t.opt(t.int(0, 10_000, `Alloy cost. Default ${STATS[k].alloy}.`)),
  energy: t.opt(t.int(0, 10_000, `Energy cost. Default ${STATS[k].energy}.`)),
  build: t.opt(t.num(0.05, 300, `Time to produce (units) or construct (structures). Default ${sec(STATS[k].build)} s.`)),
  vision: t.opt(t.num(0, 16, `Vision radius in tiles; 0 provides no sight radius. Default ${STATS[k].vision}.`)),
});
const statMove = (k: StatKind) => ({
  speed: t.opt(t.num(0.1, 10, `Speed in tiles per second. Default ${STATS[k].speed}.`)),
});
const statOrbitMove = (k: StatKind) => ({
  ...statMove(k),
  orbitAcceleration: t.opt(t.num(0.1, 40, `Orbit-only thrust acceleration in tiles/s². Default ${STATS[k].orbitAcceleration}.`)),
  orbitTurnRate: t.opt(t.num(0.1, 12, `Orbit-only maximum velocity turn rate in radians/s. Default ${STATS[k].orbitTurnRate}.`)),
});
const statWeapon = (k: StatKind) => ({
  dmg: t.opt(t.num(1, 1000, `Damage per shot, before the weapon-vs-armor multiplier. Default ${STATS[k].dmg}.`)),
  range: t.opt(t.num(0.5, 12, `Weapon range in tiles (centre to target edge). Default ${STATS[k].range}.`)),
  cooldown: t.opt(t.num(0.05, 30, `Time between shots. Default ${sec(STATS[k].cooldown)} s.`)),
});
const armedUnit = (k: StatKind) => t.opt(t.obj({ ...statCost(k), ...statMove(k), ...statWeapon(k) }));
const shieldUnit = (k: StatKind) => t.opt(t.obj({
  ...statCost(k), ...statOrbitMove(k), ...statWeapon(k),
  shield: t.opt(t.num(0, 100_000, `Orbit shield capacity. Default ${STATS[k].shield}.`)),
  shieldRegen: t.opt(t.num(0, 1000, `Orbit shield HP restored per second. Default ${STATS[k].shieldRegen}.`)),
  shieldDelay: t.opt(t.num(0, 120, `Seconds out of combat before shield recharge. Default ${sec(STATS[k].shieldDelay!)}.`)),
}));
const unarmedOrbitUnit = (k: StatKind) => t.opt(t.obj({ ...statCost(k), ...statOrbitMove(k) }));
const statsRules = t.obj(
  {
    digger: armedUnit('digger'),
    sapper: t.opt(t.obj({ ...statCost('sapper'), ...statMove('sapper') })),
    trooper: armedUnit('trooper'),
    tank: armedUnit('tank'),
    flak: armedUnit('flak'),
    interceptor: shieldUnit('interceptor'),
    bomber: armedUnit('bomber'),
    solar: unarmedOrbitUnit('solar'),
    tug: unarmedOrbitUnit('tug'),
    lancer: shieldUnit('lancer'),
    skiff: shieldUnit('skiff'),
    bastion: shieldUnit('bastion'),
    warden: armedUnit('warden'),
    gunship: armedUnit('gunship'),
    gun_platform: t.opt(t.obj({ hp: t.opt(t.num(1, 100_000, `Hit points. Default ${STATS.gun_platform.hp}.`)), ...statWeapon('gun_platform') })),
    island_mortar: t.opt(t.obj({ ...statCost('island_mortar'), ...statWeapon('island_mortar') })),
    ore_extractor: t.opt(t.obj(statCost('ore_extractor'))),
    shaft: t.opt(t.obj(statCost('shaft'))),
    turret: t.opt(t.obj({ ...statCost('turret'), ...statWeapon('turret') })),
    relay: t.opt(t.obj(statCost('relay'))),
    aerie: t.opt(t.obj(statCost('aerie'))),
    storm_seeder: t.opt(t.obj(statCost('storm_seeder'))),
    stormcatcher: t.opt(t.obj(statCost('stormcatcher'))),
    headframe: t.opt(t.obj(statCost('headframe'))),
    bulkhead: t.opt(t.obj(statCost('bulkhead'))),
    geothermal: t.opt(t.obj(statCost('geothermal'))),
    breacher: armedUnit('breacher'),
    drill_yard: t.opt(t.obj(statCost('drill_yard'))),
    mooring_tower: t.opt(t.obj(statCost('mooring_tower'))),
    lava_bridge: t.opt(t.obj({ hp: t.opt(t.int(1, 100_000, `Hit points of a lava bridge (cost and time: rules.depths.lavaBridge*). Default ${STATS.lava_bridge.hp}.`)) })),
  },
  'Unit and structure stats per kind (the Spire: `spire`). Plane, targets, armor, weapon and body size are fixed.',
);

const segmentHp = (p: Plane) => t.opt(t.int(1, 100_000, `Default ${SPIRE_HP[p]} (lossRule crowns: ${CROWNS_SPIRE_HP[p]}).`));
const spireRules = t.obj(
  {
    lossRule: t.opt(t.enum(LOSS_RULES, `How an army is eliminated: surface = its Surface segment falls; crowns = a fallen Surface segment costs crownsSurface crowns, any other fallen segment crownsSide, and the army is out at crownsToLose (by default the Surface alone, or any two side segments); a rebuilt segment returns its crown. The time cap then ranks fewest crowns lost first. Default ${LOSS_RULES[0]}.`)),
    hp: t.opt(t.obj({ depths: segmentHp('depths'), surface: segmentHp('surface'), sky: segmentHp('sky'), orbit: segmentHp('orbit') }, 'Hit points per segment. Unset segments take the defaults of the match\'s lossRule (crowns: two side segments hold the Surface\'s HP).')),
    dmg: t.opt(t.num(0, 1000, `Segment beam damage per shot (0: segments do not shoot). Default ${STATS.spire.dmg}.`)),
    range: t.opt(t.num(1, 12, `Segment beam range in tiles. Default ${STATS.spire.range}.`)),
    cooldown: t.opt(t.num(0.05, 30, `Time between segment beam shots. Default ${sec(STATS.spire.cooldown)} s.`)),
    vision: t.opt(t.num(1, 16, `Segment vision radius in tiles. Default ${STATS.spire.vision}.`)),
    timeCap: t.opt(t.int(60, 7200, `Match length cap in seconds: at the cap the army with the most total Spire HP wins (lossRule crowns: fewest crowns lost first), then the most contested-point score (rules.surface.postScore); equal is a draw. Default ${TIME_CAP}.`)),
    ...scalarGroup(SCALAR_GROUPS.spire, '').fields,
  },
  "Each team's Spire (one segment per plane; the loss rule decides which falls eliminate an army), segment rebuilds, impacts on it, sudden death and the time cap.",
);

/** An army's income multiplier when the rules give it no handicap. */
export const NO_HANDICAP = 1;
/** Closed bounds of a per-army income multiplier: a handicap may at most halve or double what an army earns. */
export const HANDICAP_INCOME_MIN = 0.5;
export const HANDICAP_INCOME_MAX = 2;
const incomeMultiplier = (army: ArmyId) => t.opt(t.num(HANDICAP_INCOME_MIN, HANDICAP_INCOME_MAX,
  `Income multiplier of army ${army}: every alloy and energy credit it earns (mining, trickles, lodes, energy delivery, asteroids, caches, the core) is multiplied by it; starting stock, refunds and costs are not. Default ${NO_HANDICAP}.`));
const handicapRules = t.obj(
  {
    income: t.opt(t.obj({ nw: incomeMultiplier('nw'), ne: incomeMultiplier('ne'), se: incomeMultiplier('se'), sw: incomeMultiplier('sw') },
      'Income multiplier per army corner.')),
  },
  'Public per-army handicaps, the only rules that may differ between armies (handicapped benchmark opponents, uneven practice). Equal values keep the match an exact mirror.',
);

/**
 * Bounded, trusted owner input. Documents never appear in the public resolved rules schema. Bounds follow
 * MAX_MAP_SIZE: whole-map cell counts, and the canonical sector is at most half the map (C2; C4 stores a quarter).
 */
const mapLayerDimensions = {
  __cWid: t.int(1, MAX_MAP_SIZE), __cHei: t.int(1, MAX_MAP_SIZE / 2), __gridSize: t.int(1, 1),
};
const mapFeatureFieldSchema = t.union('__type', {
  Int: { __identifier: t.enum(['slot', 'loads', 'order', 'rotation', 'oreCapacity']), __value: t.int(0, 1000000) },
  Float: { __identifier: t.enum(['r', 'w', 'width', 'height', 'dx', 'dy', 'weight', 'spread']), __value: t.num(-MAX_MAP_SIZE, 100) },
  Bool: { __identifier: t.enum(['rich']), __value: t.bool() },
  String: { __identifier: t.enum(['path', 'kind']), __value: t.str(96) },
  'Array<Int>': { __identifier: t.enum(['cells']), __value: t.ints(MAX_MAP_SIZE * MAX_MAP_SIZE, 0, MAX_MAP_SIZE - 1) },
});
const mapDocumentSchema = t.obj({
  id: t.str(96, '^[a-z][a-z0-9_]*$'), label: t.str(128), identity: t.str(512),
  seed: t.int(0, 0xffffffff), size: t.int(MAP_SIZES[0], MAX_MAP_SIZE), sides: t.int(2, 4),
  spireInset: t.int(SPIRE_INSET_MIN, SPIRE_INSET_MAX), preset: t.enum(TERRAIN_PRESETS),
  version: t.int(1, 1), symmetry: t.enum(['C2', 'C4']),
  layouts: t.list(t.obj({
    id: t.str(64), teams: t.list(t.ints(4, 0, 3), 4),
    supported: t.bool(), fairness: t.enum(['rotational', 'adjacent', 'opposite', 'duel']),
  }), 8),
  levels: t.list(t.obj({
    identifier: t.enum(['Canonical']), worldX: t.int(0, 0), worldY: t.int(0, 0),
    pxWid: t.int(1, MAX_MAP_SIZE), pxHei: t.int(1, MAX_MAP_SIZE / 2),
    layerInstances: t.list(t.union('__type', {
      IntGrid: {
        ...mapLayerDimensions, __identifier: t.enum(['Surface', 'Depths', 'Ore', 'Owner', 'Magma', 'Cavern']),
        intGridRle: t.ints(MAX_MAP_SIZE * MAX_MAP_SIZE, 0, MAX_MAP_SIZE * MAX_MAP_SIZE / 2),
      },
      Entities: {
        ...mapLayerDimensions, __identifier: t.enum(['Features']),
        entityInstances: t.list(t.obj({
          __identifier: t.enum(['StartSlot', 'Fault', 'Lode', 'Island', 'OrbitRegion', 'MotherLode', 'Post', 'RichOre']), iid: t.str(96),
          __grid: t.ints(2, 0, MAX_MAP_SIZE - 1), px: t.list(t.num(0, MAX_MAP_SIZE), 2),
          fieldInstances: t.list(mapFeatureFieldSchema, 6),
        }), 512),
      },
    }), 7),
  }), 1),
  generation: t.obj({
    lodes: t.list(t.obj({
      zone: t.enum(['home', 'flanks', 'centre']),
      requested: t.int(0, MAX_MAP_SIZE * MAX_MAP_SIZE), placed: t.int(0, MAX_MAP_SIZE * MAX_MAP_SIZE), widened: t.int(0, MAX_MAP_SIZE * MAX_MAP_SIZE),
      prepared: t.int(0, MAX_MAP_SIZE * MAX_MAP_SIZE), cliffPrepared: t.int(0, MAX_MAP_SIZE * MAX_MAP_SIZE), fallback: t.int(0, MAX_MAP_SIZE * MAX_MAP_SIZE), missing: t.int(0, MAX_MAP_SIZE * MAX_MAP_SIZE),
    }), 8),
    terrainEdits: t.list(t.obj({ c: t.int(0, MAX_MAP_SIZE * MAX_MAP_SIZE - 1), before: t.int(0, 6), after: t.int(0, 6) }), MAX_MAP_SIZE * MAX_MAP_SIZE),
    stages: t.list(t.obj({ name: t.str(32), seed: t.int(0, 0xffffffff) }), 16),
  }),
});
const mapSelectionSchema = t.obj({
  seed: t.opt(t.int(0, 0xffffffff, 'Public map generation seed; defaults to the match seed.')),
  params: t.opt(mapRules),
  name: t.opt(t.str(96, '^[a-z][a-z0-9_]*$', 'Registered authored or saved map.')),
  document: t.opt(mapDocumentSchema),
}, 'Exactly one selector: {seed?, params?}, {name}, or {document}. Inline documents are limited to 128 KiB.', { merge: 'replace' });

/**
 * Match options = match rules: every field optional and bounded (validated by the PlayerThree host; see `checkRules`
 * for readable errors). Omitted fields use the host's defaults, then DEFAULT_RULES.
 */
export const matchOptionsSchema = t.obj(
  {
    terrain: t.opt(t.enum(TERRAIN_PRESETS, `Surface terrain preset. Default ${DEFAULT_TERRAIN}.`)),
    map: t.opt(mapSelectionSchema),
    economy: t.opt(scalarGroup(SCALAR_GROUPS.economy, 'Start resources and units, trickles, ore loads, energy delivery, upkeep, unit and structure caps, and structure site HP.')),
    depths: t.opt(scalarGroup(SCALAR_GROUPS.depths, 'Digging, fortifying, rails, mining orders, charges, breaches, chasms and magma.')),
    surface: t.opt(scalarGroup(SCALAR_GROUPS.surface, 'Terrain effects, siege range, the build radius and falls into the Depths.')),
    sky: t.opt(scalarGroup(SCALAR_GROUPS.sky, 'Islands, sky structures, weather, spotting and interception.')),
    orbit: t.opt(scalarGroup(SCALAR_GROUPS.orbit, 'The sun, asteroids, impacts, orbital scans and abilities.')),
    queue: t.opt(scalarGroup(SCALAR_GROUPS.queue, 'The team build queue: entry limits and the refund for cancelling a started entry.')),
    movement: t.opt(scalarGroup(SCALAR_GROUPS.movement, 'Default rally points per plane, destination slot spacing, acceleration, and plane transfers.')),
    combat: t.opt(scalarGroup(SCALAR_GROUPS.combat, 'Splash and direct hits, firing distances, fight-move contact, bomb release and returning to post.')),
    ascent: t.opt(scalarGroup(SCALAR_GROUPS.ascent, 'Interceptor ascent cost, duration and cooldown.')),
    research: t.opt(scalarGroup(SCALAR_GROUPS.research, 'Research costs, segment-loss refunds and the shared shield cap.')),
    signals: t.opt(scalarGroup(SCALAR_GROUPS.signals, 'Team signals: on/off, per-seat rate and open signals, and how long signals last.')),
    spire: t.opt(spireRules),
    stats: t.opt(statsRules),
    handicap: t.opt(handicapRules),
  },
  'Match rules: the same for every army except the public per-army handicaps. Durations are in seconds.',
);
type SchemaMatchOptions = Infer<typeof matchOptionsSchema>;
export type MapSelection = { seed?: number; params?: Infer<typeof mapRules>; name?: never; document?: never }
  | { name: string; seed?: never; params?: never; document?: never }
  | { document: MapDocument; name?: never; seed?: never; params?: never };
export type MatchOptions = Omit<SchemaMatchOptions, 'map'> & { map?: MapSelection };

/** A schema with every optional field made required, recursively: the shape of fully resolved options. */
interface FilledObj<F> {
  readonly t: 'obj';
  readonly fields: F;
  readonly doc?: string;
}
type Filled<S> = S extends OptS<infer I> ? Filled<I> : S extends ObjS<infer F> ? FilledObj<{ readonly [K in keyof F]: Filled<F[K]> }> : S;
function fill(s: Schema): Schema {
  if (s.t === 'opt') return fill(s.item as Schema);
  if (s.t !== 'obj') return s;
  const fields: Record<string, Schema> = {};
  for (const [k, f] of Object.entries(s.fields as Record<string, Schema>)) fields[k] = fill(f);
  return t.obj(fields, s.doc);
}
/** A match's full rules (every field present): `rules` in observations and snapshot views. */
const { map: _inputMap, ...publicRuleFields } = matchOptionsSchema.fields;
const unresolvedRulesSchema = t.obj({ ...publicRuleFields, map: t.opt(mapRules) });
// Schema-to-type mapping of `fill` is beyond what TS can check generically (instantiation depth); the shape is `Filled`.
export const rulesSchema = fill(unresolvedRulesSchema) as unknown as Filled<typeof unresolvedRulesSchema>;
export type Rules = Infer<typeof rulesSchema>;
/** Map generation rules (match rules `map`). */
export type MapRules = Rules['map'];

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** The numeric fields of a stats row: the ones `rules.stats` and `rules.spire` may override. */
type StatNumber = { [K in keyof Stats]-?: Stats[K] extends number | undefined ? K : never }[keyof Stats];

function defaultRules(): Rules {
  const groups: Record<string, Record<string, number | boolean>> = {};
  for (const [group, spec] of Object.entries(SCALAR_GROUPS)) {
    const values: Record<string, number | boolean> = {};
    for (const [key, [econ, unit]] of Object.entries(spec as ScalarSpec)) values[key] = unit === 'sec' ? sec(ECON[econ] as number) : ECON[econ];
    groups[group] = values;
  }
  const stats: Record<string, Record<string, number>> = {};
  for (const [kind, rule] of Object.entries(statsRules.fields)) {
    const row: Record<string, number> = {};
    const base = STATS[kind as StatKind];
    for (const f of Object.keys((rule as OptS<ObjS>).item.fields) as StatNumber[]) row[f] = isStatSeconds(f) ? sec(base[f]!) : base[f]!;
    stats[kind] = row;
  }
  const spire = { lossRule: LOSS_RULES[0], ...groups.spire, hp: { ...SPIRE_HP }, dmg: STATS.spire.dmg, range: STATS.spire.range, cooldown: sec(STATS.spire.cooldown), vision: STATS.spire.vision, timeCap: TIME_CAP };
  // Built from the dynamic group tables above; DEFAULT_RULES is validated against rulesSchema by the rules tests.
  const handicap = { income: { nw: NO_HANDICAP, ne: NO_HANDICAP, se: NO_HANDICAP, sw: NO_HANDICAP } };
  return { terrain: DEFAULT_TERRAIN, map: { ...MAP_DEFAULTS }, ...groups, spire, stats, handicap } as unknown as Rules;
}
/** The default rules: today's constants (ECON, STATS, SPIRE_HP, map generation), durations in seconds. Frozen. */
export const DEFAULT_RULES: Rules = deepFreeze(defaultRules());
/** The defaults a match with lossRule `crowns` resolves over: its segment HP defaults are CROWNS_SPIRE_HP. */
const CROWNS_DEFAULT_RULES: Rules = deepFreeze({ ...DEFAULT_RULES, spire: { ...DEFAULT_RULES.spire, lossRule: 'crowns', hp: { ...CROWNS_SPIRE_HP } } });
/** The time cap under the default rules, in ticks (tools that always play the defaults; a match: `sim.timeCap`). */
export const DEFAULT_TIME_CAP_TICKS = toTicks(TIME_CAP);

function overlay(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (Array.isArray(over)) return over;
  if (typeof base !== 'object' || base === null || typeof over !== 'object' || over === null) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = overlay((base as Record<string, unknown>)[k], v);
  return out;
}
/**
 * A match's full rules: its (validated) options over DEFAULT_RULES, objects merged field by field. Frozen. Under
 * lossRule `crowns` unset segment HP takes CROWNS_SPIRE_HP.
 */
export function resolveRules(options: MatchOptions = {}): Rules {
  const { map, ...publicOptions } = options;
  const descriptor = map?.name ? mapDescriptor(map.name) : undefined;
  const params = map?.document
    ? { size: map.document.size, spireInset: map.document.spireInset }
    : descriptor ? { size: descriptor.size, spireInset: descriptor.spireInset } : map?.params;
  const terrain = map?.document?.preset ?? descriptor?.terrain ?? publicOptions.terrain;
  const base = publicOptions.spire?.lossRule === 'crowns' ? CROWNS_DEFAULT_RULES : DEFAULT_RULES;
  return deepFreeze(overlay(base, { ...publicOptions, ...(terrain === undefined ? {} : { terrain }), ...(params ? { map: params } : {}) }) as Rules);
}
/** Encode resolved numeric rules as generated-map input; source selectors and event seeds are separate inputs. */
export function rulesOptions(rules: Rules): MatchOptions {
  return { ...rules, map: { params: rules.map } };
}

/** Stable short identity for resolved rules, independent of object insertion order. Computed once per match. */
export function hashRules(rules: Rules): number {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  return fnv1a(canonical(rules));
}

/** Lobby groups are presentation only: their fields retain the canonical rules paths. */
export const RULE_GROUPS = [
  { id: 'orbit', label: 'Orbit' }, { id: 'sky', label: 'Sky' },
  { id: 'surface', label: 'Surface' }, { id: 'depths', label: 'Depths' },
  { id: 'economy', label: 'Economy' }, { id: 'map', label: 'Map' },
  { id: 'match', label: 'Match' },
] as const;
export type RuleGroup = (typeof RULE_GROUPS)[number]['id'];
export type RuleValue = number | boolean | string | readonly RuleValue[] | { readonly [key: string]: RuleValue };
export interface RuleField {
  readonly path: readonly string[];
  readonly group: RuleGroup;
  readonly section: string;
  readonly label: string;
  readonly description: string;
  readonly unit: string;
  readonly kind: 'int' | 'num' | 'bool' | 'enum' | 'list';
  readonly defaultValue: RuleValue;
  readonly min?: number;
  readonly max?: number;
  readonly choices?: readonly string[];
  /** Object fields, or the fields of one list item. No second hand-maintained form schema. */
  readonly children?: readonly RuleField[];
}

function ruleLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase()
    .replace(/\bhp\b/g, 'HP').replace(/\bdps\b/g, 'DPS').replace(/\bpd\b/g, 'point defence')
    .replace(/\bdmg\b/g, 'damage').replace(/\bmax\b/g, 'maximum').replace(/\bmin\b/g, 'minimum');
  return (words[0]?.toUpperCase() ?? '') + words.slice(1);
}

function ruleGroup(path: readonly string[]): RuleGroup {
  const [area, key, plane] = path;
  if (area === 'terrain' || area === 'map') return 'map';
  if (area === 'handicap') return 'economy';
  if (area === 'stats') return STATS[key as StatKind].plane;
  if (area === 'spire' && key === 'hp') return plane as Plane;
  if (area === 'research') return key?.startsWith('ascentThrusters') ? 'sky'
    : key?.startsWith('aegisProjectors') || key?.startsWith('nightCloak') || key?.startsWith('lancerLens') ? 'orbit'
    : key?.startsWith('drillBits') || key?.startsWith('shapedCharges') ? 'depths' : 'match';
  if (area === 'ascent') return 'sky';
  if (area === 'queue' || area === 'combat' || area === 'spire' || area === 'signals') return 'match';
  // Per-plane default rallies (`<plane>Rally`) sit with their plane; slot spacing applies to every plane.
  if (area === 'movement') return key?.endsWith('Rally') ? key.slice(0, -'Rally'.length) as Plane : 'match';
  return area as RuleGroup;
}

function ruleUnit(path: readonly string[], description: string): string {
  const [area, key] = path;
  const field = path.at(-1)!;
  const spec = SCALAR_GROUPS[area as keyof typeof SCALAR_GROUPS] as ScalarSpec | undefined;
  if (spec?.[key!]?.[1] === 'sec' || (area === 'stats' && isStatSeconds(field))
    || (area === 'spire' && (field === 'cooldown' || field === 'timeCap')) || (area === 'map' && field === 'period')) return 's';
  if (/tiles\/s²/.test(description)) return 'tiles/s²';
  if (/radians\/s/.test(description)) return 'rad/s';
  if (/tiles per second/.test(description)) return 'tiles/s';
  if (/alloy per second/i.test(description)) return 'alloy/s';
  if (/energy per second/i.test(description)) return 'energy/s';
  if (/HP (?:repaired|restored) per second/.test(description)) return 'HP/s';
  if (/damage per second/i.test(description)) return 'damage/s';
  if (/multipl(?:ier|y|ies)|multiple of/i.test(description)) return '×';
  if (/fraction|share|chance|probability|damage reduction/i.test(description)) return 'fraction';
  if ((area === 'spire' && key === 'hp') || /hit points|hull HP|shield capacity|\bHP\b/i.test(description)) return 'HP';
  if (field === 'alloy' || /Alloy$/.test(field)) return 'alloy';
  if (field === 'energy' || /Energy$/.test(field)) return 'energy';
  if (/alloy/i.test(description) && /cost|per .*load|for docking|alloy to/i.test(description)) return 'alloy';
  if (/energy/i.test(description) && /cost|per .*activation|per .*ascent|per .*scan|per .*lance/i.test(description)) return 'energy';
  if (/damage/i.test(description)) return 'damage';
  if (/ore loads/i.test(description)) return 'loads';
  if (/tiles|radius|distance|spacing|range|inset/i.test(description)) return 'tiles';
  return '';
}

function ruleFields(schema: Schema, defaults: unknown, path: readonly string[] = []): RuleField[] {
  if (schema.t === 'opt') return ruleFields(schema.item as Schema, defaults, path);
  if (schema.t === 'obj') return Object.entries(schema.fields as Record<string, Schema>)
    .flatMap(([key, child]) => ruleFields(child, (defaults as Record<string, unknown>)[key], [...path, key]));
  if (schema.t !== 'int' && schema.t !== 'num' && schema.t !== 'bool' && schema.t !== 'enum' && schema.t !== 'list') {
    throw new Error(`Unsupported rules editor schema at ${path.join('.')}: ${schema.t}`);
  }
  const description = schema.doc ?? '';
  const field: RuleField = {
    // Nested map objects (template, presets, generator stages) get their own heading, like a stats row.
    path, group: ruleGroup(path), section: path[0] === 'stats' || (path[0] === 'map' && path.length > 2 && path[2] !== '*') ? ruleLabel(path[1]!) : ruleLabel(path[0]!),
    label: path[0] === 'spire' && path[1] === 'hp' ? 'Spire segment HP' : path[0] === 'handicap' ? `${path.at(-1)!.toUpperCase()} income` : ruleLabel(path.at(-1)!),
    description, unit: ruleUnit(path, description), kind: schema.t, defaultValue: defaults as RuleValue,
    ...(schema.t === 'int' || schema.t === 'num' ? { min: schema.min, max: schema.max } : {}),
    ...(schema.t === 'enum' ? { choices: schema.values } : {}),
    ...(schema.t === 'list' ? {
      max: schema.max,
      children: ruleFields(schema.item as Schema, (defaults as unknown[])[0] ?? {}, [...path, '*']),
    } : {}),
  };
  return [field];
}

/** Complete bounded editor descriptors, generated from the resolved schema and actual default rules. */
export const RULE_FIELDS: readonly RuleField[] = deepFreeze(ruleFields(rulesSchema as Schema, DEFAULT_RULES));
export interface RuleDiff {
  readonly field: RuleField;
  readonly standard: RuleValue;
  readonly value: RuleValue;
}
/** Read one canonical path; list item descriptors use `*` and are rendered under their parent. */
export function ruleValue(rules: Rules, path: readonly string[]): RuleValue {
  let value: unknown = rules;
  for (const key of path) value = (value as Record<string, unknown>)[key];
  return value as RuleValue;
}
function equalRuleValue(a: RuleValue, b: RuleValue): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) =>
    Object.hasOwn(b, key) && equalRuleValue((a as Record<string, RuleValue>)[key]!, (b as Record<string, RuleValue>)[key]!));
}
/** Every departure from Standard, including map lists and curated presets, is custom/unranked. */
export function diffRules(rules: Rules): readonly RuleDiff[] {
  return RULE_FIELDS.flatMap((field) => {
    const value = ruleValue(rules, field.path);
    return equalRuleValue(value, field.defaultValue) ? [] : [{ field, standard: field.defaultValue, value }];
  });
}
export function isCustomRules(rules: Rules): boolean {
  return diffRules(rules).length > 0;
}
export interface RulesPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly rules: Rules;
}
/** Curated ordinary rules objects; presets never introduce a separate simulation mode. */
export const RULE_PRESETS: readonly RulesPreset[] = deepFreeze([
  { id: 'standard', label: 'Standard', description: 'Guarded default balance. Only this ruleset is covered by default balance claims.', rules: DEFAULT_RULES },
  { id: 'fast', label: 'Fast', description: 'Higher income, quicker research and shorter digging, capture and ability timers; 15-minute cap.',
    rules: resolveRules({
      economy: { spireAlloyRate: 4, baseEnergyCap: 4, relayEnergyCap: 8, solarRate: 4, headframeRate: 1 },
      depths: { digRockTime: 1, digOreTime: 1.5, fortifyTime: 2, railTime: 1, breachTime: 2 },
      sky: { captureTime: 2.5, captureStructureTime: 6, aerieLaunchTime: 1, aerieDropCooldown: 15 },
      orbit: { scanCooldown: 10, lanceCooldown: 12.5, aegisCooldown: 15 },
      research: { ascentThrustersTime: 15, aegisProjectorsTime: 12.5, nightCloakTime: 15, lancerLensTime: 12.5 },
      spire: { timeCap: 900 },
    }) },
  { id: 'rich-economy', label: 'Rich economy', description: 'More starting resources and double primary alloy and energy income.',
    rules: resolveRules({ economy: { startAlloy: 1200, startEnergy: 450, spireAlloyRate: 4, oreLoad: 20, baseEnergyCap: 4, relayEnergyCap: 8, solarRate: 4, headframeRate: 1 } }) },
  { id: 'no-asteroids', label: 'No asteroids', description: 'No drifting asteroid pairs spawn; orbital ships and the day/night cycle remain.',
    rules: resolveRules({ orbit: { maxAsteroids: 0 } }) },
  { id: 'calm-skies', label: 'Calm skies', description: 'No natural or Storm Seeder storms. Fog banks and jet winds remain.',
    rules: resolveRules({ sky: { stormSets: 0, seederDuration: 0 } }) },
  { id: 'long-game', label: 'Long game', description: 'Standard gameplay with a 60-minute match cap.',
    rules: resolveRules({ spire: { timeCap: 3600 } }) },
  { id: 'crowns', label: 'Crowns', description: `Lose the Surface segment, or any two of Depths, Sky and Orbit, and you are out; side segments hold ${CROWNS_SPIRE_HP.sky} HP.`,
    rules: resolveRules({ spire: { lossRule: 'crowns' } }) },
]);
export function resolveRulesPreset(id: string): Rules {
  const preset = RULE_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown rules preset: ${id}`);
  return preset.rules;
}


/**
 * Validate untrusted match rules (a host's rules file, a create-match request) with a readable error naming the
 * field and its bounds, e.g. `rules.depths.digRockTime: must be a number from 0.05 to 120`. Never echoes the input.
 */
export function checkRules(raw: unknown): { ok: true; options: MatchOptions } | { ok: false; error: string } {
  const r = validate(matchOptionsSchema, raw);
  if (r.ok) {
    const queue = { ...DEFAULT_RULES.queue, ...r.value.queue };
    if (queue.laneSlots > queue.seatMax || queue.laneSlots * PLANES.length > queue.teamMax) {
      return { ok: false, error: 'rules.queue.laneSlots: reserved slots must fit each seatMax and all planes within teamMax' };
    }
    const selection = r.value.map;
    if (selection) {
      const named = selection.name !== undefined, inline = selection.document !== undefined;
      if (named && inline || (named || inline) && (selection.seed !== undefined || selection.params !== undefined)) {
        return { ok: false, error: 'rules.map: choose {seed, params}, {name}, or {document}, not a mixture' };
      }
      if (named) {
        const descriptor = mapDescriptor(selection.name!);
        if (!descriptor || descriptor.tags.includes('generated')) return { ok: false, error: 'rules.map.name: unknown registered authored map' };
      }
      if (inline) {
        if (new TextEncoder().encode(JSON.stringify(selection.document)).byteLength > INLINE_MAP_DOCUMENT_BYTES) {
          return { ok: false, error: 'rules.map.document: inline document exceeds 128 KiB; save it on the host and select it by name' };
        }
        const document = validateMapDocument(selection.document);
        if (!document.valid) return { ok: false, error: 'rules.map.document: invalid map document' };
      }
    }
    const map = selection?.params;
    if (map?.slots !== undefined && map.slots !== 2 && map.slots !== 4) return { ok: false, error: 'rules.map.params.slots: must be 2 or 4' };
    if (map?.size !== undefined && !(MAP_SIZES as readonly number[]).includes(map.size)) return { ok: false, error: 'rules.map.params.size: must be 48, 64, or 80' };
    if (map && (map.homeLodeMinRadius ?? DEFAULT_RULES.map.homeLodeMinRadius) > (map.homeLodeMaxRadius ?? DEFAULT_RULES.map.homeLodeMaxRadius)) {
      return { ok: false, error: 'rules.map.params.homeLodeMaxRadius: must be ≥ homeLodeMinRadius' };
    }
    if (map && (map.postDistanceMin ?? DEFAULT_RULES.map.postDistanceMin) > (map.postDistanceMax ?? DEFAULT_RULES.map.postDistanceMax)) {
      return { ok: false, error: 'rules.map.params.postDistanceMax: must be ≥ postDistanceMin' };
    }
    const rings = map?.islandRingLayout;
    if (rings?.length === 0) return { ok: false, error: 'rules.map.params.islandRingLayout: must list at least one ring' };
    for (const [i, ring] of (rings ?? []).entries()) {
      if (i > 0 && ring.radius <= rings![i - 1]!.radius) return { ok: false, error: `rules.map.params.islandRingLayout.${i}.radius: must be > the previous ring's radius` };
    }
    for (const [i, zone] of (map?.contestedZones ?? []).entries()) {
      if (zone.minRadius > zone.maxRadius) return { ok: false, error: `rules.map.params.contestedZones.${i}.maxRadius: must be ≥ minRadius` };
    }
    if (map?.contestedPosts && new Set(map.contestedPosts).size !== map.contestedPosts.length) {
      return { ok: false, error: 'rules.map.params.contestedPosts: each kind at most once' };
    }
    // A tug must be able to release from outside the enemy Orbit segment's beam (the asteroid rides on the tug). The
    // beam reaches from the footprint edge, farthest on the diagonals: the stand-off must exist from every bearing.
    const deorbitRange = r.value.orbit?.deorbitRange ?? DEFAULT_RULES.orbit.deorbitRange;
    const beamToTug = (r.value.spire?.range ?? DEFAULT_RULES.spire.range) + SPIRE_CORNER + STATS.tug.radius;
    if (deorbitRange <= beamToTug) {
      return { ok: false, error: `rules.orbit.deorbitRange: must be > rules.spire.range + Spire half-diagonal ${SPIRE_CORNER.toFixed(2)} + tug radius ${STATS.tug.radius} (${beamToTug.toFixed(2)}), so tugs can release outside the Orbit segment beam` };
    }
    const surface = r.value.surface;
    const siegeMin = surface?.siegeMinRange ?? DEFAULT_RULES.surface.siegeMinRange;
    if (siegeMin >= Math.min(surface?.siegeRangeUnits ?? DEFAULT_RULES.surface.siegeRangeUnits, surface?.siegeRangeStructures ?? DEFAULT_RULES.surface.siegeRangeStructures, surface?.siegeSpireRange ?? DEFAULT_RULES.surface.siegeSpireRange)) {
      return { ok: false, error: 'rules.surface.siegeMinRange: must be < siegeRangeUnits, siegeRangeStructures and siegeSpireRange' };
    }
    // Derelict ruin: chamber < ring < corridor < hull; breaches and gates invariant under every quarter turn, each gate
    // aligned with a breach when open; gates narrower than one eighth of the ring per 4 gates.
    const o = { ...DEFAULT_RULES.orbit, ...r.value.orbit };
    if (o.metalChance + o.iceChance > 1) return { ok: false, error: 'rules.orbit.iceChance: metalChance + iceChance must be ≤ 1' };
    if (o.derelictRingInner >= o.derelictRingOuter) return { ok: false, error: 'rules.orbit.derelictRingOuter: must be > derelictRingInner' };
    if (o.derelictRingOuter >= o.derelictHullInner) return { ok: false, error: 'rules.orbit.derelictHullInner: must be > derelictRingOuter' };
    if (o.derelictHullInner >= o.derelictHullOuter) return { ok: false, error: 'rules.orbit.derelictHullOuter: must be > derelictHullInner' };
    if (o.derelictGates % 4 !== 0 || o.derelictBreaches % o.derelictGates !== 0) return { ok: false, error: 'rules.orbit.derelictBreaches: gates must be a multiple of 4 and breaches a multiple of gates' };
    if (o.derelictGateWidth >= (2 * Math.PI * (o.derelictRingInner + o.derelictRingOuter) / 2) / (2 * o.derelictGates)) {
      return { ok: false, error: 'rules.orbit.derelictGateWidth: must be < the ring circumference / (2 × gates)' };
    }
    if (o.derelictEnabled) {
      // The ruin shrinks to fit inside every Spire's Orbit reach for this map's size and spireInset (derelictScale), so
      // it can never overlap a beam or the deorbit stand-off; it must still pass the widest Orbit ship through every
      // breach and gate.
      const rules = resolveRules(r.value as MatchOptions);
      const tables = compileRules(rules);
      const { size, spireInset } = rules.map;
      const g = derelictGeometry(tables.econ, tables.stats, tables.spires, size);
      const pass = passWidth(widestOrbitShip(tables.stats));
      const narrow = g.breachWidth < g.gateWidth ? 'derelictBreachWidth' : 'derelictGateWidth';
      if (Math.min(g.breachWidth, g.gateWidth) < pass) {
        return { ok: false, error: `rules.orbit.${narrow}: with the Spires at spireInset ${spireInset} on S${size} the ruin shrinks to ${(g.hullOuter / o.derelictHullOuter).toFixed(3)} tiles per S48 tile, and its ${narrow === 'derelictGateWidth' ? 'gates' : 'breaches'} (${Math.min(g.breachWidth, g.gateWidth).toFixed(2)}) no longer pass the widest Orbit ship (${pass.toFixed(2)}): lower spireInset, shrink derelictHullOuter or derelictLane, widen the apertures or switch derelictEnabled off` };
      }
    }
    return { ok: true, options: r.value as MatchOptions };
  }
  let s: Schema = matchOptionsSchema;
  const at: string[] = [];
  for (const p of r.path) {
    while (s.t === 'opt') s = s.item as Schema;
    const next: Schema | undefined =
      s.t === 'obj' && typeof p === 'string' && p !== '?' ? (s.fields as Record<string, Schema | undefined>)[p]
      : s.t === 'list' ? s.item as Schema : undefined;
    if (!next) break;
    s = next;
    at.push(String(p));
  }
  while (s.t === 'opt') s = s.item as Schema;
  const what =
    s.t === 'int' ? `an integer from ${s.min} to ${s.max}`
    : s.t === 'num' ? `a number from ${s.min} to ${s.max}`
    : s.t === 'enum' ? `one of ${s.values.join(', ')}`
    : s.t === 'bool' ? 'true or false'
    : s.t === 'list' ? `a list of at most ${s.max} items`
    : s.t === 'str' ? `a string of at most ${s.maxLength} characters`
    : s.t === 'ints' ? `a list of at most ${s.maxItems} integers from ${s.min} to ${s.max}`
    : 'an object';
  const where = ['rules', ...at].join('.');
  if (r.code === 'unknown_field' && s.t === 'obj') return { ok: false, error: `${where}: unknown field (allowed: ${Object.keys(s.fields).join(', ')})` };
  return { ok: false, error: `${where}: must be ${what}` };
}
