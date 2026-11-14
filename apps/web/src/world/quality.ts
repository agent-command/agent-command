/**
 * Render quality tiers and the backend choice. Phones (`isPhone`) run tile-based GPUs (Mali, Adreno) where memory
 * bandwidth dominates: every device pixel is shaded, stored and reloaded once per full-screen pass, so the phone tier
 * cuts pixels (pixel ratio 1, no MSAA resolve) and passes (no bloom mip chain, a coarser storm target) before anything
 * else. The look keeps its ink lines, cel shading, fog and storms; only the emissive glow and paper grain go, the
 * ground scatter thins and the shore field coarsens.
 */
import { SHORE } from './shore.ts';

export type QualityTier = 'full' | 'phone';
export type Backend = 'webgpu' | 'webgl';

export interface Quality {
  readonly tier: QualityTier;
  /** Device pixels per CSS pixel, at most. */
  readonly maxPixelRatio: number;
  /** 4× MSAA on the canvas and the ink scene pass. */
  readonly msaa: boolean;
  /** The emissive bloom: a five-mip blur chain, about eleven extra full- and part-screen passes. */
  readonly bloom: boolean;
  /** Paper grain and fibres in the ink composite: two 3D noise evaluations per pixel. */
  readonly grain: boolean;
  /** Share of the drawing buffer's width and height the fused storm pass renders at. */
  readonly stormScale: number;
  /**
   * Death effects (`death-fx.ts`): `cap` deaths play their staged effect at once (more get a one-shot burst, no
   * lingering stages or animated wreck), `density` scales every particle count and emission rate, `linger` the
   * smoke columns' and scorches' durations.
   */
  readonly deaths: { readonly cap: number; readonly density: number; readonly linger: number };
  /** Surface grass and pebbles (`ground-detail.ts`): at most `slots` of each per cell (of `SCATTER_SLOTS`). */
  readonly scatter: { readonly slots: number };
  /** Shore field texels per cell (`shore.ts`): the resolution of the water's coast distance, flow and fords. */
  readonly shoreRes: number;
}

export const QUALITY: Readonly<Record<QualityTier, Quality>> = {
  full: { tier: 'full', maxPixelRatio: 1.75, msaa: true, bloom: true, grain: true, stormScale: 0.5, deaths: { cap: 32, density: 1, linger: 1 }, scatter: { slots: 5 }, shoreRes: SHORE.res },
  // A Pixel 9 is 412 CSS px wide at DPR 2.625: ratio 1 shades 1/6.9 of its native pixels; the previous 1.75 cap shaded
  // 3.1× as many as ratio 1 does, before the 4× MSAA target and its resolve.
  phone: { tier: 'phone', maxPixelRatio: 1, msaa: false, bloom: false, grain: false, stormScale: 0.35, deaths: { cap: 12, density: 0.5, linger: 0.6 }, scatter: { slots: 2 }, shoreRes: SHORE.res / 2 },
};

/** `?quality=full|phone` overrides (A/B on a device); otherwise a phone gets the phone tier. */
export function qualityTier(params: URLSearchParams, phone: boolean): QualityTier {
  const asked = params.get('quality');
  if (asked === 'full' || asked === 'phone') return asked;
  return phone ? 'phone' : 'full';
}

/**
 * `?renderer=webgl|webgpu` overrides; otherwise WebGPU wherever the browser exposes it, phones included: three's
 * per-draw CPU cost is the same on WebGPURenderer's WebGL2 backend (bind-group and uniform churn live in the renderer
 * class, not the backend), while WebGPU's GPU-side savings grow with pixel count. Without `navigator.gpu` only
 * WebGL2 exists, whatever was asked.
 */
export function backendChoice(params: URLSearchParams, hasWebGPU: boolean): Backend {
  if (!hasWebGPU) return 'webgl';
  return params.get('renderer') === 'webgl' ? 'webgl' : 'webgpu';
}
