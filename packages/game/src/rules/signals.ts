/**
 * Team signals (PlayerThree `manifest.signals`, DESIGN §9.2): the one cross-seat help path. A seat asks a teammate's
 * plane for support with `request_support`; the target answers through `signal_update`. Typed only: a need, an
 * optional count and an optional tile; no text. Each plane's card lists the needs it answers, so routing never asks a
 * plane for what it cannot do. The `signals` match rules (ECON `signal*`) narrow SIGNAL_LIMITS_MAX or turn them off.
 */
import { signalSchemas, type SignalLimits } from 'playerthree/signals';
import { t } from 'playerthree/schema';
import { MAX_MAP_SIZE, PLANES, type Plane, SUPPORT_COUNT_MAX, toTicks } from './vocabulary.ts';

/**
 * What a teammate can ask for, and who answers:
 * - troops: Surface sends troopers (down an own Shaft when asked from the Depths, else to the tile); the Depths send
 *   troopers up an own Shaft when the Surface asks (own built Shafts are the only Surface↔Depths portals);
 * - flak: Surface moves flak under the tile (falling rocks, enemy air over a sky island's path);
 * - air_cover: Sky screens the tile with interceptors (from Orbit: ascends them to cover arrays or tugs);
 * - bombers: Sky sends bombers onto the tile (a structure there);
 * - scan: Orbit scans the tile;
 * - escort: Orbit's fleet escorts the tile in orbit (an ascended interceptor raid, a tow);
 * - collapse: the Depths undermine the tile from a tunnel below it (sappers, stacked as a structure there needs);
 * - drop: Orbit deorbits a towed asteroid onto the tile;
 * - capture: Sky takes the island nearest the tile, Surface the forward post nearest it (asked of the team: whichever
 *   is there);
 * - defend: our Spire segment on `plane` is threatened (alert segment_threatened): any seat with a tool that reaches
 *   that plane helps hold it (send it to `team`).
 */
export const SUPPORT_NEEDS = ['troops', 'air_cover', 'scan', 'flak', 'bombers', 'escort', 'collapse', 'drop', 'capture', 'defend'] as const;
export type SupportNeed = (typeof SUPPORT_NEEDS)[number];

/** The plane(s) whose card answers each need (also the generated `to` values). */
export const NEED_ANSWERERS: Readonly<Record<SupportNeed, readonly Plane[]>> = {
  troops: ['surface', 'depths'],
  flak: ['surface'],
  air_cover: ['sky'],
  bombers: ['sky'],
  scan: ['orbit'],
  escort: ['orbit'],
  collapse: ['depths'],
  drop: ['orbit'],
  capture: ['sky', 'surface'],
  defend: PLANES,
};

/**
 * The manifest's signal limits: the upper bounds of the `signals` match rules (they size the observation lists).
 * A match narrows them through its rules (`signalLimitsOf`), or turns signals off.
 */
export const SIGNAL_LIMITS_MAX: SignalLimits = {
  perSecond: 2,
  burst: 8,
  maxOpen: 4,
  ttlTicks: toTicks(120),
  keepTicks: toTicks(30),
};

const answers = (plane: Plane) => {
  const needs = SUPPORT_NEEDS.filter((need) => NEED_ANSWERERS[need].includes(plane));
  return needs.length > 0 ? [{ kind: 'request_support', where: { need: needs } }] : [];
};

export const SIGNALS = {
  kinds: {
    request_support: {
      roles: [...PLANES],
      params: {
        need: t.enum(SUPPORT_NEEDS, 'troops (Surface, Depths), flak (Surface), air_cover and bombers (Sky), scan, escort and drop (Orbit), collapse (Depths), capture (Sky islands, Surface posts), defend (everyone: `to` team).'),
        count: t.opt(t.int(1, SUPPORT_COUNT_MAX, 'How many units you want (troops, interceptors, bombers, flak, sappers on a collapse); omitted: the answerer decides.')),
        x: t.opt(t.int(0, MAX_MAP_SIZE - 1, 'Tile x of where you need it (all planes share x/y).')),
        y: t.opt(t.int(0, MAX_MAP_SIZE - 1, 'Tile y.')),
        plane: t.opt(t.enum(PLANES, 'defend: the plane of our threatened Spire segment.')),
      },
      doc: `Ask a teammate's plane for support at a tile. The answering seat acks when it commits, then sends done (or fail); decline when it cannot. Built-in bots answer within a budget and their own priorities. What each need means for the answerer:
- troops → Surface: troopers move to the tile; asked by the Depths, they transfer down the own Shaft nearest the tile (own built, unsealed Shafts are the only portals) and join you there. → Depths: troopers come up an own Shaft near the tile.
- flak → Surface: flak moves under the tile (falling rocks, enemy air over an island's path) and holds there.
- air_cover → Sky: interceptors screen the tile; asked by Orbit, researched interceptors ascend to cover your arrays or tugs near the tile (Ascent rules apply).
- bombers → Sky: bombers attack a visible structure at the tile once the sky is safe enough.
- scan → Orbit: a scan reveals the tile on all planes (energy, cooldown).
- escort → Orbit: the fleet (Bastions first) moves to the tile in orbit to escort an ascended raid or a tow.
- collapse → Depths: sappers undermine the tile from a tunnel below it (as many stacked as a known structure there needs, or count); without a tunnel there the diggers dig one first. Done once the charge is planted.
- drop → Orbit: the next towed asteroid that can reach is deorbited onto the tile (mandate asteroidDrops permitting). Done once it falls.
- capture → Sky: interceptors take the island nearest the tile; → Surface: troopers take the forward post nearest it. Ask the team: the plane with something to take there acks, the other declines. Done once held.
- defend {plane} → team (alert segment_threatened; under lossRule crowns a fallen segment costs crowns): whoever reaches that plane helps hold our segment there, x/y = our Spire. Built-in bots: Depths segment → Surface troopers down a Shaft; Surface → Depths troopers up a Shaft; Sky → Surface flak under the Spire; Orbit → Sky interceptors ascend (Ascent Thrusters).
Give x/y whenever the need has a place; count is a wish, not a promise.`,
    },
  },
  cards: Object.fromEntries(PLANES.map((plane) => [plane, answers(plane)])),
} as const;

export const SIGNAL_SCHEMAS = signalSchemas(PLANES, SIGNALS, SIGNAL_LIMITS_MAX);

/** This match's signal limits from its compiled rules, or null when the `signals.enabled` rule is off. */
export function signalLimitsOf(econ: {
  readonly signalsEnabled: boolean; readonly signalRate: number; readonly signalBurst: number;
  readonly signalMaxOpen: number; readonly signalTtlTicks: number; readonly signalKeepTicks: number;
}): SignalLimits | null {
  if (!econ.signalsEnabled) return null;
  return { perSecond: econ.signalRate, burst: econ.signalBurst, maxOpen: econ.signalMaxOpen, ttlTicks: econ.signalTtlTicks, keepTicks: econ.signalKeepTicks };
}
