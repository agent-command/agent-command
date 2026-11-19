// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES, RULE_FIELDS, RULE_GROUPS, hashRules, resolveRules, resolveRulesPreset } from '@agent-command/game/contract';
import { createRulesEditor, editRule, resetRuleGroup, type RulesEditorOptions } from '../src/rules-editor.ts';

afterEach(() => document.body.replaceChildren());
function mount(extra: Partial<RulesEditorOptions> = {}) {
  const onChange = vi.fn();
  const editor = createRulesEditor({ rules: DEFAULT_RULES, onChange, ...extra });
  document.body.append(editor.element);
  return { ...editor, onChange };
}
function field(element: HTMLElement, path: string): HTMLInputElement {
  return element.querySelector<HTMLInputElement>(`[data-rule-path="${path}"]`)!;
}
function change(element: HTMLElement, path: string, value: string): void {
  const input = field(element, path);
  input.value = value;
  input.dispatchEvent(new Event('change'));
}
function click(element: HTMLElement, label: string): void {
  const button = [...element.querySelectorAll('button')].find((entry) => entry.textContent === label)!;
  button.click();
}

describe('rules editor model helpers', () => {
  it('edits nested list entries without mutating the frozen source', () => {
    const next = editRule(DEFAULT_RULES, ['map', 'contestedZones', '0', 'loads'], 220);
    expect(next.map.contestedZones[0]!.loads).toBe(220);
    expect(DEFAULT_RULES.map.contestedZones[0]!.loads).toBe(150);
    expect(next).not.toBe(DEFAULT_RULES);
  });
  it('resets exactly the selected presentation group, including unit stats and segment HP', () => {
    const custom = resolveRules({
      orbit: { maxAsteroids: 0 }, economy: { startAlloy: 999 },
      stats: { lancer: { hp: 999 } }, spire: { hp: { orbit: 999 } },
    });
    const next = resetRuleGroup(custom, 'orbit');
    expect(next.orbit).toEqual(DEFAULT_RULES.orbit);
    expect(next.stats.lancer).toEqual(DEFAULT_RULES.stats.lancer);
    expect(next.spire.hp.orbit).toBe(DEFAULT_RULES.spire.hp.orbit);
    expect(next.economy.startAlloy).toBe(999);
  });
});

describe('schema-generated lobby editor', () => {
  it('renders all groups and scalar/list controls, accessible labels and explicit defaults/bounds', () => {
    const { element } = mount();
    expect([...element.querySelectorAll('[data-rule-group]')].map((entry) => (entry as HTMLElement).dataset.ruleGroup))
      .toEqual(RULE_GROUPS.map((group) => group.id));
    // One pass over ~4k nodes; per-field selector scans are quadratic under happy-dom.
    const inputs = new Map([...element.querySelectorAll<HTMLInputElement>('[data-rule-path]')].map((input) => [input.dataset.rulePath!, input]));
    const lists = new Set([...element.querySelectorAll<HTMLElement>('[data-rule-list]')].map((list) => list.dataset.ruleList!));
    const labels = new Map([...element.querySelectorAll<HTMLLabelElement>('label[for]')].map((label) => [label.htmlFor, label.textContent]));
    const notes = new Map([...element.querySelectorAll<HTMLElement>('small[id]')].map((note) => [note.id, note.textContent]));
    for (const descriptor of RULE_FIELDS) {
      const path = descriptor.path.join('.');
      if (descriptor.kind === 'list') {
        expect(lists.has(path), path).toBe(true);
        for (const child of descriptor.children ?? []) expect(inputs.has(child.path.map((key) => key === '*' ? '0' : key).join('.'))).toBe(true);
      } else {
        const input = inputs.get(path);
        expect(input, path).toBeDefined();
        expect(labels.get(input!.id)).toBe(descriptor.label);
        expect(notes.get(input!.getAttribute('aria-describedby')!)).toContain('Standard:');
        expect(notes.get(input!.getAttribute('aria-describedby')!)).toContain('Bounds:');
      }
    }
    expect(element.textContent).toContain('Standard · Guarded');
    expect(element.querySelector('[title]')).toBeNull();
  });

  it('shows the full visible diff and custom/unranked badge for any field change, then resets it', () => {
    const { element, onChange } = mount();
    change(element, 'economy.startAlloy', '700');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].economy.startAlloy).toBe(700);
    expect(element.textContent).toContain('Custom · Unranked');
    expect(element.querySelector('[aria-label="Changes from Standard"]')?.textContent).toContain('400 → 700');
    expect(element.textContent).toContain('clear lobby readiness');
    click(element, 'Reset Start alloy');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(element.textContent).toContain('Standard · Guarded');
    expect(element.textContent).toContain('No gameplay changes.');
  });

  it('applies ordinary presets and resets a whole presentation group', () => {
    const { element, onChange } = mount();
    change(element, 'preset', 'rich-economy');
    expect(onChange.mock.calls[0]![0]).toEqual(resolveRulesPreset('rich-economy'));
    expect(element.textContent).toContain('Custom · Unranked');
    click(element, 'Reset Economy');
    expect(onChange.mock.calls[1]![0]).toEqual(DEFAULT_RULES);
    expect(element.textContent).toContain('Standard · Guarded');
  });

  it('supports booleans, enums, arbitrary bounded fractional numbers and list add/remove/reset', () => {
    const { element, onChange } = mount();
    const caverns = field(element, 'map.caverns');
    caverns.checked = false;
    caverns.dispatchEvent(new Event('change'));
    expect(onChange.mock.calls.at(-1)![0].map.caverns).toBe(false);
    change(element, 'terrain', 'open');
    expect(onChange.mock.calls.at(-1)![0].terrain).toBe('open');
    change(element, 'economy.spireAlloyRate', '2.123');
    expect(onChange.mock.calls.at(-1)![0].economy.spireAlloyRate).toBe(2.123);
    // Several list rules render "Add entry" (map.contestedPosts comes first and is full by default): act on the zones list.
    const zones = () => element.querySelector<HTMLElement>('[data-rule-list="map.contestedZones"]')!;
    click(zones(), 'Add entry');
    expect(onChange.mock.calls.at(-1)![0].map.contestedZones).toHaveLength(2);
    change(element, 'map.contestedZones.1.loads', '201');
    expect(onChange.mock.calls.at(-1)![0].map.contestedZones[1].loads).toBe(201);
    click(zones(), 'Remove entry 1');
    expect(onChange.mock.calls.at(-1)![0].map.contestedZones).toHaveLength(1);
    click(zones(), 'Reset Contested zones');
    expect(onChange.mock.calls.at(-1)![0].map.contestedZones).toEqual(DEFAULT_RULES.map.contestedZones);
  });

  it('edits a list of scalars (contested point kinds) item by item', () => {
    const { element, onChange } = mount();
    const posts = () => element.querySelector<HTMLElement>('[data-rule-list="map.contestedPosts"]')!;
    expect((field(element, 'map.contestedPosts.0') as unknown as HTMLSelectElement).value).toBe('centre');
    expect((field(element, 'map.contestedPosts.1') as unknown as HTMLSelectElement).value).toBe('flanks');
    click(posts(), 'Remove entry 1');
    expect(onChange.mock.calls.at(-1)![0].map.contestedPosts).toEqual(['flanks']);
    click(posts(), 'Add entry');
    expect(onChange.mock.calls.at(-1)![0].map.contestedPosts).toEqual(['flanks', 'centre']);
    click(posts(), 'Remove entry 2');
    change(element, 'map.contestedPosts.0', 'centre');
    expect(onChange.mock.calls.at(-1)![0].map.contestedPosts).toEqual(['centre']);
  });

  it('edits the derelict ruin: the on/off toggle and its core and gate numbers', () => {
    const { element, onChange } = mount();
    const ruin = field(element, 'orbit.derelictEnabled');
    expect(ruin.type).toBe('checkbox');
    expect(ruin.checked).toBe(true);
    ruin.checked = false;
    ruin.dispatchEvent(new Event('change'));
    expect(onChange.mock.calls.at(-1)![0].orbit.derelictEnabled).toBe(false);
    change(element, 'orbit.coreRewardAlloy', '6');
    expect(onChange.mock.calls.at(-1)![0].orbit.coreRewardAlloy).toBe(6);
    change(element, 'orbit.derelictOpen', '15');
    expect(onChange.mock.calls.at(-1)![0].orbit.derelictOpen).toBe(15);
  });

  it.each([['lavaLakes', 'Lava lakes'], ['richOre', 'Rich ore']] as const)('toggles map.%s.enabled under Map · %s', (key, section) => {
    const { element, onChange } = mount();
    const map = element.querySelector<HTMLElement>('[data-rule-group="map"]')!;
    const toggle = field(map, `map.${key}.enabled`);
    expect(toggle.type).toBe('checkbox');
    // both are on by default
    expect(toggle.checked).toBe(true);
    expect([...map.querySelectorAll('h4')].map((h) => h.textContent)).toContain(section);
    expect(map.querySelector(`label[for="${toggle.id}"]`)?.textContent).toBe('Enabled');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(onChange.mock.calls.at(-1)![0].map[key].enabled).toBe(false);
  });

  it('rejects bounds, empty values and cross-field invalid combinations without emitting', () => {
    const { element, onChange } = mount();
    change(element, 'economy.startAlloy', '100001');
    expect(onChange).not.toHaveBeenCalled();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Start alloy');
    change(element, 'economy.startAlloy', '');
    expect(onChange).not.toHaveBeenCalled();
    change(element, 'spire.range', '8');
    expect(onChange).not.toHaveBeenCalled();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('deorbitRange');
    expect(field(element, 'spire.range').value).toBe(String(DEFAULT_RULES.spire.range));
  });

  it('honors remote state/read-only updates and authored-map authority', () => {
    const { element, update, onChange } = mount({ mapEditable: false });
    expect(field(element, 'map.spireInset').disabled).toBe(true);
    expect(field(element, 'terrain').disabled).toBe(true);
    expect(element.textContent).toContain('authored map owns its recipe');
    update({ rules: resolveRulesPreset('fast'), disabled: true, mapEditable: false });
    expect(field(element, 'economy.startAlloy').disabled).toBe(true);
    expect(element.querySelector<HTMLSelectElement>('[aria-label="Rules preset"]')!.disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reads a preset back as selected under the lobby-owned terrain and map size', () => {
    const lobbyRules = resolveRules({ terrain: 'archipelago', map: { seed: 9, params: { size: 64 } } });
    const { element, onChange, update } = mount({ rules: lobbyRules });
    change(element, 'preset', 'fast');
    const applied = onChange.mock.calls[0]![0];
    expect(applied.terrain).toBe('archipelago'); expect(applied.map.size).toBe(64);
    // The server echoes exactly this back; the picker must show the preset, not "Custom".
    update({ rules: applied });
    expect(element.querySelector<HTMLSelectElement>('[aria-label="Rules preset"]')!.value).toBe('fast');
  });

  it('renders registry-provided discrete numeric choices without hardcoded per-field forms', () => {
    const { element, onChange } = mount({ choices: { 'economy.oreLoad': [10, 20] } });
    const select = element.querySelector<HTMLSelectElement>('[data-rule-path="economy.oreLoad"]')!;
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map((option) => option.value)).toEqual(['10', '20']);
    change(element, 'economy.oreLoad', '20');
    expect(onChange.mock.calls[0]![0].economy.oreLoad).toBe(20);
    expect(typeof onChange.mock.calls[0]![0].economy.oreLoad).toBe('number');
  });

  it('presents speed under Match as execution-only and leaves gameplay rules/hash alone', () => {
    const onSpeedChange = vi.fn();
    const { element, onChange } = mount({ speed: 1, onSpeedChange, speedBounds: { min: 1, max: 20, default: 1 } });
    const before = hashRules(DEFAULT_RULES);
    expect(element.querySelector('[data-rule-group="match"] [data-rule-path="execution.speed"]')).not.toBeNull();
    change(element, 'execution.speed', '10');
    expect(onSpeedChange).toHaveBeenCalledWith(10);
    expect(onChange).not.toHaveBeenCalled();
    expect(hashRules(DEFAULT_RULES)).toBe(before);
    expect(element.textContent).toContain('Execution setting, not gameplay rules');
    click(element, 'Reset simulation speed');
    expect(onSpeedChange).toHaveBeenLastCalledWith(1);
    change(element, 'execution.speed', '8');
    click(element, 'Reset Match');
    expect(onSpeedChange).toHaveBeenLastCalledWith(1);
  });
});
