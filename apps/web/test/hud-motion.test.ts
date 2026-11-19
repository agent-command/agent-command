// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameOf, type GameEvent, type MatchData, type QueueEntryOut, type View } from '@agent-command/game/contract';
import { EventFeed, FEED_LINES, staggerDelay, type FeedLine } from '../src/event-feed.ts';
import { QueuePanel, reordered } from '../src/queue-panel.ts';
import { Motion } from '../src/motion.ts';

/** A stand-in for the Web Animations API: records each animation and finishes it on demand. */
interface FakeAnimation {
  el: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancelled: boolean;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
  cancel(): void;
}
let anims: FakeAnimation[] = [];
const finishAll = () => {
  for (const a of anims.splice(0)) if (!a.cancelled) a.onfinish?.();
};
const transforms = () => anims.filter((a) => !a.options.pseudoElement && a.keyframes.some((k) => k.transform !== undefined && k.transform !== 'none'));

beforeEach(() => {
  anims = [];
  vi.spyOn(Element.prototype, 'animate').mockImplementation(function (this: Element, keyframes, options) {
    const a: FakeAnimation = {
      el: this,
      keyframes: keyframes as Keyframe[],
      options: (options ?? {}) as KeyframeAnimationOptions,
      cancelled: false,
      onfinish: null,
      oncancel: null,
      cancel() {
        this.cancelled = true;
        this.oncancel?.();
      },
    };
    anims.push(a);
    return a as unknown as Animation;
  });
  // rows are 30 px apart in document order, so a reorder moves them
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const i = this.parentElement ? Array.prototype.indexOf.call(this.parentElement.children, this) : 0;
    return { top: i * 30, bottom: i * 30 + 24, left: 0, right: 200, width: 200, height: 24, x: 0, y: i * 30 } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(24);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const reduceMotion = () =>
  vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: q.includes('reduce'), media: q }) as unknown as MediaQueryList);

const entry = (id: string, extra: Partial<QueueEntryOut> = {}): QueueEntryOut => ({
  id,
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
const view = (queue: QueueEntryOut[], events: Partial<GameEvent>[] = []) => ({
  army: 'nw', rulesHash: 0, queue, events,
  res: { alloy: 200, energy: 100, freeAlloy: 200, freeEnergy: 100, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0, upkeepHeld: 0 },
}) as unknown as View;

function panel(): QueuePanel {
  const p = new QueuePanel({ act: async () => true, canAct: () => true, canPrioritize: () => false, toast: () => {} });
  document.body.append(p.el);
  return p;
}
const row = (p: QueuePanel, id: string) => p.el.querySelector<HTMLLIElement>(`[data-id="${id}"]`);
const order = (p: QueuePanel) => [...p.el.querySelectorAll<HTMLLIElement>('.qp-row:not(.leaving)')].map((r) => r.dataset.id);

describe('build queue motion', () => {
  it('reuses each row, its progress bar and its status across updates', () => {
    const p = panel();
    p.update(view([entry('q_1', { status: 'building', progress: 0.2 }), entry('q_2')]));
    const a = row(p, 'q_1')!;
    const fill = a.querySelector<HTMLElement>('.qp-fill')!;
    const status = row(p, 'q_2')!.querySelector('.qp-status');
    p.update(view([entry('q_1', { status: 'building', progress: 0.5 }), entry('q_2', { reason: 'funds', eta: 60 })]));
    expect(row(p, 'q_1')).toBe(a);
    expect(a.querySelector('.qp-fill')).toBe(fill);
    expect(fill.style.transform).toBe('scaleX(0.500)');
    expect(a.getAttribute('aria-label')).toContain('50%');
    expect(row(p, 'q_2')!.querySelector('.qp-status')).toBe(status);
  });

  it('shows the first view as it is, then inks new entries in', () => {
    const p = panel();
    p.update(view([entry('q_1')]));
    expect(anims).toHaveLength(0);
    p.update(view([entry('q_1'), entry('q_2')]));
    const inks = anims.filter((a) => a.el === row(p, 'q_2'));
    expect(inks.length).toBeGreaterThan(0);
    expect(anims.every((a) => a.el === row(p, 'q_2'))).toBe(true);
  });

  it('keeps a finished row, stamped and out of reach, until its exit ends', () => {
    const p = panel();
    p.update(view([entry('q_1'), entry('q_2')]));
    const a = row(p, 'q_1')!;
    p.update(view([entry('q_2')]));
    expect(a.isConnected).toBe(true);
    expect(a.classList.contains('leaving')).toBe(true);
    expect(a.classList.contains('done')).toBe(true);
    expect(a.inert).toBe(true);
    expect(a.hasAttribute('tabindex')).toBe(false);
    expect(a.getAttribute('aria-hidden')).toBe('true');
    expect(order(p)).toEqual(['q_2']);
    finishAll();
    expect(a.isConnected).toBe(false);
  });

  it('strikes through a cancelled entry', () => {
    const p = panel();
    p.update(view([entry('q_1'), entry('q_2')]));
    const a = row(p, 'q_1')!;
    p.update(view([entry('q_2')], [{ kind: 'queue_cancelled', entry: 'q_1' }]));
    expect(a.classList.contains('cancelled')).toBe(true);
    expect(a.isConnected).toBe(true);
  });

  it('slides rows to a new order and keeps the focused row focused', () => {
    const p = panel();
    p.update(view([entry('q_1'), entry('q_2'), entry('q_3')]));
    const c = row(p, 'q_3')!;
    c.focus();
    p.update(view([entry('q_3'), entry('q_1'), entry('q_2')]));
    expect(order(p)).toEqual(['q_3', 'q_1', 'q_2']);
    expect(row(p, 'q_3')).toBe(c);
    expect(document.activeElement).toBe(c);
    const slides = transforms();
    expect(slides.map((a) => (a.el as HTMLElement).dataset.id).sort()).toEqual(['q_1', 'q_2', 'q_3']);
    expect(slides.find((a) => a.el === c)!.keyframes[0]!.transform).toBe('translateY(60px)');
  });

  it('keeps separate lane rows stable when a global queue index changes', () => {
    const p = panel();
    const orbit = entry('q_2', { item: 'solar', plane: 'orbit', by: 'orbit' });
    p.update(view([entry('q_1'), orbit, entry('q_3')]));
    const a = row(p, 'q_1')!, b = row(p, 'q_2')!, c = row(p, 'q_3')!;
    const orbitList = b.parentElement;
    b.querySelector<HTMLButtonElement>('.qp-x')!.focus();
    p.update(view([entry('q_3'), orbit, entry('q_1')]));
    expect(row(p, 'q_1')).toBe(a);
    expect(row(p, 'q_2')).toBe(b);
    expect(row(p, 'q_3')).toBe(c);
    expect(b.parentElement).toBe(orbitList);
    expect(b.parentElement).not.toBe(a.parentElement);
    expect(document.activeElement).toBe(b.querySelector('.qp-x'));
    expect(transforms().some(animation => animation.el === b)).toBe(false);
  });

  it('preserves focus inside a row when another seat reorders it', () => {
    const p = panel();
    p.update(view([entry('q_1'), entry('q_2')]));
    const button = row(p, 'q_2')!.querySelector<HTMLButtonElement>('.qp-x')!;
    button.focus();
    p.update(view([entry('q_2'), entry('q_1')]));
    expect(document.activeElement).toBe(button);
  });

  it('does not restart entry animations on repeated progress updates', () => {
    const p = panel();
    p.update(view([]));
    p.update(view([entry('q_1', { status: 'building', progress: 0.1 })]));
    const running = [...anims];
    p.update(view([entry('q_1', { status: 'building', progress: 0.2 })]));
    expect(anims).toEqual(running);
  });

  it('keeps keyboard and cancel-button intents wired after reconciliation', () => {
    const act = vi.fn(async () => true);
    const p = new QueuePanel({ act, canAct: () => true, canPrioritize: () => false, toast: () => {} });
    document.body.append(p.el);
    p.update(view([entry('q_1'), entry('q_2')]));
    const a = row(p, 'q_1')!;
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    expect(act).toHaveBeenLastCalledWith('surface', [{ kind: 'queue_move', entry: 'q_1', index: 1 }]);
    p.update(view([entry('q_2'), entry('q_1')]));
    a.querySelector<HTMLButtonElement>('.qp-x')!.click();
    expect(act).toHaveBeenLastCalledWith('surface', [{ kind: 'queue_cancel', entry: 'q_1' }]);
  });

  it('moves focus to the neighbour when the focused entry leaves', () => {
    const p = panel();
    p.update(view([entry('q_1'), entry('q_2')]));
    row(p, 'q_1')!.focus();
    p.update(view([entry('q_2')]));
    expect(document.activeElement).toBe(row(p, 'q_2'));
  });

  it('with reduced motion only fades: no slides or transforms', () => {
    reduceMotion();
    const p = panel();
    p.update(view([entry('q_1'), entry('q_2'), entry('q_3')]));
    p.update(view([entry('q_3'), entry('q_1'), entry('q_4')]));
    expect(order(p)).toEqual(['q_3', 'q_1', 'q_4']);
    expect(anims.length).toBeGreaterThan(0);
    expect(transforms()).toHaveLength(0);
    expect(anims.every((a) => a.keyframes.every((k) => Object.keys(k).every((prop) => prop === 'opacity' || prop === 'offset' || prop === 'easing')))).toBe(true);
    const gone = row(p, 'q_2')!;
    expect(gone.isConnected).toBe(true);
    finishAll();
    expect(gone.isConnected).toBe(false);
  });

  it('cancels running animations and drops leaving rows on dispose', () => {
    const p = panel();
    p.update(view([entry('q_1'), entry('q_2')]));
    const a = row(p, 'q_1')!;
    p.update(view([entry('q_2')]));
    const running = [...anims];
    p.dispose();
    expect(running.every((x) => x.cancelled)).toBe(true);
    expect(a.isConnected).toBe(false);
  });

  it('discards old exits and animations when switching team views', () => {
    const p = panel();
    p.update(view([entry('q_1')]));
    const a = row(p, 'q_1')!;
    p.update(view([]));
    p.update({ ...view([entry('q_2')]), army: 'se' });
    expect(a.isConnected).toBe(false);
    expect(anims.every((x) => x.cancelled)).toBe(true);
    expect(order(p)).toEqual(['q_2']);
  });

  it('tells a reorder from adds and removals', () => {
    const ids = (...xs: string[]) => xs.map((x) => entry(x));
    const had = (...xs: string[]) => new Set(xs);
    expect(reordered(ids('a', 'b', 'c'), ids('a', 'c', 'd'), had('a', 'b', 'c'), had('a', 'c', 'd'))).toBe(false);
    expect(reordered(ids('a', 'b'), ids('x', 'a', 'b'), had('a', 'b'), had('x', 'a', 'b'))).toBe(false);
    expect(reordered(ids('a', 'b', 'c'), ids('b', 'a', 'c'), had('a', 'b', 'c'), had('a', 'b', 'c'))).toBe(true);
  });
});

const DUEL: Pick<MatchData, 'armies'> = { armies: (['nw', 'se'] as const).map((id, slot) => ({ id, slot, frame: frameOf(id), colour: slot ? 'red' : 'blue', spireAt: { x: 0, y: 0 } })) };

describe('event feed motion', () => {
  let n = 0;
  const line = (tick: number): FeedLine => ({ key: `k${n++}`, ev: { tick, kind: 'produced', plane: 'surface', x: 1, y: 2, subject: 'tank', side: 'nw' } as GameEvent });
  const feed = () => {
    const f = new EventFeed(() => {});
    document.body.append(f.el);
    return f;
  };

  it('keeps lines across updates and adds only the new ones, staggered', () => {
    const f = feed();
    const log = [line(20), line(40)];
    f.update(log, 'nw', DUEL);
    expect(anims).toHaveLength(0);
    const first = f.el.children[0];
    log.push(line(60), line(80), line(100));
    f.update(log, 'nw', DUEL);
    expect(f.el.children[0]).toBe(first);
    expect(f.el.children).toHaveLength(5);
    const ins = anims.filter((a) => !a.options.pseudoElement && a.keyframes[0]!.opacity === 0);
    expect(ins.map((a) => a.options.delay)).toEqual([0, 40, 80]);
    // the newest line gets the wash
    expect(anims.filter((a) => a.options.pseudoElement === '::after').map((a) => a.el)).toEqual([f.el.children[4]]);
  });

  it('caps a burst stagger so the last line never trails far behind', () => {
    expect(staggerDelay(1, 2)).toBe(40);
    expect(staggerDelay(FEED_LINES - 1, FEED_LINES)).toBeLessThanOrEqual(160);
  });

  it('fades the oldest line out before dropping it', () => {
    const f = feed();
    const log = Array.from({ length: FEED_LINES }, (_, i) => line(i * 20));
    f.update(log, 'nw', DUEL);
    const oldest = f.el.children[0] as HTMLElement;
    log.push(line(500));
    f.update(log, 'nw', DUEL);
    expect(oldest.isConnected).toBe(true);
    expect(oldest.classList.contains('leaving')).toBe(true);
    expect(f.el.querySelectorAll('.ev:not(.leaving)')).toHaveLength(FEED_LINES);
    const exit = anims.find((a) => a.el === oldest && a.keyframes.at(-1)?.opacity === 0)!;
    expect(exit.keyframes.at(-1)?.marginBottom).toBe('-24px');
    finishAll();
    expect(oldest.isConnected).toBe(false);
  });

  it('with reduced motion only fades', () => {
    reduceMotion();
    const f = feed();
    const log = [line(20)];
    f.update(log, 'nw', DUEL);
    log.push(line(40), line(60));
    f.update(log, 'nw', DUEL);
    expect(anims.length).toBeGreaterThan(0);
    expect(transforms()).toHaveLength(0);
  });

  it('cleans up exits on dispose and when switching team views', () => {
    for (const switchTeam of [false, true]) {
      anims = [];
      const f = feed();
      const log = Array.from({ length: FEED_LINES }, (_, i) => line(i * 20));
      f.update(log, 'nw', DUEL);
      const oldest = f.el.children[0]!;
      log.push(line(500));
      f.update(log, 'nw', DUEL);
      if (switchTeam) f.update(log, 'se', DUEL);
      else f.dispose();
      expect(oldest.isConnected).toBe(false);
      expect(anims.every((a) => a.cancelled)).toBe(true);
    }
  });
});

describe('motion lifecycle', () => {
  it('releases filled effects when finished, with no idle timers', () => {
    const motion = new Motion();
    const el = document.createElement('div');
    const done = vi.fn();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    motion.play(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }, done);
    const animation = anims[0]!;
    finishAll();
    expect(done).toHaveBeenCalledOnce();
    expect(animation.cancelled).toBe(true);
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    motion.dispose();
    expect(done).toHaveBeenCalledOnce();
  });
});
