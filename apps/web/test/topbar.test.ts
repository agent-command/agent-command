// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sim } from '../../../packages/game/src/sim/sim.ts';
import { view as gameView } from '../../../packages/game/src/agent/present.ts';
import { SignalBoard } from 'playerthree/signals';
import type { AnyManifest } from 'playerthree/manifest';
import { ALERTS_PER_PLANE, DEFAULT_RULES, PLANES, SIGNAL_LIMITS_MAX, SIGNALS, TICK_RATE, resolveRules, spirePositions, type Entity, type Plane, type View } from '@agent-command/game/contract';
import type { MatchView } from '../src/match-view.ts';
import { LEDGER_SCOPE_STORAGE, ledgerClock, ledgerNumber, ledgerRate, matchShareLinks, NUMBER_WIDTHS, numberSlot, SCOPE_MOTION, stockSlotMetrics, TopBar } from '../src/topbar.ts';
import { daylight, MatchTimer, PlaneChips, SunDial, scheduleLines } from '../src/plan-hud.ts';
import { PlaneDashboard, type DashboardInput } from '../src/plane-dashboard.ts';
import { isLedgerScopeKey } from '../src/keymap.ts';
import { winLine } from '../src/text.ts';
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

const section = () => document.createElement('section');
const topBar = (time = section(), actions = section(), dashboard = section()) => new TopBar({ time, actions, dashboard });

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); sessionStorage.clear(); });

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

describe('top bar scope', () => {
  const actionsRow = () => {
    const actions = section();
    actions.append(Object.assign(document.createElement('div'), { className: 'top-actions' }));
    return actions;
  };
  /** A stand-in for the Web Animations API: records each animation; `finish` ends them all. */
  const recordAnimations = () => {
    const anims: { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; onfinish: (() => void) | null; cancel(): void }[] = [];
    vi.spyOn(Element.prototype, 'animate').mockImplementation(function (this: Element, keyframes, options) {
      const a = { el: this, keyframes: keyframes as Keyframe[], options: (options ?? {}) as KeyframeAnimationOptions, onfinish: null as (() => void) | null, oncancel: null, cancel() {} };
      anims.push(a);
      return a as unknown as Animation;
    });
    return { anims, finish: () => { for (const a of anims.splice(0)) a.onfinish?.(); } };
  };
  /** The bar measures 1300 px with the dashboard, 1000 px with every plane; each group 400 px. */
  const widths = () => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const bar = (this as HTMLElement).closest<HTMLElement>('.topbar');
    const width = this === bar ? (bar!.dataset.scope === 'plane' ? 1300 : 1000) : 400;
    return { width, height: 56, left: 0, right: width, top: 0, bottom: 56, x: 0, y: 0 } as DOMRect;
  });

  it('opens on the plane dashboard; the All button shows every plane, pressed, for the rest of the session', () => {
    const actions = actionsRow();
    const bar = topBar(section(), actions);
    const button = bar.scopeButton;
    expect(actions.querySelector('.top-actions')!.firstElementChild).toBe(button);
    expect([bar.scope, bar.el.dataset.scope, button.getAttribute('aria-pressed')]).toEqual(['plane', 'plane', 'false']);
    expect(button.textContent).toBe('All');
    expect(button.getAttribute('aria-label')).toBe('All planes (Alt+A)');
    expect(button.hasAttribute('data-tip')).toBe(true);
    expect(button.hasAttribute('title')).toBe(false);
    button.click();
    expect([bar.scope, bar.el.dataset.scope, button.getAttribute('aria-pressed')]).toEqual(['all', 'all', 'true']);
    expect(sessionStorage.getItem(LEDGER_SCOPE_STORAGE)).toBe('all');
    // A later bar this session (a reload, the next match) opens where the player left it.
    expect(topBar().scope).toBe('all');
    button.click();
    expect(bar.scope).toBe('plane');
    expect(topBar().scope).toBe('plane');
  });

  it('toggles on Alt+A by key position only, never on A alone or with other modifiers', () => {
    const key = (init: Partial<KeyboardEvent>) => ({ code: 'KeyA', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init });
    expect(isLedgerScopeKey(key({ altKey: true }))).toBe(true);
    // macOS Option+A types "å": the key position still matches.
    expect(isLedgerScopeKey(new KeyboardEvent('keydown', { key: 'å', code: 'KeyA', altKey: true }))).toBe(true);
    for (const init of [{}, { altKey: true, ctrlKey: true }, { altKey: true, metaKey: true }, { altKey: true, shiftKey: true }, { altKey: true, code: 'KeyS' }, { code: 'F5' }]) {
      expect(isLedgerScopeKey(key(init)), JSON.stringify(init)).toBe(false);
    }
  });

  it('tweens the bar to its new width while the groups fade out, then in, never both at once', () => {
    const { anims, finish } = recordAnimations();
    widths();
    const dashboard = section();
    const bar = topBar(section(), actionsRow(), dashboard);
    document.body.append(bar.el);
    const ledger = bar.el.querySelector<HTMLElement>('.ledger-all')!;
    bar.setScope('all');
    const of = (el: Element) => anims.find((a) => a.el === el)!;
    expect(of(bar.el).keyframes).toEqual([{ width: '1300px' }, { width: '1000px' }]);
    expect(of(bar.el).options).toMatchObject({ duration: SCOPE_MOTION.width, easing: SCOPE_MOTION.easing });
    expect(of(dashboard).keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(of(ledger).keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(of(ledger).options.delay).toBeGreaterThanOrEqual(of(dashboard).options.duration as number);
    expect(of(ledger).options.fill).toBe('backwards');
    expect((of(ledger).options.delay as number) + (of(ledger).options.duration as number)).toBeLessThanOrEqual(SCOPE_MOTION.width);
    // Mid-tween: the outgoing group is out of the flow at its drawn width, the incoming one held at its final width,
    // and the bar clips both.
    expect(dashboard.classList.contains('leaving')).toBe(true);
    expect(dashboard.style.width).toBe('400px');
    expect(ledger.style.flex).toBe('0 0 400px');
    expect(bar.el.classList.contains('tweening')).toBe(true);
    finish();
    expect(dashboard.classList.contains('leaving')).toBe(false);
    expect([dashboard.style.width, ledger.style.flex]).toEqual(['', '']);
    expect(bar.el.classList.contains('tweening')).toBe(false);
    // Switching back mid-tween settles the running one first.
    bar.setScope('plane');
    bar.setScope('all');
    expect(bar.el.querySelectorAll('.leaving')).toHaveLength(1);
    bar.dispose();
  });

  it('with reduced motion swaps at once: no tween, no fade', () => {
    const { anims } = recordAnimations();
    widths();
    vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: q.includes('reduce'), media: q }) as unknown as MediaQueryList);
    const bar = topBar(section(), actionsRow());
    document.body.append(bar.el);
    bar.setScope('all');
    expect(anims).toEqual([]);
    expect(bar.el.querySelector('.leaving')).toBeNull();
    expect(bar.el.classList.contains('tweening')).toBe(false);
    expect(bar.el.dataset.scope).toBe('all');
  });

  it('moves keyboard focus to the All button when the focused control is in the group it hides', () => {
    sessionStorage.setItem(LEDGER_SCOPE_STORAGE, 'all');
    const time = section();
    const chip = document.createElement('button');
    time.append(chip);
    const bar = topBar(time, actionsRow());
    document.body.append(bar.el);
    chip.focus();
    bar.setScope('plane');
    expect(document.activeElement).toBe(bar.scopeButton);
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
    const bar = topBar();
    const v = view();
    const stock = bar.el.querySelector('.ledger-resource.alloy .ledger-stock')!;
    expect(bar.el.querySelectorAll('.ledger-resource svg.ledger-resource-icon')).toHaveLength(2);
    expect(bar.el.querySelector('.ledger-resource-name')).toBeNull();
    // The square badge, never the wide logo.
    const brand = bar.el.querySelector<HTMLImageElement>('img.ledger-brand')!;
    expect(brand.getAttribute('alt')).toBe('Agent Command');
    expect(brand.getAttribute('srcset')).toContain('180w');
    expect(brand.getAttribute('src')).not.toContain('logo');
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
    const bar = topBar();
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
    // The solar bank is a stored/max row in the tooltip; the chip keeps only its stock and rate.
    const bankMax = DEFAULT_RULES.economy.solarBankMax;
    expect(tooltip.querySelector('.income-bank')?.textContent).toBe(`50 / ${bankMax}`);
    expect(bar.el.querySelector('.ledger-bank')).toBeNull();
    expect(energy.getAttribute('aria-label')).toContain(`solar bank 50 of ${bankMax}`);
    expect(energy.querySelector('.resource-detail')?.children).toHaveLength(1);
    expect(energy.querySelector('.ledger-rate')?.textContent).toBe('+6.5/s');
    expect(energy.hasAttribute('data-tip')).toBe(true);
    expect(energy.hasAttribute('title')).toBe(false);
    bar.dispose();
  });
  it('keeps focused resource, objective, timer, plane chip and dashboard nodes alive across changing views', () => {
    const timer = new MatchTimer();
    const chips = new PlaneChips(() => {});
    const dashboard = new PlaneDashboard(() => {});
    const time = section();
    time.append(timer.el, chips.el);
    const bar = topBar(time, section(), dashboard.el);
    document.body.append(bar.el);
    const v = view();
    const input = (focus: Plane): DashboardInput => ({ focus, sunAngle: 0, lead: (p) => chips.lead(p) });
    bar.update(v);
    timer.update(v, 0);
    chips.update(v);
    dashboard.update(v, input('surface'));
    expect(bar.el.hasAttribute('data-own-keys')).toBe(false);
    for (const selector of ['.ledger-resource', '.ledger-segment', '.ledger-event', '.plane-chip', '.dash-bar', '.dash-next', '.dash-time', '.dash-mini[data-plane="sky"]']) {
      const node = bar.el.querySelector<HTMLElement>(selector)!;
      node.focus();
      bar.update({ ...v, res: { ...v.res, alloy: 99999 } });
      timer.update(v, 100);
      const next = view({ tick: 100, alerts: [{ plane: 'orbit', kind: 'rocks', tick: 400 }, { plane: 'surface', kind: 'segment_threatened' }], spire: PLANES.map((plane) => ({ plane, hp: 6000, maxHp: 7000, ...(plane === 'surface' ? { threatened: true } : {}) })) });
      chips.update(next);
      // Diving re-scopes the same nodes.
      dashboard.update(next, input('depths'));
      dashboard.update(next, input('surface'));
      expect(document.activeElement, selector).toBe(node);
      expect(bar.el.querySelector(selector)).toBe(node);
    }
    bar.dispose();
  });
  it('does not invent enemy health and identifies our team correctly', () => {
    const bar = topBar();
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
    const bar = topBar();
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

  it('a threatened Spire outranks every request: it leads, pulses and keeps its slot under the cap', () => {
    const jump = vi.fn();
    const h = hooks(['surface']);
    const chips = new PlaneChips(jump, h);
    document.body.append(chips.el);
    const signals = [request({ id: 'sg_1', expires: 900 }), request({ id: 'sg_2', expires: 400, need: 'flak' }), request({ id: 'sg_3', expires: 500, need: 'scan' })];
    chips.update(view({ tick: 100, alerts: [{ plane: 'surface', kind: 'segment_threatened' }, ...busy], signals }));
    const surface = chipOf(chips, 'surface');
    expect(surface.querySelector('.plane-chip-label')!.textContent).toBe('Spire');
    expect(surface.querySelector('.plane-chip-need')!.childElementCount).toBe(0);
    expect(surface.classList.contains('request')).toBe(false);
    expect(surface.classList.contains('urgent')).toBe(true);
    expect(surface.getAttribute('aria-label')).toBe('Surface: Our Spire segment here is under attack or low · ask the team to defend it');
    surface.focus();
    const lines = [...document.querySelectorAll('.plane-chip-tip > div')].map((d) => d.textContent);
    expect(lines).toHaveLength(ALERTS_PER_PLANE);
    expect(lines[0]).toContain('Our Spire segment');
    expect(lines.slice(1).map((l) => l!.split(' · ')[0])).toEqual(['Depths needs flak', 'Depths needs scan']);
    // No request line offers "click to take it": a click goes to the plane, not into a request.
    expect(lines.some((l) => l!.includes('click to take it'))).toBe(false);
    surface.click();
    expect(h.open).not.toHaveBeenCalled();
    expect(jump).toHaveBeenCalledWith('surface', undefined, undefined);
  });

  it('names each plane’s leading item in plain words, without map spots, for the plane dashboard', () => {
    const chips = new PlaneChips(() => {});
    const schedule: View['schedule'] = [{ kind: 'derelict_open', tick: 300, until: 500 }];
    chips.update(view({ tick: 100, alerts: busy, signals: [request()], schedule }));
    expect(chips.lead('surface')).toEqual({ text: 'Depths needs troops · 00:30 left', tone: 'urgent' });
    expect(chips.lead('depths')).toEqual({ text: 'Enemy digging into your wall · crack 3/4', tone: 'urgent' });
    expect(chips.lead('sky')).toEqual({ text: 'Storm at peak · breaks up in 01:00', tone: 'alert' });
    chips.update(view({ tick: 100, alerts: [], signals: [], schedule }));
    expect(chips.lead('orbit')).toEqual({ text: 'Derelict gates open in 00:10 · for 00:10', tone: 'quiet' });
    expect(chips.lead('surface')).toEqual({ text: 'No charges under us or drops incoming', tone: 'quiet' });
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

describe('plane dashboard', () => {
  const ent = ({ id = 1, ...e }: Omit<Partial<Entity>, 'id'> & { id?: number }): Entity => ({ kind: 'tank', side: 'nw', plane: 'surface', x: 10, y: 10, hp: 100, maxHp: 100, state: 'idle', ...e, id: `e${id}` }) as Entity;
  const quiet: DashboardInput['lead'] = () => ({ text: 'Nothing scheduled', tone: 'quiet' });
  const input = (focus: Plane, extra: Partial<DashboardInput> = {}): DashboardInput => ({ focus, sunAngle: 0, lead: quiet, ...extra });
  const make = () => {
    const jump = vi.fn();
    const d = new PlaneDashboard(jump);
    document.body.append(d.el);
    return { d, jump };
  };
  const text = (d: PlaneDashboard, selector: string) => d.el.querySelector(selector)!.textContent;
  const stats = (d: PlaneDashboard) => [...d.el.querySelectorAll('.dash-stat')].map((s) => [s.querySelector('.dash-v')!.textContent, s.querySelector('.dash-l')!.textContent]);
  const minis = (d: PlaneDashboard) => [...d.el.querySelectorAll<HTMLElement>('.dash-mini')].filter((m) => !m.hidden).map((m) => m.dataset.plane);
  const hp = (threatened: Plane[] = [], hp = 6000) => PLANES.map((plane) => ({ plane, hp, maxHp: 7000, ...(threatened.includes(plane) ? { threatened: true } : {}) }));

  it('scopes to the plane in view: its Spire, two key numbers from the team view, and the other three planes', () => {
    const { d } = make();
    const posts = snapshot.match!.posts.length;
    expect(posts).toBeGreaterThan(0);
    const v = view({
      entities: [
        ent({ id: 1, kind: 'post', side: 'nw' }), ent({ id: 2, kind: 'post', side: 'nw' }), ent({ id: 3, kind: 'post', side: 'se' }),
        ent({ id: 4, kind: 'headframe' }), ent({ id: 5, kind: 'headframe', side: 'se' }),
        ent({ id: 6, kind: 'island', plane: 'sky', side: 'nw' }), ent({ id: 7, kind: 'island', plane: 'sky', side: 'nw' }), ent({ id: 8, kind: 'island', plane: 'sky', side: 'neutral' }),
        ent({ id: 9, kind: 'solar', plane: 'orbit', x: 4, y: 4 }), ent({ id: 10, kind: 'solar', plane: 'orbit', x: 40, y: 40 }),
        ent({ id: 11, kind: 'digger', plane: 'depths' }), ent({ id: 12, kind: 'digger', plane: 'depths' }), ent({ id: 13, kind: 'digger', plane: 'depths', hp: 0 }),
      ],
      alerts: [{ plane: 'sky', kind: 'storm_peak', tick: 1300, x: 30, y: 14 }],
      oreCaches: [{ id: 1, x: 5, y: 5, alloy: 0, radius: 2, below: { x: 5, y: 5, alloy: 120 } }, { id: 2, x: 9, y: 9, alloy: 40, radius: 2, below: { x: 9, y: 9, alloy: 30 } }],
    });
    d.update(v, input('surface'));
    expect(text(d, '.dash-spire .dash-k')).toBe('Surface Spire');
    expect(text(d, '.dash-next .dash-k')).toBe('Next on Surface');
    expect(stats(d)).toEqual([[`2/${posts}`, 'posts held'], ['1', 'headframes']]);
    expect(minis(d)).toEqual(['orbit', 'sky', 'depths']);
    d.update(v, input('sky'));
    expect(text(d, '.dash-spire .dash-k')).toBe('Sky Spire');
    expect(stats(d)).toEqual([['2/3', 'islands held'], ['at peak', 'weather']]);
    expect(minis(d)).toEqual(['orbit', 'surface', 'depths']);
    d.update(v, input('orbit', { sunAngle: 1.2 }));
    const sun = daylight(v, 1.2);
    expect(stats(d)).toEqual([[`${sun.lit}/2`, 'arrays lit'], [`${sun.baseLit ? 'dusk' : 'dawn'} ${ledgerClock(sun.edgeIn)}`, 'sun']]);
    d.update(v, input('depths'));
    expect(stats(d)).toEqual([['2', 'diggers'], ['150', 'ore in caches']]);
    expect(minis(d)).toEqual(['orbit', 'sky', 'surface']);
    d.update({ ...v, alerts: [] }, input('sky'));
    expect(stats(d)[1]).toEqual(['clear', 'weather']);
  });

  it('pairs our Spire with each rival’s: hatched "not scouted" until seen, its seen health after', () => {
    const { d } = make();
    d.update(view(), input('surface'));
    const who = () => [...d.el.querySelectorAll('.dash-who')].map((w) => w.textContent);
    const bars = () => [...d.el.querySelectorAll<HTMLElement>('.dash-bar')];
    expect(who()).toEqual(['You', 'Red']);
    expect(bars().map((b) => b.textContent)).toEqual(['7000 / 7000', 'not scouted']);
    expect(bars()[1]!.classList.contains('unknown')).toBe(true);
    expect(bars()[1]!.getAttribute('aria-label')).toBe('Red Surface Spire: not scouted');
    const seen = view({ entities: [ent({ id: 40, kind: 'spire', side: 'se', plane: 'surface', hp: 3500, maxHp: 7000 })] });
    d.update(seen, input('surface'));
    expect(bars().map((b) => b.textContent)).toEqual(['7000 / 7000', '3500 / 7000']);
    expect(bars()[1]!.classList.contains('unknown')).toBe(false);
    expect(bars()[1]!.querySelector<HTMLElement>('.dash-fill')!.style.width).toBe('50%');
    // Another plane's sighting says nothing about this one.
    d.update(seen, input('sky'));
    expect(bars()[1]!.textContent).toBe('not scouted');
    d.update({ ...seen, eliminated: ['se'] }, input('surface'));
    expect(bars()[1]!.textContent).toBe('eliminated');
  });

  it('a hit on this plane overrides Next and pulses our bar; a hit elsewhere turns that plane’s mini into a pill', () => {
    const { d, jump } = make();
    const lead: DashboardInput['lead'] = (p) => ({ text: p === 'surface' ? 'Drop lands in 00:10' : 'Quiet', tone: 'urgent' });
    d.update(view({ spire: hp() }), input('surface', { lead }));
    const next = d.el.querySelector<HTMLElement>('.dash-next')!;
    expect([text(d, '.dash-next .dash-k'), text(d, '.dash-next .dash-text')]).toEqual(['Next on Surface', 'Drop lands in 00:10']);
    expect([next.classList.contains('warn'), next.classList.contains('bad')]).toEqual([true, false]);
    expect(d.el.querySelector('.dash-mini.hit')).toBeNull();
    d.update(view({ spire: hp(['surface', 'sky']) }), input('surface', { lead }));
    const ours = d.el.querySelector<HTMLElement>('.dash-bar')!;
    expect(ours.classList.contains('hit')).toBe(true);
    expect(ours.textContent).toBe('HIT · 6000 / 7000');
    expect([text(d, '.dash-next .dash-k'), text(d, '.dash-next .dash-text')]).toEqual(['Surface · now', 'Your Surface Spire is under attack']);
    expect([next.classList.contains('warn'), next.classList.contains('bad')]).toEqual([false, true]);
    expect(next.dataset.tip).toBe('Your Surface Spire is under attack');
    const mini = (p: Plane) => d.el.querySelector<HTMLButtonElement>(`.dash-mini[data-plane="${p}"]`)!;
    expect([mini('sky').classList.contains('hit'), mini('sky').textContent]).toEqual([true, 'Sky hit']);
    expect(mini('sky').getAttribute('aria-label')).toBe('Sky Spire: 6000 / 7000 HP · under attack');
    expect([mini('depths').classList.contains('hit'), mini('depths').textContent]).toEqual([false, 'Depths']);
    // A hit mini jumps to our Spire there; a calm one dives to its plane.
    mini('sky').click();
    mini('depths').click();
    const home = snapshot.match!.armies.find((a) => a.id === 'nw')!.spireAt;
    expect(jump.mock.calls).toEqual([['sky', home.x, home.y], ['depths', undefined, undefined]]);
    // A fallen segment is not "under attack".
    d.update(view({ spire: hp(['sky'], 0) }), input('surface', { lead }));
    expect(mini('sky').classList.contains('hit')).toBe(false);
  });

  it('shows the time left and how this match is won, from its rules', () => {
    const { d } = make();
    const rules = (spire: Partial<typeof DEFAULT_RULES.spire>) => ({ ...snapshot.match!, rules: { ...snapshot.match!.rules, spire: { ...snapshot.match!.rules.spire, ...spire } } });
    d.update(view({ tick: 20, match: rules({ timeCap: 1800 }) }), input('surface'));
    expect(text(d, '.dash-left')).toBe('29:59 left');
    expect(text(d, '.dash-time .dash-text')).toBe("Win: destroy Red's Surface Spire");
    d.update(view(), input('sky'));
    expect(text(d, '.dash-left')).toBe('No time limit');
  });

  it('words the win condition per loss rule, rival count and eliminations', () => {
    const duel = snapshot.match!;
    const crowns = { ...duel, rules: resolveRules({ spire: { lossRule: 'crowns' } }) };
    const s = crowns.rules.spire;
    expect(winLine(duel, 'nw', undefined, [])).toBe("Win: destroy Red's Surface Spire");
    expect(winLine(crowns, 'nw', [], [])).toBe(`Win: take ${s.crownsToLose} crowns from Red (Surface ${s.crownsSurface}, others ${s.crownsSide})`);
    expect(winLine(crowns, 'nw', [{ army: 'se', lost: s.crownsToLose - 1, fallen: ['sky'] }], [])).toBe(`Win: take 1 more crown from Red (Surface ${s.crownsSurface}, others ${s.crownsSide})`);
    const ffa = gameView(new Sim(3, { map: { params: { slots: 4 } } }), 'nw').match!;
    expect(winLine(ffa, 'nw', undefined, [])).toBe("Win: destroy every rival's Surface Spire");
    expect(winLine(ffa, 'nw', undefined, ['se', 'sw'])).toBe("Win: destroy Red's Surface Spire");
    expect(winLine(ffa, 'nw', undefined, ['nw'])).toBe('Your army is out');
  });

  it('spectators: each army by its colour, a rival’s Spire from its own view', () => {
    const { d } = make();
    const theirs = view({ army: 'se', spire: hp([], 5000) });
    d.update(view({ spire: hp(['surface']) }), input('surface', { peer: (army) => (army === 'se' ? theirs : undefined) }));
    expect([...d.el.querySelectorAll('.dash-who')].map((w) => w.textContent)).toEqual(['Blue', 'Red']);
    expect([...d.el.querySelectorAll('.dash-bar')].map((b) => b.textContent)).toEqual(['HIT · 6000 / 7000', '5000 / 7000']);
    expect(text(d, '.dash-next .dash-text')).toBe("Blue's Surface Spire is under attack");
  });

  it('never uses native titles: truncatable text carries the game tooltip', () => {
    const { d } = make();
    d.update(view({ spire: hp(['sky']) }), input('surface'));
    expect(d.el.querySelector('[title]')).toBeNull();
    for (const selector of ['.dash-bar', '.dash-stats', '.dash-next', '.dash-time', '.dash-mini[data-plane="sky"]']) {
      expect(d.el.querySelector<HTMLElement>(selector)!.hasAttribute('data-tip'), selector).toBe(true);
    }
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
