// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANDATE_PRESETS, type ConsentCommander, type ConsentRequestInfo } from '@playerthree/connect';
import { ConnectPage } from '../src/connect-page.ts';
import { ProfileApi, type Roster, type RosterCommander } from '../src/profile.ts';
import * as profileApi from '../src/profile.ts';
import { ApiError } from '../src/api.ts';
import * as dom from '../src/dom.ts';

const KEY = 'agent-command.profile';
const profile = { id: 'a'.repeat(16), secret: 'b'.repeat(43) };
const request: ConsentRequestInfo = {
  client: { name: '<img> Harness', kind: 'codex', domain: 'harness.example', logoUri: 'https://external.invalid/tracking.png' },
  roles: ['surface', 'sky'], redirect: { host: '127.0.0.1:4545', loopback: true }, expiresAt: 9999999999999,
};
function commander(id: string, name: string, roles: RosterCommander['roles'] = ['surface']): RosterCommander {
  return { id, name, roles, kind: 'agent', isolation: { independentSessions: false }, token: `PRIVATE_TOKEN_${id}`,
    metadata: { provider: 'Provider', model: '<b>Model' }, scopes: [...MANDATE_PRESETS.autonomous.scopes],
    mandate: { ...MANDATE_PRESETS.autonomous, whenAbsent: 'policy', directive: { stance: 'defend' } },
    policy: { activeByRole: { surface: null }, versions: [] }, approvals: [], connected: false, lastSeenAt: null, seated: null, practicing: false, lastPractice: null };
}
const first = commander('first', 'DeepSeek Surface');
const second = commander('second', 'OpenAI Surface');
const roster: Roster = { id: profile.id, surfaceHash: 'a'.repeat(64), commanders: [first, second], chat: [] };
function button(page: ConnectPage, text: string): HTMLButtonElement {
  const found = [...page.el.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
function choose(page: ConnectPage, id: string): void {
  const select = page.el.querySelector<HTMLSelectElement>('#consent-commander')!;
  select.value = id;
  select.dispatchEvent(new Event('change'));
}
async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function mount(): ConnectPage { const page = new ConnectPage('request-id'); document.body.append(page.el); return page; }

beforeEach(() => {
  history.replaceState(null, '', '/connect?r=request-id');
  localStorage.clear();
  vi.spyOn(profileApi, 'consentInfo').mockResolvedValue(request);
  vi.spyOn(ProfileApi.prototype, 'roster').mockResolvedValue(roster);
  vi.spyOn(ProfileApi.prototype, 'connections').mockResolvedValue([]);
  vi.spyOn(ProfileApi, 'create');
  vi.spyOn(ProfileApi.prototype, 'createCommander');
  // No navigation is needed to assert the one-time terminal state.
  vi.spyOn(ProfileApi.prototype, 'answerConsent').mockResolvedValue({ redirect: 'javascript:blocked' });
  vi.spyOn(profileApi, 'answerPairedConsent').mockResolvedValue({ redirect: 'javascript:blocked' });
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear(); });

describe('named commander consent', () => {
  it('never creates a profile or connection when this browser has no identity', async () => {
    const page = mount(); await settle();
    expect(page.el.textContent).toContain('Nothing has been created');
    expect(button(page, 'Create a separate profile').disabled).toBe(true);
    expect(ProfileApi.create).not.toHaveBeenCalled();
    expect(ProfileApi.prototype.createCommander).not.toHaveBeenCalled();
    expect(page.el.querySelector('#consent-commander')).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('requires an explicit named selection, gates compatible roles and grants its ID only once', async () => {
    localStorage.setItem(KEY, JSON.stringify(profile));
    const page = mount(); await settle();
    expect(button(page, 'Choose a commander').disabled).toBe(true);
    expect([...page.el.querySelectorAll('option')].map((node) => node.textContent)).toContain(second.name);
    choose(page, second.id);
    expect(page.el.querySelector<HTMLButtonElement>('[data-plane="sky"]')!.disabled).toBe(true);
    expect(page.el.querySelector('[data-plane="surface"]')!.getAttribute('aria-pressed')).toBe('true');
    button(page, 'Allow 1 plane').click();
    button(page, 'Sending').click();
    await settle();
    expect(ProfileApi.prototype.answerConsent).toHaveBeenCalledExactlyOnceWith('request-id', second.id, ['surface'], true);
    expect(page.el.textContent).toContain('Allowed');
    expect(page.el.querySelector('select')).toBeNull();
    expect(ProfileApi.prototype.createCommander).not.toHaveBeenCalled();
  });

  it('displays identity as text, marks self-reports, never loads remote logos or renders credentials', async () => {
    localStorage.setItem(KEY, JSON.stringify(profile));
    const page = mount(); await settle(); choose(page, first.id);
    expect(page.el.textContent).toContain('<img> Harness');
    expect(page.el.textContent).toContain('verified by harness.example');
    expect(page.el.textContent).toContain('Provider / <b>Model · self-reported');
    expect(page.el.textContent).toContain('never your profile secret');
    expect(page.el.querySelector('img')).toBeNull();
    expect(page.el.innerHTML).not.toContain('PRIVATE_TOKEN');
    expect(page.el.innerHTML).not.toContain(profile.secret);
    expect(page.el.querySelector('[name="team"]')).toBeNull();
    expect(page.el.querySelector('[data-tip]')).not.toBeNull();
  });

  it('allows reducing the grant to a subset and disables approval for no roles', async () => {
    localStorage.setItem(KEY, JSON.stringify(profile));
    vi.mocked(ProfileApi.prototype.roster).mockResolvedValue({ ...roster, commanders: [commander('both', 'Both', ['surface', 'sky'])] });
    const page = mount(); await settle(); choose(page, 'both');
    page.el.querySelector<HTMLButtonElement>('[data-plane="sky"]')!.click();
    page.el.querySelector<HTMLButtonElement>('[data-plane="surface"]')!.click();
    expect(button(page, 'Pick a plane').disabled).toBe(true);
    page.el.querySelector<HTMLButtonElement>('[data-plane="surface"]')!.click();
    button(page, 'Allow 1 plane').click(); await settle();
    expect(ProfileApi.prototype.answerConsent).toHaveBeenCalledWith('request-id', 'both', ['surface'], true);
  });

  it('creates only an explicitly submitted new roster entry, then waits for a separate allow click', async () => {
    localStorage.setItem(KEY, JSON.stringify(profile));
    const created = commander('new', 'New connection', ['surface', 'sky']);
    vi.mocked(ProfileApi.prototype.createCommander).mockResolvedValue({ ...roster, commanders: [...roster.commanders, created] });
    const page = mount(); await settle();
    const input = page.el.querySelector<HTMLInputElement>('#consent-new-name')!;
    input.value = 'New connection'; input.dispatchEvent(new Event('input'));
    page.el.querySelector<HTMLFormElement>('.consent-create')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(ProfileApi.prototype.createCommander).toHaveBeenCalledExactlyOnceWith({ name: 'New connection', kind: 'agent', roles: ['surface', 'sky'], isolation: { independentSessions: false } });
    expect(page.el.querySelector<HTMLSelectElement>('#consent-commander')!.value).toBe('new');
    expect(ProfileApi.prototype.answerConsent).not.toHaveBeenCalled();
    button(page, 'Allow 2 planes').click(); await settle();
    expect(ProfileApi.prototype.answerConsent).toHaveBeenCalledWith('request-id', 'new', ['surface', 'sky'], true);
  });

  it('denies an empty roster without creating a commander and cannot answer twice', async () => {
    localStorage.setItem(KEY, JSON.stringify(profile));
    vi.mocked(ProfileApi.prototype.roster).mockResolvedValue({ ...roster, commanders: [] });
    const page = mount(); await settle(); button(page, 'Deny').click(); await settle();
    expect(ProfileApi.prototype.answerConsent).toHaveBeenCalledExactlyOnceWith('request-id', '', [], false);
    expect(page.el.textContent).toContain('Denied');
    expect(ProfileApi.prototype.createCommander).not.toHaveBeenCalled();
  });

  it('preserves an unrecognized saved profile rather than silently replacing it', async () => {
    localStorage.setItem(KEY, JSON.stringify(profile));
    vi.mocked(ProfileApi.prototype.roster).mockRejectedValue(new ApiError('bad_profile'));
    const page = mount(); await settle();
    expect(page.el.textContent).toContain('credentials have been preserved');
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(profile));
    expect(ProfileApi.create).not.toHaveBeenCalled();
  });

  it('makes an already answered request terminal instead of exposing another grant attempt', async () => {
    localStorage.setItem(KEY, JSON.stringify(profile));
    vi.mocked(ProfileApi.prototype.answerConsent).mockRejectedValue(new ApiError('unknown_request'));
    const page = mount(); await settle(); choose(page, first.id); button(page, 'Allow 1 plane').click(); await settle();
    expect(page.el.textContent).toContain('already answered');
    expect(page.el.querySelector('select')).toBeNull();
    expect(ProfileApi.prototype.answerConsent).toHaveBeenCalledTimes(1);
  });

  it('keeps paired authorization request-only, preserves this browser identity and selects a safe named commander', async () => {
    localStorage.setItem(KEY, JSON.stringify(profile));
    const safe: ConsentCommander = { id: 'original', name: 'Original commander', kind: 'agent', roles: ['sky'], isolation: { independentSessions: false }, metadata: { model: 'Original model' }, scopes: first.scopes, mandate: first.mandate, holder: null };
    vi.spyOn(profileApi, 'pairConsent').mockResolvedValue({ commanders: [safe], pairingToken: 'request-only-capability', expiresAt: request.expiresAt });
    const page = mount(); await settle();
    const input = page.el.querySelector<HTMLInputElement>('[aria-label="Pairing code"]')!;
    input.value = 'ABC234'; input.dispatchEvent(new Event('input'));
    page.el.querySelector<HTMLFormElement>('.consent-pair')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(); choose(page, safe.id);
    expect(page.el.querySelector('.consent-create')).toBeNull();
    expect(page.el.textContent).toContain('Pairing cannot create or edit your roster');
    expect(page.el.textContent).toContain('Original model · self-reported');
    button(page, 'Allow 1 plane').click(); await settle();
    expect(profileApi.answerPairedConsent).toHaveBeenCalledExactlyOnceWith('request-id', 'original', ['sky'], true, 'request-only-capability');
    expect(ProfileApi.prototype.answerConsent).not.toHaveBeenCalled();
    expect(ProfileApi.create).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(profile));
    expect(page.el.textContent).toContain('No profile credential was saved');
    expect(page.el.innerHTML).not.toContain('request-only-capability');
  });
  it('copies the exact pending sign-in URL and retains the existing profile when pairing fails', async () => {
    localStorage.setItem(KEY, JSON.stringify(profile));
    history.replaceState(null, '', '/connect?r=request-id&continuity=keep');
    const copy = vi.spyOn(dom, 'copyText').mockResolvedValue(true);
    vi.spyOn(profileApi, 'pairConsent').mockRejectedValue(new ApiError('bad_code'));
    const page = mount(); await settle();
    button(page, 'Copy sign-in link').click(); await settle();
    expect(copy).toHaveBeenCalledWith(location.href);
    const input = page.el.querySelector<HTMLInputElement>('[aria-label="Pairing code"]')!;
    input.value = 'BAD234'; input.dispatchEvent(new Event('input'));
    page.el.querySelector<HTMLFormElement>('.consent-pair')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(page.el.textContent).toContain('invalid, expired or already used');
    expect(page.el.querySelector<HTMLInputElement>('[aria-label="Pairing code"]')!.value).toBe('BAD234');
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(profile));
    expect(ProfileApi.create).not.toHaveBeenCalled();
  });

  it('creates a separate profile only after an explicit confirmation and button press', async () => {
    vi.mocked(ProfileApi.create).mockImplementation(async () => {
      localStorage.setItem(KEY, JSON.stringify(profile));
      return { api: ProfileApi.stored()!, roster };
    });
    const page = mount(); await settle();
    expect(ProfileApi.create).not.toHaveBeenCalled();
    const confirmation = page.el.querySelector<HTMLInputElement>('.consent-recovery details input[type="checkbox"]')!;
    confirmation.checked = true; confirmation.dispatchEvent(new Event('change'));
    expect(ProfileApi.create).not.toHaveBeenCalled();
    button(page, 'Create a separate profile').click(); await settle();
    expect(ProfileApi.create).toHaveBeenCalledTimes(1);
    expect(page.el.querySelector<HTMLSelectElement>('#consent-commander')!.value).toBe('');
    expect(ProfileApi.prototype.answerConsent).not.toHaveBeenCalled();
  });

});
