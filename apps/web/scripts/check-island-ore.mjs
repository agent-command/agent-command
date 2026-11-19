// Real World/Entities/ink rendering of controlled public-view disclosures, not substitute island/mineral geometry.
// Uses the shared dev server (http://localhost:5173, never started/stopped here). Run only under flock /tmp/ac-test.lock;
// one page, finite frames, browser closed in finally.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(new URL('../../../tools/dev-mcp/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const out = process.env.AC_ISLAND_ORE_OUTPUT ?? '/tmp/ac-island-ore-art';
const requested = process.env.AC_ISLAND_ORE_RENDERER ?? 'webgl';
await mkdir(out, { recursive: true });
let browser;
const close = async () => { await browser?.close(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await close(); process.exit(124); });
const report = { requested, errors: [], frames: [], note: 'Actual World/Entities/ink rendering; controlled visible-view disclosures, not a live mining-economy run. Screenshots require visual inspection.' };
try {
  const web = process.env.AC_WEB ?? 'http://localhost:5173';
  // The sim needs Node built-ins, so the authoritative fixture view is made here and handed to the page.
  const { createGame } = await import('../../../packages/game/src/index.ts');
  const base = createGame({ seed: 42 }).view('nw', { snapshot: true });
  assert(base.entities.some(e => e.kind === 'island' && e.oreCapacity > 0), 'fixture must start from a genuine ore-bearing island');
  const html = '<link rel="icon" href="data:,"><style>html,body{margin:0;background:#e4ecef}canvas{display:block;width:100vw;height:100vh}p{position:fixed;top:12px;left:12px;margin:0;padding:7px 10px;background:#f4efe0;color:#29354a;font:14px monospace}</style><canvas></canvas><p id="label"></p>';
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'), args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 640 }, reducedMotion: 'no-preference' });
  page.setDefaultTimeout(90000);
  page.on('pageerror', e => report.errors.push(e.message));
  // Sibling edits on the shared dev server must not hot-reload the proof page between captures: the HMR socket is a
  // silent mock that never reaches Vite (closing it would make the client poll and reload).
  await page.routeWebSocket(/./, () => {});
  // The browser's own favicon probe for the plain-text host document is not part of the proof.
  page.on('console', e => { if (e.location().url?.endsWith('/favicon.ico')) return; if (e.type() === 'error' || /shader.*error|validation error/i.test(e.text())) report.errors.push(`${e.text()} ${e.location().url ?? ''}`); });
  // Any same-origin non-app document; replace it with the bare proof page so the full client never boots.
  await page.goto(`${web}/CREDITS.txt`);
  await page.setContent(html);
  await page.evaluate(renderer => history.replaceState(null, '', `/island-ore-proof?renderer=${renderer}`), requested);
  report.backend = await page.evaluate(async base => {
    const [{ World }, { FADE }] = await Promise.all([import('/src/world/world.ts'), import('/src/world/fade.ts')]);
    const w = new World(document.querySelector('canvas'), 48);
    await w.init();
    const island = base.entities.find(e => e.kind === 'island' && e.oreCapacity > 0);
    // A genuine ordinary island, shown beside the ore crag only for the phenotype comparison shot.
    const ordinary = base.entities.find(e => e.kind === 'island' && !(e.oreCapacity > 0));
    base.islands = base.islands.filter(e => e.id === island.id);
    base.entities = []; base.memory = []; base.fx = []; base.impacts = []; base.oreCaches = []; base.rally = [];
    base.weather = { storms: [], forecast: [], fog: [], seeded: [], seedWarnings: [] };
    let tick = 0;
    window.fixture = { w, base, island, FADE };
    window.showOre = async (name, remaining, { reset = false, hidden = false, lowered = false, captured = false, close = false, compare = false } = {}) => {
      if (reset) w.reset();
      const view = structuredClone(base);
      view.tick = ++tick;
      view.vision.sky.fill(hidden ? 0 : 1073741823);
      const e = { ...island, side: captured ? 'se' : 'nw', elevation: lowered ? -8 : 0, oreBuffer: 0 };
      if (remaining === null) { delete e.oreRemaining; delete e.oreBuffer; }
      else e.oreRemaining = remaining;
      const extractor = { id: captured ? 'e_991' : 'e_990', kind: 'ore_extractor', side: e.side, plane: 'sky', x: e.x, y: e.y,
        hp: 160, maxHp: 160, state: 'idle', link: e.id, extractorPowered: true, elevation: e.elevation };
      view.entities = hidden ? [e] : [e, extractor];
      if (compare) view.entities.push({ ...ordinary, side: 'nw', x: e.x - 7, y: e.y + 7, elevation: 0 });
      await w.setView(view);
      // Acceptance is the normal RTS camera; `close` is a lower, nearer detail shot only.
      w.rig.dist = close ? 14 : 30; w.rig.pitch = close ? 0.6 : 1; w.rig.yaw = Math.PI / 4;
      w.rig.lookAtTile(e.x, e.y);
      w.rig.setPreparationPlane('sky', performance.now());
      document.querySelector('#label').textContent = `${name} · Sky · reserve ${remaining === null ? 'not disclosed' : remaining} / ${e.oreCapacity}`;
      for (let i = 0; i < 2; i++) { await new Promise(requestAnimationFrame); w.frame(); }
      const ore = w.entities.root.getObjectByName(`island-ore-${e.id}`), track = w.entities.tracks.get(e.id);
      return { name, focus: w.rig.focus, level: w.rig.level, skyAlpha: FADE.sky.alpha.value, skyFocus: FADE.sky.focus.value,
        cameraDistance: w.rig.dist, count: ore.count, visible: ore.visible, id: ore.uuid,
        position: ore.position.toArray(), islandY: track.wy, localBounds: ore.boundingBox?.isEmpty() ? null : [ore.boundingBox.min.toArray(), ore.boundingBox.max.toArray()],
        matrixVersion: ore.instanceMatrix.version };
    };
    await window.showOre('rich', island.oreCapacity);
    await w.prepareFirstFrame({ planes: ['sky'] });
    return w.backend;
  }, base);
  assert(requested !== 'webgpu' || report.backend === 'WebGPU', 'WebGPU fallback is not WebGPU evidence');
  const capacity = await page.evaluate(() => window.fixture.island.oreCapacity);
  const capture = async (name, remaining, options) => {
    const result = await page.evaluate(([name, remaining, options]) => window.showOre(name, remaining, options), [name, remaining, options]);
    assert.equal(result.focus, 'sky'); assert.equal(result.level, 2);
    assert.equal(result.skyAlpha, 1); assert.equal(result.skyFocus, 1);
    assert.equal(result.cameraDistance, options?.close ? 14 : 30);
    assert.equal(report.errors.length, 0, report.errors.join('\n'));
    await page.screenshot({ path: join(out, `${requested}-${name}.png`) });
    report.frames.push(result);
    return result;
  };
  const rich = await capture('rich', capacity);
  await capture('rich-close', capacity, { close: true });
  await capture('compare-ordinary', capacity, { compare: true });
  const partial = await capture('partial', capacity / 4);
  assert(rich.count > partial.count && partial.count > 0);
  const spent = await capture('depleted', 0);
  await capture('depleted-close', 0, { close: true });
  assert.equal(spent.count, 0);
  const spentUnknown = await capture('spent-unknown-captured', null, { hidden: true, captured: true });
  assert.equal(spentUnknown.id, spent.id); assert.equal(spentUnknown.count, 0);
  const unknown = await capture('unknown-new-view', null, { reset: true, hidden: true });
  assert.notEqual(unknown.id, spent.id); assert.equal(unknown.count, 0);
  const lowered = await capture('lowered-rich', capacity, { reset: true, lowered: true });
  assert(lowered.visible && lowered.count === rich.count);
  assert.equal(lowered.position[1], lowered.islandY);
  assert(lowered.islandY < rich.islandY - 7);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await capture('lowered-reduced-motion', capacity, { lowered: true });
  assert.equal(reduced.count, lowered.count); assert.equal(reduced.matrixVersion, lowered.matrixVersion);
  report.surfaceIsolation = await page.evaluate(async () => {
    const { w, island, FADE } = window.fixture;
    w.rig.setPreparationPlane('surface', performance.now());
    await new Promise(requestAnimationFrame); w.frame();
    return { focus: w.rig.focus, skyAlpha: FADE.sky.alpha.value, visible: w.entities.root.getObjectByName(`island-ore-${island.id}`).visible };
  });
  assert.equal(report.surfaceIsolation.focus, 'surface');
  assert.equal(report.surfaceIsolation.skyAlpha, 0); assert.equal(report.surfaceIsolation.visible, false);
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
} finally {
  try { await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); }
  finally { await close(); }
}
console.log(`Island ore visual proof: ${out}`);
