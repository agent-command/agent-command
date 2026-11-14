/**
 * The orders section of the command card: ordinary commands in one compact uniform style, abilities as framed tiles
 * with hotkey, cost and a cooldown ring. The section never scrolls: when a selection has more actions than fit, labels
 * collapse first, then the lowest-ranked actions move under one More button (a top-layer popover, so the card's
 * clipping never hides them).
 */
import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { tip, type TipContent } from './tooltip.ts';
import type { CardGroup } from './tools/catalog.ts';
import './command-card.css';

export interface CardAction {
  /** Stable identity (tool id, `stance:defensive`, `sky:launch`…): focus, ready pulses and overflow survive rebuilds. */
  id: string;
  group: CardGroup;
  /** Overflow order: the lowest ranks move under More first. */
  rank: number;
  icon: IconName;
  label: string;
  tip: TipContent;
  run(): void;
  on?: boolean;
  /** Unavailable: dimmed, `aria-disabled`, the tooltip status says why. Clicks still reach `run` (it explains). */
  disabled?: boolean;
  hotkey?: string;
  /** A short count on the corner (dig tags, hangar berths). */
  badge?: string;
  cost?: { alloy?: number; energy?: number };
  cooldown?: { left: number; fraction: number };
  /** Consecutive actions with one segment render as a joined control group that overflows as a whole. */
  segment?: { id: string; label: string };
}

interface Slot { el: HTMLElement; group: CardGroup; rank: number; order: number }
interface Live { action: CardAction; el: HTMLElement; ring?: HTMLElement; left?: HTMLElement; tipKey: string }

let nextMenu = 0;

export class CommandCard {
  readonly el = h('div', { class: 'orders', role: 'toolbar', 'aria-label': 'Orders' });
  private readonly commands = h('div', { class: 'card-group', 'data-group': 'commands', role: 'group', 'aria-label': 'Commands' });
  private readonly abilities = h('div', { class: 'card-group', 'data-group': 'abilities', role: 'group', 'aria-label': 'Abilities' });
  private readonly menu = h('div', { id: `card-more-${++nextMenu}`, class: 'card-more', 'data-group': 'more', role: 'group', 'aria-label': 'More orders', popover: 'auto' });
  private readonly more = tip(h('button', {
    class: 'cmd more', 'aria-label': 'More orders', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': this.menu.id, hidden: true,
    onclick: () => this.toggleMenu(),
  }, icon('more', 16)), { title: 'More orders', description: 'Actions that do not fit on the card' });
  private slots: Slot[] = [];
  private readonly live = new Map<string, Live>();
  /** Ids last seen cooling down: the update that sees one ready again pulses it once. */
  private readonly cooling = new Set<string>();
  private key = '';
  private readonly resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.fit()) : undefined;

  constructor() {
    this.el.append(this.commands, this.abilities);
    // A closed popover renders nothing; it lives in the body so opening it never re-parents focused controls.
    document.body.append(this.menu);
    this.menu.addEventListener('toggle', () => this.more.setAttribute('aria-expanded', String(this.menuOpen())));
    this.menu.addEventListener('click', (event) => {
      if ((event.target as Element | null)?.closest?.('button')) this.closeMenu();
    });
    this.resize?.observe(this.el);
  }

  dispose(): void {
    this.resize?.disconnect();
    this.closeMenu();
    this.menu.remove();
  }

  /** Cheap when only cooldowns or tooltip text moved: the DOM is rebuilt only when the set of controls changes. */
  update(actions: readonly CardAction[], accent: string): void {
    const key = `${accent}|${actions.map((a) => `${a.id}:${a.group}:${a.rank}:${a.icon}:${a.label}:${a.on ? 1 : 0}:${a.disabled ? 1 : 0}:${a.hotkey ?? ''}:${a.badge ?? ''}:${a.cost?.alloy ?? ''}:${a.cost?.energy ?? ''}:${a.segment?.id ?? ''}`).join('|')}`;
    if (key !== this.key) {
      this.key = key;
      this.build(actions, accent);
    }
    for (const action of actions) this.refresh(action);
  }

  private build(actions: readonly CardAction[], accent: string): void {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && (this.el.contains(active) || this.menu.contains(active)) ? active.dataset.action : undefined;
    this.el.style.setProperty('--accent', accent);
    this.menu.style.setProperty('--accent', accent);
    this.live.clear();
    this.slots = [];
    let segment: { id: string; el: HTMLElement; slot: Slot } | undefined;
    for (const action of actions) {
      const el = this.control(action);
      if (!action.segment) {
        segment = undefined;
        this.slots.push({ el, group: action.group, rank: action.rank, order: this.slots.length });
        continue;
      }
      if (segment?.id !== action.segment.id) {
        const group = h('span', { class: 'cmd-seg', role: 'group', 'aria-label': action.segment.label });
        segment = { id: action.segment.id, el: group, slot: { el: group, group: action.group, rank: action.rank, order: this.slots.length } };
        this.slots.push(segment.slot);
      }
      segment.el.append(el);
      segment.slot.rank = Math.max(segment.slot.rank, action.rank);
    }
    this.fit();
    if (focused) this.live.get(focused)?.el.focus({ preventScroll: true });
  }

  private control(action: CardAction): HTMLElement {
    const ability = action.group === 'abilities';
    const el = h('button', {
      class: `${ability ? 'ability' : 'cmd'}${action.on ? ' on' : ''}${action.disabled ? ' off' : ''}`,
      'data-action': action.id, 'aria-label': action.label, 'aria-pressed': String(!!action.on), 'aria-disabled': String(!!action.disabled),
      onclick: () => this.live.get(action.id)?.action.run(),
    });
    const live: Live = { action, el, tipKey: '' };
    if (ability) {
      live.ring = h('span', { class: 'ring', 'aria-hidden': 'true' });
      live.left = h('span', { class: 'cd-left num', 'aria-hidden': 'true' });
      el.append(live.ring, icon(action.icon, 22), live.left);
      if (action.hotkey) el.append(h('kbd', { class: 'ability-key', 'aria-hidden': 'true' }, action.hotkey));
      const cost = action.cost?.energy ? ['energy', action.cost.energy] as const : action.cost?.alloy ? ['alloy', action.cost.alloy] as const : undefined;
      if (cost) el.append(h('span', { class: `ability-cost c-${cost[0]}`, 'aria-hidden': 'true' }, icon(cost[0], 9), String(cost[1])));
    } else {
      el.append(icon(action.icon, 16));
      if (action.hotkey) el.append(h('kbd', { class: 'cmd-key', 'aria-hidden': 'true' }, action.hotkey));
    }
    if (action.badge) el.append(h('span', { class: 'card-badge num', 'aria-hidden': 'true' }, action.badge));
    this.live.set(action.id, live);
    return el;
  }

  /** Per update, without rebuilding: cooldown ring and seconds, tooltip text, and the one-shot ready pulse. */
  private refresh(action: CardAction): void {
    const live = this.live.get(action.id);
    if (!live) return;
    live.action = action;
    const t = action.tip;
    const key = `${t.title}\u0000${t.description ?? ''}\u0000${t.status ?? ''}\u0000${t.hotkey ?? ''}\u0000${t.cost?.alloy ?? ''}:${t.cost?.energy ?? ''}`;
    if (key !== live.tipKey) {
      live.tipKey = key;
      tip(live.el, t);
    }
    if (!live.ring) return;
    const cooldown = action.cooldown;
    live.el.classList.toggle('cooling', !!cooldown);
    live.el.style.setProperty('--cd', String(cooldown?.fraction ?? 0));
    live.left!.textContent = cooldown ? String(cooldown.left) : '';
    if (cooldown) {
      this.cooling.add(action.id);
      live.el.classList.remove('pulse');
    } else if (this.cooling.delete(action.id)) {
      // Restart the one-shot animation even if a previous pulse class is still on the element.
      live.el.classList.remove('pulse');
      void live.el.offsetWidth;
      live.el.classList.add('pulse');
    }
  }

  /** Lay every control out in display order, then shed labels and low ranks until nothing overflows. */
  private fit(): void {
    this.el.classList.remove('compact');
    this.commands.replaceChildren(...this.slots.filter((s) => s.group === 'commands').map((s) => s.el), this.more);
    this.abilities.replaceChildren(...this.slots.filter((s) => s.group === 'abilities').map((s) => s.el));
    this.menu.replaceChildren();
    this.more.hidden = true;
    if (!this.overflowing()) return this.closeMenu();
    this.el.classList.add('compact');
    if (!this.overflowing()) return this.closeMenu();
    this.more.hidden = false;
    const moved = new Set<Slot>();
    // Lowest rank first; among equals the later one on the card goes first.
    for (const slot of [...this.slots].sort((a, b) => a.rank - b.rank || b.order - a.order)) {
      moved.add(slot);
      slot.el.remove();
      if (!this.overflowing()) break;
    }
    this.menu.replaceChildren(...this.slots.filter((s) => moved.has(s)).map((s) => s.el));
  }

  private overflowing(): boolean {
    return this.el.scrollHeight > this.el.clientHeight + 1 || this.el.scrollWidth > this.el.clientWidth + 1;
  }

  private menuOpen(): boolean {
    return this.menu.matches?.(':popover-open') ?? false;
  }

  private toggleMenu(): void {
    if (this.menuOpen()) return this.closeMenu();
    this.menu.showPopover();
    // Above the More button and inside the viewport: the popover is in the top layer, outside the card's clipping.
    const button = this.more.getBoundingClientRect();
    const menu = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(button.left, innerWidth - menu.width - 8))}px`;
    this.menu.style.top = `${Math.max(8, button.top - menu.height - 6)}px`;
    this.more.setAttribute('aria-expanded', 'true');
  }

  private closeMenu(): void {
    if (this.menuOpen()) this.menu.hidePopover();
    this.more.setAttribute('aria-expanded', 'false');
  }
}
