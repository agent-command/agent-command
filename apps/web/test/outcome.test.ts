// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { ARMIES, COLOURS, TICK_RATE, frameOf, type ArmyId, type MatchData, type Report } from '@agent-command/game/contract';
import { outcomeCard, outcomeTable, perspectiveChoice } from '../src/outcome.ts';
import type { MatchView } from '../src/match-view.ts';

const stats = (k: number) => ({
  alloyMined: 1000 + k, energyDelivered: 500 + k, produced: 10 + k, kills: k, unitsLost: 2 * k, structuresLost: k, collapses: 0, impacts: 0,
  interceptions: 0, islandTicks: (30 + k) * TICK_RATE, postsCaptured: k, postTicks: (20 + k) * TICK_RATE, coreCashed: 0, pointTicks: (5 + k) * TICK_RATE, spireDamageDealt: 100 * k,
});
/** A four-army FFA report in army order: se won, nw placed second, sw third, ne went out first; colours by slot. */
function report(ranks: Partial<Record<ArmyId, number>>): Report {
  return {
    outcome: 'loss', rank: ranks.nw, ticks: 6000, timeline: [],
    armies: ARMIES.map((army, k) => ({ army, colour: COLOURS[k]!, rank: ranks[army], stats: stats(k), spire: [] })),
  } as unknown as Report;
}
const rows = (table: HTMLTableElement) => [...table.querySelectorAll('tr')].map((row) => [...row.children].map((cell) => cell.textContent));

describe('after-action outcome table', () => {
  it('lists every army in its colour with its final place, our column marked', () => {
    const table = outcomeTable(report({ se: 1, nw: 2, sw: 3, ne: 4 }), 'nw');
    const [head, place, alloy, , , kills] = rows(table);
    expect(head).toEqual(['', 'You', 'Red', 'Green', 'Violet']);
    expect(place).toEqual(['Place', '2nd', '4th', '1st', '3rd']);
    expect(alloy).toEqual(['Alloy mined', '1,000', '1,001', '1,002', '1,003']);
    expect(kills).toEqual(['Kills', '0', '1', '2', '3']);
    expect(rows(table).find((row) => row[0] === 'Island-seconds held')).toEqual(['Island-seconds held', '30', '31', '32', '33']);
    expect(rows(table).find((row) => row[0] === 'Contested-point seconds')).toEqual(['Contested-point seconds', '5', '6', '7', '8']);
    const headers = [...table.querySelectorAll<HTMLElement>('th[data-army]')];
    expect(headers.map((th) => th.dataset.army)).toEqual([...ARMIES]);
    expect(headers.map((th) => th.hasAttribute('data-own'))).toEqual([true, false, false, false]);
    expect(headers.map((th) => th.getAttribute('style'))).toEqual(COLOURS.map((colour) => `color: var(--army-${colour}-ink);`));
    expect(headers.map((th) => th.dataset.tip)).toEqual(['Blue · Northwest · you', 'Red · Northeast', 'Green · Southeast', 'Violet · Southwest']);
    expect(table.querySelector('[title]')).toBeNull();
  });

  it('shares tied places and leaves an army without a final place blank', () => {
    const [head, place] = rows(outcomeTable(report({ ne: 1, se: 1, nw: 3 }), 'se'));
    expect(head).toEqual(['', 'Blue', 'Red', 'You', 'Violet']);
    expect(place).toEqual(['Place', '3rd', '1st', '1st', '—']);
  });

  it('names a two-army duel by colour (nw blue, se red)', () => {
    const duel = { outcome: 'win', rank: 1, ticks: 100, timeline: [], armies: [
      { army: 'nw', colour: 'blue', rank: 1, stats: stats(0), spire: [] }, { army: 'se', colour: 'red', rank: 2, stats: stats(1), spire: [] },
    ] } as unknown as Report;
    expect(rows(outcomeTable(duel, 'se')).slice(0, 2)).toEqual([['', 'Blue', 'You'], ['Place', '1st', '2nd']]);
  });
});

describe('after-action card', () => {
  it('uses the final report clock and place rather than a stale last view, keeping only recent moments', () => {
    const final = report({ se: 1, nw: 2, sw: 3, ne: 4 });
    final.timeline = Array.from({ length: 14 }, (_, index) => ({
      kind: 'unit_lost', plane: 'surface', tick: (60 + index) * TICK_RATE, subject: 'tank', side: 'nw', count: 1, x: 10, y: 10,
    }));
    const view = { tick: 20, rank: 4, match: { armies: [] } } as unknown as MatchView;
    const card = outcomeCard({ outcome: 'loss', label: 'FFA', report: final, view, army: 'nw', exit() {}, keepLooking() {} });
    expect(card.querySelector('.outcome-meta')?.textContent).toBe('FFA · 2nd of 4 · 5m 0s');
    const timestamps = [...card.querySelectorAll('.ev-t')].map((element) => element.textContent);
    expect(timestamps).toHaveLength(12);
    expect(timestamps[0]).toBe('1:02');
    expect(timestamps.at(-1)).toBe('1:13');
  });

  it('shows a known outcome while its report is still in flight without inventing report details', () => {
    const view = { tick: 61 * TICK_RATE, rank: 2, match: { armies: [{}, {}] } } as unknown as MatchView;
    const card = outcomeCard({ outcome: 'loss', label: 'Duel', report: undefined, view, army: 'nw', exit() {}, keepLooking() {} });
    expect(card.querySelector('.outcome-title')?.textContent).toBe('DEFEAT');
    expect(card.querySelector('.outcome-meta')?.textContent).toBe('Duel · 1m 1s');
    expect(card.querySelector('.report')).toBeNull();
    expect(card.textContent).toContain('Waiting for the after-action report…');
  });
});

describe('eliminated perspective choice', () => {
  it('offers All, then every army in its colour, and hands the choice on', () => {
    const match: Pick<MatchData, 'armies'> = { armies: ARMIES.map((id, slot) => ({ id, slot, frame: frameOf(id), colour: COLOURS[slot]!, spireAt: { x: 0, y: 0 } })) };
    const choose = vi.fn();
    const group = perspectiveChoice(match, 'ne', choose);
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button[data-perspective]')];
    expect(buttons.map((button) => button.dataset.perspective)).toEqual(['all', ...ARMIES]);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Spectate: all', 'Spectate: Blue', 'Spectate: Red (you)', 'Spectate: Green', 'Spectate: Violet']);
    expect(buttons.every((button) => button.dataset.tip)).toBe(true);
    buttons[3]!.click();
    expect(choose).toHaveBeenCalledExactlyOnceWith('se');
    buttons[0]!.click();
    expect(choose).toHaveBeenLastCalledWith('all');
  });
});
