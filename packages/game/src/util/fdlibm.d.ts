/**
 * Types of fdlibm.js: PlayerThree's deterministic fdlibm Math, bit-identical in every engine. `sqrt`, `floor`, `round`,
 * `abs`, `min`, `max` and the like are exact by specification: call them on `Math`.
 */
export declare const dmath: {
  sin(x: number): number;
  cos(x: number): number;
  tan(x: number): number;
  asin(x: number): number;
  acos(x: number): number;
  atan(x: number): number;
  atan2(y: number, x: number): number;
  sinh(x: number): number;
  cosh(x: number): number;
  tanh(x: number): number;
  asinh(x: number): number;
  acosh(x: number): number;
  atanh(x: number): number;
  exp(x: number): number;
  expm1(x: number): number;
  log(x: number): number;
  log1p(x: number): number;
  log2(x: number): number;
  log10(x: number): number;
  pow(x: number, y: number): number;
  cbrt(x: number): number;
  hypot(a: number, b: number): number;
};
