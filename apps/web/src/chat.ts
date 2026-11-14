/**
 * Owner ↔ commander chat UI: a chat bar (target chips All / Orbit / Sky / Surface / Depths, optional map ping) and a
 * commander log (your messages and your agents' replies, per plane). Used in a match and on the Commanders screen.
 * Every text (including agent-authored replies) is rendered as plain text nodes, never as markup.
 */
import './chat.css';
import { isPlane, PLANES, type Plane } from '@agent-command/game/contract';
import { PLANE_ACCENT, h } from './dom.ts';
import { icon } from './icons.ts';
import { PLANE_NAME } from './text.ts';

export const MAX_TELL_CHARS = 500;

export interface Ping {
  plane: Plane;
  x: number;
  y: number;
}

export interface ChatLine {
  from: 'owner' | 'agent';
  /** Owner messages: recipients. Agent replies: the speaking plane. */
  roles: string[];
  text: string;
  /** ms since epoch */
  at: number;
  ping?: unknown;
}

export function pingText(p: unknown): string {
  if (typeof p !== 'object' || p === null) return '';
  const { plane, x, y } = p as Record<string, unknown>;
  if (typeof plane !== 'string' || !isPlane(plane) || typeof x !== 'number' || typeof y !== 'number') return '';
  return `${PLANE_NAME[plane]} (${Math.round(x)}, ${Math.round(y)})`;
}

export class ChatBar {
  readonly el: HTMLElement;
  private targets = new Set<Plane>();
  private ping: Ping | undefined;
  private sending = false;
  private readonly chips: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly pingEl: HTMLElement;
  private readonly status: HTMLElement;
  private readonly send: (roles: Plane[] | 'all', text: string, ping?: Ping) => Promise<void>;
  private readonly floating: boolean;

  /** `floating`: hidden until `open()` (in a match); otherwise always visible (Commanders screen). */
  constructor(send: (roles: Plane[] | 'all', text: string, ping?: Ping) => Promise<void>, opts: { floating: boolean; placeholder?: string }) {
    this.send = send;
    this.floating = opts.floating;
    this.chips = h('div', { class: 'chat-targets', role: 'group', 'aria-label': 'Send to' });
    this.pingEl = h('span', { class: 'chat-ping' });
    this.status = h('span', { class: 'chat-status', role: 'status' });
    this.input = h('input', {
      class: 'chat-input',
      maxlength: MAX_TELL_CHARS,
      placeholder: opts.placeholder ?? 'Message your commanders — e.g. “Sky, cover the asteroid drop”',
      'aria-label': 'Message to your commanders',
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        // Enter sends; on an empty line it just closes the bar (open with Enter, close with Enter).
        if (this.input.value.trim()) void this.submit();
        else this.close();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.el = h(
      'div',
      { class: `chat-bar${this.floating ? ' floating' : ''}` },
      this.chips,
      h('div', { class: 'chat-row' }, this.input, this.pingEl,
        h('button', { class: 'btn small primary chat-send', 'aria-label': 'Send', 'data-tip': 'Send · Enter', onclick: () => void this.submit() }, icon('send', 16))),
      this.status,
    );
    this.renderChips();
    this.renderPing();
  }

  get isOpen(): boolean {
    return !this.floating || this.el.classList.contains('open');
  }

  open(): void {
    this.el.classList.add('open');
    this.input.focus();
  }

  close(): void {
    if (this.floating) this.el.classList.remove('open');
    this.ping = undefined;
    this.renderPing();
    this.input.blur();
  }

  /** Attach a map point (Alt+click) and open the bar. */
  attachPing(p: Ping): void {
    this.ping = p;
    this.renderPing();
    this.open();
  }

  private renderChips(): void {
    const chip = (label: string, on: boolean, toggle: () => void, accent?: string) =>
      h('button', { class: `chat-chip${on ? ' on' : ''}`, style: accent ? `--accent:${accent}` : undefined, 'aria-pressed': on ? 'true' : 'false', onclick: toggle }, label);
    this.chips.replaceChildren(
      chip('All', this.targets.size === 0, () => {
        this.targets.clear();
        this.renderChips();
      }),
      ...[...PLANES].reverse().map((p) =>
        chip(
          PLANE_NAME[p],
          this.targets.has(p),
          () => {
            if (this.targets.has(p)) this.targets.delete(p);
            else this.targets.add(p);
            if (this.targets.size === PLANES.length) this.targets.clear();
            this.renderChips();
          },
          PLANE_ACCENT[p],
        ),
      ),
    );
  }

  private renderPing(): void {
    this.pingEl.replaceChildren(
      ...(this.ping
        ? [
            icon('ping', 14),
            pingText(this.ping),
            h('button', { class: 'chat-x', 'aria-label': 'Remove ping', 'data-tip': 'Remove ping', onclick: () => ((this.ping = undefined), this.renderPing()) }, icon('cancel', 14)),
          ]
        : []),
    );
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.sending) return;
    this.sending = true;
    this.status.textContent = '';
    try {
      await this.send(this.targets.size === 0 ? 'all' : [...this.targets], text, this.ping);
      this.input.value = '';
      this.ping = undefined;
      this.renderPing();
      if (this.floating) this.close();
    } catch (e) {
      const code = e instanceof Error ? e.message : 'failed';
      this.status.textContent = code === 'rate_limited' ? 'Slow down — a few messages per second at most.' : `Not sent (${code}).`;
    } finally {
      this.sending = false;
    }
  }
}

/** Your messages and your agents' replies, newest last, colour-coded by plane. */
export class CommanderLog {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private lines: ChatLine[] = [];
  private readonly max: number;

  constructor(opts: { title?: string; max?: number } = {}) {
    this.max = opts.max ?? 60;
    this.list = h('div', { class: 'chat-lines', role: 'log', 'aria-live': 'polite' });
    this.el = h('section', { class: 'commander-log', 'aria-label': 'Commander log' },
      h('div', { class: 'dispatch-head' }, icon('chat', 14), h('span', { class: 'stamp' }, opts.title ?? 'Dispatches')), this.list);
    this.render();
  }

  add(line: ChatLine): void {
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    this.render();
  }

  /** Replace everything (Commanders screen: the server keeps the log). */
  set(lines: ChatLine[]): void {
    const next = lines.slice(-this.max);
    if (JSON.stringify(next) === JSON.stringify(this.lines)) return;
    this.lines = next;
    this.render();
  }

  private render(): void {
    this.el.classList.toggle('empty', this.lines.length === 0);
    if (this.lines.length === 0) {
      this.list.replaceChildren(h('div', { class: 'muted small' }, 'No messages yet. Your agents answer here (only you see their replies).'));
      return;
    }
    this.list.replaceChildren(
      ...this.lines.map((l) => {
        const planes = l.roles.filter(isPlane);
        const who =
          l.from === 'agent'
            ? h('b', {}, planes[0] ? `${PLANE_NAME[planes[0]]}:` : 'Agent:')
            : h('b', { class: 'you' }, `You · ${planes.length === PLANES.length ? 'All' : planes.map((p) => PLANE_NAME[p]).join(', ')}:`);
        const ping = l.ping !== undefined ? pingText(l.ping) : '';
        const accent = l.from === 'agent' && planes[0] ? `--accent:${PLANE_ACCENT[planes[0]]}` : undefined;
        return h('div', { class: `chat-line ${l.from}`, style: accent }, who, ' ', h('span', {}, l.text),
          ping ? h('span', { class: 'muted chat-line-ping' }, ' ', icon('ping', 12), ping) : null);
      }),
    );
    this.list.scrollTop = this.list.scrollHeight;
  }
}
