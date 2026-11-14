/**
 * The event feed: the last lines of the army's log, bottom-left, newest at the bottom; a click jumps to the event.
 * Lines are keyed (game.ts's event key) and kept while shown, so only new and dropped lines move: new lines slide in
 * from the edge with an ink fade (a burst staggers, capped so the newest never trails the game) and the newest gets a
 * highlighter wash that fades; older lines rise to make room (FLIP) and the oldest fades off the top. Reduced motion:
 * opacity only. Team requests (`view.signals`) write a line when they appear and one per later state; the line of a
 * request's current state offers the human's one-click answer (click takes it, × declines, ✓ marks it done).
 */
import { TICK_RATE, type ArmyId, type MatchData, type Plane } from '@agent-command/game/contract';
import { PLANE_ACCENT, h } from './dom.ts';
import { EASE_OUT, Motion, measureTops, reducedMotion } from './motion.ts';
import { NEED_LABEL, PLANE_NAME, eventText, signalText, signalTo, type FeedEvent } from './text.ts';
import { icon } from './icons.ts';
import { signalAction, signalPlane, type SignalAction, type SignalEntry, type SignalHooks } from './signals.ts';

/** A request's line: the board entry as it was in the state the line reports. */
export interface SignalEvent {
  kind: 'signal';
  tick: number;
  entry: SignalEntry;
}

export interface FeedLine {
  key: string;
  ev: FeedEvent | SignalEvent;
}

/** A shown request line and the answer it currently offers. */
interface SignalLine {
  entry: SignalEntry;
  go: HTMLElement;
  answer: HTMLButtonElement;
  action: SignalAction | undefined;
}

export const FEED_LINES = 7;
const STAGGER_MS = 40;
/** A burst staggers this long at most in all (the step shrinks), so its last line lands within ~0.4 s. */
const STAGGER_MAX_MS = 160;
const IN_MS = 220;
const RISE_MS = 200;
const OUT_MS = 200;
const FADE_MS = 160;
const WASH_MS = 1200;

/** The delay of line `i` of a burst of `n` new lines. */
export function staggerDelay(i: number, n: number): number {
  return n > 1 ? i * Math.min(STAGGER_MS, STAGGER_MAX_MS / (n - 1)) : 0;
}

/** A line's match time stamp, m:ss. */
function clock(tick: number): HTMLElement {
  const secs = Math.floor(tick / TICK_RATE);
  return h('span', { class: 'ev-t' }, `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
}

export class EventFeed {
  readonly el: HTMLElement;
  private readonly jump: (plane: Plane, x?: number, y?: number) => void;
  private readonly hooks: SignalHooks | undefined;
  private readonly lines = new Map<string, HTMLElement>();
  /** Request lines among `lines`, by the same key. */
  private readonly signalLines = new Map<string, SignalLine>();
  /** Lines dropped off the feed, still fading (not clickable). */
  private readonly leaving = new Set<Element>();
  private readonly motion = new Motion();
  /** Army the lines were written for: the first view and a switch of army view rewrite them without motion. */
  private army: ArmyId | undefined;
  /** What is shown (army, line count, newest key): the feed only appends, so this changes exactly when lines do. */
  private shown = '';

  constructor(jump: (plane: Plane, x?: number, y?: number) => void, hooks?: SignalHooks) {
    this.jump = jump;
    this.hooks = hooks;
    this.el = h('div', { class: 'feed' });
  }

  /**
   * Show the last FEED_LINES of `feed` (oldest first) as `army` of a match with these `armies` reads them; `signals` is
   * the team's board now (request lines offer an answer only while their state is still current).
   */
  update(feed: readonly FeedLine[], army: ArmyId, armies: Pick<MatchData, 'armies'> & Partial<Pick<MatchData, 'posts'>>, signals: readonly SignalEntry[] = []): void {
    this.refreshSignals(signals);
    const from = Math.max(0, feed.length - FEED_LINES);
    const shown = `${army}|${feed.length - from}|${feed[feed.length - 1]?.key ?? ''}`;
    if (shown === this.shown) return;
    this.shown = shown;
    const animate = this.army === army;
    if (!animate) {
      this.army = army;
      this.dispose();
      for (const el of this.lines.values()) el.remove();
      this.lines.clear();
      this.signalLines.clear();
    }
    const reduced = animate && reducedMotion();

    const keep = new Set<string>();
    const fresh: FeedLine[] = [];
    for (let i = from; i < feed.length; i++) {
      const f = feed[i]!;
      keep.add(f.key);
      if (!this.lines.has(f.key)) fresh.push(f);
    }
    // read phase: where the lines are drawn before the new ones push them up
    const before = animate && !reduced && fresh.length ? measureTops(this.el.children) : undefined;
    const heights = new Map<HTMLElement, number>();
    if (animate && !reduced) {
      for (const [key, el] of this.lines) if (!keep.has(key)) heights.set(el, el.offsetHeight);
    }
    const gap = heights.size ? parseFloat(getComputedStyle(this.el).rowGap) || 0 : 0;

    for (const [key, el] of this.lines)
      if (!keep.has(key)) {
        this.lines.delete(key);
        this.signalLines.delete(key);
        if (animate) this.leave(el, reduced, (heights.get(el) ?? 0) + gap);
        else el.remove();
      }
    const added = fresh.map((f) => {
      const el = this.line(f, army, armies);
      this.lines.set(f.key, el);
      this.el.append(el);
      return el;
    });
    if (before) this.motion.flip(before, RISE_MS);
    if (fresh.some((f) => f.ev.kind === 'signal')) this.refreshSignals(signals);
    if (!animate) return;

    added.forEach((el, i) => {
      const delay = reduced ? 0 : staggerDelay(i, added.length);
      if (reduced) this.motion.play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: EASE_OUT });
      else this.motion.play(el, [{ opacity: 0, transform: 'translateX(-14px)' }, { opacity: 1, transform: 'none' }], { duration: IN_MS, delay, easing: EASE_OUT, fill: 'backwards' });
      if (i === added.length - 1) this.motion.play(el, [{ opacity: 1 }, { opacity: 0 }], { pseudoElement: '::after', duration: WASH_MS, delay, easing: 'ease-out', fill: 'backwards' });
    });
  }

  /** Stop every animation and drop the lines still fading. */
  dispose(): void {
    this.motion.dispose();
    for (const el of this.leaving) el.remove();
    this.leaving.clear();
  }

  private line(f: FeedLine, army: ArmyId, armies: Pick<MatchData, 'armies'> & Partial<Pick<MatchData, 'posts'>>): HTMLElement {
    const ev = f.ev;
    if (ev.kind === 'signal') return this.signalLine(f.key, ev);
    const { text, sev } = eventText(ev, army, armies);
    return h(
      'button',
      { class: `ev ${sev}`, onclick: () => this.jump(ev.plane, ev.x, ev.y), 'data-tip': `Jump to ${PLANE_NAME[ev.plane]}: ${text}`, 'aria-label': `Jump to ${text}` },
      clock(ev.tick),
      h('span', { class: 'ev-p', style: `--accent:${PLANE_ACCENT[ev.plane]}`, 'data-tip': PLANE_NAME[ev.plane] }, icon(ev.plane, 14)),
      icon(ev.kind, 14),
      h('span', { class: 'ev-text' }, text),
    );
  }

  /** from → to, the need and its state; the main button jumps (and takes it), the side button declines or finishes. */
  private signalLine(key: string, ev: SignalEvent): HTMLElement {
    const e = ev.entry;
    const { text, sev } = signalText(e);
    const to = e.to === 'team' ? undefined : e.to as Plane;
    const go = h('button', { class: 'ev-go', onclick: () => this.open(key) },
      clock(ev.tick),
      h('span', { class: 'ev-p', style: `--accent:${PLANE_ACCENT[e.from]}`, 'data-tip': PLANE_NAME[e.from] }, icon(e.from, 14)),
      h('span', { class: 'ev-arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'ev-p', ...(to ? { style: `--accent:${PLANE_ACCENT[to]}` } : {}), 'data-tip': signalTo(e.to) }, icon(to ?? 'team', 14)),
      h('span', { 'data-tip': NEED_LABEL[e.need] }, icon(`need_${e.need}`, 14)),
      h('span', { class: 'ev-text' }, text),
    );
    const answer = h('button', { class: 'ev-answer', hidden: true, onclick: () => this.answer(key) });
    const line: SignalLine = { entry: e, go, answer, action: undefined };
    this.signalLines.set(key, line);
    this.label(line);
    return h('div', { class: `ev sig ${sev}` }, go, answer);
  }

  /** Request lines offer the human's answer only while their state is the request's current one. */
  private refreshSignals(signals: readonly SignalEntry[]): void {
    if (!this.signalLines.size) return;
    const hooks = this.hooks;
    for (const line of this.signalLines.values()) {
      const { entry } = line;
      const now = hooks ? signals.find((s) => s.id === entry.id && s.tick === entry.tick) : undefined;
      const action = now && now.state === entry.state ? signalAction(now, (p) => hooks!.mine(p)) : undefined;
      if (action?.plane === line.action?.plane && action?.update === line.action?.update) continue;
      line.action = action;
      this.label(line);
    }
  }

  private label(line: SignalLine): void {
    const { full } = signalText(line.entry);
    const action = line.action;
    const plane = action?.plane ?? signalPlane(line.entry);
    const what = action?.update === 'ack' ? `Jump to ${PLANE_NAME[plane]} and take it` : `Jump to ${PLANE_NAME[plane]}`;
    line.go.setAttribute('data-tip', `${what}: ${full}`);
    line.go.setAttribute('aria-label', `${what}: ${full}`);
    line.answer.hidden = !action;
    if (!action) return;
    const decline = action.update === 'ack';
    line.answer.replaceChildren(icon(decline ? 'cancel' : 'check', 12));
    line.answer.setAttribute('data-tip', decline ? `Decline as ${PLANE_NAME[action.plane]}` : `Done as ${PLANE_NAME[action.plane]}`);
    line.answer.setAttribute('aria-label', decline ? 'Decline' : 'Done');
  }

  private open(key: string): void {
    const line = this.signalLines.get(key);
    if (!line) return;
    const e = line.entry;
    if (this.hooks) this.hooks.open(e, line.action?.plane);
    else this.jump(signalPlane(e), e.x === undefined ? undefined : e.x + 0.5, e.y === undefined ? undefined : e.y + 0.5);
  }

  private answer(key: string): void {
    const line = this.signalLines.get(key);
    const action = line?.action;
    if (!line || !action || !this.hooks) return;
    this.hooks.answer(line.entry, action.plane, action.update === 'ack' ? 'decline' : 'done');
  }

  /** A line dropped off the top: it fades and folds up, then goes. */
  private leave(el: HTMLElement, reduced: boolean, space: number): void {
    this.leaving.add(el);
    el.classList.add('leaving');
    el.inert = true;
    el.setAttribute('aria-hidden', 'true');
    const done = () => {
      el.remove();
      this.leaving.delete(el);
    };
    const keyframes: Keyframe[] = reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { opacity: 1, marginBottom: '0px', clipPath: 'inset(0 0 0 0)' },
          { opacity: 0, marginBottom: `${-space}px`, clipPath: 'inset(0 0 100% 0)' },
        ];
    this.motion.play(el, keyframes, { duration: reduced ? FADE_MS : OUT_MS, easing: EASE_OUT, fill: 'forwards' }, done);
  }
}
