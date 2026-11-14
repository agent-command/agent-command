/** Real client render recipes fed exclusively by serialized, team-fogged simulation views.
 * node apps/lookdev/scripts/orbit-combat.mjs /tmp/ac-orbitfx before|after
 * ORBIT_FX_ROOT selects an immutable baseline checkout; ORBIT_FX_PORT selects an unused Vite port.
 * Captures include deterministic 40-ship combat, shield impacts and a Lancer pulse, plus warmed CPU timings.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { createGame } from '../../../packages/game/src/agent/adapter.ts';
import { PLANE_Y } from '../../../packages/game/src/rules/contract.ts';

const out = resolve(process.argv[2] ?? '/tmp/ac-orbitfx');
const label = process.argv[3] ?? 'after';
const root = process.env.ORBIT_FX_ROOT ?? fileURLToPath(new URL('../../..', import.meta.url));
const port = Number(process.env.ORBIT_FX_PORT ?? 5237);
mkdirSync(out, { recursive: true });
function recipe(name) {
  const game = createGame({ seed: 7 });
  const sim = game.sim;
  const ships = [];
  // Recipes name the duel's armies (nw, se); the sim takes army indices in slot order (nw 0, se 1).
  const add = (kind, army, x, y) => { const e = sim.add(kind, army === 'nw' ? 0 : 1, 'orbit', x, y); ships.push(e); return e; };
  if (name === 'brawl-wide') {
    for (let side = 0; side < 2; side++) for (let i = 0; i < 20; i++) {
      add(['bastion', 'lancer', 'skiff', 'skiff'][i % 4], side ? 'se' : 'nw', side ? 25 + (i % 4) * 1.6 : 23 - (i % 4) * 1.6, 10 + Math.floor(i / 4) * 6);
    }
  } else {
    add('bastion', 'nw', 23, 24);
    add('lancer', 'se', 28, 24);
    add('skiff', 'se', 25.5, 26.5);
    add('lancer', 'nw', 20, 21);
    add('bastion', 'se', 26, 21);
  }
  // The recipe grants a real scan, rather than bypassing client visibility gates or importing god state.
  for (const army of sim.armies) {
    for (let y = 2; y < 48; y += 4) for (let x = 2; x < 48; x += 4) army.scans.push({ x, y, until: 300 });
    for (const vision of sim.vis) for (let c = 0; c < vision.length; c++) vision[c] |= army.group.bit;
  }
  // Each army names what it sees (game sim/aliases.ts): every ship, now that the scan shows it.
  sim.noteSightings();
  if (name === 'brawl-wide') {
    for (let side = 0; side < 2; side++) for (let i = 0; i < 20; i++) {
      const team = side ? 'se' : 'nw';
      const result = game.apply({ team, role: 'orbit' }, { kind: 'attack', units: [game.entityId(team, ships[side * 20 + i].id)], target: game.entityId(team, ships[(1 - side) * 20 + i].id) });
      if (!result.ok) throw new Error(`Brawl attack order rejected: ${JSON.stringify(result)}`);
    }
  }
  const ids = new Set(ships.map(e => game.entityId('nw', e.id)));
  const frames = [];
  for (let tick = 0; tick < 64; tick++) {
    sim.step();
    const v = JSON.parse(JSON.stringify(game.view('nw')));
    v.entities = v.entities.filter(e => ids.has(e.id));
    v.fx = v.fx.filter(f => f.plane === 'orbit');
    frames.push(v);
  }
  // The client draws each army in its match colour (world.setView adopts them; these frames bypass it).
  return { name, frames, ships: ids.size, armies: sim.armyIds.map((id, a) => ({ id, colour: sim.armyColour[a] })) };
}
const fixtures = ['brawl-wide', 'bastion-shield', 'lancer-pulse'].filter(name => !process.env.ORBIT_FX_SCENE || name === process.env.ORBIT_FX_SCENE).map(recipe);
const server = await createServer({ root: resolve(root, 'apps/web'), logLevel: 'warn', server: { hmr: false, port, strictPort: true, host: '127.0.0.1' } });
await server.listen();
let browser;
const evidence = { label, root, viewport: { width: 1440, height: 1000 }, errors: [], captures: [] };
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? `${homedir()}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`, headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: evidence.viewport, deviceScaleFactor: 1, permissions: ['local-network-access'] });
  page.on('pageerror', e => evidence.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') evidence.errors.push(m.text()); });
  await page.route('**/__orbit-combat?*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0;background:#171e3a}canvas{width:100vw;height:100vh;display:block}aside{position:absolute;top:24px;left:28px;color:#e9dcc4;font:14px/1.6 monospace;white-space:pre;pointer-events:none}</style><canvas></canvas><aside></aside>' }));
  await page.goto(`http://127.0.0.1:${port}/__orbit-combat?renderer=webgl`);
  evidence.backend = await page.evaluate(async () => {
    const [{ World }, fade, palette, ink, materials, fog, common] = await Promise.all([import('/src/world/world.ts'), import('/src/world/fade.ts'), import('/src/world/palette.ts'), import('/src/world/ink.ts'), import('/src/world/materials.ts'), import('/src/world/fog.ts'), import('/src/world/common.ts')]);
    const world = new World(document.querySelector('canvas'));
    await world.init();
    window.orbitRecipe = { world, fade, palette, ink, materials, fog, common, selected: new Set() };
    return world.backend;
  });
  for (const fixture of fixtures) {
    const state = await page.evaluate(async ({ fixture, orbitY, label }) => {
      const { world: w, fade, palette, ink, materials, fog, common, selected } = window.orbitRecipe;
      w.reset();
      common.setArmyColours(fixture.armies);
      fade.applyFade(3); palette.setViewLevel(3);
      w.combat.focus = 'orbit';
      const wide = fixture.name === 'brawl-wide';
      const camera = w.rig.camera;
      const distance = wide ? 57 : fixture.name === 'bastion-shield' ? 11 : 18;
      const cx = wide ? 0 : fixture.name === 'bastion-shield' ? 0.1 : -0.2;
      const cz = wide ? -1 : fixture.name === 'bastion-shield' ? 0.4 : -1.6;
      camera.position.set(cx + distance * 0.13, orbitY + distance * 0.83, cz + distance * 0.55);
      camera.lookAt(cx, orbitY + 0.35, cz); camera.updateMatrixWorld();
      ink.LINE_DIST.value = distance;
      let latest;
      const frame = (n, render = true) => {
        const now = n * 1000 / 60;
        const index = Math.min(fixture.frames.length - 1, Math.floor(n / 3));
        const v = fixture.frames[index];
        if (v !== latest) {
          latest = v;
          w.view = v;
          w.entities.ingest(v, now);
          w.layers.update(v, tick => tick / 20);
          fog.ingestVision(v, index === 0);
          w.combat.ingest(v, tick => w.entities.tickTime(tick, now));
          for (const f of v.fx) if (f.kind === 'shot' && f.tick >= v.tick - 1 && f.tp !== undefined) w.entities.fire(f.src, f.plane, f.x, f.y, w.entities.tickTime(f.tick, now), f.tp, f.tx, f.ty);
        }
        materials.clock.value = now / 1000;
        fog.stepFog(1 / 60);
        w.layers.frame(now / 1000, v, 0);
        w.layers.depths.group.visible = w.layers.surface.group.visible = w.layers.sky.group.visible = w.layers.surface.canopyRoot.visible = false;
        w.entities.frame(now, now / 1000, selected, undefined, 'nw', 'orbit', distance, w.layers.orbit.sunAngle.value);
        w.layers.orbit.follow(w.entities.tracks, now / 1000);
        w.combat.frame(now, 1 / 60, camera.position.y, w.entities.renderTick);
        if (render) w.pipeline.render();
      };
      // Warm every shader variant before recording or freezing the plate.
      for (let n = 0; n < 150; n++) frame(n);
      // Keep the snapshot at an actual firing event, rather than inventing an unrepresentative beam.
      const beamFrame = fixture.frames.findIndex((v, i) => i > 10 && v.fx.some(f => f.kind === 'shot' && f.subject === 'lancer' && f.tick === v.tick));
      const shieldFrame = fixture.frames.findIndex((v, i) => i > 10 && v.entities.some(e => e.kind === 'bastion' && e.side === 'nw' && e.shield < (fixture.frames[i - 1].entities.find(p => p.id === e.id)?.shield ?? 0)));
      const captureFrame = Math.max(15, fixture.name === 'bastion-shield' && shieldFrame >= 0 ? shieldFrame : beamFrame) * 3 + 8;
      w.reset(); latest = undefined;
      for (let n = 0; n <= captureFrame; n++) frame(n);
      document.querySelector('aside').textContent = `FIELD JOURNAL / ORBIT COMBAT · ${label.toUpperCase()}\n${fixture.name} · ${fixture.ships} ships · ${w.backend}`;
      await new Promise(requestAnimationFrame);
      w.pipeline.render();
      window.orbitRecipe.frame = frame;
      window.orbitRecipe.fixture = fixture;
      window.orbitRecipe.latest = () => latest;
      const locks = w.combat.orbitShots;
      return { ships: fixture.ships, tick: latest.tick, captureFrame, distance, drawCalls: w.renderer.info.render.drawCalls, triangles: w.renderer.info.render.triangles, shotCount: w.combat.shots.bolts.count + (locks?.bolts.count ?? 0), activeOrbitLocks: locks?.n ?? 0, activeShieldRipples: w.combat.orbitShields?.n ?? 0, shields: [...w.entities.tracks.values()].filter(t => t.e.shield > 0).length };
    }, { fixture, orbitY: PLANE_Y.orbit, label });
    const file = `${label}-${fixture.name}.png`;
    await page.screenshot({ path: resolve(out, file) });
    evidence.captures.push({ file, ...state });
    if (fixture.name === 'brawl-wide' && process.env.ORBIT_FX_TIMING !== '0') {
      evidence.timing = await page.evaluate(async () => {
        const { world: w, frame } = window.orbitRecipe;
        const samples = [], intervals = [];
        let previous = performance.now();
        for (let batch = 0; batch < 3; batch++) {
          w.reset();
          for (let i = 0; i < 150; i++) {
            await new Promise(requestAnimationFrame);
            const now = performance.now();
            const start = now;
            frame(i);
            const elapsed = performance.now() - start;
            if (i >= 30) { samples.push(elapsed); intervals.push(now - previous); }
            previous = now;
          }
        }
        samples.sort((a,b) => a-b); intervals.sort((a,b) => a-b);
        return { samples: samples.length, cpuP50Ms: samples[Math.floor(samples.length * .5)], cpuP95Ms: samples[Math.floor(samples.length * .95)], rafP50Ms: intervals[Math.floor(intervals.length * .5)], measurement: 'CPU update + render submission, warm shaders, 1440x1000 WebGL2; RAF interval separately (includes browser scheduling/GPU)' };
      });
      writeFileSync(resolve(out, `${label}-timing-evidence.json`), JSON.stringify(evidence.timing, null, 2) + '\n');
    }
  }
  writeFileSync(resolve(out, `${label}-evidence.json`), JSON.stringify(evidence, null, 2) + '\n');
  if (process.env.ORBIT_FX_LIVE === '1') {
    const api = async (path, body) => {
      const res = await fetch(`${process.env.ORBIT_FX_SERVER ?? 'http://127.0.0.1:2637'}/dev/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${process.env.AC_DEV_ADMIN_TOKEN}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return res.json();
    };
    const match = await api('matches', { mode: 'bots', opponent: 'novice', seed: 7, speed: 0 });
    const path = `matches/${match.roomId}`;
    // Each army names the ships its own way (game sim/aliases.ts): the spawn cheat answers with every army's names.
    const spawned = { nw: [], se: [] };
    try {
      await api(`${path}/cheat`, { op: 'reveal', army: 'nw', seconds: 60 });
      await api(`${path}/cheat`, { op: 'reveal', army: 'se', seconds: 60 });
      for (let side = 0; side < 2; side++) for (let i = 0; i < 20; i++) {
        const response = await api(`${path}/cheat`, { op: 'spawn', kind: ['bastion', 'lancer', 'skiff', 'skiff'][i % 4], army: side ? 'se' : 'nw', x: side ? 25 + (i % 4) * 1.6 : 23 - (i % 4) * 1.6, y: 10 + Math.floor(i / 4) * 6 });
        spawned.nw.push(response.names.nw[0]);
        spawned.se.push(response.names.se[0]);
      }
      await page.setViewportSize({ width: 960, height: 640 });
      await page.goto(`http://127.0.0.1:${port}/?renderer=webgl#r=${match.roomId}&t=${match.tokens.nw}`);
      await page.waitForFunction(() => window.__agentCommand?.world.view, null, { timeout: 60000 });
      // A view is available before first-load worker preparation and shader warming finish.
      await page.waitForFunction(() => performance.getEntriesByName('ac:match-first-frame').length > 0, null, { timeout: 60000 });
      await page.evaluate(async ({ roomId, hostileToken, ids }) => {
        const w = window.__agentCommand.world;
        w.renderer.setPixelRatio(0.75); w.resize();
        const { Connection } = await import('/src/net.ts');
        const hostile = await Connection.join(roomId, hostileToken, { view() {}, seats() {}, report() {}, left() {} });
        await window.__agentCommand.game().conn.setController('orbit', 'human');
        await hostile.setController('orbit', 'human');
        for (let i = 0; i < 20; i++) {
          await window.__agentCommand.game().conn.act('orbit', [{ kind: 'attack', units: [ids.nw[i]], target: ids.nw[20 + i] }]);
          await hostile.act('orbit', [{ kind: 'attack', units: [ids.se[20 + i]], target: ids.se[i] }]);
        }
        w.rig.goTo('orbit', performance.now(), 'jump');
        w.rig.lookAtTile(24, 23); w.rig.dist = 57; w.rig.yaw = Math.PI * .42;
      }, { roomId: match.roomId, hostileToken: match.tokens.se, ids: spawned });
      await api(`${path}/speed`, { speed: 1 });
      await page.waitForFunction(() => window.__agentCommand.world.view.tick >= 22, null, { timeout: 30000 });
      await page.screenshot({ path: resolve(out, `${label}-live-match-wide.png`) });
      evidence.live = await page.evaluate(ids => {
        const w = window.__agentCommand.world;
        const visible = [...w.entities.tracks.values()].filter(t => t.visible && ids.includes(t.e.id));
        return { tick: w.view.tick, backend: w.backend, visibleSpawnedShips: visible.length, shots: w.combat.shots.bolts.count + w.combat.orbitShots.bolts.count, activeOrbitLocks: w.combat.orbitShots.n, shieldRipples: w.combat.orbitShields.n, shields: visible.filter(t => t.e.shield > 0).length, connected: true, viewport: '960x640', pixelRatio: 0.75 };
      }, spawned.nw);
      await page.evaluate(() => {
        const w = window.__agentCommand.world;
        const bastion = [...w.entities.tracks.values()].find(t => t.e.kind === 'bastion' && t.e.side === 'nw' && t.visible && t.e.shield < t.e.maxShield);
        if (!bastion) throw new Error('Live Bastion not visible');
        w.rig.lookAtTile(bastion.rx, bastion.ry); w.rig.dist = 16;
      });
      await page.waitForFunction(() => window.__agentCommand.world.combat.orbitShields.n > 0, null, { timeout: 15000 });
      await page.screenshot({ path: resolve(out, `${label}-live-match-bastion.png`) });
      evidence.live.closeShieldRipples = await page.evaluate(() => window.__agentCommand.world.combat.orbitShields.n);
    } finally {
      await api(`${path}/end`, {});
    }
  }
  writeFileSync(resolve(out, `${label}-evidence.json`), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.errors.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
