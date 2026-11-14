// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountAgentConsole } from '../src/agent-console.ts';

vi.mock('@playerthree/console', () => ({
  createPlayerConsole: vi.fn(() => ({})),
  mountConsolePanel: vi.fn(({ mount }: { mount: HTMLElement }) => {
    const el = document.createElement('aside');
    const close = document.createElement('button');
    close.className = 'playerthree-console__close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close the agent console');
    el.append(close);
    mount.append(el);
    return { el, isOpen: false, open: vi.fn(), close: vi.fn(), toggle: vi.fn(), dispose: vi.fn() };
  }),
}));
afterEach(() => document.body.replaceChildren());

describe('external console host adapter', () => {
  it('uses the same icon and keyboard tooltip as the rest of the UI', () => {
    const panel = mountAgentConsole({ credential: () => undefined, mount: document.body });
    const close = panel.el.querySelector<HTMLButtonElement>('button')!;
    expect(panel.el.querySelector('[title]')).toBeNull();
    expect(close.getAttribute('aria-label')).toBe('Close the agent console');
    expect(close.querySelector('.icon-cancel')).not.toBeNull();
    close.focus();
    expect(close.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.querySelector('[role=tooltip]')?.textContent).toBe('Close the agent console');
  });
});
