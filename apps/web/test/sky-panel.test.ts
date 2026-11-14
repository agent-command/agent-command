// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES, TICK_RATE, type Entity, type Plane, type QueueEntryOut, type View } from '@agent-command/game/contract';
import { CommandCard } from '../src/command-card.ts';
import { islandOreInfo, islandTip, selectedAerie, skyActions, skyStructureHint, weatherLegend, weatherTip } from '../src/sky-panel.ts';
import { model } from '../src/world/models.ts';
import { installTooltips, TOOLTIP_DELAY } from '../src/tooltip.ts';

beforeEach(() => { installTooltips()(); vi.useFakeTimers(); installTooltips(); });
afterEach(() => { installTooltips()(); document.body.replaceChildren(); vi.useRealTimers(); });

const entity = (kind: Entity['kind'], id: string, extra: Partial<Entity> = {}): Entity => ({ id, kind, side: 'nw', plane: 'sky', x: 10, y: 12, hp: 100, maxHp: 100, state: 'active', ...extra } as Entity);
function panel(entities: Entity[], selection: Entity[], rules = DEFAULT_RULES) {
  const view = { army: 'nw', rulesHash: 0, tick: 100, entities, queue: [], res: { alloy: 1000, energy: 1000, freeAlloy: 1000, freeEnergy: 1000, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0, upkeepHeld: 0 } } as unknown as View;
  const card = new CommandCard();
  const el = card.el;
  document.body.append(el);
  const act = vi.fn();
  const render = () => card.update(skyActions(view, rules, selection, act), '#7fd6ff');
  render();
  const click = (label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
  const status = (label: string) => {
    el.querySelector(`[aria-label="${label}"]`)!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    return document.querySelector('[role="tooltip"]:not([hidden])')?.textContent ?? '';
  };
  return { view, el, act, render, click, status };
}

describe('Sky structure command card', () => {
  it('exposes hangared occupants, individual/all launch and paid airdrops', () => {
    const aerie = entity('aerie', 'nest');
    const docked = entity('interceptor', 'fighter', { state: 'hangared', hangar: 'nest' });
    const launching = entity('bomber', 'bomber', { state: 'launching', hangar: 'nest', ready: 140 });
    const p = panel([aerie, docked, launching], [aerie]);
    p.click('Launch all aircraft');
    expect(p.act).toHaveBeenLastCalledWith([{ kind: 'launch', units: ['fighter'] }]);
    p.click('Launch Interceptor fighter');
    expect(p.act).toHaveBeenLastCalledWith([{ kind: 'launch', units: ['fighter'] }]);
    p.act.mockClear();
    p.click('Launch Bomber bomber');
    expect(p.act).not.toHaveBeenCalled();
    p.click('Airdrop troopers');
    expect(p.act).toHaveBeenLastCalledWith([{ kind: 'airdrop', aerie: 'nest' }]);
    expect(p.el.textContent).toContain(`2/${DEFAULT_RULES.sky.aerieCapacity}`);
    expect(p.el.querySelector('[title], svg title')).toBeNull();
    for (const button of p.el.querySelectorAll('button[data-action]')) {
      expect(button.getAttribute('aria-label')).toBeTruthy();
      expect(button.hasAttribute('data-tip')).toBe(true);
      button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      vi.advanceTimersByTime(TOOLTIP_DELAY);
      expect(document.querySelector('[role="tooltip"]:not([hidden])')?.textContent).toBeTruthy();
      expect(button.querySelector('svg')).not.toBeNull();
    }
  });

  it('blocks airdrops while cooling down or unaffordable', () => {
    const aerie = entity('aerie', 'nest', { ready: 100 + 3 * TICK_RATE });
    const p = panel([aerie], [aerie]);
    p.click('Airdrop troopers');
    expect(p.act).not.toHaveBeenCalled();
    p.el.querySelector('[aria-label="Airdrop troopers"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(document.querySelector('[role="tooltip"]:not([hidden])')?.textContent).toContain('Ready in 3s');
    aerie.ready = 0;
    p.view.res.alloy = p.view.res.freeAlloy = 0;
    p.render();
    p.click('Airdrop troopers');
    expect(p.act).not.toHaveBeenCalled();
  });

  it('only offers own Aeries and never forwards enemy/unfinished producers', () => {
    const air = entity('interceptor', 'air', { state: 'idle' });
    const aerie = entity('aerie', 'nest');
    const enemy = entity('aerie', 'enemy', { side: 'se' });
    const building = entity('aerie', 'building', { state: 'constructing' });
    const p = panel([air, aerie, enemy, building], [air]);
    p.click('Hangar at Aerie');
    expect(p.act).toHaveBeenCalledWith([{ kind: 'hangar', units: ['air'], target: 'nest' }]);
    expect(p.el.querySelectorAll('button[data-action]')).toHaveLength(1);
    expect(selectedAerie([enemy, building, aerie], 'nw')).toBe(aerie);
    expect(selectedAerie([enemy, building], 'nw')).toBeUndefined();
  });

  it('does not grant island owners control of a Surface tower through the Sky card', () => {
    const island = entity('island', 'isle', { state: 'drifting', mooringState: 'held', mooringTower: 'tower' });
    const p = panel([island], [island]);
    expect([...p.el.querySelectorAll('button')].some((b) => /moor|release/i.test(b.textContent ?? ''))).toBe(false);
  });

  it('drops the complete island buffer without an amount override, power gate or optimistic income', () => {
    const island = entity('island', 'ore-island', { oreCapacity: 240, oreRemaining: 90, oreBuffer: 12.5, state: 'drifting' });
    const extractor = entity('ore_extractor', 'extractor', { link: island.id, state: 'idle', extractorPowered: false });
    const p = panel([island, extractor], [extractor]);
    const drop = () => p.el.querySelector<HTMLButtonElement>('[data-action="sky:drop-ore"]')!;
    expect(drop().getAttribute('aria-disabled')).not.toBe('true');
    drop().click();
    expect(p.act).toHaveBeenLastCalledWith([{ kind: 'drop_ore', island: island.id }]);
    expect(island.oreBuffer).toBe(12.5);
    expect(island.oreRemaining).toBe(90);
    expect(p.view.res.alloy).toBe(1000);
    p.act.mockClear();
    island.oreBuffer = 0;
    p.render(); drop().click();
    expect(drop().getAttribute('aria-disabled')).toBe('true');
    expect(p.act).not.toHaveBeenCalled();
    delete island.oreBuffer;
    p.render(); drop().click();
    expect(drop().getAttribute('aria-disabled')).toBe('true');
    expect(p.act).not.toHaveBeenCalled();
  });

  it('keeps depleted-island cargo commandable without an extractor or a duplicate demolition action', () => {
    const island = entity('island', 'ore-island', { oreCapacity: 240, oreRemaining: 0, oreBuffer: 17, state: 'drifting' });
    const extractor = entity('ore_extractor', 'extractor', { link: island.id, state: 'constructing' });
    const selected = [extractor], p = panel([island, extractor], selected);
    expect(p.el.querySelector('[data-action="sky:dismantle-extractor"]')).toBeNull();
    expect(island.oreBuffer).toBe(17);
    p.view.entities = [island];
    selected.splice(0, 1, island);
    p.render();
    expect(p.el.querySelector('[data-action="sky:dismantle-extractor"]')).toBeNull();
    p.el.querySelector<HTMLButtonElement>('[data-action="sky:drop-ore"]')!.click();
    expect(p.act).toHaveBeenLastCalledWith([{ kind: 'drop_ore', island: island.id }]);
    island.side = 'se';
    delete island.oreBuffer;
    p.render();
    expect(p.el.querySelector('[data-action="sky:drop-ore"]')).toBeNull();
    expect(p.el.querySelector('[data-action="sky:dismantle-extractor"]')).toBeNull();
  });

  it('renders numeric reserve and cargo only from their disclosed fields, not static path capacity', () => {
    const island = entity('island', 'ore-island', { oreCapacity: 240, oreRemaining: 7.5, oreBuffer: 12.25, state: 'drifting' });
    const extractor = entity('ore_extractor', 'extractor', { link: island.id, state: 'mining', extractorPowered: true });
    const p = panel([island, extractor], [extractor]);
    p.view.islands = [{ id: island.id, cx: 24, cy: 24, r: 10, phase: 0, speed: 0.01, oreCapacity: 240 }];
    const known = islandOreInfo(extractor, p.view, DEFAULT_RULES)!;
    const reserve = known.querySelector('[aria-label="Ore reserve"]')!;
    expect(Number(reserve.getAttribute('aria-valuenow'))).toBe(7.5);
    expect(Number(reserve.getAttribute('aria-valuemax'))).toBe(240);
    expect(Number(known.querySelector('[aria-label="Buffered ore"]')!.getAttribute('aria-valuenow'))).toBe(12.25);
    delete island.oreRemaining;
    delete island.oreBuffer;
    const unknown = islandOreInfo(island, p.view, DEFAULT_RULES)!;
    expect(unknown.querySelector('[aria-label="Ore reserve"]')!.hasAttribute('aria-valuenow')).toBe(false);
    expect(unknown.querySelector('[aria-label="Buffered ore"]')).toBeNull();
    island.oreRemaining = 0;
    expect(islandOreInfo(island, p.view, DEFAULT_RULES)!.querySelector('[aria-label="Ore reserve"]')!.getAttribute('aria-valuenow')).toBe('0');
    expect(islandOreInfo(entity('island', 'ordinary'), p.view, DEFAULT_RULES)).toBeUndefined();
  });

  it('seeds from a built own Storm Seeder with its cost, public telegraph, active state and cooldown', () => {
    const r = DEFAULT_RULES.sky;
    const seeder = entity('storm_seeder', 'seeder', { state: 'idle', ready: 0 });
    const p = panel([seeder], [seeder]);
    expect(p.status('Seed storm')).toContain(String(r.seederCost));
    p.click('Seed storm');
    expect(p.act).toHaveBeenLastCalledWith([{ kind: 'seed', seeder: 'seeder' }]);
    seeder.state = 'active';
    seeder.activeUntil = 100 + (r.seederTelegraph + r.seederDuration) * TICK_RATE;
    seeder.ready = 100 + r.seederCooldown * TICK_RATE;
    p.render();
    p.act.mockClear();
    expect(p.el.querySelector('[aria-label="Seed storm"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(p.status('Seed storm')).toContain(`Storm forms in ${r.seederTelegraph}s`);
    p.click('Seed storm');
    expect(p.act).not.toHaveBeenCalled();
    seeder.state = 'idle';
    seeder.activeUntil = 0;
    p.render();
    p.click('Seed storm');
    expect(p.act).not.toHaveBeenCalled();
    seeder.ready = 0;
    p.view.res.energy = p.view.res.freeEnergy = r.seederCost - 1;
    p.render();
    p.click('Seed storm');
    expect(p.act).not.toHaveBeenCalled();
    // never for an unfinished or enemy Seeder, nor when seeding is off in the match
    expect(panel([seeder], [{ ...seeder, state: 'constructing' }]).el.querySelector('[aria-label="Seed storm"]')).toBeNull();
    expect(panel([seeder], [{ ...seeder, side: 'se' }]).el.querySelector('[aria-label="Seed storm"]')).toBeNull();
    const off = { ...DEFAULT_RULES, sky: { ...DEFAULT_RULES.sky, seederEnabled: false } };
    expect(panel([seeder], [seeder], off).el.querySelector('[aria-label="Seed storm"]')).toBeNull();
  });

  it('affords seeding from the Sky lane’s own earmark, never another lane’s', () => {
    const r = DEFAULT_RULES.sky;
    const seeder = entity('storm_seeder', 'seeder', { state: 'idle', ready: 0 });
    const p = panel([seeder], [seeder]);
    const hold = (plane: Plane, extra: Partial<QueueEntryOut> = {}): QueueEntryOut => ({
      id: `q_${plane}`, item: 'interceptor', plane, by: plane, byCtl: 'human', alloy: 0, energy: r.seederCost,
      heldAlloy: 0, heldEnergy: 1, recovery: false, paid: false, next: true, status: 'waiting', progress: 0, ...extra,
    });
    // The bank holds plenty, but all except one short of the price is earmarked.
    Object.assign(p.view.res, { energy: 1000, freeEnergy: r.seederCost - 1, heldEnergy: 1000 - r.seederCost + 1 });
    const seedable = (queue: QueueEntryOut[]) => {
      p.view.queue = queue;
      p.render();
      p.act.mockClear();
      p.click('Seed storm');
      return p.act.mock.calls.length > 0;
    };
    expect(seedable([hold('orbit')])).toBe(false);
    expect(seedable([hold('sky', { recovery: true })])).toBe(false);
    expect(seedable([hold('sky', { paid: true })])).toBe(false);
    expect(seedable([hold('sky')])).toBe(true);
  });

  it('hangars gunships and shows Aerie repair on damaged occupants only while powered and enabled', () => {
    const gunship = entity('gunship', 'brawler', { state: 'idle' });
    const aerie = entity('aerie', 'nest');
    const hangar = panel([gunship, aerie], [gunship]);
    hangar.click('Hangar at Aerie');
    expect(hangar.act).toHaveBeenCalledWith([{ kind: 'hangar', units: ['brawler'], target: 'nest' }]);
    hangar.el.remove();
    const hurt = entity('gunship', 'hurt', { state: 'hangared', hangar: 'nest', hp: 200, maxHp: 320 });
    const p = panel([aerie, hurt], [aerie]);
    expect(p.status('Launch Gunship hurt')).toContain(`repairing ${DEFAULT_RULES.sky.aerieRepair} HP/s`);
    aerie.state = 'idle';
    p.render();
    expect(p.status('Launch Gunship hurt')).not.toContain('repairing');
    aerie.state = 'active';
    const off = { ...DEFAULT_RULES, sky: { ...DEFAULT_RULES.sky, aerieRepairEnabled: false } };
    expect(panel([aerie, hurt], [aerie], off).status('Launch Gunship hurt')).not.toContain('repairing');
  });

  it('requires nearby aircraft, free berths and power before offering a hangar action', () => {
    const air = entity('interceptor', 'air', { x: 40 });
    const aerie = entity('aerie', 'nest');
    const p = panel([air, aerie], [air]);
    p.click('Hangar at Aerie');
    expect(p.act).not.toHaveBeenCalled();
    air.x = 10;
    aerie.state = 'idle';
    p.render();
    p.click('Hangar at Aerie');
    expect(p.act).not.toHaveBeenCalled();
    aerie.state = 'active';
    for (let i = 0; i < DEFAULT_RULES.sky.aerieCapacity; i++) p.view.entities.push(entity('bomber', `docked-${i}`, { hangar: 'nest', state: 'hangared' }));
    p.render();
    p.click('Hangar at Aerie');
    expect(p.act).not.toHaveBeenCalled();
  });

  it('preserves keyboard focus when a cooldown updates', () => {
    const aerie = entity('aerie', 'nest', { ready: 200 });
    const p = panel([aerie], [aerie]);
    document.body.append(p.el);
    p.el.querySelector<HTMLButtonElement>('[aria-label=\"Airdrop troopers\"]')!.focus();
    p.view.tick += TICK_RATE;
    p.render();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Airdrop troopers');
    p.el.remove();
  });

  it('uses match tuning in descriptions and supplies distinct modeled structures', () => {
    const rules = { ...DEFAULT_RULES, sky: { ...DEFAULT_RULES.sky, aerieCapacity: 7, seederRadius: 9, stormcatcherRate: 3.5 } };
    expect(skyStructureHint('aerie', rules)).toContain('7 aircraft');
    expect(skyStructureHint('storm_seeder', rules)).toContain('radius 9');
    expect(skyStructureHint('storm_seeder', { ...rules, sky: { ...rules.sky, seederEnabled: false } })).toContain('off');
    expect(skyStructureHint('stormcatcher', rules)).toContain('3.5 energy/s');
    expect(skyStructureHint('gun_platform', { ...rules, sky: { ...rules.sky, emplaceRangeBonus: 2 } })).toContain('range +2');
    const meshes = ['aerie', 'storm_seeder', 'stormcatcher', 'interceptor', 'bomber', 'gunship', 'gun_platform'].map((kind) => model(kind as Entity['kind']));
    expect(new Set(meshes).size).toBe(7);
    for (const mesh of meshes) {
      expect(mesh.getAttribute('position').count).toBeGreaterThan(0);
      expect(mesh.getAttribute('accent').count).toBe(mesh.getAttribute('position').count);
    }
    const legend = weatherLegend(rules);
    expect(legend.querySelectorAll('[data-tip]')).toHaveLength(3);
    expect(legend.querySelector('[title]')).toBeNull();
  });

  it('tells capture timing and drain on an island', () => {
    const match = { armies: [{ id: 'nw', colour: 'blue' }, { id: 'se', colour: 'red' }] } as unknown as View['match'];
    const rules = { ...DEFAULT_RULES, sky: { ...DEFAULT_RULES.sky, captureTime: 4, captureStructureTime: 11 } };
    const tipOf = (island: Entity, slot?: Entity) =>
      islandTip(island, { army: 'nw', tick: 100, entities: slot ? [island, slot] : [island], islands: [{ id: island.id, cx: 24, cy: 24, r: 10, phase: 0, speed: 0.01 }], match } as View, rules).description;
    const relay = entity('relay', 'relay', { side: 'se', link: 'isle' });
    const theirs = entity('island', 'isle', { side: 'se', state: 'drifting', link: 'relay' });
    expect(tipOf(theirs, relay)).toContain('Capturing takes 11s uncontested and drains the structure');
    expect(tipOf(theirs, { ...relay, progress: 0.5, state: 'constructing' })).toContain('Capturing takes 4s uncontested.');
    expect(tipOf(entity('island', 'isle', { side: 'neutral', state: 'drifting' }))).toContain('capture it (4s uncontested)');
    expect(tipOf({ ...theirs, state: 'capturing', progress: 0.25 }, relay)).toContain('Being captured: 25%. The capture drains its Relay.');
    expect(tipOf({ ...theirs, state: 'drifting', progress: 0.1 }, relay)).toContain('Capture fading: 10%.');
  });

  it('distinguishes harmless gathering clouds from active lifecycle weather without changing seeded effects', () => {
    const rules = { ...DEFAULT_RULES, sky: { ...DEFAULT_RULES.sky, stormDps: 7, seederDuration: 42 } };
    expect(weatherTip('forecast', rules)).toEqual({
      title: 'Gathering storm',
      description: 'Faint gathering clouds mark an upcoming natural storm. No storm effects yet; the clouds billow into a storm at the forecast start, then drift and break apart.',
    });
    const natural = weatherTip('storm', rules);
    expect(natural.description).toContain('7 damage/s');
    expect(natural.description).toContain('scale');
    expect(natural.description).toContain('mature stage');
    expect(natural.description).toContain('Idle aircraft step out on their own');
    expect(weatherTip('storm', { ...rules, sky: { ...rules.sky, stormEvadeEnabled: false } }).description).not.toContain('step out');
    expect(weatherTip('seeded', rules).description).toContain('up to 42s');
    expect(weatherTip('seeded', rules).description).not.toContain('scale');
    expect(weatherTip('fog', rules).description).toContain('fixed public path');
    expect(weatherTip('seeding', { ...rules, sky: { ...rules.sky, seederTelegraph: 4 } }).description).toContain('4s telegraph');
  });
});
