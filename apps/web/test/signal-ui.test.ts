// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEED_ANSWERERS, PLANES, SUPPORT_NEEDS, type MatchData, type Plane } from '@agent-command/game/contract';
import { EventFeed, type FeedLine } from '../src/event-feed.ts';
import { requestIntent, requestNeeds, requestTarget, signalAction, type SignalEntry, type SignalHooks } from '../src/signals.ts';

afterEach(() => document.body.replaceChildren());

/** Request lines never name other armies. */
const DUEL: Pick<MatchData, 'armies'> = { armies: [] };
const request = (extra: Partial<SignalEntry> = {}): SignalEntry =>
  ({ kind: 'request_support', id: 'sg_1', from: 'depths', to: 'surface', tick: 400, expires: 1300, state: 'submitted', need: 'troops', x: 12, y: 20, ...extra }) as SignalEntry;
const line = (e: SignalEntry, tick = e.tick): FeedLine => ({ key: `signal:nw:${e.tick}:${e.id}:${e.state}`, ev: { kind: 'signal', tick, entry: e } });
const hooks = (mine: Plane[] = []) => ({ mine: vi.fn((p: Plane) => mine.includes(p)), open: vi.fn(), answer: vi.fn() }) satisfies SignalHooks;
const lines = (feed: EventFeed) => [...feed.el.querySelectorAll<HTMLElement>('.ev.sig')];
const go = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.ev-go')!;
const answer = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.ev-answer')!;

describe('team requests in the event feed', () => {
  it('writes one line when a request appears: time, from → to plane icons, the need, a threat slip', () => {
    const feed = new EventFeed(vi.fn(), hooks());
    const r = request({ count: 6 });
    feed.update([line(r)], 'nw', DUEL, [r]);
    const [el] = lines(feed);
    expect(el!.classList.contains('warn')).toBe(true);
    expect(el!.querySelector('.ev-t')!.textContent).toBe('0:20');
    const planes = [...el!.querySelectorAll('.ev-p svg')].map((svg) => svg.getAttribute('class'));
    expect(planes).toEqual(['icon icon-depths', 'icon icon-surface']);
    expect(el!.querySelector('svg.icon-need_troops')).not.toBeNull();
    expect(el!.querySelector('.ev-text')!.textContent).toBe('Troops ×6');
    expect(go(el!).getAttribute('data-tip')).toBe('Jump to Surface: Depths → Surface: Troops ×6');
    expect(answer(el!).hidden).toBe(true);
    expect(el!.hasAttribute('title') || !!el!.querySelector('[title]')).toBe(false);
  });

  it('jumps to the request tile on the asked plane (through the game when it answers for the human)', () => {
    const jump = vi.fn();
    const plain = new EventFeed(jump);
    const r = request();
    plain.update([line(r)], 'nw', DUEL, [r]);
    go(lines(plain)[0]!).click();
    expect(jump).toHaveBeenCalledWith('surface', 12.5, 20.5);
    const h = hooks();
    const feed = new EventFeed(jump, h);
    feed.update([line(r)], 'nw', DUEL, [r]);
    go(lines(feed)[0]!).click();
    expect(h.open).toHaveBeenCalledWith(r, undefined);
  });

  it('names a team request’s addressee with the team glyph and writes short lines as its state changes', () => {
    const feed = new EventFeed(vi.fn(), hooks());
    const r = request({ from: 'sky', to: 'team', need: 'troops' });
    const taken = { ...r, state: 'working', by: 'depths' } as SignalEntry;
    const done = { ...taken, state: 'completed' } as SignalEntry;
    const expired = { ...request({ id: 'sg_2', need: 'flak', from: 'sky' }), state: 'expired' } as SignalEntry;
    feed.update([line(r), line(taken, 500), line(done, 900), line(expired, 1400)], 'nw', DUEL, [done, expired]);
    const all = lines(feed);
    expect([...all[0]!.querySelectorAll('.ev-p svg')].map((svg) => svg.getAttribute('class'))).toEqual(['icon icon-sky', 'icon icon-team']);
    expect(all.map((el) => el.querySelector('.ev-text')!.textContent)).toEqual(['Troops', 'Troops Depths on it', 'Troops done', 'Flak expired']);
    expect(all.map((el) => ['good', 'bad', 'warn', 'info'].find((s) => el.classList.contains(s)))).toEqual(['warn', 'info', 'good', 'info']);
  });

  it('offers the human one click to take a request for a plane they control, × to decline, then ✓ once taken', () => {
    const h = hooks(['surface']);
    const feed = new EventFeed(vi.fn(), h);
    const r = request();
    feed.update([line(r)], 'nw', DUEL, [r]);
    const first = lines(feed)[0]!;
    expect(go(first).getAttribute('data-tip')).toBe('Jump to Surface and take it: Depths → Surface: Troops');
    expect(answer(first).hidden).toBe(false);
    expect(answer(first).getAttribute('aria-label')).toBe('Decline');
    go(first).click();
    expect(h.open).toHaveBeenLastCalledWith(r, 'surface');
    answer(first).click();
    expect(h.answer).toHaveBeenLastCalledWith(r, 'surface', 'decline');
    // Taken: the submitted line goes quiet, the new working line offers Done.
    const taken = { ...r, state: 'working', by: 'surface' } as SignalEntry;
    feed.update([line(r), line(taken, 450)], 'nw', DUEL, [taken]);
    const [old, working] = lines(feed);
    expect(old).toBe(first);
    expect(answer(old!).hidden).toBe(true);
    expect(go(old!).getAttribute('data-tip')).toBe('Jump to Surface: Depths → Surface: Troops');
    expect(answer(working!).hidden).toBe(false);
    expect(answer(working!).getAttribute('aria-label')).toBe('Done');
    answer(working!).click();
    expect(h.answer).toHaveBeenLastCalledWith(taken, 'surface', 'done');
    // Gone from the board (closed and kept no longer): nothing left to answer.
    feed.update([line(r), line(taken, 450)], 'nw', DUEL, []);
    expect(answer(working!).hidden).toBe(true);
  });

  it('never offers an answer on a plane the human does not control', () => {
    const feed = new EventFeed(vi.fn(), hooks(['sky']));
    const r = request();
    feed.update([line(r)], 'nw', DUEL, [r]);
    expect(answer(lines(feed)[0]!).hidden).toBe(true);
  });
});

describe('request routing', () => {
  it('asks the one other plane that answers a need, the team when several do, and never yourself', () => {
    expect(requestTarget('surface', 'troops')).toBe('depths');
    expect(requestTarget('depths', 'troops')).toBe('surface');
    expect(requestTarget('sky', 'troops')).toBe('team');
    expect(requestTarget('orbit', 'air_cover')).toBe('sky');
    expect(requestTarget('sky', 'air_cover')).toBeUndefined();
    for (const plane of PLANES) {
      expect(requestNeeds(plane)).toEqual(SUPPORT_NEEDS.filter((need) => NEED_ANSWERERS[need].some((p) => p !== plane)));
      for (const need of requestNeeds(plane)) expect(requestTarget(plane, need)).not.toBe(plane);
    }
    expect(requestNeeds('surface')).toEqual(['troops', 'air_cover', 'scan', 'bombers', 'escort', 'collapse', 'drop', 'capture', 'defend']);
    expect(requestTarget('surface', 'defend')).toBe('team');
    // defend asks the team to hold the asking seat's own segment.
    expect(requestIntent('sky', 'team', 'defend', 3, 4).signal).toMatchObject({ need: 'defend', plane: 'sky', to: 'team' });
  });

  it('lets the human take only open requests for their planes and finish only those they took', () => {
    const mine = (p: Plane) => p === 'depths';
    expect(signalAction(request({ from: 'sky', to: 'team' }), mine)).toEqual({ plane: 'depths', update: 'ack' });
    expect(signalAction(request(), mine)).toBeUndefined();
    expect(signalAction(request({ to: 'depths', from: 'surface', state: 'working', by: 'depths' }), mine)).toEqual({ plane: 'depths', update: 'done' });
    expect(signalAction(request({ from: 'sky', to: 'team', state: 'working', by: 'surface' }), mine)).toBeUndefined();
    expect(signalAction(request({ to: 'depths', from: 'surface', state: 'completed', by: 'depths' }), mine)).toBeUndefined();
  });
});
