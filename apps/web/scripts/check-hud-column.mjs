// Node >=24. The match HUD's right column: the top bar, the docked music player, the commander dispatches slip, the
// build queue and the field map never overlap; dispatches never move or squeeze the queue or the field map; a slip
// with room shows its head and lines; and a dragged player hands its reserved space back. Uses the workspace's
// dev-MCP Playwright installation; headless only. Run in the isolated environment described in check-layout.mjs.
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
const out = process.env.AC_LAYOUT_OUTPUT ?? '/tmp/ac-hud-column';
const captureOnly = process.argv.includes('--capture-only');
const prefix = process.env.AC_LAYOUT_PREFIX ?? (captureOnly ? 'before' : 'after');
const desktop = [[1280, 720], [1440, 900], [1920, 1080]];
// Landscape only: the match HUD's grid is wider than a portrait phone, before and after this column.
const phones = [[844, 390]];
// A slot this tall always fits the slip's head and a line, so a hidden slip there is a bug.
const ROOMY_SLOT = 120;
const reports = [];
const failures = [];

async function admin(path, body) {
  const res = await fetch(`${server}/dev/matches${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert(res.ok, `dev-admin ${path}: ${res.status} ${await (res.ok ? Promise.resolve('') : res.text())}`);
  return res.json();
}

/** Real component renderers on a paused real match: `queue` build entries and `dispatches` chat lines. */
async function fill(page, queue, dispatches) {
  await page.evaluate(async ({ queue, dispatches }) => {
    const { productionTabs } = await import('/src/production-tabs.ts');
    const g = window.__agentCommand.game();
    const planes = ['depths', 'surface', 'sky', 'orbit'];
    const entries = planes.flatMap((plane) => productionTabs(plane).flatMap((tab) => tab.items.map((item) => ({ item, plane }))));
    g.view.queue = Array.from({ length: queue }, (_, i) => ({
      id: `column_${i}`, ...entries[i % entries.length], by: 'surface', byCtl: 'human', alloy: 120, energy: 0, status: i % 2 ? 'building' : 'waiting', progress: 0.25,
    }));
    g.queuePanel.update(g.view);
    g.chatLog.set(Array.from({ length: dispatches }, (_, i) => i % 3 === 0
      ? { from: 'owner', roles: [planes[i % 4]], text: `Hold the ridge and screen the convoy (${i})`, at: i }
      : { from: 'agent', roles: [planes[i % 4]], text: `Copy. Two squads to the north lode, forty seconds out (${i}).`, at: i }));
  }, { queue, dispatches });
  await settle(page);
}

/** Queue slips finish entering and leaving, then two frames for the player's published height to land. */
async function settle(page) {
  await page.waitForFunction(() => !document.querySelector('.qp-row.leaving')
    && document.querySelector('.queue-panel').getAnimations({ subtree: true }).every((a) => a.playState !== 'running'), null, { timeout: 60_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function measure() {
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const rect = (el) => el.getBoundingClientRect().toJSON();
  const player = document.querySelector('.music-player');
  const slip = document.querySelector('.commander-log');
  const slot = document.querySelector('.dispatch-slot');
  const boxes = [{ name: 'top bar', ...rect(document.querySelector('.topbar')) }];
  if (visible(player) && !player.classList.contains('placed')) boxes.push({ name: 'music player', ...rect(player) });
  const slipShown = visible(slip);
  if (slipShown) {
    // The gold tape overhangs the slip's top edge; it must clear the player and the top bar too.
    const tape = parseFloat(getComputedStyle(slip, '::before').top) || 0;
    const b = rect(slip);
    boxes.push({ name: 'dispatches', ...b, top: b.top + Math.min(0, tape) });
  }
  const queue = rect(document.querySelector('.queue-panel'));
  const map = rect(document.querySelector('.minimap-box'));
  boxes.push({ name: 'queue', ...queue }, { name: 'field map', ...map });
  const head = slipShown ? rect(slip.querySelector('.dispatch-head')) : undefined;
  return {
    boxes,
    slipShown,
    headClipped: !!head && head.bottom > rect(slip).bottom + 0.5,
    linesHeight: slipShown ? slip.querySelector('.chat-lines').getBoundingClientRect().height : 0,
    slot: slot ? slot.getBoundingClientRect().height : undefined,
    queue,
    map,
    placed: player?.classList.contains('placed') ?? false,
    reserve: parseFloat(getComputedStyle(document.querySelector('.field-col')).paddingTop),
  };
}

const same = (a, b) => Math.abs(a.top - b.top) <= 0.5 && Math.abs(a.bottom - b.bottom) <= 0.5;

await mkdir(out, { recursive: true });
const match = await admin('', { mode: 'pvp', seed: 42, speed: 0 });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
});

async function open(phone) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce', ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  // Phones get the "best on a computer" banner first; this check plays on.
  if (phone) await context.addInitScript(() => sessionStorage.setItem('agent-command.mobile-deploy-anyway', '1'));
  const page = await context.newPage();
  if (phone) await page.setViewportSize({ width: phones[0][0], height: phones[0][1] });
  await page.goto(`${web}/?renderer=webgl&debug#r=${match.roomId}&t=${match.tokens.nw}`);
  await page.waitForFunction(() => !!window.__agentCommand?.game()?.view && !document.documentElement.dataset.loading, null, { timeout: 240_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

/** One player state at each size: a short, long and full queue, each without and then with dispatches. */
async function check(page, sizes, player) {
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    const label = `${width}x${height}-${player}`;
    const errors = [];
    for (const [queue, dispatches] of [[2, 3], [12, 30], [24, 30]]) {
      const name = `${label}-q${queue}-d${dispatches}`;
      await fill(page, queue, 0);
      const alone = await page.evaluate(measure);
      if (alone.slipShown) errors.push(`${name}: the empty dispatches slip is shown`);
      await fill(page, queue, dispatches);
      const m = await page.evaluate(measure);
      const caseErrors = layoutErrors(m.boxes, width, height);
      if (!same(m.queue, alone.queue)) caseErrors.push(`dispatches moved the queue: ${JSON.stringify([alone.queue.top, alone.queue.bottom])} -> ${JSON.stringify([m.queue.top, m.queue.bottom])}`);
      if (!same(m.map, alone.map)) caseErrors.push(`dispatches moved the field map: ${JSON.stringify([alone.map.top, alone.map.bottom])} -> ${JSON.stringify([m.map.top, m.map.bottom])}`);
      if (!m.slipShown && (m.slot ?? 0) >= ROOMY_SLOT) caseErrors.push(`the slip is hidden in a ${m.slot}px slot`);
      if (m.headClipped) caseErrors.push('the slip head is clipped');
      if (m.slipShown && m.linesHeight < 1) caseErrors.push('the slip shows no line');
      if (m.placed && m.reserve > 0.5) caseErrors.push(`a dragged player still reserves ${m.reserve}px`);
      if (!m.placed && m.reserve < 0.5) caseErrors.push('the docked player reserves no space');
      errors.push(...caseErrors.map((e) => `${name}: ${e}`));
      reports.push({ label: name, ...m });
      await page.screenshot({ path: join(out, `${prefix}-${name}.png`) });
    }
    if (errors.length) failures.push({ label, errors: [...new Set(errors)] });
  }
}

try {
  const { context, page } = await open(false);
  const player = page.locator('.music-player');
  await check(page, desktop, 'docked');
  await player.getByRole('button', { name: 'Track list' }).click();
  await check(page, desktop, 'list');
  await player.getByRole('button', { name: 'Track list' }).click();
  await player.getByRole('button', { name: 'Collapse music player' }).click();
  await check(page, desktop, 'collapsed');
  await player.locator('.mp-grip').click();
  // Drag the open player by its grip into the world: it is `.placed` and the column takes the space back.
  await page.setViewportSize({ width: desktop[0][0], height: desktop[0][1] });
  const grip = await player.locator('.mp-grip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(520, 340, { steps: 8 });
  await page.mouse.up();
  await check(page, desktop, 'placed');
  await context.close();
  const phone = await open(true);
  await check(phone.page, phones, 'phone');
  await phone.context.close();
} finally {
  await browser.close();
  await admin(`/${match.roomId}/end`, {}).catch(() => {});
}
await writeFile(join(out, `${prefix}-hud-column.json`), JSON.stringify(reports, null, 2));
console.log(`${reports.length} layouts measured; ${failures.length} failing cases. Screenshots/report: ${out}/${prefix}-*`);
if (captureOnly) console.log(JSON.stringify(failures, null, 2));
else assert.deepEqual(failures, [], 'the HUD right column overlaps, lets dispatches squeeze the queue or field map, or keeps a stale music player reservation');
