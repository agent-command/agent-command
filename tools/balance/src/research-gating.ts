#!/usr/bin/env node
/**
 * Research gating probe: does a built-in bot only research upgrades its own composition uses?
 *
 * Usage (from the checkout root):
 *   node tools/balance/src/research-gating.ts [--seeds 1,2,3] [--levels standard,veteran] [--seconds 720] [--terrain open] [--out report.json]
 * or `pnpm --filter @agent-command/balance research:gating --seeds 1 …` (runs in tools/balance; `--out` is relative to it).
 * Every (level, seed) pair plays one same-level bot mirror with the default match rules (plus `--terrain` when given),
 * capped at `--seconds` of game time.
 *
 * Beneficiaries come from the upgrade registry (grant_ability `units`, kind-selected modifiers), never upgrade
 * identities; segment-scoped upgrades only count beneficiaries on their own plane, as the sim applies them. Per accepted
 * research request (`research`, or `queue_add` of an upgrade) the probe records owned and queued beneficiaries of the
 * requesting army (all seats, all planes): when the intent was applied, and once the whole decision round had been
 * applied (`afterDecision`: the same decision's later production intents count). Owned = alive, finished entities; a
 * queue entry counts as queued until it leaves the queue (a started structure's site is not counted again). Per
 * completion it records the beneficiaries at completion, the first second with an owned beneficiary at or after it,
 * the seconds with one, and the peak count until the match ended or hit the cap.
 *
 * Machine-readable JSON report on stdout (or `--out`); progress on stderr. Exit codes:
 *   0 pass: research completed and every completion had an owned beneficiary at or after completion, and no accepted
 *     request had zero owned+queued beneficiaries after its decision round;
 *   1 fail: `failures` lists every unused completion and zero-beneficiary request;
 *   2 vacuous: no research completed in any match, so nothing was verified (`verdict: "vacuous"`).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  isUpgrade,
  OPPONENTS,
  playBotMatch,
  TERRAIN_PRESETS,
  TICK_RATE,
  UPGRADE_IDS,
  UPGRADES,
  upgradeBeneficiaries,
  type AgentCommandGame,
  type AgentCommandIntent,
  type AgentCommandSeat,
  type ArmyId,
  type BotMatchResult,
  type Kind,
  type MatchOptions,
  type Opponent,
  type Plane,
  type TerrainPreset,
  type UpgradeId,
} from '@agent-command/game';
import { layoutArmies } from './spec.ts';
import { quantile } from './stats.ts';

type Sim = AgentCommandGame['sim'];

export interface Beneficiaries {
  kinds: readonly Kind[];
  /** segment-scoped upgrades only affect entities on their plane; null: team-wide */
  plane: Plane | null;
}

/** Kinds an upgrade's effects apply to, from the registry alone. Upgrades without kind-level effects cannot be probed. */
export function beneficiariesOf(id: UpgradeId): Beneficiaries {
  const upgrade = UPGRADES[id];
  const kinds = upgradeBeneficiaries(id);
  if (kinds.length === 0) throw new Error(`research-gating: ${id} has no kind-level beneficiaries; extend upgradeBeneficiaries for its effects`);
  return { kinds, plane: upgrade.scope === 'segment' ? upgrade.at : null };
}

export interface Snapshot {
  owned: number;
  queued: number;
  byKind: Partial<Record<Kind, { owned: number; queued: number }>>;
}

/** Owned (alive, finished) and queued beneficiaries of `army`, read from the authoritative sim. */
export function snapshot(sim: Sim, army: ArmyId, b: Beneficiaries): Snapshot {
  const index = sim.armyIndex(army);
  const byKind: Snapshot['byKind'] = {};
  for (const kind of b.kinds) byKind[kind] = { owned: 0, queued: 0 };
  let owned = 0;
  let queued = 0;
  for (const e of sim.ents) {
    if (e.side !== index || e.dead || e.hp <= 0 || !e.built || (b.plane !== null && e.plane !== b.plane)) continue;
    const row = byKind[e.kind];
    if (!row) continue;
    row.owned++;
    owned++;
  }
  for (const entry of sim.armies[index]!.queue) {
    if (b.plane !== null && entry.plane !== b.plane) continue;
    const row = byKind[entry.item as Kind];
    if (!row) continue;
    row.queued++;
    queued++;
  }
  return { owned, queued, byKind };
}

export interface ResearchRecord {
  army: ArmyId;
  upgrade: UpgradeId;
  /** requesting seat; null: completed without an observed request */
  seat: Plane | null;
  /** game seconds */
  requestedAt: number | null;
  /** when the intent was applied (earlier intents of the same decision round already applied) */
  atRequest: Snapshot | null;
  /** after every seat's intents of that decision round were applied and the tick stepped */
  afterDecision: Snapshot | null;
  status: 'pending' | 'completed' | 'cancelled';
  /** game seconds the research completed or left the queue unfinished */
  endedAt: number | null;
  atCompletion: Snapshot | null;
  /** first game second at or after completion with an owned beneficiary */
  firstOwnedAt: number | null;
  /** post-completion game seconds with at least one owned beneficiary */
  ownedSeconds: number;
  /** most owned beneficiaries at once, at or after completion */
  peakOwned: number;
  /** observed game seconds from completion to the end of the match (or cap) */
  horizonSeconds: number | null;
  /** completed, and no owned beneficiary at any observed tick at or after completion */
  unused: boolean;
  /** accepted with zero owned and queued beneficiaries after its decision round */
  zeroBeneficiaries: boolean;
}

/** Feed with playBotMatch's `onIntent` / `onTick`, then `finish` once the match stops. */
export class ResearchGatingTracker {
  readonly records: ResearchRecord[] = [];
  private readonly beneficiaries = Object.fromEntries(UPGRADE_IDS.map((id) => [id, beneficiariesOf(id)])) as Record<UpgradeId, Beneficiaries>;
  private readonly awaitingDecision: ResearchRecord[] = [];
  private readonly completed = new Map<ArmyId, Set<UpgradeId>>();
  private readonly ownedTicks = new Map<ResearchRecord, number>();

  intent(game: AgentCommandGame, seat: AgentCommandSeat, intent: AgentCommandIntent, result: { ok: boolean }): void {
    if (!result.ok) return;
    const upgrade = intent.kind === 'research' ? intent.upgrade : intent.kind === 'queue_add' && isUpgrade(intent.item) ? intent.item : null;
    if (upgrade === null) return;
    const record: ResearchRecord = {
      army: seat.team,
      upgrade,
      seat: seat.role,
      requestedAt: game.tick / TICK_RATE,
      atRequest: snapshot(game.sim, seat.team, this.beneficiaries[upgrade]),
      afterDecision: null,
      status: 'pending',
      endedAt: null,
      atCompletion: null,
      firstOwnedAt: null,
      ownedSeconds: 0,
      peakOwned: 0,
      horizonSeconds: null,
      unused: false,
      zeroBeneficiaries: false,
    };
    this.records.push(record);
    this.awaitingDecision.push(record);
  }

  tick(game: AgentCommandGame): void {
    const sim = game.sim;
    const now = sim.tick / TICK_RATE;
    for (const record of this.awaitingDecision) {
      const s = snapshot(sim, record.army, this.beneficiaries[record.upgrade]);
      record.afterDecision = s;
      record.zeroBeneficiaries = s.owned + s.queued === 0;
    }
    this.awaitingDecision.length = 0;
    for (const [index, army] of sim.armyIds.entries()) {
      const research = sim.armies[index]!.research;
      let known = this.completed.get(army);
      if (!known) this.completed.set(army, (known = new Set()));
      if (research.size === known.size) continue;
      for (const id of research) {
        if (known.has(id)) continue;
        known.add(id);
        this.complete(sim, army, id, now);
      }
    }
    for (const record of this.records) {
      if (record.status === 'pending') {
        const t = sim.armies[sim.armyIndex(record.army)]!;
        if (!t.research.has(record.upgrade) && !t.queue.some((entry) => entry.item === record.upgrade)) {
          record.status = 'cancelled';
          record.endedAt = now;
        }
        continue;
      }
      if (record.status !== 'completed') continue;
      const owned = snapshot(sim, record.army, this.beneficiaries[record.upgrade]).owned;
      if (owned === 0) continue;
      record.firstOwnedAt ??= now;
      record.peakOwned = Math.max(record.peakOwned, owned);
      this.ownedTicks.set(record, (this.ownedTicks.get(record) ?? 0) + 1);
    }
  }

  /** Closes the observation horizon; returns every record. */
  finish(game: AgentCommandGame): ResearchRecord[] {
    const end = game.tick / TICK_RATE;
    for (const record of this.records) {
      if (record.status !== 'completed') continue;
      record.horizonSeconds = end - record.endedAt!;
      record.ownedSeconds = (this.ownedTicks.get(record) ?? 0) / TICK_RATE;
      record.unused = record.firstOwnedAt === null;
    }
    return this.records;
  }

  private complete(sim: Sim, army: ArmyId, upgrade: UpgradeId, now: number): void {
    let record = this.records.findLast((r) => r.army === army && r.upgrade === upgrade && r.status === 'pending');
    if (!record) {
      record = {
        army, upgrade, seat: null, requestedAt: null, atRequest: null, afterDecision: null, status: 'pending', endedAt: null, atCompletion: null,
        firstOwnedAt: null, ownedSeconds: 0, peakOwned: 0, horizonSeconds: null, unused: false, zeroBeneficiaries: false,
      };
      this.records.push(record);
    }
    record.status = 'completed';
    record.endedAt = now;
    record.atCompletion = snapshot(sim, army, this.beneficiaries[upgrade]);
  }
}

export interface MatchReport {
  level: Opponent;
  seed: number;
  /** game seconds played */
  seconds: number;
  outcome: BotMatchResult['outcome'];
  records: ResearchRecord[];
}

/** One same-level bot duel mirror with the tracker attached to playBotMatch's metrics callbacks. */
export function runMatch(level: Opponent, seed: number, seconds: number, options: MatchOptions = {}): MatchReport {
  const tracker = new ResearchGatingTracker();
  const result = playBotMatch({
    seed,
    levels: Object.fromEntries(layoutArmies('duel').map((army) => [army, level])),
    options,
    maxTicks: Math.round(seconds * TICK_RATE),
    onIntent: (game, seat, intent, applied) => tracker.intent(game, seat, intent, applied),
    onTick: (game) => tracker.tick(game),
  });
  return { level, seed, seconds: result.ticks / TICK_RATE, outcome: result.outcome, records: tracker.finish(result.game) };
}

export interface UpgradeSummary {
  requests: number;
  completed: number;
  completedBy: Partial<Record<ArmyId, number>>;
  cancelled: number;
  pending: number;
  /** completions without an observed accepted request */
  untracked: number;
  unused: number;
  zeroBeneficiaryRequests: number;
  medianRequestedAt: number | null;
  medianCompletedAt: number | null;
  /** completion → first owned beneficiary (0: owned at completion) */
  medianFirstOwnedDelay: number | null;
}

export interface GatingReport {
  probe: 'research-gating';
  run: { seeds: number[]; levels: Opponent[]; seconds: number; options: MatchOptions };
  beneficiaries: Record<UpgradeId, Beneficiaries>;
  verdict: 'pass' | 'fail' | 'vacuous';
  /** human-readable explanation of the verdict */
  note: string;
  failures: string[];
  totals: Omit<UpgradeSummary, 'completedBy' | 'medianRequestedAt' | 'medianCompletedAt' | 'medianFirstOwnedDelay'> & { matches: number };
  /** level → upgrade → summary */
  byUpgrade: Partial<Record<Opponent, Record<UpgradeId, UpgradeSummary>>>;
  matches: MatchReport[];
}

const median = (xs: number[]): number | null => (xs.length ? quantile(xs, 0.5) : null);

export function summarize(run: GatingReport['run'], matches: MatchReport[]): GatingReport {
  const totals: GatingReport['totals'] = { matches: matches.length, requests: 0, completed: 0, cancelled: 0, pending: 0, untracked: 0, unused: 0, zeroBeneficiaryRequests: 0 };
  const failures: string[] = [];
  const byUpgrade: GatingReport['byUpgrade'] = {};
  for (const level of run.levels) {
    const rows = {} as Record<UpgradeId, UpgradeSummary>;
    for (const id of UPGRADE_IDS) {
      const requested: number[] = [];
      const completedAt: number[] = [];
      const delays: number[] = [];
      const row: UpgradeSummary = {
        requests: 0, completed: 0, completedBy: {}, cancelled: 0, pending: 0, untracked: 0, unused: 0, zeroBeneficiaryRequests: 0,
        medianRequestedAt: null, medianCompletedAt: null, medianFirstOwnedDelay: null,
      };
      for (const match of matches) {
        if (match.level !== level) continue;
        for (const r of match.records) {
          if (r.upgrade !== id) continue;
          const where = `${level} seed ${match.seed} ${r.army} ${id}`;
          if (r.requestedAt !== null) {
            row.requests++;
            requested.push(r.requestedAt);
          } else if (r.status === 'completed') row.untracked++;
          if (r.zeroBeneficiaries) {
            row.zeroBeneficiaryRequests++;
            failures.push(`${where}: requested at ${r.requestedAt}s by ${r.seat} with no owned or queued beneficiary`);
          }
          if (r.status === 'cancelled') row.cancelled++;
          if (r.status === 'pending') row.pending++;
          if (r.status !== 'completed') continue;
          row.completed++;
          row.completedBy[r.army] = (row.completedBy[r.army] ?? 0) + 1;
          completedAt.push(r.endedAt!);
          if (r.firstOwnedAt !== null) delays.push(r.firstOwnedAt - r.endedAt!);
          if (r.unused) {
            row.unused++;
            failures.push(`${where}: completed at ${r.endedAt}s, no owned beneficiary for the remaining ${r.horizonSeconds}s`);
          }
        }
      }
      row.medianRequestedAt = median(requested);
      row.medianCompletedAt = median(completedAt);
      row.medianFirstOwnedDelay = median(delays);
      totals.requests += row.requests;
      totals.completed += row.completed;
      totals.cancelled += row.cancelled;
      totals.pending += row.pending;
      totals.untracked += row.untracked;
      totals.unused += row.unused;
      totals.zeroBeneficiaryRequests += row.zeroBeneficiaryRequests;
      rows[id] = row;
    }
    byUpgrade[level] = rows;
  }
  const verdict = failures.length ? 'fail' : totals.completed === 0 ? 'vacuous' : 'pass';
  const note = verdict === 'fail'
    ? `${totals.unused} unused completion(s), ${totals.zeroBeneficiaryRequests} zero-beneficiary request(s)`
    : verdict === 'vacuous'
      ? `no research completed in ${matches.length} match(es) (${totals.requests} request(s)): nothing verified`
      : `${totals.completed} completion(s), each with an owned beneficiary at or after completion`;
  return {
    probe: 'research-gating',
    run,
    beneficiaries: Object.fromEntries(UPGRADE_IDS.map((id) => [id, beneficiariesOf(id)])) as Record<UpgradeId, Beneficiaries>,
    verdict,
    note,
    failures,
    totals,
    byUpgrade,
    matches,
  };
}

function cli(): void {
  const { values } = parseArgs({
    options: {
      seeds: { type: 'string', default: '1,2,3' },
      levels: { type: 'string', default: 'standard,veteran' },
      seconds: { type: 'string', default: '720' },
      terrain: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const seeds = values.seeds.split(',').map(Number);
  if (!seeds.length || !seeds.every((s) => Number.isSafeInteger(s))) throw new Error('--seeds must be comma-separated integers');
  const levels = values.levels.split(',') as Opponent[];
  if (!levels.length || !levels.every((l) => OPPONENTS.includes(l))) throw new Error(`--levels must be comma-separated of ${OPPONENTS.join(', ')}`);
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--seconds must be positive');
  if (values.terrain !== undefined && !(TERRAIN_PRESETS as readonly string[]).includes(values.terrain)) throw new Error(`--terrain must be one of ${TERRAIN_PRESETS.join(', ')}`);
  const options: MatchOptions = values.terrain === undefined ? {} : { terrain: values.terrain as TerrainPreset };
  const matches: MatchReport[] = [];
  for (const level of levels) for (const seed of seeds) {
    const match = runMatch(level, seed, seconds, options);
    const done = match.records.filter((r) => r.status === 'completed');
    process.stderr.write(`${level} seed ${seed}: ${match.seconds}s ${Object.entries(match.outcome).map(([army, outcome]) => `${army} ${outcome}`).join(', ')}; ${match.records.length} research record(s), ${done.length} completed, ${done.filter((r) => r.unused).length} unused\n`);
    matches.push(match);
  }
  const report = summarize({ seeds, levels, seconds, options }, matches);
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.out) writeFileSync(values.out, json);
  else process.stdout.write(json);
  process.stderr.write(`${report.verdict}: ${report.note}\n`);
  for (const failure of report.failures) process.stderr.write(`  ${failure}\n`);
  process.exitCode = report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
