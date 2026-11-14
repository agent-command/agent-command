// @vitest-environment happy-dom
/** Crowns HUD (lossRule crowns only): crown pips per army, the match point banner, the crown-lost cue and the end card's fallen segments. */
import { describe, expect, it } from 'vitest';
import { resolveRules, type ArmyId, type GameEvent, type View } from '@agent-command/game/contract';
import { crownPips, CrownsBoard, MatchPointBanner, matchPointArmies } from '../src/plan-hud.ts';
import { END_REASON_LABEL, endLabel } from '../src/observer-model.ts';

const CROWNS = resolveRules({ spire: { lossRule: 'crowns' } });
const SURFACE = resolveRules({});
const name = (army: ArmyId): string => ({ nw: 'Blue', se: 'Red', ne: 'Green', sw: 'Gold' } as Record<string, string>)[army]!;
const rows = (...list: [ArmyId, number, View['spire'][number]['plane'][]][]): View['crowns'] => list.map(([army, lost, fallen]) => ({ army, lost, fallen }));

describe('crown pips', () => {
  it('four pips per army, Orbit → Depths, dark where the segment fell', () => {
    const el = crownPips({ army: 'se', lost: 1, fallen: ['sky'] }, CROWNS, 'Red');
    const pips = [...el.querySelectorAll<HTMLElement>('.crown-pip')];
    expect(pips.map((p) => p.dataset.plane)).toEqual(['orbit', 'sky', 'surface', 'depths']);
    expect(pips.map((p) => p.dataset.state)).toEqual(['standing', 'fallen', 'standing', 'standing']);
    expect(pips.find((p) => p.dataset.plane === 'surface')!.dataset.crowns).toBe(String(CROWNS.spire.crownsSurface));
    expect(el.getAttribute('aria-label')).toBe(`Red: 1 of ${CROWNS.spire.crownsToLose} crowns lost · Sky down`);
  });

  it('the HUD board shows every army, own first, eliminated rows frozen as given, and only under crowns', () => {
    const board = new CrownsBoard();
    const crowns = rows(['nw', 0, []], ['se', 2, ['sky', 'orbit']]);
    board.update(CROWNS, crowns, 'se', name);
    expect(board.el.hidden).toBe(false);
    const shown = [...board.el.querySelectorAll<HTMLElement>('.crowns-row')];
    expect(shown.map((r) => r.dataset.team)).toEqual(['se', 'nw']);
    expect([...shown[0]!.querySelectorAll<HTMLElement>('.crown-pip')].map((p) => p.dataset.state)).toEqual(['fallen', 'fallen', 'standing', 'standing']);
    board.update(SURFACE, crowns, 'se', name);
    expect(board.el.hidden).toBe(true);
    board.update(CROWNS, undefined, 'se', name);
    expect(board.el.hidden).toBe(true);
  });
});

describe('match point', () => {
  it('names armies in play one crown from out; eliminated armies and other loss rules never', () => {
    const at = CROWNS.spire.crownsToLose - 1;
    const crowns = rows(['nw', at, ['sky']], ['se', at - 1, []], ['ne', CROWNS.spire.crownsToLose, ['surface']]);
    expect(matchPointArmies(CROWNS, crowns, ['ne'])).toEqual(['nw']);
    expect(matchPointArmies(SURFACE, crowns, [])).toEqual([]);
    const banner = new MatchPointBanner();
    banner.update(CROWNS, crowns, ['ne'], name);
    expect(banner.el.hidden).toBe(false);
    expect(banner.el.textContent).toContain('Match point · Blue');
    banner.update(CROWNS, rows(['nw', 0, []], ['se', 0, []]), [], name);
    expect(banner.el.hidden).toBe(true);
    banner.update(SURFACE, crowns, [], name);
    expect(banner.el.hidden).toBe(true);
  });
});

describe('end card', () => {
  const fell = (side: ArmyId, plane: GameEvent['plane']): GameEvent => ({ tick: 900, kind: 'army_eliminated', plane, x: 4, y: 4, side, killer: 'nw' }) as GameEvent;
  it('names the fallen segments instead of "Spire destroyed"', () => {
    expect(endLabel('spire', 900, [fell('se', 'orbit')], rows(['nw', 0, []], ['se', 2, ['sky', 'orbit']]), name)).toBe('Sky and Orbit segments fell');
    // No crowns rows: the deciding segment the event names.
    expect(endLabel('spire', 900, [fell('se', 'surface')], undefined, name)).toBe('Surface segment fell');
    // Several armies fall on the final tick: each named; duplicate events count once.
    expect(endLabel('spire', 900, [fell('se', 'surface'), fell('ne', 'sky'), fell('se', 'surface')], rows(['ne', 2, ['depths', 'sky']]), name))
      .toBe('Red: Surface segment fell · Green: Depths and Sky segments fell');
    expect(endLabel('time_cap', 900, [], undefined, name)).toBe(END_REASON_LABEL.time_cap);
    expect(endLabel('forfeit', 900, [fell('se', 'surface')], undefined, name)).toBe(END_REASON_LABEL.forfeit);
  });
});
