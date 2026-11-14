import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Screenshots, type ShotRequest } from '../src/screenshot.ts';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright-core', () => ({ chromium: { launch } }));

const png = Buffer.from('screenshot');
let currentUrl = '';
const page = {
  isClosed: vi.fn(() => false),
  viewportSize: vi.fn(() => ({ width: 1280, height: 720 })),
  url: vi.fn(() => currentUrl),
  goto: vi.fn(async (url: string) => { currentUrl = url; }),
  evaluate: vi.fn(async <T, A>(fn: (arg: A) => T, arg: A): Promise<T> => fn(arg)),
  waitForFunction: vi.fn(async (ready: () => boolean) => { expect(ready()).toBe(true); }),
  waitForTimeout: vi.fn(async () => {}),
  screenshot: vi.fn(async () => png),
  close: vi.fn(async () => {}),
  locator: vi.fn(() => ({ first: () => toggle })),
};
const toggle = { waitFor: vi.fn(async () => {}), dispatchEvent: vi.fn(async () => {}) };
const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
const req: ShotRequest = { roomId: 'test-room', token: 'owner-token', viewer: 'nw', plane: 'surface', width: 1280, height: 720, waitMs: 100, hud: true };
let debug: NonNullable<Window['__agentCommand']>;
let shots: Screenshots;

beforeEach(() => {
  vi.clearAllMocks();
  currentUrl = '';
  debug = {
    world: { size: 48, view: { tick: 42, army: 'nw' }, rig: { dist: 30, lookAtTile: vi.fn(), holdDive: vi.fn() } },
    game: () => ({ goTo: vi.fn() }),
  };
  vi.stubGlobal('window', { __agentCommand: debug });
  vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
  launch.mockResolvedValue(browser);
  shots = new Screenshots('http://localhost:5000', '/test/chromium');
});
afterEach(async () => {
  await shots.close();
  vi.unstubAllGlobals();
});

describe('screenshots through the web debug hook', () => {
  it('waits for both an active game and the rendered world view', async () => {
    page.waitForFunction.mockImplementationOnce(async (ready) => {
      vi.stubGlobal('window', {});
      expect(ready()).toBe(false);
      const game = debug.game;
      debug.game = () => undefined;
      vi.stubGlobal('window', { __agentCommand: debug });
      expect(ready()).toBe(false);
      debug.game = game;
      debug.world.view = undefined;
      expect(ready()).toBe(false);
      debug.world.view = { tick: 42, army: 'nw' };
      expect(ready()).toBe(true);
    });

    expect(await shots.shoot(req)).toEqual({ png, tick: 42, army: 'nw' });
    expect(page.goto).toHaveBeenCalledWith('http://localhost:5000/?renderer=webgl&debug#r=test-room&t=owner-token', { waitUntil: 'load' });
    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), undefined, { timeout: 20_000 });
  });

  it.each(['depths', 'surface', 'sky', 'orbit'] as const)('captures %s without a private game view', async (plane) => {
    const game = { goTo: vi.fn() };
    debug.game = () => game;

    expect(await shots.shoot({ ...req, plane })).toEqual({ png, tick: 42, army: 'nw' });
    expect(game.goTo).toHaveBeenCalledWith(plane);
    expect(debug.world.rig.holdDive).toHaveBeenNthCalledWith(1, 1);
    expect(debug.world.rig.holdDive).toHaveBeenLastCalledWith(undefined);
    expect(page.screenshot).toHaveBeenCalledWith({ type: 'png' });
    expect(launch).toHaveBeenCalledWith({
      headless: true,
      executablePath: '/test/chromium',
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
    });
  });

  it.each([48, 64, 80])('scales zoom bounds to the %s-tile match', async (size) => {
    debug.world.size = size;
    await shots.shoot({ ...req, zoom: 2 });
    expect(debug.world.rig.dist).toBe(15 * size / 48);
  });

  it('returns the captured world tick and army rather than stale private game metadata', async () => {
    const game = { goTo: vi.fn(), view: { tick: 1, army: 'nw' } };
    debug.game = () => game;
    page.screenshot.mockImplementationOnce(async () => {
      debug.world.view = { tick: 81, army: 'se' };
      return png;
    });

    expect(await shots.shoot(req)).toEqual({ png, tick: 81, army: 'se' });
  });

  it('switches a spectator to the requested army through the client\'s per-army perspective toggle', async () => {
    await shots.shoot({ ...req, viewer: 'spectator', army: 'sw' });
    expect(page.locator).toHaveBeenCalledWith('.team-toggle button[data-army="sw"]');
    expect(toggle.dispatchEvent).toHaveBeenCalledWith('click');
  });
});
