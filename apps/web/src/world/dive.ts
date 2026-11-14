/**
 * Plane transitions: how the camera dive between planes moves and what the ink pass draws over it (docs/art/DIRECTIONS.md
 * §1 "Plane transitions"). A chosen plane snaps over in a short inked punch: radial speed lines travelling with the dive
 * (outward falling in, inward pulling out), a zoom smear, a chromatic split at the peak, paper grain and a wash of the
 * destination's accent leading in. Reduced motion crossfades through the destination's page instead; the Settings
 * toggle keeps the camera dive without the ink. Pure numbers here; `ink.ts` draws them.
 */
import { diveEffects, reducedMotion } from '../motion.ts';
import { clamp, easeInOutCubic } from './common.ts';

/**
 * Why the camera changes plane. `jump`: a chosen plane (player keys and chips, observer planes, minimap and feed jumps,
 * the auto-director's cuts). `tour`: the home backdrop's slow tour, faint lines only. `track`: following a unit that
 * changed plane (its own transit and timed-visit return visuals tell that story), no ink at all.
 */
export type DiveKind = 'jump' | 'tour' | 'track';
/** Duration (ms) and ink strength (0..1) per kind. */
export const DIVES: Readonly<Record<DiveKind, { readonly ms: number; readonly fx: number }>> = {
  jump: { ms: 450, fx: 1 },
  tour: { ms: 1150, fx: 0.35 },
  track: { ms: 1150, fx: 0 },
};

/** `ink`: dive plus the inked transition; `plain`: the camera dive alone; `fade`: no camera motion, a crossfade. */
export type DiveStyle = 'ink' | 'plain' | 'fade';

/** Decided once when a dive starts, so a preference flipped mid-dive never tears the one in flight. */
export function diveStyle(kind: DiveKind): DiveStyle {
  if (reducedMotion()) return 'fade';
  return DIVES[kind].fx > 0 && diveEffects() ? 'ink' : 'plain';
}

/** One frame of a dive. Every effect is 0 at both ends, so a dive starts and lands on the unaltered frame. */
export interface DiveLook {
  /** Dive progress, 0..1 (drives the speed lines' travel). */
  k: number;
  /** Eased progress of the camera level from the source plane (0) to the destination (1). */
  ease: number;
  /** Camera swing out and back (pitch, distance, field of view), 0..1. */
  swing: number;
  /** Extra field of view (degrees): the swing's widening plus the landing punch. */
  fov: number;
  /** Ink effects, 0..1 (already scaled by the kind's strength). */
  lines: number;
  smear: number;
  chroma: number;
  tint: number;
  grain: number;
  /** Reduced motion: cover by the destination's page (1 = fully covered). */
  wash: number;
}

export const restingLook = (): DiveLook => ({ k: 0, ease: 0, swing: 0, fov: 0, lines: 0, smear: 0, chroma: 0, tint: 0, grain: 0, wash: 0 });

/** Field-of-view widening at the swing's peak and the narrowing kick on landing (degrees). */
const FOV_SWING = 16;
const FOV_LAND = 5;

/**
 * The look at dive progress `k` (0..1) across `span` plane steps, written into `out` (no allocation per frame).
 * `fade` keeps the camera still and swaps planes at k = 0.5 while the page wash fully covers the frame.
 */
export function diveLook(out: DiveLook, k: number, span: number, style: DiveStyle, fx: number): DiveLook {
  const t = clamp(k, 0, 1);
  out.k = t;
  const arc = Math.sin(Math.PI * t);
  out.lines = out.smear = out.chroma = out.tint = out.grain = out.wash = 0;
  if (style === 'fade') {
    out.ease = t < 0.5 ? 0 : 1;
    out.swing = 0;
    out.fov = 0;
    out.wash = Math.min(1, arc * 1.25);
    return out;
  }
  out.ease = easeInOutCubic(t);
  out.swing = arc * Math.min(1, span);
  out.fov = out.swing * FOV_SWING;
  if (style !== 'ink') return out;
  // The punch: wide through the fall, then a short narrowing kick over the last quarter, settling exactly on landing.
  out.fov -= Math.sin(Math.PI * clamp((t - 0.75) / 0.25, 0, 1)) * FOV_LAND * fx;
  out.lines = fx * ramp(t, 0.04, 0.28) * (1 - ramp(t, 0.72, 0.98));
  out.smear = fx * arc * arc;
  out.chroma = fx * Math.exp(-(((t - 0.5) / 0.14) ** 2)) * arc;
  out.tint = fx * ramp(t, 0.3, 0.72) * (1 - ramp(t, 0.82, 1));
  out.grain = fx * arc;
  return out;
}

/** Smoothstep of `t` over a..b. */
function ramp(t: number, a: number, b: number): number {
  const x = clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
}

/** Any ink on screen: the composite's transition branches run only then (the reduced-motion wash is a plain lerp). */
export const inkActive = (l: DiveLook): boolean => l.lines + l.smear + l.chroma + l.tint + l.grain > 1e-3;
