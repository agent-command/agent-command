// Particles on a real paused match, real renderer and HUD: on WebGPU the compute step is read back and checked against
// the CPU pool's integration, then each backend renders a big fight (explosions and shots every 100 ms) over six
// burning zones while frame time is measured. Needs an isolated server pair, like check-camera.mjs:
//   AC_LAYOUT_URL (web), AC_LAYOUT_SERVER_URL (game server), AC_DEV_ADMIN_TOKEN.
// AC_PARTICLES_BACKENDS (webgpu,webgl), AC_PARTICLES_SECONDS (20), AC_PARTICLES_OUTPUT (/tmp/ac-particles).
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
assert(token, 'AC_DEV_ADMIN_TOKEN is required for the isolated audit server');
const out = process.env.AC_PARTICLES_OUTPUT ?? '/tmp/ac-particles';
const seconds = Number(process.env.AC_PARTICLES_SECONDS ?? 20);
const backends = (process.env.AC_PARTICLES_BACKENDS ?? 'webgpu,webgl').split(',');

async function admin(path, body) {
  const response = await fetch(`${server}/dev/matches${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert(response.ok, `dev-admin ${path}: ${response.status}`);
  return response.json();
}

await mkdir(out, { recursive: true });
const reports = [];
for (const backend of backends) {
  const match = await admin('', { mode: 'pvp', seed: 42, speed: 0 });
  const army = match.armies[0].id;
  await admin(`/${match.roomId}/cheat`, { op: 'reveal', army });
  await admin(`/${match.roomId}/step`, { ticks: 1 });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'),
    // Headless WebGPU on a GPU-less host: SwiftShader's Vulkan through the WebGPU service (plain --enable-unsafe-webgpu
    // drops its instance mid-session). Its canvas does not reach screenshots there; WebGL2 screenshots do.
    args: ['--no-sandbox', '--ignore-gpu-blocklist', ...(backend === 'webgpu' ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan,WebGPUService'] : ['--use-gl=angle', '--use-angle=gl'])],
  });
  let failure;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${web}/?${backend === 'webgl' ? 'renderer=webgl&' : ''}debug#r=${match.roomId}&t=${match.tokens[army]}`);
    await page.waitForFunction(() => !!window.__agentCommand?.game()?.view, undefined, { timeout: 600_000 });
    const name = await page.evaluate(() => window.__agentCommand.world.backend);
    assert.equal(name, backend === 'webgpu' ? 'WebGPU' : 'WebGL2', `requested ${backend} must not silently fall back`);

    // The fight: a fixed, seeded stream of unit and structure deaths and shots around one point, ingested through
    // Combat like any snapshot's fx; six burning zones in reach of the same camera.
    const centre = await page.evaluate(async () => {
      const { world, game } = window.__agentCommand;
      const view = game().view;
      const home = view.match.armies.find((a) => a.id === view.army).spireAt;
      const cx = Math.round((home.x * 2 + view.match.rules.map.size / 2) / 3), cy = Math.round((home.y * 2 + view.match.rules.map.size / 2) / 3);
      const { clockAt } = await import('/src/world/materials.ts');
      const scorches = [[-4, -3], [3, -4], [5, 2], [-2, 4], [-6, 2], [1, 0]].map(([dx, dy]) => ({ x: cx + dx, y: cy + dy, radius: 2.5, until: view.tick + 100_000 }));
      view.scorches = scorches;
      world.layers.deposits.update(view, (tick) => clockAt(world.entities.tickTime(tick, performance.now())));
      game().goTo('surface');
      world.rig.holdDive(1);
      world.rig.lookAtTile(cx, cy);
      world.rig.dist = 30;
      world.rig.pitch = 1;
      let t = view.tick;
      let seed = 1;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      window.__particleLoad = setInterval(() => {
        t++;
        const fx = [];
        for (let i = 0; i < 2; i++) fx.push({ kind: 'death', plane: 'surface', tick: t, x: cx + (rand() - 0.5) * 12, y: cy + (rand() - 0.5) * 12, subject: 'trooper' });
        if (t % 5 === 0) fx.push({ kind: 'death', plane: 'surface', tick: t, x: cx + (rand() - 0.5) * 10, y: cy + (rand() - 0.5) * 10, subject: 'turret' });
        for (let i = 0; i < 8; i++) {
          const x = cx + (rand() - 0.5) * 14, y = cy + (rand() - 0.5) * 14;
          fx.push({ kind: 'shot', plane: 'surface', tick: t, arrive: t, w: i % 3 ? 'rifle' : 'cannon', x, y, tx: x + (rand() - 0.5) * 6, ty: y + (rand() - 0.5) * 6 });
        }
        world.combat.ingest({ ...view, tick: t, fx, scorches }, () => performance.now());
      }, 100);
      return { cx, cy };
    });

    // Warm up (pipelines compile on first use), then measure frame intervals and the CPU time of the effects step.
    await page.waitForTimeout(12_000);
    const stats = await page.evaluate(async (ms) => {
      const { world } = window.__agentCommand;
      const combat = world.combat;
      const frame = combat.frame;
      let effectsMs = 0, calls = 0;
      combat.frame = (...args) => { const t0 = performance.now(); frame.apply(combat, args); effectsMs += performance.now() - t0; calls++; };
      const intervals = [];
      await new Promise((resolve) => {
        const end = performance.now() + ms;
        let last = performance.now();
        const step = (now) => { intervals.push(now - last); last = now; if (now < end) requestAnimationFrame(step); else resolve(); };
        requestAnimationFrame(step);
      });
      combat.frame = frame;
      intervals.shift();
      intervals.sort((a, b) => a - b);
      const mean = intervals.reduce((s, v) => s + v, 0) / Math.max(1, intervals.length);
      return {
        frames: intervals.length,
        meanMs: +mean.toFixed(1), p50Ms: +(intervals[Math.floor(intervals.length / 2)] ?? 0).toFixed(1), p95Ms: +(intervals[Math.floor(intervals.length * 0.95)] ?? 0).toFixed(1),
        effectsCpuMs: +(effectsMs / Math.max(1, calls)).toFixed(2),
        particles: { sparks: combat.sparks.n, smoke: combat.smoke.n, debris: combat.debris.n },
      };
    }, seconds * 1000);
    await page.screenshot({ path: join(out, `${backend}-mid.png`) });
    await page.evaluate(() => { window.__agentCommand.world.rig.dist = 14; });
    await page.waitForTimeout(4_000);
    await page.screenshot({ path: join(out, `${backend}-near.png`) });

    // WebGPU: run the compute step for a known spawn on a fixed dt sequence and read the slot back.
    const readback = await page.evaluate(async () => {
      const { world } = window.__agentCommand;
      const pool = world.combat.sparks;
      if (!pool.kernels?.length || !pool.positions) return { skipped: 'CPU pool' };
      clearInterval(window.__particleLoad);
      const frame = world.frame;
      world.frame = () => undefined;
      try {
        world.combat.reset();
        const paint = { r: 1, g: 0.5, b: 0.25 };
        const spawns = [[1, 3, -2, 2, 4, -1, 9, 0.5, 2], [0, 1, 0, -1, 0.5, 2, -0.6, 1.2, -1e9]];
        for (const [x, y, z, vx, vy, vz, g, drag, floor] of spawns) pool.spawn(1, x, y, z, vx, vy, vz, 10, 0.2, 0.1, paint, 1, g, drag, floor);
        const dts = [0.05, 0.03, 0.07, 0.05, 0.04, 0.06, 0.05, 0.05];
        for (const dt of dts) {
          pool.update(dt);
          world.combat.dispatch(world.renderer);
        }
        const gpu = new Float32Array(await world.renderer.getArrayBufferAsync(pool.positions)).slice(0, 8);
        const cpu = [];
        for (const [x, y, z, vx, vy, vz, g, drag, floor] of spawns) {
          let px = x, py = y, pz = z, ux = vx, uy = vy, uz = vz, age = 0;
          for (const dt of dts) {
            const d = Math.max(0, 1 - drag * dt);
            ux *= d; uy = (uy - g * dt) * d; uz *= d;
            px += ux * dt; py = Math.max(floor, py + uy * dt); pz += uz * dt; age += dt;
          }
          cpu.push(px, py, pz, age);
        }
        const error = Math.max(...cpu.map((v, i) => Math.abs(v - gpu[i])));
        world.combat.reset();
        world.combat.flame(1, 0, 1, 0, 2, 1, 0, 0);
        pool.update(0.032);
        world.combat.dispatch(world.renderer);
        const flame = new Float32Array(await world.renderer.getArrayBufferAsync(pool.positions)).slice(0, 4);
        return { gpu: Array.from(gpu), cpu, maxError: error, flame: { live: pool.n, first: Array.from(flame) } };
      } finally {
        world.frame = frame;
      }
    });
    reports.push({ backend, renderer: name, centre, ...stats, readback, errors });
    console.log(JSON.stringify(reports.at(-1)));
    if (backend === 'webgpu') {
      assert.equal(typeof readback.maxError, 'number', 'WebGPU must exercise compute and read back its storage buffer');
      assert(readback.flame.live >= 35, 'the flamer must spawn its body and core through the compute pool');
      assert(Math.abs(readback.flame.first[0] - 1.6 * 0.032) < 1e-5, 'flame velocity must advance on the GPU');
      assert(Math.abs(readback.flame.first[3] - 0.032) < 1e-5, 'flame lifetime must advance on the GPU');
    }
    if (readback.maxError !== undefined) assert(readback.maxError < 1e-3, `compute step diverges from the CPU pool by ${readback.maxError}`);
    assert.deepEqual(errors, [], 'no page errors');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await browser.close();
    // A match may expire after a failed join; keep the original renderer/admission error in that case.
    try {
      await admin(`/${match.roomId}/end`, {});
    } catch (cleanup) {
      throw failure ? new AggregateError([failure, cleanup], 'Particle smoke and match cleanup failed') : cleanup;
    }
  }
}
await writeFile(join(out, 'report.json'), JSON.stringify(reports, null, 2));
