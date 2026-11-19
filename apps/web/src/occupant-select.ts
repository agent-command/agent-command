/**
 * The one slot occupant selector (You / Open / Bot level + knobs / Commander / Closed), used for whole armies,
 * single plane seats and benchmark setups alike. Every change is one atomic `assign` of a tagged SlotOccupant.
 */
import { OPPONENTS, botDescriptor, resolveBotOptions, type BOT_KNOBS, type Opponent, type Plane } from '@agent-command/game/contract';
import type { LobbyOccupant, LobbySeat, SlotOccupant } from '@agent-command/game/lobby';
import { OPP_LABEL } from './agent-button.ts';
import { COMMANDER_VALUE, commanderPicker } from './commander-picker.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import type { RosterCommander } from './profile.ts';
import './occupant-select.css';

/** Open and Closed are pregame availability, not occupants: such slots render empty until someone takes them. */
export type SlotState = 'open' | 'closed' | 'active';
export function slotState(occupants: readonly LobbyOccupant[]): SlotState {
  if (occupants.some((occupant) => occupant.kind !== 'open' && occupant.kind !== 'closed')) return 'active';
  return occupants.some((occupant) => occupant.kind === 'open') ? 'open' : 'closed';
}

/** Semantic equality never collapses unlike bot settings or different named connections. */
export function wholeArmyOccupant(seats: readonly LobbySeat[]): LobbyOccupant | undefined {
  const first = seats[0]?.occupant;
  if (!first) return undefined;
  const key = occupantKey(first);
  return seats.every((seat) => occupantKey(seat.occupant) === key) ? first : undefined;
}
function occupantKey(occupant: LobbyOccupant): string {
  switch (occupant.kind) {
    case 'human': return `human:${occupant.memberId}`;
    case 'bot': return JSON.stringify(['bot', occupant.level, Object.entries(resolveBotOptions(occupant.level as Opponent, occupant.options)).sort(([a], [b]) => a.localeCompare(b))]);
    case 'commander': return `commander:${occupant.ref?.id ?? occupant.entrantId}:${occupant.ref?.kind ?? ''}:${occupant.ref?.version ?? ''}`;
    default: return occupant.kind;
  }
}

export interface OccupantSelectOptions {
  team: string;
  roles: readonly Plane[];
  /** Accessible prefix, e.g. "Northwest whole army". */
  label: string;
  /** Undefined when the slot's seats differ. */
  current: LobbyOccupant | undefined;
  /** Display text for a current occupant this member cannot select (another human, someone else's commander). */
  currentText: string;
  you: string;
  roster: readonly RosterCommander[] | undefined;
  /** My commanders already on another army (id → its label): greyed out, a commander plays one army per match. */
  otherArmy?: ReadonlyMap<string, string>;
  disabled: boolean;
  /** Non-leaders may only take open seats for themselves. */
  claimOnly: boolean;
  /** Primary one-click claim on open slots ("Claim slot"); members without seats (observers) may claim too. */
  claim: string;
  assign(occupant: SlotOccupant): void;
  /** A deliberate bot level change, remembered for the next practice. */
  botLevel(level: Opponent): void;
}

export function occupantSelect(o: OccupantSelectOptions): HTMLElement {
  const { current } = o;
  const roles = [...o.roles];
  const ownRef = current?.kind === 'commander' ? current.ref : undefined;
  const picker = commanderPicker(o.roster, roles, ownRef?.id, o.claimOnly, o.otherArmy);
  const value = !current ? 'mixed' : current.kind === 'human' ? current.memberId === o.you ? 'you' : 'occupied' : current.kind === 'commander' ? ownRef ? `${COMMANDER_VALUE}${ownRef.id}` : 'occupied' : current.kind;
  const select = h('select', { 'aria-label': `${o.label} occupant`, 'data-occupant': `${o.team}:${roles.join(',')}`, disabled: o.disabled, 'data-tip': 'Changes are atomic and clear readiness. Other members must release their occupied seats.', onchange: (event: Event) => {
    const picked = (event.target as HTMLSelectElement).value;
    if (picked === 'you') o.assign({ kind: 'human', memberId: o.you });
    else if (picked === 'open' || picked === 'closed') o.assign({ kind: picked });
    else if (picked === 'bot') o.assign({ kind: 'bot', level: 'standard', options: { ...resolveBotOptions('standard') } });
    else { const ref = picker.ref(picked); if (ref) o.assign({ kind: 'commander', ref }); }
  } },
    ...(value === 'mixed' || value === 'occupied' ? [h('option', { value, selected: true, disabled: true }, value === 'mixed' ? 'Mixed · 4 planes' : o.currentText)] : []),
    ...([['you', 'You'], ['open', 'Open'], ['bot', 'Bot']] as const).map(([option, text]) => h('option', { value: option, selected: option === value, disabled: o.claimOnly && option !== 'you' }, text)),
    picker.options,
    h('option', { value: 'closed', selected: value === 'closed', disabled: o.claimOnly }, 'Closed'));
  const el = h('div', { class: 'occupant-select' });
  if (current?.kind === 'open' && !o.disabled) el.append(h('button', { type: 'button', class: 'btn primary', 'data-occupant-claim': `${o.team}:${roles.join(',')}`, 'data-tip': 'Take this slot yourself', onclick: () => o.assign({ kind: 'human', memberId: o.you }) }, icon('human'), o.claim));
  el.append(select);
  if (current?.kind !== 'bot') return el;
  const level = current.level as Opponent;
  const assign = (nextLevel: Opponent, options: Record<string, number | boolean>) => o.assign({ kind: 'bot', level: nextLevel, options });
  el.append(h('select', { 'aria-label': `${o.label} bot level`, disabled: o.disabled, onchange: (event: Event) => { const next = (event.target as HTMLSelectElement).value as Opponent; o.botLevel(next); assign(next, { ...resolveBotOptions(next) }); } },
    ...OPPONENTS.map((option) => h('option', { value: option, selected: level === option }, OPP_LABEL[option]))));
  const descriptor = botDescriptor(level);
  const knobs: Readonly<Record<string, (typeof BOT_KNOBS)[keyof typeof BOT_KNOBS]>> = descriptor.knobs;
  const options = resolveBotOptions(level, current.options);
  if (Object.keys(knobs).length) el.append(h('details', { class: 'occupant-bot-tune' }, h('summary', { 'data-tip': 'Deterministic strategy options' }, icon('settings', 16), 'Tune'),
    ...Object.entries(knobs).map(([key, knob]) => h('label', { 'data-tip': knob.description }, knob.label,
      h('input', { type: 'range', min: knob.min, max: knob.max, step: knob.step, value: options[key as keyof typeof options], disabled: o.disabled, 'aria-label': `${o.label} ${knob.label}`, onchange: (event: Event) => assign(level, { ...options, [key]: Number((event.target as HTMLInputElement).value) }) }),
      h('span', {}, String(options[key as keyof typeof options]))))));
  return el;
}
