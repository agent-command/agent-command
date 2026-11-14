// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicyStatus } from 'playerthree/control';
import { CommanderSeats, type PopHost, type SeatState } from '../src/commander-pop.ts';
import { ApiError } from '../src/api.ts';
import { ProfileApi, type Roster, type RosterCommander } from '../src/profile.ts';
const profile = { id: 'a'.repeat(16), secret: 'b'.repeat(43) };
const seat: SeatState = { controller: 'agent', agentActive: true, scopes: ['act'], mandate: { autonomy: 'autonomous', whenAbsent: 'hold', directive: { stance: 'defend' } } };
function commander(id: string, team: string): RosterCommander {
  return { id, name: id, kind: 'agent', roles: ['surface', 'sky'], isolation: { independentSessions: true }, token: `private-${id}`, scopes: ['act'], mandate: seat.mandate,
    policy: { activeByRole: { surface: null, sky: null }, versions: [] }, approvals: [], connected: true, lastSeenAt: null, seated: { match: 'match', roomId: 'match', team, roles: ['surface', 'sky'] }, practicing: false, lastPractice: null };
}
const roster: Roster = { id: profile.id, surfaceHash: 'a'.repeat(64), commanders: [commander('North agent', 'nw'), commander('South agent', 'se')], chat: [] };
let commanderSeats: CommanderSeats; let stop: (() => void) | undefined;
function host(patch: Partial<PopHost> = {}): PopHost {
  return { matchId: 'match', team: () => 'nw', seat: () => seat, setController: vi.fn(async () => {}), setMandate: vi.fn(async () => {}), setScopes: vi.fn(async () => {}),
    resolveApproval: vi.fn(async () => {}), policyStatus: vi.fn(async () => null), mint: vi.fn(async () => 'exact-seat-token'), pickFocus: vi.fn(), toast: vi.fn(), changed: vi.fn(), ...patch };
}
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); localStorage.setItem('agent-command.profile', JSON.stringify(profile));
  vi.spyOn(ProfileApi.prototype, 'roster').mockResolvedValue(roster);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ policies: { surface: null, sky: null } })));
});
afterEach(() => { stop?.(); stop = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function mount(owner: PopHost): Promise<void> { commanderSeats = new CommanderSeats(owner); document.body.append(commanderSeats.pop); stop = commanderSeats.start(); await vi.advanceTimersByTimeAsync(0); }

describe('frozen exact-seat commander controls', () => {
  it('resolves named commander by match, team and role, never the first compatible role entry', async () => {
    await mount(host({ team: () => 'se' }));
    expect(commanderSeats.chipFor('surface').textContent).toContain('South agent');
    commanderSeats.toggle('surface'); expect(commanderSeats.pop.textContent).toContain('South agent'); expect(commanderSeats.pop.textContent).not.toContain('North agent');
  });
  it('supports one commander on multiple same-side isolated roles', async () => {
    await mount(host()); expect(commanderSeats.chipFor('surface').textContent).toContain('North agent'); expect(commanderSeats.chipFor('sky').textContent).toContain('North agent');
  });
  it('does not bind an unrelated match using role compatibility alone', async () => {
    await mount(host({ matchId: 'other-match' })); expect(commanderSeats.chipFor('surface').textContent).not.toContain('North agent');
  });
  it('keeps observer controls closed and never polls owner-private roster state', async () => {
    const owner = host({ readOnly: true }); await mount(owner); commanderSeats.toggle('surface');
    expect(owner.toast).toHaveBeenCalledWith('Observing · read-only'); expect(commanderSeats.pop.hidden).toBe(true); expect(ProfileApi.prototype.roster).not.toHaveBeenCalled();
  });
});

describe('"Who plays <Plane>" seat picker', () => {
  const spare: RosterCommander = { ...commander('Spare agent', 'nw'), roles: ['depths'], seated: null };
  const withCommanders = (...extra: RosterCommander[]) => vi.mocked(ProfileApi.prototype.roster).mockResolvedValue({ ...roster, commanders: [...roster.commanders, ...extra] });
  const cards = () => [...commanderSeats.pop.querySelectorAll<HTMLButtonElement>('.seat-card')];
  const card = (key: string) => cards().find((entry) => entry.dataset.key === key)!;

  it('lists me, a bot, hold, the seat\'s live agent and my compatible commanders, and hands the seat over on a click', async () => {
    const assign = vi.fn(async () => {});
    withCommanders(spare, { ...commander('Sky only', 'nw'), roles: ['sky'], seated: null });
    const owner = host({ assign }); await mount(owner);
    commanderSeats.toggle('depths');
    expect(commanderSeats.pop.querySelector('.seat-picker')?.getAttribute('aria-label')).toBe('Who plays Depths');
    // Only commanders compatible with this plane; the current occupant (the seat's live agent) is highlighted.
    expect(cards().map((entry) => entry.dataset.key)).toEqual(['human', 'bot', 'none', 'agent', 'commander:Spare agent']);
    expect(cards().filter((entry) => entry.getAttribute('aria-pressed') === 'true').map((entry) => entry.dataset.key)).toEqual(['agent']);
    expect(card('commander:Spare agent').querySelector('.seat-card-dot')?.getAttribute('data-status')).toBe('online');
    expect(card('commander:Spare agent').textContent).toContain('Spare agent');

    card('commander:Spare agent').click(); await vi.advanceTimersByTimeAsync(0);
    expect(assign).toHaveBeenCalledWith('depths', { kind: 'commander', ref: { id: 'Spare agent', kind: 'agent' } });
    expect(owner.toast).toHaveBeenLastCalledWith('Depths → Spare agent (your commander)', 'ok');
    card('bot').click(); await vi.advanceTimersByTimeAsync(0);
    expect(assign).toHaveBeenLastCalledWith('depths', { kind: 'bot' });
    expect(owner.toast).toHaveBeenLastCalledWith('Depths → Bot', 'ok');
    card('human').click(); await vi.advanceTimersByTimeAsync(0);
    expect(assign).toHaveBeenLastCalledWith('depths', { kind: 'human' });
    // Hold and the seat's own agent change only the controller.
    card('none').click(); await vi.advanceTimersByTimeAsync(0);
    expect(owner.setController).toHaveBeenLastCalledWith('depths', 'none');
    expect(assign).toHaveBeenCalledTimes(3);
    expect(owner.toast).toHaveBeenLastCalledWith('Depths → Hold', 'ok');
  });

  it('spins on the picked card while it is handed over, then explains a refusal in plain English', async () => {
    let refuse!: (error: Error) => void;
    const assign = vi.fn(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
    withCommanders(spare);
    const owner = host({ assign }); await mount(owner);
    commanderSeats.toggle('depths');
    card('commander:Spare agent').click(); await vi.advanceTimersByTimeAsync(0);
    expect(card('commander:Spare agent').getAttribute('aria-busy')).toBe('true');
    expect(card('commander:Spare agent').querySelector('.seat-card-spin')).not.toBeNull();
    expect(card('commander:Spare agent').textContent).toContain('Handing over');
    // Every other card waits for it.
    expect(card('bot').getAttribute('aria-disabled')).toBe('true');
    card('bot').click(); expect(assign).toHaveBeenCalledTimes(1);

    refuse(new ApiError('agents_need_main')); await vi.advanceTimersByTimeAsync(0);
    expect(owner.toast).toHaveBeenLastCalledWith('Couldn\'t hand Depths to Spare agent: commanders can only join this match at the start (it runs on a game worker).', 'err');
    expect(card('commander:Spare agent').getAttribute('aria-busy')).toBeNull();
    expect(card('bot').getAttribute('aria-disabled')).toBeNull();
  });

  it('disables commanders that cannot take the seat now, with the reason in the tip', async () => {
    const assign = vi.fn(async () => {});
    withCommanders(
      { ...commander('Asleep', 'nw'), roles: ['depths'], seated: null, connected: false },
      { ...commander('Elsewhere', 'nw'), roles: ['depths'], seated: { match: 'other', roomId: 'other', team: 'nw', roles: ['depths'] } },
      { ...commander('Enemy side', 'se'), roles: ['depths'] },
      spare,
    );
    await mount(host({ assign }));
    commanderSeats.toggle('depths');
    const tipOf = (key: string) => card(key).dataset.tip ?? '';
    expect(card('commander:Asleep').getAttribute('aria-disabled')).toBe('true');
    expect(card('commander:Asleep').querySelector('.seat-card-dot')?.getAttribute('data-status')).toBe('offline');
    expect(tipOf('commander:Asleep')).toBe('Asleep is offline: start its agent (Commanders shows how), then hand it Depths.');
    expect(tipOf('commander:Elsewhere')).toBe('Elsewhere is playing another match.');
    expect(tipOf('commander:Enemy side')).toBe('Enemy side already plays another army in this match.');
    expect(card('commander:Spare agent').getAttribute('aria-disabled')).toBeNull();
    for (const key of ['commander:Asleep', 'commander:Elsewhere', 'commander:Enemy side']) card(key).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(assign).not.toHaveBeenCalled();
  });

  it('says up front that a worker-hosted match takes no commanders mid-match', async () => {
    const assign = vi.fn(async () => {});
    withCommanders(spare);
    await mount(host({ assign, agentHandOver: false }));
    commanderSeats.toggle('depths');
    expect(card('commander:Spare agent').getAttribute('aria-disabled')).toBe('true');
    expect(card('commander:Spare agent').dataset.tip).toContain('can only join this match at the start');
    expect(card('commander:Spare agent').textContent).toContain('Unavailable');
    card('commander:Spare agent').click(); await vi.advanceTimersByTimeAsync(0);
    expect(assign).not.toHaveBeenCalled();
    // Me and a bot still work.
    card('bot').click(); await vi.advanceTimersByTimeAsync(0);
    expect(assign).toHaveBeenCalledWith('depths', { kind: 'bot' });
  });

  it('offers no commanders outside lobby matches: me, a bot and hold change the controller', async () => {
    const owner = host(); await mount(owner); commanderSeats.toggle('surface');
    // The bound commander is the seat's own agent; no other commander and no "Add a commander" here.
    expect(cards().map((entry) => entry.dataset.key)).toEqual(['human', 'bot', 'none', 'commander:North agent']);
    expect(commanderSeats.pop.querySelector('.seat-picker-add')).toBeNull();
    card('bot').click(); await vi.advanceTimersByTimeAsync(0);
    expect(owner.setController).toHaveBeenLastCalledWith('surface', 'bot');
    expect(owner.toast).toHaveBeenLastCalledWith('Surface → Bot', 'ok');
  });

  it('links to Commanders when I have no commander for the plane', async () => {
    await mount(host({ assign: vi.fn(async () => {}) })); commanderSeats.toggle('orbit');
    const add = commanderSeats.pop.querySelector<HTMLAnchorElement>('.seat-picker-add')!;
    expect(add.textContent).toBe('Add a commander');
    expect(add.getAttribute('href')).toBe('?screen=commanders');
    expect(add.target).toBe('_blank');
  });

  it('moves between cards with the arrow keys, keeps those keys from the game and keeps focus through redraws', async () => {
    withCommanders(spare);
    await mount(host({ assign: vi.fn(async () => {}) }));
    commanderSeats.toggle('depths'); commanderSeats.focusPicker();
    const focused = () => (document.activeElement as HTMLElement | null)?.dataset.key;
    expect(focused()).toBe('agent');
    const game = vi.fn(); window.addEventListener('keydown', game);
    const key = (name: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    try {
      key('ArrowRight'); expect(focused()).toBe('commander:Spare agent');
      key('ArrowLeft'); key('ArrowLeft'); expect(focused()).toBe('none');
      key('Home'); expect(focused()).toBe('human');
      key('End'); expect(focused()).toBe('commander:Spare agent');
      expect(game).not.toHaveBeenCalled();
      expect(cards().filter((entry) => entry.tabIndex === 0).map((entry) => entry.dataset.key)).toEqual(['commander:Spare agent']);
      commanderSeats.refresh(); expect(focused()).toBe('commander:Spare agent');
    } finally { window.removeEventListener('keydown', game); }
  });
});

describe('owner-private policy runtime health', () => {
  const failed: PolicyStatus = {
    version: 1, runtime: 'js', calls: 406, successfulCalls: 0, consecutiveFailures: 406,
    errors: 406, timeouts: 0, meanMs: 1, maxMs: 1, intentsEmitted: 0, intentsRejected: [], logs: [],
    lastError: { code: 'threw', message: "cannot read property 'vision' of undefined" },
  };
  it('warns without opening controls, then shows recovery despite historical failures, without switching controllers', async () => {
    let status = failed;
    const owner = host({ seat: () => ({ ...seat, controller: 'policy', policyVersion: 1 }), policyStatus: vi.fn(async () => status) });
    await mount(owner);
    expect(owner.policyStatus).toHaveBeenCalledWith('depths');
    expect(commanderSeats.chipFor('depths').dataset.health).toBe('failed');
    expect(commanderSeats.chipFor('depths').textContent).toContain('406 consecutive failures');
    commanderSeats.toggle('depths');
    expect(commanderSeats.pop.querySelector('[role="alert"]')?.textContent).toContain('No successful decisions');
    expect(commanderSeats.pop.textContent).toContain("cannot read property 'vision' of undefined");
    expect(commanderSeats.pop.querySelector('[data-key="policy"] .seat-card-dot')?.getAttribute('data-status')).toBe('failed');
    status = { ...failed, calls: 407, successfulCalls: 1, consecutiveFailures: 0, intentsEmitted: 2 };
    await vi.advanceTimersByTimeAsync(3000);
    expect(commanderSeats.chipFor('depths').dataset.health).toBe('ok');
    expect(commanderSeats.pop.textContent).toContain('Policy recovered');
    expect(commanderSeats.pop.textContent).toContain('1 successful decisions');
    expect(commanderSeats.pop.textContent).toContain('406 errors');
    expect(commanderSeats.pop.textContent).toContain('Previous failure');
    expect(commanderSeats.pop.querySelector('[role="alert"]')).toBeNull();
    expect(owner.setController).not.toHaveBeenCalled();
  });
  it('distinguishes a newly repaired version awaiting a decision from successful execution', async () => {
    const owner = host({ seat: () => ({ ...seat, controller: 'policy', policyVersion: 2 }), policyStatus: vi.fn(async () => ({
      ...failed, version: 2, calls: 0, successfulCalls: 0, consecutiveFailures: 0, errors: 0, lastError: undefined,
    })) });
    await mount(owner);
    expect(commanderSeats.chipFor('depths').dataset.health).toBe('waiting');
    commanderSeats.toggle('depths');
    expect(commanderSeats.pop.textContent).toContain('No successful policy decisions yet');
    expect(commanderSeats.pop.querySelector('[data-key="policy"] .seat-card-dot')?.getAttribute('data-status')).toBe('waiting');
  });
  it('reports loss of status rather than retaining a stale failure badge', async () => {
    const status = vi.fn(async (): Promise<PolicyStatus> => failed);
    await mount(host({ seat: () => ({ ...seat, controller: 'policy' }), policyStatus: status }));
    expect(commanderSeats.chipFor('depths').dataset.health).toBe('failed');
    status.mockRejectedValue(new Error('disconnected'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(commanderSeats.chipFor('depths').dataset.health).toBe('unknown');
  });
  it('never requests or displays runtime status as a spectator', async () => {
    const owner = host({ readOnly: true, seat: () => ({ ...seat, controller: 'policy' }), policyStatus: vi.fn(async () => failed) });
    await mount(owner);
    expect(owner.policyStatus).not.toHaveBeenCalled();
    expect(commanderSeats.chipFor('depths').dataset.health).toBeUndefined();
  });
  it('shows a failed activation distinctly from no policy installed', async () => {
    await mount(host({ seat: () => ({ ...seat, controller: 'policy' }), policyStatus: vi.fn(async (): Promise<PolicyStatus> => ({ version: null, activationError: 'policy_failed' })) }));
    expect(commanderSeats.chipFor('depths').dataset.health).toBe('failed');
    commanderSeats.toggle('depths');
    expect(commanderSeats.pop.textContent).toContain('Policy could not start');
  });
  it('reads an agent seat through its authenticated live lease without requiring a human socket', async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ policies: { surface: { ...failed, calls: 613, successfulCalls: 613, consecutiveFailures: 0, errors: 0 } } }));
    const owner = host({ seat: (plane) => plane === 'surface' ? { ...seat, controller: 'policy', policyVersion: 1 } : seat, policyStatus: vi.fn(async () => { throw new ApiError('forbidden'); }) });
    await mount(owner);
    commanderSeats.toggle('surface'); await vi.advanceTimersByTimeAsync(0);
    expect(commanderSeats.pop.querySelector('.policy-health')?.getAttribute('data-health')).toBe('ok');
    expect(owner.policyStatus).not.toHaveBeenCalled();
    const [path, init] = vi.mocked(fetch).mock.calls[0]!;
    const query = new URL(String(path), 'https://game.test').searchParams;
    expect(Object.fromEntries(query)).toEqual({ commander: 'North agent', match: 'match', team: 'nw', role: 'surface' });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${profile.secret}`);
    vi.mocked(fetch).mockImplementation(async () => Response.json({ error: 'forbidden' }, { status: 403 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(commanderSeats.pop.querySelector('.policy-health')?.getAttribute('data-health')).toBe('unknown');
    expect(owner.policyStatus).not.toHaveBeenCalled();
  });
  it('distinguishes an installed-policy absence from a failed status read', async () => {
    const status = vi.fn(async (): Promise<PolicyStatus | null> => null);
    await mount(host({ seat: () => ({ ...seat, controller: 'policy' }), policyStatus: status }));
    expect(commanderSeats.chipFor('depths').dataset.health).toBe('waiting');
    status.mockRejectedValue(new Error('disconnected'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(commanderSeats.chipFor('depths').dataset.health).toBe('unknown');
  });
});
