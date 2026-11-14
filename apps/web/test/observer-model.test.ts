import { describe, expect, it } from 'vitest';
import { CELL, SURFACE, TERRAIN_CELLS_PER_WORD, TERRAIN_CODE_BITS, VISION_BITS_PER_WORD, type GameEvent } from '@agent-command/game/contract';
import { composition, endReason, lensView, observerBoard, standings, Timeline, visionOptions, type BoardSide, type ObserverSideData } from '../src/observer-model.ts';
import type { MatchView } from '../src/match-view.ts';

const ev = (tick: number, kind: GameEvent['kind'], x: number, extra: Partial<GameEvent> = {}): GameEvent => ({ tick, kind, plane: 'surface', x, y: 10, ...extra }) as GameEvent;

describe('vision choices follow the observer grant', () => {
  it('omniscient: everything plus each side; team: only that team; featured relay: All first while served, each side its own stream', () => {
    expect(visionOptions({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: 0 }).map((option) => [option.value, option.stream])).toEqual([['all', true], ['nw', false], ['se', false]]);
    expect(visionOptions({ kind: 'team', team: 'se', delayMs: 0 }).map((option) => option.value)).toEqual(['se']);
    expect(visionOptions({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: 3000 }, ['nw', 'se']).map((option) => [option.value, option.stream])).toEqual([['all', true], ['nw', true], ['se', true]]);
    // A featured match that serves no All (a seat that is not a built-in bot): each side's fog only.
    expect(visionOptions({ kind: 'team', team: 'nw', delayMs: 3000 }, ['nw', 'se']).map((option) => [option.value, option.stream])).toEqual([['nw', true], ['se', true]]);
    // A four-army match: All plus one lens per army, in slot order; never an id outside the contract.
    expect(visionOptions({ kind: 'omniscient', teams: ['nw', 'ne', 'se', 'sw'], delayMs: 0 }).map((option) => option.value)).toEqual(['all', 'nw', 'ne', 'se', 'sw']);
    expect(visionOptions({ kind: 'omniscient', teams: ['nw', 'blue'], delayMs: 0 }).map((option) => option.value)).toEqual(['all', 'nw']);
    expect(visionOptions({ kind: 'team', team: 'blue', delayMs: 0 })).toEqual([]);
  });
});

describe('timeline', () => {
  it('reads each side window once, merges bursts, counts shared breakthroughs once', () => {
    const timeline = new Timeline();
    const blue = [ev(100, 'enemy_killed', 10, { subject: 'tank', side: 'se' }), ev(110, 'enemy_killed', 12, { subject: 'tank', side: 'se' }), ev(120, 'breach_opened', 30, { side: 'nw' }), ev(120, 'produced', 5)];
    timeline.ingest('nw', blue);
    // The sliding window repeats: nothing is counted twice.
    timeline.ingest('nw', blue);
    // The se army's window holds the same public breakthrough and a hit on its Spire.
    timeline.ingest('se', [ev(120, 'breach_opened', 30, { side: 'nw' }), ev(125, 'spire_damaged', 24, { side: 'nw' })]);
    expect(timeline.moments.map((moment) => [moment.kind, moment.team, moment.victim, moment.count])).toEqual([
      ['kill', 'nw', 'se', 2], ['breakthrough', 'nw', undefined, 1], ['spire', 'nw', 'se', 1],
    ]);
    // Far apart in time: a new line.
    timeline.ingest('nw', [ev(400, 'enemy_killed', 12, { subject: 'tank', side: 'se' })]);
    expect(timeline.moments).toHaveLength(4);
  });
});

describe('army lens over the omniscient projection', () => {
  const SIZE = 48, TICK = 1000;
  const words = (cells: (x: number, y: number) => boolean) => {
    const out = new Array<number>(Math.ceil(SIZE * SIZE / VISION_BITS_PER_WORD)).fill(0);
    for (let c = 0; c < SIZE * SIZE; c++) if (cells(c % SIZE, Math.floor(c / SIZE))) out[Math.floor(c / VISION_BITS_PER_WORD)]! |= 1 << (c % VISION_BITS_PER_WORD);
    return out;
  };
  // nw sees the top-left 16×16 tiles on every plane; (12, 12) is forest.
  const near = (x: number, y: number) => x < 16 && y < 16;
  const terrain = new Array<number>(Math.ceil(SIZE * SIZE / TERRAIN_CELLS_PER_WORD)).fill(0);
  const forest = 12 * SIZE + 12;
  terrain[Math.floor(forest / TERRAIN_CELLS_PER_WORD)] = SURFACE.forest << (TERRAIN_CODE_BITS * (forest % TERRAIN_CELLS_PER_WORD));
  const match = {
    rules: { map: { size: SIZE }, depths: { chargesFogged: true, chargePublicTime: 5 } }, terrain,
    armies: [{ id: 'nw', slot: 0, frame: 0, colour: 'blue', spireAt: { x: 4, y: 4 } }, { id: 'se', slot: 1, frame: 2, colour: 'red', spireAt: { x: 44, y: 44 } }],
  };
  const unit = (id: string, side: string, kind: string, x: number, y: number, extra: object = {}) => ({ id, side, kind, plane: 'surface', x, y, hp: 100, maxHp: 100, state: 'idle', ...extra });
  const world = {
    tick: TICK, army: 'nw', match, eliminated: [], fx: [], events: [], memory: [], flares: [], oreCaches: [], scorches: [], lodes: [], islands: [], tremors: [], alerts: [], rally: [],
    weather: { storms: [], forecast: [], fog: [], seeded: [], seedWarnings: [] }, vision: { depths: words(() => true), surface: words(() => true), sky: words(() => true), orbit: words(() => true) },
    entities: [
      unit('e_1', 'se', 'tank', 40.5, 40.5), unit('e_2', 'se', 'tank', 8.5, 8.5), unit('e_3', 'se', 'trooper', 12.5, 12.5),
      unit('e_4', 'se', 'interceptor', 6.5, 6.5, { plane: 'sky', hangar: 'e_9' }), unit('e_5', 'neutral', 'asteroid', 40.5, 10.5, { plane: 'orbit', state: 'drifting', resourceType: 'alloy' }),
    ],
    charges: [
      { x: 40, y: 40, tick: TICK + 500, side: 'se', stack: 2 }, { x: 10, y: 10, tick: TICK + 500, side: 'se', stack: 3 },
      { x: 40, y: 41, tick: TICK + 500, side: 'nw', stack: 1 }, { x: 30, y: 30, tick: TICK + 20, side: 'se', stack: 1 },
    ],
    schedule: [{ kind: 'asteroid_spawn', tick: TICK + 900 }, { kind: 'lode_vent', tick: TICK + 300, x: 24.5, y: 24.5 }],
    depths: new Array<number>(SIZE * SIZE).fill(CELL.rock), pockets: [{ x: 40, y: 40, id: 1 }], cracks: [{ x: 40, y: 40, stage: 2 }, { x: 9, y: 9, stage: 1 }],
  } as unknown as MatchView;
  const side = { army: 'nw', res: {}, spire: [], queue: [], research: {}, forces: [], events: [], vision: { depths: words(near), surface: words(near), sky: words(near), orbit: words(near) } } as unknown as ObserverSideData;

  it('hides a hostile charge and its collapse entry the army has not seen, as its own stream would; All keeps them', () => {
    const lens = lensView(world, side);
    // All: every charge, the vent's lode cell, every pocket.
    expect(world.charges).toContainEqual(expect.objectContaining({ x: 40, y: 40, side: 'se' }));
    expect(world.pockets).toHaveLength(1);
    // The lens: a hostile charge in its Depths sight (stack withheld), its own (with its stack), one in its public window.
    expect(lens.charges).toEqual([{ x: 10, y: 10, tick: TICK + 500, side: 'se' }, { x: 40, y: 41, tick: TICK + 500, side: 'nw', stack: 1 }, { x: 30, y: 30, tick: TICK + 20, side: 'se' }]);
    expect(lens.schedule).toEqual([
      { kind: 'collapse', tick: TICK + 20, x: 30.5, y: 30.5 }, { kind: 'lode_vent', tick: TICK + 300 },
      { kind: 'collapse', tick: TICK + 500, x: 10.5, y: 10.5 }, { kind: 'collapse', tick: TICK + 500, x: 40.5, y: 41.5 }, { kind: 'asteroid_spawn', tick: TICK + 900 },
    ]);
  });

  it('drops what only army knowledge could show: unseen, forest-hidden and hangared units, unseen rocks, terrain, pockets, cracks', () => {
    const lens = lensView(world, side);
    expect(lens.entities.map((e) => e.id)).toEqual(['e_2']);
    expect(lens.depths[10 * SIZE + 10]).toBe(CELL.rock);
    expect(lens.depths[40 * SIZE + 40]).toBe(CELL.unknown);
    expect(lens.pockets).toEqual([]);
    expect(lens.cracks).toEqual([{ x: 9, y: 9, stage: 1 }]);
  });
});

it('composition counts units per plane in kind order, structures excluded', () => {
  const e = (kind: string, plane: string, side = 'nw') => ({ kind, plane, side });
  expect(composition([e('tank', 'surface'), e('trooper', 'surface'), e('tank', 'surface'), e('spire', 'surface'), e('bomber', 'sky'), e('tank', 'surface', 'se')] as never, 'nw'))
    .toEqual([{ plane: 'sky', kinds: [{ kind: 'bomber', count: 1 }] }, { plane: 'surface', kinds: [{ kind: 'trooper', count: 1 }, { kind: 'tank', count: 2 }] }]);
});

it('scores an army\'s board from its replacement-cost forces rows', () => {
  const side = {
    army: 'ne', res: { alloy: 10 }, spire: [{ plane: 'surface', hp: 300, maxHp: 1000 }], queue: [], research: { available: [], inProgress: [], completed: [], seen: [] },
    forces: [{ plane: 'surface', units: 3, alloy: 300, energy: 30, structures: 1, structureAlloy: 0, structureEnergy: 0 }, { plane: 'sky', units: 2, alloy: 100, energy: 50, structures: 0, structureAlloy: 0, structureEnergy: 0 }],
    events: [], vision: {},
  };
  expect(observerBoard(side as never)).toMatchObject({ army: 'ne', disclosed: true, forces: { units: 5, value: 480 }, spire: { surface: { hp: 300, maxHp: 1000 }, orbit: undefined } });
});

describe('end of match', () => {
  const fell = (tick: number, side: string, killer?: string) => ev(tick, 'army_eliminated', 4, { side, ...(killer ? { killer } : {}) } as Partial<GameEvent>);
  it('names how it ended from the final tick: time cap, a Spire kill, a forfeit, or the host', () => {
    const hp = (values: Record<string, number>) => (army: string, plane: string) => values[`${army}.${plane}`] ?? values[army];
    expect(endReason(18000, 18000, [], hp({}))).toBe('time_cap');
    expect(endReason(900, 18000, [fell(900, 'se', 'nw')], hp({ se: 0 }))).toBe('spire');
    // A fallen army whose Surface segment still stands forfeited, killing blow or not.
    expect(endReason(900, 18000, [fell(900, 'se')], hp({ se: 400 }))).toBe('forfeit');
    // Spire out of sight: no killing blow means a forfeit; an earlier tick's elimination is not how the match ended.
    expect(endReason(900, 18000, [fell(900, 'se')], hp({}))).toBe('forfeit');
    expect(endReason(900, 18000, [fell(900, 'se', 'nw')], hp({}))).toBe('spire');
    expect(endReason(900, 18000, [fell(400, 'ne', 'nw')], hp({}))).toBe('ended');
    // Crowns: the event names the deciding segment, so a Surface still standing is no forfeit when the Sky fell.
    const sky = { ...fell(900, 'se', 'nw'), plane: 'sky' } as GameEvent;
    expect(endReason(900, 18000, [sky], hp({ 'se.sky': 0, 'se.surface': 7000 }))).toBe('spire');
  });

  it('places every army from the projection, else from the outcomes alone, best first', () => {
    const armies = [{ id: 'nw', colour: 'blue' }, { id: 'ne', colour: 'green' }, { id: 'se', colour: 'red' }, { id: 'sw', colour: 'violet' }] as const;
    const board = (army: string, units: number, surface: number): BoardSide => ({ army, disclosed: true, res: undefined, forces: { units, value: units * 100 }, spire: { depths: undefined, surface: { hp: surface, maxHp: 1000 }, sky: undefined, orbit: { hp: 500, maxHp: 500 } }, queue: [], names: 'sim', research: undefined }) as BoardSide;
    const boards = new Map([['nw', board('nw', 4, 0)], ['ne', board('ne', 9, 700)], ['se', board('se', 0, 0)], ['sw', board('sw', 2, 0)]] as const);
    const outcomes = { nw: 'loss', ne: 'win', se: 'loss', sw: 'loss' } as const;
    const known = new Map([['ne', 1], ['nw', 2], ['sw', 3], ['se', 4]] as const);
    const rows = standings(armies, outcomes, known, boards);
    expect(rows.map((row) => [row.army, row.rank, row.outcome])).toEqual([['ne', 1, 'win'], ['nw', 2, 'loss'], ['sw', 3, 'loss'], ['se', 4, 'loss']]);
    expect(rows[0]).toMatchObject({ forces: { units: 9, value: 900 }, spire: { hp: 1200, maxHp: 1500 } });
    // A fogged team view knows only its own place: the winner is first, the others' places stay unknown in army order.
    expect(standings(armies, outcomes, new Map([['sw', 3]]), new Map()).map((row) => [row.army, row.rank, row.spire])).toEqual([['ne', 1, undefined], ['sw', 3, undefined], ['nw', undefined, undefined], ['se', undefined, undefined]]);
    // Two alliances: the outcomes alone place both; a draw shares first place.
    const duel = [{ id: 'nw', colour: 'blue' }, { id: 'se', colour: 'red' }] as const;
    expect(standings(duel, { nw: 'loss', se: 'win' }, new Map(), new Map()).map((row) => [row.army, row.rank])).toEqual([['se', 1], ['nw', 2]]);
    expect(standings(duel, { nw: 'draw', se: 'draw' }, new Map(), new Map()).map((row) => [row.army, row.rank])).toEqual([['nw', 1], ['se', 1]]);
  });
});
