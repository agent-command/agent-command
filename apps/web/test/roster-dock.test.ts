// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionInfo } from '@playerthree/connect';
import { COMMANDER_DRAG, draggedCommander, rosterDock } from '../src/roster-dock.ts';
import type { RosterCommander } from '../src/profile.ts';

function commander(id: string, roles: RosterCommander['roles']): RosterCommander {
  return { id, name: id.toUpperCase(), kind: 'agent', roles, isolation: { independentSessions: false }, token: `secret-${id}`, scopes: [],
    mandate: { autonomy: 'autonomous', whenAbsent: 'hold', directive: { stance: 'defend' } }, policy: { activeByRole: Object.fromEntries(roles.map((role) => [role, null])), versions: [] }, approvals: [],
    connected: false, lastSeenAt: null, seated: null, practicing: false, lastPractice: null };
}
const live: ConnectionInfo = { id: 'c1', commander: 'a', client: { name: 'Claude Code', kind: 'claude-code' }, roles: ['surface'], active: true, lastSeen: 1, createdAt: 1, authorizedAt: 1 };

describe('roster dock', () => {
  it('renders draggable chips with an online dot for an active connection and no credentials', () => {
    const dock = rosterDock([commander('a', ['surface']), commander('b', ['orbit'])], [live]);
    const chips = [...dock.querySelectorAll<HTMLElement>('.agent-button')];
    expect(chips.map((chip) => chip.dataset.commanderId)).toEqual(['a', 'b']);
    expect(chips.every((chip) => chip.draggable)).toBe(true);
    expect(chips.map((chip) => chip.dataset.status)).toEqual(['online', 'offline']);
    expect(dock.outerHTML).not.toContain('secret-');
    expect(dock.querySelector('[title]')).toBeNull();
  });
  it('carries only the commander id when dragged', () => {
    const dock = rosterDock([commander('a', ['surface'])], undefined);
    const data = new Map<string, string>();
    const event = new Event('dragstart') as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: 'none' } });
    dock.querySelector('.agent-button')!.dispatchEvent(event);
    expect([...data]).toEqual([[COMMANDER_DRAG, 'a']]);
    expect(draggedCommander(event)).toBe('a');
  });
  it('picks by click with the selection pressed, and dims commanders that do not fit the roles', () => {
    const pick = vi.fn();
    const dock = rosterDock([commander('a', ['surface']), commander('b', ['orbit'])], [], { selected: 'b', onPick: pick, roles: ['surface'] });
    const [a, b] = [...dock.querySelectorAll<HTMLButtonElement>('button.agent-button')];
    expect(b!.getAttribute('aria-pressed')).toBe('true'); expect(a!.getAttribute('aria-pressed')).toBe('false');
    expect(b!.classList.contains('unfit')).toBe(true); expect(a!.classList.contains('unfit')).toBe(false);
    a!.click(); expect(pick).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });
});
