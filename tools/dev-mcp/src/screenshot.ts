/**
 * Screenshots of the real web client joined to a match: headless Chromium (playwright-core), one persistent page per
 * match and viewer so repeated shots are fast. The client is driven through its `?debug` hook
 * (`window.__agentCommand = { world, game() }`) and forced onto WebGL2 (`?renderer=webgl`; headless WebGPU has no
 * readback on WSL/most CI).
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import type { ArmyId, Plane } from '@agent-command/game/contract';
import type { Viewer } from './watch.ts';

const CHROME_ARGS = ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'];
const HUD_STYLE_ID = 'devmcp-hide-hud';
/** CameraRig default distance (apps/web/src/world/camera.ts) and its zoom clamp. */
const BASE_DIST = 30;
const MIN_DIST = 12;
const MAX_DIST = 78;

export interface ShotRequest {
  roomId: string;
  token: string;
  viewer: Viewer;
  /** Spectators: whose view to show. */
  army?: ArmyId;
  plane: Plane;
  x?: number;
  y?: number;
  /** 1 = default camera distance; 2 = twice as close. */
  zoom?: number;
  width: number;
  height: number;
  waitMs: number;
  hud: boolean;
}

export interface Shot {
  png: Buffer;
  tick: number;
  army: string;
}

/** The parts of the web client's debug hook (apps/web/src/play.ts, `?debug`) used here. */
interface Debug {
  world: {
    size: number;
    view: { tick: number; army: string } | undefined;
    rig: { dist: number; lookAtTile(x: number, y: number): void; holdDive(k: number | undefined): void };
  };
  game(): { goTo(p: Plane): void } | undefined;
}

declare global {
  interface Window {
    __agentCommand?: Debug;
  }
}

export class Screenshots {
  readonly webUrl: string;
  readonly executablePath: string | undefined;
  #browser: Promise<Browser> | undefined;
  readonly #pages = new Map<string, Page>();

  constructor(webUrl: string, executablePath?: string) {
    this.webUrl = webUrl.replace(/\/+$/, '');
    this.executablePath = executablePath;
  }

  #launch(): Promise<Browser> {
    // Full Chromium (`channel: 'chromium'`, new headless) rather than the headless shell: it has the WebGL stack.
    const binary = this.executablePath ? { executablePath: this.executablePath } : { channel: 'chromium' };
    this.#browser ??= chromium.launch({ headless: true, args: CHROME_ARGS, ...binary }).catch((e: unknown) => {
      this.#browser = undefined;
      throw e;
    });
    return this.#browser;
  }

  async #page(req: ShotRequest): Promise<Page> {
    const key = `${req.roomId}:${req.viewer}`;
    let page = this.#pages.get(key);
    if (page?.isClosed()) page = undefined;
    if (!page) {
      const browser = await this.#launch();
      page = await browser.newPage({ viewport: { width: req.width, height: req.height } });
      this.#pages.set(key, page);
    } else if (page.viewportSize()?.width !== req.width || page.viewportSize()?.height !== req.height) {
      await page.setViewportSize({ width: req.width, height: req.height });
    }
    // (Re)join when new, or when the client fell back to the lobby (match ended and the room closed).
    const hash = `#r=${encodeURIComponent(req.roomId)}&t=${encodeURIComponent(req.token)}`;
    const joined = await page.evaluate(() => !!window.__agentCommand?.game()).catch(() => false);
    if (!joined || !page.url().endsWith(hash)) {
      await page.goto(`${this.webUrl}/?renderer=webgl&debug${hash}`, { waitUntil: 'load' });
    }
    await page.waitForFunction(() => {
      const dbg = window.__agentCommand;
      return !!(dbg?.game() && dbg.world.view);
    }, undefined, { timeout: 20_000 });
    return page;
  }

  async shoot(req: ShotRequest): Promise<Shot> {
    const page = await this.#page(req);
    if (req.army && req.viewer === 'spectator') {
      // The spectator perspective toggle (one button per army) is the client's own UI for switching views.
      const toggle = page.locator(`.team-toggle button[data-army="${req.army}"]`).first();
      await toggle.waitFor({ state: 'attached', timeout: 10_000 });
      // dispatchEvent: the HUD re-renders with every view, so actionability checks (stable/visible) would keep retrying.
      await toggle.dispatchEvent('click');
    }
    await page.evaluate(
      ({ plane, x, y, zoom, baseDist, minDist, maxDist, hide, styleId }) => {
        const dbg = window.__agentCommand!;
        const rig = dbg.world.rig;
        dbg.game()!.goTo(plane);
        rig.holdDive(1); // land on the plane immediately instead of animating the dive
        if (x !== undefined && y !== undefined) rig.lookAtTile(x, y);
        if (zoom !== undefined) {
          const scale = dbg.world.size / 48;
          rig.dist = Math.min(maxDist * scale, Math.max(minDist * scale, baseDist * scale / zoom));
        }
        const style = document.getElementById(styleId);
        if (hide && !style) document.head.append(Object.assign(document.createElement('style'), { id: styleId, textContent: '.hud { display: none !important; }' }));
        if (!hide) style?.remove();
      },
      {
        plane: req.plane,
        x: req.x,
        y: req.y,
        zoom: req.zoom,
        baseDist: BASE_DIST,
        minDist: MIN_DIST,
        maxDist: MAX_DIST,
        hide: !req.hud,
        styleId: HUD_STYLE_ID,
      },
    );
    await page.waitForTimeout(Math.max(100, req.waitMs));
    await page.evaluate(() => window.__agentCommand!.world.rig.holdDive(undefined));
    const png = await page.screenshot({ type: 'png' });
    const info = await page.evaluate(() => {
      const { tick, army } = window.__agentCommand!.world.view!;
      return { tick, army };
    });
    return { png, ...info };
  }

  /** Drop pages of matches that are gone. */
  async forget(roomId: string): Promise<void> {
    for (const [key, page] of this.#pages) {
      if (!key.startsWith(`${roomId}:`)) continue;
      this.#pages.delete(key);
      await page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const b = this.#browser;
    this.#browser = undefined;
    this.#pages.clear();
    if (b) await (await b.catch(() => undefined))?.close();
  }
}
