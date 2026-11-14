/**
 * "Who plays <Plane>": the in-match seat picker (commander popover). One wrapping grid of occupant cards; a click
 * hands the seat over at once. Arrow keys move between cards (Home/End to the ends), Enter or Space picks one. A
 * card that cannot take the seat stays focusable and its tip says why.
 */
import type { Plane } from '@agent-command/game/contract';
import { agentButton, agentText, type AgentIdentity } from './agent-button.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { tip } from './tooltip.ts';
import { PLANE_NAME } from './text.ts';

/** Connection/readiness lights; policy runtime failures and untried versions are distinct from both. */
export type SeatCardStatus = 'offline' | 'online' | 'ready' | 'failed' | 'waiting';
const STATUS_TEXT: Record<SeatCardStatus, string> = { offline: 'Offline', online: 'Online', ready: 'Ready', failed: 'Failing', waiting: 'Unconfirmed' };

export interface SeatCard {
  /** Stable across redraws (`human`, `bot`, `none`, `policy`, `commander:<id>`): keyboard focus stays on it. */
  key: string;
  /** Shown through `agentButton`; without `status` (the card carries its own light). */
  identity: AgentIdentity;
  status: SeatCardStatus;
  /** Plays this plane now. */
  current: boolean;
  /** What picking it does, or what it is doing now (tip). */
  hint: string;
  /** Why it cannot take the seat now (tip); unset when it can. */
  unavailable?: string;
}

export interface SeatPickerOptions {
  plane: Plane;
  cards: readonly SeatCard[];
  /** The card whose hand-over is in flight: it spins, and no card can be picked meanwhile. */
  pending?: string;
  /** Another popover action is in flight: no card can be picked. */
  busy: boolean;
  /** The card holding the keyboard stop (focus survives redraws); default the current occupant. */
  focus?: string;
  /** I have no commander for this plane: where to add one (opens in a new tab; the match keeps running). */
  addCommander?: string;
  pick(card: SeatCard): void;
}

export function seatPicker(o: SeatPickerOptions): HTMLElement {
  const plane = PLANE_NAME[o.plane];
  const cards = o.cards.map((card) => {
    const pending = o.pending === card.key;
    const state = pending ? 'Handing over…' : card.current ? card.identity.kind === 'none' ? 'On hold' : 'Playing' : card.unavailable && card.status !== 'offline' ? 'Unavailable' : STATUS_TEXT[card.status];
    // The chip keeps the whole card width for the name; its detail (Live, Policy v4) rides on the state line.
    const caption = !pending && card.identity.detail ? `${state} · ${card.identity.detail}` : state;
    const button = h('button', {
      type: 'button', class: 'seat-card', tabindex: '-1', 'data-key': card.key, 'aria-pressed': String(card.current),
      'aria-disabled': card.unavailable || o.busy ? 'true' : undefined, 'aria-busy': pending ? 'true' : undefined,
      'aria-label': `${agentText(card.identity)} · ${state}`,
    }, agentButton(card.identity, { size: 'small' }),
      h('span', { class: 'seat-card-state' }, h('i', { class: pending ? 'seat-card-spin' : 'seat-card-dot', 'data-status': card.status, 'aria-hidden': 'true' }), h('span', { class: 'seat-card-caption' }, caption)));
    tip(button, [card.unavailable ?? card.hint, card.identity.model && `${card.identity.model} (self-reported)`].filter(Boolean).join(' · '));
    button.addEventListener('click', () => { if (!card.current && !card.unavailable && !o.busy) o.pick(card); });
    return button;
  });
  const stop = cards.find((card) => card.dataset.key === o.focus) ?? cards.find((card) => card.getAttribute('aria-pressed') === 'true') ?? cards[0];
  if (stop) stop.tabIndex = 0;
  const grid = h('div', { class: 'seat-picker', role: 'group', 'aria-label': `Who plays ${plane}` }, ...cards);
  grid.addEventListener('keydown', (event) => {
    const at = cards.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    // A row is the cards sharing the first card's line; one row (or no layout) moves one card up or down.
    const columns = cards.filter((card) => card.offsetTop === cards[0]!.offsetTop).length;
    const row = columns < cards.length ? columns : 1;
    const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: row, ArrowUp: -row, Home: -at, End: cards.length - 1 - at } as Record<string, number>)[event.key];
    // The game's own shortcuts (camera arrows, plane keys) never see keys that belong to the picker.
    if (step === undefined) { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); return; }
    event.preventDefault(); event.stopPropagation();
    const next = cards[Math.max(0, Math.min(cards.length - 1, at + step))]!;
    for (const card of cards) card.tabIndex = card === next ? 0 : -1;
    next.focus();
  });
  const add = o.addCommander
    ? tip(h('a', { class: 'seat-picker-add', href: o.addCommander, target: '_blank', rel: 'noopener' }, icon('commanders', 14), 'Add a commander'),
      `No commander of yours plays ${plane} yet. Commanders opens in a new tab: connect an agent or deploy a policy, then pick it here.`)
    : null;
  return h('div', { class: 'seat-pick' }, h('p', { class: 'pop-label', 'aria-hidden': 'true' }, `Who plays ${plane}`), grid, add);
}
