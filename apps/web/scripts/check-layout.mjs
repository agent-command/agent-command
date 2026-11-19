// Node >=24. Uses the workspace's existing dev-MCP Playwright installation; no browser download or headed mode.
//
// Isolated environment (shared with check-camera.mjs and check-hud-column.mjs). The Vite proxy rewrites `Host`, so the
// server must admit the Vite origin to join the match:
//   PORT=2578 AC_DEV_ADMIN_TOKEN=card-layout-local-test CORS_ORIGINS=http://127.0.0.1:5188 node apps/server/src/main.ts
//   AC_SERVER_PORT=2578 pnpm --filter @agent-command/web dev --host 127.0.0.1 --port 5188
//   AC_LAYOUT_URL=http://127.0.0.1:5188 AC_LAYOUT_SERVER_URL=http://127.0.0.1:2578 \
//     AC_DEV_ADMIN_TOKEN=card-layout-local-test pnpm --filter @agent-command/web test:layout
// Every plane's command page with selected units, a full queue and feed, console closed and open, across desktop and
// narrow viewports: panel intersections, viewport bounds, scroll reachability of every control and the clear world
// centre. PNGs and a JSON report go to AC_LAYOUT_OUTPUT; `--capture-only` records a baseline without assertions and
// AC_LAYOUT_PREFIX names the capture set; CHROMIUM_PATH selects the browser.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { layoutErrors } from './layout-geometry.ts';

const require = createRequire(new URL('../../../tools/dev-mcp/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const web = process.env.AC_LAYOUT_URL ?? 'http://127.0.0.1:5173';
const server = process.env.AC_LAYOUT_SERVER_URL ?? 'http://127.0.0.1:2567';
const token = process.env.AC_DEV_ADMIN_TOKEN;
assert(token, 'AC_DEV_ADMIN_TOKEN is required: run an isolated dev-admin server for this check.');
const out = process.env.AC_LAYOUT_OUTPUT ?? '/tmp/ac-card';
const captureOnly = process.argv.includes('--capture-only');
const prefix = process.env.AC_LAYOUT_PREFIX ?? (captureOnly ? 'before' : 'after');
const sizes = [[1920, 1080], [1440, 900], [1280, 800], [1024, 768], [1024, 1080], [1366, 768], [900, 650]];
const panels = ['.topbar', '.switcher', '.card', '.queue-panel', '.minimap-box', '.feed', '.playerthree-console'];
const reports = [];
const failures = [];

async function admin(path, body) {
  const res = await fetch(`${server}/dev/matches${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert(res.ok, `dev-admin ${path}: ${res.status} ${await (res.ok ? Promise.resolve('') : res.text())}`);
  return res.json();
}

await mkdir(out, { recursive: true });
const match = await admin('', { mode: 'pvp', seed: 42, speed: 0 });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.goto(`${web}/?renderer=webgl&debug#r=${match.roomId}&t=${match.tokens.blue}`);
  await page.waitForFunction(() => !!window.__agentCommand?.game()?.view);
  await page.evaluate(() => document.fonts.ready);
  // Stress fixtures use the actual component renderers and a paused real match. No fake panel HTML or CSS.
  await page.evaluate(async () => {
    const { productionTabs } = await import('/src/production-tabs.ts');
    const g = window.__agentCommand.game();
    for (const seat of g.seats) if (seat.team === 'blue') seat.controller = 'agent';
    g.renderSwitcher();
    const entries = ['depths', 'surface', 'sky', 'orbit'].flatMap((plane) => productionTabs(plane).flatMap((tab) => tab.items.map((item) => ({ item, plane }))));
    g.view.queue = Array.from({ length: 24 }, (_, i) => ({
      id: `layout_${i}`, ...entries[i % entries.length], by: 'surface', byCtl: 'human', alloy: 120, energy: 0, status: i % 2 ? 'building' : 'waiting', progress: 0.25,
    }));
    g.view.research.inProgress = ['depths', 'surface', 'sky', 'orbit'].flatMap((plane) => productionTabs(plane).filter((tab) => tab.id === 'research').flatMap((tab) => tab.items));
    g.queuePanel.update(g.view);
    g.eventFeed.update(Array.from({ length: 7 }, (_, i) => ({ key: `layout_${i}`, ev: {
      tick: i * 20, kind: 'produced', plane: 'surface', x: 1, y: 2, subject: 'tank', side: 'blue',
    } })), 'blue');
  });
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    for (const plane of ['surface', 'depths', 'sky', 'orbit']) {
      await page.evaluate((plane) => {
        const { world } = window.__agentCommand;
        const g = window.__agentCommand.game();
        g.goTo(plane);
        world.rig.holdDive(1);
        g.renderCard();
      }, plane);
      const categories = await page.locator('.production-tab').evaluateAll((buttons, plane) => buttons.map((button) => button.id.replace(`production-${plane}-`, '')), plane);
      const cardHeight = await page.locator('.card').evaluate((card) => card.getBoundingClientRect().height);
      for (const category of ['selection', ...categories]) {
        await page.evaluate(({ plane, category }) => {
          const { world } = window.__agentCommand;
          const g = window.__agentCommand.game();
          const selected = g.controls.selection.get(plane);
          selected.clear();
          if (category === 'selection') {
            for (const [id, track] of world.entities.tracks) {
              if (track.e.side === 'blue' && track.e.plane === plane && !['spire', 'island', 'asteroid'].includes(track.e.kind)) selected.add(id);
            }
          } else g.productionTabs.state.select(plane, category);
          g.renderCard();
        }, { plane, category });
        // [console open, top bar scope all]: both scopes at every size (the bar narrows to the plane dashboard).
        const states = [[false, false], [true, false], [false, true], [true, true]];
        for (const [open, all] of states) {
          await page.evaluate(([open, all]) => {
            const g = window.__agentCommand.game();
            g.topBar.setScope(all ? 'all' : 'plane');
            const console = g.agentConsole;
            if (open) console.open(); else console.close();
            for (const e of document.querySelectorAll('.hud *')) { e.scrollTop = 0; e.scrollLeft = 0; }
          }, [open, all]);
          // Let font/layout/console rendering, the scope tween and reduced-motion fades settle; not a timing benchmark.
          await page.waitForTimeout(400);
          const label = `${width}x${height}-${plane}-${category}${open ? '-console' : ''}${all ? '-all' : ''}`;
          const measured = await page.evaluate(({ selectors, cardHeight }) => {
            const box = (el, name) => ({ name, ...el.getBoundingClientRect().toJSON() });
            const visible = (el) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
            const roots = selectors.map((s) => document.querySelector(s)).filter((e) => e && visible(e));
            const boxes = roots.map((e) => box(e, e.className));
            const errors = [];
            if (document.querySelectorAll('.qp-row:not(.leaving)').length !== 24) errors.push('full queue fixture was lost');
            if (document.querySelectorAll('.feed .ev:not(.leaving)').length !== 7) errors.push('full event feed fixture was lost');
            const card = document.querySelector('.card').getBoundingClientRect();
            if (Math.abs(card.height - cardHeight) > 0.5) errors.push('switching production tabs changed the card height');
            const top = document.querySelector('.topbar').getBoundingClientRect();
            const rail = document.querySelector('.switcher').getBoundingClientRect();
            const field = document.querySelector('.field-col').getBoundingClientRect();
            const centre = { width: field.left - rail.right - 20, height: card.top - top.bottom - 20 };
            if (centre.width < 300 || centre.height < 150) errors.push(`world centre too small: ${JSON.stringify(centre)}`);
            // A long commander label must yield to the idle count and stance, not escape the rail button.
            for (const label of document.querySelectorAll('.plane-btn .plane-chip, .plane-btn .idle, .plane-btn .stance')) {
              const r = label.getBoundingClientRect();
              const button = label.closest('.plane-btn').getBoundingClientRect();
              if (r.left < button.left || r.right > button.right) errors.push(`rail status outside its button: ${label.textContent}`);
            }
            // A scrollable list/card is intentional. Every control must become fully visible when scrolled to,
            // including the last queue cancellation and the last command; hidden overflow is never accepted.
            for (const root of roots) {
              for (const control of root.querySelectorAll('button, [role="button"], [tabindex]:not([tabindex="-1"]), canvas, .ev')) {
                if (!visible(control)) continue;
                control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                const r = control.getBoundingClientRect();
                const name = control.getAttribute('aria-label') || control.getAttribute('data-tip') || control.textContent?.trim() || control.tagName;
                if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) errors.push(`control outside viewport: ${name}`);
                for (let ancestor = control.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
                  const style = getComputedStyle(ancestor);
                  const a = ancestor.getBoundingClientRect();
                  if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX) && (r.left < a.left - 1 || r.right > a.right + 1)) errors.push(`control clipped horizontally: ${name}`);
                  if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY) && (r.top < a.top - 1 || r.bottom > a.bottom + 1)) errors.push(`control clipped vertically: ${name}`);
                }
              }
            }
            for (const e of document.querySelectorAll('.hud *')) { e.scrollTop = 0; e.scrollLeft = 0; }
            return { boxes, errors: [...new Set(errors)], centre };
          }, { selectors: panels, cardHeight });
          const errors = [...layoutErrors(measured.boxes, width, height), ...measured.errors];
          reports.push({ label, ...measured, errors });
          if (errors.length) failures.push({ label, errors });
          // Each plane changes the command page; retain all variants, not just the easiest empty card.
          await page.screenshot({ path: join(out, `${prefix}-${label}.png`) });
        }
      }
    }
  }
} finally {
  await browser.close();
  await admin(`/${match.roomId}/end`, {});
}
await writeFile(join(out, `${prefix}-layout.json`), JSON.stringify(reports, null, 2));
console.log(`${reports.length} layouts measured; ${failures.length} failures. Screenshots/report: ${out}/${prefix}-*`);
if (captureOnly) console.log(JSON.stringify(failures, null, 2));
else assert.deepEqual(failures, [], 'HUD panels/controls overlap, clip, or leave too little world space');
