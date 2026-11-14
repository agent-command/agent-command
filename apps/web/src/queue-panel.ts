/**
 * Shared-bank production in four output-plane lanes, pinned above the field map. Only a role credential can
 * change its lane; order never sets a team's global funding priority. Rows are keyed by entry id and kept across
 * view updates (focus survives; each row is built once and updated in place), and nothing is rebuilt while dragging.
 *
 * Motion (motion.ts; reduced motion: opacity only): a new entry inks in from a pencil outline; a finished one is stamped
 * done and a cancelled one struck through before its slip folds away; reorders slide rows to their new places (FLIP);
 * progress bars ease between updates.
 *
 * Keys on a focused row (not its cancel button): ↑/↓ Home/End move focus ·
 * Alt+↑/↓ move the entry up/down · Alt+Home/End to the top/bottom · Delete/Backspace cancel · Esc backs out of an
 * armed Fund first (its inline confirm / cancel pair), else back to the map.
 */
import { PLANES, UPGRADES, isUnitKind, isUpgrade, type Plane, type QueueEntryOut, type Rules, type View } from '@agent-command/game/contract';
import type { Intent } from './controls.ts';
import { PLANE_ACCENT, h } from './dom.ts';
import { EASE_OUT, Motion, measureTops, reducedMotion } from './motion.ts';
import { KIND_LABEL, PLANE_NAME, QUEUE_REASON_TEXT, seatName } from './text.ts';
import { icon } from './icons.ts';
import { tip } from './tooltip.ts';
import { ledgerNumber } from './topbar.ts';

export interface QueueHost {
  act(role: Plane, intents: Intent[]): Promise<boolean>;
  /** Whether the connection currently holds an acting credential for this output role. */
  canAct(role: Plane): boolean;
  /** Explicit owner capability, not merely an acting role credential. */
  canPrioritize(role: Plane): boolean;
  toast(text: string, kind?: 'err' | 'ok'): void;
}

/** No queue-wide ETA: only observed construction progress, recovery and blocking state. */
export function queueStatus(e: QueueEntryOut): string {
  if (e.status === 'building') return `${Math.round(e.progress * 100)}% · paid`;
  const status = e.reason ? queueReasonText(e) : e.status;
  return `${e.recovery ? 'Worker recovery · ' : ''}${status}${e.paid ? ' · paid' : ''}`;
}

/**
 * A saving head names the resource it is still short of: a plain "needs funds" misleads while the bank shows a
 * surplus of the other one.
 */
function queueReasonText(e: QueueEntryOut): string {
  if (e.reason !== 'funds') return e.reason ? QUEUE_REASON_TEXT[e.reason] : '';
  const alloy = e.heldAlloy < e.alloy, energy = e.heldEnergy < e.energy;
  if (!alloy && !energy) return 'backed, starts next';
  return `${QUEUE_REASON_TEXT.funds} ${alloy && energy ? 'alloy and energy' : alloy ? 'alloy' : 'energy'}`;
}

/** An entry's name: the upgrade, a segment rebuild, or the kind. */
export function queueLabel(e: Pick<QueueEntryOut, 'item' | 'plane'>): string {
  return isUpgrade(e.item) ? UPGRADES[e.item].label : e.item === 'rebuild' ? `${PLANE_NAME[e.plane]} rebuild` : KIND_LABEL[e.item];
}

/** The index an entry at `from` ends at when dropped into gap `gap` (0 = above the first row, n = below the last). */
export function dropIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/** Whether the entries both lists hold come in a different order (`had`: ids of `prev`, `has`: ids of `next`). */
export function reordered(prev: readonly QueueEntryOut[], next: readonly QueueEntryOut[], had: ReadonlySet<string> | ReadonlyMap<string, unknown>, has: ReadonlySet<string>): boolean {
  let j = 0;
  for (const e of prev) {
    if (!has.has(e.id)) continue;
    while (j < next.length && !had.has(next[j]!.id)) j++;
    if (next[j]?.id !== e.id) return true;
    j++;
  }
  return false;
}

const INK_MS = 240;
const SLIDE_MS = 220;
const MARK_MS = 160;
/** A leaving slip: its mark lands, then it folds away. */
const LEAVE_MS = 420;
const FADE_MS = 160;
const SHORT_REASON: Record<NonNullable<QueueEntryOut['reason']>, string> = {
  funds: 'Saving', producer: 'Busy', segment_destroyed: 'Rebuild', pop_cap: 'Pop cap',
  structure_cap: 'Build cap', occupied: 'Occupied', blocked: 'Blocked', not_held: 'Island lost',
  no_builder: 'Builder', site_unseen: 'Reveal', enemy_near: 'Enemy', lane: 'Queued',
};

/** Exact amounts in tips, built once (`toLocaleString` with options builds a formatter per call). */
const EXACT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const PRIORITY_TIP = 'Fund first · One-time reallocation from only your own lanes. Other work may wait longer; bounded recovery allocation is overridden for this action. Other owners, upkeep and paid work are unaffected.';
const CONFIRM_TIP = 'Moves this eligible commitment to the front of its plane lane and reallocates protected funds from only your owned lanes. Those commitments may wait longer. Bounded recovery allocation is overridden for this funding action. Other owners’ funds, upkeep and paid work are unaffected. No ongoing priority or completion time.';

/** Keep live numeric updates from replacing text nodes when their displayed value has not changed. */
function setText(el: HTMLElement, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

/** tip() only when the text changed: it re-renders an open tooltip. */
function setTip(el: HTMLElement, text: string): void {
  if (el.dataset.tip !== text) tip(el, text);
}

/** A waiting, unpaid entry only short of funds or its lane turn: what a one-shot `queue_priority` may fund. */
function fundable(e: QueueEntryOut): boolean {
  return e.status === 'waiting' && !e.paid && (e.reason === undefined || e.reason === 'funds' || e.reason === 'lane');
}

/** Every entry field a row displays: views carry fresh objects, so fields are compared, never references. */
function sameEntry(a: QueueEntryOut, b: QueueEntryOut): boolean {
  return a.item === b.item && a.plane === b.plane && a.by === b.by && a.byCtl === b.byCtl && a.alloy === b.alloy && a.energy === b.energy
    && a.heldAlloy === b.heldAlloy && a.heldEnergy === b.heldEnergy && a.recovery === b.recovery && a.paid === b.paid && a.next === b.next
    && a.status === b.status && a.progress === b.progress && a.reason === b.reason && a.producer === b.producer;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** One slip, built once. Everything after `keep` is what was last written: updates touch only changes. */
interface Row {
  id: string;
  el: HTMLLIElement;
  icon: HTMLElement;
  name: HTMLElement;
  alloy: HTMLElement;
  energy: HTMLElement;
  alloyFill: HTMLElement;
  energyFill: HTMLElement;
  status: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  x: HTMLButtonElement;
  priority: HTMLButtonElement;
  /** The inline second step of Fund first (the commanders screen's confirm/cancel pair), shown while armed. */
  confirm: HTMLButtonElement;
  keep: HTMLButtonElement;
  last: QueueEntryOut | undefined;
  /** Lane index, editability, Fund first eligibility and armed state of the last render. */
  at: number;
  editable: boolean;
  prioritizable: boolean;
  confirming: boolean;
  alloyShare: number;
  energyShare: number;
  heldAlloy: string;
  heldEnergy: string;
  state: string;
  fillAt: string;
  label: string;
  title: string;
}

/** A bank ledger cell and the value it shows. */
interface Cell { key: keyof View['res']; el: HTMLElement; value: number; exact: string }

export class QueuePanel {
  readonly el: HTMLElement;
  private readonly count: HTMLElement;
  private readonly list: HTMLElement;
  private readonly lanes = new Map<Plane, { list: HTMLOListElement; label: HTMLElement; count: HTMLElement; access: HTMLElement; n: number; editable: boolean; shared: boolean }>();
  private readonly bankSummary = h('summary', { class: 'qp-bank-summary' });
  private readonly freeAlloy = h('b', { class: 'num' });
  private readonly freeEnergy = h('b', { class: 'num' });
  private queueRules: Rules['queue'] | undefined;
  /** The queue rules the recovery line was written for (null: not written yet). */
  private recoveryFor: Rules['queue'] | undefined | null = null;
  private shownFreeAlloy = NaN;
  private shownFreeEnergy = NaN;
  private shownCount = -1;
  private shownMax = -1;
  private readonly resources = h('div', { class: 'qp-resources' });
  private readonly recovery = h('div', { class: 'qp-foot' });
  private readonly resourceCells: Cell[] = [];
  private readonly host: QueueHost;
  private readonly rows = new Map<string, Row>();
  /** Rows of entries gone from the queue, still playing their exit (not focusable, ignored by keys and drops). */
  private readonly leaving = new Set<Element>();
  private readonly motion = new Motion();
  private entries: QueueEntryOut[] = [];
  /** The previous update's `entries`, refilled as the next one (the two lists alternate). */
  private spare: QueueEntryOut[] = [];
  /** Per-update scratch, reused. */
  private readonly ids = new Set<string>();
  private readonly gone: Row[] = [];
  private readonly entered: HTMLLIElement[] = [];
  /** Wire indices stay global even though the display and priority are lane-local. */
  private wireEntries: QueueEntryOut[] = [];
  /** Entry whose Fund first awaits its inline confirmation. */
  private confirming: string | undefined;
  /** Entry being dragged; view updates wait in `pending` until the drag ends. */
  private dragId: string | undefined;
  private pending: View | undefined;
  /** Team of the last view: the first view and a switch to the other team's view show the queue without motion. */
  private team: string | undefined;
  /** The list's row gap (CSS), read once with the first measurement that needs it. */
  private gap: number | undefined;

  constructor(host: QueueHost) {
    this.host = host;
    this.count = h('span', { class: 'qp-count num' });
    this.list = h('div', { class: 'qp-lanes' });
    for (const plane of PLANES) {
      const count = h('span', { class: 'qp-lane-count num' });
      const access = h('span', { class: 'qp-access' });
      const label = h('h3', { class: 'qp-lane-label', id: `queue-lane-${plane}` },
        icon(plane, 16), h('span', { class: 'qp-plane-name' }, PLANE_NAME[plane]), count, access);
      const list = h('ol', {
        class: 'qp-list',
        'aria-labelledby': `queue-lane-${plane}`,
        ondragover: (e: Event) => this.dragOver(e as DragEvent, plane),
        ondragleave: (e: Event) => {
          if (!list.contains((e as DragEvent).relatedTarget as Node | null)) this.clearMarks();
        },
        ondrop: (e: Event) => this.drop(e as DragEvent, plane),
      });
      this.lanes.set(plane, { list, label, count, access, n: -1, editable: false, shared: false });
      this.list.append(h('section', { class: 'qp-lane', style: `--accent:${PLANE_ACCENT[plane]}` }, label, list));
    }
    const help = 'Shared bank · each plane funds its next eligible commitment. Drag or Alt+↑↓ changes only that lane; paid work is unaffected by reordering. Delete cancels. Other owners’ lanes are read-only.';
    this.bankSummary.append(h('span', { class: 'qp-bank-label' }, 'Free'),
      h('span', { class: 'qp-bank-value c-alloy' }, icon('alloy', 13), this.freeAlloy),
      h('span', { class: 'qp-bank-value c-energy' }, icon('energy', 13), this.freeEnergy),
      h('span', { class: 'qp-bank-more' }, 'Bank details'));
    const ledger = h('table', { class: 'qp-ledger', 'aria-label': 'Shared bank accounting' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Shared bank'),
        h('th', { scope: 'col', class: 'c-alloy' }, 'Alloy'), h('th', { scope: 'col', class: 'c-energy' }, 'Energy'))));
    const body = h('tbody');
    for (const [label, alloy, energy] of [
      ['Bank', 'alloy', 'energy'], ['Free', 'freeAlloy', 'freeEnergy'],
      ['Earmarked', 'heldAlloy', 'heldEnergy'], ['Recovery', 'recoveryAlloy', 'recoveryEnergy'],
      ['Upkeep', undefined, 'upkeepHeld'],
    ] as const) {
      const row = h('tr', {}, h('th', { scope: 'row' }, label));
      for (const key of [alloy, energy]) {
        const cell = h('td', {}, key ? '' : '—');
        if (key) this.resourceCells.push({ key, el: cell, value: NaN, exact: '' });
        row.append(cell);
      }
      body.append(row);
    }
    ledger.append(body);
    this.resources.append(ledger, this.recovery);
    this.el = h(
      'section',
      { class: 'queue-panel', 'aria-label': 'Team production lanes' },
      h('div', { class: 'qp-head' }, h('span', { class: 'stamp', 'data-tip': help, tabindex: 0, 'aria-label': help }, icon('queue', 16), ' Production'), this.count),
      h('details', { class: 'qp-bank' }, this.bankSummary, this.resources),
      this.list,
    );
  }

  update(v: View): void {
    if (this.dragId) {
      this.pending = v;
      return;
    }
    this.pending = undefined;
    this.wireEntries = v.queue;
    if (v.match) this.queueRules = v.match.rules.queue;
    const prev = this.entries;
    const entries = this.spare;
    entries.length = 0;
    for (const plane of PLANES) for (const e of v.queue) if (e.plane === plane) entries.push(e);
    const teamMax = this.queueRules?.teamMax ?? 0;
    if (this.shownCount !== entries.length || this.shownMax !== teamMax) {
      this.shownCount = entries.length;
      this.shownMax = teamMax;
      this.count.textContent = teamMax ? `${entries.length} / ${teamMax}` : String(entries.length);
    }
    this.renderBank(v.res);
    if (this.recoveryFor !== this.queueRules) {
      this.recoveryFor = this.queueRules;
      this.recovery.textContent = this.queueRules
        ? `Recovery ≤${Math.round(this.queueRules.recoveryFraction * 100)}% while normal work waits · worker target ${this.queueRules.recoveryWorkers}.`
        : 'Awaiting match recovery rules.';
    }
    const animate = this.team === v.army;
    if (!animate) this.dispose();
    this.team = v.army;
    const reduced = animate && reducedMotion();
    const slide = animate && !reduced;

    const active = document.activeElement;
    const focusedRow = active instanceof HTMLElement ? active.closest<HTMLLIElement>('.qp-row') : null;
    const focusedId = focusedRow && this.list.contains(focusedRow) ? focusedRow.dataset.id : undefined;
    const focusedAt = focusedId ? prev.findIndex((x) => x.id === focusedId) : -1;
    this.entries = entries;
    this.spare = prev;

    const ids = this.ids;
    ids.clear();
    for (const e of entries) ids.add(e.id);
    if (this.confirming && !ids.has(this.confirming)) this.confirming = undefined;
    const gone = this.gone;
    gone.length = 0;
    for (const [id, row] of this.rows) if (!ids.has(id)) gone.push(row);
    const moved = slide && reordered(prev, entries, this.rows, ids);

    // read phase, before any write: where the rows are drawn now, and the height of each leaving one
    const before = moved ? measureTops([...this.rows.values()].map((row) => row.el)) : undefined;
    const heights = slide && gone.length ? gone.map((r) => r.el.offsetHeight) : undefined;
    if (heights) this.gap ??= parseFloat(getComputedStyle(this.lanes.values().next().value!.list).rowGap) || 0;

    if (gone.length) {
      const cancelled = new Set(v.events.filter((ev) => ev.kind === 'queue_cancelled').map((ev) => ev.entry));
      gone.forEach((row, k) => {
        this.rows.delete(row.id);
        if (animate) this.leave(row.el, cancelled.has(row.id) ? 'cancelled' : 'done', reduced, heights?.[k] ?? 0);
        else row.el.remove();
      });
      gone.length = 0;
    }
    const entered = this.entered;
    entered.length = 0;
    let shared = true;
    for (const plane of PLANES) if (!this.host.canAct(plane)) shared = false;
    // Move only within stable lane lists; keep existing nodes (including focused rows and leaving slips).
    let k = 0;
    for (const plane of PLANES) {
      const lane = this.lanes.get(plane)!;
      const editable = this.host.canAct(plane);
      const start = k;
      while (k < entries.length && entries[k]!.plane === plane) k++;
      const n = k - start;
      if (lane.n !== n || lane.editable !== editable || lane.shared !== shared) {
        lane.n = n;
        lane.editable = editable;
        lane.shared = shared;
        lane.count.textContent = n ? String(n) : '—';
        lane.access.hidden = shared;
        lane.access.textContent = editable ? 'Control' : 'View only';
        lane.access.classList.toggle('readonly', !editable);
        lane.label.setAttribute('aria-label', `${PLANE_NAME[plane]}: ${n} queued, ${editable ? 'editable with your role credential' : 'read-only'}`);
      }
      let at: Element | null = lane.list.firstElementChild;
      for (let i = 0; i < n; i++) {
        const e = entries[start + i]!;
        let row = this.rows.get(e.id);
        if (!row) {
          row = this.makeRow(e.id);
          this.rows.set(e.id, row);
          if (animate) entered.push(row.el);
        }
        while (at && this.leaving.has(at)) at = at.nextElementSibling;
        if (at === row.el) at = row.el.nextElementSibling;
        else lane.list.insertBefore(row.el, at);
        this.renderRow(row, e, i, editable);
      }
    }

    // second read, then the writes: rows slide to their new places; new entries ink in (and open their space unless rows slide)
    if (before) this.motion.flip(before, SLIDE_MS);
    const grow = slide && !before && entered.length ? entered.map((el) => el.offsetHeight) : undefined;
    if (grow) this.gap ??= parseFloat(getComputedStyle(this.lanes.values().next().value!.list).rowGap) || 0;
    for (let i = 0; i < entered.length; i++) this.enter(entered[i]!, reduced, grow?.[i]);
    entered.length = 0;

    // keep keyboard focus on the same entry (moving a node can drop focus), or on its neighbour once it is gone
    if (focusedId) {
      const row = this.rows.get(focusedId) ?? (entries.length ? this.rows.get(entries[Math.min(Math.max(0, focusedAt), entries.length - 1)]!.id) : undefined);
      const target = row?.el === focusedRow && active instanceof HTMLElement ? active : row?.el;
      if (target && document.activeElement !== target) target.focus({ preventScroll: true });
    }
  }

  /** The free bank and ledger cells: formatting and tips only for values that moved. */
  private renderBank(r: View['res']): void {
    if (this.shownFreeAlloy !== r.freeAlloy || this.shownFreeEnergy !== r.freeEnergy) {
      this.shownFreeAlloy = r.freeAlloy;
      this.shownFreeEnergy = r.freeEnergy;
      const freeAlloy = ledgerNumber(r.freeAlloy), freeEnergy = ledgerNumber(r.freeEnergy);
      setText(this.freeAlloy, freeAlloy);
      setText(this.freeEnergy, freeEnergy);
      this.bankSummary.setAttribute('aria-label', `Free shared resources: ${freeAlloy} alloy, ${freeEnergy} energy. Expand bank details for earmarks and reserves.`);
    }
    for (const cell of this.resourceCells) {
      const value = r[cell.key] as number;
      if (cell.value === value) continue;
      cell.value = value;
      setText(cell.el, ledgerNumber(value));
      const exact = EXACT.format(value);
      if (cell.exact === exact) continue;
      cell.exact = exact;
      tip(cell.el, exact);
      cell.el.setAttribute('aria-label', exact);
    }
  }

  /** Stop every animation and drop the rows still leaving. */
  dispose(): void {
    this.motion.dispose();
    for (const el of this.leaving) el.remove();
    this.leaving.clear();
  }

  /** A new slip: slides in from the right as a pencil outline, then the wash comes in; `height` also opens its space. */
  private enter(el: HTMLLIElement, reduced: boolean, height: number | undefined): void {
    if (reduced) {
      this.motion.play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: EASE_OUT });
      return;
    }
    const ink: Keyframe[] = [
      { opacity: 0, transform: 'translateX(10px)', filter: 'grayscale(1)' },
      { opacity: 1, transform: 'none', filter: 'none' },
    ];
    if (height !== undefined) {
      // start folded under the slip below (negative margin), then open its space
      ink[0]!.marginBottom = `${-(height + (this.gap ?? 0))}px`;
      ink[1]!.marginBottom = '0px';
    }
    this.motion.play(el, ink, { duration: INK_MS, easing: EASE_OUT });
    this.motion.play(el, [{ opacity: 1 }, { opacity: 0 }], { pseudoElement: '::after', duration: INK_MS, easing: 'ease-in' });
  }

  /** An entry left the queue: stamp it done or strike it out, then fold the slip away and drop it. */
  private leave(el: HTMLLIElement, kind: 'done' | 'cancelled', reduced: boolean, height: number): void {
    this.leaving.add(el);
    el.classList.remove('drop-before', 'dragging');
    el.classList.add('leaving', kind);
    el.removeAttribute('tabindex');
    el.draggable = false;
    el.inert = true;
    el.setAttribute('aria-hidden', 'true');
    const done = () => {
      el.remove();
      this.leaving.delete(el);
    };
    if (reduced) {
      this.motion.play(el, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, delay: MARK_MS, fill: 'forwards' }, done);
      return;
    }
    const mark: Keyframe[] = kind === 'done' ? [{ opacity: 0, transform: 'scale(1.7)' }, { opacity: 1, transform: 'scale(1)' }] : [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }];
    this.motion.play(el, mark, { pseudoElement: '::before', duration: MARK_MS, easing: EASE_OUT, fill: 'both' });
    const fold = `${-(height + (this.gap ?? 0))}px`;
    this.motion.play(
      el,
      [
        { opacity: 1, marginBottom: '0px' },
        { opacity: 1, marginBottom: '0px', offset: 0.45, easing: EASE_OUT },
        { opacity: 0, marginBottom: fold },
      ],
      { duration: LEAVE_MS, fill: 'forwards' },
      done,
    );
  }

  private makeRow(id: string): Row {
    const glyph = h('span', { class: 'qp-icon', 'aria-hidden': 'true' });
    const name = h('b', { class: 'qp-item-name' });
    const alloy = h('span', { class: 'c-alloy' });
    const energy = h('span', { class: 'c-energy' });
    const alloyFill = h('span', { class: 'qp-fund-fill' });
    const energyFill = h('span', { class: 'qp-fund-fill' });
    const status = h('span', { class: 'qp-status' });
    const fill = h('span', { class: 'qp-fill' });
    const bar = h('span', { class: 'qp-bar', hidden: true }, fill);
    const x = h(
      'button',
      {
        class: 'qp-x',
        tabindex: -1,
        onmousedown: (ev: Event) => ev.preventDefault(),
        onclick: (ev: Event) => {
          ev.stopPropagation();
          this.cancel(id);
        },
      },
      icon('cancel', 14),
    );
    const priority = h('button', {
      class: 'qp-priority',
      type: 'button',
      hidden: true,
      onclick: (event: Event) => { event.stopPropagation(); this.prioritize(id); },
    }, icon('mount_forward', 14));
    tip(priority, PRIORITY_TIP);
    const confirm = tip(h('button', {
      class: 'btn small danger qp-confirm',
      type: 'button',
      hidden: true,
      onclick: (event: Event) => { event.stopPropagation(); this.confirmPriority(id); },
    }, 'Fund first'), CONFIRM_TIP);
    const keep = h('button', {
      class: 'btn small ghost qp-keep',
      type: 'button',
      hidden: true,
      onclick: (event: Event) => { event.stopPropagation(); this.disarm(id); },
    }, 'Cancel');
    const el = h(
      'li',
      {
        class: 'qp-row',
        tabindex: 0,
        draggable: 'true',
        'data-id': id,
        onkeydown: (e: Event) => this.key(e as KeyboardEvent, id),
        ondragstart: (e: Event) => {
          const d = e as DragEvent;
          const entry = this.entries.find((e) => e.id === id);
          if (!entry || !this.host.canAct(entry.plane)) { d.preventDefault(); return; }
          this.dragId = id;
          d.dataTransfer?.setData('text/plain', id);
          if (d.dataTransfer) d.dataTransfer.effectAllowed = 'move';
          el.classList.add('dragging');
        },
        ondragend: () => {
          el.classList.remove('dragging');
          this.clearMarks();
          this.dragId = undefined;
          if (this.pending) this.update(this.pending);
        },
      },
      glyph,
      h('span', { class: 'qp-main' },
        h('span', { class: 'qp-name' }, name),
        h('span', { class: 'qp-meta' },
          h('span', { class: 'qp-cost c-alloy' }, h('span', { class: 'hud-cost' }, icon('alloy', 12), alloy), h('span', { class: 'qp-fund-track', 'aria-hidden': 'true' }, alloyFill)),
          h('span', { class: 'qp-cost c-energy' }, h('span', { class: 'hud-cost' }, icon('energy', 12), energy), h('span', { class: 'qp-fund-track', 'aria-hidden': 'true' }, energyFill)),
          status),
        bar),
      h('span', { class: 'qp-actions' }, priority, x, confirm, keep),
    );
    return {
      id, el, icon: glyph, name, alloy, energy, alloyFill, energyFill, status, bar, fill, x, priority, confirm, keep,
      last: undefined, at: -1, editable: false, prioritizable: false, confirming: false,
      alloyShare: NaN, energyShare: NaN, heldAlloy: '', heldEnergy: '', state: '', fillAt: '', label: '', title: '',
    };
  }

  private renderRow(row: Row, e: QueueEntryOut, i: number, editable: boolean): void {
    const prioritizable = editable && this.host.canPrioritize(e.plane) && fundable(e);
    if (this.confirming === e.id && !prioritizable) this.confirming = undefined;
    const confirming = this.confirming === e.id;
    const last = row.last;
    if (last && row.at === i && row.editable === editable && row.prioritizable === prioritizable && row.confirming === confirming && sameEntry(last, e)) return;
    const look = !last || row.editable !== editable || last.item !== e.item || last.plane !== e.plane || last.by !== e.by
      || last.byCtl !== e.byCtl || last.alloy !== e.alloy || last.energy !== e.energy;
    const funds = !last || look || last.paid !== e.paid || last.heldAlloy !== e.heldAlloy || last.heldEnergy !== e.heldEnergy;
    const detail = !last || funds || last.reason !== e.reason || last.producer !== e.producer;
    row.last = e;
    row.at = i;
    row.editable = editable;
    const label = queueLabel(e);
    const status = queueStatus(e);
    const owner = seatName(e.by, e.byCtl);
    const funding = !e.paid && (e.next || e.recovery || e.heldAlloy > 0 || e.heldEnergy > 0);
    const backed = funding && e.heldAlloy >= e.alloy && e.heldEnergy >= e.energy;
    row.el.classList.toggle('funding', funding);
    row.el.classList.toggle('next', e.next);
    row.el.classList.toggle('recovery', e.recovery);
    row.el.classList.toggle('backed', backed);
    row.el.classList.toggle('paid', e.paid);
    if (look) {
      row.el.style.setProperty('--accent', PLANE_ACCENT[e.plane]);
      row.icon.style.setProperty('--accent', PLANE_ACCENT[e.plane]);
      row.icon.replaceChildren(icon(e.item));
      row.name.textContent = label;
      const alloyCost = ledgerNumber(e.alloy), energyCost = ledgerNumber(e.energy);
      setText(row.alloy, alloyCost);
      setText(row.energy, energyCost);
      row.alloy.style.inlineSize = `${alloyCost.length}ch`;
      row.energy.style.inlineSize = `${energyCost.length}ch`;
      row.el.draggable = editable;
      row.el.classList.toggle('readonly', !editable);
      row.x.disabled = !editable;
      setTip(row.x, editable ? `Cancel ${label} · requested by ${owner}` : `${PLANE_NAME[e.plane]} lane is read-only`);
      row.x.setAttribute('aria-label', `Cancel ${label}`);
      row.priority.setAttribute('aria-label', `Fund ${label} first using only your lanes’ earmarks`);
      row.confirm.setAttribute('aria-label', `Confirm: fund ${label} first`);
      row.keep.setAttribute('aria-label', `Keep ${label} in place`);
    }
    if (row.prioritizable !== prioritizable || row.confirming !== confirming) {
      row.prioritizable = prioritizable;
      row.confirming = confirming;
      row.priority.hidden = !prioritizable || confirming;
      row.x.hidden = confirming;
      row.confirm.hidden = !confirming;
      row.keep.hidden = !confirming;
    }
    if (funds) {
      const alloyShare = e.alloy ? clamp01(e.heldAlloy / e.alloy) : 1;
      const energyShare = e.energy ? clamp01(e.heldEnergy / e.energy) : 1;
      if (row.alloyShare !== alloyShare) {
        row.alloyShare = alloyShare;
        row.alloyFill.style.transform = `scaleX(${alloyShare})`;
      }
      if (row.energyShare !== energyShare) {
        row.energyShare = energyShare;
        row.energyFill.style.transform = `scaleX(${energyShare})`;
      }
      row.heldAlloy = e.paid ? '' : EXACT.format(e.heldAlloy);
      row.heldEnergy = e.paid ? '' : EXACT.format(e.heldEnergy);
      setTip(row.alloy, e.paid ? `${e.alloy} alloy paid` : `${row.heldAlloy} of ${e.alloy} alloy held`);
      setTip(row.energy, e.paid ? `${e.energy} energy paid` : `${row.heldEnergy} of ${e.energy} energy held`);
    }
    const building = e.status === 'building';
    if (row.state !== e.status) {
      if (row.state) row.el.classList.remove(row.state);
      row.el.classList.add(e.status);
      row.state = e.status;
      row.bar.hidden = !building;
      row.status.hidden = false;
      row.status.classList.toggle('blocked', e.status === 'blocked');
    }
    if (building) {
      // the fill eases between updates (CSS transition on transform), never rebuilt
      const fillAt = `scaleX(${clamp01(e.progress).toFixed(3)})`;
      if (row.fillAt !== fillAt) {
        row.fillAt = fillAt;
        row.fill.style.transform = fillAt;
        setTip(row.bar, status);
      }
    }
    const reason = e.reason ? SHORT_REASON[e.reason] : '';
    const shortStatus = building ? `${Math.round(e.progress * 100)}% · paid`
      : e.paid ? `${reason || 'Paused'} · paid`
      : e.status === 'blocked' ? reason || 'Blocked'
      : e.recovery ? 'Recovery'
      : backed ? 'Backed'
      : e.next ? 'Next'
      : e.reason === 'funds' || !e.reason ? 'Queued' : reason;
    setText(row.status, shortStatus);
    setTip(row.status, status);

    if (detail) {
      const why = queueReasonText(e);
      const where = e.producer ? `made at forward producer ${e.producer}` : isUpgrade(e.item) ? `researched at the ${PLANE_NAME[e.plane]} Spire segment` : isUnitKind(e.item) ? `made at the ${PLANE_NAME[e.plane]} Spire segment` : `built on ${PLANE_NAME[e.plane]}`;
      const title = `${label} · ${where}${why ? ` · ${why}` : ''}\nRequested by ${owner}.\n${e.paid ? 'Already paid; reordering does not interrupt this work.' : `Held: ${row.heldAlloy}/${e.alloy} alloy · ${row.heldEnergy}/${e.energy} energy. Only the next eligible commitment in this lane holds normal funds.`}\n${editable ? `Reorder only the ${PLANE_NAME[e.plane]} lane; paid work is unaffected.` : 'Read-only: no acting credential for this lane.'}`;
      if (row.title !== title) {
        row.title = title;
        tip(row.el, title);
      }
    }
    const aria = `${PLANE_NAME[e.plane]} #${i + 1} ${label}, ${e.next ? 'next commitment, ' : ''}${status}, ${e.paid ? `${e.alloy} alloy and ${e.energy} energy paid` : `${row.heldAlloy} of ${e.alloy} alloy held, ${row.heldEnergy} of ${e.energy} energy held`}, requested by ${owner}${editable ? '' : ', read-only'}`;
    if (row.label !== aria) {
      row.label = aria;
      row.el.setAttribute('aria-label', aria);
    }
  }

  // ---------------------------------------------------------------- actions
  private cancel(id: string): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e || !this.host.canAct(e.plane)) return;
    const label = queueLabel(e);
    void this.host.act(e.plane, [{ kind: 'queue_cancel', entry: id }]).then((ok) => ok && this.host.toast(`${label} cancelled`, 'ok'));
  }

  /** Fund first, step one: arm the row's inline confirmation (a native dialog would freeze the HUD mid-match). */
  private prioritize(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || !this.host.canAct(entry.plane) || !this.host.canPrioritize(entry.plane) || !fundable(entry)) return;
    this.confirming = id;
    this.rerender(entry);
    this.rows.get(id)?.confirm.focus({ preventScroll: true });
  }

  /** Fund first, step two: the armed entry, still eligible, gets one `queue_priority`. */
  private confirmPriority(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    const armed = this.confirming === id;
    this.disarm(id);
    if (!armed || !entry || !this.host.canAct(entry.plane) || !this.host.canPrioritize(entry.plane) || !fundable(entry)) return;
    void this.host.act(entry.plane, [{ kind: 'queue_priority', entry: id }]);
  }

  private disarm(id: string): void {
    if (this.confirming !== id) return;
    this.confirming = undefined;
    const entry = this.entries.find((e) => e.id === id);
    if (entry) this.rerender(entry);
    this.rows.get(id)?.el.focus({ preventScroll: true });
  }

  /** Redraw one row between views (its lane index is unchanged). */
  private rerender(entry: QueueEntryOut): void {
    const row = this.rows.get(entry.id);
    if (row) this.renderRow(row, entry, row.at, this.host.canAct(entry.plane));
  }

  private move(id: string, index: number): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || !this.host.canAct(entry.plane)) return;
    const lane = this.entries.filter((e) => e.plane === entry.plane);
    const target = lane[Math.max(0, Math.min(lane.length - 1, index))];
    if (!target || target.id === id) return;
    const wireIndex = this.wireEntries.findIndex((e) => e.id === target.id);
    void this.host.act(entry.plane, [{ kind: 'queue_move', entry: id, index: wireIndex }]);
  }

  private key(e: KeyboardEvent, id: string): void {
    // Keys belong to the row, except Esc backing out of an armed Fund first from its confirm buttons.
    if (e.target !== e.currentTarget && !(e.key === 'Escape' && this.confirming === id)) return;
    const i = this.entries.findIndex((x) => x.id === id);
    const entry = this.entries[i];
    if (!entry) return;
    const lane = this.entries.filter((x) => x.plane === entry.plane);
    const laneIndex = lane.findIndex((x) => x.id === id);
    const last = this.entries.length - 1;
    const focusAt = (j: number) => this.rows.get(this.entries[Math.max(0, Math.min(last, j))]?.id ?? '')?.el.focus();
    switch (e.key) {
      case 'ArrowUp':
        if (e.altKey) this.move(id, laneIndex - 1);
        else focusAt(i - 1);
        break;
      case 'ArrowDown':
        if (e.altKey) this.move(id, laneIndex + 1);
        else focusAt(i + 1);
        break;
      case 'Home':
        if (e.altKey) this.move(id, 0);
        else focusAt(0);
        break;
      case 'End':
        if (e.altKey) this.move(id, lane.length - 1);
        else focusAt(last);
        break;
      case 'Delete':
      case 'Backspace':
        this.cancel(id);
        break;
      case 'Escape':
        if (this.confirming === id) this.disarm(id);
        else (e.currentTarget as HTMLElement).blur();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // ---------------------------------------------------------------- drag and drop
  /** The gap under the pointer: 0 = above the first row … n = below the last. */
  private gapAt(y: number, entries: readonly QueueEntryOut[]): number {
    for (let i = 0; i < entries.length; i++) {
      const r = this.rows.get(entries[i]!.id)?.el.getBoundingClientRect();
      if (r && y < r.top + r.height / 2) return i;
    }
    return entries.length;
  }

  private dragOver(e: DragEvent, plane: Plane): void {
    this.clearMarks();
    const entry = this.entries.find((x) => x.id === this.dragId);
    if (!entry || entry.plane !== plane || !this.host.canAct(plane)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const lane = this.entries.filter((x) => x.plane === plane);
    const before = lane[this.gapAt(e.clientY, lane)];
    if (before) this.rows.get(before.id)?.el.classList.add('drop-before');
    else this.lanes.get(plane)!.list.classList.add('drop-end');
  }

  private drop(e: DragEvent, plane: Plane): void {
    const entry = this.entries.find((x) => x.id === this.dragId);
    if (!entry || entry.plane !== plane || !this.host.canAct(plane)) return;
    e.preventDefault();
    const lane = this.entries.filter((x) => x.plane === plane);
    const from = lane.findIndex((x) => x.id === entry.id);
    this.move(entry.id, dropIndex(from, this.gapAt(e.clientY, lane)));
    this.clearMarks();
  }

  private clearMarks(): void {
    for (const lane of this.lanes.values()) lane.list.classList.remove('drop-end');
    for (const row of this.rows.values()) row.el.classList.remove('drop-before');
  }
}
