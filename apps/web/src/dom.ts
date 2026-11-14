import type { Plane } from '@agent-command/game/contract';
import { tip } from './tooltip.ts';

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | number | false | null | undefined;

/** Tiny DOM builder. Text children are always set as text nodes (never HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.style.cssText = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) el.append(typeof c === 'number' ? String(c) : c);
  if (el.hasAttribute('data-tip')) tip(el, el.dataset.tip ?? '');
  return el;
}

/** Element targets, including SVG icon descendants (duck-typed: test DOMs may lack a global `Element`). */
export function targetElement(target: EventTarget | null): Element | undefined {
  return target && typeof (target as Element).closest === 'function' ? target as Element : undefined;
}

/** Only text-entry controls own all keys; ordinary HUD focus must not pause game shortcuts. */
export function isTextEntry(event: EventTarget | null): boolean {
  const target = targetElement(event);
  if (!target) return false;
  if (target.closest('input, textarea, select')) return true;
  const editable = target.closest('[contenteditable]')?.getAttribute('contenteditable')?.toLowerCase();
  return (target as HTMLElement).isContentEditable === true
    || editable === '' || editable === 'true' || editable === 'plaintext-only';
}

/** Replace children only when the rendered key changes (avoids DOM churn on every view update). */
export function patch(el: HTMLElement, key: string, render: () => Child[]): void {
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(...render().filter((c): c is Node | string => c !== false && c !== null && c !== undefined).map((c) => (typeof c === 'number' ? String(c) : c)));
}

/** Add `steps` classes one at a time until `el` stops overflowing its own box: a fixed panel sheds detail, never scrolls. */
export function fitClasses(el: HTMLElement, steps: readonly string[]): void {
  el.classList.remove(...steps);
  for (const step of steps) {
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) return;
    el.classList.add(step);
  }
}

export function fmt(n: number, digits = 0): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/**
 * Copy to the system clipboard (Clipboard API). Where the API is missing (a non-secure context such as a LAN http
 * address) a hidden, off-screen textarea is copied with `execCommand('copy')`: no prompt or visible field.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none';
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    focused?.focus({ preventScroll: true });
  }
}

/**
 * Each plane is a chapter of the field journal, numbered in stack order (Depths first): the stamped section header
 * on the plane rail, command panel, banner, minimap, lobby, Commanders screen and ready check.
 */
/** Each plane's wash colour: the rail tabs, minimap pages, section stamps, pings and Commanders slots. */
export const PLANE_ACCENT: Record<Plane, string> = { depths: '#ffb347', surface: '#9be36d', sky: '#7fd6ff', orbit: '#c79bff' };

export const PLANE_CHAPTER: Record<Plane, { numeral: string; label: string }> = {
  depths: { numeral: 'I', label: 'I · The Deep' },
  surface: { numeral: 'II', label: 'II · The Front' },
  sky: { numeral: 'III', label: 'III · The Sky' },
  orbit: { numeral: 'IV', label: 'IV · The High Orbit' },
};
