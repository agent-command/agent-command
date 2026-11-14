/**
 * Bot answers as text for decision traces, keeping visible every value JSON would merge: a package's answer reaches
 * the host as JSON (-0 → 0, NaN and ±Infinity → null, undefined fields dropped), an in-process bot's as the objects
 * themselves, which the sim could tell apart.
 */
export function exactJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'number' && (Object.is(v, -0) || !Number.isFinite(v))) return `<${Object.is(v, -0) ? '-0' : v}>`;
    return v === undefined ? '<undefined>' : v;
  });
}
