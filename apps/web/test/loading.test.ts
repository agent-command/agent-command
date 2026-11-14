// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Loading from '../src/loading.ts';

let loading: typeof Loading;
beforeEach(async () => {
  vi.resetModules();
  const html = new DOMParser().parseFromString(readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8'), 'text/html');
  for (const script of html.querySelectorAll('script')) script.remove();
  document.body.innerHTML = html.body.innerHTML;
  document.documentElement.dataset.loading = 'assets';
  performance.clearMarks();
  // Intentionally exercise the real HTML-first module boundary after its DOM exists.
  loading = await import('../src/loading.ts');
});

describe('progressive HTML loader', () => {
  it('starts with a sized logo, inline critical styles and accessible progress before app JavaScript', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');
    expect(html).toContain('<style>');
    expect(document.querySelector('.load-logo')?.getAttribute('width')).toBe('960');
    expect(document.querySelector('.load-logo')?.getAttribute('height')).toBe('402');
    expect(document.querySelector('.load-logo')?.getAttribute('decoding')).toBe('async');
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
  });

  it('boots on the home menu shell and keeps it through the home fade; a loading screen or error swaps in the card', () => {
    const html = new DOMParser().parseFromString(readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8'), 'text/html');
    expect(html.documentElement.hasAttribute('data-boot')).toBe(true);
    expect(document.querySelector('.shell')?.getAttribute('aria-hidden')).toBeNull();
    expect(document.querySelector('.shell-tiles')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.shell h1 img')?.getAttribute('alt')).toBe('Agent Command');
    expect(document.querySelector('.home-about')?.textContent).toContain('Surface, Depths, Sky and Orbit');
    expect(document.querySelector('.shell-logo')?.getAttribute('width')).toBe('960');
    document.documentElement.dataset.boot = '';
    loading.finishLoading('home');
    expect(document.documentElement.dataset.boot).toBe('');
    expect(document.getElementById('loading')?.inert).toBe(true);
    loading.beginLoading();
    expect(document.documentElement.dataset.boot).toBeUndefined();
    expect(document.getElementById('loading')?.inert).toBe(false);
    document.documentElement.dataset.boot = '';
    loading.failLoading('Terrain failed');
    expect(document.documentElement.dataset.boot).toBeUndefined();
  });

  it("paints the first visit's only backdrop still behind the boot shell, preloaded", () => {
    // poster.ts opens a first visit on the baked still's map; the shell can only match it if there is exactly one.
    const stills = readdirSync(resolve(import.meta.dirname, '../assets/posters')).filter((file) => file.endsWith('.webp'));
    expect(stills).toHaveLength(1);
    const html = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');
    expect(html).toContain(`<link rel="preload" as="image" href="./assets/posters/${stills[0]}" fetchpriority="high" />`);
    expect(html).toContain(`html[data-boot] #loading{background:url(./assets/posters/${stills[0]}) 50%/cover`);
  });

  it('reports real stages without regressing progress and reveals only on completion', () => {
    loading.beginLoading();
    loading.setLoading('world', 0.4, 'Preparing planes');
    expect(document.getElementById('load-stage')?.textContent).toBe('Building world');
    loading.setLoading('connecting', 0.65);
    loading.setLoading('first-frame', 0.9);
    loading.setLoading('first-frame', 0.8);
    expect(document.getElementById('load-fill')?.style.width).toBe('90%');
    expect(document.documentElement.dataset.loading).toBe('first-frame');
    loading.finishLoading('match');
    expect(document.documentElement.dataset.loading).toBeUndefined();
    expect(document.getElementById('loading')?.getAttribute('aria-hidden')).toBe('true');
    expect(performance.getEntriesByName('ac:match-first-frame')).toHaveLength(1);
  });

  it('restarts cleanly and shows a recoverable error without retaining match/watch credentials', () => {
    loading.finishLoading('home');
    loading.beginLoading();
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
    history.replaceState(null, '', '/?watch=live#r=secret');
    loading.failLoading('Terrain failed');
    expect(document.getElementById('loading')?.dataset.stage).toBe('error');
    expect(document.getElementById('load-note')?.textContent).toContain('Terrain failed');
    expect(document.querySelector('#load-note a')?.getAttribute('href')).toBe('/');
  });

  it('offers Try again for a retryable entry, which runs once, beside Return home', () => {
    const retry = vi.fn();
    loading.failLoading('The match did not arrive. It may have ended.', retry);
    expect(document.getElementById('load-stage')?.textContent).toBe('Could not load');
    const again = document.querySelector<HTMLAnchorElement>('#load-note [data-load-action="retry"]')!;
    expect(again.textContent).toBe('Try again');
    expect(document.querySelector('#load-note [data-load-action="home"]')?.textContent).toBe('Return home');
    again.click();
    again.click();
    expect(retry).toHaveBeenCalledOnce();
    loading.beginLoading();
    expect(document.documentElement.dataset.loading).toBe('assets');
  });
});
