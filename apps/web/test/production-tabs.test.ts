// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RULES, PLANES, QUEUE_ITEMS, STATS, UPGRADES, isUpgrade, type View } from '@agent-command/game/contract';
import { FIXED_KEYS, keymap } from '../src/keymap.ts';
import { ProductionTabs, ProductionTabState, type ProductionItem, productionEnabled, productionTabCount, productionTabDirection, productionTabs } from '../src/production-tabs.ts';
import { queueLabel } from '../src/queue-panel.ts';

const view = (items: ProductionItem[] = [], inProgress: View['research']['inProgress'] = []): Pick<View, 'queue' | 'research'> => ({
  queue: items.map((item, i) => ({ id: `q_${i}`, item, plane: isUpgrade(item) ? UPGRADES[item].at : STATS[item].plane, by: 'surface', byCtl: 'human', alloy: 0, energy: 0, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: !!(i % 2), next: !(i % 2), status: i % 2 ? 'building' : 'waiting', progress: 0 })),
  research: { available: [], completed: [], inProgress, seen: [] },
});
afterEach(() => document.body.replaceChildren());

describe('production categories', () => {
  it('partitions every queued registry item onto its own plane without empty tabs', () => {
    for (const plane of PLANES) {
      const tabs = productionTabs(plane);
      expect(tabs.every((tab) => tab.items.length > 0)).toBe(true);
      const items = tabs.flatMap((tab) => tab.items);
      expect(new Set(items).size).toBe(items.length);
      // A segment rebuild is offered on the fallen segment's note, never in a tab.
      expect([...items].sort()).toEqual(QUEUE_ITEMS.filter((item) => item !== 'rebuild' && (isUpgrade(item) ? UPGRADES[item].at : STATS[item].plane) === plane).sort());
      expect(tabs.find((tab) => tab.id === 'research')?.items ?? []).toEqual(Object.values(UPGRADES).filter((upgrade) => upgrade.at === plane).map((upgrade) => upgrade.id));
    }
  });
  it('withholds research a match switches off', () => {
    const off = { ...DEFAULT_RULES, research: { ...DEFAULT_RULES.research, drillBitsEnabled: false } };
    expect(productionEnabled('drill_bits', off)).toBe(false);
    expect(productionEnabled('shaped_charges', off)).toBe(true);
  });
  it('offers gunships and Storm Seeders only while their match toggles are on', () => {
    const sky = productionTabs('sky').flatMap((tab) => tab.items);
    expect(sky.filter((item) => productionEnabled(item, DEFAULT_RULES))).toEqual(sky);
    const off = { ...DEFAULT_RULES, sky: { ...DEFAULT_RULES.sky, gunshipEnabled: false, seederEnabled: false } };
    expect(sky.filter((item) => !productionEnabled(item, off))).toEqual(['gunship', 'storm_seeder']);
  });
  it('offers both secondary buildings only when hardpoints exist, independently of the main slot', () => {
    const off = { ...DEFAULT_RULES, sky: { ...DEFAULT_RULES.sky, islandHardpoints: 0 } };
    for (const item of ['island_mortar', 'ore_extractor'] as const) {
      expect(productionEnabled(item, DEFAULT_RULES)).toBe(true);
      expect(productionEnabled(item, off)).toBe(false);
    }
    expect(productionEnabled('relay', off)).toBe(true);
  });
  it('admits the complete orbital fleet through the unit registry and counts each queued ship', () => {
    const tab = productionTabs('orbit').find((tab) => tab.id === 'units')!;
    expect(tab.items).toEqual(expect.arrayContaining(['solar', 'tug', 'lancer', 'skiff', 'bastion']));
    expect(productionTabCount(tab, view(['skiff', 'skiff', 'bastion', 'lancer', 'tank']))).toBe(4);
    for (const plane of ['surface', 'depths', 'sky'] as const) {
      expect(productionTabs(plane).flatMap((tab) => tab.items)).not.toContain('skiff');
      expect(productionTabs(plane).flatMap((tab) => tab.items)).not.toContain('bastion');
    }
  });
  it('offers the Depths seat Wardens on its Units tab, counting only that tab\'s items', () => {
    const tab = productionTabs('depths').find((tab) => tab.id === 'units')!;
    expect(tab.items).toContain('warden');
    expect(tab.items).not.toContain('trooper');
    const queued = view(['trooper', 'trooper', 'warden']);
    expect(productionTabCount(tab, queued)).toBe(1);
    expect(queueLabel(queued.queue[0]!)).toBe('Trooper');
  });
  it('remembers the last tab independently for each plane and rejects absent categories', () => {
    const state = new ProductionTabState();
    state.select('surface', 'structures');
    state.select('sky', 'research');
    expect(state.get('depths').id).toBe('units');
    expect(state.get('surface').id).toBe('structures');
    expect(state.get('sky').id).toBe('research');
    state.select('orbit', 'structures');
    expect(state.get('orbit').id).toBe('units');
    expect(new ProductionTabState().get('surface').id).toBe('units');
  });
  it('cycles only available tabs in both directions, wrapping at the ends', () => {
    const state = new ProductionTabState();
    state.step('sky', -1);
    expect(state.get('sky').id).toBe('research');
    state.step('sky', 1);
    expect(state.get('sky').id).toBe('units');
    state.step('orbit', -1);
    expect(state.get('orbit').id).toBe('research');
    state.step('orbit', 1);
    expect(state.get('orbit').id).toBe('units');
  });
  it('counts queued and building items by category without double-counting active research', () => {
    const [units, structures, research] = productionTabs('sky');
    const v = view(['interceptor', 'relay', 'relay', 'ascent_thrusters', 'tank'], ['ascent_thrusters']);
    expect(productionTabCount(units!, v)).toBe(1);
    expect(productionTabCount(structures!, v)).toBe(2);
    expect(productionTabCount(research!, v)).toBe(1);
    expect(productionTabCount(research!, view([], ['ascent_thrusters']))).toBe(1);
    expect(productionTabCount(research!, view())).toBe(0);
  });
  it('reserves Ctrl+brackets without colliding with either tool layout or fixed controls', () => {
    for (const layout of ['classic', 'wasd'] as const) {
      for (const bracket of ['[', ']']) {
        expect(Object.values(keymap(layout))).not.toContain(bracket);
        expect(FIXED_KEYS).not.toContain(bracket);
      }
    }
    const event = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: '[', code: 'BracketLeft' };
    expect(productionTabDirection(event)).toBe(-1);
    expect(productionTabDirection({ ...event, key: ']', code: 'BracketRight' })).toBe(1);
    for (const modifier of ['metaKey', 'altKey', 'shiftKey'] as const) expect(productionTabDirection({ ...event, [modifier]: true })).toBeUndefined();
    expect(productionTabDirection({ ...event, ctrlKey: false })).toBeUndefined();
    expect(productionTabDirection({ ...event, key: '1', code: 'Digit1' })).toBeUndefined();
  });
});

describe('production tab controls', () => {
  it('preserves focused buttons across queue badge changes', () => {
    const tabs = new ProductionTabs(() => {});
    document.body.append(tabs.el);
    tabs.update('surface', view());
    const button = tabs.el.querySelector<HTMLButtonElement>('[role=tab]')!;
    button.focus();
    tabs.update('surface', view(['tank', 'tank']));
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-label')).toBe('Units, 2 queued or in progress');
    expect(button.querySelector('.production-tab-count')?.textContent).toBe('2');
    expect(button.getAttribute('aria-controls')).toBe('production-items');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.getAttribute('data-tip')).toContain('Units');
    expect(tabs.el.querySelector('.production-tab-hint')).toBeNull();
  });
  it('supports roving focus, arrow/Home/End navigation and per-plane restoration', () => {
    let plane: typeof PLANES[number] = 'sky';
    const tabs = new ProductionTabs(() => tabs.update(plane, view()));
    document.body.append(tabs.el);
    tabs.update(plane, view());
    let button = tabs.el.querySelector<HTMLButtonElement>('[aria-selected=true]')!;
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(tabs.state.get('sky').id).toBe('research');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Research');
    button = document.activeElement as HTMLButtonElement;
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs.state.get('sky').id).toBe('units');
    tabs.step('sky', -1);
    plane = 'surface';
    tabs.update(plane, view());
    tabs.el.querySelector<HTMLButtonElement>('#production-surface-structures')!.click();
    plane = 'sky';
    tabs.update(plane, view());
    expect(tabs.el.querySelector('[aria-selected=true]')?.getAttribute('aria-label')).toBe('Research');
    expect(tabs.el.querySelectorAll('[role=tab][tabindex="0"]')).toHaveLength(1);
    tabs.el.querySelector('[aria-selected=true]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(tabs.state.get('sky').id).toBe('units');
  });
  it('leaves camera arrows unhandled after a mouse click, restoring navigation on keyboard re-entry', () => {
    const tabs = new ProductionTabs(() => tabs.update('sky', view()));
    const outside = document.createElement('button');
    document.body.append(tabs.el, outside);
    tabs.update('sky', view());
    const button = tabs.el.querySelector<HTMLButtonElement>('[aria-selected=true]')!;
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    button.focus();
    button.click();
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    button.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(false);
    expect(tabs.state.get('sky').id).toBe('units');
    outside.focus();
    button.focus();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs.state.get('sky').id).toBe('structures');
  });
});
