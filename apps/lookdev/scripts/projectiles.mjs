/**
 * Source-browser projectile contact sheet; no game server, accounts, sockets or persisted match data.
 * Run: node apps/lookdev/scripts/projectiles.mjs [output-directory]
 * CHROME selects Chromium; default matches the existing lookdev capture script. Outputs PNGs + evidence.json.
 * Real Sim.fire() events are generated in Node (game adapter imports node:crypto), then only serialized,
 * fog-filtered views cross into the browser. This deliberately freezes presentation, not simulation physics.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { createGame } from '../../../packages/game/src/agent/adapter.ts';
import { STATS, PLANE_Y, TICK_RATE } from '../../../packages/game/src/rules/contract.ts';

const out = resolve(process.argv[2] ?? '/tmp/ac-projectiles');
mkdirSync(out, { recursive: true });
const fixtures = [];
for (const [kind, stat] of Object.entries(STATS)) {
  if (!stat.weapon) continue;
  const game = createGame({ seed: 7 });
  const sim = game.sim;
  sim.tick = 20;
  // Spire crystals are tied to the real army's fixed Spire position; ordinary units may be placed freely. The sim
  // takes army indices in slot order: 0 is the duel's nw army, 1 its se army.
  const source = kind === 'spire'
    ? sim.ents.find(e => e.kind === 'spire' && e.side === 0 && e.plane === stat.plane)
    : sim.add(kind, 0, stat.plane, 21, 24);
  const target = sim.add(stat.targets[0] === 'sky' ? 'interceptor' : 'trooper', 1, stat.targets[0], source.x + Math.min(4, stat.range * 0.8), source.y);
  // JS may exercise the private simulation entrypoint in this isolated visual recipe; no production
  // API is widened and timing/damage/weapon selection still come from the real server implementation.
  sim.fire(source, target);
  const view = JSON.parse(JSON.stringify(game.view('nw')));
  const id = game.entityId('nw', source.id);
  const event = view.fx.find(f => f.kind === 'shot' && f.src === id);
  if (!event) throw new Error(`No authoritative ${kind} shot in the fog-filtered fixture`);
  fixtures.push({ name: stat.weapon, view: { ...view, entities: view.entities.filter(e => e.id === id) }, event });
}
// Troopers can fight in the Depths; exercise the same thin stroke against the dark-card palette.
{
  const game = createGame({ seed: 7 });
  const sim = game.sim;
  sim.tick = 20;
  const source = sim.add('trooper', 0, 'depths', 21, 24);
  const target = sim.add('digger', 1, 'depths', 25, 24);
  sim.fire(source, target);
  const view = JSON.parse(JSON.stringify(game.view('nw')));
  const event = view.fx.find(f => f.kind === 'shot');
  fixtures.push({ name: 'rifle-depths', view: { ...view, entities: view.entities.filter(e => e.id === game.entityId('nw', source.id)) }, event });
}

const server = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), logLevel: 'warn', server: { port: 5198, strictPort: true, host: '127.0.0.1' } });
await server.listen();
let browser;
const evidence = { backend: '', errors: [], captures: [] };
try {
  // Keep the Vite listener inside the cleanup scope even if Chromium is missing or cannot launch.
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? `${homedir()}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`, headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', error => evidence.errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') evidence.errors.push(message.text()); });
  // Blank page rather than main.ts: no lobby, live game loop or HMR navigation races with the frozen clock.
  await page.route('**/__projectile-smoke?*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0}canvas{display:block;width:100vw;height:100vh}aside{position:absolute;left:24px;top:20px;background:#efe6d0;color:#2b2019;padding:12px;font:18px monospace;white-space:pre}</style><canvas></canvas><aside></aside>' }));
  await page.goto('http://127.0.0.1:5198/__projectile-smoke?renderer=webgl');
  evidence.backend = await page.evaluate(async () => {
    const { World } = await import('/src/world/world.ts');
    const world = new World(document.querySelector('canvas'));
    await world.init();
    window.projectileWorld = world;
    return world.backend;
  });
  for (const fixture of fixtures) {
    for (const phase of ['flight', 'impact']) {
      const state = await page.evaluate(async ({ fixture, phase, planeY, tickRate }) => {
        const [{ applyFade }, { setViewLevel }, { LINE_DIST }] = await Promise.all([import('/src/world/fade.ts'), import('/src/world/palette.ts'), import('/src/world/ink.ts')]);
        const world = window.projectileWorld;
        world.reset();
        const { event, view, name } = fixture;
        const planes = ['depths', 'surface', 'sky', 'orbit'];
        const start = event.tick * 1000 / tickRate;
        const arrival = event.arrive * 1000 / tickRate;
        const now = phase === 'flight' ? (arrival === start ? start + 25 : (start + arrival) / 2) : arrival + 40;
        const level = (planes.indexOf(event.plane) + planes.indexOf(event.tp)) / 2;
        applyFade(level); setViewLevel(level);
        world.combat.focus = event.plane;
        world.entities.ingest(view, start);
        world.entities.fire(event.src, event.plane, event.x, event.y, start, event.tp, event.tx, event.ty);
        world.entities.frame(start, 1, new Set(), undefined, 'nw', event.plane, 1);
        world.combat.ingest(view, tick => tick * 1000 / tickRate);
        const midY = (planeY[event.plane] + planeY[event.tp]) / 2;
        const cross = event.plane !== event.tp;
        // A 30-tile camera distance matches normal gameplay; cross-plane frames widen only enough to
        // include both endpoints. Source and target remain at their true world heights in every PNG.
        const distance = cross ? 44 : 30;
        const camera = world.rig.camera;
        const centreX = (event.x + event.tx) / 2 - 24, centreZ = (event.y + event.ty) / 2 - 24;
        camera.position.set(centreX + 4, midY + distance * 0.8, centreZ + distance * 0.55);
        camera.lookAt(centreX, midY + (cross ? 0 : 1), centreZ);
        camera.updateMatrixWorld();
        LINE_DIST.value = distance;
        // Step at 60 Hz from launch to preserve genuine trail/muzzle/particle evolution, then freeze.
        for (let t = start; t < now; t += 1000 / 60) world.combat.frame(t, 1 / 60, camera.position.y, t * tickRate / 1000);
        world.combat.frame(now, 0, camera.position.y, now * tickRate / 1000);
        document.querySelector('aside').textContent = `${name} · ${phase}\n${event.plane} → ${event.tp}\nserver flight ${arrival - start} ms`;
        world.pipeline.render();
        await new Promise(requestAnimationFrame);
        world.pipeline.render();
        return { name, phase, now, start, arrival, strokes: world.combat.shots.bolts.count, bodies: world.combat.shots.bodies.count, particles: world.combat.sparks.n + world.combat.smoke.n + world.combat.debris.n };
      }, { fixture, phase, planeY: PLANE_Y, tickRate: TICK_RATE });
      const file = `${fixture.name}-${phase}.png`;
      await page.screenshot({ path: resolve(out, file) });
      evidence.captures.push({ file, ...state });
    }
  }
  writeFileSync(resolve(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output: out, ...evidence }));
  if (evidence.errors.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
