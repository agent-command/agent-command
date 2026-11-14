import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGame } from '@agent-command/game';
import type { Entity } from '@agent-command/game/contract';
import { ContactOverlay } from '../src/contact-overlay.ts';
import { configureContacts, createContacts } from '../src/tools/contacts.ts';
import { SIDE_HEX } from '../src/world/common.ts';
import { UNIT_PAINT } from '../src/world/palette.ts';
import type { Track } from '../src/world/entities.ts';
import type { World } from '../src/world/world.ts';
import { TerrainField } from '../src/world/terrain.ts';

const HALF = 24;

vi.mock('../src/icons.ts', () => ({ icon: () => ({ setAttribute: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());

function harness(scale = 30) {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) });
  vi.stubGlobal('Image', class { onload: (() => void) | null = null; src = ''; });
  vi.stubGlobal('XMLSerializer', class { serializeToString() { return '<svg/>'; } });
  const renderer = new ContactOverlay();
  const source = { id: 'bomber', kind: 'bomber', side: 'nw', plane: 'sky', x: 20, y: 20, state: 'idle' } as Entity;
  const enemy = { id: 'enemy', kind: 'tank', side: 'se', plane: 'surface', x: 20, y: 20, state: 'idle' } as Entity;
  const view = createGame({ seed: 11 }).view('nw');
  view.entities = [enemy];
  view.memory = [];
  const contacts = createContacts();
  configureContacts(contacts, { units: [source], spire: false }, 'sky', view);
  const tr = (e: Entity) => ({ e, rx: e.x, ry: e.y, wy: 999, visible: false } as Track);
  const world = {
    size: 48,
    layers: { surface: { field: new TerrainField(48) } },
    view, army: 'nw', rig: { focus: 'sky', diving: false }, selected: new Set([source.id]),
    project: (x: number, _height: number, z: number) => ({ x: (x + HALF) * scale, y: (z + HALF) * scale, behind: false }),
    entities: { tracks: new Map([[enemy.id, tr(enemy)], [source.id, tr(source)]]) },
  };
  const strokes: string[] = [];
  const ctx = {
    strokeStyle: '', lineWidth: 0, fillStyle: '', globalAlpha: 1,
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
    arc: vi.fn(), fill: vi.fn(), setLineDash: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
    stroke() { strokes.push(this.strokeStyle); },
  };
  const draw = () => { renderer.clear(); renderer.draw(ctx as unknown as CanvasRenderingContext2D, world as unknown as World, contacts); };
  return { renderer, contacts, world, view, enemy, source, ctx, strokes, draw };
}

describe('main-view contact overlay', () => {
  it('draws exposed enemy footprints and selected source rings despite native-layer fading', () => {
    const h = harness();
    h.draw();
    expect([...h.renderer.drawn]).toEqual(['enemy']);
    expect(h.strokes).toContain(SIDE_HEX.red);
    expect(h.strokes).toContain(SIDE_HEX.blue);
    expect(h.ctx.setLineDash).toHaveBeenCalledWith([5, 3]);
    expect(h.world.selected.has(h.source.id)).toBe(true);
  });

  it('never draws hidden cached tracks or memory, and clears contact ids when fog changes', () => {
    const h = harness();
    h.draw();
    h.view.entities = [];
    h.view.memory = [{ id: h.enemy.id, kind: 'turret', side: 'se', plane: 'surface', x: 20, y: 20, seen: 0 }];
    h.draw();
    expect(h.renderer.drawn.size).toBe(0);
    for (const side of ['nw', 'neutral'] as const) {
      h.view.entities = [{ ...h.enemy, side }];
      h.draw();
      expect(h.renderer.drawn.size).toBe(0);
    }
  });

  it('uses gold plus a plane badge for valid hover, but grey for out-of-range hover', () => {
    const h = harness();
    h.contacts.hovered = h.enemy.id;
    h.draw();
    expect(h.strokes).toContain('#ffd21f');
    expect(h.ctx.drawImage).toHaveBeenCalledWith(expect.anything(), expect.any(Number), expect.any(Number), 18, 18);
    h.enemy.x = 50;
    h.world.entities.tracks.get(h.enemy.id)!.rx = 50;
    h.strokes.length = 0;
    h.draw();
    expect([...h.renderer.drawn]).toEqual(['enemy']);
    expect(h.strokes).toContain(UNIT_PAINT.steel);
    expect(h.strokes).not.toContain('#ffd21f');
  });

  it('renders tiny contacts with constant 18px icons rather than shrinking with camera scale', () => {
    const h = harness(1);
    h.draw();
    expect(h.ctx.drawImage).toHaveBeenCalledWith(expect.anything(), expect.any(Number), expect.any(Number), 18, 18);
    expect(h.ctx.arc).toHaveBeenCalledWith(20, 20, 12, 0, Math.PI * 2);
  });

  it('does not draw on a different source plane, during dives, or when inactive', () => {
    const h = harness();
    h.contacts.source = 'surface';
    h.draw();
    expect(h.renderer.drawn.size).toBe(0);
    h.contacts.source = 'sky';
    h.world.rig.diving = true;
    h.draw();
    expect(h.renderer.drawn.size).toBe(0);
    h.world.rig.diving = false;
    h.contacts.active = false;
    h.draw();
    expect(h.renderer.drawn.size).toBe(0);
    expect(h.ctx.save).not.toHaveBeenCalled();
  });
});
