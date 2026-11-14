/** Sweep result file (JSON) and its markdown report. */
import { CROSS, DAMAGE_ORIGINS, PLANES, SAPPER_FIELDS, type Plane, type SapperMetrics } from '@agent-command/game';
import { GUARDRAILS, probeMax, type GuardrailResult } from './guardrails.ts';
import { LENGTH_EDGES, MIX_SHARE, type MatchSummary, type ProbeHealth, type SegmentDamage, type SetStats, type SlotAverages } from './metrics.ts';
import { PROBES } from './probes.ts';
import { LAYOUT_ARMIES } from './spec.ts';
import type { Interval } from './stats.ts';

export interface SweepResult {
  label: string;
  node: string;
  workers: number;
  wallMs: number;
  plan: {
    layout: string; seeds: number; probeSeeds: number; probeLevels: string[]; mirrorLevels?: string[]; probes: string[];
    terrains?: string[]; sizes?: number[];
  };
  sets: SetStats[];
  guardrails: GuardrailResult[];
  matches: ArchivedMatch[];
}

/** A match summary as stored: entrants and options live on its run set, zero counts are dropped. */
export type ArchivedMatch = Omit<MatchSummary, 'options'>;

export function archive({ options: _options, ...m }: MatchSummary): ArchivedMatch {
  return { ...m, cross: Object.fromEntries(Object.entries(m.cross).filter(([, v]) => v > 0)) };
}

/** One line per run set and per match: diffable, greppable, and a fraction of pretty-printed size. */
export function toJson(r: SweepResult): string {
  const { sets, guardrails, matches, ...head } = r;
  const lines = (xs: readonly unknown[]): string => xs.map((x) => `    ${JSON.stringify(x)}`).join(',\n');
  const body = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${body},\n  "sets": [\n${lines(sets)}\n  ],\n  "guardrails": [\n${lines(guardrails)}\n  ],\n  "matches": [\n${lines(matches)}\n  ]\n}\n`;
}

const pct = (v: number): string => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–');
const ci = (i: Interval): string => `${pct(i.p)} [${pct(i.lo)}–${pct(i.hi)}]`;
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '–');
const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;
const table = (head: readonly string[], rows: readonly (readonly (string | number)[])[]): string =>
  [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const sum = (r: Record<Plane, number>): number => PLANES.reduce((a, p) => a + r[p], 0);
const bucketLabel = (i: number): string => (i === LENGTH_EDGES.length - 1 ? `${LENGTH_EDGES[i]}+` : `${LENGTH_EDGES[i]}–${LENGTH_EDGES[i + 1]}`);
/** A probe ceiling to one decimal (32.5% in four-army FFA). */
const ceiling = (s: SetStats): string => `${Math.round(probeMax(s.layout) * 1000) / 10}%`;
/** `nw 3 · se 1`: one count per layout slot. */
const perSlot = (s: SetStats, cell: (slot: number) => string | number): string => s.slots.map((army, i) => `${army} ${cell(i)}`).join(' · ');
/** Entrant 0's record per layout slot. */
const aBySlot = (s: SetStats): string => perSlot(s, (i) => `${s.aBySlot[i]!.wins}/${s.aBySlot[i]!.n}`);

/** Sandbox errors and timeouts, then rejected of emitted intents with the two most common codes. */
function probeHealth(h: ProbeHealth): string {
  const top = Object.entries(h.codes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([code, n]) => `${code.replace(/^game:/, '')} ${n}`);
  return `${h.errors + h.timeouts} / ${h.rejected} of ${h.intents}${top.length ? ` (${top.join(', ')})` : ''}`;
}

/**
 * Payload causes reported beside the plane-of-origin split. `core_drop` (the derelict core dropped as a bomb)
 * stays its own cause, so the asteroid impact share that decides `spire.impactMultiplier` is never confounded.
 */
const DROP_CAUSES = ['impact', 'core_drop'] as const;
const share = (part: number, whole: number): string => (whole > 0 ? pct(part / whole) : '–');
/** Spire HP lost by every segment together, by plane of origin. */
function pooledFrom(s: SetStats): Record<string, number> {
  return Object.fromEntries(DAMAGE_ORIGINS.map((o) => [o, PLANES.reduce((a, p) => a + s.spireDamage[p].from[o], 0)]));
}
const pooledTotal = (s: SetStats): number => PLANES.reduce((a, p) => a + s.spireDamage[p].total, 0);
/** Entrant rows of the sapper table: a mirror pools its equal entrants; otherwise the tested entrant, then the rest. */
function sapperRows(s: SetStats): [string, SapperMetrics][] {
  const sum = (rows: readonly SapperMetrics[]): SapperMetrics => {
    const out = {} as SapperMetrics;
    for (const field of SAPPER_FIELDS) out[field] = rows.reduce((a, r) => a + r[field], 0);
    return out;
  };
  if (s.kind === 'mirror') return [['all armies', sum(s.sappers)]];
  const head = s.entrants[0]!;
  return [[head.probe ?? head.level, s.sappers[0]!], [s.kind === 'probe' ? 'its opponents' : s.entrants[1]!.level, sum(s.sappers.slice(1))]];
}
const sapperActive = (m: SapperMetrics): boolean => m.ordered + m.noTunnel + m.rejected + m.planted > 0;
const causes = (d: SegmentDamage): string =>
  Object.entries(d.by).slice(0, 3).map(([cause, hp]) => `${cause} ${share(hp, d.total)}`).join(', ') || '–';

function findings(r: SweepResult): string[] {
  const out: string[] = [];
  const mirrors = r.sets.filter((s) => s.kind === 'mirror');
  for (const s of mirrors) {
    const biased = r.guardrails.find((g) => g.id === 'slot_bias' && g.set === s.key && !g.pass);
    out.push(
      biased
        ? `**Slot bias in the ${s.title}:** ${perSlot(s, (i) => s.slotWins[i]!)} (shares of decisive matches ${perSlot(s, (i) => ci(s.bias.shares[i]!))}, p = ${s.bias.p.toFixed(3)}).`
        : `No detectable slot bias in the ${s.title} (${perSlot(s, (i) => s.slotWins[i]!)}, ${s.draws} draws, p = ${s.bias.p.toFixed(2)}).`,
    );
  }
  const pacing = mirrors.map((s) => `${s.title} ${f1(s.length.median)} min${s.capped ? ` (${s.capped}/${s.n} went the distance)` : ''}`);
  const banded = mirrors.filter((s) => GUARDRAILS.lengthLevels[s.layout].includes(s.entrants[0]!.level));
  const off = banded.filter((s) => {
    const [lo, hi] = GUARDRAILS.lengthBand[s.layout];
    return s.length.median < lo || s.length.median > hi;
  });
  const bands = [...new Set(banded.map((s) => s.layout))].map((layout) => `${GUARDRAILS.lengthBand[layout].join('–')} min (${layout})`).join(', ');
  if (mirrors.length > 0) {
    out.push(`Median mirror length: ${pacing.join(', ')}.${off.length ? ` Outside the length band (${bands}): ${off.map((s) => s.title).join(', ')}.` : banded.length ? ` Banded mirrors are inside ${bands}.` : ''}`);
  }
  for (const s of r.sets.filter((x) => x.kind === 'ladder')) out.push(`${s.title}: ${s.entrants[0]!.level} wins ${ci(s.aRate)} (${s.draws} draws).`);
  for (const s of mirrors) {
    const at3 = s.units['3'];
    if (at3) out.push(`${s.title} at 3:00: ${perSlot(s, (i) => f1(sum(at3.slots[i]!)))} units across the planes (target ~15–30 per army).`);
  }
  for (const s of mirrors) {
    const idle = PLANES.filter((p) => s.firstMinute.active[p] < 0.8);
    out.push(
      idle.length
        ? `Pillar 4 (${s.title}): every army acts on every plane in the first 60 s in ${pct(s.firstMinute.allPlanes)} of matches; quiet: ${idle.map((p) => `${p} (${pct(s.firstMinute.active[p])})`).join(', ')}.`
        : `Pillar 4 (${s.title}): every army acts on every plane in the first 60 s in ${pct(s.firstMinute.allPlanes)} of matches.`,
    );
  }
  for (const s of mirrors) {
    const surface = s.spireDamage.surface;
    if (surface.total > 0) out.push(`Surface Spire damage (${s.title}): ${f1(surface.total)} HP per match; impacts ${share(surface.by['impact'] ?? 0, surface.total)}, core drops ${share(surface.by['core_drop'] ?? 0, surface.total)} (the impact share decides \`spire.impactMultiplier\`).`);
    const from = pooledFrom(s);
    const total = pooledTotal(s);
    if (total > 0) out.push(`Spire damage by plane of origin (${s.title}, every segment): ${DAMAGE_ORIGINS.map((o) => `${o} ${share(from[o]!, total)}`).join(' · ')}.`);
  }
  for (const s of mirrors) {
    const narrow = PLANES.filter((p) => s.mix[p].produced > 0 && s.mix[p].kinds < 2);
    if (narrow.length) out.push(`Unit mix (${s.title}): fewer than two kinds at ≥ ${pct(MIX_SHARE)} of production on ${narrow.map((p) => `${p} (${f1(s.mix[p].entropy)} bits)`).join(', ')}.`);
  }
  const never = CROSS.filter((c) => mirrors.every((s) => (s.cross[c.key]?.mean ?? 0) === 0)).map((c) => c.key);
  if (mirrors.length > 0 && never.length) out.push(`Cross-plane interactions never seen in any mirror: ${never.join(', ')}.`);
  const probes = r.sets.filter((s) => s.kind === 'probe');
  const strong = probes.filter((s) => s.aRate.p > probeMax(s.layout));
  // Non-viable: under 0.4× the uniform share (20% in a duel, 10% in four-army FFA).
  const weak = probes.filter((s) => s.aRate.p < 0.4 / LAYOUT_ARMIES[s.layout]);
  if (strong.length) out.push(`**Probes above their ceiling:** ${strong.map((s) => `${s.title} ${ci(s.aRate)} (ceiling ${ceiling(s)})`).join('; ')}.`);
  else if (probes.length) out.push(`No strategy probe exceeds its ceiling (${[...new Set(probes.map((s) => `${ceiling(s)} ${s.layout}`))].join(', ')}).`);
  if (weak.length) out.push(`Non-viable forced strategies (< 0.4× the uniform share): ${weak.map((s) => `${s.title} ${pct(s.aRate.p)}`).join('; ')}.`);
  return out;
}

function unitsTable(s: SetStats, units: Record<string, SlotAverages>): string {
  const rows = Object.keys(units)
    .sort((a, b) => Number(a) - Number(b))
    .flatMap((m) => {
      const u = units[m]!;
      return s.slots.map((army, i) => [`${m}:00 ${army}`, ...PLANES.map((p) => f1(u.slots[i]![p])), f1(sum(u.slots[i]!)), u.n]);
    });
  return table(['minute / army', ...PLANES, 'total', 'matches'], rows);
}

export function toMarkdown(r: SweepResult): string {
  const mirrors = r.sets.filter((s) => s.kind === 'mirror');
  const ladder = r.sets.filter((s) => s.kind === 'ladder');
  const probes = r.sets.filter((s) => s.kind === 'probe');
  const failed = r.guardrails.filter((g) => !g.pass);
  const out: string[] = [];
  out.push(`# Balance sweep: ${r.label}`);
  out.push('');
  out.push(
    `${r.plan.layout} · ${r.matches.length} matches (${r.plan.seeds ? `${r.plan.seeds} seeds per mirror and ladder orientation, ` : 'probes only, '}${r.plan.probeSeeds} per probe orientation)` +
      `${r.plan.terrains ? ` · terrain ${r.plan.terrains.join(', ')}` : ' · default terrain'}${r.plan.sizes ? ` · size ${r.plan.sizes.join(', ')}` : ''} · ${r.workers} workers · ${f1(r.wallMs / 60000)} min wall · Node ${r.node}.`,
  );
  out.push('');
  out.push('Generated by `node tools/balance/src/main.ts sweep`; metric definitions in [README](README.md). Data: the JSON next to this file.');
  out.push('');
  out.push('## Findings');
  out.push('');
  for (const f of findings(r)) out.push(`- ${f}`);
  out.push('');
  out.push(`## Guardrails (DESIGN §11.5, §15.13): ${failed.length ? `${failed.length} of ${r.guardrails.length} failing` : `all ${r.guardrails.length} pass`}`);
  out.push('');
  out.push(table(['guardrail', 'run set', 'value', 'target', ''], r.guardrails.map((g) => [g.id, g.set, g.value, g.target, g.pass ? 'pass' : '**FAIL**'])));
  out.push('');

  // Reference sets (mirrors and ladder) are absent from probe-only sweeps (`--seeds 0`).
  if (mirrors.length > 0) {
    out.push('## Slot bias (mirrors)');
    out.push('');
    out.push('Decisive wins per slot, each slot\'s share of decisive matches with a 95% Wilson interval, and the goodness-of-fit p against equal shares (two slots: the exact two-sided binomial test at 50%; more: the exact multinomial test).');
    out.push('');
    out.push(
      table(
        ['mirror', 'matches', 'wins per slot', 'draws', 'shares', 'p', 'verdict'],
        mirrors.map((s) => [s.title, s.n, perSlot(s, (i) => s.slotWins[i]!), s.draws, perSlot(s, (i) => ci(s.bias.shares[i]!)), s.bias.p.toFixed(3),
          r.guardrails.some((g) => g.id === 'slot_bias' && g.set === s.key && !g.pass) ? '**biased**' : 'within noise']),
      ),
    );
    out.push('');

    if (ladder.length) {
      out.push('## Tier ladder');
      out.push('');
      out.push('Each seed played in both orientations; draws are not wins.');
      out.push('');
      out.push(
        table(
          ['matchup', 'matches', 'first wins', 'first by slot', 'draws', 'median min'],
          ladder.map((s) => [s.title, s.n, ci(s.aRate), aBySlot(s), s.draws, f1(s.length.median)]),
        ),
      );
      out.push('');
    }

    out.push('## Match length (minutes)');
    out.push('');
    out.push(
      table(
        ['run set', 'median', 'p10', 'p25', 'p75', 'p90', 'min', 'max', ...LENGTH_EDGES.map((_, i) => bucketLabel(i))],
        [...mirrors, ...ladder].map((s) => [s.title, f1(s.length.median), f1(s.length.p10), f1(s.length.p25), f1(s.length.p75), f1(s.length.p90), f1(s.length.min), f1(s.length.max), ...s.length.hist]),
      ),
    );
    out.push('');
    out.push(`The last bucket is the 30 min time cap (decided on total Spire HP).`);
    out.push('');

    out.push('## Units per plane (mirrors)');
    out.push('');
    out.push('Mean units alive per army at each minute, over the matches still running then.');
    for (const s of mirrors) {
      out.push('');
      out.push(`### ${s.title}`);
      out.push('');
      out.push(unitsTable(s, s.units));
    }
    out.push('');

    out.push('## Pillar 4: meaningful actions in the first 60 s');
    out.push('');
    out.push(
      'Mean actions per army and plane. Depths: ore deliveries, charges planted/defused, tunnels broken into, breaches, chasms. Surface/any plane: structures completed, portal transfers. ' +
        'Sky: island captures, interceptions. Orbit: grapples, deorbits, scans. Every plane: kills there (a fight). "All active" = share of matches in which every army acts on that plane.',
    );
    out.push('');
    out.push(
      table(
        ['mirror', ...PLANES.map((p) => `${p} per army`), ...PLANES.map((p) => `${p} all active`), 'all planes'],
        mirrors.map((s) => [s.title, ...PLANES.map((p) => perSlot(s, (i) => f1(s.firstMinute.slots[i]![p]))), ...PLANES.map((p) => pct(s.firstMinute.active[p])), pct(s.firstMinute.allPlanes)]),
      ),
    );
    out.push('');

    out.push('## Cross-plane interactions per match');
    out.push('');
    out.push('Mean per match (share of matches with at least one). Kills use the authoritative final damage source, including the owner of payloads and other area effects.');
    out.push('');
    // Several presets make the table too wide for the ladder columns: mirrors carry the comparison.
    const crossSets = (r.plan.terrains?.length ?? 0) > 1 ? mirrors : [...mirrors, ...ladder];
    out.push(
      table(
        ['interaction', ...crossSets.map((s) => s.title)],
        // Sweeps recorded before an interaction was counted have no entry for it: shown as –.
        CROSS.map((c) => [
          c.label,
          ...crossSets.map((s) => {
            const x = s.cross[c.key];
            return x ? `${f1(x.mean)} (${pct(x.share)})` : '–';
          }),
        ]),
      ),
    );
    out.push('');

    out.push('## Production and kill shares (mirrors)');
    out.push('');
    const kinds = (pick: (s: SetStats) => Record<string, number>): string[] => [...new Set(mirrors.flatMap((s) => Object.keys(pick(s))))];
    out.push(table(['unit produced', ...mirrors.map((s) => s.title)], kinds((s) => s.produced).map((k) => [k, ...mirrors.map((s) => pct(s.produced[k] ?? 0))])));
    out.push('');
    out.push(
      table(
        ['killed by', ...mirrors.map((s) => s.title)],
        [...kinds((s) => s.kills).map((k) => [k, ...mirrors.map((s) => pct(s.kills[k] ?? 0))]),
          ...kinds((s) => s.environmental).map((k) => [`${k} (environment/friendly)`, ...mirrors.map((s) => pct(s.environmental[k] ?? 0))]),
          ['*(unattributed deaths)*', ...mirrors.map((s) => pct(s.unattributed))]],
      ),
    );
    out.push('Shares use all deaths as the denominator. Environment/friendly rows have a named source but no hostile killer.');
    out.push('');
    out.push('### Unit mix per plane');
    out.push('');
    out.push(`Production by kind on each plane, all armies pooled: units per match, the Shannon entropy of the kind shares in bits (0 = one kind; log₂ k for k equal kinds), and the kinds at ≥ ${pct(MIX_SHARE)} of that plane's production.`);
    out.push('');
    out.push(
      table(
        ['mirror', ...PLANES.map((p) => `${p} units`), ...PLANES.map((p) => `${p} bits (kinds)`)],
        mirrors.map((s) => [s.title, ...PLANES.map((p) => f1(s.mix[p].produced)), ...PLANES.map((p) => `${f1(s.mix[p].entropy)} (${s.mix[p].kinds})`)]),
      ),
    );
    out.push('');
    out.push('### Structure edge (correlational)');
    out.push('');
    out.push('Matches in which one army completed more of a structure than every other, and the share of those that army won. Winners also build more, so this flags candidates for a forced probe; it is not a guardrail.');
    out.push('');
    const structures = [...new Set(mirrors.flatMap((s) => Object.keys(s.structureEdge)))];
    out.push(
      table(
        ['structure', ...mirrors.map((s) => s.title)],
        structures.map((k) => [k, ...mirrors.map((s) => (s.structureEdge[k]?.n ? `${pct(s.structureEdge[k].wins / s.structureEdge[k].n)} of ${s.structureEdge[k].n}` : '–'))]),
      ),
    );
    out.push('');
  }

  if (probes.length) {
    out.push('## Strategy probes');
    out.push('');
    out.push(
      `Forced-strategy JS policies (PlayerThree sandbox) on the listed seats, built-in bots of the same level on the rest, against that level; every seed in every rotation (the probe plays each slot once). Guardrail: ≤ ${GUARDRAILS.probeShare}× the uniform share (${[...new Set(probes.map((s) => `${ceiling(s)} ${s.layout}`))].join(', ')}).`,
    );
    out.push('');
    out.push(
      table(
        ['probe vs level', 'seats', 'strategy', 'matches', 'probe wins', 'by slot', 'mean place', 'draws', 'median min', 'policy errors / rejected intents'],
        probes.map((s) => {
          const p = PROBES.find((x) => x.id === s.entrants[0]!.probe);
          return [
            s.title,
            p ? Object.keys(p.seats).join(', ') : '',
            p?.strategy ?? '',
            s.n,
            ci(s.aRate),
            aBySlot(s),
            f1(s.aPlacement),
            s.draws,
            f1(s.length.median),
            s.probe ? probeHealth(s.probe) : '–',
          ];
        }),
      ),
    );
    out.push('');
  }

  const damaged = r.sets.filter((s) => pooledTotal(s) > 0);
  if (damaged.length) {
    out.push('## Spire damage by segment');
    out.push('');
    out.push(
      'Spire HP actually lost (overkill excluded) per match, all armies pooled: the share by the plane the damage came from (`none`: storms, floods, scorch and other sources without one), ' +
        `the payload causes ${DROP_CAUSES.map((c) => `\`${c}\``).join(' and ')} on their own, and the three largest causes.`,
    );
    out.push('');
    out.push(
      table(
        ['run set', 'segment', 'HP per match', ...DAMAGE_ORIGINS.map((o) => `from ${o}`), ...DROP_CAUSES, 'top causes'],
        damaged.flatMap((s) => PLANES.filter((p) => s.spireDamage[p].total > 0).map((p) => {
          const d = s.spireDamage[p];
          return [s.title, p, f1(d.total), ...DAMAGE_ORIGINS.map((o) => share(d.from[o], d.total)), ...DROP_CAUSES.map((c) => share(d.by[c] ?? 0, d.total)), causes(d)];
        })),
      ),
    );
    out.push('');
  }

  const sapperSets = r.sets.flatMap((s) => sapperRows(s).filter(([, m]) => sapperActive(m)).map(([who, m]) => [s, who, m] as const));
  if (sapperSets.length) {
    out.push('## Sappers and chasms');
    out.push('');
    out.push(
      'Per match: undermine intents accepted, rejected for want of a tunnel (the cell is no known tunnel or none reaches it) and otherwise; charges planted, defused, gone off without damaging a hostile structure (dud) and with (hit), and the HP they took. ' +
        'Chasm attempts are undermine intents on an unopened fault cell, accepted / rejected.',
    );
    out.push('');
    out.push(
      table(
        ['run set', 'armies', 'undermine ok', 'no tunnel', 'other rejected', 'planted', 'defused', 'dud', 'hit', 'HP', 'chasm attempts'],
        sapperSets.map(([s, who, m]) => [s.title, who, f1(m.ordered), f1(m.noTunnel), f1(m.rejected), f1(m.planted), f1(m.defused), f1(m.dud), f1(m.hit), f1(m.damage), `${f1(m.chasmOrdered)} / ${f1(m.chasmRejected)}`]),
      ),
    );
    out.push('');
  }

  out.push('## Runtime');
  out.push('');
  out.push(
    table(
      ['run set', 'matches', 'mean s per match', 'CPU min'],
      r.sets.map((s) => [s.title, s.n, f1(s.wallMs.mean / 1000), f1(s.wallMs.total / 60000)]),
    ),
  );
  out.push('');
  return out.join('\n');
}
