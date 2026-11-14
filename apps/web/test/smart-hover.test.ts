// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CELL, DEFAULT_RULES, sunHalfWidth, spirePositions, type Entity, type Plane, type UnitKind, type View } from '@agent-command/game/contract';
import { Controls, type ControlHost } from '../src/controls.ts';
import { CanvasCursor, CURSOR, SCROLL_CURSORS } from '../src/cursors.ts';
import { setKeyLayout } from '../src/keymap.ts';
import type { Overlay } from '../src/overlay.ts';
import { installTooltips, TOOLTIP_DELAY } from '../src/tooltip.ts';
import type { Track } from '../src/world/entities.ts';
import type { World } from '../src/world/world.ts';
import { TerrainField } from '../src/world/terrain.ts';

const cleanup: (() => void)[] = [];
let disposeTips: () => void;
beforeEach(() => {
  setKeyLayout('classic');
  installTooltips()();
  vi.useFakeTimers();
  disposeTips = installTooltips();
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  disposeTips();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const ent = (kind: string, id: string, plane: Plane, x: number, y: number, side = 'nw'): Entity =>
  ({ id, kind, side, plane, x, y, hp: 100, maxHp: 100, state: 'idle' }) as Entity;

/** Controls over a fake world whose pointer always rests on (8.25, 9.75) and picks `hovered`. */
function harness(plane: Plane, units: Entity[], seen: Entity[]) {
  const size = DEFAULT_RULES.map.size;
  const canvas = document.createElement('canvas');
  canvas.setPointerCapture = vi.fn();
  document.body.append(canvas);
  const tracks = new Map([...units, ...seen].map((e) => [e.id, { e, rx: e.x, ry: e.y, wy: 0 } as Track]));
  const world = {
    size, layers: { surface: { field: new TerrainField(size) } },
    selected: new Set<string>(), entities: { tracks }, lens: { show: vi.fn() },
    orbitAbilities: { aim: vi.fn() }, designations: { showPreview: vi.fn() },
    rig: { focus: plane, edge: { x: 0, y: 0 }, keys: new Set<string>() },
    pickTile: vi.fn(() => ({ x: 8.25, y: 9.75 })),
    groundPoint: vi.fn(() => ({ x: 8.25, y: 9.75 })),
    pickEntity: vi.fn((): Track | undefined => undefined),
    pointAt: vi.fn(), pointAway: vi.fn(),
  };
  const view = {
    army: 'nw', tick: 0, entities: [...units, ...seen], memory: [], holes: [],
    match: { rules: DEFAULT_RULES, sun: { half: sunHalfWidth(2) }, armies: (['nw', 'se'] as const).map((id, slot) => ({ id, slot, frame: slot * 2, colour: slot ? 'red' : 'blue', spireAt: spirePositions(DEFAULT_RULES.map.spireInset, size)[id] })) },
    sun: { angle: 0 }, res: { energy: 1000, alloy: 0, freeEnergy: 1000, freeAlloy: 0, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0, upkeepHeld: 0 }, research: { available: [], completed: [], inProgress: [], seen: [] },
    depths: Array<number>(size * size).fill(CELL.tunnel),
    designations: { normal: Array<number>(Math.ceil(size * size / 30)).fill(0), urgent: Array<number>(Math.ceil(size * size / 30)).fill(0) },
  } as unknown as View;
  const host = {
    view: () => view, act: vi.fn<ControlHost['act']>(async () => true), canQueue: () => true,
    toast: vi.fn(), goTo: vi.fn(), jumpTo: vi.fn(), toggleCommander: vi.fn(), pickDirective: vi.fn(), changed: vi.fn(), hint: vi.fn(),
  } satisfies ControlHost;
  const controls = new Controls(world as unknown as World, { canvas, cursor: new CanvasCursor(canvas), pings: [] } as unknown as Overlay, host);
  cleanup.push(() => controls.dispose());
  // Controls installs its own per-plane selection set on the world.
  for (const e of units) world.selected.add(e.id);
  const hover = (picked?: Entity, options: PointerEventInit = {}) => {
    world.pickEntity.mockReturnValue(picked && tracks.get(picked.id));
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 100, pointerId: 1, bubbles: true, ...options }));
  };
  const rightClick = (options: PointerEventInit = {}) => {
    const init = { clientX: 100, clientY: 100, pointerId: 1, button: 2, bubbles: true, ...options };
    canvas.dispatchEvent(new PointerEvent('pointerdown', init));
    canvas.dispatchEvent(new PointerEvent('pointerup', init));
  };
  const tipText = () => {
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    return document.querySelector<HTMLElement>('[role="tooltip"]:not([hidden])')?.textContent;
  };
  return { canvas, view, host, hover, rightClick, tipText, controls, world };
}
const unit = (kind: UnitKind, id: string, plane: Plane) => ent(kind, id, plane, 2, 3);

describe('smart right-click hover feedback', () => {
  it('shows the transfer cursor and "Descend" over an own Shaft, then sends that transfer', () => {
    const shaft = ent('shaft', 'shaft', 'surface', 8.5, 9.5);
    const h = harness('surface', [unit('trooper', 't', 'surface')], [shaft]);
    h.hover(shaft);
    expect(h.canvas.style.cursor).toBe(CURSOR.enter);
    expect(h.tipText()).toBe('Descend');
    h.rightClick();
    expect(h.host.act).toHaveBeenCalledWith('surface', [{ kind: 'transfer', units: ['t'], to: 'depths', x: 8.5, y: 9.5 }]);
  });

  it('Alt switches the hovered order to a plain move without a pointer move', () => {
    const shaft = ent('shaft', 'shaft', 'surface', 8.5, 9.5);
    const h = harness('surface', [unit('trooper', 't', 'surface')], [shaft]);
    h.hover(shaft);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true }));
    expect(h.canvas.style.cursor).toBe(CURSOR.move);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    expect(h.canvas.style.cursor).toBe(CURSOR.enter);
  });

  it('names grapple and capture, and shows the attack cursor only for enemies the team sees', () => {
    const rock = { ...ent('asteroid', 'rock', 'orbit', 8, 9, 'neutral'), state: 'drifting' } as Entity;
    const orbit = harness('orbit', [unit('tug', 'tug', 'orbit')], [rock]);
    orbit.hover(rock);
    expect(orbit.canvas.style.cursor).toBe(CURSOR.grapple);
    expect(orbit.tipText()).toBe('Grapple');
    const island = ent('island', 'isl', 'sky', 8, 9, 'neutral');
    const sky = harness('sky', [unit('interceptor', 'i', 'sky')], [island]);
    sky.hover(island);
    expect(sky.canvas.style.cursor).toBe(CURSOR.capture);
    expect(sky.tipText()).toBe('Capture');
    const enemy = ent('tank', 'enemy', 'surface', 8, 9, 'se');
    const surface = harness('surface', [unit('tank', 'tank', 'surface')], [enemy]);
    surface.hover(enemy);
    expect(surface.canvas.style.cursor).toBe(CURSOR.attack);
    surface.view.entities.splice(surface.view.entities.indexOf(enemy), 1);
    surface.hover(enemy);
    expect(surface.canvas.style.cursor).toBe(CURSOR.move);
  });

  it('shows the invalid cursor when the selection can do nothing there', () => {
    const h = harness('surface', [{ ...ent('turret', 'turret', 'surface', 2, 3) }], []);
    h.hover();
    expect(h.canvas.style.cursor).toBe(CURSOR.invalid);
    h.rightClick();
    expect(h.host.act).not.toHaveBeenCalled();
  });
});

describe('canvas cursor lifecycle', () => {
  it('writes the canvas cursor only on change and resets to the page cursor', () => {
    const style = { cursor: 'stale' };
    let writes = 0;
    const el = { style: { get cursor() { return style.cursor; }, set cursor(value: string) { writes++; style.cursor = value; } } };
    const cursor = new CanvasCursor(el);
    expect(style.cursor).toBe('');
    cursor.set(CURSOR.move); cursor.set(CURSOR.move);
    expect([style.cursor, writes]).toEqual([CURSOR.move, 2]);
    cursor.reset(); cursor.reset();
    expect([style.cursor, cursor.value, writes]).toEqual(['', '', 3]);
  });

  it('drops the edge-scroll arrow when the pointer leaves the canvas', () => {
    const h = harness('surface', [unit('tank', 'tank', 'surface')], []);
    h.hover(undefined, { clientY: 2 });
    expect(h.canvas.style.cursor).toBe(SCROLL_CURSORS[6]);
    expect(h.world.rig.edge).toEqual({ x: 0, y: -1 });
    h.canvas.dispatchEvent(new PointerEvent('pointerleave'));
    expect(h.canvas.style.cursor).toBe('');
    expect(h.world.rig.edge).toEqual({ x: 0, y: 0 });
    h.hover();
    expect(h.canvas.style.cursor).toBe(CURSOR.move);
  });

  it('leaves no armed order, edge-scroll arrow or pan behind when the controls are disposed', () => {
    const h = harness('surface', [unit('tank', 'tank', 'surface')], []);
    h.controls.arm({ kind: 'amove' });
    expect(h.canvas.style.cursor).toBe(CURSOR.attackMove);
    h.hover(undefined, { clientY: 2 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect([h.canvas.style.cursor, h.world.rig.keys.size]).toEqual([SCROLL_CURSORS[6], 1]);
    // A session ending with the pointer still on the canvas (the elimination hand-off, a world drop) sees no pointerleave.
    h.controls.dispose();
    expect(h.canvas.style.cursor).toBe('');
    expect(h.world.rig.edge).toEqual({ x: 0, y: 0 });
    expect(h.world.rig.keys.size).toBe(0);
  });
});
