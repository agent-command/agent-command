/**
 * In-match top ledger: alloy/energy stocks and rates, then one of two scopes. `plane` (the default) is the plane
 * dashboard of the plane in view; `all` is every plane at once: per-plane Spire health for us and each hostile army,
 * the daylight dial, the time limit and the four plane chips. The choice holds for the session (Alt+A or the All
 * button); switching tweens the bar's width while the groups crossfade, so the bar keeps its height and nothing else
 * in the HUD moves. Number slots are fixed-width (measured from the loaded font) so live values never reflow.
 */
import { PLANES, hostileSide, type ArmyId, type Plane, type View } from '@agent-command/game/contract';
import { COLOUR_LABEL } from './armies.ts';
import type { MatchView } from './match-view.ts';
import { h, PLANE_ACCENT } from './dom.ts';
import { DASH_TEXT, PLANE_NAME } from './text.ts';
import badgeUrl from './brand/icon.png';
import badgeHiUrl from './brand/badge.png';
import { fragmentFor, type MatchMode } from './net.ts';
import { icon } from './icons.ts';
import { LEDGER_SCOPE_KEY_LABEL } from './keymap.ts';
import { Motion, reducedMotion } from './motion.ts';
import { tip } from './tooltip.ts';
import './icon-topbar.css';

export const NUMBER_WIDTHS = { stock: 6, rate: 9, clock: 5, small: 5 } as const;
const LEDGER_PLANES = [...PLANES].reverse();

/** What the bar shows: the plane in view's dashboard, or every plane at once. */
export type LedgerScope = 'plane' | 'all';
/** The scope holds for the browser session (sessionStorage). */
export const LEDGER_SCOPE_STORAGE = 'agent-command.ledger-scope';
/** Scope switch: the bar's width tween, and the crossfade of its groups (out, then in: never both visible at once). */
export const SCOPE_MOTION = { width: 240, fadeOut: 90, fadeIn: 90, easing: 'cubic-bezier(.2,.8,.2,1)' } as const;
const LEDGER_BOTTOM = '--ledger-bottom';

function storedScope(): LedgerScope {
  try {
    return sessionStorage.getItem(LEDGER_SCOPE_STORAGE) === 'all' ? 'all' : 'plane';
  } catch {
    return 'plane'; // storage unavailable: the default
  }
}

/** Sharing follows the ticket's credentials, never guesses a spectator token on direct-link joins. */
export function matchShareLinks(options: { roomId: string; mode?: MatchMode; invite?: string; spectator?: string }, base: string): { kind: 'invite' | 'spectator'; label: string; url: string; hint: string }[] {
  const links: { kind: 'invite' | 'spectator'; label: string; url: string; hint: string }[] = [];
  if (options.mode === 'pvp' && options.invite) links.push({ kind: 'invite', label: 'Copy invite link', url: `${base}#${options.invite}`, hint: 'Copy the invitation for your opponent to join this match.' });
  if (options.spectator) links.push({ kind: 'spectator', label: 'Copy spectator link', url: `${base}#${fragmentFor(options.roomId, options.spectator)}`, hint: 'Copy a read-only link for someone to watch this match.' });
  return links;
}

/** Six ungrouped figures before compact suffixes; stock geometry is measured from the loaded hand font. */
export function ledgerNumber(value: number, compactAt: 1000 | 1000000 = 1000000): string {
  if (!Number.isFinite(value)) return '—';
  const n = Math.max(0, Math.floor(value));
  if (n < compactAt) return String(n);
  for (const [scale, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const) {
    if (n >= scale) {
      const raw = n / scale;
      const scaled = raw < 100 ? Math.floor(raw * 10) / 10 : Math.floor(raw);
      const text = `${scaled}${suffix}`;
      if (text.length <= NUMBER_WIDTHS.stock) return text;
    }
  }
  return '999T+';
}

export function ledgerRate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  const text = magnitude < 1000 ? magnitude.toFixed(1) : ledgerNumber(magnitude, 1000);
  return `${value < 0 ? '−' : '+'}${text}/s`;
}

/** Countdown always occupies mm:ss; absent/stationary events retain their slot. */
export function ledgerClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const n = Math.max(0, Math.ceil(seconds));
  return n >= 6000 ? '99m+' : `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export function numberSlot(kind: keyof typeof NUMBER_WIDTHS, text = ''): HTMLElement {
  return h('span', { class: `ledger-number ledger-${kind}`, style: `--figures:${NUMBER_WIDTHS[kind]}` }, text);
}

type StockMetrics = Pick<TextMetrics, 'width' | 'actualBoundingBoxLeft' | 'actualBoundingBoxRight' | 'actualBoundingBoxAscent' | 'actualBoundingBoxDescent'>;

/** Reserve the widest six-figure ink bounds, not merely the font's advance width. */
export function stockSlotMetrics(measure: (text: string) => StockMetrics): { width: number; padding: number; height: number; sample: string } {
  const samples = [...'0123456789'].map((digit) => digit.repeat(NUMBER_WIDTHS.stock));
  samples.push('999.9k', '999.9M', '999.9B', '999.9T', '999T+');
  let inkWidth = 0;
  let overhang = 0;
  let height = 0;
  let sample = '';
  for (const text of samples) {
    const m = measure(text);
    const width = Math.max(m.width, m.actualBoundingBoxLeft + m.actualBoundingBoxRight);
    if (width > inkWidth) { inkWidth = width; sample = text; }
    overhang = Math.max(overhang, m.actualBoundingBoxLeft, m.actualBoundingBoxRight - m.width);
    height = Math.max(height, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
  }
  const padding = Math.ceil(Math.max(2, overhang) + 3);
  return { width: Math.ceil(inkWidth) + padding * 2, padding, height: Math.ceil(height) + 6, sample };
}

export interface TopBarParts {
  /** The daylight dial, time limit, plane chips and crowns (the `all` scope's time group). */
  time: HTMLElement;
  /** The match actions; its `.top-actions` row receives the scope button first. */
  actions: HTMLElement;
  /** The plane dashboard (the `plane` scope). */
  dashboard: HTMLElement;
  /** The match's name, on the badge's tip. */
  label?: string;
}

export class TopBar {
  readonly el: HTMLElement;
  private readonly economy = h('section', { class: 'ledger-economy', 'aria-label': 'Resources' });
  private readonly objective = h('section', { class: 'ledger-objective hud-chip', 'aria-label': 'Spire objective' });
  private readonly resources = ['Alloy', 'Energy'].map((name) => {
    const stock = numberSlot('stock');
    const rate = numberSlot('rate');
    const glyph = icon(name === 'Alloy' ? 'alloy' : 'energy', 18);
    glyph.classList.add('ledger-resource-icon');
    return { name, stock, rate, el: h('div', { class: `ledger-resource hud-chip ${name.toLowerCase()}`, tabindex: 0 },
      h('div', { class: 'resource-main' }, glyph, stock),
      h('div', { class: 'resource-detail' }, rate)) };
  });
  /** Our Spire row, then one row per hostile Spire (compact when several), rebuilt when the match's armies change. */
  private rows: { army: ArmyId; ours: boolean; segments: { plane: Plane; fill: HTMLElement; el: HTMLElement }[] }[] = [];
  private rowsKey = '';
  private readonly spireRows = h('div', { class: 'ledger-spire-rows' });
  /** The `all` scope's groups: the Spire ledger and the time group. */
  private readonly ledger: HTMLElement;
  private readonly dashboard: HTMLElement;
  readonly scopeButton: HTMLButtonElement;
  private current: LedgerScope = storedScope();
  private readonly motion = new Motion();
  /** Watches the bar's height (two rows on narrow screens) for `--ledger-bottom`. */
  private readonly edge = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.publishEdge()) : undefined;

  constructor({ time, actions, dashboard, label }: TopBarParts) {
    this.economy.append(...this.resources.map((r) => r.el));
    this.objective.append(
      h('div', { class: 'ledger-spire-row ledger-planes' },
        h('span', { class: 'ledger-spire-icon', 'data-tip': 'Spire health by plane', 'aria-label': 'Spire' }, icon('spire', 14)),
        ...LEDGER_PLANES.map((p) => h('span', { class: 'ledger-plane-icon', 'data-tip': PLANE_NAME[p], 'aria-label': PLANE_NAME[p], style: `--accent:${PLANE_ACCENT[p]}` }, icon(p, 14)))),
      this.spireRows);
    time.classList.add('hud-chip');
    actions.classList.add('hud-chip');
    this.dashboard = dashboard;
    this.ledger = h('div', { class: 'ledger-all' }, this.objective, time);
    this.scopeButton = h('button', { type: 'button', class: 'btn ghost ledger-scope', onclick: () => this.setScope(this.current === 'all' ? 'plane' : 'all') },
      icon('map', 14), h('span', { class: 'ledger-scope-label' }, DASH_TEXT.all));
    (actions.querySelector('.top-actions') ?? actions).prepend(this.scopeButton);
    const brand = h('img', { class: 'ledger-brand', src: badgeHiUrl, srcset: `${badgeUrl} 64w, ${badgeHiUrl} 180w`, sizes: '(max-width: 600px) 24px, 52px', alt: 'Agent Command', width: 180, height: 180 });
    if (label) tip(brand, { title: 'Agent Command', description: label });
    this.el = h('header', { class: 'topbar', 'aria-label': 'Match ledger' },
      brand, this.economy, h('div', { class: 'ledger-stage' }, dashboard, this.ledger), actions);
    this.edge?.observe(this.el);
    this.show();
  }

  get scope(): LedgerScope {
    return this.current;
  }

  /** Called before joining: fonts can never resize stock slots during live play. */
  async prepare(): Promise<void> {
    const style = getComputedStyle(this.resources[0]!.stock);
    const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    await document.fonts.load(font);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = font;
    const metrics = stockSlotMetrics((text) => ctx.measureText(text));
    this.el.style.setProperty('--stock-width', `${metrics.width}px`);
    this.el.style.setProperty('--stock-padding', `${metrics.padding}px`);
    this.el.style.setProperty('--stock-height', `${Math.max(34, metrics.height)}px`);
    this.el.dataset.stockSample = metrics.sample;
    this.el.dataset.ready = 'true';
  }

  /**
   * Show the plane in view's dashboard or every plane; remembered for the session. The bar tweens from its drawn width
   * to the new one; the outgoing group leaves the flow at its drawn width and fades out, then the incoming one fades
   * in, both clipped to the bar. Reduced motion swaps at once.
   */
  setScope(scope: LedgerScope): void {
    if (scope === this.current) return;
    try {
      sessionStorage.setItem(LEDGER_SCOPE_STORAGE, scope);
    } catch {
      /* storage unavailable: this page only */
    }
    this.settle();
    const from = this.current === 'plane' ? this.dashboard : this.ledger;
    const to = scope === 'plane' ? this.dashboard : this.ledger;
    if (from.contains(document.activeElement)) this.scopeButton.focus();
    const animate = this.el.isConnected && typeof this.el.animate === 'function' && !reducedMotion();
    const before = animate ? this.el.getBoundingClientRect().width : 0;
    const outWidth = animate ? from.getBoundingClientRect().width : 0;
    this.current = scope;
    this.show();
    if (!animate) return;
    from.classList.add('leaving');
    from.style.width = `${outWidth}px`;
    const after = this.el.getBoundingClientRect().width;
    to.style.flex = `0 0 ${to.getBoundingClientRect().width}px`;
    this.el.classList.add('tweening');
    const m = SCOPE_MOTION;
    this.motion.play(from, [{ opacity: 1 }, { opacity: 0 }], { duration: m.fadeOut, easing: 'ease-out', fill: 'forwards' }, () => {
      from.classList.remove('leaving');
      from.style.width = '';
    });
    this.motion.play(to, [{ opacity: 0 }, { opacity: 1 }], { duration: m.fadeIn, delay: m.fadeOut, easing: 'ease-in', fill: 'backwards' });
    this.motion.play(this.el, [{ width: `${before}px` }, { width: `${after}px` }], { duration: m.width, easing: m.easing }, () => this.settle());
  }

  /** End a scope tween still running: both groups back at rest. */
  private settle(): void {
    this.motion.dispose();
    for (const group of [this.dashboard, this.ledger]) {
      group.classList.remove('leaving');
      group.style.width = '';
      group.style.flex = '';
    }
    this.el.classList.remove('tweening');
  }

  private show(): void {
    const all = this.current === 'all';
    this.el.dataset.scope = this.current;
    this.scopeButton.setAttribute('aria-pressed', String(all));
    this.scopeButton.setAttribute('aria-label', `All planes (${LEDGER_SCOPE_KEY_LABEL})`);
    tip(this.scopeButton, { title: 'All planes', description: all ? DASH_TEXT.planeTip : DASH_TEXT.allTip, hotkey: LEDGER_SCOPE_KEY_LABEL });
  }

  /** `--ledger-bottom` on the root: the bar's bottom edge (CSS px), where panels docked under it sit (the music player). */
  private publishEdge(): void {
    const root = document.documentElement.style;
    if (this.el.isConnected && this.el.getClientRects().length) root.setProperty(LEDGER_BOTTOM, `${Math.round(this.el.getBoundingClientRect().bottom)}px`);
    else root.removeProperty(LEDGER_BOTTOM);
  }

  dispose(): void {
    this.motion.dispose();
    this.edge?.disconnect();
    document.documentElement.style.removeProperty(LEDGER_BOTTOM);
  }

  private incomeTable(v: MatchView, alloy: boolean, bankMax: number): HTMLElement {
    const r = v.res;
    const table = h('div', { class: 'income-table' });
    for (const plane of PLANES) {
      const income = r.income[plane];
      const gain = alloy ? income.alloy : income.energy;
      const upkeep = alloy ? 0 : income.upkeep;
      if (!gain && !upkeep) continue;
      table.append(h('div', { class: 'income-row', 'aria-label': `${PLANE_NAME[plane]}: ${gain} income${alloy ? '' : `, ${upkeep} upkeep`} per second` },
        icon(plane, 16),
        h('span', { class: gain - upkeep < 0 ? 'income-negative' : 'income-positive' }, ledgerRate(gain)),
        upkeep ? h('span', { class: 'income-negative' }, `· −${upkeep.toFixed(1)}/s`) : null));
    }
    if (!alloy) {
      // Our arrays: anchored of all, what they make now, and their mean exposure ramp (output and ramp are own data).
      let n = 0, anchored = 0, output = 0, ramp = 0;
      for (const e of v.entities) {
        if (e.kind !== 'solar' || e.side !== v.army) continue;
        n++;
        output += e.output ?? 0;
        if (e.state === 'unfurled') { anchored++; ramp += e.ramp ?? 0; }
      }
      if (n) table.append(h('div', { class: 'income-row income-arrays', 'aria-label': `Solar arrays: ${anchored} of ${n} anchored, making ${output.toFixed(1)} per second, mean ramp ${anchored ? Math.round((ramp / anchored) * 100) : 0} percent` },
        icon('solar', 16), h('span', {}, `${anchored}/${n} · ${output.toFixed(1)}/s · ramp ${anchored ? Math.round((ramp / anchored) * 100) : 0}%`)));
    }
    if (!alloy) table.append(h('div', { class: 'income-row income-capacity', 'aria-label': `Solar ${r.solarRate}/s; capacity ${r.energyCap}/s${r.solarRate > r.energyCap ? '; delivery limited' : ''}` },
      icon('daylight', 16), h('span', {}, `${r.solarRate}/s →`), icon('relay', 16), h('span', {}, `${r.energyCap}/s`),
      r.solarRate > r.energyCap ? icon('impact_incoming', 16) : null));
    if (!alloy) table.append(h('div', { class: 'income-row income-ice' }, icon('tug', 16), h('span', {}, 'Ice mining: delivered cargo bypasses solar capacity')));
    if (!alloy && bankMax > 0) table.append(h('div', { class: 'income-row income-bank', 'aria-label': `Solar bank ${r.energyBank} of ${bankMax}` },
      icon('bank', 16), h('span', {}, `${r.energyBank} / ${bankMax}`)));
    return table;
  }

  update(v: MatchView): void {
    const r = v.res;
    const capped = r.solarRate > r.energyCap + 0.01;
    // The solar bank shows in the Energy tooltip (a gauge on the chip would crowd its rate slot).
    const bankMax = v.match.rules.economy.solarBankMax;
    for (const row of this.resources) {
      const alloy = row.name === 'Alloy';
      const value = alloy ? r.alloy : r.energy;
      const rate = alloy ? r.alloyRate : r.energyRate;
      const net = rate - (alloy ? 0 : r.upkeep);
      row.stock.textContent = ledgerNumber(value);
      row.stock.setAttribute('aria-label', String(value));
      row.el.classList.toggle('capped', !alloy && capped);
      row.rate.textContent = ledgerRate(rate);
      tip(row.el, { title: row.name, body: () => this.incomeTable(v, alloy, bankMax), status: `${value} · ${ledgerRate(net)}` });
      row.el.setAttribute('aria-label', `${row.name}: ${value}; net income ${net} per second${!alloy && bankMax > 0 ? `; solar bank ${r.energyBank} of ${bankMax}` : ''}`);
    }
    this.spireLedger(v);
  }

  private spireLedger(v: MatchView): void {
    const hostiles = v.match.armies.filter((a) => hostileSide(v.match, v.army, a.id));
    const key = `${v.army}|${hostiles.map((a) => `${a.id}:${a.colour}`).join(',')}`;
    if (key !== this.rowsKey) {
      this.rowsKey = key;
      this.rows = [{ army: v.army, ours: true }, ...hostiles.map((a) => ({ army: a.id, ours: false }))].map(({ army, ours }) => ({ army, ours, segments: LEDGER_PLANES.map((plane) => {
        const fill = h('span', { class: 'ledger-health' });
        return { plane, fill, el: h('span', { class: 'ledger-segment', tabindex: 0 }, fill) };
      }) }));
      this.objective.dataset.hostiles = String(hostiles.length);
      this.spireRows.replaceChildren(...this.rows.map((row) => {
        const colour = v.match.armies.find((a) => a.id === row.army)!.colour;
        const name = row.ours ? 'Our Spire' : `${COLOUR_LABEL[colour]} Spire`;
        return h('div', { class: `ledger-spire-row${row.ours ? '' : ' hostile'}`, 'data-army': row.army, style: `--side:var(--army-${colour});--side-ink:var(--army-${colour}-ink)` },
          h('span', { class: 'ledger-side', 'data-tip': name, 'aria-label': name }, icon(row.ours ? 'ours' : 'enemy', 12)),
          ...row.segments.map((s) => s.el));
      }));
    }
    for (const row of this.rows) {
      const out = v.eliminated.includes(row.army);
      const who = row.ours ? 'Our' : COLOUR_LABEL[v.match.armies.find((a) => a.id === row.army)!.colour];
      for (const slot of row.segments) {
        const { plane } = slot;
        const segment = out ? undefined : row.ours ? v.spire.find((s) => s.plane === plane) : v.entities.find((e) => e.kind === 'spire' && e.side === row.army && e.plane === plane);
        const ratio = segment ? Math.min(1, Math.max(0, segment.hp / segment.maxHp)) : 0;
        const label = `${who} ${PLANE_NAME[plane]} Spire: ${out ? 'eliminated' : segment ? `${segment.hp} / ${segment.maxHp} HP` : 'not visible'}`;
        slot.el.className = `ledger-segment${out ? ' dead' : !segment ? ' unknown' : ratio === 0 ? ' dead' : ratio < 0.35 ? ' low' : ''}`;
        tip(slot.el, label);
        slot.el.setAttribute('aria-label', label);
        slot.fill.style.setProperty('--health', `${ratio * 100}%`);
      }
    }
  }
}
