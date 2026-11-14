// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { View } from '@agent-command/game/contract';
import { Controls, type ControlHost } from '../src/controls.ts';
import { CanvasCursor } from '../src/cursors.ts';
import { setKeyLayout } from '../src/keymap.ts';
import type { Overlay } from '../src/overlay.ts';
import { ProductionTabs } from '../src/production-tabs.ts';
import { installTooltips } from '../src/tooltip.ts';
import { CameraRig } from '../src/world/camera.ts';
import type { World } from '../src/world/world.ts';

const cleanup: (() => void)[] = [];
beforeEach(() => setKeyLayout('wasd'));
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  installTooltips()();
  document.body.replaceChildren();
  setKeyLayout('classic');
});

function harness() {
  const canvas = document.createElement('canvas');
  const rig = new CameraRig(48);
  const world = {
    rig, selected: new Set<string>(), entities: { tracks: new Map() }, lens: { show: vi.fn() }, designations: { showPreview: vi.fn() },
  };
  const host = {
    view: () => undefined, act: vi.fn<ControlHost['act']>(async () => true), canQueue: () => true,
    toast: vi.fn(), goTo: vi.fn(), jumpTo: vi.fn(), toggleCommander: vi.fn(), pickDirective: vi.fn(),
    changed: vi.fn(), hint: vi.fn(), onChatKey: vi.fn(),
  } satisfies ControlHost;
  const controls = new Controls(world as unknown as World, { canvas, cursor: new CanvasCursor(canvas) } as Overlay, host);
  cleanup.push(() => controls.dispose());
  const view = { queue: [], research: { available: [], completed: [], inProgress: [], seen: [] } } satisfies Pick<View, 'queue' | 'research'>;
  const tabs = new ProductionTabs(() => tabs.update('surface', view));
  tabs.update('surface', view);
  document.body.append(canvas, tabs.el);
  const button = tabs.el.querySelector<HTMLButtonElement>('[role="tab"]')!;
  const clickHud = () => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    // happy-dom does not perform the browser's pointer-focus default action.
    button.focus();
    button.click();
    expect(document.activeElement).toBe(button);
  };
  return { rig, host, tabs, button, clickHud };
}

function key(target: EventTarget, value: string, type: 'keydown' | 'keyup' = 'keydown') {
  const event = new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('game hotkeys after HUD focus', () => {
  it('clicks a production HUD button, presses W, and applies real camera pan', () => {
    const h = harness();
    h.clickHud();
    const tx = h.rig.tx;
    const tz = h.rig.tz;
    expect(key(h.button, 'w').defaultPrevented).toBe(true);
    expect(h.rig.keys.has('up')).toBe(true);
    h.rig.update(16, 1 / 60, 0);
    expect(Math.hypot(h.rig.tx - tx, h.rig.tz - tz)).toBeGreaterThan(0);
    key(h.button, 'w', 'keyup');
    expect(h.rig.keys.size).toBe(0);
  });

  it.each(['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])('keeps %s panning after a mouse-focused category button', (value) => {
    const h = harness();
    h.clickHud();
    key(h.button, value);
    h.rig.update(16, 1 / 60, 0);
    expect(Math.hypot(h.rig.tx, h.rig.tz)).toBeGreaterThan(0);
    expect(h.tabs.state.get('surface').id).toBe('units');
    key(h.button, value, 'keyup');
    expect(h.rig.keys.size).toBe(0);
  });

  it('keeps classic camera arrows working after a HUD click', () => {
    setKeyLayout('classic');
    const h = harness();
    h.clickHud();
    key(h.button, 'ArrowRight');
    h.rig.update(16, 1 / 60, 0);
    expect(Math.hypot(h.rig.tx, h.rig.tz)).toBeGreaterThan(0);
    expect(h.tabs.state.get('surface').id).toBe('units');
  });

  it('routes plane and commander shortcuts from the focused HUD button', () => {
    const h = harness();
    h.clickHud();
    key(h.button, 'q');
    key(h.button, 'e');
    key(h.button, 'F1');
    expect(h.host.goTo.mock.calls).toEqual([['depths'], ['sky'], ['depths']]);
    key(h.button, '`');
    expect(h.host.toggleCommander).toHaveBeenCalledOnce();
  });

  it('leaves Space, Enter and Tab defaults intact on focused buttons', () => {
    const h = harness();
    h.clickHud();
    const home = vi.spyOn(h.rig, 'lookAtTile');
    for (const value of [' ', 'Enter', 'Tab']) expect(key(h.button, value).defaultPrevented).toBe(false);
    expect(h.host.onChatKey).not.toHaveBeenCalled();
    expect(home).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(h.button);
  });

  it.each(['input', 'textarea', 'select', 'contenteditable'] as const)('leaves game keys with %s focus', (kind) => {
    const h = harness();
    const editor = document.createElement(kind === 'contenteditable' ? 'div' : kind);
    let target: HTMLElement = editor;
    if (kind === 'contenteditable') {
      editor.setAttribute('contenteditable', 'true');
      editor.tabIndex = 0;
      target = document.createElement('span');
      editor.append(target);
    }
    document.body.append(editor);
    editor.focus();
    expect(document.activeElement).toBe(editor);
    for (const value of ['w', 'ArrowUp', 'q', 'e', '`', 'Enter']) expect(key(target, value).defaultPrevented).toBe(false);
    h.rig.update(16, 1 / 60, 0);
    expect(h.rig.tx).toBe(0);
    expect(h.rig.tz).toBe(0);
    expect(h.host.goTo).not.toHaveBeenCalled();
    expect(h.host.toggleCommander).not.toHaveBeenCalled();
    expect(h.host.onChatKey).not.toHaveBeenCalled();
  });

  it('stops held camera pan when focus enters a text field and accepts its keyup', () => {
    const h = harness();
    h.clickHud();
    key(h.button, 'w');
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(h.rig.keys.size).toBe(0);
    h.rig.update(16, 1 / 60, 0);
    expect(h.rig.tx).toBe(0);
    expect(h.rig.tz).toBe(0);
    key(input, 'w', 'keyup');
    expect(h.rig.keys.size).toBe(0);
  });
});
