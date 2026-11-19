/** The research-gating probe's bookkeeping, fed by a real headless game exactly as playBotMatch feeds it. */
import { describe, expect, it } from 'vitest';
import { createGame, isProducedUnit, TICK_RATE, UPGRADE_IDS, UPGRADES, type AgentCommandGame, type AgentCommandIntent, type Plane, type ProducedUnit } from '@agent-command/game';
import { beneficiariesOf, ResearchGatingTracker, snapshot, summarize, type MatchReport } from '../src/research-gating.ts';

/** An upgrade with a Spire-produced unit beneficiary that nw neither owns nor queues at the start. */
function setup(seed: number) {
  const game = createGame({ seed, options: {} });
  const team = game.sim.armies[0]!;
  team.alloy = 10_000;
  team.energy = 10_000;
  for (const id of UPGRADE_IDS) {
    const b = beneficiariesOf(id);
    const unit = b.kinds.find((k): k is ProducedUnit => isProducedUnit(k));
    const start = snapshot(game.sim, 'nw', b);
    if (unit && start.owned + start.queued === 0) return { game, id, unit };
  }
  throw new Error('no upgrade with an unowned unit beneficiary');
}

/** One decision round at the current tick, then step: the playBotMatch order. */
function decide(game: AgentCommandGame, tracker: ResearchGatingTracker, intents: AgentCommandIntent[], role: Plane) {
  const seat = { team: 'nw' as const, role };
  for (const intent of intents) {
    const result = game.apply(seat, intent, { source: 'bot' });
    expect(result.ok).toBe(true);
    tracker.intent(game, seat, intent, result);
  }
  game.step();
  tracker.tick(game);
}

function match(game: AgentCommandGame, tracker: ResearchGatingTracker): MatchReport {
  return { level: 'standard', seed: game.sim.seed, seconds: game.tick / TICK_RATE, outcome: { nw: game.outcome('nw'), se: game.outcome('se') }, records: tracker.finish(game) };
}

const run = { seeds: [1], levels: ['standard' as const], seconds: 1, options: {} };

describe('research gating probe', () => {
  it('flags research without beneficiaries as a zero-beneficiary request and an unused completion', () => {
    const { game, id } = setup(11);
    const tracker = new ResearchGatingTracker();
    decide(game, tracker, [{ kind: 'research', upgrade: id }], UPGRADES[id].at);
    for (let i = 0; i < 120 * TICK_RATE && !game.sim.armies[0]!.research.has(id); i++) {
      game.step();
      tracker.tick(game);
    }
    for (let i = 0; i < 5 * TICK_RATE; i++) {
      game.step();
      tracker.tick(game);
    }
    const report = summarize(run, [match(game, tracker)]);
    const [record] = report.matches[0]!.records;
    expect(record).toMatchObject({ army: 'nw', upgrade: id, status: 'completed', zeroBeneficiaries: true, unused: true, firstOwnedAt: null });
    expect(record!.horizonSeconds).toBeGreaterThanOrEqual(5);
    expect(report.verdict).toBe('fail');
    expect(report.failures).toHaveLength(2);
    expect(report.totals).toMatchObject({ requests: 1, completed: 1, unused: 1, zeroBeneficiaryRequests: 1 });
  });

  it('counts a beneficiary queued later in the same decision, and its ownership after completion', () => {
    const { game, id, unit } = setup(12);
    const tracker = new ResearchGatingTracker();
    decide(game, tracker, [{ kind: 'research', upgrade: id }, { kind: 'queue_add', item: unit }], UPGRADES[id].at);
    for (let i = 0; i < 180 * TICK_RATE && !(tracker.records[0]!.status === 'completed' && tracker.records[0]!.firstOwnedAt !== null); i++) {
      game.step();
      tracker.tick(game);
    }
    const report = summarize(run, [match(game, tracker)]);
    const [record] = report.matches[0]!.records;
    expect(record!.atRequest).toMatchObject({ owned: 0, queued: 0 });
    expect(record!.afterDecision!.owned + record!.afterDecision!.queued).toBe(1);
    expect(record).toMatchObject({ status: 'completed', zeroBeneficiaries: false, unused: false, peakOwned: 1 });
    expect(record!.firstOwnedAt).toBeGreaterThanOrEqual(record!.endedAt!);
    expect(report.verdict).toBe('pass');
  });

  it('reports a run without completed research as vacuous, not a pass', () => {
    const game = createGame({ seed: 13, options: {} });
    const tracker = new ResearchGatingTracker();
    game.step();
    tracker.tick(game);
    const report = summarize(run, [match(game, tracker)]);
    expect(report.verdict).toBe('vacuous');
    expect(report.totals.completed).toBe(0);
  });
});
