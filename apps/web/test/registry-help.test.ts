import { describe, expect, it } from 'vitest';
import { PLANES } from '@agent-command/game/contract';
import { commandFor, planeToolHelp, setKeyLayout, type KeyLayout } from '../src/keymap.ts';
import { LENS_PEEK_META, TOOL_META } from '../src/tools/catalog.ts';

const LAYOUTS: KeyLayout[] = ['classic', 'wasd'];

describe('registry-backed plane help', () => {
  it.each(LAYOUTS)('%s: help includes exactly the plane’s registered commands and current shortcuts', (layout) => {
    for (const plane of PLANES) {
      const help = planeToolHelp(plane, layout);
      const registered = [...TOOL_META, LENS_PEEK_META].filter((tool) => tool.id !== 'default' && tool.planes.includes(plane));
      expect(help.map((tool) => tool.id)).toEqual(registered.map((tool) => tool.id));
      for (const [index, tool] of registered.entries()) {
        expect(help[index]).toEqual({ id: tool.id, label: tool.label, hint: tool.hint, key: tool.hotkey?.[layout].toUpperCase() });
        if (help[index]!.key) expect(commandFor(help[index]!.key!.toLowerCase(), layout)).toBe(tool.id);
      }
    }
  });

  it('keeps plane-specific commands out of unrelated help', () => {
    const depths = ['designate', 'mine', 'fortify', 'bulkhead', 'geothermal', 'undermine', 'breach', 'rail', 'bridge'];
    for (const plane of PLANES) {
      const planeIds = planeToolHelp(plane, 'classic').map((tool) => tool.id);
      for (const id of depths) expect(planeIds.includes(id)).toBe(plane === 'depths');
      expect(planeIds.includes('build')).toBe(plane === 'surface' || plane === 'sky');
      expect(planeIds.includes('relay')).toBe(plane === 'sky');
      expect(planeIds.includes('deorbit')).toBe(plane === 'orbit');
      expect(planeIds.includes('transfer')).toBe(plane === 'surface' || plane === 'depths');
      for (const id of ['amove', 'move', 'patrol', 'stop', 'hold', 'scan', 'rally', 'pick']) expect(planeIds).toContain(id);
      expect(planeIds).not.toContain('default');
    }
  });

  it.each(LAYOUTS)('%s: documents projected cross-plane attack and both interim peek directions', (layout) => {
    for (const plane of PLANES) {
      const help = planeToolHelp(plane, layout);
      expect(help.find((tool) => tool.id === 'lensAttack')).toMatchObject({ label: 'Cross-plane attack', key: 'O' });
      const peek = help.find((tool) => tool.id === 'peek')!;
      expect(peek.key).toBe('Y');
      expect(peek.hint).toContain('no selection needed');
      expect(peek.hint).toContain('Shift reverses Surface/Sky direction');
      expect(peek.hint).toContain('Depths → Surface');
      expect(peek.hint).toContain('Orbit → Sky');
    }
  });

  it.each(LAYOUTS)('%s: explains direct Depths designation while retaining the Dig shortcut', (layout) => {
    const dig = planeToolHelp('depths', layout).find((tool) => tool.id === 'designate')!;
    expect(dig.key).toBe('J');
    expect(dig.hint).toContain('right-drag 2+ tiles for normal tags');
    expect(dig.hint).toContain('Shift urgent');
    expect(dig.hint).toContain('Alt clear');
    expect(dig.hint).toContain('no selection needed');
    expect(dig.hint).toContain('selected diggers work the box immediately');
    expect(dig.hint).toContain('armed tool: left-drag, Alt/Ctrl clear, Esc or right-click cancels');
  });

  it('keeps selection and contextual clicks distinct from designation gestures', () => {
    const hint = TOOL_META.find((tool) => tool.id === 'default')!.hint;
    expect(hint).toContain('Click or left-drag to select');
    expect(hint).toContain('right-click: the order the cursor shows');
    expect(hint).toContain('Alt+right-click bypasses contextual orders');
    expect(hint).toContain('Ctrl+right-click for Depths abilities');
  });

  it('includes mouse-only tools without inventing shortcut labels', () => {
    for (const [plane, id] of [['surface', 'build'], ['sky', 'relay'], ['orbit', 'pick']] as const) {
      const tool = planeToolHelp(plane).find((tool) => tool.id === id);
      expect(tool).toBeDefined();
      expect(tool!.label.length).toBeGreaterThan(0);
      expect(tool!.hint.length).toBeGreaterThan(0);
      expect(tool!.key).toBeUndefined();
    }
  });

  it('uses the current camera layout when help is rebuilt', () => {
    try {
      setKeyLayout('wasd');
      const wasd = planeToolHelp('orbit');
      expect(wasd.find((tool) => tool.id === 'amove')!.key).toBe('Z');
      expect(wasd.find((tool) => tool.id === 'stop')!.key).toBe('X');
      expect(wasd.find((tool) => tool.id === 'deorbit')!.key).toBe('V');
      setKeyLayout('classic');
      const classic = planeToolHelp('orbit');
      expect(classic.find((tool) => tool.id === 'amove')!.key).toBe('A');
      expect(classic.find((tool) => tool.id === 'stop')!.key).toBe('S');
      expect(classic.find((tool) => tool.id === 'deorbit')!.key).toBe('D');
    } finally {
      setKeyLayout('classic');
    }
  });
});
