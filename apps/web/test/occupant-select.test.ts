// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { PLANES, resolveBotOptions } from '@agent-command/game/contract';
import type { LobbyOccupant } from '@agent-command/game/lobby';
import { commanderPicker } from '../src/commander-picker.ts';
import { occupantSelect, slotState, type OccupantSelectOptions } from '../src/occupant-select.ts';
import type { RosterCommander } from '../src/profile.ts';

const commander = (id: string, patch: Partial<RosterCommander> = {}): RosterCommander => ({
  id, name: id, kind: 'agent', roles: ['surface'], isolation: { independentSessions: true }, token: 'private-token', scopes: [],
  mandate: { autonomy: 'autonomous', whenAbsent: 'hold', directive: { stance: 'defend' } },
  policy: { activeByRole: { surface: null }, versions: [] }, approvals: [], connected: true, lastSeenAt: null, seated: null, practicing: false, lastPractice: null, ...patch,
});
function mount(current: LobbyOccupant | undefined, patch: Partial<OccupantSelectOptions> = {}) {
  const options: OccupantSelectOptions = {
    team: 'se', roles: ['surface'], label: 'Red surface', current, currentText: 'Someone', you: 'me',
    roster: [commander('deepseek'), commander('policy-bot', { kind: 'policy', policy: { activeByRole: { surface: 5 }, versions: [] } }), commander('orbit-only', { roles: ['orbit'] })],
    disabled: false, claimOnly: false, claim: 'Claim seat', assign: vi.fn(), botLevel: vi.fn(), ...patch,
  };
  const el = occupantSelect(options); document.body.replaceChildren(el);
  const select = el.querySelector<HTMLSelectElement>('select[data-occupant]')!;
  const pick = (value: string) => { select.value = value; select.dispatchEvent(new Event('change')); };
  return { el, select, pick, options };
}

describe('slot state', () => {
  it('is empty until something occupies a seat', () => {
    expect(slotState([{ kind: 'open' }, { kind: 'open' }])).toBe('open');
    expect(slotState([{ kind: 'closed' }])).toBe('closed');
    expect(slotState([{ kind: 'open' }, { kind: 'closed' }])).toBe('open');
    expect(slotState([{ kind: 'open' }, { kind: 'bot', level: 'standard', options: {} }])).toBe('active');
  });
});

describe('commander picker', () => {
  it('lists only commanders compatible with every slot role and resolves exact refs', () => {
    const picker = commanderPicker([commander('a', { roles: ['surface', 'sky'] }), commander('b'), commander('c', { kind: 'policy', roles: ['surface', 'sky'], policy: { activeByRole: { surface: 2, sky: 3 }, versions: [] } })], ['surface', 'sky'], 'c', false);
    expect(picker.commanders.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect([...picker.options.querySelectorAll('option')].map((option) => [option.value, option.selected])).toEqual([['commander:a', false], ['commander:c', true]]);
    expect(picker.ref('commander:c')).toEqual({ id: 'c', kind: 'policy' });
    expect(commanderPicker(picker.commanders, ['sky'], 'c', false).ref('commander:c')).toEqual({ id: 'c', kind: 'policy', version: 3 });
    expect(picker.ref('commander:b')).toBeUndefined();
    expect(picker.options.outerHTML).not.toContain('private-token');
  });
  it('greys out a commander already on another army, with the reason as its tip, and resolves no ref for it', () => {
    const picker = commanderPicker([commander('a'), commander('b')], ['surface'], undefined, false, new Map([['a', 'Northwest']]));
    const [a, b] = [...picker.options.querySelectorAll('option')];
    expect(a!.disabled).toBe(true); expect(a!.textContent).toMatch(/^a · .* · plays Northwest$/);
    expect(a!.dataset.tip).toBe('a already plays Northwest. A commander plays one army per match: clear it there first.');
    expect(b!.disabled).toBe(false); expect(b!.dataset.tip).toBeUndefined();
    expect(picker.ref('commander:a')).toBeUndefined();
    expect(picker.ref('commander:b')).toEqual({ id: 'b', kind: 'agent' });
  });
});

describe('occupant selector', () => {
  it('offers You / Open / Bot / my compatible commanders / Closed and assigns atomically', () => {
    const { select, pick, options } = mount({ kind: 'open' });
    expect([...select.options].map((option) => option.value)).toEqual(['you', 'open', 'bot', 'commander:deepseek', 'commander:policy-bot', 'closed']);
    pick('bot'); expect(options.assign).toHaveBeenLastCalledWith({ kind: 'bot', level: 'standard', options: { ...resolveBotOptions('standard') } });
    pick('commander:policy-bot'); expect(options.assign).toHaveBeenLastCalledWith({ kind: 'commander', ref: { id: 'policy-bot', kind: 'policy', version: 5 } });
    pick('closed'); expect(options.assign).toHaveBeenLastCalledWith({ kind: 'closed' });
  });
  it('makes claiming an open slot the primary one-click action', () => {
    const { el, options } = mount({ kind: 'open' }, { roles: [...PLANES], claim: 'Claim slot' });
    const claim = el.querySelector<HTMLButtonElement>('[data-occupant-claim]')!;
    expect(claim.textContent).toBe('Claim slot'); expect(claim.classList.contains('primary')).toBe(true); expect(el.firstElementChild).toBe(claim);
    claim.click(); expect(options.assign).toHaveBeenCalledWith({ kind: 'human', memberId: 'me' });
    expect(mount({ kind: 'open' }, { disabled: true }).el.querySelector('[data-occupant-claim]')).toBeNull();
    expect(mount({ kind: 'bot', level: 'standard', options: {} }).el.querySelector('[data-occupant-claim]')).toBeNull();
  });
  it('limits non-leaders to claiming and shows occupied or mixed slots read-only', () => {
    const claimOnly = mount({ kind: 'open' }, { claimOnly: true }).select;
    expect([...claimOnly.options].filter((option) => !option.disabled && !(option.parentElement as HTMLOptGroupElement).disabled).map((option) => option.value)).toEqual(['you']);
    expect(mount({ kind: 'human', memberId: 'other' }).select.value).toBe('occupied');
    expect(mount(undefined).select.selectedOptions[0]?.textContent).toBe('Mixed · 4 planes');
  });
  it('exposes bot level and knobs, remembering a deliberate level change', () => {
    const { el, options } = mount({ kind: 'bot', level: 'standard', options: {} });
    const level = el.querySelector<HTMLSelectElement>('select[aria-label="Red surface bot level"]')!;
    level.value = 'veteran'; level.dispatchEvent(new Event('change'));
    expect(options.botLevel).toHaveBeenCalledWith('veteran');
    expect(options.assign).toHaveBeenLastCalledWith({ kind: 'bot', level: 'veteran', options: { ...resolveBotOptions('veteran') } });
  });
  it('lists no commander when none fits the slot roles (the room dock links to Commanders)', () => {
    const { el } = mount({ kind: 'open' }, { roles: ['depths'] });
    expect(el.querySelectorAll('optgroup option')).toHaveLength(0);
    expect(el.querySelector('button.ghost')).toBeNull();
  });
});
