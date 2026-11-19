// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { EntrantRow } from 'playerthree/arena';
import { agentButton, agentCard, agentText, controllerAgent, entrantAgent, occupantAgent, rosterAgent } from '../src/agent-button.ts';
import type { RosterCommander } from '../src/profile.ts';

const commander = (patch: Partial<RosterCommander> = {}): RosterCommander => ({
  id: 'deepseek', name: 'DeepSeek Surface', kind: 'agent', roles: ['surface'], isolation: { independentSessions: true }, token: 'private-token', scopes: [],
  mandate: { autonomy: 'autonomous', whenAbsent: 'hold', directive: { stance: 'defend' } }, metadata: { provider: 'DeepSeek', model: 'V3' },
  policy: { activeByRole: { surface: 4 }, versions: [] }, approvals: [], connected: true, lastSeenAt: null, seated: null, practicing: false, lastPractice: null, ...patch,
});
const row: EntrantRow = { entrantId: 'e1', kind: 'agent', label: 'DeepSeek Surface', aiPlayer: true, provider: 'DeepSeek', model: 'V3', selfReported: true, harness: 'Claude Code', harnessVerified: false, scaffoldVersion: '1.2.0', artifactHash: null, botVersion: null, botLevel: null, botOptions: null, stateResetSource: null };

describe('AgentButton', () => {
  it('renders identity, model badge and connection status without credentials', () => {
    const chip = agentButton(rosterAgent(commander()));
    expect(chip.tagName).toBe('SPAN'); expect(chip.dataset.kind).toBe('agent'); expect(chip.dataset.status).toBe('online');
    expect(chip.querySelector('.agent-button-name')?.textContent).toBe('DeepSeek Surface');
    expect(chip.querySelector('.agent-button-model')?.textContent).toBe('DeepSeek / V3');
    expect(chip.getAttribute('aria-label')).toBe('DeepSeek Surface · Live · DeepSeek / V3 (self-reported) · Connected');
    expect(chip.outerHTML).not.toContain('private-token'); expect(chip.hasAttribute('title')).toBe(false);
  });
  it('becomes a real pressed button only when it acts', () => {
    const click = vi.fn();
    const chip = agentButton({ kind: 'bot', name: 'Bot' }, { onClick: click, pressed: true, size: 'small' }) as HTMLButtonElement;
    expect(chip.tagName).toBe('BUTTON'); expect(chip.type).toBe('button'); expect(chip.getAttribute('aria-pressed')).toBe('true'); expect(chip.classList.contains('small')).toBe(true);
    chip.click(); expect(click).toHaveBeenCalledOnce();
    expect(chip.querySelector('.agent-button-status')).toBeNull();
  });
  it('gives the same commander the same identity in roster, lobby seat, observer and results', () => {
    const own = commander();
    const seat = occupantAgent({ kind: 'commander', entrantId: 'e1', ref: { id: own.id, kind: 'agent' } }, { you: 'me', members: [], roster: [own] });
    expect(seat).toEqual(rosterAgent(own));
    const result = entrantAgent(row);
    const observer = entrantAgent({ id: 'e1', label: row.label, kind: 'agent', aiPlayer: true, provider: 'DeepSeek', model: 'V3', selfReported: true, harness: { label: 'Claude Code', verified: false }, scaffoldVersion: '1.2.0' });
    expect(observer).toEqual(result);
    expect(result).toMatchObject({ name: 'DeepSeek Surface', model: 'DeepSeek / V3', notes: ['Claude Code · not verified', 'Version 1.2.0'] });
    expect(agentCard(result).textContent).toContain('Claude Code · not verified');
  });
  it('shows others only their public card and marks empty seats as Open / Closed', () => {
    const other = occupantAgent({ kind: 'commander', entrantId: 'e2' }, { you: 'me', members: [], roster: [], ready: 'absent', card: { seat: { team: 'se', role: 'surface' }, kind: 'policy', aiPlayer: true, mode: 'policy', policy: { source: 'library', version: 3 } } });
    expect(other).toMatchObject({ kind: 'policy', name: 'AI Player', detail: 'Policy v3', status: 'offline' });
    expect(occupantAgent({ kind: 'open' }, { you: 'me', members: [], roster: undefined })).toEqual({ kind: 'open', name: 'Open' });
    expect(occupantAgent({ kind: 'closed' }, { you: 'me', members: [], roster: undefined })).toEqual({ kind: 'closed', name: 'Closed' });
    expect(occupantAgent({ kind: 'bot', level: 'veteran', options: {} }, { you: 'me', members: [], roster: undefined })).toEqual({ kind: 'bot', name: 'Bot', detail: 'Veteran' });
    expect(agentText(occupantAgent({ kind: 'human', memberId: 'me' }, { you: 'me', members: [{ id: 'me', label: 'Ann', seats: [], observer: false, connected: true, ready: false, leader: true }], roster: undefined }))).toBe('You · Connected');
  });
  it('names the exact in-match controller by its bound commander', () => {
    expect(controllerAgent('agent', commander(), false)).toMatchObject({ kind: 'agent', name: 'DeepSeek Surface', status: 'offline' });
    expect(controllerAgent('agent', undefined, true)).toMatchObject({ name: 'Live commander', status: 'online' });
    expect(controllerAgent('policy', undefined, false, 2)).toEqual({ kind: 'policy', name: 'Policy', detail: 'v2' });
    expect(controllerAgent('none', undefined, false)).toEqual({ kind: 'none', name: 'Hold' });
  });
});
