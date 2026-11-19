/**
 * Render one benchmark clip: the real web client (page.ts) over the frames prepare.ts dumped, stepped frame by frame
 * on a virtual clock, then encoded to H.264 with a poster and a frame strip for review.
 *   node tools/bench-clips/prepare.ts <momentId>      (sim lane: re-simulate, verify, dump frames)
 *   node tools/bench-clips/render.mjs <momentId>      (browser lane: render, encode)
 * Run both from a checkout of the release's frozen build (the build its publications record), with the campaign at
 * moments.json `campaign` (relative to that checkout, or BENCH_CLIPS_CAMPAIGN): the replay only reproduces the match
 * on the build that played it, and prepare.ts refuses to dump frames otherwise.
 * Outputs <BENCH_CLIPS_OUT or apps/web/public/benchmarks/clips>/<release>/<model>.{mp4,jpg}; raw frames and the
 * strip (<work>/<momentId>/strip.jpg: one frame per second) stay in scratch.
 * Env: BENCH_CLIPS_PORT (Vite, default 5297), CHROME, FFMPEG (default ~/.local/bin/ffmpeg).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { loadMoment, momentDir, ROOT } from './moments.ts';

const id = process.argv[2];
if (!id) throw new Error('usage: node tools/bench-clips/render.mjs <momentId>');
const moment = loadMoment(id);
const work = momentDir(id);
const verify = JSON.parse(readFileSync(join(work, 'verify.json'), 'utf8'));
if (!Object.values(verify.checks).every(Boolean)) throw new Error(`${id}: verify.json failed; run prepare.ts first`);
const views = gunzipSync(readFileSync(join(work, 'frames.jsonl.gz'))).toString('utf8').split('\n').map((line) => JSON.parse(line));

const W = 1280;
const H = 720;
const FPS = 25;
/** Virtual milliseconds per output frame and per sim tick (20 Hz). */
const FRAME_MS = 1000 / FPS;
const TICK_MS = 50;
const POST_END_MS = 1500;
const MAX_MS = 10000;
/** Size budget per clip (bytes) and the quality the first encode tries. */
const MAX_BYTES = 1.45e6;
const CRF = 25;
const ffmpeg = process.env.FFMPEG ?? join(homedir(), '.local/bin/ffmpeg');
const port = Number(process.env.BENCH_CLIPS_PORT ?? 5297);
const outDir = join(process.env.BENCH_CLIPS_OUT ?? join(ROOT, 'apps/web/public/benchmarks/clips'), moment.release);
const raw = join(work, 'raw');
rmSync(raw, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });
mkdirSync(outDir, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), id, ...a);

const { chromium } = createRequire(join(ROOT, 'tools/dev-mcp/package.json'))('playwright-core');
const { createServer } = await import(pathToFileURL(join(ROOT, 'apps/web/node_modules/vite/dist/node/index.js')).href);
const vite = await createServer({ root: join(ROOT, 'apps/web'), configFile: join(ROOT, 'apps/web/vite.config.ts'), logLevel: 'warn', server: { port, strictPort: true, host: '127.0.0.1', hmr: false } });
await vite.listen();
let browser;
const errors = [];
let recorded = 0;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1, permissions: ['local-network-access'] });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Virtual clock: real time through startup (shader compiles, async preparation), then frozen at the times we set.
  await page.addInitScript(() => {
    const real = performance.now.bind(performance);
    let at;
    performance.now = () => at ?? real();
    window.__clock = (t) => { at = t; };
  });
  await page.route('**/__bench-clip?*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}</style>`
      + `<canvas class="gl"></canvas><canvas class="overlay"></canvas><script type="module" src="/@fs${join(ROOT, 'tools/bench-clips/page.ts')}"></script>`,
  }));
  await page.goto(`http://127.0.0.1:${port}/__bench-clip?renderer=webgl&quality=full`);
  await page.waitForFunction(() => !!window.__clip, undefined, { timeout: 600000 });
  const t0 = Date.now();
  const opened = await page.evaluate(({ view, plane, candidate }) => window.__clip.open(view, plane, candidate), { view: views[0], plane: moment.plane, candidate: verify.candidate });
  log('opened', JSON.stringify(opened), `${Math.round((Date.now() - t0) / 1000)}s`);
  // Default pitch a little lower than the player's resting camera (1.0): more of the units' sides, still the whole fight.
  const shot = (s) => ({ x: s.x, y: s.y, dist: s.dist, yaw: s.yaw ?? opened.yaw, pitch: s.pitch ?? 0.9 });
  const a = shot(moment.camera);
  const b = shot(moment.end ?? moment.camera);
  const lerp = (p, q, k) => p + (q - p) * k;
  const start = await page.evaluate(() => performance.now());
  let fed = 1;
  let tick = views[0].tick;
  // A moment that ends the match holds on its aftermath (the Spire's fall plays out on the client clock) for
  // POST_END_MS; a clip never runs past MAX_MS, so a long moment starts later rather than losing its end.
  const post = views[views.length - 1].outcome !== 'running' ? POST_END_MS : 0;
  const from = Math.max(moment.from, moment.to - (MAX_MS - post) / TICK_MS);
  const span = moment.to - from;
  const total = Math.round((span * TICK_MS + post) / FRAME_MS);
  for (let n = 0; recorded < total; n++) {
    const now = start + n * FRAME_MS;
    const batch = [];
    // View i arrives at start + i × TICK_MS, as a live 20 Hz stream would.
    while (fed < views.length && start + fed * TICK_MS <= now) batch.push(views[fed++]);
    const k = Math.min(1, Math.max(0, (tick - from) / span));
    const e = k * k * (3 - 2 * k);
    const camera = { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), dist: lerp(a.dist, b.dist, e), yaw: lerp(a.yaw, b.yaw, e), pitch: lerp(a.pitch, b.pitch, e) };
    // Capture from the frame before the moment on (a frame advances the render clock by under one tick).
    const drawn = await page.evaluate(({ now, batch, camera, capture }) => {
      window.__clock(now);
      for (const view of batch) window.__clip.ingest(view);
      return window.__clip.frame(camera, capture);
    }, { now, batch, camera, capture: tick >= from - 1 });
    tick = drawn.tick;
    if (tick < from || !drawn.jpeg) continue;
    writeFileSync(join(raw, `f${String(recorded).padStart(4, '0')}.jpg`), Buffer.from(drawn.jpeg.slice(drawn.jpeg.indexOf(',') + 1), 'base64'));
    recorded++;
    if (recorded % 25 === 0) log(`frame ${recorded}/${total} tick ${tick.toFixed(1)} ${Math.round((Date.now() - t0) / 1000)}s`);
    if (fed >= views.length && tick > views[views.length - 1].tick + POST_END_MS / TICK_MS) { log('frames exhausted'); break; }
  }
} finally {
  await browser?.close().catch(() => {});
  await vite.close().catch(() => {});
}
if (errors.length) log('page errors', JSON.stringify(errors.slice(0, 10)));
if (!recorded) throw new Error('no frames recorded');

const mp4 = join(outDir, `${moment.model}.mp4`);
const input = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(raw, 'f%04d.jpg')];
const common = ['-c:v', 'libx264', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-an', '-movflags', '+faststart'];
execFileSync(ffmpeg, [...input, ...common, '-crf', String(CRF), mp4]);
if (statSync(mp4).size > MAX_BYTES) {
  // Two-pass at the bitrate the budget allows (5% container margin).
  const kbps = Math.floor(MAX_BYTES * 8 * 0.95 / (recorded / FPS) / 1000);
  const pass = join(work, 'x264-pass');
  execFileSync(ffmpeg, [...input, ...common, '-b:v', `${kbps}k`, '-pass', '1', '-passlogfile', pass, '-f', 'mp4', '/dev/null']);
  execFileSync(ffmpeg, [...input, ...common, '-b:v', `${kbps}k`, '-pass', '2', '-passlogfile', pass, mp4]);
}
// The poster is the clip's first frame, so the card does not jump when playback starts.
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', join(raw, 'f0000.jpg'), '-q:v', '4', join(outDir, `${moment.model}.jpg`)]);
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', mp4, '-vf', `select='not(mod(n\\,${FPS}))',scale=426:-1,tile=5x${Math.ceil(recorded / FPS / 5)}:padding=4`, '-frames:v', '1', '-q:v', '3', join(work, 'strip.jpg')]);
// Glitch check: any black frame, or the picture standing still for half a second (a stalled feed or clock).
const scan = spawnSync(ffmpeg, ['-hide_banner', '-i', mp4, '-vf', 'blackdetect=d=0.04:pix_th=0.08,freezedetect=n=0.0005:d=0.5', '-an', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
const glitches = scan.split('\n').filter((line) => /black_start|freeze_start/.test(line)).map((line) => line.replace(/^\[[^\]]*\]\s*/, ''));
log('done', JSON.stringify({ mp4, bytes: statSync(mp4).size, frames: recorded, seconds: recorded / FPS, glitches }));
if (glitches.length) process.exitCode = 1;
