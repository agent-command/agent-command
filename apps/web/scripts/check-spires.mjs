// Controlled view snapshots through the real World/Entities/ink renderer, not replacement scene geometry.
// Requires the already-running dev server (AC_SPIRE_URL, default http://localhost:5173); run only inside the parent-granted resource slot.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The routed proof document is not a Vite page: its HMR socket is refused by Chromium's local-network checks. That is
// harness noise, not a render error; HMR is irrelevant to a finite proof.
const hmrNoise = /\[vite\]|WebSocket connection to 'ws:|Failed to send error to Vite/;
const require = createRequire(new URL('../../../tools/dev-mcp/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const web = process.env.AC_SPIRE_URL ?? 'http://localhost:5173';
const fs = `/@fs${fileURLToPath(new URL('../../../', import.meta.url))}`; // repo root as Vite serves it
const out = process.env.AC_SPIRE_OUTPUT ?? '/tmp/ac-spires';
const backends = (process.env.AC_SPIRE_BACKENDS ?? 'webgl,webgpu').split(',');
const cases = process.env.AC_SPIRE_CASES?.split(',');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'), args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'] });
// The simulation hashes with node:crypto; produce the real transport snapshot on the Node side.
const { createGame } = await import(new URL('../../../packages/game/src/index.ts', import.meta.url).href);
const snapshot = createGame({ seed: 42 }).view('nw', { snapshot: true });
snapshot.fx = []; snapshot.impacts = [];
const report = [];
try {
  for (const requested of backends) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(120000);
    const errors = [], samples = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if ((e.type() === 'error' || /shader.*error|validation error/i.test(e.text())) && !hmrNoise.test(e.text())) errors.push(e.text()); });
    await page.route('**/spire-proof?*', route => route.fulfill({ contentType: 'text/html', body: '<style>html,body{margin:0}canvas{display:block;width:100vw;height:100vh}</style><canvas></canvas>' }));
    await page.goto(`${web}/spire-proof?renderer=${requested}`);
    const backend = await page.evaluate(async ({ fs, base }) => {
      const [{ World }, contract] = await Promise.all([
        import('/src/world/world.ts'), import(`${fs}packages/game/src/rules/contract.ts`),
      ]);
      const w = new World(document.querySelector('canvas'), 48);
      await w.init();
      window.fixture = { w, base, contract };
      await w.setView(base);
      await w.prepareFirstFrame();
      return w.backend;
    }, { fs, base: snapshot });
    if (requested === 'webgpu' && backend !== 'WebGPU') {
      report.push({ requested, backend, skipped: 'WebGPU unavailable; fallback is not WebGPU evidence', errors });
      await page.close();
      continue;
    }
    const scenarios = [
      ...['depths', 'surface', 'sky', 'orbit'].flatMap(plane => ['healthy', 'damaged', 'dead'].map(state => ({ plane, state, name: `${plane}-${state}` }))),
      ...[12, 60].map(dist => ({ plane: 'surface', state: 'healthy', dist, name: `surface-distance-${dist}` })),
      ...[-2, 0, 2].map(cross => ({ plane: 'surface', state: 'healthy', cross, dist: 12, name: `crossing-${cross}` })),
      ...[1.5, 2.5].map(level => ({ plane: level < 2 ? 'sky' : 'orbit', state: 'healthy', level, name: `transition-${level}` })),
      ...['eliminated', 'reset', 'hidden-damage', 'hidden-death', 'reduced'].map(state => ({ plane: 'sky', state, name: state })),
    ];
    if (cases) assert(cases.every(name => scenarios.some(scenario => scenario.name === name)), 'unknown Spire proof case');
    for (const scenario of scenarios.filter(scenario => !cases || cases.includes(scenario.name))) {
      // AC_SPIRE_DIST frames every non-distance case closer (or further) than the default 30-tile camera.
      scenario.defaultDist = Number(process.env.AC_SPIRE_DIST ?? 30);
      // AC_SPIRE_YAW (radians) turns the camera, for frames that show reflections moving between facets.
      scenario.yawOffset = Number(process.env.AC_SPIRE_YAW ?? 0);
      await page.emulateMedia({ reducedMotion: scenario.state === 'reduced' ? 'reduce' : 'no-preference' });
      const result = await page.evaluate(async scenario => {
        const { w, base, contract } = window.fixture;
        w.reset(); await w.setView(structuredClone(base));
        const own = base.match.armies.find(a => a.id === 'nw');
        const view = structuredClone(base); view.tick = 2;
        const hidden = scenario.state.startsWith('hidden');
        let army = 'nw', at = own.spireAt;
        if (hidden) {
          army = 'se'; at = base.match.armies.find(a => a.id === army).spireAt;
          const source = view.entities.find(e => e.kind === 'spire' && e.plane === scenario.plane);
          const seen = { ...source, id: 'proof-enemy', side: army, ...at };
          view.entities.push(seen); view.vision[scenario.plane].fill(1073741823);
          await w.setView(view);
          view.tick = 3; view.entities = view.entities.filter(e => e.id !== seen.id); view.vision[scenario.plane].fill(0);
          // No health/death field crosses fog: the next picture must retain the previous shape.
        } else if (scenario.state === 'damaged' || scenario.state === 'dead' || scenario.state === 'reduced') {
          const hp = scenario.state === 'dead' ? 0 : 0.3;
          const segment = view.spire.find(s => s.plane === scenario.plane);
          segment.hp = segment.maxHp * hp;
          for (const e of view.entities) if (e.kind === 'spire' && e.side === army && e.plane === scenario.plane) e.hp = e.maxHp * hp;
          if (!hp) {
            view.entities = view.entities.filter(e => !(e.kind === 'spire' && e.side === army && e.plane === scenario.plane));
            view.fx = [{ kind: 'death', subject: 'spire', side: army, plane: scenario.plane, tick: 2, ...at }];
          }
        } else if (scenario.state === 'eliminated') {
          view.eliminated = [army]; view.entities = view.entities.filter(e => e.side !== army);
        }
        await w.setView(view);
        const lobby = scenario.state === 'reset';
        if (lobby) {
          w.entities.spires.ingest({ ...view, eliminated: [army] });
          w.entities.spires.frame(view.tick, 1, false, false);
          w.reset();
        }
        w.rig.level = scenario.level ?? contract.PLANES.indexOf(scenario.plane);
        w.rig.focus = scenario.plane; w.rig.dist = scenario.dist ?? scenario.defaultDist;
        w.rig.yaw = Math.PI * 1.25 + scenario.yawOffset; w.rig.pitch = 1;
        w.rig.lookAtTile(at.x, at.y);
        if (scenario.cross !== undefined) {
          w.rig.tx -= Math.cos(w.rig.yaw) * Math.cos(w.rig.pitch) * w.rig.dist;
          w.rig.tz -= Math.sin(w.rig.yaw) * Math.cos(w.rig.pitch) * w.rig.dist;
          w.rig.tx += scenario.cross;
        }
        const update = [], render = [];
        for (let i = 0; i < 6; i++) {
          const start = performance.now(); w.frame(false);
          // Pin snapshot time at its authoritative boundary; presentation clocks otherwise interpolate live views.
          w.entities.spires.frame(view.tick, 1, scenario.state === 'reduced', lobby);
          w.combat.frame(performance.now(), 0, w.rig.camera.position.y, view.tick);
          const middle = performance.now();
          w.renderer.setRenderTarget(null); w.renderer.setMRT(null); w.pipeline.render();
          update.push(middle - start); render.push(performance.now() - middle);
          await new Promise(requestAnimationFrame);
        }
        const core = w.entities.spires.root.getObjectByName(`spire-${army}-${scenario.plane}-core`);
        const links = w.entities.spires.shaderTemplates.filter(m => m.name.startsWith(`spire-${army}-`) && m.name.endsWith('-link'));
        const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
        return { name: scenario.name, coreVisible: core.visible, visibleLinks: links.filter(m => m.visible).length,
          depthTest: links.every(m => m.material.depthTest), depthWrite: links.some(m => m.material.depthWrite),
          updateCpuMs: mean(update), renderSubmissionCpuMs: mean(render), camera: w.rig.camera.position.toArray() };
      }, scenario);
      await page.screenshot({ path: join(out, `${requested}-${scenario.name}${process.env.AC_SPIRE_DIST ? `-d${process.env.AC_SPIRE_DIST}` : ''}${process.env.AC_SPIRE_YAW ? `-y${process.env.AC_SPIRE_YAW}` : ''}.png`) });
      assert(result.depthTest && !result.depthWrite, 'connectors must be ordinarily occluded without writing transparent depth');
      if (scenario.state === 'dead' || scenario.state === 'eliminated') assert(!result.coreVisible, 'dead core remained visible');
      if (scenario.state === 'eliminated') assert.equal(result.visibleLinks, 0);
      if (scenario.state.startsWith('hidden')) assert(result.coreVisible, 'fog absence invented a death');
      samples.push(result);
    }
    report.push({ requested, backend, errors, samples, note: 'Controlled view fixtures; screenshots require visual inspection. CPU submission timings are not GPU timings or an isolated Spire benchmark.' });
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.close();
  }
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`Spire render proof: ${out}`);
