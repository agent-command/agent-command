import { ECON, PLANES, TICK_RATE, type Plane } from '@agent-command/game/contract';
import { CURSOR } from '../cursors.ts';

export interface ToolMeta {
  id: string;
  planes: readonly Plane[];
  label: string;
  hint: string;
  hotkey?: { classic: string; wasd: string };
  cursor: string;
}
const key = (classic: string, wasd = classic) => ({ classic, wasd });

/** Presentation and keyboard metadata only; safe to import in help and settings. */
const definitions = [
  { id: 'default', planes: PLANES, label: 'Select', hint: 'Click or left-drag to select · right-click: the order the cursor shows (move, attack, descend, capture, grapple, mine…) · Alt+right-click bypasses contextual orders · Ctrl+right-click for Depths abilities', cursor: CURSOR.pointer },
  { id: 'designate', planes: ['depths'], label: 'Dig', hint: 'Dig: right-drag 2+ tiles for normal tags · Shift urgent · Alt clear · no selection needed · selected diggers work the box immediately · armed tool: left-drag, Alt/Ctrl clear, Esc or right-click cancels', hotkey: key('j'), cursor: CURSOR.build },
  { id: 'amove', planes: PLANES, label: 'Attack-move', hint: 'Attack-move: click a point (units fight on the way)', hotkey: key('a', 'z'), cursor: CURSOR.attackMove },
  { id: 'lensAttack', planes: PLANES, label: 'Cross-plane attack', hint: 'Click a contact in reach', hotkey: key('o'), cursor: CURSOR.invalid },
  { id: 'move', planes: PLANES, label: 'Move', hint: 'Move: click a point (no stopping or chasing; mobile weapons can fire en route)', hotkey: key('m'), cursor: CURSOR.move },
  { id: 'patrol', planes: PLANES, label: 'Patrol', hint: 'Patrol: click the far end of the route', hotkey: key('p'), cursor: CURSOR.waypoint },
  { id: 'stop', planes: PLANES, label: 'Stop', hint: 'Stop selected units', hotkey: key('s', 'x'), cursor: CURSOR.pointer },
  { id: 'hold', planes: PLANES, label: 'Hold', hint: 'Hold position: fire only at what comes in range', hotkey: key('h'), cursor: CURSOR.pointer },
  { id: 'mine', planes: ['depths'], label: 'Mine', hint: 'Mine nearest known ore (or the Mother Lode) and haul it home', hotkey: key('g'), cursor: CURSOR.pointer },
  { id: 'fortify', planes: ['depths'], label: 'Fortify', hint: `Diggers or Wardens: click a rock wall of one of your own tunnels to harden it (a cracked wall is repaired, a fortified one reinforced). Time only, ${ECON.fortifyTicks / TICK_RATE} s (Wardens ×${ECON.wardenFortifySpeed} faster); an own bulkhead is repaired and reinforced; never tunnel cells`, hotkey: key('f'), cursor: CURSOR.build },
  { id: 'bulkhead', planes: ['depths'], label: 'Bulkhead', hint: 'Click a tunnel cell (not rail) next to a tunnel to queue a bulkhead: a digger builds a gate enemies must break', hotkey: key('k'), cursor: CURSOR.build },
  { id: 'geothermal', planes: ['depths'], label: 'Geothermal tap', hint: 'Click known rock cardinally beside a located sealed magma pocket; a digger works from an adjacent tunnel. One tap per pocket', cursor: CURSOR.build },
  { id: 'undermine', planes: ['depths'], label: 'Undermine', hint: 'Click a tunnel cell under the enemy (under a fault line: opens a chasm)', hotkey: key('u'), cursor: CURSOR.charge },
  { id: 'breach', planes: ['depths'], label: 'Breach', hint: 'Click a tunnel cell: troopers dig up for 6 s and climb out (one way: the hole is no portal)', hotkey: key('b'), cursor: CURSOR.sabotage },
  { id: 'deploy', planes: ['surface', 'depths'], label: 'Deploy', hint: `Root the selection: troopers dig in (${ECON.digInTicks / TICK_RATE} s; ×${ECON.dugInDamageTaken} from rifles, cannons, turrets), tanks siege (${ECON.siegeDeployTicks / TICK_RATE} s; reach ${ECON.siegeRangeStructures} vs structures, ${ECON.siegeRangeUnits} vs units, min ${ECON.siegeMinRange}, over cliffs at what you see), flak emplaces (${ECON.emplaceTicks / TICK_RATE} s; ${ECON.emplacedFlakRange} vs the Sky), Wardens raise the shield wall (friendly units pass without packing; enemies stay blocked). No firing while deploying; any order but attack or stop packs first`, cursor: CURSOR.pointer },
  { id: 'pack', planes: ['surface', 'depths'], label: 'Pack', hint: 'Pack deployed units up (no firing meanwhile); they stand idle, mobile again', cursor: CURSOR.pointer },
  { id: 'flare', planes: ['depths'], label: 'Flare', hint: `Click a known open tunnel cell within ${ECON.flareRange} tiles of a Warden: its flare lights the tunnels ${ECON.flareRange} tiles round it for ${ECON.flareRevealTicks / TICK_RATE} s. ${ECON.flareCooldown / TICK_RATE} s cooldown per Warden`, cursor: CURSOR.scan },
  { id: 'rail', planes: ['depths'], label: 'Lay rail', hint: 'Click a tunnel cell: diggers lay rail along the way there', hotkey: key('l'), cursor: CURSOR.build },
  { id: 'bridge', planes: ['depths'], label: 'Backfill', hint: `Click a hole (sinkhole, crater, chasm or breach) over a cell beside your tunnel: the nearest digger fills it back in · ${ECON.bridgeCost} alloy, ${ECON.bridgeTicks / TICK_RATE} s each. Or a lava-lake cell beside dry ground or a bridge: diggers deck it over · ${ECON.lavaBridgeCost} alloy, ${ECON.lavaBridgeTicks / TICK_RATE} s each`, hotkey: key('n'), cursor: CURSOR.build },
  { id: 'convert', planes: ['surface'], label: 'Convert to Breacher', hint: 'Troopers walk into your Drill Yard and come out Breachers (close-range flamer: ×2 vs dug-in troopers, burns structures)', cursor: CURSOR.enter },
  { id: 'transfer', planes: ['surface', 'depths'], label: 'Descend / climb', hint: 'Through your own built Shaft (sealed until a tunnel reaches its landing); the Spire, holes and enemy Shafts are no portals', hotkey: key('t'), cursor: CURSOR.enter },
  { id: 'mine_asteroid', planes: ['orbit'], label: 'Mine asteroid', hint: 'Click a visible metal or ice asteroid: extract cargo, unload at your Orbit segment and return. Move or Stop detaches, retaining cargo', hotkey: key("'"), cursor: CURSOR.build },
  { id: 'grapple', planes: ['orbit'], label: 'Tow payload', hint: 'Click a drifting asteroid or resting core to tow it whole; dock for salvage or deorbit', cursor: CURSOR.grapple },
  { id: 'deorbit', planes: ['orbit'], label: 'Deorbit', hint: 'Aim through the Sky and Surface hologram under the cursor: blast ring, fall path, reach, Sky threats and friendly fire · click to drop · Alt aims without it', hotkey: key('d', 'v'), cursor: CURSOR.strike },
  { id: 'vent', planes: ['orbit'], label: 'Vent core', hint: `Tugs towing the derelict core hold still ${ECON.coreVentTicks / TICK_RATE} s: heat drops to the core's vents so far × ${ECON.coreVentFloor} (each vent buys less) and it pulses ${ECON.coreVentDamage} damage to every Orbit unit within ${ECON.coreVentRadius} tiles`, cursor: CURSOR.pointer },
  // `;`: every letter is taken in one layout or the other (E dives up, I selects idle), and the key stays put in both.
  { id: 'release', planes: ['orbit'], label: 'Release tow', hint: 'Tugs let go of whatever they tow, where they are: a rock drifts on, the derelict core stays put', hotkey: key(';'), cursor: CURSOR.pointer },
  { id: 'sun_lance', planes: ['orbit'], label: 'Sun lance', hint: 'Aim a direction in Orbit · sunlit Lancers charge a piercing travelling lance and drain their own shield', hotkey: key(','), cursor: CURSOR.precise },
  { id: 'aegis', planes: ['orbit'], label: 'Aegis', hint: 'Researched Bastions stop and project a shared shield over nearby allied Orbit ships', hotkey: key('.'), cursor: CURSOR.pointer },
  { id: 'ascend', planes: ['sky', 'orbit'], label: 'Ascend', hint: 'Researched interceptors climb into Orbit for a temporary raid; ready aircraft pay the match energy cost together', cursor: CURSOR.pointer },
  { id: 'moor', planes: ['surface'], label: 'Moor island', hint: 'Select one Mooring Tower, then pick any visible island through the Sky Lens. The tower waits for it to enter catch range; ownership is unchanged', cursor: CURSOR.place },
  { id: 'unmoor', planes: ['surface'], label: 'Release island', hint: 'Cancel the selected tower’s pending catch or release its island to rise into a safe gap on the original route', cursor: CURSOR.pointer },
  { id: 'bombard', planes: ['sky'], label: 'Bombard Surface', hint: 'Select an Island Mortar and pick a visible enemy Surface target through the Lens. Slow arcing shells strike the fired point; splash can hit allies', cursor: CURSOR.attack },
  { id: 'emplace', planes: ['sky'], label: 'Emplace', hint: 'Click an island you hold: a selected Gunship over it lands on the hardpoint for good as a Gun Platform', cursor: CURSOR.place },
  { id: 'scan', planes: PLANES, label: 'Scan', hint: `Click any point (any plane) to scan · ${ECON.scanCost} energy`, hotkey: key('c'), cursor: CURSOR.scan },
  { id: 'rally', planes: PLANES, label: 'Set rally', hint: 'Click to set this plane’s rally point', hotkey: key('r'), cursor: CURSOR.rally },
  { id: 'build', planes: ['surface', 'sky'], label: 'Build', hint: 'Click a Surface tile, or an island you hold with the chosen slot free: main structure or secondary hardpoint. Ore Extractors require a non-depleted ore deposit', cursor: CURSOR.place },
  { id: 'relay', planes: ['sky'], label: 'Relay', hint: 'Click an island you hold to queue a Relay', cursor: CURSOR.place },
  { id: 'pick', planes: PLANES, label: 'Commander focus', hint: 'Click the map to set the commander focus point', cursor: CURSOR.beacon },
  { id: 'request', planes: PLANES, label: 'Request', hint: 'Request: click the map where a teammate should help', cursor: CURSOR.beacon },
] as const satisfies readonly ToolMeta[];
export type ToolId = (typeof definitions)[number]['id'];
export const LENS_PEEK_META = { id: 'peek', planes: PLANES, label: 'Hold to peek', hint: 'Hold Y: a hologram of the plane below or above, in place around the cursor, no selection needed · Surface → Sky, Sky → Surface, Depths → Surface, Orbit → Sky and Surface · Shift reverses Surface/Sky direction · release, Esc or right-click closes · viewing only; orders stay on source plane', hotkey: key('y') } as const;
export type ToolKeyCommand = Extract<(typeof definitions)[number], { hotkey: unknown }>['id'] | typeof LENS_PEEK_META.id;
export const TOOL_META: readonly (ToolMeta & { id: ToolId })[] = definitions;

export type CardGroup = 'commands' | 'abilities';
/**
 * Command-card placement in display order. Commands are the ordinary unit orders in one compact style; abilities are
 * unit or team specials with a framed tile, cost and cooldown. `rank` orders the overflow: when a selection has more
 * actions than fit, the lowest ranks move under the card's one More button first.
 */
export const CARD_SLOTS: Readonly<Partial<Record<ToolId, { group: CardGroup; rank: number }>>> = {
  move: { group: 'commands', rank: 9 },
  amove: { group: 'commands', rank: 9 },
  stop: { group: 'commands', rank: 8 },
  hold: { group: 'commands', rank: 7 },
  patrol: { group: 'commands', rank: 3 },
  lensAttack: { group: 'commands', rank: 5 },
  rally: { group: 'commands', rank: 6 },
  mine: { group: 'commands', rank: 6 },
  mine_asteroid: { group: 'commands', rank: 10 },
  grapple: { group: 'commands', rank: 9 },
  designate: { group: 'commands', rank: 6 },
  transfer: { group: 'commands', rank: 5 },
  fortify: { group: 'commands', rank: 2 },
  bulkhead: { group: 'commands', rank: 2 },
  sun_lance: { group: 'abilities', rank: 12 },
  aegis: { group: 'abilities', rank: 12 },
  deorbit: { group: 'abilities', rank: 12 },
  vent: { group: 'abilities', rank: 12 },
  release: { group: 'abilities', rank: 12 },
  ascend: { group: 'abilities', rank: 12 },
  moor: { group: 'abilities', rank: 11 },
  unmoor: { group: 'abilities', rank: 11 },
  bombard: { group: 'abilities', rank: 12 },
  emplace: { group: 'abilities', rank: 11 },
  undermine: { group: 'abilities', rank: 11 },
  breach: { group: 'abilities', rank: 11 },
  convert: { group: 'abilities', rank: 11 },
  deploy: { group: 'abilities', rank: 11 },
  pack: { group: 'abilities', rank: 11 },
  flare: { group: 'abilities', rank: 11 },
  rail: { group: 'abilities', rank: 10 },
  bridge: { group: 'abilities', rank: 10 },
  geothermal: { group: 'abilities', rank: 10 },
  scan: { group: 'abilities', rank: 10 },
};
