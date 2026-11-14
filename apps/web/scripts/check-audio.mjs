// Audio smoke against a running server (built client): no AudioContext before a gesture, the engine chunk loads lazily
// with ≤ 1.5 MB of initial audio, audio runs after the first click, real Ogg Opus files decode, the mix persists,
// and a live match streams its beds and effects, all without console errors. Headless Chromium cannot listen: this
// only proves the pipeline. Usage: AC_DEV_ADMIN_TOKEN=… AC_AUDIO_URL=http://127.0.0.1:2567 node scripts/check-audio.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(new URL('../../../tools/dev-mcp/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const web = process.env.AC_AUDIO_URL ?? 'http://127.0.0.1:2567';
const server = process.env.AC_AUDIO_SERVER_URL ?? web;
const token = process.env.AC_DEV_ADMIN_TOKEN;
assert(token, 'AC_DEV_ADMIN_TOKEN is required to create the smoke match');

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
});
const errors = [];
const audioBytes = { before: 0, after: 0 };
/** Body reads in flight (awaited before the byte budget is checked). */
const reads = [];
/** Every audio file URL fetched so far. */
const fetched = new Set();
let gestured = false;
/** Resolves once a file whose URL contains `part` (e.g. `/home1_1`) has been fetched. */
async function streamed(part, ms = 30_000) {
  for (const until = Date.now() + ms; ![...fetched].some((u) => u.includes(part));) {
    assert(Date.now() < until, `${part} was never fetched`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (!r.url().endsWith('.ogg')) return;
    fetched.add(r.url());
    if (!r.ok()) errors.push(`audio ${r.status()} ${r.url()}`);
    else if (r.headers()['content-type'] !== 'audio/ogg') errors.push(`audio content-type ${r.headers()['content-type']} ${r.url()}`);
    const phase = gestured ? 'after' : 'before';
    reads.push(r.body().catch(() => Buffer.alloc(0)).then((b) => { audioBytes[phase] += b.length; }));
  });

  // Waits are generous: they only bound failures, and a loaded machine can stall the page for many seconds.
  // Home: engine chunk loads when idle, but no AudioContext until a gesture.
  // The prefetch starts once the live backdrop is up (or on idle), which can trail networkidle on a busy machine.
  const firstAudio = page.waitForResponse((r) => r.url().endsWith('.ogg'), { timeout: 120_000 });
  firstAudio.catch(() => undefined); // awaited below; an earlier failure must not surface as this rejection
  await page.goto(`${web}/?debug`);
  await page.waitForFunction(() => window.__agentCommandAudio?.().loaded === true, null, { timeout: 120_000 });
  await firstAudio;
  await page.waitForLoadState('networkidle');
  await Promise.all(reads);
  const idle = await page.evaluate(() => window.__agentCommandAudio());
  assert.equal(idle.state, 'none', 'no AudioContext before the first gesture');
  assert(audioBytes.before > 0, 'home theme and interface sounds prefetched after the home is interactive');
  assert(audioBytes.before <= 1.5 * 1024 * 1024, `initial audio ${audioBytes.before} B exceeds 1.5 MB`);

  gestured = true;
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => window.__agentCommandAudio().state === 'running', null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__agentCommandAudio().decoded >= 4, null, { timeout: 60_000 });
  const home = await page.evaluate(() => window.__agentCommandAudio());
  assert.equal(home.scene, 'home');
  assert.equal(home.missing, 0, 'every home sound decoded');
  // Home plays Home II first (the default); the next home theme is Home I, streamed and decoded on demand (the
  // full-pass handover itself is covered by the unit tests: a pass is ~6.5 min)
  // (the title follows the engine's next audio frame, which a busy backdrop can hold up for seconds)
  const homeTitle = () => page.locator('.music-player .mp-title').textContent();
  assert.equal(await homeTitle(), 'Home II');
  await page.locator('.music-player button[aria-label="Next track"]').click();
  await page.waitForFunction(() => document.querySelector('.music-player .mp-title')?.textContent === 'Home I', null, { timeout: 30_000 });
  await streamed('/home1_1');
  assert(await page.evaluate(() => window.__agentCommandMusicProbe('home1')), 'Home I decodes');
  assert.equal((await page.evaluate(() => window.__agentCommandAudio())).missing, 0, 'Home I decoded');
  await page.locator('.music-player button[aria-label="Next track"]').click();
  await page.waitForFunction(() => document.querySelector('.music-player .mp-title')?.textContent === 'Home II', null, { timeout: 30_000 });

  // Settings: the mix persists in localStorage.
  await page.locator('.settings-btn').first().click();
  const slider = page.locator('.settings-slider').nth(1);
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('agent-command.audio') ?? '{}'));
  assert(typeof stored.music === 'number' && stored.music < 0.6, 'music volume persisted');
  await page.keyboard.press('Escape');

  // Lobby / Create Game: its own scene, playing War Room I
  await page.locator('[data-lobby-action="lobby"]').first().click();
  await page.waitForFunction(() => window.__agentCommandAudio().scene === 'lobby', null, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('.music-player .mp-title')?.textContent === 'War Room I', null, { timeout: 30_000 });
  await streamed('/lobby1_1');
  assert(await page.evaluate(() => window.__agentCommandMusicProbe('lobby1')), 'War Room I decodes');
  assert.equal((await page.evaluate(() => window.__agentCommandAudio())).missing, 0, 'War Room I decoded');

  // every streamed multi-part track (first and last streamed file) fetches and decodes, the seven beds of every plane
  // included (before the match, so it stays short and cannot end on its own before the dev-admin end)
  const streamedTracks = ['lobby1', 'lobby2', 'battle_4', 'battle_5', 'battle_6', 'battle_7', 'bed_orbit_4', 'bed_orbit_5', 'bed_orbit_6', 'bed_orbit_7',
    'bed_sky_4', 'bed_sky_5', 'bed_sky_6', 'bed_sky_7', 'bed_surface_4', 'bed_surface_5', 'bed_surface_6', 'bed_surface_7',
    'bed_depths_4', 'bed_depths_5', 'bed_depths_6', 'bed_depths_7', 'sting_victory_1', 'sting_victory_2', 'sting_defeat_1', 'sting_defeat_2'];
  const probes = await page.evaluate(async (ids) => {
    const out = {};
    for (const id of ids) out[id] = await window.__agentCommandMusicProbe(id);
    return out;
  }, streamedTracks);
  const bad = Object.entries(probes).filter(([, ok]) => !ok).map(([id]) => id);
  assert.deepEqual(bad, [], `tracks that did not decode: ${bad.join(', ')}`);

  // Match: create a live one, join by link (no gesture on that navigation), then click the battlefield.
  const response = await fetch(`${server}/dev/matches`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'pvp', seed: 42, speed: 2 }),
  });
  assert(response.ok, `dev-admin create: ${response.status}`);
  const match = await response.json();
  // armies are keyed by id (nw, se, …); play the first one
  const army = match.armies[0].id;
  await page.goto(`${web}/?renderer=webgl&debug#r=${match.roomId}&t=${match.tokens[army]}`);
  await page.waitForFunction(() => !!window.__agentCommand?.game()?.view, null, { timeout: 180_000 });
  // the match scene starts once the first frame is presented (shader warm-up can take a while on a loaded machine)
  await page.waitForFunction(() => !document.documentElement.dataset.loading, null, { timeout: 300_000 });
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => window.__agentCommandAudio().state === 'running' && window.__agentCommandAudio().scene === 'match', null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__agentCommandAudio().decoded >= 30, null, { timeout: 180_000 });
  for (const key of ['F1', 'F2', 'F3', 'F4']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(1500); // let the bed crossfade and the match tick (sounds are not observable headless)
  }
  const live = await page.evaluate(() => window.__agentCommandAudio());
  assert.equal(live.missing, 0, 'every requested sound decoded');
  // the music player follows the focused plane in Auto ("Orbit · 2/7"), or the battle layer near a fight
  const label = await page.locator('.music-player .mp-title').textContent();
  assert.match(label ?? '', /^(Orbit|Sky|Surface|Depths|Battle) · \d\/\d$/, `music player label ${label}`);
  // a dev match end plays one of the outcome's stinger takes
  const end = await fetch(`${server}/dev/matches/${match.roomId}/end`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ winner: army }) });
  assert(end.ok, `dev-admin end: ${end.status}`);
  await page.waitForFunction(() => !!window.__agentCommandAudio().sting, null, { timeout: 60_000 }).catch(async (error) => {
    const why = await page.evaluate(() => {
      const game = window.__agentCommand?.game();
      return { audio: window.__agentCommandAudio(), view: game?.view?.outcome, report: game?.report?.outcome, url: location.href };
    });
    throw new Error(`no sting after the match end: ${JSON.stringify(why)}`, { cause: error });
  });
  const sting = (await page.evaluate(() => window.__agentCommandAudio())).sting;
  assert(['victory', 'sting_victory_1', 'sting_victory_2'].includes(sting), `sting ${sting}`);
  await Promise.all(reads);
  assert.deepEqual(errors, [], errors.join('\n'));
  console.log(`audio ok: initial ${(audioBytes.before / 1024).toFixed(0)} KiB before gesture, ${(audioBytes.after / 1024).toFixed(0)} KiB streamed after; ${live.decoded} sounds decoded, Home II first, lobby scene played War Room I, ${streamedTracks.length} streamed tracks decoded, sting "${sting}" on match end, context ${live.state}, player "${label}", no console errors`);
} finally {
  await browser.close();
}
