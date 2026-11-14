import './tooltip.css';

export interface TipContent {
  title: string;
  description?: string;
  /** Trusted DOM builder, evaluated only while the tooltip is displayed. Never accepts HTML strings. */
  body?: () => HTMLElement;
  hotkey?: string;
  cost?: { alloy?: number; energy?: number };
  /** Rich detail (e.g. a unit stat grid); cloned into the tooltip on every show. */
  stats?: Node;
  status?: string;
}

export const TOOLTIP_DELAY = 400;
export const TOOLTIP_LONG_PRESS = 550;
const HIDE_DELAY = 100;
/** Dialogs and popovers: focus leaving one (it closed) never re-pops the hint of the control focus returns to. */
const DIALOG = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover]';
const richTips = new WeakMap<HTMLElement, TipContent>();
const controllers = new WeakMap<Document, { dispose(): void; refresh(el: HTMLElement): void; point(content: TipContent | undefined, x: number, y: number): void }>();
let nextId = 0;

/** Viewport coordinates, with top placement preferred and every edge kept inside the viewport. */
export function positionTooltip(
  anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  size: { width: number; height: number },
  viewport: { width: number; height: number; left?: number; top?: number },
  gap = 8,
  margin = 8,
): { left: number; top: number; placement: 'top' | 'bottom' } {
  const left = (viewport.left ?? 0) + margin;
  const top = (viewport.top ?? 0) + margin;
  const right = (viewport.left ?? 0) + viewport.width - margin;
  const bottom = (viewport.top ?? 0) + viewport.height - margin;
  const above = anchor.top - gap - top;
  const below = bottom - anchor.bottom - gap;
  const placement = above >= size.height || above >= below ? 'top' : 'bottom';
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, Math.max(min, max)));
  return {
    left: clamp((anchor.left + anchor.right - size.width) / 2, left, right - size.width),
    top: clamp(placement === 'top' ? anchor.top - gap - size.height : anchor.bottom + gap, top, bottom - size.height),
    placement,
  };
}

/** Register safe text or a trusted DOM builder. Non-interactive hints get a keyboard stop. */
export function tip<T extends HTMLElement>(el: T, content: string | TipContent): T {
  if (typeof content === 'string') {
    richTips.delete(el);
    el.dataset.tip = content;
  } else {
    richTips.set(el, content);
    el.dataset.tip = '';
  }
  const controls = 'button, input, select, textarea, a[href], area[href], summary, [contenteditable="true"], [tabindex]';
  if (!el.matches(controls) && !el.closest('[aria-hidden="true"]') && !el.parentElement?.closest(controls)) {
    el.tabIndex = 0;
    // h() builds children before their parents; don't leave a second stop inside a control or decorative subtree.
    if (!el.isConnected) queueMicrotask(() => {
      if (el.tabIndex === 0 && (el.closest('[aria-hidden="true"]') || el.parentElement?.closest(controls))) el.removeAttribute('tabindex');
    });
  }
  installTooltips(el.ownerDocument);
  controllers.get(el.ownerDocument)!.refresh(el);
  return el;
}

/** One delegated layer per document. The disposer also cancels timers and releases ARIA ownership. */
export function installTooltips(doc: Document = document): () => void {
  const existing = controllers.get(doc);
  if (existing) return existing.dispose;
  const win = doc.defaultView!;
  const layer = doc.createElement('div');
  layer.className = 'ac-tooltip';
  layer.id = `ac-tooltip-${++nextId}`;
  layer.setAttribute('role', 'tooltip');
  layer.hidden = true;
  let active: HTMLElement | undefined;
  let pending: HTMLElement | undefined;
  let timer: number | undefined;
  let hideTimer: number | undefined;
  let touch: { id: number; x: number; y: number } | undefined;
  let longPressed = false;
  let ownedDescription = false;
  /** The anchor last clicked or pressed: no hint until the pointer leaves it (or keyboard focus moves elsewhere). */
  let suppressed: HTMLElement | undefined;
  /** The last input was a pointer press: focus that follows (click focus, a popover focusing its field) shows nothing. */
  let pointerInput = false;
  /** The latest focus was inside a dialog or popover. */
  let focusInDialog = false;
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, name: string, handler: (event: Event) => void, capture = false) => {
    target.addEventListener(name, handler, capture);
    listeners.push(() => target.removeEventListener(name, handler, capture));
  };
  const targetOf = (target: EventTarget | null): HTMLElement | undefined => {
    const element = target as Element | null;
    const anchor = element?.closest?.<HTMLElement>('[data-tip]');
    return anchor ?? undefined;
  };
  const clearTimers = () => {
    win.clearTimeout(timer);
    win.clearTimeout(hideTimer);
    timer = hideTimer = undefined;
    pending = undefined;
  };
  const release = () => {
    if (active && ownedDescription) {
      const ids = (active.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== layer.id);
      if (ids.length) active.setAttribute('aria-describedby', ids.join(' '));
      else active.removeAttribute('aria-describedby');
    }
    ownedDescription = false;
  };
  const hide = () => {
    clearTimers();
    observer.disconnect();
    release();
    active = undefined;
    layer.hidden = true;
  };
  const observer = new MutationObserver(() => {
    if ((active && (!active.isConnected || !layer.isConnected)) || (pending && !pending.isConnected)) hide();
  });
  const render = (content: TipContent) => {
    layer.replaceChildren();
    const line = (tag: string, className: string, text: string) => {
      const el = doc.createElement(tag);
      el.className = className;
      el.textContent = text;
      layer.append(el);
    };
    line('strong', 'ac-tooltip-title', content.title);
    if (content.description) line('span', 'ac-tooltip-description', content.description);
    if (content.body) layer.append(content.body());
    if (content.hotkey) line('kbd', 'ac-tooltip-hotkey', content.hotkey);
    if (content.cost) {
      const costs: string[] = [];
      if (content.cost.alloy !== undefined) costs.push(`${content.cost.alloy} alloy`);
      if (content.cost.energy !== undefined) costs.push(`${content.cost.energy} energy`);
      if (costs.length) line('span', 'ac-tooltip-cost', costs.join(' · '));
    }
    if (content.stats) layer.append(content.stats.cloneNode(true));
    if (content.status) line('span', 'ac-tooltip-status', content.status);
  };
  const visible = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.isConnected && !el.closest('[hidden]') && (el.checkVisibility?.() ?? true);
  const openDialogs = () => new Set([...doc.querySelectorAll(DIALOG)].filter(visible));
  /** The anchor last pressed and the dialogs already open then: any newer open dialog is the one it opened. */
  let opener: { el: HTMLElement; before: Set<HTMLElement> } | undefined;
  const press = (el: HTMLElement | undefined) => {
    suppressed = el;
    opener = el && { el, before: openDialogs() };
  };
  /** A dialog or popover the anchor opened is open, or a modal covers the page outside the anchor. */
  const blocked = (el: HTMLElement): boolean => {
    if (el.getAttribute('aria-expanded') === 'true') return true;
    const controls = el.hasAttribute('aria-haspopup') ? (el.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean) : [];
    if (controls.some((id) => visible(doc.getElementById(id)))) return true;
    if (opener?.el === el && [...openDialogs()].some((dialog) => !opener!.before.has(dialog) && !dialog.contains(el))) return true;
    return [...doc.querySelectorAll('[aria-modal="true"], dialog[open]')].some((modal) => (modal.matches('dialog') ? modal.matches(':modal') : visible(modal)) && !modal.contains(el));
  };
  const place = (el: HTMLElement) => {
    const viewport = win.visualViewport;
    const position = positionTooltip(el.getBoundingClientRect(), layer.getBoundingClientRect(), {
      width: viewport?.width ?? win.innerWidth, height: viewport?.height ?? win.innerHeight,
      left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
    });
    layer.style.left = `${position.left}px`;
    layer.style.top = `${position.top}px`;
    layer.dataset.placement = position.placement;
  };
  const show = (el: HTMLElement) => {
    clearTimers();
    if (!el.isConnected || !el.hasAttribute('data-tip') || suppressed?.contains(el) || blocked(el)) return hide();
    const content = richTips.get(el) ?? { title: el.dataset.tip ?? '' };
    if (!content.title && !content.description) return hide();
    release();
    active = el;
    render(content);
    if (!layer.isConnected) doc.body.append(layer);
    layer.hidden = false;
    place(el);
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    ownedDescription = !ids.includes(layer.id);
    if (ownedDescription) el.setAttribute('aria-describedby', [...ids, layer.id].join(' '));
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  };
  const schedule = (el: HTMLElement, delay: number) => {
    if (active === el) { win.clearTimeout(hideTimer); return; }
    if (pending === el || suppressed?.contains(el)) return;
    hide();
    pending = el;
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    timer = win.setTimeout(() => { if (touch) longPressed = true; show(el); }, delay);
  };
  const leave = (event: Event) => {
    const related = (event as MouseEvent).relatedTarget;
    if ((event as PointerEvent).pointerType !== 'touch' && suppressed && !(related instanceof Node && suppressed.contains(related))) suppressed = undefined;
    if ((event as PointerEvent).pointerType === 'touch') return;
    if (related instanceof Node && ((active ?? pending)?.contains(related) || layer.contains(related))) return;
    if (active?.contains(doc.activeElement)) return;
    clearTimers();
    hideTimer = win.setTimeout(hide, HIDE_DELAY);
  };
  listen(doc, 'pointerover', (event) => {
    if ((event as PointerEvent).pointerType === 'touch') return;
    if (layer.contains(event.target as Node)) { win.clearTimeout(hideTimer); return; }
    const el = targetOf(event.target);
    if (el) schedule(el, TOOLTIP_DELAY);
  });
  listen(doc, 'pointerout', leave);
  listen(doc, 'focusin', (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const fromDialog = focusInDialog;
    focusInDialog = !!target?.closest(DIALOG);
    if (suppressed && target && !suppressed.contains(target) && !focusInDialog) suppressed = undefined;
    if (touch) return;
    const el = targetOf(event.target);
    if (el && !pointerInput && !(fromDialog && !el.closest(DIALOG))) show(el);
    else hide();
  });
  listen(doc, 'focusout', (event) => {
    const related = (event as FocusEvent).relatedTarget;
    if (!(related instanceof Node) || !active?.contains(related)) hide();
  });
  listen(doc, 'keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return;
    pointerInput = false;
    if (key === 'Tab' && !doc.activeElement?.closest(DIALOG)) focusInDialog = false;
    if (key === 'Escape') return hide();
    const el = key === 'Enter' || key === ' ' ? targetOf(event.target) : undefined;
    if (el) { hide(); press(el); }
  }, true);
  listen(doc, 'scroll', hide, true);
  listen(win, 'resize', hide);
  listen(win, 'blur', hide);
  if (win.visualViewport) {
    listen(win.visualViewport, 'resize', hide);
    listen(win.visualViewport, 'scroll', hide);
  }
  listen(doc, 'pointerdown', (event) => {
    hide();
    longPressed = false;
    pointerInput = true;
    const pointer = event as PointerEvent;
    touch = undefined;
    if (pointer.pointerType !== 'touch') { press(targetOf(event.target)); return; }
    const el = targetOf(event.target);
    if (!el) return;
    touch = { id: pointer.pointerId, x: pointer.clientX, y: pointer.clientY };
    schedule(el, TOOLTIP_LONG_PRESS);
  }, true);
  listen(doc, 'pointermove', (event) => {
    const pointer = event as PointerEvent;
    if (touch?.id === pointer.pointerId && Math.hypot(pointer.clientX - touch.x, pointer.clientY - touch.y) > 10) {
      touch = undefined;
      hide();
    }
  }, true);
  listen(doc, 'pointerup', () => {
    if (touch && !longPressed) hide();
    touch = undefined;
  }, true);
  listen(doc, 'pointercancel', () => { touch = undefined; hide(); }, true);
  listen(doc, 'click', (event) => {
    if (!longPressed) return;
    longPressed = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  /** A 1px anchor for tips on canvas content (`pointTip`): never hit-tested, moved to the pointer. */
  const pin = doc.createElement('div');
  Object.assign(pin.style, { position: 'fixed', width: '1px', height: '1px', pointerEvents: 'none' });
  const controller = {
    refresh(el: HTMLElement) { if (active === el) show(el); },
    point(content: TipContent | undefined, x: number, y: number) {
      if (!content) {
        if (active === pin || pending === pin) hide();
        return;
      }
      pin.style.left = `${x}px`;
      pin.style.top = `${y}px`;
      if (!pin.isConnected) doc.body.append(pin);
      const changed = richTips.get(pin) !== content;
      richTips.set(pin, content);
      pin.dataset.tip = '';
      if (active !== pin) schedule(pin, TOOLTIP_DELAY);
      else if (changed) show(pin);
      else place(pin);
    },
    dispose() {
      hide();
      for (const remove of listeners) remove();
      layer.remove();
      pin.remove();
      controllers.delete(doc);
    },
  };
  controllers.set(doc, controller);
  return controller.dispose;
}

/**
 * A tooltip for canvas content, which has no DOM anchor: shows `content` at viewport point (x, y) after the usual
 * hover delay and follows later calls; `undefined` hides it. Leaving the canvas hides it like any hint.
 */
export function pointTip(content: TipContent | undefined, x = 0, y = 0, doc: Document = document): void {
  installTooltips(doc);
  controllers.get(doc)!.point(content, x, y);
}

if (typeof document !== 'undefined') installTooltips(document);
