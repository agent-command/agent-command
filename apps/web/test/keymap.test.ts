import { describe, expect, it } from 'vitest';
import { FIXED_KEYS, commandFor, keyLabel, keyLayout, keymap, onKeyLayout, panFor, panKeys, setKeyLayout, type KeyCommand, type KeyLayout } from '../src/keymap.ts';
import { LENS_PEEK_META, TOOL_META } from '../src/tools/catalog.ts';

const LAYOUTS: KeyLayout[] = ['classic', 'wasd'];

describe('key layouts', () => {
  it.each(LAYOUTS)('%s: every command has its own key, clear of panning and fixed keys', (layout) => {
    const keys = Object.values(keymap(layout));
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) {
      expect(panFor(k, layout)).toBeUndefined();
      expect(FIXED_KEYS).not.toContain(k);
    }
    for (const k of panKeys(layout)) expect(commandFor(k, layout)).toBeUndefined();
    for (const [cmd, k] of Object.entries(keymap(layout))) expect(commandFor(k, layout)).toBe(cmd);
  });

  it.each(LAYOUTS)('%s: every tool shortcut comes from registry metadata', (layout) => {
    const tools = [...TOOL_META, LENS_PEEK_META].filter((tool) => tool.hotkey);
    expect(new Set(TOOL_META.map((tool) => tool.id)).size).toBe(TOOL_META.length);
    expect(Object.keys(keymap(layout)).sort()).toEqual([...tools.map((tool) => tool.id), 'idle', 'diveDown', 'diveUp'].sort());
    for (const tool of tools) {
      const key = tool.hotkey![layout];
      expect(commandFor(key, layout)).toBe(tool.id);
      expect(keyLabel(tool.id as KeyCommand, layout)).toBe(key.toUpperCase());
    }
    for (const tool of TOOL_META.filter((tool) => !tool.hotkey)) expect(keymap(layout)).not.toHaveProperty(tool.id);
  });

  it('classic: arrows pan, A attack-move, S stop, D deorbit', () => {
    expect(panKeys('classic').sort()).toEqual(['arrowdown', 'arrowleft', 'arrowright', 'arrowup']);
    expect([commandFor('a', 'classic'), commandFor('s', 'classic'), commandFor('d', 'classic'), commandFor('w', 'classic')]).toEqual(['amove', 'stop', 'deorbit', undefined]);
  });

  it('wasd: W A S D pan with the arrows; the displaced commands sit right below them (Z X V); the rest stay', () => {
    expect([panFor('w', 'wasd'), panFor('a', 'wasd'), panFor('s', 'wasd'), panFor('d', 'wasd'), panFor('arrowup', 'wasd')]).toEqual(['up', 'left', 'down', 'right', 'up']);
    expect([keyLabel('amove', 'wasd'), keyLabel('stop', 'wasd'), keyLabel('deorbit', 'wasd')]).toEqual(['Z', 'X', 'V']);
    const moved = ['amove', 'stop', 'deorbit'];
    for (const [cmd, k] of Object.entries(keymap('classic'))) if (!moved.includes(cmd)) expect(keymap('wasd')[cmd as KeyCommand]).toBe(k);
  });

  it.each(LAYOUTS)('%s: J is Dig without displacing any Depths or orbital verb', (layout) => {
    expect(commandFor('j', layout)).toBe('designate');
    expect(keyLabel('designate', layout)).toBe('J');
    expect(['g', 'f', 'u', 'b', 'l', 'n', 'k', 't', 'c'].map((key) => commandFor(key, layout)))
      .toEqual(['mine', 'fortify', 'undermine', 'breach', 'rail', 'bridge', 'bulkhead', 'transfer', 'scan']);
  });

  it.each(LAYOUTS)('%s: O arms Lens attack and Y holds peek without taking Q/E navigation', (layout) => {
    expect(commandFor('o', layout)).toBe('lensAttack');
    expect(commandFor('y', layout)).toBe('peek');
    expect(commandFor('q', layout)).toBe('diveDown');
    expect(commandFor('e', layout)).toBe('diveUp');
    expect(commandFor('i', layout)).toBe('idle');
    expect(commandFor(';', layout)).toBe('release');
  });

  it.each(LAYOUTS)('%s: comma aims Sun lance and period activates Aegis without replacing Depths commands', (layout) => {
    expect(commandFor(',', layout)).toBe('sun_lance');
    expect(commandFor('.', layout)).toBe('aegis');
    expect(commandFor('f', layout)).toBe('fortify');
    expect(commandFor('g', layout)).toBe('mine');
  });

  it('the setting defaults to classic and notifies on change', () => {
    expect(keyLayout()).toBe('classic');
    const seen: KeyLayout[] = [];
    const off = onKeyLayout((l) => seen.push(l));
    setKeyLayout('wasd');
    setKeyLayout('wasd');
    expect(keyLabel('stop')).toBe('X');
    setKeyLayout('classic');
    off();
    setKeyLayout('wasd');
    expect(seen).toEqual(['wasd', 'classic']);
    setKeyLayout('classic');
  });
});
