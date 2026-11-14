import { afterEach, describe, expect, it, vi } from 'vitest';
import { CELL, DEFAULT_RULES, spirePositions, type Entity, type View } from '@agent-command/game/contract';
import { PerspectiveCamera } from 'three';
import { CanvasCursor, CURSOR } from '../src/cursors.ts';
import { Controls, type ControlHost } from '../src/controls.ts';
import { digArea, digCount, digPriority, digRect, digTagged } from '../src/designate.ts';
import type { Overlay } from '../src/overlay.ts';
import type { World } from '../src/world/world.ts';
import type * as Tooltip from '../src/tooltip.ts';
import { pointTip } from '../src/tooltip.ts';

// This harness owns only the input EventTarget boundary; shared tooltip DOM behaviour has its own happy-dom tests.
vi.mock('../src/tooltip.ts', async (original) => ({
  ...(await original<typeof Tooltip>()),
  pointTip: vi.fn(),
}));

const plain = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.unstubAllGlobals();
});

describe('dig rectangle and packed tags', () => {
  it('includes both endpoints, snaps fractional coordinates and handles every drag direction', () => {
    const expected = { x0: 3, y0: 4, x1: 7, y1: 9 };
    for (const [start, end] of [
      [{ x: 3.2, y: 4.9 }, { x: 7.8, y: 9.1 }],
      [{ x: 7.8, y: 9.1 }, { x: 3.2, y: 4.9 }],
      [{ x: 7.8, y: 4.9 }, { x: 3.2, y: 9.1 }],
      [{ x: 3.2, y: 9.1 }, { x: 7.8, y: 4.9 }],
    ] as const) expect(digRect(start, end, 48)).toEqual(expected);
    expect(digArea(expected)).toBe(30);
    expect(digArea(digRect({ x: 2.8, y: 3.1 }, { x: 2.8, y: 3.1 }, 48)!)).toBe(1);
  });

  it('clips a drag leaving the map, but rejects a missed ground ray', () => {
    expect(digRect({ x: 2, y: 3 }, { x: -10, y: 100 }, 48)).toEqual({ x0: 0, y0: 3, x1: 2, y1: 47 });
    expect(digRect({ x: 2, y: 3 }, { x: NaN, y: 3 }, 48)).toBeUndefined();
  });

  it('makes clear override urgent and never interprets Shift as queueing', () => {
    expect(digPriority(plain)).toBe(1);
    expect(digPriority({ ...plain, shiftKey: true })).toBe(2);
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey'])
      expect(digPriority({ ...plain, shiftKey: true, [modifier]: true })).toBe(0);
  });

  it('decodes 30-bit words across boundaries and counts each team tag once', () => {
    const size = DEFAULT_RULES.map.size;
    const tags = { normal: Array<number>(Math.ceil(size * size / 30)).fill(0), urgent: Array<number>(Math.ceil(size * size / 30)).fill(0) };
    for (const i of [0, 29, 30, 59, 60, size * size - 1]) tags.normal[Math.floor(i / 30)]! |= 1 << (i % 30);
    tags.urgent[1] = 1;
    expect(digCount(tags, size)).toBe(6);
    for (const i of [0, 29, 30, 59, 60, size * size - 1]) expect(digTagged(tags.normal, i)).toBe(true);
    for (const i of [1, 28, 31, 58, 61]) expect(digTagged(tags.normal, i)).toBe(false);
  });
});

/** DOM event boundary only; the actual Controls implementation handles every gesture. */
function harness(limit = 256) {
  const size = DEFAULT_RULES.map.size;
  const win = new EventTarget();
  vi.stubGlobal('window', win);
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('innerWidth', 1000);
  vi.stubGlobal('innerHeight', 1000);
  const canvas = Object.assign(new EventTarget(), { setPointerCapture: vi.fn(), style: { cursor: '' } });
  const rig = { focus: 'depths', edge: { x: 0, y: 0 }, keys: new Set(), rotate: vi.fn(), zoom: vi.fn(), lookAtTile: vi.fn(), camera: { position: { x: 0, y: 60, z: 0 } } };
  const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(0, 60, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  rig.camera = camera;
  const world = {
    size,
    rig,
    viewport: { left: 0, top: 0, width: 1000, height: 1000 },
    selected: new Set<string>(),
    entities: { tracks: new Map() },
    designations: { showPreview: vi.fn() },
    lens: { show: vi.fn() },
    groundPoint: (x: number, y: number) => ({ x, y }),
    project: (x: number, _height: number, z: number) => ({ x: x + size / 2, y: z + size / 2, behind: false }),
    pickTile: (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size ? { x, y } : undefined,
    pickEntity: () => undefined,
    pointAt: vi.fn(),
    pointAway: vi.fn(),
  };
  const view = {
    army: 'nw', tick: 0, rulesHash: 0, entities: [], research: { completed: [] }, depths: Array<number>(size * size).fill(CELL.unknown), holes: [],
    res: { energy: 1000, alloy: 1000, freeEnergy: 1000, freeAlloy: 1000, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0, upkeepHeld: 0, scanReadyAt: 0 },
    designations: { normal: Array<number>(Math.ceil(size * size / 30)).fill(0), urgent: Array<number>(Math.ceil(size * size / 30)).fill(0) },
    match: {
      rulesHash: 0, armies: (['nw', 'se'] as const).map((id, slot) => ({ id, slot, frame: slot * 2, colour: slot ? 'red' : 'blue', spireAt: spirePositions(DEFAULT_RULES.map.spireInset, size)[id] })),
      rules: { ...structuredClone(DEFAULT_RULES), depths: { ...DEFAULT_RULES.depths, designateCells: limit, designateMax: 512 } },
    },
  } as unknown as View;
  const host = {
    view: () => view,
    act: vi.fn(async () => true),
    canQueue: () => true,
    toast: vi.fn(), changed: vi.fn(), hint: vi.fn(), goTo: vi.fn(), jumpTo: vi.fn(),
    toggleCommander: vi.fn(), pickDirective: vi.fn(), onPing: vi.fn(),
  } satisfies ControlHost;
  const overlay = { canvas, cursor: new CanvasCursor(canvas), pings: [], preview: undefined, drag: undefined, contacts: undefined as Overlay['contacts'] };
  const controls = new Controls(world as unknown as World, overlay as unknown as Overlay, host);
  disposals.push(() => controls.dispose());
  const pointer = (type: string, x: number, y: number, extra = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, plain, { clientX: x, clientY: y, pointerId: 1, button: 0 }, extra);
    canvas.dispatchEvent(event);
  };
  const key = (key: string, extra = {}, type = 'keydown') => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, plain, { key, code: `Key${key.toUpperCase()}`, repeat: false }, extra);
    win.dispatchEvent(event);
  };
  return { controls, world, host, canvas, win, overlay, pointer, key, view };
}

describe('Depths Dig controls', () => {
  it('J arms without a selection, sends an inclusive reverse box as the human seat and stays armed', () => {
    const h = harness();
    h.key('j');
    h.pointer('pointerdown', 7.9, 9.9);
    h.pointer('pointermove', 3.1, 4.1);
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 3, y0: 4, x1: 7, y1: 9 }, 1, true);
    h.pointer('pointerup', 3.1, 4.1);
    expect(h.host.act).toHaveBeenLastCalledWith('surface', [{ kind: 'designate', rect: { x0: 3, y0: 4, x1: 7, y1: 9 }, priority: 1 }]);
    expect(h.controls.armed).toEqual({ kind: 'designate' });
    h.pointer('pointerdown', 12, 13);
    h.pointer('pointerup', 12, 13, { shiftKey: true });
    expect(h.host.act).toHaveBeenLastCalledWith('surface', [{ kind: 'designate', rect: { x0: 12, y0: 13, x1: 12, y1: 13 }, priority: 2 }]);
  });

  it.each(['altKey', 'ctrlKey', 'metaKey'])('%s clears instead of rotating, pinging or selecting', (modifier) => {
    const h = harness();
    h.controls.arm({ kind: 'designate' });
    const mods = { [modifier]: true, shiftKey: true };
    h.pointer('pointerdown', 3, 4, mods);
    h.pointer('pointermove', 4, 5, mods);
    h.pointer('pointerup', 4, 5, mods);
    expect(h.host.act).toHaveBeenCalledWith('surface', [{ kind: 'designate', rect: { x0: 3, y0: 4, x1: 4, y1: 5 }, priority: 0 }]);
    expect(h.world.rig.rotate).not.toHaveBeenCalled();
    expect(h.host.onPing).not.toHaveBeenCalled();
    expect(h.overlay.drag).toBeUndefined();
    expect(h.world.selected.size).toBe(0);
  });

  it('updates urgent/clear preview when modifiers change without moving the mouse', () => {
    const h = harness();
    h.key('j');
    h.pointer('pointerdown', 2, 3);
    h.pointer('pointermove', 4, 5);
    h.key('Shift', { shiftKey: true });
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 2, y0: 3, x1: 4, y1: 5 }, 2, true);
    h.key('Alt', { altKey: true, shiftKey: true });
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 2, y0: 3, x1: 4, y1: 5 }, 0, true);
    h.key('Alt', {}, 'keyup');
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 2, y0: 3, x1: 4, y1: 5 }, 1, true);
  });

  it('shows the match drag limit and rejects an oversized box without clipping its plan', () => {
    const h = harness(4);
    h.key('j');
    h.pointer('pointerdown', 2, 3);
    h.pointer('pointermove', 4, 5);
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 2, y0: 3, x1: 4, y1: 5 }, 1, false);
    expect(h.host.hint).toHaveBeenLastCalledWith(expect.stringContaining('9/4 cells — box too large'));
    h.pointer('pointerup', 4, 5);
    expect(h.host.act).not.toHaveBeenCalled();
    expect(h.host.toast).toHaveBeenCalledWith('Dig box exceeds 4 cells; choose a smaller box');
  });

  it.each(['escape', 'plane', 'pointercancel', 'lostpointercapture', 'blur'])('%s cancels an in-flight drag without an order', (action) => {
    const h = harness();
    h.key('j');
    h.pointer('pointerdown', 2, 3);
    if (action === 'escape') h.key('Escape');
    else if (action === 'plane') {
      h.world.rig.focus = 'surface';
      h.controls.onPlane('surface');
    } else if (action === 'blur') h.win.dispatchEvent(new Event('blur'));
    else h.canvas.dispatchEvent(new Event(action));
    h.pointer('pointerup', 4, 5);
    expect(h.host.act).not.toHaveBeenCalled();
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith();
  });

  it('right-click cancels, key repeats do not toggle, and the tool cannot arm outside Depths', () => {
    const h = harness();
    h.key('j');
    h.key('j', { repeat: true });
    expect(h.controls.armed?.kind).toBe('designate');
    h.pointer('pointerdown', 2, 3, { button: 2 });
    h.pointer('pointerup', 2, 3, { button: 2 });
    expect(h.controls.armed).toBeUndefined();
    h.world.rig.focus = 'surface';
    h.key('j');
    h.controls.arm({ kind: 'designate' });
    expect(h.controls.armed).toBeUndefined();
    expect(h.host.act).not.toHaveBeenCalled();
  });

  it('does not begin outside the map and clips an in-map drag at the boundary', () => {
    const h = harness();
    h.key('j');
    h.pointer('pointerdown', -1, 2);
    h.pointer('pointerup', 3, 4);
    expect(h.host.act).not.toHaveBeenCalled();
    h.pointer('pointerdown', 46, 46);
    h.pointer('pointerup', 70, 70);
    expect(h.host.act).toHaveBeenCalledWith('surface', [{ kind: 'designate', rect: { x0: 46, y0: 46, x1: 47, y1: 47 }, priority: 1 }]);
  });

  it('preserves explicit right-click digging, Shift queueing, mine and Alt ping outside Dig', () => {
    const h = harness();
    const e = { id: 'digger_1', kind: 'digger', side: 'nw', plane: 'depths', x: 2, y: 3 } as Entity;
    h.world.entities.tracks.set(e.id, { e });
    h.world.selected.add(e.id);
    // Clear of blue's Spire footprint, where a right-click is a portal action rather than a dig or move.
    h.pointer('pointerdown', 14, 15, { button: 2 });
    h.pointer('pointerup', 14, 15, { button: 2, shiftKey: true });
    expect(h.host.act).toHaveBeenCalledWith('depths', [{ kind: 'dig', units: [e.id], x: 14, y: 15, queue: true }]);
    h.key('g');
    expect(h.host.act).toHaveBeenLastCalledWith('depths', [{ kind: 'mine', units: [e.id] }]);
    h.pointer('pointerdown', 14, 15, { altKey: true });
    h.pointer('pointerup', 14, 15, { altKey: true });
    expect(h.host.onPing).toHaveBeenCalledWith({ plane: 'depths', x: 14, y: 15 });
  });
});

describe('default right-drag designation controls', () => {
  it('keeps the default tool unarmed and previews only an actual two-cell gesture', () => {
    const h = harness();
    h.pointer('pointermove', 2.1, 3.1);
    h.pointer('pointerdown', 2.1, 3.1, { button: 2 });
    h.pointer('pointermove', 2.9, 3.9, { button: -1 });
    expect(h.world.designations.showPreview).not.toHaveBeenCalled();
    h.pointer('pointermove', 3, 3.9, { button: -1 });
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 2, y0: 3, x1: 3, y1: 3 }, 1, true);
    expect(h.overlay.drag).toBeUndefined();
    expect(h.controls.armed).toBeUndefined();
    h.key('Shift', { shiftKey: true });
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 2, y0: 3, x1: 3, y1: 3 }, 2, true);
    h.key('Alt', { shiftKey: true, altKey: true });
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 2, y0: 3, x1: 3, y1: 3 }, 0, true);
    h.pointer('pointerup', 3, 3.9, { button: 2, shiftKey: true, altKey: true });
    expect(h.host.act).toHaveBeenCalledWith('depths', [{ kind: 'designate', rect: { x0: 2, y0: 3, x1: 3, y1: 3 }, priority: 0 }]);
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith();
    expect(h.host.onPing).not.toHaveBeenCalled();
    expect(h.world.rig.rotate).not.toHaveBeenCalled();
  });

  it('dispatches immediate nonqueued digs only for selected diggers, preserving mixed selection', () => {
    const h = harness();
    const digger = { id: 'digger_1', kind: 'digger', side: 'nw', plane: 'depths', x: 2.5, y: 3.5 } as Entity;
    const trooper = { ...digger, id: 'trooper_1', kind: 'trooper' } as Entity;
    for (const e of [digger, trooper]) {
      h.world.entities.tracks.set(e.id, { e });
      h.world.selected.add(e.id);
    }
    h.view.depths.fill(CELL.tunnel);
    h.view.depths[3 * h.world.size + 3] = CELL.rock;
    h.pointer('pointerdown', 3, 3, { button: 2 });
    h.pointer('pointerup', 4, 3, { button: 2, shiftKey: true });
    expect(h.host.act).toHaveBeenCalledWith('depths', [
      { kind: 'designate', rect: { x0: 3, y0: 3, x1: 4, y1: 3 }, priority: 2 },
      { kind: 'dig', units: [digger.id], x: 3, y: 3 },
    ]);
    expect([...h.world.selected]).toEqual([digger.id, trooper.id]);
    h.pointer('pointerdown', 3, 3, { button: 2, altKey: true });
    h.pointer('pointerup', 4, 3, { button: 2, altKey: true });
    expect(h.host.act).toHaveBeenLastCalledWith('depths', [{ kind: 'designate', rect: { x0: 3, y0: 3, x1: 4, y1: 3 }, priority: 0 }]);
  });

  it.each(['escape', 'plane', 'pointercancel', 'lostpointercapture', 'blur', 'arm'])('%s cancels a genuine right-drag without falling back to context', (action) => {
    const h = harness();
    const e = { id: 'digger_1', kind: 'digger', side: 'nw', plane: 'depths', x: 2, y: 3 } as Entity;
    h.world.entities.tracks.set(e.id, { e });
    h.world.selected.add(e.id);
    h.pointer('pointerdown', 2, 3, { button: 2 });
    h.pointer('pointermove', 4, 5, { button: -1 });
    if (action === 'escape') h.key('Escape');
    else if (action === 'plane') {
      h.world.rig.focus = 'surface';
      h.controls.onPlane('surface');
    } else if (action === 'blur') h.win.dispatchEvent(new Event('blur'));
    else if (action === 'arm') h.key('j');
    else h.canvas.dispatchEvent(new Event(action));
    h.pointer('pointerup', 4, 5, { button: 2 });
    expect(h.host.act).not.toHaveBeenCalled();
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith();
    expect(h.overlay.drag).toBeUndefined();
  });

  it('keeps captured drags alive across pointerleave and does no frame-time pointer or terrain work', () => {
    const h = harness();
    h.pointer('pointerdown', 46, 46, { button: 2 });
    h.pointer('pointermove', 70, 70, { button: -1 });
    h.canvas.dispatchEvent(new Event('pointerleave'));
    const count = h.world.designations.showPreview.mock.calls.length;
    h.controls.frame();
    expect(h.world.designations.showPreview).toHaveBeenCalledTimes(count);
    h.pointer('pointerup', 70, 70, { button: 2 });
    expect(h.host.act).toHaveBeenCalledWith('depths', [{ kind: 'designate', rect: { x0: 46, y0: 46, x1: 47, y1: 47 }, priority: 1 }]);
  });

  it.each(['surface', 'sky', 'orbit'] as const)('suppresses right-drag context on %s while retaining a plain right-click', (plane) => {
    const h = harness();
    h.world.rig.focus = plane;
    h.controls.onPlane(plane);
    const e = { id: 'crew', kind: 'trooper', side: 'nw', plane, x: 2, y: 3 } as Entity;
    h.world.entities.tracks.set(e.id, { e });
    h.world.selected.add(e.id);
    h.pointer('pointerdown', 14, 15, { button: 2 });
    h.pointer('pointermove', 16, 15, { button: -1 });
    h.pointer('pointerup', 14, 15, { button: 2 });
    expect(h.host.act).not.toHaveBeenCalled();
    h.pointer('pointerdown', 14, 15, { button: 2 });
    h.pointer('pointerup', 14, 15, { button: 2 });
    expect(h.host.act).toHaveBeenCalledWith(plane, [{ kind: 'move', units: [e.id], x: 14, y: 15, mode: 'move' }]);
  });

  it('keeps Alt right-click a pure move and ordinary left-drag a selection box', () => {
    const h = harness();
    const e = { id: 'digger_1', kind: 'digger', side: 'nw', plane: 'depths', x: 2, y: 3 } as Entity;
    h.world.entities.tracks.set(e.id, { e });
    h.world.selected.add(e.id);
    h.pointer('pointerdown', 4, 5, { button: 2, altKey: true });
    h.pointer('pointerup', 4, 5, { button: 2, altKey: true });
    expect(h.host.act).toHaveBeenCalledWith('depths', [{ kind: 'move', units: [e.id], x: 4, y: 5, mode: 'move' }]);
    h.world.entities.tracks.clear();
    h.host.act.mockClear();
    h.pointer('pointerdown', 2, 3);
    h.pointer('pointermove', 20, 30, { button: -1 });
    expect(h.overlay.drag).toEqual({ x0: 2, y0: 3, x1: 20, y1: 30 });
    h.pointer('pointerup', 20, 30);
    expect(h.overlay.drag).toBeUndefined();
    expect(h.host.act).not.toHaveBeenCalled();
  });
});

describe('explicit contacts and interim peek controls', () => {
  it('arms Cross-plane attack only for cross-plane weapons and cancels with Esc/right-click without an order', () => {
    const h = harness();
    h.world.rig.focus = 'surface';
    h.controls.onPlane('surface');
    h.key('o');
    expect(h.controls.armed).toBeUndefined();
    const flak = { id: 'flak_1', kind: 'flak', side: 'nw', plane: 'surface', x: 2, y: 3 } as Entity;
    h.world.entities.tracks.set(flak.id, { e: flak });
    h.world.selected.add(flak.id);
    h.pointer('pointermove', 20, 20);
    h.key('o');
    expect(h.controls.armed?.kind).toBe('lensAttack');
    expect(h.canvas.style.cursor).toBe(CURSOR.invalid);
    expect(h.overlay.contacts).toMatchObject({ active: true, source: 'surface' });
    expect(h.overlay.contacts?.planes.has('sky')).toBe(true);
    expect(h.world.lens.show).not.toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
    h.key('o', { repeat: true });
    expect(h.controls.armed?.kind).toBe('lensAttack');
    h.key('Escape');
    expect(h.controls.armed).toBeUndefined();
    expect(h.overlay.contacts).toBeUndefined();
    h.key('o');
    h.pointer('pointerdown', 20, 20, { button: 2 });
    h.pointer('pointerup', 20, 20, { button: 2 });
    expect(h.controls.armed).toBeUndefined();
    expect(h.overlay.contacts).toBeUndefined();
    expect(h.host.act).not.toHaveBeenCalled();
  });

  it('shows contacts without pointer motion and keeps them armed after an invalid click releases capture', () => {
    const h = harness();
    h.world.rig.focus = 'surface';
    h.controls.onPlane('surface');
    const flak = { id: 'flak_1', kind: 'flak', side: 'nw', plane: 'surface', x: 2, y: 3 } as Entity;
    h.world.entities.tracks.set(flak.id, { e: flak });
    h.world.selected.add(flak.id);
    h.key('o');
    expect(h.overlay.contacts).toMatchObject({ active: true, source: 'surface' });
    h.pointer('pointerdown', 20, 20);
    h.pointer('pointerup', 20, 20);
    h.pointer('lostpointercapture', 20, 20);
    h.controls.frame();
    expect(h.controls.armed?.kind).toBe('lensAttack');
    expect(h.overlay.contacts?.active).toBe(true);
    expect(h.canvas.style.cursor).toBe(CURSOR.invalid);
    expect(h.host.act).not.toHaveBeenCalled();
  });

  it.each([
    ['depths', false, 'surface'], ['surface', false, 'sky'], ['sky', false, 'surface'], ['orbit', false, 'sky'],
    ['surface', true, 'depths'], ['sky', true, 'orbit'],
  ] as const)('holds Y on %s with reverse=%s to peek at %s without units', (source, reverse, target) => {
    const h = harness();
    h.world.rig.focus = source;
    h.controls.onPlane(source);
    h.pointer('pointermove', 20, 20);
    expect(h.world.lens.show).not.toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
    h.key('y', { shiftKey: reverse });
    expect(pointTip).toHaveBeenLastCalledWith(undefined);
    expect(h.controls.armed).toBeUndefined();
    expect(h.world.lens.show).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, source, target }));
    h.key('y', {}, 'keyup');
    expect(h.world.lens.show).toHaveBeenLastCalledWith();
    expect(h.host.act).not.toHaveBeenCalled();
  });

  it('changes peek direction with held Shift and closes on blur, Escape and right-click', () => {
    const h = harness();
    h.world.rig.focus = 'sky';
    h.controls.onPlane('sky');
    h.pointer('pointermove', 20, 20);
    h.key('y');
    h.key('Shift', { shiftKey: true });
    expect(h.world.lens.show).toHaveBeenLastCalledWith(expect.objectContaining({ target: 'orbit' }));
    h.key('Shift', {}, 'keyup');
    expect(h.world.lens.show).toHaveBeenLastCalledWith(expect.objectContaining({ target: 'surface' }));
    h.key('Escape');
    expect(h.world.lens.show).toHaveBeenLastCalledWith();
    h.key('y', { repeat: true });
    expect(h.world.lens.show).toHaveBeenLastCalledWith();
    h.key('y');
    h.pointer('pointerdown', 20, 20, { button: 2 });
    h.pointer('pointerup', 20, 20, { button: 2 });
    expect(h.world.lens.show).toHaveBeenLastCalledWith();
    h.key('y');
    h.win.dispatchEvent(new Event('blur'));
    expect(h.world.lens.show).toHaveBeenLastCalledWith();
    expect(h.host.act).not.toHaveBeenCalled();
  });
});

describe('registry input dispatch', () => {
  it('routes ordinary order hotkeys and keeps a newer tool armed when an older order succeeds', async () => {
    const h = harness();
    const e = { id: 'trooper_1', kind: 'trooper', side: 'nw', plane: 'depths', x: 2, y: 3 } as Entity;
    h.world.entities.tracks.set(e.id, { e });
    h.world.selected.add(e.id);
    h.key('m');
    h.pointer('pointerdown', 4, 5);
    h.pointer('pointerup', 4, 5);
    expect(h.host.act).toHaveBeenCalledWith('depths', [{ kind: 'move', units: [e.id], x: 4, y: 5, mode: 'move' }]);
    h.key('p');
    await Promise.resolve();
    expect(h.controls.armed?.kind).toBe('patrol');
    h.pointer('pointerdown', 6, 7);
    h.pointer('pointerup', 6, 7, { shiftKey: true });
    await Promise.resolve();
    expect(h.controls.armed?.kind).toBe('patrol');
    expect(h.host.act).toHaveBeenLastCalledWith('depths', [{ kind: 'patrol', units: [e.id], x: 6, y: 7, queue: true }]);
  });

  it('keeps selection-free targeting hotkeys and their selection guidance', () => {
    const h = harness();
    h.key('f');
    expect(h.controls.armed?.kind).toBe('fortify');
    h.pointer('pointerdown', 4, 5);
    h.pointer('pointerup', 4, 5);
    expect(h.host.toast).toHaveBeenLastCalledWith('Select diggers or Wardens first');
    h.key('u');
    expect(h.controls.armed?.kind).toBe('undermine');
    h.pointer('pointerdown', 4, 5);
    h.pointer('pointerup', 4, 5);
    expect(h.host.toast).toHaveBeenLastCalledWith('Select sappers first');
    h.world.rig.focus = 'orbit';
    h.controls.onPlane('orbit');
    h.key('d');
    expect(h.controls.armed?.kind).toBe('deorbit');
    h.pointer('pointerdown', 4, 5);
    h.pointer('pointerup', 4, 5);
    expect(h.host.toast).toHaveBeenLastCalledWith('Select a towing tug first');
    expect(h.host.act).not.toHaveBeenCalled();
  });

  it('uses tool plane eligibility and preserves scan/focus navigation callbacks', () => {
    const h = harness();
    h.controls.arm({ kind: 'relay' });
    expect(h.controls.armed).toBeUndefined();
    h.controls.arm({ kind: 'build', structure: 'turret' });
    expect(h.controls.armed).toBeUndefined();
    h.key('c');
    h.world.rig.focus = 'sky';
    h.controls.onPlane('sky');
    expect(h.controls.armed?.kind).toBe('scan');
    h.pointer('pointerdown', 4, 5);
    h.pointer('pointerup', 4, 5);
    expect(h.host.act).toHaveBeenLastCalledWith('orbit', [{ kind: 'scan', x: 4, y: 5 }]);
    h.controls.arm({ kind: 'pick', role: 'depths' });
    h.world.rig.focus = 'surface';
    h.controls.onPlane('surface');
    h.pointer('pointerdown', 6, 7);
    h.pointer('pointerup', 6, 7);
    expect(h.host.pickDirective).toHaveBeenCalledWith('depths', 6, 7);
    expect(h.controls.armed).toBeUndefined();
  });

  it('does not complete an old selection gesture on a different plane', () => {
    const h = harness();
    h.pointer('pointerdown', 2, 3);
    h.pointer('pointermove', 20, 30);
    h.world.rig.focus = 'sky';
    h.controls.onPlane('sky');
    h.host.changed.mockClear();
    h.pointer('pointerup', 20, 30);
    expect(h.host.act).not.toHaveBeenCalled();
    expect(h.overlay.drag).toBeUndefined();
    expect(h.host.changed).not.toHaveBeenCalled();
  });

  it('uses the release point for modifier-only previews after a completed drag', () => {
    const h = harness();
    h.key('j');
    h.pointer('pointerdown', 2, 3);
    h.pointer('pointerup', 6, 7);
    h.key('Shift', { shiftKey: true });
    expect(h.world.designations.showPreview).toHaveBeenLastCalledWith({ x0: 6, y0: 7, x1: 6, y1: 7 }, 2, true);
  });
});
