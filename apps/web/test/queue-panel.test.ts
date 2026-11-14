// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntryOut, View } from '@agent-command/game/contract';
import { dropIndex, QueuePanel, queueStatus } from '../src/queue-panel.ts';

const entry = (extra: Partial<QueueEntryOut>): QueueEntryOut => ({
  id: 'q_1',
  item: 'tank',
  plane: 'surface',
  by: 'surface',
  byCtl: 'human',
  alloy: 120,
  energy: 0,
  heldAlloy: 0,
  heldEnergy: 0,
  recovery: false,
  paid: extra.status === 'building',
  next: extra.status !== 'building' && extra.status !== 'blocked' && !extra.paid && !extra.recovery,
  status: 'waiting',
  progress: 0,
  ...extra,
});
const res = { alloy: 200, energy: 100, freeAlloy: 200, freeEnergy: 100, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0, upkeepHeld: 0 };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('build queue panel', () => {
  it('shows paid progress and funding reasons without promising a waiting ETA', () => {
    expect(queueStatus(entry({ reason: 'funds', eta: 230 }))).toBe(queueStatus(entry({ reason: 'funds' })));
    expect(queueStatus(entry({ status: 'building', progress: 0.42, eta: 30 }))).toContain('42%');
    const reasons = [entry({ reason: 'funds' }), entry({ status: 'blocked', reason: 'not_held' }), entry({ status: 'blocked', reason: 'occupied' }), entry({ recovery: true, reason: 'funds' })];
    expect(new Set(reasons.map(queueStatus)).size).toBe(reasons.length);
  });

  it('names the resource a saving head lacks and tells a lane wait apart from a funding wait', () => {
    expect(queueStatus(entry({ reason: 'funds', energy: 30, heldAlloy: 120, heldEnergy: 4 }))).toBe('saving energy');
    expect(queueStatus(entry({ reason: 'funds', energy: 30, heldAlloy: 50, heldEnergy: 30 }))).toBe('saving alloy');
    expect(queueStatus(entry({ reason: 'funds', energy: 30 }))).toBe('saving alloy and energy');
    const lane = queueStatus(entry({ next: false, reason: 'lane' }));
    expect(lane).not.toMatch(/saving|funds/);
    expect(lane).toContain('lane');
  });

  it('turns a drop gap into the final index of the moved entry', () => {
    expect(dropIndex(3, 0)).toBe(0);
    expect(dropIndex(0, 4)).toBe(3);
    expect(dropIndex(2, 2)).toBe(2);
    expect(dropIndex(2, 3)).toBe(2);
  });

  it('keeps icon rows accessible and preserves cancel and keyboard reorder intents', () => {
    const calls: unknown[] = [];
    const panel = new QueuePanel({
      canAct: (role) => role === 'surface',
      canPrioritize: () => false,
      act: async (role, intents) => { calls.push({ role, intents }); return true; },
      toast: () => {},
    });
    document.body.append(panel.el);
    panel.update({ army: 'nw', rulesHash: 0, res, queue: [entry({}), entry({ id: 'q_2', item: 'trooper', next: false })], events: [] } as unknown as View);
    const row = panel.el.querySelector<HTMLLIElement>('.qp-row')!;
    expect(row.getAttribute('aria-label')).toContain('Tank');
    expect(row.querySelector('.qp-icon svg')).not.toBeNull();
    expect(panel.el.querySelector('[title]')).toBeNull();
    expect(panel.el.querySelector('details.qp-bank')!.hasAttribute('open')).toBe(false);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    const cancel = row.querySelector<HTMLButtonElement>('.qp-x')!;
    cancel.focus();
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    cancel.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(cancel);
    row.querySelector<HTMLButtonElement>('.qp-x')!.click();
    expect(calls).toEqual([
      { role: 'surface', intents: [{ kind: 'queue_move', entry: 'q_1', index: 1 }] },
      { role: 'surface', intents: [{ kind: 'queue_cancel', entry: 'q_1' }] },
    ]);
    panel.dispose();
  });

  it('groups lanes but sends global wire indices and the entry output role', () => {
    const calls: unknown[] = [];
    const panel = new QueuePanel({
      canAct: () => true,
      canPrioritize: () => false,
      act: async (role, intents) => { calls.push({ role, intents }); return true; },
      toast: () => {},
    });
    document.body.append(panel.el);
    panel.update({
      army: 'nw', rulesHash: 0, res, events: [], queue: [
        entry({ id: 'q_1' }),
        entry({ id: 'q_2', item: 'solar', plane: 'orbit', by: 'orbit' }),
        entry({ id: 'q_3', item: 'trooper', next: false }),
      ],
    } as unknown as View);
    const lists = [...panel.el.querySelectorAll('.qp-lanes > section > ol.qp-list')];
    expect(lists).toHaveLength(4);
    expect(lists.map(list => [...list.querySelectorAll<HTMLElement>('.qp-row')].map(row => row.dataset.id)))
      .toEqual([[], ['q_1', 'q_3'], [], ['q_2']]);
    panel.el.querySelector<HTMLElement>('[data-id="q_1"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    panel.el.querySelector<HTMLButtonElement>('[data-id="q_2"] .qp-x')!.click();
    expect(calls).toEqual([
      { role: 'surface', intents: [{ kind: 'queue_move', entry: 'q_1', index: 2 }] },
      { role: 'orbit', intents: [{ kind: 'queue_cancel', entry: 'q_2' }] },
    ]);
    panel.dispose();
  });

  it('does not let a Surface owner reorder or cancel another human Orbit lane', () => {
    const calls: unknown[] = [];
    const panel = new QueuePanel({
      canAct: role => role === 'surface',
      canPrioritize: () => false,
      act: async (role, intents) => { calls.push({ role, intents }); return true; },
      toast: () => {},
    });
    document.body.append(panel.el);
    panel.update({
      army: 'nw', rulesHash: 0, res, events: [], queue: [
        entry({}),
        entry({ id: 'q_2', item: 'solar', plane: 'orbit', by: 'orbit' }),
        entry({ id: 'q_3', item: 'lancer', plane: 'orbit', by: 'orbit', next: false }),
      ],
    } as unknown as View);
    const orbit = panel.el.querySelector<HTMLElement>('[data-id="q_2"]')!;
    orbit.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    orbit.querySelector<HTMLButtonElement>('.qp-x')?.click();
    expect(orbit.draggable).toBe(false);
    expect(calls).toEqual([]);
    panel.dispose();
  });

  it('confirms one-shot priority in place and keeps owner authority, including requested recovery', () => {
    const act = vi.fn(async () => true);
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const panel = new QueuePanel({
      canAct: () => true,
      canPrioritize: role => role === 'depths',
      act,
      toast: () => {},
    });
    document.body.append(panel.el);
    const view = {
      army: 'nw', rulesHash: 0, res, events: [], queue: [
        entry({ id: 'q_1', item: 'digger', plane: 'depths', by: 'depths', recovery: true }),
        entry({ id: 'q_2', item: 'solar', plane: 'orbit', by: 'orbit' }),
        entry({ id: 'q_3', item: 'sapper', plane: 'depths', by: 'depths', paid: true, status: 'blocked', reason: 'producer', next: false }),
      ],
    } as unknown as View;
    panel.update(view);
    const row = panel.el.querySelector<HTMLElement>('[data-id="q_1"]')!;
    const priority = row.querySelector<HTMLButtonElement>('.qp-priority')!;
    const yes = row.querySelector<HTMLButtonElement>('.qp-confirm')!;
    const no = row.querySelector<HTMLButtonElement>('.qp-keep')!;
    expect(priority.hidden).toBe(false);
    expect(yes.hidden && no.hidden).toBe(true);
    // Step one arms the inline pair; Cancel and Esc back out without an order.
    priority.click();
    expect(yes.hidden || no.hidden).toBe(false);
    expect(priority.hidden).toBe(true);
    expect(document.activeElement).toBe(yes);
    no.click();
    expect(yes.hidden && no.hidden).toBe(true);
    expect(priority.hidden).toBe(false);
    priority.click();
    yes.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(yes.hidden).toBe(true);
    // Arming survives view updates until the entry stops being fundable.
    priority.click();
    panel.update(view);
    expect(yes.hidden).toBe(false);
    expect(act).not.toHaveBeenCalled();
    yes.click();
    expect(act).toHaveBeenCalledExactlyOnceWith('depths', [{ kind: 'queue_priority', entry: 'q_1' }]);
    expect(yes.hidden).toBe(true);
    priority.click();
    panel.update({ ...view, queue: [{ ...view.queue[0]!, status: 'building', paid: true }, ...view.queue.slice(1)] } as View);
    expect(yes.hidden && priority.hidden).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    for (const id of ['q_2', 'q_3']) {
      const button = panel.el.querySelector<HTMLButtonElement>(`[data-id="${id}"] .qp-priority`);
      expect(button === null || button.hidden || button.disabled).toBe(true);
    }
    panel.dispose();
  });

  it('touches nothing on an identical update and only the changed values otherwise', () => {
    const panel = new QueuePanel({ canAct: () => true, canPrioritize: () => false, act: async () => true, toast: () => {} });
    document.body.append(panel.el);
    const view = (heldAlloy: number, freeAlloy: number) => ({
      army: 'nw', rulesHash: 0, events: [], res: { ...res, freeAlloy }, queue: [entry({ id: 'q_1', alloy: 80, heldAlloy })],
    } as unknown as View);
    panel.update(view(20, 200));
    const row = panel.el.querySelector<HTMLElement>('[data-id="q_1"]')!;
    const [alloyFill] = row.querySelectorAll<HTMLElement>('.qp-fund-fill');
    const cells = [...panel.el.querySelectorAll<HTMLElement>('.qp-ledger td')];
    const marks = () => [alloyFill!.style.transform, row.style.getPropertyValue('--accent'), row.dataset.tip, ...cells.map(cell => cell.dataset.tip)];
    alloyFill!.style.transform = 'marker';
    row.style.setProperty('--accent', 'marker');
    row.dataset.tip = 'marker';
    for (const cell of cells) if (cell.dataset.tip !== undefined) cell.dataset.tip = 'marker';
    const before = marks();
    panel.update(view(20, 200));
    expect(marks()).toEqual(before);
    panel.update(view(40, 150.5));
    expect(alloyFill!.style.transform).toBe('scaleX(0.5)');
    expect(row.style.getPropertyValue('--accent')).toBe('marker');
    expect(row.dataset.tip).not.toBe('marker');
    const free = cells.filter(cell => cell.dataset.tip !== undefined && cell.dataset.tip !== 'marker');
    expect(free.map(cell => cell.dataset.tip)).toEqual([(150.5).toLocaleString(undefined, { maximumFractionDigits: 1 })]);
    expect(panel.el.querySelector('[title]')).toBeNull();
    panel.dispose();
  });

  it('uses the authoritative eligible head and displays held resources separately from paid progress', () => {
    const panel = new QueuePanel({
      canAct: role => role === 'surface',
      canPrioritize: () => false,
      act: async () => true,
      toast: () => {},
    });
    document.body.append(panel.el);
    const waiting = entry({ id: 'q_2', next: true, alloy: 80, energy: 20, heldAlloy: 20, heldEnergy: 10, reason: 'funds' });
    const update = (head: QueueEntryOut) => panel.update({
      army: 'nw', rulesHash: 0, res, events: [], queue: [
        entry({ id: 'q_1', status: 'blocked', reason: 'occupied', next: false }),
        head,
        entry({ id: 'q_3', item: 'digger', plane: 'depths', by: 'depths', recovery: true }),
      ],
    } as unknown as View);
    update(waiting);
    const first = panel.el.querySelector<HTMLElement>('[data-id="q_1"]')!;
    const head = panel.el.querySelector<HTMLElement>('[data-id="q_2"]')!;
    const recovery = panel.el.querySelector<HTMLElement>('[data-id="q_3"]')!;
    expect(first.classList.contains('next')).toBe(false);
    expect(head.classList.contains('next')).toBe(true);
    expect(head.classList.contains('funding')).toBe(true);
    expect([...head.querySelectorAll<HTMLElement>('.qp-fund-fill')].map(fill => fill.style.transform)).toEqual(['scaleX(0.25)', 'scaleX(0.5)']);
    expect(head.querySelector<HTMLElement>('.qp-bar')!.hidden).toBe(true);
    expect(recovery.classList.contains('recovery')).toBe(true);
    expect(recovery.classList.contains('next')).toBe(false);
    expect(panel.el.querySelector('#queue-lane-depths .qp-access')!.classList.contains('readonly')).toBe(true);
    update({ ...waiting, heldAlloy: 80, heldEnergy: 20 });
    expect(panel.el.querySelector('[data-id="q_2"]')).toBe(head);
    expect(head.classList.contains('backed')).toBe(true);
    panel.dispose();
  });
});
