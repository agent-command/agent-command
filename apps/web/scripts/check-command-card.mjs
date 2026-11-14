// Node >=24. Headless command-card fit check: the busiest real selections at the supported resolutions.
// Needs an isolated dev-admin server + vite (AC_LAYOUT_URL / AC_LAYOUT_SERVER_URL / AC_DEV_ADMIN_TOKEN).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(new URL('../../../tools/dev-mcp/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const web = process.env.AC_LAYOUT_URL ?? 'http://127.0.0.1:5173';
const server = process.env.AC_LAYOUT_SERVER_URL ?? 'http://127.0.0.1:2567';
const token = process.env.AC_DEV_ADMIN_TOKEN;
assert(token, 'AC_DEV_ADMIN_TOKEN is required: run an isolated dev-admin server for this check.');
const out = process.env.AC_LAYOUT_OUTPUT ?? '/tmp/ac-card';
const captureOnly = process.argv.includes('--capture-only');
const prefix = process.env.AC_LAYOUT_PREFIX ?? (captureOnly ? 'before' : 'after');
const sizes = [[1024, 768], [1280, 800], [1920, 1080]];
/** The busiest selections per plane; `abilities` must render as ability tiles, never hidden. */
const scenarios = [
  { name: 'orbit-fleet', plane: 'orbit', abilities: ['sun_lance', 'aegis', 'deorbit', 'scan'] },
  { name: 'orbit-cooldown', plane: 'orbit', cooldown: true, abilities: ['sun_lance', 'aegis', 'deorbit', 'scan'] },
  { name: 'depths-crews', plane: 'depths', abilities: ['undermine', 'breach', 'rail', 'bridge', 'geothermal', 'scan'] },
  { name: 'surface-army', plane: 'surface', abilities: ['scan'] },
  { name: 'sky-wing', plane: 'sky', abilities: ['ascend', 'scan'] },
];
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
const cheat = (body) => admin(`/${match.roomId}/cheat`, body);
await cheat({ op: 'give', team: 'blue', alloy: 5000, energy: 5000 });
const spawn = (kind, count, x, y, plane) => cheat({ op: 'spawn', team: 'blue', kind, count, x, y, ...(plane ? { plane } : {}) });
for (const [kind, count] of [['lancer', 3], ['bastion', 2], ['tug', 2], ['skiff', 4], ['solar', 1]]) await spawn(kind, count, 8, 8);
for (const [kind, count] of [['digger', 4], ['sapper', 3], ['trooper', 3]]) await spawn(kind, count, 4.5, 6.5, 'depths');
for (const [kind, count] of [['tank', 4], ['trooper', 4], ['flak', 2]]) await spawn(kind, count, 9, 9);
for (const [kind, count] of [['interceptor', 4], ['bomber', 2]]) await spawn(kind, count, 9, 9);
await admin(`/${match.roomId}/step`, { ticks: 2 });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.goto(`${web}/?renderer=webgl&debug#r=${match.roomId}&t=${match.tokens.blue}`);
  await page.waitForFunction(() => !!window.__agentCommand?.game()?.view && !document.documentElement.dataset.loading, undefined, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    for (const scenario of scenarios) {
      // Real renderers on a paused real match; research and tow/cooldown state are set on the client snapshot only.
      const selectedCount = await page.evaluate(({ plane, cooldown }) => {
        const { world } = window.__agentCommand;
        const g = window.__agentCommand.game();
        for (const id of ['aegis_projectors', 'ascent_thrusters', 'night_cloak', 'lancer_lens']) if (!g.view.research.completed.includes(id)) g.view.research.completed.push(id);
        g.goTo(plane);
        world.rig.holdDive(1);
        const selected = g.controls.selection.get(plane);
        selected.clear();
        let tug = false;
        for (const [id, track] of world.entities.tracks) {
          const e = track.e;
          if (e.side !== 'blue' || e.plane !== plane || ['spire', 'island', 'asteroid'].includes(e.kind)) continue;
          selected.add(id);
          if (e.kind === 'tug' && !tug) { tug = true; e.state = 'towing'; }
          if (e.kind === 'lancer' || e.kind === 'bastion') e.abilityReady = cooldown ? g.view.tick + 20 * 12 : 0;
        }
        g.view.res.scanReadyAt = cooldown ? g.view.tick + 20 * 9 : 0;
        g.renderCard();
        return selected.size;
      }, scenario);
      await page.waitForTimeout(250);
      const label = `${width}x${height}-${scenario.name}`;
      const measured = await page.evaluate(() => {
        const card = document.querySelector('.card');
        const c = card.getBoundingClientRect();
        const errors = [];
        const visible = (el) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        const name = (el) => el.getAttribute('aria-label') || el.getAttribute('data-tip') || el.textContent?.trim() || el.className || el.tagName;
        // Nothing on the card may scroll: a scrollable box that actually overflows hides commands.
        for (const el of [card, ...card.querySelectorAll('*')]) {
          if (!visible(el)) continue;
          const style = getComputedStyle(el);
          if (['auto', 'scroll'].includes(style.overflowY) && el.scrollHeight > el.clientHeight + 1) errors.push(`scrolls vertically: ${el.className}`);
          if (['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1) errors.push(`scrolls horizontally: ${el.className}`);
        }
        // Every control and status chip is fully inside the card and every clipping ancestor, without scrolling.
        for (const el of card.querySelectorAll('button, [role="button"], [tabindex]:not([tabindex="-1"]), .hud-cost, .ability-key, .num')) {
          if (!visible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.left < c.left - 0.5 || r.top < c.top - 0.5 || r.right > c.right + 0.5 || r.bottom > c.bottom + 0.5) errors.push(`outside the card: ${name(el)}`);
          for (let a = el.parentElement; a && a !== card.parentElement; a = a.parentElement) {
            const style = getComputedStyle(a);
            const b = a.getBoundingClientRect();
            if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX) && (r.left < b.left - 1 || r.right > b.right + 1)) { errors.push(`clipped horizontally: ${name(el)}`); break; }
            if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY) && (r.top < b.top - 1 || r.bottom > b.bottom + 1)) { errors.push(`clipped vertically: ${name(el)}`); break; }
          }
        }
        const tools = [...document.querySelectorAll('.card [data-action], .card-more [data-action]')].map((el) => ({ tool: el.dataset.action, group: el.closest('[data-group]')?.dataset.group }));
        return { card: c.toJSON(), errors: [...new Set(errors)], tools };
      });
      const errors = [...measured.errors];
      if (selectedCount < 6) errors.push(`selection fixture lost: ${selectedCount} units`);
      if (!captureOnly) {
        for (const id of scenario.abilities) {
          const tile = measured.tools.find((t) => t.tool === id);
          if (!tile) errors.push(`missing ability: ${id}`);
          else if (tile.group !== 'abilities' && tile.group !== 'more') errors.push(`${id} is not grouped as an ability`);
        }
        for (const t of measured.tools) if (['move', 'amove', 'stop', 'hold', 'patrol'].includes(t.tool) && t.group === 'abilities') errors.push(`${t.tool} is grouped as an ability`);
      }
      reports.push({ label, selectedCount, ...measured, errors });
      if (errors.length) failures.push({ label, errors });
      await page.screenshot({ path: join(out, `${prefix}-${label}.png`) });
      await page.screenshot({ path: join(out, `${prefix}-${label}-card.png`), clip: measured.card });
    }
  }
} finally {
  await browser.close();
  await admin(`/${match.roomId}/end`, {});
}
await writeFile(join(out, `${prefix}-card.json`), JSON.stringify(reports, null, 2));
console.log(`${reports.length} command cards measured; ${failures.length} failures. Screenshots/report: ${out}/${prefix}-*`);
if (captureOnly) console.log(JSON.stringify(failures, null, 2));
else assert.deepEqual(failures, [], 'command card controls scroll, clip or are missing');
