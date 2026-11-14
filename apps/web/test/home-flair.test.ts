// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { SPLASHES, poweredBy, socialLinks, withSplash } from '../src/home-flair.ts';

describe('home social badges', () => {
  it('renders only configured http(s) URLs as new-tab links with a name and tooltip', () => {
    const nav = socialLinks([
      { url: ' https://x.com/agentcommandgg ', icon: 'brand_x', name: 'X' },
      { url: '', icon: 'brand_discord', name: 'Discord' },
      { url: 'javascript:alert(1)', icon: 'brand_patreon', name: 'Patreon' },
    ])!;
    const links = [...nav.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    const [x] = links;
    expect(x!.href).toBe('https://x.com/agentcommandgg');
    expect(x!.target).toBe('_blank');
    expect(x!.rel).toBe('noopener noreferrer');
    expect(x!.getAttribute('aria-label')).toBe('Agent Command on X (opens in a new tab)');
    expect(x!.dataset.tip).toBe('Agent Command on X');
    expect(x!.querySelector('svg.icon-brand_x path')?.getAttribute('fill')).toBe('currentColor');
  });
  it('renders nothing when no URL is set', () => {
    expect(socialLinks([{ url: undefined, icon: 'brand_x', name: 'X' }])).toBeUndefined();
  });
});

describe('PlayerThree credit', () => {
  it('links to playerthree.gg in a new tab with a decorative logo, a name and a tooltip', () => {
    const link = poweredBy() as HTMLAnchorElement;
    expect(link.href).toBe('https://playerthree.gg/');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.getAttribute('aria-label')).toBe('Powered by PlayerThree (opens playerthree.gg in a new tab)');
    expect(link.dataset.tip).toContain('playerthree.gg');
    expect(link.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(link.querySelector('.home-p3-text')?.textContent).toBe('Powered by PlayerThree');
  });
});

describe('home splash', () => {
  it('keeps short lines and picks one per call without entering the heading', () => {
    expect(SPLASHES.length).toBeGreaterThanOrEqual(25);
    for (const line of SPLASHES) expect(line.length, line).toBeLessThanOrEqual(48);
    const title = document.createElement('h1');
    const mark = withSplash(title, () => 0.9999);
    expect(mark.firstElementChild).toBe(title);
    expect(mark.querySelector('.home-splash')?.textContent).toBe(SPLASHES.at(-1));
    expect(mark.querySelector('.home-splash')?.getAttribute('aria-hidden')).toBe('true');
    expect(title.textContent).toBe('');
  });
});
