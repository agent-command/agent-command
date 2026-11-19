// Agent Command's built-in bot library: packages/game/src/rules/stats.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * Unit and structure stats: weapons and armor, plane transits, the default STATS table, footprints and the
 * Surface build radius, plane targeting, unit order limits and default Spire segment HP.
 */
import { norm } from '../util/math.js';
import { SURFACE } from './terrain.js';
import { BUILDABLE, isNeutralKind, toTicks, } from './vocabulary.js';

/** Weapon per shooter kind; drives projectile behaviour and the `shot` fx look. */
export const WEAPONS = ['rifle', 'cannon', 'flak', 'missile', 'bomb', 'beam', 'turret', 'pick', 'point_defence', 'shotgun', 'flamer'];
/**
 * Armor classes for the damage table (counters). Falling asteroids count as `air`; `heavy_air` is the gunship (and
 * its Gun Platform): flak and missiles ×1.25 against it (×1.5 against `air`), so its 320 HP stay tougher per cost than
 * an interceptor's under flak while flak and missiles still answer it; `island` is every island structure (it rides
 * out ground fire from turrets and flak passing below).
 */
export const ARMORS = ['light', 'armored', 'air', 'structure', 'small', 'heavy_air', 'island'];
/** Aircraft armors: storms slow and damage these. */
export const isAirArmor = (a) => a === 'air' || a === 'heavy_air';
/** Damage multiplier by weapon vs armor: rifle shreds light, cannon cracks armor and buildings, flak/missiles kill air. */
export const DAMAGE_VS = {
  rifle: { light: 1.25, armored: 0.6, air: 1, structure: 0.5, small: 1, heavy_air: 1, island: 0.5 },
  cannon: { light: 0.75, armored: 1.5, air: 1, structure: 1.25, small: 0.5, heavy_air: 1, island: 1.25 },
  flak: { light: 1, armored: 1, air: 1.5, structure: 0.5, small: 1.5, heavy_air: 1.25, island: 0.35 },
  missile: { light: 1, armored: 1, air: 1.5, structure: 0.75, small: 1, heavy_air: 1.25, island: 0.75 },
  bomb: { light: 1, armored: 1.25, air: 1, structure: 1.5, small: 0.5, heavy_air: 1, island: 1.5 },
  beam: { light: 1, armored: 1, air: 1, structure: 1, small: 0.3, heavy_air: 1, island: 1 },
  turret: { light: 1, armored: 1, air: 1, structure: 0.5, small: 1, heavy_air: 1, island: 0.25 },
  pick: { light: 1, armored: 0.5, air: 1, structure: 0.5, small: 1, heavy_air: 1, island: 0.5 },
  point_defence: { light: 1, armored: 0.18, air: 2, structure: 0.15, small: 2, heavy_air: 1, island: 0.15 },
  /** Warden corridor shotgun: shreds diggers, sappers and troopers; gates are the sapper's job. */
  shotgun: { light: 1.25, armored: 0.75, air: 1, structure: 0.5, small: 1, heavy_air: 1, island: 0.5 },
  /**
   * Breacher flamer (hitscan, forward cone splash): burns infantry out of foxholes and cooks turret lines; tanks shrug
   * it off. Against a fully dug-in Trooper the multiplier is rules.surface.breacherDugInMultiplier instead of `light`.
   * It never reaches the Sky, so its air columns are unused.
   */
  flamer: { light: 1.5, armored: 0.5, air: 1, structure: 1.25, small: 1, heavy_air: 1, island: 1 },
};

export const TRANSITS = {
  ascend: {
    from: 'sky', to: 'orbit', ability: 'ascend',
    cost: { alloy: 0, energy: 'ascentEnergy' }, prep: 0, travel: 'ascentClimb',
    stay: 'ascentDuration', cooldown: 'ascentCooldown', telegraph: 'contrail',
    reach: ['orbit'], return: 'sky', arrival: 'column',
  },
  descend: {
    from: 'surface', to: 'depths', kinds: ['trooper', 'breacher'],
    cost: { alloy: 0, energy: 0 }, prep: 0, travel: 0, stay: 0, cooldown: 0,
    telegraph: 'portal', arrival: 'portal',
  },
  emerge: {
    from: 'depths', to: 'surface', kinds: ['trooper', 'breacher'],
    cost: { alloy: 0, energy: 0 }, prep: 0, travel: 0, stay: 0, cooldown: 0,
    telegraph: 'portal', arrival: 'portal',
  },
  airdrop: {
    from: 'sky', to: 'surface', kinds: ['trooper'],
    cost: { alloy: 0, energy: 0 }, prep: 0, travel: 'aerieDropTravel', stay: 0, cooldown: 0,
    telegraph: 'contrail', arrival: 'column', stationary: true,
  },
};
export function transitValue(value, econ) {
  return typeof value === 'number' ? value : econ[value];
}
const capabilities = (flags = {}) => ({ spotterDown: false, capture: false, tow: false, carry: false, dig: false, build: false, fortify: false, lens: false, ...flags });



/** Default unit/structure stats (durations in ticks). A match runs on its rules' stats: `compileRules(rules).stats`. */
// prettier-ignore
export const STATS = {
  digger: { plane: 'depths', hp: 80, speed: 2, dmg: 4, range: 1, cooldown: toTicks(1), targets: ['depths'], alloy: 50, energy: 0, build: toTicks(5), vision: 4, radius: 0.3, armor: 'light', weapon: 'pick', mount: { kind: 'fixed' }, projectileSpeed: 0, splash: 0, capabilities: capabilities({ carry: true, dig: true, build: true, fortify: true }), abilities: [] },
  sapper: { plane: 'depths', hp: 60, speed: 2.5, dmg: 0, range: 0, cooldown: toTicks(0), targets: [], alloy: 60, energy: 40, build: toTicks(6), vision: 4, radius: 0.3, armor: 'light', mount: { kind: 'fixed' }, projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [] },
  trooper: { plane: 'surface', hp: 100, speed: 2.5, dmg: 8, range: 4, cooldown: toTicks(1), targets: ['surface', 'depths'], alloy: 40, energy: 0, build: toTicks(4), vision: 6, radius: 0.35, armor: 'light', weapon: 'rifle', mount: { kind: 'fixed' }, projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], deploy: 'dug_in' },
  // Tank: 90 alloy + 30 energy = 135 cost-equivalent (alloy + 1.5 × energy): 11.1 DPS per 100 (the Trooper: 20), but
  // at equal cost 3.4 Troopers now lose two of their number killing one (at 60 energy, 4.5 lost one). Its fight stats
  // are untouched, so the turret duel (about 20 s each way, decided by range) and the Breacher's ×0.5 stay as they were.
  tank: { plane: 'surface', hp: 300, speed: 1.6, dmg: 30, range: 6, cooldown: toTicks(2), targets: ['surface'], alloy: 90, energy: 30, build: toTicks(9), vision: 9, radius: 0.6, armor: 'armored', weapon: 'cannon', mount: { kind: 'turret', traverse: Math.PI }, projectileSpeed: 12, splash: 0.8, capabilities: capabilities(), abilities: [], deploy: 'siege' },
  flak: { plane: 'surface', hp: 150, speed: 2, dmg: 14, range: 7, cooldown: toTicks(0.8), targets: ['sky'], alloy: 70, energy: 40, build: toTicks(6), vision: 7, radius: 0.5, armor: 'armored', weapon: 'flak', mount: { kind: 'turret', traverse: Math.PI * 2 }, projectileSpeed: 16, splash: 1.2, capabilities: capabilities(), abilities: [], deploy: 'emplaced' },
  interceptor: { plane: 'sky', hp: 120, shield: 25, shieldRegen: 5, shieldDelay: toTicks(5), orbitAcceleration: 12, orbitTurnRate: 4.5, speed: 5, dmg: 12, range: 5, cooldown: toTicks(0.6), targets: ['sky'], alloy: 55, energy: 55, build: toTicks(6), vision: 8, radius: 0.4, armor: 'air', weapon: 'missile', mount: { kind: 'forward', arc: 60 }, projectileSpeed: 10, splash: 0, capabilities: capabilities({ capture: true }), abilities: [] },
  bomber: { plane: 'sky', hp: 200, speed: 3, dmg: 60, range: 1.5, cooldown: toTicks(3), targets: ['surface'], alloy: 100, energy: 100, build: toTicks(10), vision: 6, radius: 0.6, armor: 'air', weapon: 'bomb', mount: { kind: 'forward', arc: 60 }, projectileSpeed: 4, splash: 1.5, capabilities: capabilities({ capture: true, spotterDown: true }), abilities: [] },
  // The Sky's in-plane brawler: interceptors out-range it; it shreds interceptors that close; heavy_air takes flak and
  // missiles at ×1.25 (×1.5 vs air), so it outlasts an interceptor per cost under flak but flak still answers it.
  gunship: { plane: 'sky', hp: 320, speed: 2.5, dmg: 9, range: 3, cooldown: toTicks(0.45), targets: ['sky'], alloy: 120, energy: 60, build: toTicks(12), vision: 7, radius: 0.6, armor: 'heavy_air', weapon: 'rifle', mount: { kind: 'turret', traverse: Math.PI * 2 }, projectileSpeed: 0, splash: 0, capabilities: capabilities({ capture: true }), abilities: [] },
  solar: { plane: 'orbit', hp: 100, speed: 1, orbitAcceleration: 2, orbitTurnRate: 1.2, dmg: 0, range: 0, cooldown: toTicks(0), targets: [], alloy: 60, energy: 0, build: toTicks(5), vision: 6, radius: 0.6, armor: 'light', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], deploy: 'unfurled' },
  tug: { plane: 'orbit', hp: 150, speed: 2, orbitAcceleration: 3, orbitTurnRate: 1.6, dmg: 0, range: 0, cooldown: toTicks(0), targets: [], alloy: 100, energy: 20, build: toTicks(7), vision: 8, radius: 0.5, armor: 'light', projectileSpeed: 0, splash: 0, capabilities: capabilities({ tow: true }), abilities: [] },
  lancer: { plane: 'orbit', hp: 240, shield: 80, shieldRegen: 8, shieldDelay: toTicks(5), orbitAcceleration: 3, orbitTurnRate: 1.2, speed: 2.5, dmg: 28, range: 6, cooldown: toTicks(1.2), targets: ['orbit'], alloy: 120, energy: 115, build: toTicks(12), vision: 8, radius: 0.5, armor: 'armored', weapon: 'beam', mount: { kind: 'fixed' }, projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: ['sun_lance'] },
  skiff: { plane: 'orbit', hp: 65, shield: 20, shieldRegen: 4, shieldDelay: toTicks(5), orbitAcceleration: 14, orbitTurnRate: 5, speed: 5.5, dmg: 8, range: 1.8, cooldown: toTicks(0.5), targets: ['orbit'], alloy: 40, energy: 25, build: toTicks(4), vision: 8, radius: 0.28, armor: 'small', weapon: 'rifle', mount: { kind: 'forward', arc: 60 }, projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [] },
  bastion: { plane: 'orbit', hp: 240, shield: 140, shieldRegen: 10, shieldDelay: toTicks(5), orbitAcceleration: 1.8, orbitTurnRate: 0.7, speed: 2, dmg: 6, range: 3.2, cooldown: toTicks(0.15), targets: ['orbit', 'sky'], alloy: 140, energy: 80, build: toTicks(12), vision: 8, radius: 0.6, armor: 'armored', weapon: 'point_defence', mount: { kind: 'turret', traverse: Math.PI * 6 }, projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [] },
  // Depths fighter: light on purpose (its toughness is the shield wall, not its armour); no TRANSITS entry, so it never leaves the Depths.
  warden: { plane: 'depths', hp: 160, speed: 2, dmg: 12, range: 2, cooldown: toTicks(0.8), targets: ['depths'], alloy: 60, energy: 20, build: toTicks(6), vision: 4, radius: 0.35, armor: 'light', weapon: 'shotgun', mount: { kind: 'fixed' }, projectileSpeed: 24, splash: 0.6, capabilities: capabilities({ fortify: true }), abilities: ['flare'], deploy: 'walled' },
  // Converted, never produced: alloy/energy/build are the conversion's (a Trooper in an own Drill Yard). Splash: how far
  // past the target the flame reaches, inside the rules.surface.breacherConeArc cone. Portals like a Trooper (TRANSITS).
  breacher: { plane: 'surface', hp: 120, speed: 2.5, dmg: 22, range: 1.8, cooldown: toTicks(1), targets: ['surface', 'depths'], alloy: 40, energy: 20, build: toTicks(6), vision: 5, radius: 0.35, armor: 'light', weapon: 'flamer', mount: { kind: 'fixed' }, projectileSpeed: 0, splash: 1, capabilities: capabilities(), abilities: [] },
  spire: { plane: 'surface', hp: 7000, speed: 0, dmg: 30, range: 7, cooldown: toTicks(1), targets: ['surface', 'depths', 'sky', 'orbit'], alloy: 0, energy: 0, build: toTicks(0), vision: 9, radius: 1.5, armor: 'structure', weapon: 'beam', mount: { kind: 'fixed' }, projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: ['scan'], footprint: { w: 3, h: 3 } },
  shaft: { plane: 'surface', hp: 500, speed: 0, dmg: 0, range: 0, cooldown: toTicks(0), targets: [], alloy: 100, energy: 0, build: toTicks(8), vision: 4, radius: 0.8, armor: 'structure', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 2, h: 2 } },
  turret: { plane: 'surface', hp: 400, speed: 0, dmg: 12, range: 7, cooldown: toTicks(0.8), targets: ['surface', 'sky'], alloy: 80, energy: 20, build: toTicks(6), vision: 8, radius: 0.7, armor: 'structure', weapon: 'turret', mount: { kind: 'turret', traverse: Math.PI * 2 }, projectileSpeed: 18, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 1, h: 1 } },
  mooring_tower: { plane: 'surface', hp: 400, speed: 0, dmg: 0, range: 0, cooldown: 0, targets: [], alloy: 100, energy: 60, build: toTicks(25), vision: 7, radius: 1, armor: 'structure', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 2, h: 2 } },
  relay: { plane: 'sky', hp: 250, speed: 0, dmg: 0, range: 0, cooldown: toTicks(0), targets: [], alloy: 100, energy: 0, build: toTicks(6), vision: 8, radius: 0.8, armor: 'island', projectileSpeed: 0, splash: 0, capabilities: capabilities({ spotterDown: true }), abilities: [], footprint: { w: 1, h: 1 } },
  aerie: { plane: 'sky', hp: 400, speed: 0, dmg: 0, range: 0, cooldown: 0, targets: [], alloy: 150, energy: 40, build: toTicks(8), vision: 8, radius: 0.9, armor: 'island', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 1, h: 1 } },
  storm_seeder: { plane: 'sky', hp: 300, speed: 0, dmg: 0, range: 0, cooldown: 0, targets: [], alloy: 150, energy: 80, build: toTicks(8), vision: 8, radius: 0.8, armor: 'island', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 1, h: 1 } },
  stormcatcher: { plane: 'sky', hp: 250, speed: 0, dmg: 0, range: 0, cooldown: 0, targets: [], alloy: 150, energy: 40, build: toTicks(8), vision: 8, radius: 0.8, armor: 'island', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 1, h: 1 } },
  headframe: { plane: 'surface', hp: 600, speed: 0, dmg: 0, range: 0, cooldown: toTicks(0), targets: [], alloy: 150, energy: 0, build: toTicks(12), vision: 6, radius: 0.8, armor: 'structure', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 3, h: 3 } },
  bulkhead: { plane: 'depths', hp: 400, speed: 0, dmg: 0, range: 0, cooldown: toTicks(0), targets: [], alloy: 40, energy: 0, build: toTicks(5), vision: 2, radius: 0.45, armor: 'structure', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 1, h: 1 } },
  // An emplaced Gunship (`emplace`): rides its island in the defence slot, never queued. heavy_air, so Surface flak
  // and interceptor missiles hit it at ×1.25; range is the Gunship's plus rules.sky.emplaceRangeBonus (compileRules).
  gun_platform: { plane: 'sky', hp: 320, speed: 0, dmg: 9, range: 3, cooldown: toTicks(0.45), targets: ['sky'], alloy: 0, energy: 0, build: toTicks(0), vision: 7, radius: 0.6, armor: 'heavy_air', weapon: 'rifle', mount: { kind: 'turret', traverse: Math.PI * 2 }, projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 1, h: 1 } },
  // Queued gunner-slot defence; no downward sight. Surface aim comes only from the army's existing vision.
  island_mortar: { plane: 'sky', hp: 300, speed: 0, dmg: 60, range: 8, cooldown: toTicks(6), targets: ['surface'], alloy: 140, energy: 80, build: toTicks(20), vision: 0, radius: 0.6, armor: 'island', weapon: 'bomb', mount: { kind: 'turret', traverse: Math.PI * 2 }, projectileSpeed: 5, splash: 2.5, capabilities: capabilities(), abilities: [], footprint: { w: 1, h: 1 } },
  // Provisional supplemental economy: reserves and extracted cargo belong to the island, never this rig.
  ore_extractor: { plane: 'sky', hp: 250, speed: 0, dmg: 0, range: 0, cooldown: 0, targets: [], alloy: 80, energy: 40, build: toTicks(20), vision: 0, radius: 0.6, armor: 'island', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 1, h: 1 } },
  geothermal: { plane: 'depths', hp: 300, speed: 0, dmg: 0, range: 0, cooldown: toTicks(0), targets: [], alloy: 120, energy: 0, build: toTicks(5), vision: 2, radius: 0.45, armor: 'structure', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 1, h: 1 } },
  drill_yard: { plane: 'surface', hp: 500, speed: 0, dmg: 0, range: 0, cooldown: toTicks(0), targets: [], alloy: 120, energy: 40, build: toTicks(10), vision: 5, radius: 0.8, armor: 'structure', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 2, h: 2 } },
  // A lava bridge over a permanent lava-lake cell (`bridge`; cost and time in rules.depths.lavaBridge*): any army walks
  // it, combat and charges destroy it, and the cell is lava again.
  lava_bridge: { plane: 'depths', hp: 240, speed: 0, dmg: 0, range: 0, cooldown: toTicks(0), targets: [], alloy: 0, energy: 0, build: toTicks(0), vision: 1, radius: 0.45, armor: 'structure', projectileSpeed: 0, splash: 0, capabilities: capabilities(), abilities: [], footprint: { w: 1, h: 1 } },
};

/** The existing cell-grid exclusion around a structure: leave one whole cell between footprints. */
export const STRUCTURE_SPACING = 1;

/** Neutral objects and units have no rectangular footprint. */
export function footprint(kind) {
  return isStatKind(kind) ? STATS[kind].footprint : undefined;
}

export function footprintMinX(kind, x) {
  return x - (footprint(kind)?.w ?? 0) / 2;
}

export function footprintMinY(kind, y) {
  return y - (footprint(kind)?.h ?? 0) / 2;
}

/** Point-to-rectangle edge distance (zero inside); nonstructures retain point distance. */
export function footprintDistance(kind, x, y, px, py) {
  const f = footprint(kind);
  return norm(Math.max(0, Math.abs(px - x) - (f?.w ?? 0) / 2), Math.max(0, Math.abs(py - y) - (f?.h ?? 0) / 2));
}

/**
 * Half-diagonal of the Spire footprint (tiles). Segment beams reach `spire.range` + target radius beyond the footprint
 * edge, so from the centre they reach farthest on the diagonals, this much beyond range + radius: the radius a
 * bearing-free (disc) estimate of the beam must use.
 */
export const SPIRE_CORNER = norm(STATS.spire.footprint.w, STATS.spire.footprint.h) / 2;

/** Rectangle intersection, optionally including an empty-cell spacing ring. Touching edges alone do not overlap. */
export function footprintOverlap(kind, x, y, otherKind, ox, oy, spacing = 0) {
  const a = footprint(kind);
  const b = footprint(otherKind);
  return Math.abs(x - ox) < ((a?.w ?? 0) + (b?.w ?? 0)) / 2 + spacing
    && Math.abs(y - oy) < ((a?.h ?? 0) + (b?.h ?? 0)) / 2 + spacing;
}

/**
 * The one Surface level a structure site stands on: its whole footprint plus the STRUCTURE_SPACING apron around it is
 * all `SURFACE.ground` or all `SURFACE.high` (never straddling a cliff edge or ramp; no forest, ford, fault, water or
 * cliff). Returns that terrain code, or -1. The footprint (min cell `minX`,`minY`, `w`×`h`) must lie inside the map;
 * apron cells beyond the map edge do not count. Terrain is public, so this is fog-safe for clients and agents.
 */
export function surfaceSiteLevel(terrain, size, minX, minY, w, h) {
  if (minX < 0 || minY < 0 || minX + w > size || minY + h > size) return -1;
  const level = terrain[minY * size + minX];
  if (level !== SURFACE.ground && level !== SURFACE.high) return -1;
  const y1 = Math.min(size, minY + h + STRUCTURE_SPACING);
  const x1 = Math.min(size, minX + w + STRUCTURE_SPACING);
  for (let y = Math.max(0, minY - STRUCTURE_SPACING); y < y1; y++) {
    for (let x = Math.max(0, minX - STRUCTURE_SPACING); x < x1; x++) if (terrain[y * size + x] !== level) return -1;
  }
  return level;
}

/**
 * Surface build radius (DESIGN §6): the kinds that project it and the rule (an Econ / `rules.surface` key) giving each
 * radius. Turrets, Sky and Depths structures project none, so defences cannot chain-creep. A held home post (neutral
 * kind `post`, owned while held) projects postBuildRadius, a held contested point (a `post` that matchData.posts marks
 * `contested`) contestedPostBuildRadius instead. A new Surface source kind (barracks) is one entry here.
 */
export const BUILD_RADIUS_KINDS = ['spire', 'shaft', 'headframe', 'post'];
export const BUILD_RADIUS_RULE = { spire: 'buildRadiusSpire', shaft: 'buildRadiusShaft', headframe: 'buildRadiusHeadframe', post: 'postBuildRadius' };
export const isBuildRadiusKind = (kind) => Object.hasOwn(BUILD_RADIUS_RULE, kind);
/** Surface structures whose sites the build rule judges (Sky island and Depths structures are exempt). */
export const isRadiusBound = (kind) => (BUILDABLE).includes(kind);
/**
 * Headframes need no radius: a known lode is the expansion step itself, so taking a far lode stays as fast as before
 * the radius, and turret creep needs a completed Headframe or Shaft first. They still respect the no-build zone.
 */
export const radiusExempt = (kind) => kind === 'headframe';

/** Radius (tiles) a live, completed own `kind` projects (`contested`: a contested point); 0 for kinds that project none. */
export function buildRadiusOf(kind, rules, contested = false) {
  if (kind === 'post' && contested) return rules.contestedPostBuildRadius;
  return isBuildRadiusKind(kind) ? rules[BUILD_RADIUS_RULE[kind]] : 0;
}

/**
 * Does a `kind` source centred at (sx, sy) (`contested`: a contested point) cover a structure centred at (x, y)?
 * Squared distances keep it mirror-exact.
 */
export function inBuildRadius(kind, sx, sy, x, y, rules, contested = false) {
  const r = buildRadiusOf(kind, rules, contested);
  const dx = x - sx;
  const dy = y - sy;
  return r > 0 && dx * dx + dy * dy <= r * r;
}

/** Is a structure centred at (x, y) inside the no-build zone of the hostile Spire centred at (ex, ey)? */
export function inEnemySpireZone(ex, ey, x, y, rules) {
  return footprintDistance('spire', ex, ey, x, y) < rules.enemySpireNoBuild;
}

/**
 * The shared Surface placement rule (sim, bots, policies, client) for a `kind` site centred at (x, y): never inside the
 * no-build zone of any of `hostileSpires` (the Spire centres of hostile armies still in play: `matchData.armies` less
 * `eliminated`), and (except Headframes, see radiusExempt) within the radius of one of `sources` (the army's own live,
 * completed structures and held posts, contested points marked; kinds that project none are skipped). Uses only own
 * entities and public Spire and post positions, so it is fog-safe. Structures already standing outside a shrunken
 * radius keep working.
 */
export function buildSiteError(kind, sources, hostileSpires, x, y, rules) {
  for (const foe of hostileSpires) if (inEnemySpireZone(foe.x, foe.y, x, y, rules)) return 'no_build_zone';
  if (radiusExempt(kind)) return null;
  for (const s of sources) if (inBuildRadius(s.kind, s.x, s.y, x, y, rules, s.contested)) return null;
  return 'out_of_radius';
}

const TARGET_PLANE_BIT = { depths: 1, surface: 2, sky: 4, orbit: 8 };
const TARGET_MASK = {};
for (const [kind, stats] of Object.entries(STATS)) {
  let mask = 0;
  for (const plane of stats.targets) mask |= TARGET_PLANE_BIT[plane];
  TARGET_MASK[kind] = mask;
}

/**
 * Current weapon reach, not transfer destinations; active visits override it only on arrival. `lens`: the shooter
 * holds the `lens` capability (Lancer Lens research), so its Orbit beam also reaches the Sky below, without a transit.
 */
export function canHitPlane(kind, source, target, transit, lens = false) {
  if (transit && source === transit.to) return transit.reach ? transit.reach.includes(target) : target === transit.to;
  if (lens && source === 'orbit' && target === 'sky') return true;
  if (!((TARGET_MASK[kind] ?? 0) & TARGET_PLANE_BIT[target])) return false;
  if (kind === 'spire' || target === source) return target === source;
  if (source === 'orbit' && target === 'sky' && isStatKind(kind) && STATS[kind].weapon === 'point_defence') return true;
  return (source === 'surface' && target === 'sky') || (source === 'sky' && target === 'surface');
}
/** Max queued orders per unit (`queue: true`). */
export const ORDER_QUEUE = 8;
/** Tiles: how far beyond weapon range fight-moving and idle units notice enemies. */
export const ACQUIRE_RANGE = 2;
/** Tiles a unit may chase away from its anchor, by stance. */
export const LEASH = { aggressive: 8, defensive: 3, hold: 0 };

/** Default HP of each Spire segment (match rules `spire.hp`) under lossRule `surface`, where the Surface segment is the life. */
export const SPIRE_HP = { depths: 2500, surface: 7000, sky: 2500, orbit: 2500 };
/** Default segment HP under lossRule `crowns`: two side segments (one crown each) hold the Surface's two crowns' HP. */
export const CROWNS_SPIRE_HP = { depths: 3500, surface: 7000, sky: 3500, orbit: 3500 };
/** Does `kind` have a stats row (every kind except the neutral island and asteroid)? */
export const isStatKind = (kind) => Object.hasOwn(STATS, kind);
