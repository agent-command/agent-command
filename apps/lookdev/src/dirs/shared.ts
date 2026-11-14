/** TSL building blocks several looks share: key light, cel ramp, world-space hatching, edge detection. */
import { type Node, type PassNode, type PerspectiveCamera } from 'three/webgpu';
import {
  abs,
  color,
  dot,
  float,
  fwidth,
  max,
  mix,
  mx_noise_float,
  normalWorld,
  perspectiveDepthToViewZ,
  positionWorld,
  screenSize,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { F1, V3 } from '../kit.ts';
import { SUN_DIR } from '../world.ts';

export const SUN = uniform(SUN_DIR.clone());

/**
 * Two-tone cel ramp with a hue-shifted shadow, a thin highlight band and stepped AO. `sunVis` is the baked (terrain)
 * or 1 (units) sun visibility; `soft` widens the terminator (clouds).
 */
export function cel(base: V3, shadowTint: string, sunVis: F1 | number = 1, ao: F1 | number = 1, soft = 0.08): V3 {
  const ndl = dot(normalWorld, SUN);
  const sv: F1 = typeof sunVis === 'number' ? float(sunVis) : sunVis;
  const occ: F1 = typeof ao === 'number' ? float(ao) : ao;
  const lit = smoothstep(0, soft, ndl).mul(smoothstep(0.3, 0.55, sv));
  const hi = smoothstep(0.7, 0.76, ndl).mul(lit).mul(0.1);
  const shade = base.mul(color(shadowTint));
  const occl = mix(float(0.74), float(1), smoothstep(0.55, 0.8, occ));
  return mix(shade, base, lit).add(hi).mul(occl) as V3;
}

/** Antialiased line mask for a scalar field whose integer+0.5 crossings are lines; `w` = half width (0..0.5). */
export function lines(s: F1, w: F1 | number): F1 {
  const d = abs(s.fract().sub(0.5));
  const fw = fwidth(s).max(1e-4);
  const wn: F1 = typeof w === 'number' ? float(w) : w;
  return float(1).sub(smoothstep(wn.sub(fw), wn.add(fw), d)) as F1;
}

/** World-space tonal hatching: one direction below `tone` 0.75, cross-hatch below 0.45. Returns ink coverage. */
export function hatch(tone: F1, freq = 7): F1 {
  const p = positionWorld;
  const s1 = dot(p, vec3(1, 0.7, 1)).mul(freq) as F1;
  const s2 = dot(p, vec3(1, -0.7, -1)).mul(freq) as F1;
  const w1 = smoothstep(0.85, 0.35, tone).mul(0.32);
  const w2 = smoothstep(0.5, 0.15, tone).mul(0.28);
  return max(lines(s1, w1), lines(s2, w2)) as F1;
}

export const lum = (c: V3): F1 => dot(c, vec3(0.3, 0.55, 0.15)) as F1;

/**
 * Screen-space edges from a depth + view-normal MRT pass: depth Laplacian (silhouettes, relative to distance so it
 * works at every zoom) and normal discontinuity (creases). `width` in pixels; `wobble` jitters the sample offset
 * by low-frequency screen noise for a hand-inked line.
 */
export function edges(scenePass: PassNode, camera: PerspectiveCamera, width = 1, wobble = 0, normalLo = 0.3, normalHi = 0.65): F1 {
  const nrm = scenePass.getTextureNode('normal');
  const dep = scenePass.getTextureNode('depth');
  const near = uniform(camera.near);
  const far = uniform(camera.far);
  const px = vec2(width, width).div(screenSize);
  const jitter = wobble ? mx_noise_float(vec3(screenUV.mul(vec2(9, 6)), 1)).mul(wobble).add(1) : float(1);
  const o = px.mul(jitter);
  const z = (u: Node<'vec2'>): F1 => perspectiveDepthToViewZ(dep.sample(u).r, near, far).negate() as F1;
  const n = (u: Node<'vec2'>): V3 => nrm.sample(u).xyz as V3;
  const u0 = screenUV;
  const ue = u0.add(vec2(o.x, 0));
  const uw = u0.sub(vec2(o.x, 0));
  const un = u0.add(vec2(0, o.y));
  const us = u0.sub(vec2(0, o.y));
  const z0 = z(u0);
  const lap = abs(z(ue).add(z(uw)).sub(z0.mul(2))).add(abs(z(un).add(z(us)).sub(z0.mul(2)))).div(z0);
  const depthEdge = smoothstep(0.006, 0.02, lap);
  const n0 = n(u0);
  const nd = float(4).sub(dot(n0, n(ue)).add(dot(n0, n(uw))).add(dot(n0, n(un))).add(dot(n0, n(us))));
  const normalEdge = smoothstep(normalLo, normalHi, nd);
  return max(depthEdge, normalEdge) as F1;
}
