// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CELL, DEFAULT_RULES, PLANES, sunHalfWidth, spirePositions, type Entity, type Plane, type UnitKind, type View } from '@agent-command/game/contract';
import { CommandCard } from '../src/command-card.ts';
import { Controls, type ControlHost } from '../src/controls.ts';
import { CanvasCursor } from '../src/cursors.ts';
import { setKeyLayout } from '../src/keymap.ts';
import type { Overlay } from '../src/overlay.ts';
import { installTooltips } from '../src/tooltip.ts';
import type { OrbitFormation } from '../src/tools/index.ts';
import type { Track } from '../src/world/entities.ts';
import type { World } from '../src/world/world.ts';
import { TerrainField } from '../src/world/terrain.ts';

const cleanup: (() => void)[] = [];
beforeEach(() => setKeyLayout('classic'));
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  installTooltips()();
  document.body.replaceChildren();
  setKeyLayout('classic');
});

function ship(kind: UnitKind, id: string = kind, plane: Plane = 'orbit'): Entity {
  return { id, kind, side: 'nw', plane, x: 2, y: 3, state: 'idle' } as Entity;
}

function harness(units = [ship('lancer'), ship('tug')], plane: Plane = 'orbit') {
  const size = DEFAULT_RULES.map.size;
  const canvas = document.createElement('canvas');
  canvas.setPointerCapture = vi.fn();
  const commandCard = new CommandCard();
  const card = commandCard.el;
  document.body.append(canvas, card);
  cleanup.push(() => commandCard.dispose());
  const tracks = new Map(units.map((e) => [e.id, { e, rx: e.x, ry: e.y, wy: 0 } as Track]));
  const world = {
    size, layers: { surface: { field: new TerrainField(size) } },
    selected: new Set<string>(), entities: { tracks }, lens: { show: vi.fn() },
    orbitAbilities: { aim: vi.fn() },
    designations: { showPreview: vi.fn() },
    rig: { focus: plane, edge: { x: 0, y: 0 }, keys: new Set<string>() },
    pickTile: vi.fn(() => ({ x: 8.25, y: 9.75 })),
    groundPoint: vi.fn(() => ({ x: 8.25, y: 9.75 })),
    pickEntity: vi.fn((): Track | undefined => undefined),
  };
  const view = {
    army: 'nw', tick: 0, entities: units, memory: [], match: { rules: DEFAULT_RULES, sun: { half: sunHalfWidth(2) }, armies: (['nw', 'se'] as const).map((id, slot) => ({ id, slot, frame: slot * 2, colour: slot ? 'red' : 'blue', spireAt: spirePositions(DEFAULT_RULES.map.spireInset, size)[id] })) }, holes: [],
    sun: { angle: 0 }, res: { energy: 1000, alloy: 0, freeEnergy: 1000, freeAlloy: 0, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0, upkeepHeld: 0 }, queue: [], research: { available: [], completed: [], inProgress: [], seen: [] }, spire: [], islands: [],
    depths: Array<number>(size * size).fill(CELL.tunnel),
    designations: { normal: Array<number>(Math.ceil(size * size / 30)).fill(0), urgent: Array<number>(Math.ceil(size * size / 30)).fill(0) },
  } as unknown as View;
  const host = {
    view: () => view, act: vi.fn<ControlHost['act']>(async () => true), canQueue: () => true,
    toast: vi.fn(), goTo: vi.fn(), jumpTo: vi.fn(), toggleCommander: vi.fn(), pickDirective: vi.fn(), changed: vi.fn(), hint: vi.fn(),
  } satisfies ControlHost;
  const controls = new Controls(world as unknown as World, { canvas, cursor: new CanvasCursor(canvas), pings: [] } as unknown as Overlay, host);
  cleanup.push(() => controls.dispose());
  for (const e of units) world.selected.add(e.id);
  const render = () => commandCard.update(controls.cardActions(), '#c79bff');
  render();
  const button = (label: string) => {
    const el = card.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(el, label).not.toBeNull();
    return el!;
  };
  /** Choose a formation (a no-op when it is already the active one: clicking that clears it). */
  const selectFormation = (formation: OrbitFormation) => {
    const el = button(`${formation[0]!.toUpperCase()}${formation.slice(1)} formation`);
    if (el.getAttribute('aria-pressed') !== 'true') el.click();
    render();
  };
  const clickMap = (button = 0, options: PointerEventInit = {}) => {
    const init = { clientX: 100, clientY: 100, pointerId: 1, button, bubbles: true, ...options };
    canvas.dispatchEvent(new PointerEvent('pointerdown', init));
    canvas.dispatchEvent(new PointerEvent('pointerup', init));
  };
  return { controls, world, view, host, card, button, render, selectFormation, clickMap };
}

describe('Orbit formation command card', () => {
  it('renders three named icon toggles, none chosen by default, with rich keyboard tooltips', () => {
    const h = harness();
    const group = h.card.querySelector('[role="group"][aria-label="Orbit formation"]')!;
    expect(group.querySelectorAll('button')).toHaveLength(3);
    for (const formation of ['wedge', 'line', 'escort'] as const) {
      const button = h.button(`${formation[0]!.toUpperCase()}${formation.slice(1)} formation`);
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(button.querySelector(`.icon-formation_${formation}`)).not.toBeNull();
      expect(button.hasAttribute('title')).toBe(false);
      button.focus();
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(formation === 'escort' ? 'preferring a tug or solar array' : 'slowest ship');
    }
    h.selectFormation('line');
    expect(h.button('Line formation').getAttribute('aria-pressed')).toBe('true');
    expect(h.button('Wedge formation').getAttribute('aria-pressed')).toBe('false');
    h.selectFormation('escort');
    expect(h.button('Escort formation').getAttribute('aria-pressed')).toBe('true');
    expect(h.button('Line formation').getAttribute('aria-pressed')).toBe('false');
    // Clicking the active formation clears it: back to per-ship slots.
    h.button('Escort formation').click();
    h.render();
    expect(h.button('Escort formation').getAttribute('aria-pressed')).toBe('false');
    expect(h.host.act).not.toHaveBeenCalled();
  });

  it('sends a plain move without a chosen formation (the server gives each ship its own slot)', () => {
    const h = harness();
    h.clickMap(2);
    expect(h.host.act).toHaveBeenLastCalledWith('orbit', [{ kind: 'move', units: ['lancer', 'tug'], x: 8.25, y: 9.75, mode: 'move' }]);
  });

  it.each(['wedge', 'line', 'escort'] as const)('sends %s on contextual right-click and Alt-right-click moves', (formation) => {
    const h = harness();
    h.selectFormation(formation);
    for (const altKey of [false, true]) {
      h.clickMap(2, { shiftKey: true, altKey });
      expect(h.host.act).toHaveBeenLastCalledWith('orbit', [{
        kind: 'move', units: ['lancer', 'tug'], x: 8.25, y: 9.75, mode: 'move', formation,
        ...(formation === 'escort' ? { escort: 'tug' } : {}), queue: true,
      }]);
    }
  });

  it.each(['wedge', 'line', 'escort'] as const)('uses %s for command-card and hotkey move/fight orders', (formation) => {
    const h = harness();
    for (const [label, key, mode] of [['Move', 'm', 'move'], ['Attack-move', 'a', 'fight']] as const) {
      for (const viaHotkey of [false, true]) {
        if (viaHotkey) window.dispatchEvent(new KeyboardEvent('keydown', { key }));
        else h.button(label).click();
        // Changing formation after arming must update the already-active tool session.
        h.selectFormation(formation);
        h.clickMap(0, { shiftKey: true });
        expect(h.host.act).toHaveBeenLastCalledWith('orbit', [{
          kind: 'move', units: ['lancer', 'tug'], x: 8.25, y: 9.75, mode, formation,
          ...(formation === 'escort' ? { escort: 'tug' } : {}), queue: true,
        }]);
        h.controls.arm(undefined);
      }
    }
  });

  it.each(['tug', 'solar'] as const)('prefers the selected %s over a warship as escort anchor', (civilian) => {
    const h = harness([ship('lancer'), ship(civilian)]);
    h.selectFormation('escort');
    h.clickMap(2);
    expect(h.host.act.mock.calls[0]?.[1][0]).toMatchObject({ formation: 'escort', escort: civilian });
  });

  it('falls back to a selected warship without reading an unselected civilian', () => {
    const h = harness([ship('lancer', 'first'), ship('lancer', 'second')]);
    const civilian = ship('solar', 'unselected');
    h.view.entities.push(civilian);
    h.world.entities.tracks.set(civilian.id, { e: civilian } as Track);
    h.selectFormation('escort');
    h.clickMap(2);
    expect(h.host.act.mock.calls[0]?.[1][0]).toMatchObject({ formation: 'escort', escort: 'first' });
    expect(h.world.pickEntity).toHaveBeenCalledTimes(1);
  });

  it('hides the selector and drops formation on a single-ship order, restoring it for a fleet', () => {
    const h = harness([ship('lancer', 'first'), ship('lancer', 'second')]);
    h.selectFormation('escort');
    h.world.selected.delete('second');
    h.render();
    expect(h.card.querySelector('[aria-label="Orbit formation"]')).toBeNull();
    h.clickMap(2);
    expect(h.host.act).toHaveBeenLastCalledWith('orbit', [{ kind: 'move', units: ['first'], x: 8.25, y: 9.75, mode: 'move' }]);
    h.world.selected.add('second');
    h.render();
    expect(h.button('Escort formation').getAttribute('aria-pressed')).toBe('true');
    h.world.selected.clear();
    h.render();
    expect(h.card.querySelector('[aria-label="Orbit formation"]')).toBeNull();
  });

  it.each(PLANES.filter((plane) => plane !== 'orbit'))('leaves %s movement unchanged after choosing an Orbit formation', (plane) => {
    const h = harness();
    h.selectFormation('escort');
    h.world.rig.focus = plane;
    h.controls.onPlane(plane);
    for (const id of ['one', 'two']) {
      const e = ship(plane === 'sky' ? 'interceptor' : 'trooper', id, plane);
      h.world.entities.tracks.set(id, { e, rx: e.x, ry: e.y, wy: 0 } as Track);
      h.world.selected.add(id);
    }
    h.render();
    expect(h.card.querySelector('[aria-label="Orbit formation"]')).toBeNull();
    h.clickMap(2);
    expect(h.host.act).toHaveBeenLastCalledWith(plane, [{ kind: 'move', units: ['one', 'two'], x: 8.25, y: 9.75, mode: 'move' }]);
    h.world.rig.focus = 'orbit';
    h.controls.onPlane('orbit');
    h.render();
    expect(h.button('Escort formation').getAttribute('aria-pressed')).toBe('true');
  });

  it('leaves patrol orders unchanged', () => {
    const h = harness();
    h.selectFormation('escort');
    h.button('Patrol').click();
    h.clickMap(0, { shiftKey: true });
    expect(h.host.act).toHaveBeenCalledWith('orbit', [{ kind: 'patrol', units: ['lancer', 'tug'], x: 8.25, y: 9.75, queue: true }]);
  });
});
