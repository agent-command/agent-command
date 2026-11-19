// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES, STRUCTURE_KINDS, type Entity, type Plane, type View } from '@agent-command/game/contract';
import { Sim } from '../../../packages/game/src/sim/sim.ts';
import { applyIntent, simIntent, type GameIntent } from '../../../packages/game/src/agent/intents.ts';
import { view as gameView } from '../../../packages/game/src/agent/present.ts';
import { CommandCard } from '../src/command-card.ts';
import { structureActions } from '../src/structure-action.ts';

const entity = (kind: Entity['kind'], plane: Plane = 'surface', extra: Partial<Entity> = {}): Entity => ({ id: 'e_1', kind, side: 'nw', plane, x: 12, y: 12, hp: 100, maxHp: 100, state: 'active', ...extra });
const view = { army: 'nw', entities: [], tick: 0, res: { alloy: 1000, energy: 1000, freeAlloy: 1000, freeEnergy: 1000, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0, upkeepHeld: 0 } } as unknown as View;
const none = () => {};
beforeEach(() => { vi.stubGlobal('confirm', vi.fn(() => true)); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('Destroy Structure selection action', () => {
  it('offers only one completed own static building on the selected plane', () => {
    const act = vi.fn();
    for (const kind of STRUCTURE_KINDS) {
      const target = entity(kind);
      expect(structureActions(view, DEFAULT_RULES, 'surface', [target], act, undefined, none).length > 0, kind).toBe(kind !== 'spire');
    }
    for (const target of [entity('turret', 'sky'), entity('turret', 'surface', { side: 'se' }), entity('turret', 'surface', { state: 'constructing' }), entity('turret', 'surface', { hp: 0 }), entity('island'), entity('post'), entity('tank'), entity('solar')]) {
      expect(structureActions(view, DEFAULT_RULES, 'surface', [target], act, undefined, none)).toEqual([]);
    }
    expect(structureActions(view, DEFAULT_RULES, 'surface', [], act, undefined, none)).toEqual([]);
    expect(structureActions(view, DEFAULT_RULES, 'surface', [entity('turret'), entity('shaft')], act, undefined, none)).toEqual([]);
  });

  it('arms in the card, backs out, then confirms a real removal of the displayed building and frees its map cell', () => {
    const sim = new Sim(31, { terrain: 'open', sky: { stormSets: 0 } });
    const turret = sim.add('turret', 0, 'surface', 14.5, 14.5);
    sim.armies[0]!.structures++;
    sim.step();
    const snapshot = { ...gameView(sim, 'nw'), signals: [] };
    // The view names entities as nw does (game sim/aliases.ts); the card's intents go back through those names.
    const named = (id: number) => `e_${sim.aliasOf(0, id)}`;
    const selected = snapshot.entities.find(e => e.id === named(turret.id))!;
    const other = sim.add('turret', 0, 'surface', 16.5, 14.5);
    sim.armies[0]!.structures++;
    const selection = [selected];
    expect(selected).toBeDefined();
    const results: unknown[] = [];
    const card = new CommandCard(); document.body.append(card.el);
    let armed: string | undefined;
    // The game re-renders the card on arm/disarm, as game.ts does.
    const render = () => card.update(structureActions(snapshot, sim.rules, 'surface', selection, intents => {
      for (const intent of intents) results.push(applyIntent(sim, 0, 'surface', simIntent(sim, 0, intent as GameIntent)));
    }, armed, id => { armed = id; render(); }), '#fff');
    render();
    const button = () => card.el.querySelector<HTMLButtonElement>('[data-action="structure:dismantle"]')!;
    const keep = () => card.el.querySelector<HTMLButtonElement>('[data-action="structure:keep"]');
    expect(keep()).toBeNull();
    button().click();
    expect(results).toEqual([]);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    keep()!.click();
    expect(keep()).toBeNull();
    expect(results).toEqual([]); expect(turret.dead).toBe(false);
    button().click();
    // A later selection change does not retarget the armed confirmation.
    selection[0] = entity('turret', 'surface', { id: named(other.id) });
    button().click();
    expect(results).toEqual([{ ok: true }]); expect(turret.dead).toBe(true);
    expect(other.dead).toBe(false);
    expect(armed).toBeUndefined();
    expect(window.confirm).not.toHaveBeenCalled();
    sim.step();
    expect(gameView(sim, 'nw').entities.some(e => e.id === selected.id)).toBe(false);
    expect(sim.surfaceBodies[14 * sim.size + 14]).toBe(0);
    card.dispose();
  });
});
