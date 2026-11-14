// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from '../src/dom.ts';
import { installTooltips, pointTip, positionTooltip, tip, TOOLTIP_DELAY, TOOLTIP_LONG_PRESS } from '../src/tooltip.ts';

let dispose: () => void;
beforeEach(() => {
  installTooltips()();
  vi.useFakeTimers();
  dispose = installTooltips();
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function anchor(text = 'Help') {
  const el = h('button', { 'data-tip': text }, 'Action');
  document.body.append(el);
  return el;
}
const visible = () => document.querySelector<HTMLElement>('[role="tooltip"]:not([hidden])');
function pointer(el: Element, type: string, options: PointerEventInit = {}) {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse', ...options }));
}

describe('global tooltips', () => {
  it('delegates plain data-tip without registering the target', () => {
    const el = document.createElement('button');
    el.dataset.tip = 'Unregistered';
    document.body.append(el);
    pointer(el, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY - 1);
    expect(visible()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(visible()?.textContent).toBe('Unregistered');
  });

  it('cancels a pending hover on leaving', () => {
    const el = anchor();
    pointer(el, 'pointerover');
    vi.advanceTimersByTime(100);
    pointer(el, 'pointerout');
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(visible()).toBeNull();
    expect(el.hasAttribute('aria-describedby')).toBe(false);
  });

  it('keeps one layer when switching targets, with no stale timer', () => {
    const first = anchor('First');
    const second = anchor('Second');
    pointer(first, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY / 2);
    pointer(second, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY / 2);
    expect(visible()).toBeNull();
    vi.advanceTimersByTime(TOOLTIP_DELAY / 2);
    expect(visible()?.textContent).toBe('Second');
    first.focus();
    expect(visible()?.textContent).toBe('First');
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
  });

  it('shows keyboard focus immediately and closes on blur', () => {
    const el = anchor();
    el.focus();
    expect(visible()?.textContent).toBe('Help');
    expect(el.getAttribute('aria-describedby')).toBe(visible()?.id);
    el.blur();
    expect(visible()).toBeNull();
    expect(el.hasAttribute('aria-describedby')).toBe(false);
  });

  it('makes static declarative hints reachable without changing explicit tab order', () => {
    const el = h('span', { 'data-tip': 'Static' }, 'Badge');
    const excluded = tip(h('span', { tabindex: -1 }), 'Programmatic only');
    document.body.append(el);
    expect(el.tabIndex).toBe(0);
    expect(excluded.tabIndex).toBe(-1);
    el.focus();
    expect(visible()?.textContent).toBe('Static');
  });

  it('only releases its own description ID and preserves outside updates', () => {
    const el = anchor();
    el.setAttribute('aria-describedby', 'existing');
    el.focus();
    const id = visible()!.id;
    expect(el.getAttribute('aria-describedby')).toBe(`existing ${id}`);
    el.setAttribute('aria-describedby', `${el.getAttribute('aria-describedby')} later`);
    el.blur();
    expect(el.getAttribute('aria-describedby')).toBe('existing later');
  });

  it('renders rich content as text, including zero costs, and refreshes the active hint', () => {
    const el = tip(anchor(), { title: '<b>Tank</b>', description: '<img src=x>', hotkey: 'T', cost: { alloy: 120, energy: 0 }, status: 'Queued' });
    el.focus();
    expect(visible()?.querySelector('b, img')).toBeNull();
    expect(visible()?.querySelector('.ac-tooltip-title')?.textContent).toBe('<b>Tank</b>');
    expect(visible()?.querySelector('kbd')?.textContent).toBe('T');
    expect(visible()?.textContent).toContain('120 alloy · 0 energy');
    expect(visible()?.textContent).toContain('Queued');
    tip(el, 'Updated');
    expect(visible()?.textContent).toBe('Updated');
    expect(visible()?.querySelector('kbd')).toBeNull();
    tip(el, '');
    expect(visible()).toBeNull();
  });

  it('keeps the hint open while the pointer crosses into the layer', () => {
    const el = anchor();
    pointer(el, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    const layer = visible()!;
    pointer(el, 'pointerout');
    vi.advanceTimersByTime(50);
    pointer(layer, 'pointerover', { relatedTarget: el });
    vi.advanceTimersByTime(200);
    expect(visible()).toBe(layer);
    pointer(layer, 'pointerout');
    vi.advanceTimersByTime(100);
    expect(visible()).toBeNull();
  });

  it('does not close a focused hint when the pointer leaves', () => {
    const el = anchor();
    el.focus();
    pointer(el, 'pointerout');
    vi.advanceTimersByTime(200);
    expect(visible()).not.toBeNull();
  });

  it('Escape closes both visible and pending hints without stealing focus', () => {
    const el = anchor();
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(visible()).toBeNull();
    expect(document.activeElement).toBe(el);
    el.blur();
    pointer(el, 'pointerover');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(visible()).toBeNull();
  });

  it('a click dismisses the hint and suppresses it until the pointer leaves the anchor', () => {
    const el = anchor();
    const icon = h('span', {}, '⚙');
    el.append(icon);
    pointer(el, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(visible()).not.toBeNull();
    pointer(el, 'pointerdown');
    expect(visible()).toBeNull();
    el.focus(); // click focus
    pointer(el, 'pointerup');
    el.click();
    pointer(icon, 'pointerover');
    pointer(el, 'pointerout', { relatedTarget: icon });
    vi.advanceTimersByTime(TOOLTIP_DELAY * 2);
    expect(visible()).toBeNull();
    pointer(el, 'pointerout', { relatedTarget: document.body });
    pointer(el, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(visible()?.textContent).toBe('Help');
  });

  it('a keyboard press dismisses the focused hint until focus moves on', () => {
    const el = anchor();
    const other = anchor('Other');
    el.focus();
    expect(visible()).not.toBeNull();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(visible()).toBeNull();
    el.blur();
    el.focus();
    expect(visible()).toBeNull();
    other.focus();
    expect(visible()?.textContent).toBe('Other');
    el.focus();
    expect(visible()?.textContent).toBe('Help');
  });

  it('never shows while the popover the anchor opened is open', () => {
    const pop = h('div', { id: 'pop', role: 'dialog', hidden: true }, h('input', { 'data-tip': 'Inside' }));
    const el = h('button', { 'data-tip': 'Settings', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'pop' }, 'Gear');
    document.body.append(el, pop);
    el.setAttribute('aria-expanded', 'true');
    pop.hidden = false;
    pointer(el, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(visible()).toBeNull();
    el.focus();
    expect(visible()).toBeNull();
  });

  it('focus returning from a closed popover or modal does not re-pop the hint', () => {
    const field = h('input', {});
    const pop = h('div', { role: 'dialog' }, field);
    const el = anchor('Settings');
    document.body.append(pop);
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    pop.remove();
    el.focus();
    expect(visible()).toBeNull();
    el.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    el.focus();
    expect(visible()?.textContent).toBe('Settings');
  });

  it('focus that follows a pointer press (a popover focusing its field) shows nothing', () => {
    const el = anchor('Settings');
    const field = h('input', { 'data-tip': 'WASD camera' });
    document.body.append(field);
    pointer(el, 'pointerdown');
    el.focus();
    field.focus();
    expect(visible()).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    el.focus();
    expect(visible()?.textContent).toBe('Settings');
  });

  it('an anchor that opened an unlabelled popover stays quiet until the popover closes', () => {
    const el = anchor('Commander');
    const pop = h('div', { role: 'dialog', hidden: true }, 'Pick');
    document.body.append(pop);
    el.addEventListener('click', () => (pop.hidden = false));
    pointer(el, 'pointerdown');
    el.click();
    pointer(el, 'pointerout', { relatedTarget: document.body });
    pointer(el, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(visible()).toBeNull();
    pop.hidden = true;
    pointer(el, 'pointerout', { relatedTarget: document.body });
    pointer(el, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(visible()?.textContent).toBe('Commander');
  });

  it('closes on nested scrolling and window resize', () => {
    const el = anchor();
    el.focus();
    el.dispatchEvent(new Event('scroll'));
    expect(visible()).toBeNull();
    el.blur();
    el.focus();
    window.dispatchEvent(new Event('resize'));
    expect(visible()).toBeNull();
  });

  it('cleans up detached active and pending anchors', async () => {
    const el = anchor();
    el.focus();
    el.remove();
    await vi.advanceTimersByTimeAsync(1);
    expect(visible()).toBeNull();
    expect(el.hasAttribute('aria-describedby')).toBe(false);
    const pending = anchor();
    pointer(pending, 'pointerover');
    pending.remove();
    await vi.advanceTimersByTimeAsync(TOOLTIP_DELAY);
    expect(visible()).toBeNull();
  });

  it('never adds focus stops to decorative hints or children of existing controls', async () => {
    const hidden = h('span', { 'aria-hidden': 'true', 'data-tip': 'Decoration' });
    const child = h('span', { 'data-tip': 'Inner detail' });
    const control = h('button', { 'data-tip': 'Control' }, child);
    const laterHidden = h('span', { 'data-tip': 'Nested decoration' });
    document.body.append(hidden, control, h('span', { 'aria-hidden': 'true' }, laterHidden));
    await Promise.resolve();
    expect(hidden.hasAttribute('tabindex')).toBe(false);
    expect(child.hasAttribute('tabindex')).toBe(false);
    expect(laterHidden.hasAttribute('tabindex')).toBe(false);
    control.focus();
    expect(visible()?.textContent).toBe('Control');
  });

  it('supports touch long press without activating the underlying command', () => {
    const el = anchor();
    const click = vi.fn();
    el.addEventListener('click', click);
    pointer(el, 'pointerdown', { pointerType: 'touch', pointerId: 1 });
    el.focus();
    vi.advanceTimersByTime(TOOLTIP_LONG_PRESS - 1);
    expect(visible()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(visible()?.textContent).toBe('Help');
    pointer(el, 'pointerup', { pointerType: 'touch', pointerId: 1 });
    pointer(el, 'pointerout', { pointerType: 'touch', pointerId: 1 });
    vi.advanceTimersByTime(200);
    expect(visible()).not.toBeNull();
    el.click();
    expect(click).not.toHaveBeenCalled();
    pointer(document.body, 'pointerdown', { pointerType: 'touch', pointerId: 2 });
    expect(visible()).toBeNull();
  });

  it('cancels long press on short taps, movement and pointer cancellation', () => {
    for (const ending of ['pointerup', 'pointermove', 'pointercancel']) {
      const el = anchor();
      pointer(el, 'pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 20 });
      vi.advanceTimersByTime(100);
      pointer(el, ending, { pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 20 });
      vi.advanceTimersByTime(TOOLTIP_LONG_PRESS);
      expect(visible()).toBeNull();
    }
  });

  it('positions the mounted layer using the shared geometry helper', () => {
    const el = anchor();
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 140, top: 200, bottom: 240 } as DOMRect);
    el.focus();
    const layer = visible()!;
    const expected = positionTooltip(el.getBoundingClientRect(), layer.getBoundingClientRect(), {
      width: window.visualViewport?.width ?? window.innerWidth,
      height: window.visualViewport?.height ?? window.innerHeight,
      left: window.visualViewport?.offsetLeft ?? 0,
      top: window.visualViewport?.offsetTop ?? 0,
    });
    expect(layer.style.left).toBe(`${expected.left}px`);
    expect(layer.style.top).toBe(`${expected.top}px`);
  });

  it('uses the shared delayed tooltip for canvas points, refreshes content and hides on leave', () => {
    const storm = { title: 'Storm', description: 'Aircraft take damage.' };
    pointTip(storm, 100, 200);
    vi.advanceTimersByTime(TOOLTIP_DELAY / 2);
    pointTip(storm, 110, 210);
    vi.advanceTimersByTime(TOOLTIP_DELAY / 2);
    expect(visible()?.textContent).toContain('Storm');
    pointTip({ title: 'Storm', description: 'Updated match rules.' }, 120, 220);
    expect(visible()?.textContent).toContain('Updated match rules.');
    pointTip(undefined);
    expect(visible()).toBeNull();
  });

  it('cancels a pending canvas point without hiding an unrelated DOM tooltip', () => {
    pointTip({ title: 'Mist' }, 100, 200);
    pointTip(undefined);
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(visible()).toBeNull();
    anchor('Build').focus();
    pointTip(undefined);
    expect(visible()?.textContent).toBe('Build');
  });

  it('disposes listeners, pending timers, ARIA references and the layer', () => {
    const el = anchor();
    el.focus();
    dispose();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(el.hasAttribute('aria-describedby')).toBe(false);
    pointer(el, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(visible()).toBeNull();
    dispose = installTooltips();
    pointer(el, 'pointerover');
    vi.advanceTimersByTime(TOOLTIP_DELAY);
    expect(visible()).not.toBeNull();
  });
});

describe('tooltip positioning', () => {
  const viewport = { width: 300, height: 200 };
  const size = { width: 100, height: 40 };
  it('centers above when there is space', () => {
    expect(positionTooltip({ left: 120, right: 160, top: 100, bottom: 120 }, size, viewport)).toEqual({ left: 90, top: 52, placement: 'top' });
  });
  it('flips below near the top edge', () => {
    expect(positionTooltip({ left: 120, right: 160, top: 10, bottom: 30 }, size, viewport)).toEqual({ left: 90, top: 38, placement: 'bottom' });
  });
  it('clamps left and right edges', () => {
    expect(positionTooltip({ left: 0, right: 10, top: 100, bottom: 120 }, size, viewport).left).toBe(8);
    expect(positionTooltip({ left: 290, right: 300, top: 100, bottom: 120 }, size, viewport).left).toBe(192);
  });
  it('uses the roomier side when neither fits and clamps oversized content', () => {
    expect(positionTooltip({ left: 0, right: 20, top: 80, bottom: 100 }, { width: 500, height: 500 }, viewport)).toEqual({ left: 8, top: 8, placement: 'bottom' });
  });
  it('respects visual viewport offsets', () => {
    expect(positionTooltip({ left: 40, right: 60, top: 60, bottom: 80 }, size, { ...viewport, left: 30, top: 50 })).toEqual({ left: 38, top: 88, placement: 'bottom' });
  });
});
