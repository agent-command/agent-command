/** Deterministic presentation fixtures through the production World/ink/fog/island renderer.
 * Run under a finite /tmp/ac-test.lock: node apps/lookdev/scripts/storm.mjs [output] [webgl|webgpu].
 * Uses the existing web Vite service, never starts/stops it. Fixtures alter presentation, not simulation rules.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createGame } from '../../../packages/game/src/agent/adapter.ts';
import { PLANE_Y, MOORING_DEPTH } from '../../../packages/game/src/rules/contract.ts';

const out = resolve(process.argv[2] ?? '/tmp/ac-fused-storm-proof');
const backend = process.argv[3] ?? 'webgl';
const minimal = process.env.STORM_PROOF_MINIMAL === '1';
mkdirSync(out, { recursive: true });
const game = createGame({ seed: 7 });
const fixtureSize = game.sim.rules.map.size;
const aircraft = [game.sim.add('interceptor', 0, 'sky', fixtureSize / 2 - 4, fixtureSize / 2 + 0.8),
  game.sim.add('interceptor', 0, 'sky', fixtureSize / 2 + 9, fixtureSize / 2 + 0.8)];
const building = game.sim.add('aerie', 0, 'sky', fixtureSize / 2 - 4, fixtureSize / 2);
// Orders fixtures only (`surface`): a Surface tank under the storm.
const tank = game.sim.add('tank', 0, 'surface', fixtureSize / 2 - 6, fixtureSize / 2 + 2);
const fixtureIds = new Set([...aircraft, building, tank].map(e => game.entityId('nw', e.id)));
for (const cells of game.sim.vis) cells.fill(game.sim.armies[0].group.bit);
const view = JSON.parse(JSON.stringify(game.view('nw')));
const islands = view.entities.filter(e => e.kind === 'island').slice(0, 2);
if (islands.length !== 2) throw new Error('Two real island models required');
view.entities = [...islands, ...view.entities.filter(e => fixtureIds.has(e.id))];
view.islands = [];
view.fx = [];
const size = view.match.rules.map.size;
for (let i = 0; i < islands.length; i++) {
  Object.assign(islands[i], { x: size / 2 + (i ? 9 : -4), y: size / 2, elevation: 0, side: i ? 'neutral' : 'nw' });
}
const mounted = view.entities.find(e => e.kind === 'aerie');
if (!mounted) throw new Error('Real island building required');
Object.assign(mounted, { link: islands[0].id, x: islands[0].x, y: islands[0].y, elevation: 0 });
view.weather = { storms: [{ id: 0, x: size / 2 - 4, y: size / 2, radius: 7, maxRadius: 7, strength: 1, stage: 'mature', originX: size / 2 - 4, originY: size / 2, dx: 0, dy: 0, start: 0, grown: 20, breaking: 20000, end: 20100, turns: 0 }], forecast: [], seeded: [], seedWarnings: [], fog: [] };
/** STORM_PROOF_GATE=art: look review; =cutaway: a moving island entering, inside, lowered, raising and leaving. */
const GATES = {
  art: ['pass-2-centre', 'orbit-low', 'flow-b', 'lightning', 'control-no-clearance'],
  cutaway: ['pass-0-outside', 'pass-1-entering', 'pass-2-centre', 'pass-3-lowering', 'pass-4-moored', 'pass-5-raising',
    'pass-6-leaving', 'pass-7-outside', 'pass-8-hidden', 'orbit-low', 'orbit-low-moored', 'orbit-low-raising', 'control-no-clearance'],
  growth: ['growth-150', 'growth-340', 'growth-399', 'growth-401', 'growth-460', 'growth-560'],
  fade: ['pass-2-centre', 'view-sky-to-orbit', 'view-orbit', 'view-surface'],
  orders: ['orders-storm', 'orders-storm-low', 'orders-clear', 'orders-ring', 'orders-surface', 'orders-legacy', 'orders-calm', 'orders-calm-legacy'],
  // An island entering a storm, soaking, then leaving and drying (`frames` × 0.1 s per step): the wet ramp.
  wet: ['wet-0-outside', 'wet-1-entered', 'wet-2-inside', 'wet-3-soaked', 'wet-4-leaving', 'wet-5-dry'],
  // Public effects above a storm: the Spire's connector rising through it and an aircraft's ascent column.
  beam: ['beam-storm', 'beam-storm-low'],
  // The inked lightning bolt, a forming storm beside a mature one (they fuse, never carve each other), and a visible
  // structure off any island opening its own gap.
  storm2: ['lightning', 'peer-forming', 'peer-forming-low', 'structure-storm'],
};
const evidence = { backendRequested: backend, errors: [], captures: [], fixture: 'Production World; staged public weather, island snapshot positions/heights and visibility. Not a live gameplay test.' };
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? `${homedir()}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`, headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] });
const stop = signal => {
  evidence.errors.push(`Interrupted by ${signal}`);
  void browser.close().finally(() => {
    writeFileSync(resolve(out, `${backend}-evidence.json`), JSON.stringify(evidence, null, 2) + '\n');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  const page = await browser.newPage({ viewport: minimal ? { width: 960, height: 672 } : { width: 1440, height: 1000 }, deviceScaleFactor: 1, permissions: ['local-network-access'] });
  page.setDefaultTimeout(90000);
  page.on('pageerror', e => evidence.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') evidence.errors.push(m.text()); });
  // This isolated World fixture needs no live socket. Keep dev HMR open but disconnected from reload broadcasts.
  await page.routeWebSocket('**', () => {});
  await page.route('**/__storm-proof?*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0}canvas{width:100vw;height:100vh;display:block}aside{position:absolute;top:24px;left:28px;color:#26354a;font:14px/1.5 monospace;white-space:pre}</style><canvas></canvas><aside></aside>' }));
  await page.goto(`${process.env.STORM_PROOF_URL ?? 'http://localhost:5173'}/__storm-proof?renderer=${backend}`);
  evidence.backend = await page.evaluate(async view => {
    const [{ World }, weather] = await Promise.all([import('/src/world/world.ts'), import('/src/world/weather.ts')]);
    const w = new World(document.querySelector('canvas'), view.match.rules.map.size);
    await w.init();
    await Promise.all([w.layers.surface.ready(), w.layers.depths.ready(), w.layers.orbit.ruin.ready()]);
    await w.entities.prepareView(view);
    // The production startup warm-up, including the storm pass's own programs.
    if (!await w.prepareFirstFrame()) throw new Error('World warm-up superseded');
    // The live World's own fused storm pass (private field; this fixture only reads it).
    window.stormProof = { w, clouds: w.storms, weather, view, lineMaterial: w.entities.lines.material };
    return w.backend;
  }, view);
  const cases = (minimal ? [
    { name: 'pass-0-outside', move: -10 }, { name: 'pass-1-entering', move: -6 },
    { name: 'pass-2-centre' }, { name: 'pass-3-lowering', height: -MOORING_DEPTH / 2 },
    { name: 'pass-4-moored', height: -MOORING_DEPTH }, { name: 'pass-5-raising', move: 2, height: -MOORING_DEPTH / 2 },
    { name: 'pass-6-leaving', move: 6 }, { name: 'pass-7-outside', move: 10 },
    { name: 'pass-8-hidden', hidden: true }, { name: 'reduced-a', reduced: true, still: true, tick: 240, flow: 12.3 },
    { name: 'control-no-clearance', occluded: true, still: true, tick: 240, flow: 12.3 },
    { name: 'orbit-wide', still: true, tick: 240, flow: 12.3, distance: 65 },
    { name: 'orbit-side', still: true, tick: 240, flow: 12.3, yaw: Math.PI / 2 },
    { name: 'orbit-low', still: true, tick: 240, flow: 12.3, pitch: 0.4 },
    { name: 'orbit-low-moored', still: true, tick: 240, flow: 12.3, pitch: 0.4, height: -MOORING_DEPTH },
    ...[150, 340, 399, 401, 460, 560].map(tick => ({ name: `growth-${tick}`, still: true, growth: true, tick, move: -10 })),
    { name: 'orbit-low-raising', still: true, tick: 240, flow: 12.3, pitch: 0.4, height: -MOORING_DEPTH / 3, move: 1 },
    { name: 'view-orbit', still: true, tick: 240, flow: 12.3, level: 3, focus: 'orbit' },
    { name: 'view-sky-to-orbit', still: true, tick: 240, flow: 12.3, level: 2.5, focus: 'orbit' },
    { name: 'view-surface', still: true, tick: 240, flow: 12.3, level: 1, focus: 'surface' },
    { name: 'orders-storm', still: true, tick: 240, flow: 12.3, orders: true },
    { name: 'orders-storm-low', still: true, tick: 240, flow: 12.3, orders: true, pitch: 0.4 },
    { name: 'orders-clear', still: true, tick: 240, flow: 12.3, orders: true, outside: true },
    { name: 'orders-ring', still: true, tick: 240, flow: 12.3, orders: true, ring: true, surface: true },
    { name: 'orders-surface', still: true, tick: 240, flow: 12.3, orders: true, surface: true, level: 1, focus: 'surface' },
    { name: 'orders-legacy', still: true, tick: 240, flow: 12.3, orders: true, outside: true, legacy: true },
    // No weather at all: the overlay pass against the scene-pass lines with nothing composited over either.
    { name: 'orders-calm', still: true, tick: 240, flow: 12.3, orders: true, calm: true, level: 2, focus: 'sky' },
    { name: 'orders-calm-legacy', still: true, tick: 240, flow: 12.3, orders: true, calm: true, legacy: true, level: 2, focus: 'sky' },
    { name: 'wet-0-outside', move: -10, frames: 3 }, { name: 'wet-1-entered', move: -6, frames: 3 },
    { name: 'wet-2-inside', move: -5, frames: 5 }, { name: 'wet-3-soaked', move: -4, frames: 10 },
    { name: 'wet-4-leaving', move: -10, frames: 4 }, { name: 'wet-5-dry', move: -10, frames: 12 },
    { name: 'beam-storm', still: true, tick: 240, flow: 12.3, beam: true, level: 2, focus: 'sky' },
    { name: 'beam-storm-low', still: true, tick: 240, flow: 12.3, beam: true, level: 2, focus: 'sky', pitch: 0.4 },
    { name: 'peer-forming', still: true, tick: 240, flow: 12.3, peer: true },
    { name: 'peer-forming-low', still: true, tick: 240, flow: 12.3, peer: true, pitch: 0.4 },
    { name: 'structure-storm', still: true, tick: 240, flow: 12.3, structure: true },
    { name: 'flow-b', still: true, tick: 240, flow: 14.3 },
    { name: 'reduced-b', reduced: true, still: true, tick: 240, flow: 14.3 },
    { name: 'lightning', still: true, lightning: true },
  ].map((c, i) => ({ ...c, sequence: !c.still, tick: c.tick ?? 80 + i * 80 })) : [
    { name: 'normal-inside-outside' }, { name: 'wide', distance: 65 },
    { name: 'moored', height: -MOORING_DEPTH }, { name: 'lowering', height: -MOORING_DEPTH / 2 },
    { name: 'moving', move: 1.5 }, { name: 'lightning', lightning: true },
    { name: 'motion', tick: 180 }, { name: 'hidden-no-cutaway', hidden: true },
    { name: 'weather-outside', outside: true }, { name: 'reduced-motion', reduced: true, lightning: true },
    { name: 'sky-surface-transition', level: 1.65 }, { name: 'camera-orbit', yaw: 1.1 },
    ...Array.from({ length: 8 }, (_, i) => ({ name: `flow-${i}`, flow: 4 + i * 0.5 })),
    { name: 'reduced-flow-a', reduced: true, flow: 4 }, { name: 'reduced-flow-b', reduced: true, flow: 7.5 },
  ]).filter(c => (!process.env.STORM_PROOF_GATE || GATES[process.env.STORM_PROOF_GATE].includes(c.name))
    && (!process.env.STORM_PROOF_SCENE || c.name === process.env.STORM_PROOF_SCENE));
  for (const c of cases) {
    await page.emulateMedia({ reducedMotion: c.reduced ? 'reduce' : 'no-preference' });
    const result = await page.evaluate(async ({ c, skyY, minimal }) => {
      const { w, clouds, weather, view } = window.stormProof;
      const v = structuredClone(view);
      const distance = c.distance ?? 38;
      let tick = c.tick ?? 80;
      if (c.lightning) for (let t = 100; t < 1200; t++) if (weather.flashAt(t / 20, 0) > 0.9) { tick = t; break; }
      v.tick = tick;
      v.entities[0].elevation = c.height ?? 0;
      v.entities[0].x += c.move ?? 0;
      const mounted = v.entities.find(e => e.kind === 'aerie');
      mounted.x = v.entities[0].x;
      mounted.elevation = v.entities[0].elevation;
      const picked = [];
      let hovered;
      if (!c.surface) v.entities = v.entities.filter(e => e.kind !== 'tank');
      if (c.orders) {
        // A selected own aircraft inside the storm with its order line and a queued waypoint.
        const flyer = v.entities.find(e => e.kind === 'interceptor');
        // ring: off the deck, over open storm, hovered too (the hovered marker keeps its ring beside the contour).
        if (c.ring) { flyer.x -= 3; flyer.y += 2.5; hovered = flyer.id; }
        Object.assign(flyer, { state: 'moving', tx: flyer.x - 4, ty: flyer.y + 3, wp: [{ x: flyer.x + 2, y: flyer.y + 5 }] });
        picked.push(flyer.id);
      }
      if (c.surface) {
        const tank = v.entities.find(e => e.kind === 'tank');
        // ring: Sky view, the tank placed to sit behind the Sky storm's band on screen.
        if (c.ring) { tank.x -= 12.5; tank.y -= 11; }
        Object.assign(tank, { state: 'moving', tx: tank.x + 5, ty: tank.y + 4 });
        picked.push(tank.id);
      }
      if (c.outside) {
        v.weather.storms[0].originX -= 20;
        v.weather.storms[0].x -= 20; // authoritative snapshot membership and sampled visual origin agree
      }
      if (c.calm) v.weather.storms = [];
      if (c.peer) {
        // A second storm forming over the mature one's eastern arm: the two must fuse, never carve each other.
        const mature = v.weather.storms[0];
        v.weather.storms.push({ ...mature, id: 1, x: mature.x + 7, originX: mature.originX + 7, y: mature.y + 2, originY: mature.originY + 2,
          strength: 0.3, stage: 'forming', start: tick - 60, grown: tick + 240 });
      }
      if (c.structure) {
        // A visible building with no island opening (its island unlinked): it opens its own gap with an x-ray outline.
        const aerie = v.entities.find(e => e.kind === 'aerie');
        v.entities.push({ ...aerie, id: 'e_standalone', link: undefined, x: v.weather.storms[0].x + 3, y: v.weather.storms[0].y - 3 });
      }
      if (c.beam) {
        // The storm over the viewer's Spire, with an interceptor ascending to Orbit inside it.
        const spire = v.match.armies.find(a => a.id === v.army).spireAt;
        Object.assign(v.weather.storms[0], { x: spire.x + 3, y: spire.y + 3, originX: spire.x + 3, originY: spire.y + 3 });
        const flyer = v.entities.find(e => e.kind === 'interceptor');
        Object.assign(flyer, { x: spire.x + 5, y: spire.y + 4, transit: { to: 'orbit', at: tick + 30, until: 0 } });
      }
      if (c.growth) {
        // A later storm announced, gathering, then forming: its drawn size must only ever grow.
        const later = { ...v.weather.storms[0], id: 1, strength: 0, stage: 'forecast', start: 400, grown: 700, breaking: 20000, end: 20100 };
        v.weather.storms = tick < later.start ? [] : [later];
        v.weather.forecast = tick < later.start ? [later] : [];
      }
      const continuing = c.sequence && window.stormProof.sequenceStarted;
      if (!continuing) w.reset();
      w.selected = new Set(picked);
      w.hovered = hovered;
      // legacy: the order lines as drawn before the overlay pass (scene pass under the entity root's groupOrder, plain
      // overlay material).
      const lines = w.entities.lines, stock = window.stormProof.lineMaterial;
      if (c.legacy) {
        lines.material = window.stormProof.legacyLines ??= Object.assign(new stock.constructor({ vertexColors: true }), { transparent: true, depthWrite: false, mrtNode: stock.mrtNode });
        w.entities.root.add(lines);
      } else {
        lines.material = stock;
        w.entities.overlays.add(lines);
      }
      window.stormProof.sequenceStarted = !!c.sequence;
      const snapshotNow = tick * 50;
      let renderNow = c.flow === undefined ? snapshotNow : c.flow * 1000;
      w.view = v;
      w.army = v.army;
      w.viewAt = performance.now();
      w.entities.ingest(v, snapshotNow);
      if (c.hidden) v.vision.sky.fill(0);
      w.fog.ingestVision(v, true);
      w.fog.stepFog(1);
      w.layers.update(v, t => t / 20);
      w.rig.level = c.level ?? 2;
      w.rig.focus = c.focus ?? 'sky';
      w.rig.dist = distance;
      const camera = w.rig.camera, yaw = c.yaw ?? 0, pitch = c.pitch ?? Math.atan2(0.79, 0.62);
      camera.position.set(2 + Math.sin(yaw) * distance * Math.cos(pitch), skyY + distance * Math.sin(pitch), Math.cos(yaw) * distance * Math.cos(pitch));
      camera.lookAt(2, skyY - 2, 0); camera.updateMatrixWorld();
      // Use the World's own imported fade/palette/clock instances, including timestamped Vite dependencies.
      const render = () => {
        w.updateScene(renderNow, 0.1);
        if (c.occluded) {
          // Control: the same frame with every island cutaway withheld.
          w.layers.sky.weather.cutaways(undefined, w.entities.root, w.fog);
          clouds.sync(w.layers.sky.weather);
        }
        w.renderer.setRenderTarget(null);
        w.renderer.setMRT(null);
        w.pipeline.render();
      };
      // A still frame shows the settled weather response: run the eased state (≤ 0.1 s per frame) up to its time.
      if (!c.sequence) for (let i = 16; i > 0; i--) w.updateScene(renderNow - i * 100, 0.1);
      for (let i = 0; i < (c.frames ?? 3); i++) {
        await new Promise(requestAnimationFrame);
        if (c.sequence) renderNow += 100;
        render();
      }
      document.querySelector('aside').textContent = `SKY / FUSED STORM · ${c.name}\nLeft: test island + building · right: outside storm · ${w.backend}`;
      const wl = w.layers.sky.weather;
      const response = [...w.entities.islands.values()].map(i => i.grove.storm.value.toArray());
      // Plane-fade views (Orbit, a dive, Surface) check what they show, not Sky admission.
      if (c.level === undefined) {
        if (!w.layers.sky.group.visible) throw new Error('Fixture failed to focus the actual Sky layer');
        const expectedCutaways = c.hidden || c.occluded ? 0 : 2;
        if (wl.islandCount.value !== expectedCutaways) throw new Error(`Island reveal admission failed: ${wl.islandCount.value}/${expectedCutaways}`);
        if (!c.hidden && !c.outside && Math.abs(c.move ?? 0) < 7 && !(response[0]?.[0] > 0)) throw new Error('Visible in-storm island has no canonical exposure');
      }
      const samples = [];
      if (!minimal) for (let i = 0; i < 12; i++) { await new Promise(requestAnimationFrame); const start = performance.now(); render(); samples.push(performance.now() - start); }
      samples.sort((a,b) => a-b);
      return {
        tick, flowSeconds: renderNow / 1000, distance, height: c.height ?? 0,
        cutaways: wl.islandCount.value, response,
        draws: w.renderer.info.render.drawCalls, triangles: w.renderer.info.render.triangles,
        cells: wl.cloudField.count, packets: clouds.packets.count, windStrips: clouds.trails.count,
        cloudTarget: { width: clouds.pass.renderTarget.width, height: clouds.pass.renderTarget.height },
        flash: wl.cloudField.states.slice(0, wl.cloudField.count).some(state => state.y > 0.01),
        strikes: wl.cloudField.strikes.slice(0, wl.cloudField.count).filter(strike => strike.w > 0.02).length,
        stormOpacity: wl.cloudField.states.slice(0, wl.cloudField.count).map(state => state.x),
        transitionWash: w.rig.look.wash,
        overlays: { shown: w.entities.overlaysShown, rings: w.entities.sel.count, contourTiles: w.entities.selectionContours.mesh.geometry.instanceCount,
          lineVertices: w.entities.lines.geometry.drawRange.count, legacyLines: w.entities.lines.parent === w.entities.root, selected: [...w.selected], hovered: w.hovered ?? null,
          units: [...w.entities.tracks.values()].filter(tr => tr.e.kind === 'interceptor' || tr.e.kind === 'tank').map(tr => ({ id: tr.e.id, kind: tr.e.kind, x: tr.rx, y: tr.ry, height: tr.wy, tx: tr.e.tx })) },
        renderedIslands: [...w.entities.tracks.values()].filter(tr => tr.e.kind === 'island').map(tr => ({
          id: tr.e.id, x: tr.rx, y: tr.ry, height: tr.wy, visible: tr.visible,
          fog: w.fog.tileVisible('sky', tr.rx, tr.ry), modelVisible: w.entities.root.getObjectByName(`island-terrain-${tr.e.id}`)?.visible,
        })),
        renderedBuildings: [...w.entities.tracks.values()].filter(tr => tr.e.link).map(tr => ({ id: tr.e.id, island: tr.e.link, x: tr.rx, y: tr.ry, height: tr.wy, visible: tr.visible })),
        clearance: wl.islands.slice(0, wl.islandCount.value).map((centre, i) => ({ centre: centre.toArray(), axes: wl.islandAxes[i].toArray() })),
        cpuSamples: samples.length, cpuSubmissionP50Ms: samples[6], cpuSubmissionP95Ms: samples[11],
        measurement: minimal ? 'Capture-only: 3 rendered frames per snapshot; no timing run' : '12 CPU update + render submission samples after 3 rendered frames; driver compilation may remain; not GPU frame time or hardware performance proof',
      };
    }, { c, skyY: PLANE_Y.sky, minimal });
    const file = `${backend}-${c.name}.png`;
    await page.screenshot({ path: resolve(out, file) });
    evidence.captures.push({ file, ...result });
  }
  await page.evaluate(() => { window.stormProof.w.layers.sky.weather.dispose(); window.stormProof.clouds.dispose(); });
} catch (error) {
  evidence.errors.push(String(error));
  throw error;
} finally {
  await browser.close();
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  const report = resolve(out, `${backend}-evidence.json`);
  if (process.env.STORM_PROOF_SCENE && existsSync(report)) {
    const previous = JSON.parse(readFileSync(report, 'utf8'));
    const replaced = new Set(evidence.captures.map(c => c.file));
    evidence.captures = [...previous.captures.filter(c => !replaced.has(c.file)), ...evidence.captures];
    evidence.errors = [...previous.errors, ...evidence.errors];
  }
  writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence, null, 2));
if (evidence.errors.length) process.exitCode = 1;
