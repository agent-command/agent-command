import { describe, expect, it } from 'vitest';
import { COLOURS, PLANES } from '../src/rules/contract.ts';
import { lobbyLayout, lobbyMap, lobbyMode } from '../src/lobby/lobby.ts';
import { MAPS } from '../src/maps/registry.ts';
import { namedMap } from '../src/maps/maps.ts';

describe('map-owned lobby layouts', () => {
  it.each(MAPS)('$id derives armies and colours from its declared layout', (map) => {
    expect(lobbyMap(map.id)).toBe(map);
    for (const layout of map.layouts) {
      const mode = lobbyMode(map.id, layout.id)!;
      expect(lobbyLayout(map.id, layout.id)).toBe(layout);
      expect(mode).toMatchObject({
        mapId: map.id, layoutId: layout.id, id: layout.mode, supported: layout.supported, playersPerSide: 1,
        slots: layout.sides, symmetry: layout.sides === 2 ? 'point' : 'quarter-turn',
      });
      expect(layout.sides).toBeLessThanOrEqual(map.sides);
      expect(mode.roles).toBe(map.roles);
      const participating = layout.alliances.flatMap((alliance) => alliance.slots);
      expect(new Set(participating).size).toBe(participating.length);
      expect(mode.sides.map((side) => side.id).sort()).toEqual([...participating].sort());
      for (const side of mode.sides) {
        expect(map.slots.find((slot) => slot.id === side.id)?.label).toBe(side.label);
        // The k-th alliance plays the k-th colour.
        expect(side.alliance).toBe(COLOURS[layout.alliances.findIndex((alliance) => alliance.slots.includes(side.id))]);
      }
      expect(lobbyMode(map.id, layout.id)).toEqual(mode);
    }
  });

  it('two-slot maps offer the opposite-corner 1v1; generated recipes a C2 duel and a C4 free-for-all', () => {
    for (const map of MAPS) {
      expect(map.roles).toEqual(PLANES);
      expect(map.slots).toHaveLength(map.sides);
      if (map.tags.includes('generated')) {
        expect(map.sides).toBe(4);
        expect(map.slots.map((slot) => slot.id)).toEqual(['nw', 'ne', 'se', 'sw']);
        expect(map.layouts.map((layout) => [layout.id, layout.mode, layout.sides, layout.supported])).toEqual([['duel', '1v1', 2, true], ['ffa', 'ffa', 4, true]]);
        expect(lobbyMode(map.id, 'duel')!.sides.map((side) => [side.id, side.alliance])).toEqual([['nw', 'blue'], ['se', 'red']]);
        expect(lobbyMode(map.id, 'ffa')!.sides.map((side) => [side.id, side.alliance])).toEqual([['nw', 'blue'], ['ne', 'red'], ['se', 'green'], ['sw', 'violet']]);
      } else if (map.sides === 2) {
        expect(map.slots.map((slot) => [slot.id, slot.corner])).toEqual([['nw', 'northwest'], ['se', 'southeast']]);
        expect(map.layouts.filter((layout) => layout.supported).map((layout) => layout.mode)).toEqual(['1v1']);
        expect(lobbyMode(map.id, 'duel')!.sides.map((side) => side.id)).toEqual(['nw', 'se']);
        expect(lobbyMode(map.id, '2v2')).toBeUndefined();
        expect(lobbyMode(map.id, 'ffa')).toBeUndefined();
      }
    }
  });

  it('four_corners layouts come from its map document: FFA and the C4 duel supported, alliances by army id', () => {
    const map = lobbyMap('four_corners')!;
    const document = namedMap('four_corners')!;
    expect(map.sides).toBe(4);
    expect(map.slots.map((slot) => [slot.id, slot.corner])).toEqual([['nw', 'northwest'], ['ne', 'northeast'], ['se', 'southeast'], ['sw', 'southwest']]);
    expect(map.layouts.map((layout) => layout.id)).toEqual(document.layouts.map((layout) => layout.id));
    expect(map.layouts.map((layout) => [layout.id, layout.mode, layout.supported, layout.sides, layout.fairness])).toEqual([
      ['ffa', 'ffa', true, 4, 'exact'],
      ['duel', '1v1', true, 4, 'exact'],
      ['adjacent', '2v2', false, 4, 'unverified'],
      ['opposite', '2v2', false, 4, 'unverified'],
    ]);
    expect(map.layouts.map((layout) => layout.alliances)).toEqual([
      [{ id: 'nw', slots: ['nw'] }, { id: 'ne', slots: ['ne'] }, { id: 'se', slots: ['se'] }, { id: 'sw', slots: ['sw'] }],
      [{ id: 'nw', slots: ['nw'] }, { id: 'se', slots: ['se'] }],
      [{ id: 'nw_ne', slots: ['nw', 'ne'] }, { id: 'se_sw', slots: ['se', 'sw'] }],
      [{ id: 'nw_se', slots: ['nw', 'se'] }, { id: 'ne_sw', slots: ['ne', 'sw'] }],
    ]);
    expect(lobbyMode('four_corners', 'duel')).toMatchObject({ symmetry: 'quarter-turn', slots: 4, sides: [{ id: 'nw', alliance: 'blue' }, { id: 'se', alliance: 'red' }] });
    expect(lobbyMode('four_corners', 'ffa')!.sides.map((side) => side.alliance)).toEqual(['blue', 'red', 'green', 'violet']);
  });

  it('rejects unknown map/layout pairs rather than inferring a global mode', () => {
    expect(lobbyMap('not-a-map')).toBeUndefined();
    expect(lobbyLayout('not-a-map', 'duel')).toBeUndefined();
    expect(lobbyMode('not-a-map', 'duel')).toBeUndefined();
    expect(lobbyMode('open', 'not-a-layout')).toBeUndefined();
  });
});
