// One page, one backend, finite frames. Real World/Entities/FieldMesh/ink renderer, controlled visible views.
// Run only in an authorized slot under flock /tmp/ac-test.lock, against the already-running dev server (AC_SELECTION_URL).
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
const web = process.env.AC_SELECTION_URL ?? 'http://localhost:5173';
const fs = `/@fs${fileURLToPath(new URL('../../../', import.meta.url))}`; // repo root as Vite serves it
const html = '<link rel="icon" href="data:,"><style>html,body{margin:0;background:#e4dfce}canvas{display:block;width:100vw;height:100vh}p{position:fixed;top:8px;left:8px;margin:0;padding:6px;background:#eee9d9;color:#302a23;font:14px monospace}</style><canvas></canvas><p id="label"></p>';
const out = process.env.AC_SELECTION_OUTPUT ?? '/tmp/ac-selection-contours';
const requested = process.env.AC_SELECTION_RENDERER ?? 'webgl';
const focused = process.env.AC_SELECTION_FOCUSED === '1';
const diagnostic = process.env.AC_SELECTION_DIAGNOSTIC === '1';
const metadataOnly = process.env.AC_SELECTION_METADATA === '1';
// AC_SELECTION_WARM=1 runs the production startup template warmup before the first selection.
const warm = process.env.AC_SELECTION_WARM === '1';
await mkdir(out, { recursive: true });
let browser;
const close = async () => { await browser?.close(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await close(); process.exit(124); });
const report = { requested, warm, errors: [], navigations: [], frames: [], spire: [], note: `CPU update/submission wall times, NOT GPU timings. Controlled visible-view fixture, not live simulation. ${warm ? 'First select follows the production template warmup.' : 'Cold first-select deliberately bypasses template warmup to separate compile cost from warmed updates.'}` };
try {
  // The simulation hashes with node:crypto; produce the real transport snapshot on the Node side.
  const { createGame } = await import(new URL('../../../packages/game/src/index.ts', import.meta.url).href);
  const game = createGame({ seed: 42 });
  const base = game.view('nw', { snapshot: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'), args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 640 }, reducedMotion: 'no-preference' });
  page.setDefaultTimeout(90000);
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error' && !hmrNoise.test(e.text())) report.errors.push(e.text()); });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) report.navigations.push(frame.url()); });
  await page.route('**/selection-proof?*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${web}/selection-proof?renderer=${requested}`);
  report.backend = await page.evaluate(async ({ base, diagnostic, warm, fs }) => {
    const [{ World }, contract] = await Promise.all([
      import('/src/world/world.ts'), import(`${fs}packages/game/src/rules/contract.ts`),
    ]);
    const w = new World(document.querySelector('canvas'), 48);
    await w.init();
    const unit = (id, x, y, side = 'nw') => ({ id, kind: 'tank', side, plane: 'surface', x, y, hp: 100, maxHp: 100, state: 'idle' });
    const codes = new Uint8Array(48 * 48).fill(contract.SURFACE.ground);
    let view = base;
    w.rig.level = 1; w.rig.focus = 'surface'; w.rig.dist = 26;
    w.rig.yaw = Math.PI / 4; w.rig.pitch = 1.05;
    if (diagnostic) {
      // Unmodified native map, fog, starting fighters and Spire; later snapshots are stepped by the real sim.
      await w.setView(view);
      await w.layers.surface.ready();
      const fighters = view.entities.filter(e => e.side === 'nw' && e.plane === 'surface' && contract.isUnitKind(e.kind));
      if (fighters.length < 2) throw new Error('Native diagnostic requires starting Surface fighters');
      const x = fighters.reduce((v, e) => v + e.x, 0) / fighters.length, z = fighters.reduce((v, e) => v + e.y, 0) / fighters.length;
      w.selected = new Set(view.entities.filter(e => e.side === 'nw' && e.plane === 'surface').map(e => e.id));
      w.rig.lookAtTile(x, z);
      let target = { x: x + 8, y: z + 8, roughness: -1 };
      const terrain = w.layers.surface.field;
      for (let y = 4; y < 44; y++) for (let i = 4; i < 44; i++) {
        const distance = Math.hypot(i + 0.5 - x, y + 0.5 - z);
        const feature = contract.surfaceFeature(terrain.terrainCodes[y * 48 + i]);
        if (distance < 8 || distance > 12 || feature === contract.SURFACE.cliff || feature === contract.SURFACE.water) continue;
        const h = [terrain.groundAt(i, y), terrain.groundAt(i + 1, y), terrain.groundAt(i, y + 1), terrain.groundAt(i + 1, y + 1)];
        const roughness = Math.max(...h) - Math.min(...h);
        if (roughness > target.roughness) target = { x: i + 0.5, y: y + 0.5, roughness };
      }
      window.nativeMove = { units: fighters.map(e => e.id), x: target.x, y: target.y, roughness: target.roughness };
    } else {
      base.match = { ...base.match, armies: base.match.armies.map(a => a.id === 'nw' ? { ...a, spireAt: { x: 28.5, y: 25.5 } } : a) };
      base.entities = []; base.islands = []; base.memory = []; base.fx = []; base.impacts = []; base.lodes = []; base.holes = [];
      for (const plane of contract.PLANES) base.vision[plane].fill(1073741823);
      view = { ...base, entities: [unit('a', 23, 24), unit('b', 25, 24), unit('c', 29, 24), unit('d', 30.8, 24)] };
      await w.setView(view);
      w.layers.surface.setTerrain({ codes, faults: [], posts: [] });
      await w.layers.surface.ready();
      w.rig.lookAtTile(26, 24);
    }
    await w.prepareFirstFrame({ planes: ['surface'], templates: warm });
    window.fixture = { w, view, unit, codes, contract };
    window.drawFixture = async (label, count = 1) => {
      const frames = [];
      document.querySelector('#label').textContent = label;
      for (let i = 0; i < count; i++) {
        await new Promise(requestAnimationFrame);
        const start = performance.now();
        w.frame(false);
        const updated = performance.now();
        w.renderer.setRenderTarget(null); w.renderer.setMRT(null); w.pipeline.render();
        const submitted = performance.now();
        frames.push({ label, nowMs: start, updateCpuMs: updated - start, renderSubmissionCpuMs: submitted - updated });
      }
      return frames;
    };
    await window.drawFixture('unselected baseline', 2);
    return w.backend;
  }, { base, diagnostic, warm, fs });
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  if (requested === 'webgpu' && report.backend !== 'WebGPU') {
    report.limitation = 'Requested WebGPU unavailable; no WebGPU proof was produced.';
  } else if (diagnostic) {
    const move = await page.evaluate(() => window.nativeMove);
    report.nativeMove = move;
    report.moveResult = game.apply({ team: 'nw', role: 'surface' }, { kind: 'move', units: move.units, x: move.x, y: move.y });
    assert.equal(report.moveResult.ok, true, JSON.stringify(report.moveResult));
    for (let i = 0; i < 60; i++) game.step();
    await page.evaluate(async view => {
      const f = window.fixture;
      f.view = view; await f.w.setView(view); await f.w.layers.surface.ready();
      const units = view.entities.filter(e => window.nativeMove.units.includes(e.id));
      f.w.rig.lookAtTile(units.reduce((v, e) => v + e.x, 0) / units.length, units.reduce((v, e) => v + e.y, 0) / units.length);
      await window.drawFixture('native movement settle', 5);
      const pending = [f.w.pipeline.outputNode], visited = new Set();
      while (pending.length) {
        const node = pending.pop();
        if (visited.has(node)) continue;
        visited.add(node);
        if (node.isPassTextureNode && node.passNode.scene === f.w.scene) { f.pass = node.passNode; break; }
        pending.push(...node.getChildren());
      }
      if (!f.pass) throw new Error('Actual scene pass not found');
      f.output = f.w.pipeline.outputNode;
      f.ground = f.w.layers.surface.group.children.find(o => o.geometry === f.w.layers.surface.drawnGeometry);
      f.raster = [];
      const material = f.w.entities.selectionContours.mesh.material;
      f.color = material.colorNode; f.opacity = material.opacityNode;
      const nodes = [material.positionNode], scanned = new Set();
      while (nodes.length) {
        const node = nodes.pop();
        if (scanned.has(node)) continue;
        scanned.add(node);
        if (node.isVaryingNode && node.name === 'v_contourTile') { f.metadata = node; break; }
        if (node._attributeName === 'contourTile') f.metadata = node;
        nodes.push(...node.getChildren());
      }
      if (!f.metadata) throw new Error('Actual contour metadata node not found');
      f.w.entities.selectionContours.mesh.onAfterRender = () => {
        const gl = f.w.renderer.backend.gl, material = f.w.entities.selectionContours.mesh.material;
        if (!gl) return;
        const program = gl.getParameter(gl.CURRENT_PROGRAM), location = gl.getAttribLocation(program, 'contourTile');
        f.raster.push({ label: document.querySelector('#label').textContent,
          alphaToCoverage: material.alphaToCoverage, coverageEnabled: gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE),
          offsetEnabled: gl.isEnabled(gl.POLYGON_OFFSET_FILL), factor: gl.getParameter(gl.POLYGON_OFFSET_FACTOR), units: gl.getParameter(gl.POLYGON_OFFSET_UNITS),
          depthTest: gl.isEnabled(gl.DEPTH_TEST), depthWrite: gl.getParameter(gl.DEPTH_WRITEMASK), depthFunc: gl.getParameter(gl.DEPTH_FUNC),
          metadataBinding: { location, integer: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_INTEGER), type: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_TYPE), divisor: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_DIVISOR) } });
        if (!f.shaders) f.shaders = gl.getAttachedShaders(gl.getParameter(gl.CURRENT_PROGRAM)).map(s => ({ type: gl.getShaderParameter(s, gl.SHADER_TYPE), source: gl.getShaderSource(s) }));
      };
    }, game.view('nw', { snapshot: true }));
    const images = {};
    const modes = metadataOnly ? ['full', 'raw', 'metadata-clear', 'metadata-error'] : ['full', 'raw', 'raw-no-ground-depth', 'raw-no-bias', 'raw-no-legacy', 'normal', 'normal-no-contours'];
    for (const mode of modes) {
      await page.evaluate(mode => {
        const f = window.fixture, mesh = f.w.entities.selectionContours.mesh;
        f.w.pipeline.outputNode = mode === 'full' ? f.output : f.pass.getTextureNode(mode.startsWith('normal') ? 'normal' : 'output');
        f.w.pipeline.needsUpdate = true;
        f.ground.material.depthWrite = mode !== 'raw-no-ground-depth';
        mesh.material.polygonOffset = mode !== 'raw-no-bias';
        mesh.visible = mode !== 'normal-no-contours';
        if (mode.startsWith('metadata')) {
          const offset = f.metadata.z.toFloat(), count = f.metadata.w.toFloat();
          const error = offset.floor().sub(offset.round()).abs().max(count.floor().sub(count.round()).abs());
          mesh.material.colorNode = f.color.mul(0).add(1);
          mesh.material.opacityNode = mode === 'metadata-error' ? error : error.mul(0);
          mesh.material.needsUpdate = true;
        }
        f.w.entities.dabs.visible = f.w.entities.sel.visible = mode !== 'raw-no-legacy';
        document.querySelector('#label').textContent = `DIAGNOSTIC same frozen native pose: ${mode}`;
        f.w.renderer.setRenderTarget(null); f.w.renderer.setMRT(null); f.w.pipeline.render();
      }, mode);
      assert.equal(report.errors.length, 0, report.errors.join('\n'));
      images[mode] = (await page.screenshot({ path: join(out, `${requested}-diagnostic-${mode}.png`) })).toString('base64');
    }
    report[metadataOnly ? 'metadataDifference' : 'normalDifference'] = await page.evaluate(async ({ a, b }) => {
      const decode = async data => {
        const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [x, y] = await Promise.all([decode(a), decode(b)]);
      let changed = 0, maxDifference = 0, white = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      const width = 960;
      for (let i = 960 * 48 * 4; i < x.length; i += 4) {
        const d = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]));
        if (d) {
          changed++;
          const px = (i / 4) % width, py = Math.floor(i / 4 / width);
          x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
        }
        maxDifference = Math.max(maxDifference, d);
        // An error-mask hit paints opaque white over a pixel that was not white before.
        if (y[i] > 250 && y[i + 1] > 250 && y[i + 2] > 250 && !(x[i] > 250 && x[i + 1] > 250 && x[i + 2] > 250)) white++;
      }
      return { changedPixelsBelowLabel: changed, maxChannelDifference: maxDifference, newWhitePixels: white, changedBox: [x0, y0, x1, y1] };
    }, metadataOnly ? { a: images['metadata-clear'], b: images['metadata-error'] } : { a: images.normal, b: images['normal-no-contours'] });
    report.raster = await page.evaluate(() => window.fixture.raster);
    await writeFile(join(out, 'contour-shaders.json'), JSON.stringify(await page.evaluate(() => window.fixture.shaders), null, 2));
    for (let i = 0; i < 20; i++) game.step();
    await page.evaluate(async view => {
      const f = window.fixture;
      f.ground.material.depthWrite = true; f.w.entities.selectionContours.mesh.material.polygonOffset = true;
      f.w.entities.selectionContours.mesh.material.colorNode = f.color;
      f.w.entities.selectionContours.mesh.material.opacityNode = f.opacity;
      f.w.entities.selectionContours.mesh.material.needsUpdate = true;
      f.w.entities.dabs.visible = f.w.entities.sel.visible = true;
      f.w.pipeline.outputNode = f.output; f.w.pipeline.needsUpdate = true;
      f.view = view; await f.w.setView(view); await f.w.layers.surface.ready();
      f.w.rig.yaw += 0.18; f.w.rig.dist = 29;
      await window.drawFixture('native movement + normal camera orbit, original pipeline restored', 3);
    }, game.view('nw', { snapshot: true }));
    await page.screenshot({ path: join(out, `${requested}-diagnostic-moving.png`) });
    assert.equal(report.errors.length, 0, report.errors.join('\n'));
  } else {
    const capture = async (label, count, file) => {
      report.frames.push(...await page.evaluate(([label, count]) => window.drawFixture(label, count), [label, count]));
      assert.equal(report.errors.length, 0, report.errors.join('\n'));
      assert.equal(report.navigations.length, 1, 'Fixture reloaded: this is not valid renderer evidence');
      report.spire.push(await page.evaluate(async label => {
        const { w } = window.fixture, surface = w.layers.surface;
        const body = w.entities.root.getObjectByName('spire-nw-surface');
        const core = body.getObjectByName('spire-nw-surface-core');
        const { FADE } = await import('/src/world/fade.ts');
        return {
          label, cameraDistance: w.rig.dist, baseY: body.position.y,
          supportY: surface.field.groundAt(28.5, 25.5),
          drawnY: surface.drawnGeometry.getAttribute('position').getY(102 * surface.field.field.n + 114),
          planeAlpha: FADE.surface.alpha.value, coreDepthTest: core.material.depthTest, coreDepthWrite: core.material.depthWrite,
          contourDepthTest: w.entities.selectionContours.mesh.material.depthTest, contourDepthWrite: w.entities.selectionContours.mesh.material.depthWrite,
        };
      }, label));
      if (file) await page.screenshot({ path: join(out, `${requested}-${file}.png`) });
    };
    await page.evaluate(() => { window.fixture.w.selected = new Set(['a', 'b', 'c', 'd']); });
    if (!focused) await capture(warm ? 'first select after production template warmup' : 'cold first select (diagnostic, templates deliberately bypassed)', 1, warm ? 'warm-first-select' : 'cold-select');
    await capture('entrance settled: joined pair + disjoint pair, normal RTS zoom', focused ? 6 : 10, focused ? 'focused-merged-disjoint' : 'merged-disjoint');
    if (!focused) {
      await page.evaluate(() => { window.fixture.w.selected.clear(); });
      await capture('deselected: ordinary dabs, no retained group contour', 1, 'deselected');
      await page.evaluate(() => { window.fixture.w.selected = new Set(['a', 'b', 'c', 'd']); });
      await capture('warm reselect', 1, 'warm-select');
      await capture('warm entrance settled', 8);
    }
    // These are real successive view positions; Entities retains its normal snapshot interpolation.
    for (let step = 1; step <= (focused ? 1 : 3); step++) {
      await page.evaluate(async step => {
        const f = window.fixture;
        f.view = { ...f.view, tick: f.view.tick + 2, entities: f.view.entities.map(e => ({ ...e, x: e.id === 'a' ? 23 + step * 0.5 : e.id === 'b' ? 25 + step * 0.5 : e.x })) };
        await f.w.setView(f.view);
      }, step);
      await capture(`moving pair, snapshot ${step}`, 3, focused ? 'focused-moving' : `moving-${step}`);
    }
    if (!focused) {
      await page.evaluate(async () => {
        const f = window.fixture;
        f.w.selected.delete('b');
        f.view = { ...f.view, tick: f.view.tick + 2, entities: f.view.entities.filter(e => e.id !== 'b') };
        await f.w.setView(f.view);
      });
      await capture('removed source: no ghost or continued bridge', 2, 'removed');
      await page.evaluate(async () => {
        const f = window.fixture;
        // Real terrain baker supplies both normals and dynamically selected triangle diagonals.
        for (let z = 18; z < 31; z++) {
          f.codes[z * 48 + 26] = f.contract.SURFACE.cliff;
          for (let x = 27; x < 35; x++) f.codes[z * 48 + x] = f.contract.SURFACE.high;
        }
        f.w.layers.surface.setTerrain({ codes: f.codes, faults: [], posts: [] });
        await f.w.layers.surface.ready();
        f.view = { ...f.view, tick: f.view.tick + 2, entities: [f.unit('a', 24.2, 24), f.unit('b', 25.5, 24), f.unit('c', 27.5, 24), f.unit('d', 29.1, 24)] };
        await f.w.setView(f.view);
        f.w.selected = new Set(['a', 'b', 'c', 'd']);
      });
      await capture('terrain slopes / cliff: conforming contours on separate support regions', 10, 'slope-cliff');
      for (const distance of [18, 42]) for (let step = 1; step <= 2; step++) {
        await page.evaluate(async ([distance, step]) => {
          const f = window.fixture;
          f.w.rig.dist = distance;
          f.view = { ...f.view, tick: f.view.tick + 2, entities: f.view.entities.map(e => ({ ...e, x: e.x + 0.3, y: e.y + 0.15 })) };
          await f.w.setView(f.view);
        }, [distance, step]);
        await capture(`moving across slope/triangle/tile boundaries, distance ${distance}, step ${step}`, 2, `slope-${distance}-${step}`);
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await capture('reduced motion: static contour, current source positions', 1, 'reduced');
    }
    report.support = await page.evaluate(() => {
      const { w, view } = window.fixture;
      return view.entities.map(e => ({ id: e.id, x: e.x, z: e.y, height: w.layers.surface.field.groundAt(e.x, e.y) }));
    });
  }
  await page.close();
} finally {
  try { await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); }
  finally { await close(); }
}
console.log(JSON.stringify(report, null, 2));
