// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sim } from '../../../packages/game/src/sim/sim.ts';
import { view as gameView } from '../../../packages/game/src/agent/present.ts';
import { SignalBoard } from 'playerthree/signals';
import type { AnyManifest } from 'playerthree/manifest';
import { ALERTS_PER_PLANE, DEFAULT_RULES, PLANES, SIGNAL_LIMITS_MAX, SIGNALS, TICK_RATE, spirePositions, type Plane, type View } from '@agent-command/game/contract';
import type { MatchView } from '../src/match-view.ts';
import { disclosureState, ledgerClock, ledgerNumber, ledgerRate, matchShareLinks, NUMBER_WIDTHS, numberSlot, stockSlotMetrics, TopBar } from '../src/topbar.ts';
import { MatchTimer, PlaneChips, SunDial, scheduleLines } from '../src/plan-hud.ts';
import type { SignalEntry, SignalHooks } from '../src/signals.ts';

const snapshot = gameView(new Sim(1), 'nw');
snapshot.match!.rules.spire.timeCap = 0;
const view = (extra: Partial<View> = {}) => ({
  ...snapshot, army: 'nw', tick: 0, entities: [], schedule: [], signals: [],
  res: { alloy: 400, energy: 150, alloyRate: 2, energyRate: 8, energyCap: 10, energyBank: 50, solarRate: 8, upkeep: 0,
    freeAlloy: 400, freeEnergy: 150, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0, upkeepHeld: 0,
    income: { depths: { alloy: 2, energy: 0, upkeep: 0 }, surface: { alloy: 0, energy: 0, upkeep: 0 }, sky: { alloy: 0, energy: 0, upkeep: 0 }, orbit: { alloy: 0, energy: 8, upkeep: 0 } } },
  spire: PLANES.map((plane) => ({ plane, hp: 7000, maxHp: 7000 })),
  ...extra,
}) as MatchView;

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('ledger figure contracts', () => {
  it('reserves six figures across digit boundaries without locale separators', () => {
    for (const n of [0, 9, 10, 99, 100, 999, 1000, 9999, 10000, 99999, 100000, 999999, 1e6, 1e12, 1e30, Infinity, NaN]) {
      expect(ledgerNumber(n).length).toBeLessThanOrEqual(NUMBER_WIDTHS.stock);
    }
    expect(ledgerNumber(99999)).toBe('99999');
    expect(ledgerNumber(100000)).toBe('100000');
    expect(ledgerNumber(999999)).toBe('999999');
    expect(ledgerNumber(999999999)).toBe('999M');
    expect(ledgerNumber(1234567)).toBe('1.2M');
    expect(ledgerNumber(-1)).toBe('0');
  });
  it('bounds signed rates, including the rounding and compact thresholds', () => {
    for (const n of [0, 9.95, 99.99, 999.99, 1000, 99999, 1e6, 1e12, 1e30, -2.5, Infinity]) {
      expect(ledgerRate(n).length).toBeLessThanOrEqual(NUMBER_WIDTHS.rate);
    }
    expect(ledgerRate(2)).toBe('+2.0/s');
    expect(ledgerRate(-2.5)).toBe('−2.5/s');
    expect(ledgerRate(99999)).toBe('+99.9k/s');
    expect(ledgerRate(1e9)).toBe('+1B/s');
  });
  it('keeps clocks within their slot through minute, absent, and long-match transitions', () => {
    expect([0, 9, 59.1, 60, 5999, 6000, Infinity, -5].map(ledgerClock)).toEqual(['00:00', '00:09', '01:00', '01:00', '99:59', '99m+', '—', '00:00']);
    for (const seconds of [0, 100, 6000, 1e10, NaN]) expect(ledgerClock(seconds).length).toBeLessThanOrEqual(NUMBER_WIDTHS.clock);
  });
  it('constructs the same figure reservation regardless of value length', () => {
    for (const kind of ['stock', 'rate', 'clock', 'small'] as const) {
      const a = numberSlot(kind, '0');
      const b = numberSlot(kind, '99999');
      expect(a.className).toBe(b.className);
      expect(a.style.getPropertyValue('--figures')).toBe(String(NUMBER_WIDTHS[kind]));
      expect(a.style.getPropertyValue('--figures')).toBe(b.style.getPropertyValue('--figures'));
    }
  });
  it('measures ink bounds and adds side bearings, rather than clipping to advance width', () => {
    const measured: string[] = [];
    const metrics = stockSlotMetrics((text) => {
      measured.push(text);
      return text === '777777'
        ? { width: 72, actualBoundingBoxLeft: 4, actualBoundingBoxRight: 80, actualBoundingBoxAscent: 24, actualBoundingBoxDescent: 9 }
        : { width: 60, actualBoundingBoxLeft: 1, actualBoundingBoxRight: 61, actualBoundingBoxAscent: 22, actualBoundingBoxDescent: 6 };
    });
    expect(metrics).toEqual({ width: 106, padding: 11, height: 39, sample: '777777' });
    expect(measured).toContain('999999');
    expect(measured).toContain('999.9M');
    expect(metrics.width - metrics.padding * 2).toBeGreaterThanOrEqual(84);
  });
});

describe('responsive disclosure', () => {
  it('retains all groups from 1024px and collapses only below that boundary', () => {
    for (const width of [1024, 1280, 1440, 1920]) {
      expect(disclosureState(width, false)).toEqual({ narrow: false, hidden: false, expanded: false });
      expect(disclosureState(width, true)).toEqual({ narrow: false, hidden: false, expanded: false });
    }
    for (const width of [320, 768, 1023]) {
      expect(disclosureState(width, false)).toEqual({ narrow: true, hidden: true, expanded: false });
      expect(disclosureState(width, true)).toEqual({ narrow: true, hidden: false, expanded: true });
    }
  });
  it('opens by button, closes with Escape, restores focus, and releases its resize listener', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(768);
    const media = new EventTarget();
    const remove = vi.spyOn(media, 'removeEventListener');
    vi.spyOn(window, 'matchMedia').mockReturnValue(media as MediaQueryList);
    const actions = document.createElement('section');
    const action = document.createElement('button');
    actions.append(action);
    const bar = new TopBar(document.createElement('section'), actions);
    document.body.append(bar.el);
    const button = bar.el.querySelector<HTMLButtonElement>('.ledger-disclosure')!;
    const details = bar.el.querySelector<HTMLElement>('.ledger-secondary')!;
    expect(details.hidden).toBe(true);
    expect(button.getAttribute('aria-controls')).toBe(details.id);
    button.click();
    expect(details.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    action.focus();
    action.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(details.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    button.click();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    media.dispatchEvent(new Event('change'));
    expect(button.hidden).toBe(true);
    expect(details.hidden).toBe(false);
    bar.dispose();
    expect(remove).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

describe('match sharing credentials', () => {
  const base = 'https://play.example/match';
  it.each(['bots', 'agents'] as const)('offers a read-only spectator link for a %s owner ticket', (mode) => {
    expect(matchShareLinks({ mode, roomId: 'room a', spectator: 'watch/key' }, base)).toEqual([
      { kind: 'spectator', label: 'Copy spectator link', url: `${base}#r=room%20a&t=watch%2Fkey`, hint: 'Copy a read-only link for someone to watch this match.' },
    ]);
  });
  it('preserves legacy PvP invitations without treating them as watch credentials', () => {
    expect(matchShareLinks({ mode: 'pvp', roomId: 'room', invite: 'r=room&t=red' }, base)).toEqual([
      { kind: 'invite', label: 'Copy invite link', url: `${base}#r=room&t=red`, hint: 'Copy the invitation for your opponent to join this match.' },
    ]);
  });
  it('does not invent sharing credentials for direct joins, spectators, or accepted profile invitations', () => {
    expect(matchShareLinks({ roomId: 'room' }, base)).toEqual([]);
    expect(matchShareLinks({ roomId: 'room', mode: 'pvp' }, base)).toEqual([]);
    expect(matchShareLinks({ roomId: 'room', mode: 'bots', invite: 'not-for-this-mode' }, base)).toEqual([]);
  });
});

describe('ledger data semantics', () => {
  it('retains resource chips and whole handwritten numbers through six-digit values', () => {
    const bar = new TopBar(document.createElement('section'), document.createElement('section'));
    const v = view();
    const stock = bar.el.querySelector('.ledger-resource.alloy .ledger-stock')!;
    expect(bar.el.querySelectorAll('.ledger-resource svg.ledger-resource-icon')).toHaveLength(2);
    expect(bar.el.querySelector('.ledger-resource-name')).toBeNull();
    expect(bar.el.querySelector('.ledger-brand img')?.getAttribute('alt')).toBe('Agent Command');
    for (const alloy of [9, 100, 99999, 100000, 999999, 1000000]) {
      bar.update({ ...v, res: { ...v.res, alloy } });
      expect(stock.textContent).toBe(ledgerNumber(alloy));
      expect(bar.el.querySelector('.ledger-stock')).toBe(stock);
    }
    expect(bar.el.querySelector('.ledger-resource.energy')?.getAttribute('aria-label')).toContain('net income 8');
    expect(bar.el.querySelector('[title]')).toBeNull();
    bar.dispose();
  });
  it('shows compact icon income rows, omits zero planes, and reports net energy', () => {
    const bar = new TopBar(document.createElement('section'), document.createElement('section'));
    const v = view();
    v.res.income.depths = { alloy: 3, energy: 0.5, upkeep: 0 };
    v.res.income.surface = { alloy: 2, energy: 0, upkeep: 0 };
    v.res.income.sky = { alloy: 1, energy: 2, upkeep: 0.5 };
    v.res.income.orbit = { alloy: 0, energy: 4, upkeep: 1 };
    v.res.energyRate = 6.5;
    v.res.upkeep = 1.5;
    v.res.solarRate = 12;
    document.body.append(bar.el);
    bar.update(v);
    const alloy = bar.el.querySelector<HTMLElement>('.ledger-resource.alloy')!;
    const energy = bar.el.querySelector<HTMLElement>('.ledger-resource.energy')!;
    alloy.focus();
    let tooltip = document.querySelector('[role="tooltip"]')!;
    expect(tooltip.querySelectorAll('.income-row')).toHaveLength(3);
    expect(tooltip.textContent).not.toContain('gross');
    energy.focus();
    tooltip = document.querySelector('[role="tooltip"]')!;
    // Plane rows only: the solar capacity, the ice-mining note and the solar bank are rows of their own.
    expect(tooltip.querySelectorAll('.income-row:not(.income-capacity):not(.income-ice):not(.income-bank)')).toHaveLength(3);
    expect(tooltip.querySelector('.income-ice')?.textContent).toContain('Ice mining');
    expect(tooltip.querySelectorAll('.income-row svg').length).toBeGreaterThanOrEqual(6);
    expect(tooltip.querySelector('[aria-label^="Depths:"]')?.textContent).toBe('+0.5/s');
    expect(tooltip.querySelector('[aria-label^="Surface:"]')).toBeNull();
    expect(tooltip.querySelector('[aria-label^="Sky:"]')?.textContent).toBe('+2.0/s· −0.5/s');
    expect(tooltip.querySelector('.ac-tooltip-status')?.textContent).toBe('150 · +5.0/s');
    expect(tooltip.querySelector('.income-capacity')?.textContent).toBe('12/s →10/s');
    // The solar bank shows as a gauge on the chip and a stored/max row in the tooltip.
    const bankMax = DEFAULT_RULES.economy.solarBankMax;
    expect(tooltip.querySelector('.income-bank')?.textContent).toBe(`50 / ${bankMax}`);
    expect(energy.querySelector<HTMLElement>('.ledger-bank-fill')?.style.getPropertyValue('--bank')).toBe(`${(50 / bankMax) * 100}%`);
    expect(energy.getAttribute('aria-label')).toContain(`solar bank 50 of ${bankMax}`);
    expect(alloy.querySelector('.ledger-bank')).toBeNull();
    expect(energy.querySelector('.ledger-rate')?.textContent).toBe('+6.5/s');
    expect(energy.hasAttribute('data-tip')).toBe(true);
    expect(energy.hasAttribute('title')).toBe(false);
    bar.dispose();
  });
  it('keeps focused resource, objective, timer and plane chip nodes alive across changing views', () => {
    const timer = new MatchTimer();
    const chips = new PlaneChips(() => {});
    const time = document.createElement('section');
    time.append(timer.el, chips.el);
    const bar = new TopBar(time, document.createElement('section'));
    document.body.append(bar.el);
    const v = view();
    bar.update(v);
    timer.update(v, 0);
    chips.update(v);
    expect(bar.el.hasAttribute('data-own-keys')).toBe(false);
    for (const selector of ['.ledger-resource', '.ledger-segment', '.ledger-event', '.plane-chip']) {
      const node = bar.el.querySelector<HTMLElement>(selector)!;
      node.focus();
      bar.update({ ...v, res: { ...v.res, alloy: 99999 } });
      timer.update(v, 100);
      chips.update(view({ tick: 100, alerts: [{ plane: 'orbit', kind: 'rocks', tick: 400 }] }));
      expect(document.activeElement).toBe(node);
      expect(bar.el.querySelector(selector)).toBe(node);
    }
    bar.dispose();
  });
  it('does not invent enemy health and identifies our team correctly', () => {
    const bar = new TopBar(document.createElement('section'), document.createElement('section'));
    bar.update(view({ army: 'se' }));
    expect(bar.el.querySelectorAll('.ledger-segment.unknown')).toHaveLength(4);
    expect(bar.el.querySelector('.ledger-segment')?.getAttribute('aria-label')).toContain('Our Orbit Spire');
    expect(bar.el.querySelector('.ledger-segment.unknown')?.getAttribute('aria-label')).toContain('Blue Orbit Spire: not visible');
    expect(bar.el.querySelector('.ledger-segment.unknown')?.textContent).toBe('');
    expect([...bar.el.querySelectorAll('.ledger-plane-icon')].map((e) => e.getAttribute('aria-label'))).toEqual(['Orbit', 'Sky', 'Surface', 'Depths']);
    expect(bar.el.querySelectorAll('.ledger-plane-icon svg')).toHaveLength(4);
    expect(bar.el.querySelectorAll('.ledger-side svg')).toHaveLength(2);
    expect(bar.el.querySelector('.ledger-objective')?.textContent).toBe('');
    bar.dispose();
  });
  it('draws one Spire bar per hostile army in its colour, tracking sightings and eliminations', () => {
    const sim = new Sim(3, { map: { params: { slots: 4 } } });
    const own = gameView(sim, 'nw') as MatchView;
    expect(own.match.armies.map((a) => [a.id, a.colour])).toEqual([['nw', 'blue'], ['ne', 'red'], ['se', 'green'], ['sw', 'violet']]);
    const bar = new TopBar(document.createElement('section'), document.createElement('section'));
    bar.update(own);
    const rows = () => [...bar.el.querySelectorAll<HTMLElement>('.ledger-spire-row[data-army]')];
    expect(rows().map((r) => [r.dataset.army, r.classList.contains('hostile')])).toEqual([['nw', false], ['ne', true], ['se', true], ['sw', true]]);
    expect(rows().map((r) => r.querySelector('.ledger-side')?.getAttribute('aria-label'))).toEqual(['Our Spire', 'Red Spire', 'Green Spire', 'Violet Spire']);
    expect(rows()[2]!.getAttribute('style')).toContain('--army-green');
    for (const row of rows()) expect(row.querySelectorAll('.ledger-segment')).toHaveLength(4);
    expect(bar.el.querySelector('.ledger-objective')?.getAttribute('data-hostiles')).toBe('3');
    // Spires out of sight stay unknown; a sighted Spire shows its health; an eliminated army reads as dead.
    for (const row of rows().slice(1)) expect(row.querySelectorAll('.ledger-segment.unknown')).toHaveLength(4);
    const spire = gameView(sim, 'se').entities.find((e) => e.kind === 'spire' && e.side === 'se' && e.plane === 'surface')!;
    const first = rows();
    bar.update({ ...own, entities: [...own.entities, { ...spire, hp: spire.maxHp! / 2 }], eliminated: ['sw'] });
    expect(rows()).toEqual(first);
    const green = rows()[2]!.querySelectorAll('.ledger-segment');
    expect([...green].filter((s) => !s.classList.contains('unknown'))).toHaveLength(1);
    expect(rows()[2]!.querySelector('[aria-label^="Green Surface Spire"]')?.getAttribute('aria-label')).toBe(`Green Surface Spire: ${spire.maxHp! / 2} / ${spire.maxHp} HP`);
    expect(rows()[3]!.querySelectorAll('.ledger-segment.dead')).toHaveLength(4);
    expect(rows()[3]!.querySelector('.ledger-segment')?.getAttribute('aria-label')).toContain('Violet Orbit Spire: eliminated');
    expect(rows()[1]!.querySelectorAll('.ledger-segment.unknown')).toHaveLength(4);
    bar.dispose();
  });
  it('counts the match timer down to the time cap and reads an absent cap as no limit', () => {
    const timer = new MatchTimer();
    timer.update(view(), 0);
    expect(timer.el.getAttribute('aria-label')).toBe('No time limit');
    expect(timer.el.classList.contains('idle')).toBe(true);
    timer.update(view({ match: { ...snapshot.match!, rules: { ...snapshot.match!.rules, spire: { ...snapshot.match!.rules.spire, timeCap: 1800 } } } }), 20);
    expect(timer.el.textContent).toBe('29:59');
    expect(timer.el.getAttribute('aria-label')).toBe('Time cap in 29:59');
    expect(timer.el.querySelectorAll('.hud-stamp svg.ledger-event-icon')).toHaveLength(1);
  });
});

describe('plane chips', () => {
  const busy: View['alerts'] = [
    { plane: 'depths', kind: 'wall_dig', x: 19.5, y: 20.5, stage: 3 },
    { plane: 'depths', kind: 'magma', tick: 2000, x: 9.5, y: 9.5 },
    { plane: 'surface', kind: 'drop', tick: 300, x: 20, y: 22, side: 'se' },
    { plane: 'sky', kind: 'storm_peak', tick: 1300, x: 30, y: 14 },
    { plane: 'sky', kind: 'storm_forming', tick: 1500, x: 12, y: 30 },
    { plane: 'orbit', kind: 'rocks', tick: 150 },
  ];
  const chipOf = (chips: PlaneChips, plane: string) => chips.el.querySelector<HTMLButtonElement>(`.plane-chip[data-plane="${plane}"]`)!;

  it('lists the public derelict gate windows and the next core for the Orbit chip', () => {
    const schedule: View['schedule'] = [
      { kind: 'derelict_open', tick: 100, until: 340 },
      { kind: 'derelict_open', tick: 900, until: 1140 },
      { kind: 'core_regrows', tick: 1300 },
      { kind: 'asteroid_spawn', tick: 500 },
    ];
    expect(scheduleLines({ tick: 200, schedule })).toEqual([
      'Derelict gates open · close in 00:07',
      'Derelict gates open in 00:35 · for 00:12',
      'New derelict core in 00:55',
    ]);
  });

  it('runs Orbit → Depths with plane icons and stays quiet and dim, without dashes, when nothing is pending', () => {
    const chips = new PlaneChips(() => {});
    chips.update(view({ alerts: [] }));
    const all = [...chips.el.querySelectorAll<HTMLButtonElement>('.plane-chip')];
    expect(all.map((c) => c.dataset.plane)).toEqual(['orbit', 'sky', 'surface', 'depths']);
    for (const chip of all) {
      expect(chip.querySelector('svg.plane-chip-icon')).not.toBeNull();
      expect(chip.classList.contains('idle')).toBe(true);
      expect(chip.classList.contains('urgent')).toBe(false);
      expect(chip.textContent).toBe('');
      expect(chip.hasAttribute('title')).toBe(false);
      expect(chip.hasAttribute('data-tip')).toBe(true);
    }
    expect(chipOf(chips, 'depths').getAttribute('aria-label')).toBe('Depths: Quiet below: no intruders, digging in, charges, tremors or magma');
  });

  it('shows each plane its most relevant item: countdown and compact label, the line in its tooltip and label', () => {
    const chips = new PlaneChips(() => {});
    chips.update(view({ tick: 100, alerts: busy }));
    const text = (plane: string) => [chipOf(chips, plane).querySelector('.ledger-number')!.textContent, chipOf(chips, plane).querySelector('.plane-chip-label')!.textContent];
    expect(text('orbit')).toEqual(['00:03', 'Rocks']);
    expect(text('sky')).toEqual(['01:00', 'Peak']);
    expect(text('surface')).toEqual(['00:10', 'Drop']);
    expect(text('depths')).toEqual(['3/4', 'Digging in']);
    expect(chipOf(chips, 'surface').getAttribute('aria-label')).toBe('Surface: Drop lands in 00:10 · enemy at 20, 22');
    expect(chipOf(chips, 'sky').getAttribute('aria-label')).toBe('Sky: Storm at peak · breaks up in 01:00 at 30, 14');
    // Urgent: under 10 s, or a breakthrough threat; a drop 10 s out is not yet.
    expect(['orbit', 'sky', 'surface', 'depths'].map((p) => chipOf(chips, p).classList.contains('urgent'))).toEqual([true, false, false, true]);
    chips.update(view({ tick: 120, alerts: busy }));
    expect(chipOf(chips, 'surface').classList.contains('urgent')).toBe(true);
  });

  it('jumps to the plane and the spot of its leading item, or just the plane when it has none', () => {
    const jump = vi.fn();
    const chips = new PlaneChips(jump);
    chips.update(view({ tick: 100, alerts: busy }));
    chipOf(chips, 'depths').click();
    chipOf(chips, 'orbit').click();
    chips.update(view({ tick: 100, alerts: [] }));
    chipOf(chips, 'sky').click();
    expect(jump.mock.calls).toEqual([['depths', 19.5, 20.5], ['orbit', undefined, undefined], ['sky', undefined, undefined]]);
  });

  it('renders the alerts the game derives from the team view', () => {
    const sim = new Sim(1);
    // Known to both teams (seen, felt or in its public window): only a known hostile charge raises the alert.
    sim.charges.push({ side: 1, c: 30 * sim.size + 12, at: sim.tick + 160, defuse: 0, stack: 1, reach: sim.econ.chasmReach, known: 3 });
    const v = { ...gameView(sim, 'nw'), signals: [] };
    const chips = new PlaneChips(() => {});
    chips.update(v);
    expect(chipOf(chips, 'depths').querySelector('.ledger-number')!.textContent).toBe('00:08');
    expect(chipOf(chips, 'depths').classList.contains('urgent')).toBe(true);
    expect(chipOf(chips, 'depths').getAttribute('aria-label')).toBe('Depths: Enemy charge blows in 00:08 at 12, 30');
    expect(chipOf(chips, 'orbit').classList.contains('idle')).toBe(false);
  });

  const request = (extra: Partial<SignalEntry> = {}): SignalEntry =>
    ({ kind: 'request_support', id: 'sg_1', from: 'depths', to: 'surface', tick: 100, expires: 700, state: 'submitted', need: 'troops', x: 12, y: 20, ...extra }) as SignalEntry;
  const hooks = (mine: Plane[] = []) => ({ mine: vi.fn((p: Plane) => mine.includes(p)), open: vi.fn(), answer: vi.fn() }) satisfies SignalHooks;

  it('leads the asked plane’s chip with an open request: expiry countdown, need glyph and label, only on that plane', () => {
    const chips = new PlaneChips(() => {}, hooks());
    chips.update(view({ tick: 100, alerts: busy, signals: [request()] }));
    const surface = chipOf(chips, 'surface');
    expect(surface.querySelector('.ledger-number')!.textContent).toBe('00:30');
    expect(surface.querySelector('.plane-chip-label')!.textContent).toBe('Troops');
    expect(surface.querySelector('.plane-chip-need svg.icon-need_troops')).not.toBeNull();
    expect(surface.classList.contains('request')).toBe(true);
    expect(surface.classList.contains('urgent')).toBe(true);
    expect(surface.getAttribute('aria-label')).toBe('Surface: Depths needs troops · 00:30 left at 12, 20');
    // The sender and every other plane keep their own items.
    for (const plane of ['orbit', 'sky', 'depths']) {
      expect(chipOf(chips, plane).classList.contains('request'), plane).toBe(false);
      expect(chipOf(chips, plane).querySelector('.plane-chip-need')!.childElementCount, plane).toBe(0);
    }
    expect(chipOf(chips, 'depths').querySelector('.plane-chip-label')!.textContent).toBe('Digging in');
    expect(surface.hasAttribute('title')).toBe(false);
  });

  it('shows a team request on every plane that answers it until one takes it, then on the taker only; closed ones go', () => {
    const chips = new PlaneChips(() => {}, hooks());
    const team = request({ from: 'sky', to: 'team' });
    const asked = () => PLANES.filter((p) => chipOf(chips, p).classList.contains('request'));
    chips.update(view({ tick: 100, signals: [team] }));
    expect(asked()).toEqual(['depths', 'surface']);
    chips.update(view({ tick: 140, signals: [{ ...team, state: 'working', by: 'depths' }] }));
    expect(asked()).toEqual(['depths']);
    expect(chipOf(chips, 'depths').classList.contains('urgent')).toBe(false);
    expect(chipOf(chips, 'depths').getAttribute('aria-label')).toBe('Depths: Sky needs troops · 00:28 left · Depths on it at 12, 20');
    chips.update(view({ tick: 200, signals: [{ ...team, state: 'completed', by: 'depths' }] }));
    expect(asked()).toEqual([]);
    expect(chipOf(chips, 'depths').classList.contains('idle')).toBe(true);
  });

  it('caps requests and alerts together at the per-plane alert limit, soonest-expiring request first', () => {
    const chips = new PlaneChips(() => {}, hooks());
    document.body.append(chips.el);
    const signals = [request({ id: 'sg_1', expires: 900 }), request({ id: 'sg_2', expires: 400, need: 'flak' })];
    chips.update(view({ tick: 100, alerts: [...busy, { plane: 'surface', kind: 'drop', tick: 500, x: 1, y: 1 }, { plane: 'surface', kind: 'drop', tick: 600, x: 2, y: 2 }], signals }));
    const surface = chipOf(chips, 'surface');
    expect(surface.querySelector('.plane-chip-label')!.textContent).toBe('Flak');
    surface.focus();
    const lines = [...document.querySelectorAll('.plane-chip-tip > div')].map((d) => d.textContent);
    expect(lines).toHaveLength(ALERTS_PER_PLANE);
    expect(lines[0]).toContain('flak');
    expect(lines[1]).toContain('troops');
    expect(lines[2]).toContain('Drop lands');
  });

  it('opens a request through the game on click (jump and take it there); without hooks it jumps to the tile', () => {
    const h = hooks(['surface']);
    const chips = new PlaneChips(vi.fn(), h);
    const r = request();
    chips.update(view({ tick: 100, signals: [r] }));
    expect(chipOf(chips, 'surface').getAttribute('aria-label')).toBe('Surface: Depths needs troops · 00:30 left at 12, 20 · click to take it');
    chipOf(chips, 'surface').click();
    expect(h.open).toHaveBeenCalledWith(r, 'surface');
    const jump = vi.fn();
    const plain = new PlaneChips(jump);
    plain.update(view({ tick: 100, signals: [r] }));
    chipOf(plain, 'surface').click();
    expect(jump).toHaveBeenCalledWith('surface', 12.5, 20.5);
  });

  it('renders requests from the viewing team’s own board only (fog): another team’s view carries none', () => {
    // The host's board (what AgentCommandGame and the PlayerThree host attach as `view.signals`), over the game's
    // vocabulary; the manifest module itself reads skill files, which this DOM environment cannot.
    const board = new SignalBoard({ signals: SIGNALS, roles: { values: PLANES }, tickRate: TICK_RATE } as unknown as AnyManifest, ['nw', 'se'], SIGNAL_LIMITS_MAX);
    const sim = new Sim(1);
    expect(board.apply('nw', 'depths', { kind: 'signal', signal: { kind: 'request_support', to: 'surface', need: 'troops', x: 10, y: 11 } }, sim.tick)).toEqual({ ok: true });
    const ours = { ...gameView(sim, 'nw'), signals: board.team('nw') } as View;
    const theirs = { ...gameView(sim, 'se'), signals: board.team('se') } as View;
    expect(ours.signals).toHaveLength(1);
    expect(theirs.signals).toEqual([]);
    const chips = new PlaneChips(() => {});
    chips.update({ ...ours, alerts: [] });
    expect(chipOf(chips, 'surface').classList.contains('request')).toBe(true);
    chips.update({ ...theirs, alerts: [] });
    expect(PLANES.some((p) => chipOf(chips, p).classList.contains('request'))).toBe(false);
    // The chips read requests from `signals` alone: the same team view without its board shows none.
    chips.update({ ...ours, alerts: [], signals: [] });
    expect(chipOf(chips, 'surface').classList.contains('idle')).toBe(true);
  });
});

describe('daylight dial', () => {
  it('keeps the daylight dial, phase icons, and capped clock stable without visible prose', () => {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), translate: vi.fn(), beginPath: vi.fn(),
      arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      fillRect: vi.fn(), strokeRect: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const dial = new SunDial();
    document.body.append(dial.el);
    const clock = dial.el.querySelector<HTMLElement>('.ledger-clock')!;
    const phases = [...dial.el.querySelectorAll<HTMLElement>('.sun-phase')];
    const size = DEFAULT_RULES.map.size;
    const base = spirePositions(DEFAULT_RULES.map.spireInset, size).nw;
    const angle = Math.atan2(base.y - size / 2, base.x - size / 2);
    const v = view();
    dial.update(v, angle);
    dial.el.focus();
    expect(phases.map((phase) => phase.hidden)).toEqual([true, false]);
    expect(dial.el.getAttribute('aria-label')).toContain('dusk');
    dial.update(v, angle + Math.PI / 2);
    expect(phases.map((phase) => phase.hidden)).toEqual([false, true]);
    expect(dial.el.getAttribute('aria-label')).toContain('dawn');
    expect(document.activeElement).toBe(dial.el);
    expect(dial.el.querySelector('.ledger-clock')).toBe(clock);
    expect(clock.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(dial.el.textContent).toBe(clock.textContent);
    dial.update(view({ match: { ...v.match!, sun: { ...v.match!.sun, speed: 0 } } }), angle);
    expect(clock.textContent).toBe('—');
    expect(clock.style.getPropertyValue('--figures')).toBe(String(NUMBER_WIDTHS.clock));
    expect(dial.el.querySelector('[title]')).toBeNull();
    expect(dial.el.hasAttribute('title')).toBe(false);
  });
});
