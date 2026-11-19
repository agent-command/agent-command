/** Small, dependency-free statistics for win rates and distributions. */

export interface Interval {
  /** point estimate */
  p: number;
  lo: number;
  hi: number;
}

const Z95 = 1.959964;

/** Wilson score interval for k successes in n trials (95% by default). n = 0 → the uninformative [0, 1]. */
export function wilson(k: number, n: number, z = Z95): Interval {
  if (n <= 0) return { p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // k = 0 / k = n bound exactly at 0 / 1 (float rounding would leave 1 − ε).
  return { p, lo: k === 0 ? 0 : Math.max(0, centre - half), hi: k === n ? 1 : Math.min(1, centre + half) };
}

/**
 * Exact two-sided binomial test of k successes in n trials against success probability p0: the total probability
 * of every outcome no more likely than the observed one. n = 0 → 1.
 */
export function binomialTwoSided(k: number, n: number, p0 = 0.5): number {
  if (n <= 0) return 1;
  const logPmf: number[] = new Array(n + 1);
  // log C(n, i) built incrementally: no factorial overflow for any n.
  let logC = 0;
  const lp = Math.log(p0);
  const lq = Math.log(1 - p0);
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    logPmf[i] = logC + i * lp + (n - i) * lq;
  }
  const observed = logPmf[k]!;
  let total = 0;
  // Relative tolerance so mirror-image outcomes of a symmetric null count as equally likely.
  for (const lpi of logPmf) if (lpi <= observed + 1e-9) total += Math.exp(lpi);
  return Math.min(1, total);
}

/** Outcomes the exact multinomial test enumerates at most; larger samples use the χ² approximation. */
const EXACT_OUTCOMES = 2_000_000;

/**
 * Goodness of fit of `counts` (one category per slot) against the uniform distribution: the probability under the
 * uniform null of an outcome no more likely than the observed one. Two categories are exactly the two-sided binomial
 * test at p0 = 0.5; more use the exact multinomial test while its outcome space (C(n + k − 1, k − 1)) stays small,
 * else Pearson's χ² with k − 1 degrees of freedom. No observations (or one category) → 1.
 */
export function uniformFit(counts: readonly number[]): number {
  const k = counts.length;
  const n = counts.reduce((a, b) => a + b, 0);
  if (n <= 0 || k < 2) return 1;
  if (k === 2) return binomialTwoSided(counts[0]!, n);
  if (outcomes(n, k) > EXACT_OUTCOMES) {
    const expected = n / k;
    return chiSquareSurvival(counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0), k - 1);
  }
  const logFact = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) logFact[i] = logFact[i - 1]! + Math.log(i);
  // log P(x) = log n! − Σ log xᵢ! − n log k; only the Σ part differs between outcomes.
  const base = logFact[n]! - n * Math.log(k);
  const observed = base - counts.reduce((sum, c) => sum + logFact[c]!, 0);
  let total = 0;
  const visit = (category: number, left: number, partial: number): void => {
    if (category === k - 1) {
      const lp = base - partial - logFact[left]!;
      // Relative tolerance so permutations of the observed counts (equally likely under the null) are included.
      if (lp <= observed + 1e-9) total += Math.exp(lp);
      return;
    }
    for (let c = 0; c <= left; c++) visit(category + 1, left - c, partial + logFact[c]!);
  };
  visit(0, n, 0);
  return Math.min(1, total);
}

/** C(n + k − 1, k − 1), the number of ways to split n observations over k categories. */
function outcomes(n: number, k: number): number {
  let c = 1;
  for (let i = 1; i < k; i++) c = (c * (n + i)) / i;
  return c;
}

/** P(X ≥ x) for X ~ χ²(df): the regularized upper incomplete gamma Q(df/2, x/2). */
export function chiSquareSurvival(x: number, df: number): number {
  if (x <= 0) return 1;
  const a = df / 2;
  const z = x / 2;
  const lead = a * Math.log(z) - z - logGamma(a);
  if (z < a + 1) {
    // Series for the lower function P, then Q = 1 − P.
    let term = 1 / a;
    let sum = term;
    for (let i = 1; i < 1000 && Math.abs(term) > Math.abs(sum) * 1e-15; i++) {
      term *= z / (a + i);
      sum += term;
    }
    return Math.max(0, 1 - sum * Math.exp(lead));
  }
  // Lentz continued fraction for Q.
  const tiny = 1e-300;
  let b = z + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.min(1, Math.exp(lead) * h);
}

/** Lanczos coefficients (g = 7, n = 9; ~15 significant digits). */
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7] as const;

/** log Γ(x) for x > 0. */
function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const y = x - 1;
  const t = y + 7.5;
  let a: number = LANCZOS[0];
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Linear-interpolated quantile (q in [0, 1]) of an unsorted sample; NaN for an empty sample. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Counts of `xs` per bucket: bucket i holds edges[i] ≤ x < edges[i+1]; the last bucket is open-ended. */
export function histogram(xs: readonly number[], edges: readonly number[]): number[] {
  const out = new Array<number>(edges.length).fill(0);
  for (const x of xs) {
    let i = edges.length - 1;
    while (i > 0 && x < edges[i]!) i--;
    out[i]!++;
  }
  return out;
}
