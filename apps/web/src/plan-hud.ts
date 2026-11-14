/**
 * Daylight dial, match timer and the four per-plane alert chips. The dial draws only from public sun data and our own
 * units; the chips render `view.alerts`, which the game derives from the team's own fogged view, led by the open team
 * requests waiting for that plane (`view.signals`, the team's own board). Countdowns have reserved figure slots and
 * never move neighboring controls.
 */
import { ALERTS_PER_PLANE, CRACK_STAGES, PLANES, TICK_RATE, sunOffset, toTicks, type AlertKind, type ArmyId, type Plane, type Rules, type View } from '@agent-command/game/contract';
import { h, PLANE_ACCENT } from './dom.ts';
import { ALERT_LABEL, ALERT_QUIET, ALERT_TEXT, NEED_LABEL, PLANE_NAME, planeList, REQUEST_ALERT, SCHEDULE_TEXT } from './text.ts';
import { showsOn, type SignalEntry, type SignalHooks } from './signals.ts';
import { sideHex } from './world/common.ts';
import { SUN_AHEAD_S, sunEdgeIn } from './world/plan.ts';
import { ledgerClock, numberSlot } from './topbar.ts';
import { icon } from './icons.ts';
import { tip, type TipContent } from './tooltip.ts';

const DIAL = 36;
const DAYLIGHT_HELP = 'The washed wedges show daylight; the faint edge is where light arrives in the next 20 s. Dots are your solar arrays (gold = lit); the square is your base.';
/** Console dial (style.css tokens): a deep-brown disc in a black toon rim, the sunlit wedges as a gold wash. */
const INK = '#060000';
const DISC = '#120600';
const UNLIT = '#bfb789';
const WASH = 'rgba(255,210,31,0.6)';
const WASH_DAWN = 'rgba(255,210,31,0.22)';
const LIT = '#ffd23f';

export class SunDial {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly clock = numberSlot('clock');
  private readonly dawn = h('span', { class: 'sun-phase', hidden: true }, icon('dawn', 16));
  private readonly dusk = h('span', { class: 'sun-phase' }, icon('dusk', 16));

  constructor() {
    this.canvas = h('canvas', { class: 'sun-dial', width: DIAL * 2, height: DIAL * 2, 'aria-hidden': 'true' });
    this.canvas.style.width = `${DIAL}px`;
    this.canvas.style.height = `${DIAL}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.el = tip(h('div', { class: 'sun', tabindex: 0 },
      this.canvas,
      h('div', { class: 'sun-text' }, h('div', { class: 'sun-line sun-countdown' }, this.dawn, this.dusk, this.clock))),
    { title: 'Daylight', description: DAYLIGHT_HELP });
  }

  update(v: View, angle: number): void {
    const { half, speed, wedges } = v.match!.sun;
    const size = v.match!.rules.map.size;
    const ctx = this.ctx;
    const r = DIAL - 3;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, DIAL, DIAL);
    ctx.translate(DIAL / 2, DIAL / 2);
    const s = r / 2 / (size / 2); // px per tile
    ctx.fillStyle = DISC;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, r / 2, 0, Math.PI * 2);
    ctx.fill();
    const ahead = speed * SUN_AHEAD_S;
    for (let w = 0; w < wedges; w++) {
      const base = angle + (w * Math.PI * 2) / wedges;
      ctx.fillStyle = WASH;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r / 2, base - half, base + half);
      ctx.closePath();
      ctx.fill();
      // dawn: where the leading edge will be in SUN_AHEAD_S
      const lead = speed >= 0 ? base + half : base - half;
      ctx.fillStyle = WASH_DAWN;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r / 2, Math.min(lead, lead + ahead), Math.max(lead, lead + ahead));
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, 0, r / 2, 0, Math.PI * 2);
    ctx.stroke();
    // our base and our solar arrays
    const army = v.army;
    let sp = v.match!.armies[0]!.spireAt;
    for (const a of v.match!.armies) if (a.id === army) sp = a.spireAt;
    ctx.lineWidth = 1;
    ctx.fillStyle = sideHex(army);
    ctx.fillRect((sp.x - size / 2) * s - 2.5, (sp.y - size / 2) * s - 2.5, 5, 5);
    ctx.strokeRect((sp.x - size / 2) * s - 2.5, (sp.y - size / 2) * s - 2.5, 5, 5);
    let arrays = 0;
    let lit = 0;
    for (const e of v.entities) {
      if (e.kind !== 'solar' || e.side !== army) continue;
      arrays++;
      const on = Math.abs(sunOffset(e.x, e.y, angle, size, wedges)) < half;
      if (on) lit++;
      ctx.fillStyle = on ? LIT : UNLIT;
      ctx.beginPath();
      ctx.arc((e.x - size / 2) * s, (e.y - size / 2) * s, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const o = sunOffset(sp.x, sp.y, angle, size, wedges);
    const baseLit = Math.abs(o) < half;
    const t = Math.round(sunEdgeIn(o, half, speed, !baseLit));
    const label = `${lit} of ${arrays} arrays lit; base ${baseLit ? 'lit' : 'dark'}${Number.isFinite(t) ? `; ${baseLit ? 'dusk' : 'dawn'} in ${t}s` : ''}`;
    tip(this.el, { title: 'Daylight', description: DAYLIGHT_HELP, status: label });
    this.el.setAttribute('aria-label', label);
    this.dawn.hidden = baseLit;
    this.dusk.hidden = !baseLit;
    this.clock.textContent = ledgerClock(t);
  }
}

/** The match time limit: the countdown to the time cap. */
export class MatchTimer {
  private readonly clock = numberSlot('clock');
  readonly el: HTMLElement;

  constructor() {
    const marker = icon('time_cap', 14);
    marker.classList.add('ledger-event-icon');
    this.el = h('div', { class: 'ledger-event', 'data-event-kind': 'time_cap', tabindex: 0 }, h('span', { class: 'hud-stamp' }, marker, this.clock));
  }

  update(v: View, tick: number): void {
    const cap = v.match?.rules.spire.timeCap;
    const text = ledgerClock(cap ? (toTicks(cap) - tick) / TICK_RATE : Infinity);
    if (this.clock.textContent === text) return;
    this.clock.textContent = text;
    this.el.classList.toggle('idle', !cap);
    const detail = cap ? `Time cap in ${text}` : 'No time limit';
    tip(this.el, { title: 'Time limit', description: detail });
    this.el.setAttribute('aria-label', detail);
  }
}

export type SuddenDeathPhase = 'off' | 'countdown' | 'on';
/** Sudden death's public phase at `tick` under `rules` (rules.spire.suddenDeathAt, 0 = off) and its start tick. */
export function suddenDeathPhase(rules: Rules | undefined, tick: number): { phase: SuddenDeathPhase; at: number } {
  const at = rules ? toTicks(rules.spire.suddenDeathAt) : 0;
  if (at <= 0 || tick < at - toTicks(rules!.spire.suddenDeathWarning)) return { phase: 'off', at };
  return { phase: tick < at ? 'countdown' : 'on', at };
}

/**
 * Sudden death, from the match rules and the tick alone (public): its countdown, then a standing banner naming the
 * Spire damage multiplier. Shared by the player HUD and the observer.
 */
export class SuddenDeathBanner {
  readonly el: HTMLElement;
  private readonly label = h('span', { class: 'sudden-death-label' });
  private readonly clock = numberSlot('clock');
  private shown = '';

  constructor() {
    const marker = icon('sudden_death', 16);
    this.el = h('div', { class: 'sudden-death', role: 'status', tabindex: 0, hidden: true }, marker, this.label, this.clock);
  }

  update(rules: Rules | undefined, tick: number): void {
    const { phase, at } = suddenDeathPhase(rules, tick);
    const clock = phase === 'countdown' ? ledgerClock((at - tick) / TICK_RATE) : '';
    const key = `${phase}|${clock}`;
    if (key === this.shown) return;
    this.shown = key;
    this.el.hidden = phase === 'off';
    this.el.dataset.phase = phase;
    if (phase === 'off') return;
    const times = `×${rules!.spire.suddenDeathDamage}`;
    this.label.textContent = phase === 'countdown' ? 'Sudden death in' : `Sudden death · Spires ${times}`;
    this.clock.textContent = clock;
    this.clock.hidden = phase !== 'countdown';
    const description = `Every Spire segment takes ${times} damage from everything but rocks (impacts, core drops, volatile blasts), and Orbit segments stop repairing docked ships.`;
    tip(this.el, { title: phase === 'countdown' ? `Sudden death in ${clock}` : 'Sudden death', description });
    this.el.setAttribute('aria-label', phase === 'countdown' ? `Sudden death in ${clock}` : `Sudden death: Spires take ${times} damage`);
  }
}

/** One army's public crowns row (view.crowns, lossRule crowns only). */
export type CrownsRow = NonNullable<View['crowns']>[number];

/** Crowns are on: the match's loss rule is `crowns` (every crowns element stays hidden otherwise). */
export const crownsOn = (rules: Rules | undefined): boolean => rules?.spire.lossRule === 'crowns';

/** The crown each segment holds, Orbit → Depths like the chips: lit while it stands, dark once fallen. */
export function crownPips(row: CrownsRow | undefined, rules: Rules, name: string): HTMLElement {
  const fallen = new Set(row?.fallen ?? []);
  const lost = row?.lost ?? 0;
  const label = `${name}: ${lost} of ${rules.spire.crownsToLose} crowns lost${fallen.size ? ` · ${planeList(PLANES.filter((plane) => fallen.has(plane)))} down` : ''}`;
  const el = h('span', { class: 'crown-pips', role: 'img', 'aria-label': label, 'data-lost': String(lost) },
    ...CHIP_PLANES.map((plane) => {
      const pip = h('i', { class: 'crown-pip', 'data-plane': plane, 'data-state': fallen.has(plane) ? 'fallen' : 'standing', style: `--accent:${PLANE_ACCENT[plane]}` }, icon('crown_lost', 12));
      pip.dataset.crowns = String(plane === 'surface' ? rules.spire.crownsSurface : rules.spire.crownsSide);
      return pip;
    }));
  tip(el, { title: `${name} crowns`, description: `${label}. Out at ${rules.spire.crownsToLose} crowns lost: the Surface segment costs ${rules.spire.crownsSurface}, any other ${rules.spire.crownsSide}; a rebuilt segment returns its crown.` });
  return el;
}

/** Armies in play one crown from out (lost ≥ crownsToLose − 1), in army order. */
export function matchPointArmies(rules: Rules | undefined, crowns: View['crowns'], eliminated: readonly ArmyId[]): ArmyId[] {
  if (!crownsOn(rules) || !crowns) return [];
  return crowns.filter((row) => !eliminated.includes(row.army) && row.lost >= rules!.spire.crownsToLose - 1).map((row) => row.army);
}

/**
 * Crowns per army (lossRule crowns only): four crown pips each, the viewer's own army first. Eliminated armies' rows
 * stay frozen as they fell (the view keeps them).
 */
export class CrownsBoard {
  readonly el = h('div', { class: 'crowns-board', 'aria-label': 'Crowns', hidden: true });
  private shown = '';

  update(rules: Rules | undefined, crowns: View['crowns'], own: ArmyId | undefined, name: (army: ArmyId) => string): void {
    const rows = crownsOn(rules) && crowns ? [...crowns].sort((a, b) => Number(b.army === own) - Number(a.army === own)) : [];
    const key = JSON.stringify(rows);
    if (key === this.shown) return;
    this.shown = key;
    this.el.hidden = !rows.length;
    this.el.replaceChildren(...rows.map((row) => h('span', { class: 'crowns-row', 'data-team': row.army, style: `--side-ink:${sideHex(row.army)}` },
      h('i', { class: 'crowns-swatch', 'aria-hidden': 'true' }), crownPips(row, rules!, name(row.army)))));
  }
}

/**
 * "Match point" (lossRule crowns only): an army in play is one crown from out. Styled and shared like the sudden death
 * banner (player HUD and observer).
 */
export class MatchPointBanner {
  readonly el: HTMLElement;
  private readonly label = h('span', { class: 'sudden-death-label' });
  private shown = '';

  constructor() {
    this.el = h('div', { class: 'sudden-death match-point', role: 'status', tabindex: 0, hidden: true, 'data-phase': 'on' }, icon('crown_lost', 16), this.label);
  }

  update(rules: Rules | undefined, crowns: View['crowns'], eliminated: readonly ArmyId[], name: (army: ArmyId) => string): void {
    const armies = matchPointArmies(rules, crowns, eliminated);
    const text = armies.length ? `Match point · ${armies.map(name).join(', ')}` : '';
    if (text === this.shown) return;
    this.shown = text;
    this.el.hidden = !armies.length;
    if (!armies.length) return;
    this.label.textContent = text;
    const description = `${armies.map(name).join(', ')} ${armies.length === 1 ? 'is' : 'are'} one crown from elimination (out at ${rules!.spire.crownsToLose} crowns lost).`;
    tip(this.el, { title: 'Match point', description });
    this.el.setAttribute('aria-label', `Match point: ${description}`);
  }
}

type Alert = View['alerts'][number];
/** Chips run Orbit → Depths, like the Spire ledger's plane columns. */
const CHIP_PLANES = [...PLANES].reverse();
/** Countdowns this close pulse, as do breakthrough threats. */
const URGENT_TICKS = 10 * TICK_RATE;
const THREATS: Partial<Record<AlertKind, true>> = { intruder: true, wall_dig: true, charge: true, charge_under: true, breach: true, island_contested: true, post_contested: true };

/** The chip figure: a countdown, a wall's crack stage or a tremor count. */
function alertFigure(a: Alert, tick: number): string {
  if (a.tick !== undefined) return ledgerClock((a.tick - tick) / TICK_RATE);
  if (a.stage !== undefined) return `${a.stage}/${CRACK_STAGES}`;
  return a.count === undefined ? '' : `×${a.count}`;
}

/** One tooltip line: what, when, whose and where. */
export function alertLine(a: Alert, tick: number, army: ArmyId): string {
  let text = ALERT_TEXT[a.kind].replace('{in}', a.tick === undefined ? '' : ledgerClock((a.tick - tick) / TICK_RATE));
  if (a.stage !== undefined) text += ` · crack ${a.stage}/${CRACK_STAGES}`;
  if (a.count !== undefined) text += ` · ${a.count} ${a.kind === 'tremor' ? (a.count === 1 ? 'cell' : 'cells') : a.count === 1 ? 'unit' : 'units'}`;
  if (a.side && a.side !== 'neutral') text += a.side === army ? ' · yours' : ' · enemy';
  return a.x === undefined || a.y === undefined ? text : `${text} at ${Math.floor(a.x)}, ${Math.floor(a.y)}`;
}

/** One request line: who asks for what, time left, who took it, where; and whether a click takes it. */
export function requestLine(e: SignalEntry, tick: number, take: boolean): string {
  let text = REQUEST_ALERT.text.replace('{from}', PLANE_NAME[e.from])
    .replace('{need}', `${NEED_LABEL[e.need].toLowerCase()}${e.count ? ` ×${e.count}` : ''}`)
    .replace('{in}', ledgerClock((e.expires - tick) / TICK_RATE));
  if (e.by) text += ` · ${REQUEST_ALERT.taken.replace('{by}', PLANE_NAME[e.by])}`;
  if (e.x !== undefined && e.y !== undefined) text += ` at ${e.x}, ${e.y}`;
  return take ? `${text} · ${REQUEST_ALERT.take}` : text;
}

const byExpiry = (a: SignalEntry, b: SignalEntry): number => a.expires - b.expires || a.tick - b.tick;

/** Tooltip lines for the public derelict schedule (gate windows, the next core) on the Orbit chip. */
export function scheduleLines(v: Pick<View, 'schedule' | 'tick'>): string[] {
  const clock = (ticks: number): string => ledgerClock(Math.max(0, ticks) / TICK_RATE);
  const out: string[] = [];
  for (const s of v.schedule) {
    if (s.kind === 'derelict_open' && s.until !== undefined) {
      out.push(s.tick <= v.tick
        ? SCHEDULE_TEXT.derelict_open_now.replace('{for}', clock(s.until - v.tick))
        : SCHEDULE_TEXT.derelict_open.replace('{in}', clock(s.tick - v.tick)).replace('{for}', clock(s.until - s.tick)));
    } else if (s.kind === 'core_regrows') out.push(SCHEDULE_TEXT.core_regrows.replace('{in}', clock(s.tick - v.tick)));
  }
  return out;
}

class PlaneChip {
  readonly el: HTMLButtonElement;
  private readonly plane: Plane;
  private readonly hooks: SignalHooks | undefined;
  private readonly figure = numberSlot('clock');
  /** The leading request's need glyph (empty otherwise). */
  private readonly need = h('span', { class: 'plane-chip-need' });
  private readonly label = h('span', { class: 'plane-chip-label' });
  private readonly content: TipContent;
  private view: View | undefined;
  /** Open requests waiting for this plane, soonest to expire first; they lead the chip and share its alert cap. */
  private readonly requests: SignalEntry[] = [];
  /** This plane's alerts: v.alerts[first, first + count) (the game groups them by plane, most relevant first). */
  private first = 0;
  private count = 0;
  private needShown = '';
  private aria = '';

  constructor(plane: Plane, jump: (plane: Plane, x?: number, y?: number) => void, hooks?: SignalHooks) {
    this.plane = plane;
    this.hooks = hooks;
    this.content = { title: PLANE_NAME[plane], body: () => this.list() };
    const glyph = icon(plane, 14);
    glyph.classList.add('plane-chip-icon');
    this.el = h('button', {
      type: 'button', class: 'plane-chip idle', 'data-plane': plane, style: `--accent:${PLANE_ACCENT[plane]}`,
      onclick: () => {
        const r = this.requests[0];
        if (r && hooks) return hooks.open(r, plane);
        if (r) return jump(plane, r.x === undefined ? undefined : r.x + 0.5, r.y === undefined ? undefined : r.y + 0.5);
        const a = this.count ? this.view?.alerts[this.first] : undefined;
        jump(plane, a?.x, a?.y);
      },
    }, h('span', { class: 'plane-chip-head' }, glyph, this.figure, this.need), this.label);
  }

  update(v: View): void {
    this.view = v;
    const requests = this.requests;
    requests.length = 0;
    for (const e of v.signals) if (showsOn(e, this.plane)) requests.push(e);
    requests.sort(byExpiry);
    if (requests.length > ALERTS_PER_PLANE) requests.length = ALERTS_PER_PLANE;
    const alerts = v.alerts;
    let first = 0;
    while (first < alerts.length && alerts[first]!.plane !== this.plane) first++;
    let end = first;
    while (end < alerts.length && alerts[end]!.plane === this.plane) end++;
    this.first = first;
    this.count = Math.min(end - first, ALERTS_PER_PLANE - requests.length);
    const r = requests[0];
    const a = !r && this.count ? alerts[first]! : undefined;
    const figure = r ? ledgerClock((r.expires - v.tick) / TICK_RATE) : a ? alertFigure(a, v.tick) : '';
    const label = r ? NEED_LABEL[r.need] : a ? ALERT_LABEL[a.kind] : '';
    if (this.figure.textContent !== figure) this.figure.textContent = figure;
    if (this.label.textContent !== label) this.label.textContent = label;
    const need = r ? r.need : '';
    if (need !== this.needShown) {
      this.needShown = need;
      this.need.replaceChildren(...(r ? [icon(`need_${r.need}`, 12)] : []));
    }
    this.el.classList.toggle('idle', !r && !a);
    this.el.classList.toggle('request', !!r);
    // An unanswered request pulses like a countdown under 10 s.
    this.el.classList.toggle('urgent', r ? r.state === 'submitted' : !!a && (THREATS[a.kind] || (a.tick !== undefined && a.tick - v.tick < URGENT_TICKS)));
    const aria = `${PLANE_NAME[this.plane]}: ${r ? this.requestLine(r, v.tick) : a ? alertLine(a, v.tick, v.army) : ALERT_QUIET[this.plane]}`;
    if (aria === this.aria) return;
    this.aria = aria;
    this.el.setAttribute('aria-label', aria);
    // Re-registering refreshes an open tooltip; the list itself is built only while it shows.
    tip(this.el, this.content);
  }

  private requestLine(e: SignalEntry, tick: number): string {
    return requestLine(e, tick, e === this.requests[0] && e.state === 'submitted' && !!this.hooks?.mine(this.plane));
  }

  private list(): HTMLElement {
    const v = this.view;
    const box = h('div', { class: 'plane-chip-tip' });
    if (!v || (!this.requests.length && !this.count)) box.append(h('div', {}, ALERT_QUIET[this.plane]));
    for (const e of this.requests) box.append(h('div', {}, this.requestLine(e, v?.tick ?? e.tick)));
    if (v) for (let i = this.first; i < this.first + this.count; i++) box.append(h('div', {}, alertLine(v.alerts[i]!, v.tick, v.army)));
    if (v && this.plane === 'orbit') for (const line of scheduleLines(v)) box.append(h('div', { class: 'muted' }, line));
    return box;
  }
}

/**
 * Four per-plane chips, each with its plane's most relevant timed item; a click jumps to its plane and spot. With
 * `hooks`, a click on a request opens it through the game (jump, and take it as a plane the human controls).
 */
export class PlaneChips {
  private readonly chips: PlaneChip[];
  readonly el: HTMLElement;

  constructor(jump: (plane: Plane, x?: number, y?: number) => void, hooks?: SignalHooks) {
    this.chips = CHIP_PLANES.map((plane) => new PlaneChip(plane, jump, hooks));
    this.el = h('div', { class: 'plane-chips', role: 'group', 'aria-label': 'Plane alerts' }, ...this.chips.map((c) => c.el));
  }

  update(v: View): void {
    for (const chip of this.chips) chip.update(v);
  }
}
