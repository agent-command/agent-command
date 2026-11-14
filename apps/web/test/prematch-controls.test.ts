// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANDATE_PRESETS } from '@playerthree/connect';
import { mandateControls, seg } from '../src/commanders.ts';
import { MODES } from '../src/mandate.ts';
import { SettingsMenu } from '../src/settings.ts';
import type { PlaneMandate } from '../src/profile.ts';
import { keyLayout, setKeyLayout } from '../src/keymap.ts';
import { installTooltips } from '../src/tooltip.ts';


const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  setKeyLayout('classic');
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  installTooltips()();
  document.body.replaceChildren();
  setKeyLayout('classic');
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('commander controls', () => {
  it('uses named native toggle buttons rather than radios without arrow navigation', () => {
    const pick = vi.fn();
    const group = seg('Surface stance', ['defend', 'attack'], { defend: 'Defend', attack: 'Attack' }, 'defend', pick);
    document.body.append(group);
    expect(group.getAttribute('role')).toBe('group');
    const buttons = group.querySelectorAll('button');
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1]!.tabIndex).toBe(0);
    buttons[1]!.focus();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Surface stance: Attack');
    buttons[0]!.click();
    expect(pick).not.toHaveBeenCalled();
    buttons[1]!.click();
    expect(pick).toHaveBeenCalledWith('attack');
  });

  it('preserves mandate and scope changes while abbreviating explanatory copy', () => {
    const mandate: PlaneMandate = { ...MANDATE_PRESETS.autonomous, whenAbsent: 'bot', directive: { stance: 'defend', focusX: 12, focusY: 20 }, limits: { asteroidDrops: true, collapses: true } };
    const change = vi.fn();
    const controls = mandateControls('surface', 'agent', MANDATE_PRESETS.autonomous.scopes, mandate, change);
    const modeIndex = MODES.findIndex((mode) => mode !== 'autonomous');
    controls.querySelectorAll<HTMLButtonElement>('[aria-label="Surface mode"] button')[modeIndex]!.click();
    const preset = MANDATE_PRESETS[MODES[modeIndex]!];
    expect(change).toHaveBeenLastCalledWith({ ...mandate, autonomy: preset.autonomy }, [...preset.scopes]);
    const hold = [...controls.querySelectorAll<HTMLButtonElement>('[aria-label="Surface when away"] button')].find((button) => button.textContent === 'Hold')!;
    hold.click();
    expect(change).toHaveBeenLastCalledWith({ ...mandate, whenAbsent: 'hold' });
    document.body.append(controls);
    const attack = [...controls.querySelectorAll('button')].find((button) => button.textContent === 'Attack')!;
    attack.click();
    expect(change).toHaveBeenLastCalledWith({ ...mandate, directive: { ...mandate.directive, stance: 'attack' } });
    const limit = controls.querySelector<HTMLInputElement>('input[aria-label="Surface Collapses"]')!;
    limit.checked = false;
    limit.dispatchEvent(new Event('change', { bubbles: true }));
    expect(change).toHaveBeenLastCalledWith({ ...mandate, limits: { asteroidDrops: true, collapses: false } });
    const manual = mandateControls('surface', 'human', [], mandate, change);
    expect(manual.textContent?.trim()).toBe('Manual');
    expect(manual.querySelector('[data-tip]')?.getAttribute('data-tip')).toContain('You fly this plane');
    const disabled = mandateControls('surface', 'agent', MANDATE_PRESETS.autonomous.scopes, mandate, change, true);
    expect([...disabled.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    expect(disabled.querySelector('fieldset')?.disabled).toBe(true);
  });
});

describe('settings keyboard access', () => {
  it('moves focus inside, updates key hints, and closes on Escape with focus restored', () => {
    const menu = new SettingsMenu();
    cleanup.push(() => menu.dispose());
    document.body.append(menu.el);
    const button = menu.el.querySelector('button')!;
    const box = menu.el.querySelector('input')!;
    const pop = menu.el.querySelector<HTMLElement>('[role="dialog"]')!;
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(pop.id);
    expect(document.activeElement).toBe(box);
    box.click();
    expect(keyLayout()).toBe('wasd');
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Z attack-move');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(pop.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('keeps instance IDs unique and closes when focus leaves or the outside is clicked', () => {
    const first = new SettingsMenu();
    const second = new SettingsMenu({ up: true });
    cleanup.push(() => first.dispose(), () => second.dispose());
    document.body.append(first.el, second.el);
    const firstButton = first.el.querySelector('button')!;
    const secondButton = second.el.querySelector('button')!;
    expect(firstButton.getAttribute('aria-controls')).not.toBe(secondButton.getAttribute('aria-controls'));
    firstButton.click();
    secondButton.focus();
    expect(firstButton.getAttribute('aria-expanded')).toBe('false');
    secondButton.click();
    document.body.click();
    expect(secondButton.getAttribute('aria-expanded')).toBe('false');
  });
});

