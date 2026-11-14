// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEPLOY_ANYWAY_KEY, PHONE_LINES, PHONE_QUERY, isPhone, mountMobileBanner, phoneBannerDue, sendToDesktop } from '../src/mobile-banner.ts';

interface Screen { pointer: 'coarse' | 'fine'; width: number; height: number }

/** Evaluates the comma-separated `(pointer)`, `(max-width)` and `(max-height)` features the way a browser does. */
function media(screen: Screen) {
  const feature = (text: string): boolean => {
    const [name, value] = text.replace(/[()]/g, '').split(':').map((part) => part.trim());
    if (name === 'pointer') return value === screen.pointer;
    if (name === 'max-width') return screen.width <= parseFloat(value!);
    if (name === 'max-height') return screen.height <= parseFloat(value!);
    throw new Error(`unexpected media feature ${text}`);
  };
  return (query: string) => ({ matches: query.split(',').some((clause) => clause.split(' and ').every((part) => feature(part.trim()))) }) as MediaQueryList;
}

function onScreen(screen: Screen): void {
  vi.stubGlobal('matchMedia', media(screen));
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('phone detection', () => {
  it('flags touch screens narrow in either orientation, not small desktop windows or tablets', () => {
    const cases: [Screen, boolean][] = [
      [{ pointer: 'coarse', width: 390, height: 844 }, true], // iPhone 14 portrait
      [{ pointer: 'coarse', width: 844, height: 390 }, true], // iPhone 14 landscape
      [{ pointer: 'coarse', width: 932, height: 430 }, true], // large phone landscape
      [{ pointer: 'fine', width: 600, height: 700 }, false], // small desktop window
      [{ pointer: 'coarse', width: 1180, height: 820 }, false], // tablet landscape
    ];
    for (const [screen, phone] of cases) {
      onScreen(screen);
      expect(isPhone(), JSON.stringify(screen)).toBe(phone);
    }
    expect(PHONE_QUERY).toContain('(pointer: coarse)');
  });
  it('stays quiet once the player deploys anyway this session', () => {
    onScreen({ pointer: 'coarse', width: 390, height: 844 });
    expect(phoneBannerDue()).toBe(true);
    sessionStorage.setItem(DEPLOY_ANYWAY_KEY, '1');
    expect(phoneBannerDue()).toBe(false);
  });
});

describe('send to desktop', () => {
  const url = 'https://agentcommand.example/?watch=live';
  it('uses the share sheet when it accepts the link', async () => {
    const share = vi.fn(async () => {});
    const copy = vi.spyOn(navigator.clipboard, 'writeText');
    expect(await sendToDesktop(url, { share, canShare: () => true } as unknown as Navigator)).toBe('shared');
    expect(share).toHaveBeenCalledWith({ title: 'Agent Command', url });
    expect(copy).not.toHaveBeenCalled();
  });
  it('treats a dismissed sheet as a choice, not a reason to copy', async () => {
    const copy = vi.spyOn(navigator.clipboard, 'writeText');
    const share = vi.fn(async () => { throw new DOMException('dismissed', 'AbortError'); });
    expect(await sendToDesktop(url, { share } as unknown as Navigator)).toBe('cancelled');
    expect(copy).not.toHaveBeenCalled();
  });
  it('copies the link without the Web Share API, or when sharing is refused', async () => {
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    expect(await sendToDesktop(url, {} as Navigator)).toBe('copied');
    const refused = vi.fn(async () => { throw new DOMException('no', 'NotAllowedError'); });
    expect(await sendToDesktop(url, { share: refused } as unknown as Navigator)).toBe('copied');
    expect(await sendToDesktop(url, { share: vi.fn(), canShare: () => false } as unknown as Navigator)).toBe('copied');
    expect(copy).toHaveBeenCalledTimes(3);
    expect(copy).toHaveBeenCalledWith(url);
  });
});

describe('phone banner', () => {
  const click = (banner: HTMLElement, action: string) => banner.querySelector<HTMLButtonElement>(`[data-mobile-action="${action}"]`)!.click();

  it('keeps the lines short and renders one as a dialog with three tap-sized actions', () => {
    expect(PHONE_LINES.length).toBeGreaterThanOrEqual(6);
    expect(PHONE_LINES.length).toBeLessThanOrEqual(8);
    for (const line of PHONE_LINES) expect(line.length, line).toBeLessThanOrEqual(60);
    const banner = mountMobileBanner({ onWatch: () => {}, pick: () => 0.9999 });
    expect(banner.parentElement).toBe(document.body);
    expect(banner.getAttribute('role')).toBe('dialog');
    expect(banner.querySelector('.mobile-line')?.textContent).toBe(PHONE_LINES.at(-1));
    expect([...banner.querySelectorAll('[data-mobile-action]')].map((button) => button.textContent)).toEqual(['Watch live', 'Send to desktop', 'Deploy anyway']);
    expect(document.activeElement).toBe(banner);
    mountMobileBanner({ onWatch: () => {} });
    expect(document.querySelectorAll('.mobile-banner')).toHaveLength(1);
  });
  it('Watch live closes the card and opens the observer without remembering a dismissal', () => {
    const onWatch = vi.fn();
    const banner = mountMobileBanner({ onWatch });
    click(banner, 'watch');
    expect(onWatch).toHaveBeenCalledOnce();
    expect(banner.isConnected).toBe(false);
    expect(sessionStorage.getItem(DEPLOY_ANYWAY_KEY)).toBeNull();
  });
  it('Deploy anyway closes the card, continues and is remembered for the session', () => {
    onScreen({ pointer: 'coarse', width: 390, height: 844 });
    const onDeploy = vi.fn();
    const banner = mountMobileBanner({ onWatch: () => {}, onDeploy });
    click(banner, 'deploy');
    expect(onDeploy).toHaveBeenCalledOnce();
    expect(banner.isConnected).toBe(false);
    expect(phoneBannerDue()).toBe(false);
  });
  it('Send to desktop sends the current link and toasts a copy', async () => {
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const banner = mountMobileBanner({ onWatch: () => {}, nav: {} as Navigator, url: () => 'https://agentcommand.example/#l=ABCD' });
    click(banner, 'send');
    await vi.waitFor(() => expect(banner.querySelector('.toast.ok')?.textContent).toBe('Link copied. See you on the big screen.'));
    expect(copy).toHaveBeenCalledWith('https://agentcommand.example/#l=ABCD');
    expect(banner.isConnected).toBe(true);
  });
  it('Send to desktop toasts nothing after a successful share', async () => {
    const share = vi.fn(async () => {});
    const banner = mountMobileBanner({ onWatch: () => {}, nav: { share } as unknown as Navigator, url: () => 'https://agentcommand.example/' });
    click(banner, 'send');
    await vi.waitFor(() => expect(share).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(banner.querySelector('.toast')).toBeNull();
  });
});
