/**
 * The built-in Depths bot orders only what the game accepts. Its exploration route was kept while its goal stayed
 * unknown even after a cell on it was revealed as bedrock: the bot tagged that cell again every decision (the game
 * drops designations on known bedrock), took the tag as its own and sent every free digger to dig it, and each dig was
 * refused as invalid_target. Its highway rail went to a centre cell not yet dug open (or bedrock) and its breach squads
 * dug up under known Surface structures (occupied). A seeded standard vs novice duel on twin_fords, where all three
 * happened, keeps every Depths seat's refused share under a small bound.
 */
import { describe, expect, it } from 'vitest';
import { playBotMatch } from '../src/bots/play.ts';
import { toTicks } from '../src/rules/contract.ts';

/** Most of a Depths seat's intents the game may refuse (a fight can still invalidate an order between decisions). */
const MAX_REFUSED = 0.01;

describe('built-in Depths bot orders', () => {
  it('standard vs novice on twin_fords: the game accepts the Depths seats\' orders', { timeout: 120_000 }, () => {
    const sent: Record<string, number> = {};
    const refused: Record<string, Record<string, number>> = {};
    playBotMatch({
      seed: 1, levels: { nw: 'standard', se: 'novice' }, options: { map: { name: 'twin_fords' } }, maxTicks: toTicks(900),
      onIntent(_game, seat, intent, result) {
        if (seat.role !== 'depths') return;
        sent[seat.team] = (sent[seat.team] ?? 0) + 1;
        if (result.ok) return;
        const why = (refused[seat.team] ??= {});
        why[`${intent.kind} ${result.code}`] = (why[`${intent.kind} ${result.code}`] ?? 0) + 1;
      },
    });
    for (const team of ['nw', 'se']) {
      const count = Object.values(refused[team] ?? {}).reduce((a, b) => a + b, 0);
      expect(sent[team], `${team} sent Depths orders`).toBeGreaterThan(0);
      expect(count / sent[team]!, `${team} refused ${JSON.stringify(refused[team] ?? {})} of ${sent[team]}`).toBeLessThan(MAX_REFUSED);
    }
  });
});
