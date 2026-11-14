// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CELL, DEFAULT_RULES, sunHalfWidth, TICK_RATE, type Entity, type Plane, type UnitKind, type View } from '@agent-command/game/contract';
import { CommandCard, type CardAction } from '../src/command-card.ts';
import { Controls, type ControlHost } from '../src/controls.ts';
import { CanvasCursor } from '../src/cursors.ts';
import { setKeyLayout } from '../src/keymap.ts';
import type { Overlay } from '../src/overlay.ts';
import { installTooltips } from '../src/tooltip.ts';
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

const unit = (kind: UnitKind, id: string, plane: Plane, extra: Partial<Entity> = {}): Entity =>
  ({ id, kind, side: 'nw', plane, x: 2, y: 3, hp: 100, maxHp: 100, state: 'idle', ...extra }) as Entity;

function harness(units: Entity[], plane: Plane) {
  const size = DEFAULT_RULES.map.size;
  const canvas = document.createElement('canvas');
  canvas.setPointerCapture = vi.fn();
  const card = new CommandCard();
  document.body.append(canvas, card.el);
  const world = {
    size, layers: { surface: { field: new TerrainField(size) } },
    selected: new Set<string>(), entities: { tracks: new Map(units.map((e) => [e.id, { e, rx: e.x, ry: e.y, wy: 0 } as Track])) },
    lens: { show: vi.fn() }, orbitAbilities: { aim: vi.fn() }, designations: { showPreview: vi.fn() },
    rig: { focus: plane, edge: { x: 0, y: 0 }, keys: new Set<string>() },
    pickTile: vi.fn(() => ({ x: 8, y: 9 })), groundPoint: vi.fn(() => ({ x: 8, y: 9 })), pickEntity: vi.fn((): Track | undefined => undefined),
  };
  const view = {
    army: 'nw', tick: 1000, entities: units, memory: [], queue: [], match: { rules: DEFAULT_RULES, sun: { half: sunHalfWidth(2), wedges: 2 } }, holes: [],
    sun: { angle: 0 }, res: { energy: 1000, alloy: 1000, freeEnergy: 1000, freeAlloy: 1000, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0, upkeepHeld: 0, scanReadyAt: 0 }, research: { available: [], completed: ['aegis_projectors'], inProgress: [], seen: [] }, spire: [], islands: [],
    depths: Array<number>(size * size).fill(CELL.tunnel),
    designations: { normal: Array<number>(Math.ceil(size * size / 30)).fill(0), urgent: Array<number>(Math.ceil(size * size / 30)).fill(0) },
  } as unknown as View;
  const host = {
    view: () => view, act: vi.fn<ControlHost['act']>(async () => true), canQueue: () => true,
    toast: vi.fn(), goTo: vi.fn(), jumpTo: vi.fn(), toggleCommander: vi.fn(), pickDirective: vi.fn(), changed: vi.fn(), hint: vi.fn(),
  } satisfies ControlHost;
  const controls = new Controls(world as unknown as World, { canvas, cursor: new CanvasCursor(canvas), pings: [] } as unknown as Overlay, host);
  cleanup.push(() => controls.dispose(), () => card.dispose());
  // Controls owns the selection sets: select after construction.
  for (const e of units) world.selected.add(e.id);
  const render = () => card.update(controls.cardActions(), '#c79bff');
  render();
  const group = (id: string) => card.el.querySelector(`[data-action="${id}"]`)?.closest<HTMLElement>('[data-group]')?.dataset.group;
  return { card, controls, view, host, render, group };
}

/** Any test can drive the card directly: a sun-lance-like ability and a few commands. */
function action(id: string, extra: Partial<CardAction> = {}): CardAction {
  return { id, group: 'abilities', rank: 10, icon: 'sun_lance', label: id, tip: { title: id }, run: vi.fn(), ...extra };
}

describe('command card grouping', () => {
  it('offers a non-combat Mooring Tower its Lens command and own-tower release, including bounded power grace', () => {
    const tower: Entity = { id: 'tower', kind: 'mooring_tower', side: 'nw', plane: 'surface', x: 14, y: 24, hp: 400, maxHp: 400, state: 'idle', mooringPowered: true };
    const h = harness([tower], 'surface');
    expect(h.group('moor')).toBe('abilities');
    expect(h.group('unmoor')).toBe('abilities');
    expect(h.group('move')).toBeUndefined();
    h.card.el.querySelector<HTMLButtonElement>('[data-action="moor"]')!.click();
    expect(h.controls.armed).toEqual({ kind: 'moor' });
    h.controls.arm(undefined);
    Object.assign(tower, { mooringTarget: 'island', mooringState: 'held', mooringPowered: false, mooringGrace: 25 });
    h.render();
    const actions = h.controls.cardActions();
    expect(actions.find((a) => a.id === 'moor')?.disabled).toBe(true);
    const release = actions.find((a) => a.id === 'unmoor')!;
    expect(release.disabled).toBe(false);
    expect(release.tip.status).toContain('POWER LOST');
    expect(release.tip.status).toContain('1.3s left');
    release.run();
    expect(h.host.act).toHaveBeenCalledWith('surface', [{ kind: 'unmoor', tower: tower.id }]);
    tower.side = 'ne';
    h.render();
    expect(h.group('unmoor')).toBeUndefined();
  });

  it('separates ordinary commands from every ability of a mixed Orbit fleet', () => {
    const h = harness([
      unit('lancer', 'lancer', 'orbit'), unit('bastion', 'bastion', 'orbit', { shield: 80 }), unit('skiff', 'skiff', 'orbit'),
      unit('tug', 'tug', 'orbit', { state: 'towing' }),
    ], 'orbit');
    for (const id of ['move', 'amove', 'stop', 'patrol', 'hold', 'stance:aggressive', 'stance:defensive', 'formation:wedge', 'formation:line', 'formation:escort'])
      expect(h.group(id), id).toBe('commands');
    for (const id of ['sun_lance', 'aegis', 'deorbit', 'scan']) expect(h.group(id), id).toBe('abilities');
    // Hold is the stance segment's third button: one Hold control, with its hotkey.
    expect(h.card.el.querySelectorAll('[data-action="hold"]')).toHaveLength(1);
    expect(h.card.el.querySelector('[role="group"][aria-label="Stance"] [data-action="hold"] .cmd-key')?.textContent).toBe('H');
    // Abilities are framed tiles with their hotkey badge and cost; commands are the compact uniform style.
    const lance = h.card.el.querySelector<HTMLElement>('[data-action="sun_lance"]')!;
    expect(lance.classList.contains('ability')).toBe(true);
    expect(lance.querySelector('.ability-key')?.textContent).toBe(',');
    expect(lance.querySelector('.ability-cost')?.textContent).toBe(String(DEFAULT_RULES.orbit.lanceEnergy));
    expect(lance.querySelector('.ring')).not.toBeNull();
    expect(h.card.el.querySelector('[data-action="move"]')?.classList.contains('cmd')).toBe(true);
  });

  it('groups Depths crews: worker orders are commands, collapse, breach and construction verbs are abilities', () => {
    const h = harness([unit('digger', 'd', 'depths'), unit('sapper', 's', 'depths'), unit('trooper', 't', 'depths')], 'depths');
    for (const id of ['move', 'amove', 'stop', 'mine', 'designate', 'fortify', 'bulkhead', 'transfer']) expect(h.group(id), id).toBe('commands');
    for (const id of ['undermine', 'breach', 'rail', 'bridge', 'geothermal', 'scan']) expect(h.group(id), id).toBe('abilities');
    expect(h.card.el.querySelector('[data-action="rail"] .ability-cost')?.textContent).toBe(String(DEFAULT_RULES.depths.railCost));
  });

  it('gives Wardens Fortify and their Deploy, Pack and Flare abilities, with the flare cooldown from abilityReady', () => {
    const h = harness([unit('warden', 'w', 'depths', { maxHp: 160, hp: 160 })], 'depths');
    expect(h.group('fortify')).toBe('commands');
    for (const id of ['deploy', 'pack', 'flare']) expect(h.group(id), id).toBe('abilities');
    const tile = (id: string) => h.card.el.querySelector<HTMLElement>(`[data-action="${id}"]`)!;
    expect(tile('deploy').getAttribute('aria-disabled')).not.toBe('true');
    expect(tile('pack').getAttribute('aria-disabled')).toBe('true');
    expect(tile('flare').classList.contains('cooling')).toBe(false);
    tile('deploy').click();
    expect(h.host.act).toHaveBeenLastCalledWith('depths', [{ kind: 'deploy', units: ['w'], on: true }]);
    const warden = h.view.entities[0]!;
    warden.state = 'walled';
    warden.abilityReady = h.view.tick + DEFAULT_RULES.depths.flareCooldown * TICK_RATE;
    h.render();
    expect(tile('deploy').getAttribute('aria-disabled')).toBe('true');
    expect(tile('pack').getAttribute('aria-disabled')).not.toBe('true');
    expect(tile('flare').classList.contains('cooling')).toBe(true);
    expect(tile('flare').querySelector('.cd-left')?.textContent).toBe(String(DEFAULT_RULES.depths.flareCooldown));
    tile('pack').click();
    expect(h.host.act).toHaveBeenLastCalledWith('depths', [{ kind: 'deploy', units: ['w'], on: false }]);
  });

  it('gives surface troopers, tanks and flak Deploy and Pack, sent to the Surface seat', () => {
    const h = harness([unit('tank', 'tk', 'surface', { maxHp: 300, hp: 300 }), unit('trooper', 'tr', 'surface', { maxHp: 100, hp: 100, state: 'dug_in' })], 'surface');
    for (const id of ['deploy', 'pack']) expect(h.group(id), id).toBe('abilities');
    h.card.el.querySelector<HTMLElement>('[data-action="deploy"]')!.click();
    expect(h.host.act).toHaveBeenLastCalledWith('surface', [{ kind: 'deploy', units: ['tk'], on: true }]);
    h.card.el.querySelector<HTMLElement>('[data-action="pack"]')!.click();
    expect(h.host.act).toHaveBeenLastCalledWith('surface', [{ kind: 'deploy', units: ['tr'], on: false }]);
  });

  it('keeps Scan on every card, even with nothing selected', () => {
    const h = harness([], 'surface');
    const actions = [...h.card.el.querySelectorAll<HTMLElement>('[data-action]')].map((el) => el.dataset.action!);
    expect(actions.filter((id) => !id.startsWith('request:'))).toEqual(['scan']);
  });
});

describe('team support requests', () => {
  const requests = ({ card }: { card: CommandCard }) =>
    [...card.el.querySelectorAll<HTMLElement>('[data-action^="request:"]')].map((el) => el.dataset.action);

  it('offers one Request button per need another plane answers, as one segment of commands', () => {
    const h = harness([], 'surface');
    expect(requests(h)).toEqual(['request:troops', 'request:air_cover', 'request:scan', 'request:bombers', 'request:escort', 'request:collapse', 'request:drop', 'request:capture', 'request:defend']);
    expect(h.group('request:troops')).toBe('commands');
    expect(h.card.el.querySelector('[role="group"][aria-label="Request support"] [data-action="request:air_cover"]')).not.toBeNull();
    expect(requests(harness([], 'sky'))).toEqual(['request:troops', 'request:scan', 'request:flak', 'request:escort', 'request:collapse', 'request:drop', 'request:capture', 'request:defend']);
  });

  it('arms the Request tool and sends the request at the clicked tile as the plane in view', async () => {
    const h = harness([], 'sky');
    h.card.el.querySelector<HTMLElement>('[data-action="request:troops"]')!.click();
    expect(h.controls.armed).toEqual({ kind: 'request', need: 'troops' });
    const canvas = document.querySelector('canvas')!;
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }));
    // Several planes answer troops for the Sky: the whole team is asked; the tile is the clicked cell (8, 9).
    expect(h.host.act).toHaveBeenCalledWith('sky', [{ kind: 'signal', signal: { kind: 'request_support', to: 'team', need: 'troops', x: 8, y: 9 } }]);
    await vi.waitFor(() => expect(h.host.toast).toHaveBeenCalledWith('Troops requested', 'ok'));
    expect(h.controls.armed).toBeUndefined();
  });

  it('asks the one plane that answers when only one does', () => {
    const h = harness([], 'orbit');
    h.card.el.querySelector<HTMLElement>('[data-action="request:air_cover"]')!.click();
    const canvas = document.querySelector('canvas')!;
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0 }));
    expect(h.host.act).toHaveBeenCalledWith('orbit', [{ kind: 'signal', signal: { kind: 'request_support', to: 'sky', need: 'air_cover', x: 8, y: 9 } }]);
  });

  it('hides every Request button when the match turns signals off', () => {
    const h = harness([], 'surface');
    h.view.match!.rules = { ...DEFAULT_RULES, signals: { ...DEFAULT_RULES.signals, enabled: false } };
    h.render();
    expect(requests(h)).toEqual([]);
    expect(h.card.el.querySelector('[data-action="scan"]')).not.toBeNull();
  });
});

describe('ability readiness', () => {
  it('says why an ability is unavailable: cooldown, research, sunlight or energy', () => {
    const h = harness([unit('lancer', 'lancer', 'orbit'), unit('bastion', 'bastion', 'orbit', { shield: 80 }), unit('interceptor', 'air', 'orbit')], 'orbit');
    const status = (id: string) => {
      h.render();
      const tile = h.card.el.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!;
      tile.focus();
      return { disabled: tile.getAttribute('aria-disabled'), text: document.querySelector('[role="tooltip"]:not([hidden]) .ac-tooltip-status')?.textContent };
    };
    h.view.research.completed = [];
    expect(status('aegis')).toEqual({ disabled: 'true', text: 'Research Aegis Projectors' });
    expect(status('ascend')).toEqual({ disabled: 'true', text: 'Research Ascent Thrusters' });
    h.view.research.completed = ['aegis_projectors'];
    // Sun angle 0: a lancer a quarter turn round the map centre is outside the sunlit band.
    const lancer = h.view.entities[0]!;
    lancer.x = DEFAULT_RULES.map.size / 2;
    lancer.y = DEFAULT_RULES.map.size / 2 + 8;
    expect(status('sun_lance')).toEqual({ disabled: 'true', text: 'Requires sunlight' });
    h.view.entities[1]!.abilityReady = h.view.tick + 4 * TICK_RATE;
    expect(status('aegis')).toEqual({ disabled: 'true', text: 'Cooldown 4s' });
    h.view.res.energy = h.view.res.freeEnergy = DEFAULT_RULES.orbit.scanCost - 1;
    expect(status('scan')).toEqual({ disabled: 'true', text: `Needs ${DEFAULT_RULES.orbit.scanCost} energy` });
  });

  it('runs a cooldown ring down to ready and pulses exactly once when it becomes ready', () => {
    const h = harness([unit('bastion', 'bastion', 'orbit', { shield: 80 })], 'orbit');
    const bastion = h.view.entities[0]!;
    const tile = () => h.card.el.querySelector<HTMLElement>('[data-action="aegis"]')!;
    bastion.abilityReady = h.view.tick + DEFAULT_RULES.orbit.aegisCooldown * TICK_RATE;
    h.render();
    expect(tile().classList.contains('cooling')).toBe(true);
    expect(tile().style.getPropertyValue('--cd')).toBe('1');
    expect(tile().querySelector('.cd-left')?.textContent).toBe(String(DEFAULT_RULES.orbit.aegisCooldown));
    const cooling = tile();
    h.view.tick += DEFAULT_RULES.orbit.aegisCooldown * TICK_RATE / 2;
    h.render();
    // Seconds and the ring move without rebuilding the tile.
    expect(tile()).toBe(cooling);
    expect(Number(tile().style.getPropertyValue('--cd'))).toBeCloseTo(0.5);
    expect(tile().querySelector('.cd-left')?.textContent).toBe(String(DEFAULT_RULES.orbit.aegisCooldown / 2));
    expect(tile().classList.contains('pulse')).toBe(false);
    h.view.tick = bastion.abilityReady;
    h.render();
    expect(tile().classList.contains('cooling')).toBe(false);
    expect(tile().getAttribute('aria-disabled')).toBe('false');
    expect(tile().querySelector('.cd-left')?.textContent).toBe('');
    expect(tile().classList.contains('pulse')).toBe(true);
    tile().classList.remove('pulse');
    h.view.tick += TICK_RATE;
    h.render();
    expect(tile().classList.contains('pulse')).toBe(false);
  });
});

describe('command card fit', () => {
  /** happy-dom has no layout: 20px per visible control row item, in a 100px column. */
  function constrained(card: CommandCard) {
    Object.defineProperty(card.el, 'clientHeight', { get: () => 100 });
    Object.defineProperty(card.el, 'scrollHeight', { get: () => card.el.querySelectorAll('.card-group > :not([hidden])').length * 20 });
  }

  it('never scrolls: low-ranked actions move under one More button, abilities stay', () => {
    const card = new CommandCard();
    document.body.append(card.el);
    cleanup.push(() => card.dispose());
    constrained(card);
    const run = vi.fn();
    const actions = [
      action('move', { group: 'commands', rank: 9, icon: 'move' }),
      action('patrol', { group: 'commands', rank: 3, icon: 'patrol' }),
      action('fortify', { group: 'commands', rank: 2, icon: 'fortify', run }),
      action('stance:a', { group: 'commands', rank: 7, icon: 'aggressive', segment: { id: 'stance', label: 'Stance' } }),
      action('stance:b', { group: 'commands', rank: 7, icon: 'defensive', segment: { id: 'stance', label: 'Stance' } }),
      action('sun_lance'),
      action('aegis', { icon: 'aegis' }),
    ];
    card.update(actions, '#c79bff');
    expect(card.el.classList.contains('compact')).toBe(true);
    const more = card.el.querySelector<HTMLButtonElement>('.more')!;
    expect(more.hidden).toBe(false);
    const menu = document.getElementById(more.getAttribute('aria-controls')!)!;
    // move, stance (one segment), More, sun_lance, aegis = 5 rows of 20px: fortify and patrol went under More.
    expect([...menu.querySelectorAll<HTMLElement>('[data-action]')].map((el) => el.dataset.action)).toEqual(['patrol', 'fortify']);
    expect(card.el.querySelectorAll('[data-group="abilities"] [data-action]')).toHaveLength(2);
    const onCard = [...card.el.querySelectorAll<HTMLElement>('[data-action]')].map((el) => el.dataset.action);
    expect(onCard).toEqual(['move', 'stance:a', 'stance:b', 'sun_lance', 'aegis']);
    menu.querySelector<HTMLElement>('[data-action="fortify"]')!.click();
    expect(run).toHaveBeenCalledOnce();
  });

  it('shows everything without More when it fits', () => {
    const card = new CommandCard();
    document.body.append(card.el);
    cleanup.push(() => card.dispose());
    constrained(card);
    card.update([action('move', { group: 'commands', rank: 9, icon: 'move' }), action('sun_lance')], '#c79bff');
    expect(card.el.classList.contains('compact')).toBe(false);
    expect(card.el.querySelector<HTMLButtonElement>('.more')!.hidden).toBe(true);
  });
});
