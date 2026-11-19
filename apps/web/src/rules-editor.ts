/**
 * Lobby match-rules editor generated from the game's rules schema (RULE_FIELDS/RULE_GROUPS/RULE_PRESETS): no
 * field-specific forms. Every edit passes checkRules before onChange; simulation speed is an execution setting
 * outside the rules hash.
 */
import {
  RULE_FIELDS, RULE_GROUPS, RULE_PRESETS, checkRules, diffRules, hashRules,
  resolveRulesPreset, ruleValue, rulesOptions,
  type RuleField, type RuleGroup, type RuleValue, type Rules,
} from '@agent-command/game/contract';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import './rules-editor.css';

export interface RulesEditorState {
  rules: Rules;
  disabled?: boolean;
  /** Authored/named maps own their recipe; show it, but do not pretend it is editable. */
  mapEditable?: boolean;
  speed?: number;
  /** Registry-provided legal numeric choices, e.g. a selected map descriptor's supported sizes. */
  choices?: Readonly<Record<string, readonly number[]>>;
}
export interface RulesEditorOptions extends RulesEditorState {
  onChange(rules: Rules): void;
  onSpeedChange?(speed: number): void;
  speedBounds?: { min: number; max: number; step?: number; default?: number };
}
export interface RulesEditor {
  element: HTMLElement;
  update(state: RulesEditorState): void;
  destroy(): void;
}

function assignRule(rules: Rules, path: readonly string[], value: RuleValue): void {
  let target: unknown = rules;
  for (const key of path.slice(0, -1)) target = (target as Record<string, unknown>)[key];
  (target as Record<string, unknown>)[path.at(-1)!] = typeof value === 'object' ? structuredClone(value) : value;
}
/** Immutable editing is shared by scalar, list-item, field-reset and group-reset controls. */
export function editRule(rules: Rules, path: readonly string[], value: RuleValue): Rules {
  const copy = structuredClone(rules);
  assignRule(copy, path, value);
  return copy;
}
export function resetRuleGroup(rules: Rules, group: RuleGroup): Rules {
  const next = structuredClone(rules);
  for (const field of RULE_FIELDS) if (field.group === group) assignRule(next, field.path, field.defaultValue);
  return next;
}

function formatted(value: RuleValue): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function fieldBounds(field: RuleField, choices: readonly (string | number)[] | undefined = field.choices): string {
  if (choices) return choices.join(' / ');
  if (field.kind === 'list') return `0–${field.max} entries`;
  if (field.kind === 'bool') return 'On / Off';
  return `${field.min}–${field.max}${field.unit ? ` ${field.unit}` : ''}`;
}

/** No field-specific forms: the resolved rules schema supplies every control, list and bound. */
export function createRulesEditor(options: RulesEditorOptions): RulesEditor {
  const element = h('section', { class: 'rules-editor', 'aria-label': 'Match rules' });
  let state: RulesEditorState = { ...options };
  let error = '';
  const open = new Set<string>();
  /** Each group's controls rebuild only when its own values, lock or choices change; an edit touches one group, not ~400 controls. */
  const groups = new Map<string, { key: string; element: HTMLDetailsElement }>();
  const advanced = h('details', { class: 'rules-editor__advanced' }, h('summary', {}, icon('settings'), 'Advanced rules'));
  let lastKey = '';

  function commit(next: Rules): boolean {
    if (state.disabled) return false;
    const checked = checkRules(rulesOptions(next));
    if (!checked.ok) {
      error = checked.error;
      // Rejected input stays in its control; rebuilding restores every control to the accepted rules.
      groups.clear();
      render();
      return false;
    }
    error = '';
    state = { ...state, rules: next };
    render();
    options.onChange(next);
    return true;
  }
  function button(label: string, action: () => void, disabled: boolean): HTMLButtonElement {
    return h('button', { type: 'button', class: 'rules-editor__reset', disabled, 'data-tip': label, onclick: action }, icon('queue_moved'), label);
  }
  function control(field: RuleField, path: readonly string[], value: RuleValue, locked: boolean): HTMLElement {
    const key = path.join('.');
    const choices = state.choices?.[key] ?? field.choices;
    const inputId = `rule-${instance}-${key}`;
    let input: HTMLInputElement | HTMLSelectElement;
    if (field.kind === 'bool') {
      input = h('input', { id: inputId, type: 'checkbox', disabled: locked, 'data-rule-path': key });
      input.checked = value as boolean;
      input.addEventListener('change', () => commit(editRule(state.rules, path, (input as HTMLInputElement).checked)));
    } else if (choices) {
      input = h('select', { id: inputId, disabled: locked, 'data-rule-path': key },
        ...choices.map((choice) => h('option', { value: choice }, choice)));
      input.value = String(value);
      input.addEventListener('change', () => commit(editRule(state.rules, path, field.kind === 'enum' ? input.value : Number(input.value))));
    } else {
      input = h('input', {
        id: inputId, type: 'number', min: field.min, max: field.max, step: field.kind === 'int' ? 1 : 'any',
        disabled: locked, 'data-rule-path': key,
      });
      input.value = String(value);
      input.addEventListener('change', () => {
        const number = input as HTMLInputElement;
        if (!number.checkValidity() || number.value === '') {
          error = `${field.label}: enter ${field.kind === 'int' ? 'an integer' : 'a number'} within ${fieldBounds(field, choices)}.`;
          groups.clear();
          render();
          return;
        }
        commit(editRule(state.rules, path, number.valueAsNumber));
      });
    }
    const boundsId = `${inputId}-bounds`;
    input.setAttribute('aria-describedby', boundsId);
    const changed = formatted(value) !== formatted(field.defaultValue);
    return h('div', { class: `rules-editor__field${changed ? ' rules-editor__field--changed' : ''}` },
      h('label', { for: inputId, 'data-tip': field.description }, field.label),
      h('div', { class: 'rules-editor__value' }, input, field.unit ? h('span', { class: 'rules-editor__unit' }, field.unit) : null,
        button(`Reset ${field.label}`, () => commit(editRule(state.rules, path, field.defaultValue)), locked)),
      h('small', { id: boundsId }, `Standard: ${formatted(field.defaultValue)} · Bounds: ${fieldBounds(field, choices)}`));
  }
  function list(field: RuleField, locked: boolean): HTMLElement {
    const values = ruleValue(state.rules, field.path) as readonly RuleValue[];
    // A list of scalars (map.contestedPosts) has one child at the item itself (`*`); object lists have one per key.
    const scalar = field.children?.length === 1 && field.children[0]!.path.at(-1) === '*';
    const body = h('fieldset', { class: 'rules-editor__list', 'data-rule-list': field.path.join('.') },
      h('legend', { 'data-tip': field.description }, field.label),
      h('small', {}, `Standard: ${formatted(field.defaultValue)} · Bounds: ${fieldBounds(field)}`));
    values.forEach((value, index) => {
      const row = h('fieldset', { class: 'rules-editor__list-item' }, h('legend', {}, `${field.label} ${index + 1}`));
      for (const child of field.children ?? []) {
        const path = child.path.map((key) => key === '*' ? String(index) : key);
        row.append(control(child, path, scalar ? value : (value as Record<string, RuleValue>)[child.path.at(-1)!]!, locked));
      }
      row.append(button(`Remove entry ${index + 1}`, () => {
        commit(editRule(state.rules, field.path, values.filter((_, i) => i !== index)));
      }, locked));
      body.append(row);
    });
    const template = scalar ? field.children![0]!.defaultValue
      : Object.fromEntries((field.children ?? []).map((child) => [child.path.at(-1)!, child.defaultValue]));
    body.append(button('Add entry', () => commit(editRule(state.rules, field.path, [...values, template])), locked || values.length >= field.max!),
      button(`Reset ${field.label}`, () => commit(editRule(state.rules, field.path, field.defaultValue)), locked));
    return body;
  }
  function speedControl(): HTMLElement | null {
    if (!options.onSpeedChange || state.speed === undefined || !options.speedBounds) return null;
    const bounds = options.speedBounds;
    const input = h('input', {
      type: 'number', min: bounds.min, max: bounds.max, step: bounds.step ?? 1,
      disabled: state.disabled, 'data-rule-path': 'execution.speed', id: `rule-${instance}-speed`,
    });
    input.value = String(state.speed);
    input.addEventListener('change', () => {
      if (state.disabled || !input.checkValidity() || input.value === '') return;
      const speed = input.valueAsNumber;
      state = { ...state, speed };
      render();
      options.onSpeedChange!(speed);
    });
    return h('div', { class: 'rules-editor__field' },
      h('label', { for: input.id }, 'Simulation speed'),
      h('div', { class: 'rules-editor__value' }, input, h('span', {}, '× real time'),
        button('Reset simulation speed', () => {
          state = { ...state, speed: bounds.default ?? 1 };
          render();
          options.onSpeedChange!(state.speed!);
        }, !!state.disabled)),
      h('small', {}, `Execution setting, not gameplay rules; does not change the rules hash. Default: ${bounds.default ?? 1}×. Bounds: ${bounds.min}–${bounds.max}×.`));
  }
  function render(): void {
    const focused = element.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.rulePath : undefined;
    const diffs = diffRules(state.rules);
    // The lobby owns terrain and map size (and an authored map's whole recipe), and the server applies a preset under
    // them; match and apply presets the same way, or any preset immediately reads back as "Custom".
    const asApplied = (rules: Rules): Rules => ({ ...rules, terrain: state.rules.terrain,
      map: state.mapEditable === false ? state.rules.map : { ...rules.map, size: state.rules.map.size } });
    const selected = RULE_PRESETS.find((preset) => hashRules(asApplied(preset.rules)) === hashRules(state.rules));
    const presets = h('select', { 'aria-label': 'Rules preset', disabled: state.disabled, 'data-rule-path': 'preset' },
      h('option', { value: 'custom', disabled: true }, 'Custom'),
      ...RULE_PRESETS.map((preset) => h('option', { value: preset.id }, preset.label)));
    presets.value = selected?.id ?? 'custom';
    presets.addEventListener('change', () => {
      commit(asApplied(resolveRulesPreset(presets.value)));
    });
    const choicesKey = JSON.stringify(state.choices);
    advanced.replaceChildren(advanced.firstElementChild!, ...RULE_GROUPS.map((group) => {
      const locked = !!state.disabled || (group.id === 'map' && state.mapEditable === false);
      const fields = GROUP_FIELDS.get(group.id)!;
      const key = JSON.stringify([locked, state.mapEditable, choicesKey, group.id === 'match' ? state.speed : undefined, fields.map((field) => ruleValue(state.rules, field.path))]);
      const cached = groups.get(group.id);
      if (cached?.key === key) return cached.element;
      const details = h('details', { class: 'rules-editor__group', 'data-rule-group': group.id },
        h('summary', {}, group.label, h('span', { class: 'rules-editor__count' }, `${diffs.filter((diff) => diff.field.group === group.id).length} changed`)));
      details.open = open.has(group.id);
      details.addEventListener('toggle', () => { if (details.open) open.add(group.id); else open.delete(group.id); });
      const content = h('div', { class: 'rules-editor__group-content' },
        button(`Reset ${group.label}`, () => {
          if (commit(resetRuleGroup(state.rules, group.id)) && group.id === 'match' && options.onSpeedChange && options.speedBounds && state.speed !== undefined) {
            state = { ...state, speed: options.speedBounds.default ?? 1 };
            render();
            options.onSpeedChange(state.speed!);
          }
        }, locked));
      if (group.id === 'map' && state.mapEditable === false) content.append(h('p', {}, 'This authored map owns its recipe. Choose a generated map to edit these values.'));
      let section = '';
      for (const field of fields) {
        if (section !== field.section) { section = field.section; content.append(h('h4', {}, section)); }
        content.append(field.kind === 'list' ? list(field, locked) : control(field, field.path, ruleValue(state.rules, field.path), locked));
      }
      if (group.id === 'match') {
        const speed = speedControl();
        if (speed) content.append(speed);
      }
      details.append(content);
      groups.set(group.id, { key, element: details });
      return details;
    }));
    element.replaceChildren(
      h('div', { class: 'rules-editor__header' }, h('label', {}, 'Rules preset ', presets),
        h('span', { class: `rules-editor__badge${diffs.length ? ' rules-editor__badge--custom' : ''}` }, diffs.length ? 'Custom · Unranked' : 'Standard · Guarded')),
      h('p', { class: 'rules-editor__description' }, selected?.description ?? 'Custom rules are not covered by default balance claims.'),
      h('p', { class: 'rules-editor__notice' }, 'Rules and execution changes clear lobby readiness. Rules apply equally to every side.'),
      ...(state.speed !== undefined ? [h('p', { class: 'rules-editor__notice' }, `Execution: ${state.speed}× real time · separate from gameplay rules.`)] : []),
      h('div', { class: 'rules-editor__error', role: 'alert' }, error),
      h('section', { class: 'rules-editor__diff', 'aria-label': 'Changes from Standard' },
        h('h4', {}, `Changes from Standard · ${diffs.length}`),
        diffs.length ? h('ul', {}, ...diffs.map((diff) => h('li', {},
          h('strong', {}, `${RULE_GROUPS.find((group) => group.id === diff.field.group)!.label} · ${diff.field.section} · ${diff.field.label}`),
          h('span', {}, `${formatted(diff.standard)} → ${formatted(diff.value)}${diff.field.unit ? ` ${diff.field.unit}` : ''}`))))
          : h('p', {}, 'No gameplay changes.')),
      advanced);
    lastKey = `${hashRules(state.rules)}:${state.disabled}:${state.mapEditable}:${state.speed}:${JSON.stringify(state.choices)}`;
    if (focused) for (const target of element.querySelectorAll<HTMLElement>('[data-rule-path]')) {
      if (target.dataset.rulePath === focused) { target.focus({ preventScroll: true }); break; }
    }
  }
  const instance = ++editorSerial;
  render();
  return {
    element,
    update(next) {
      const key = `${hashRules(next.rules)}:${next.disabled}:${next.mapEditable}:${next.speed}:${JSON.stringify(next.choices)}`;
      state = { ...next };
      if (key === lastKey) return;
      error = '';
      render();
    },
    destroy() { element.remove(); },
  };
}
let editorSerial = 0;
const GROUP_FIELDS = new Map(RULE_GROUPS.map((group) => [group.id, RULE_FIELDS.filter((field) => field.group === group.id)]));
