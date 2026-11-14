/**
 * Phone visitors: a toon card over Home and over a direct match entry that points them at the observer, hands the
 * link to a desktop, or lets them deploy anyway. Plain DOM and CSS (no WebGL, no 3D chunk), so it paints before
 * the backdrop and above the HTML loader.
 */
import { copyText, h } from './dom.ts';
import { icon } from './icons.ts';
import './mobile-banner.css';

/**
 * A touch-first screen that is narrow in either orientation. A small desktop window keeps a fine pointer; the
 * height clause catches large phones held landscape (wider than 900 px, never taller than 500 px).
 */
export const PHONE_QUERY = '(pointer: coarse) and (max-width: 900px), (pointer: coarse) and (max-height: 500px)';
/** "Deploy anyway" lasts for the tab's session, so a reload or a match exit doesn't nag again. */
export const DEPLOY_ANYWAY_KEY = 'agent-command.mobile-deploy-anyway';
/** How long the copy confirmation stays up (ms), matching the in-game toasts. */
const TOAST_MS = 2300;
const TOAST_FADE_MS = 500;

/** The C&C advisor, unimpressed. */
export const PHONE_LINES: readonly string[] = [
  'Commander, you brought a phone to an RTS.',
  'Four planes of war. One thumb. Bold.',
  "Your agents can play on a phone. You probably shouldn't.",
  'Tactical advisory: this battlefield needs a mouse.',
  'Insufficient pixels. Construct additional monitors.',
  'Box select with a thumb? Unit lost.',
  'Fat finger detected. Friendly fire likely.',
  "Fall back to a desktop, Commander. We'll hold the line.",
];

export function isPhone(win: Window = window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia(PHONE_QUERY).matches;
}

/** True on a phone until the player picks "Deploy anyway" this session. */
export function phoneBannerDue(win: Window = window): boolean {
  if (!isPhone(win)) return false;
  try { return win.sessionStorage.getItem(DEPLOY_ANYWAY_KEY) !== '1'; } catch { return true; }
}

export type SendResult = 'shared' | 'cancelled' | 'copied' | 'failed';

/** The OS share sheet when it accepts the link (AirDrop, mail, notes…), else the clipboard. */
export async function sendToDesktop(url: string, nav: Navigator = navigator): Promise<SendResult> {
  const data: ShareData = { title: 'Agent Command', url };
  if (typeof nav.share === 'function' && (typeof nav.canShare !== 'function' || nav.canShare(data))) {
    try {
      await nav.share(data);
      return 'shared';
    } catch (error) {
      // Dismissing the sheet is a choice, not a failure; anything else (NotAllowedError…) falls back to copying.
      if ((error as { name?: unknown } | null)?.name === 'AbortError') return 'cancelled';
    }
  }
  return await copyText(url) ? 'copied' : 'failed';
}

export interface MobileBannerOptions {
  onWatch: () => void;
  /** Runs after "Deploy anyway" closes the card (a gated match entry continues here). */
  onDeploy?: () => void;
  /** The link to send; read on tap so it names wherever the player is now. */
  url?: () => string;
  pick?: () => number;
  win?: Window;
  nav?: Navigator;
}

let current: HTMLElement | undefined;

/** Replaces any open banner; it removes itself on Watch live or Deploy anyway. */
export function mountMobileBanner(options: MobileBannerOptions): HTMLElement {
  current?.remove();
  const { win = window, nav = win.navigator, pick = Math.random, url = () => win.location.href } = options;
  const line = PHONE_LINES[Math.floor(pick() * PHONE_LINES.length)] ?? PHONE_LINES[0]!;
  const toasts = h('div', { class: 'toasts' });
  const toast = (text: string, kind: 'ok' | 'err'): void => {
    const slip = h('div', { class: `toast ${kind}`, role: 'status' }, text);
    toasts.replaceChildren(slip);
    win.setTimeout(() => slip.classList.add('out'), TOAST_MS);
    win.setTimeout(() => slip.remove(), TOAST_MS + TOAST_FADE_MS);
  };
  const close = (): void => {
    el.remove();
    if (current === el) current = undefined;
  };
  const send = h('button', {
    type: 'button', class: 'btn', 'data-mobile-action': 'send',
    onclick: () => void sendToDesktop(url(), nav).then((result) => {
      if (result === 'copied') toast('Link copied. See you on the big screen.', 'ok');
      else if (result === 'failed') toast("Couldn't copy the link", 'err');
    }),
  }, icon('desktop', 20), 'Send to desktop');
  const watch = h('button', {
    type: 'button', class: 'btn primary', 'data-mobile-action': 'watch',
    onclick: () => { close(); options.onWatch(); },
  }, icon('spectate', 20), 'Watch live');
  const deploy = h('button', {
    type: 'button', class: 'btn ghost', 'data-mobile-action': 'deploy',
    onclick: () => {
      try { win.sessionStorage.setItem(DEPLOY_ANYWAY_KEY, '1'); } catch { /* Without storage it only lasts this page. */ }
      close();
      options.onDeploy?.();
    },
  }, icon('aggressive', 20), 'Deploy anyway');
  const el = h('div', { class: 'mobile-banner lobby-toon', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mobile-banner-line', tabindex: -1 },
    h('section', { class: 'mobile-card' },
      h('span', { class: 'mobile-badge' }, icon('phone', 30)),
      h('p', { class: 'mobile-line', id: 'mobile-banner-line' }, line),
      h('p', { class: 'mobile-note' }, 'Built for mouse and keyboard.'),
      h('div', { class: 'mobile-actions' }, watch, send, deploy)),
    toasts);
  current = el;
  win.document.body.append(el);
  // The dialog takes focus (keyboard and screen readers land in it) without ringing a button on a touch screen.
  el.focus({ preventScroll: true });
  return el;
}
