// First-paint diagnostic for the home menu and its 3D backdrop (never builds or starts servers):
//   node apps/web/scripts/check-first-paint.mjs https://agentcommand.gg prod
//   node apps/web/scripts/check-first-paint.mjs http://127.0.0.1:2650 local --trace
//   node apps/web/scripts/check-first-paint.mjs http://127.0.0.1:2650 local-3g --throttle
// One headless Chromium, CPU throttling off, cold HTTP cache per run (fresh context), then one warm reload in the same
// context. Records: the boot shell's logo and backdrop still (Element Timing `shell-logo`, `shell-still`), menu
// (ac:home-ready), poster/first backdrop pixel (ac:backdrop-poster), first live 3D frame (ac:backdrop-first-frame), full
// detail (ac:backdrop-detail), the bytes transferred before each, long tasks, resource
// timings, GL call accounting (shader link/compile, buffer and texture uploads) and the preview-worker round trip. A
// screencast filmstrip is written at 0.5/1/2/5/10 s after navigation. --trace also records a Chromium performance trace
// of the cold run; --throttle emulates DevTools' Fast 3G (562.5 ms RTT, 180 KB/s down, 84 KB/s up) and a 4× slower CPU.
// AC_FP_OUTPUT defaults to /tmp/ac-first-paint; AC_FP_RUNS (default 2) cold runs; AC_FP_TIMEOUT_MS (default 90000).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [baseArg = 'http://127.0.0.1:2650', label = 'diagnostic', ...flags] = process.argv.slice(2);
assert(/^[a-zA-Z0-9_-]+$/.test(label), 'LABEL must contain only letters, numbers, underscores, or hyphens');
assert(flags.every((flag) => ['--trace', '--webgpu', '--throttle'].includes(flag)), 'Supported flags: --trace, --webgpu, --throttle');
const throttle = flags.includes('--throttle');
const base = new URL(baseArg);
if (!flags.includes('--webgpu')) base.searchParams.set('renderer', 'webgl');
base.searchParams.set('debug', '');
const out = join(process.env.AC_FP_OUTPUT ?? '/tmp/ac-first-paint', label);
const runs = Number(process.env.AC_FP_RUNS ?? 2);
const timeoutMs = Number(process.env.AC_FP_TIMEOUT_MS ?? (throttle ? 180000 : 90000));
const shots = [500, 1000, 2000, 5000, 10000];
const require = createRequire(new URL('../../../tools/dev-mcp/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const sharp = createRequire(import.meta.url)('sharp');
const chromiumPath = process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
const chromiumArgs = ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'];
const categories = [
  'toplevel', 'devtools.timeline', 'blink.user_timing', 'v8', 'gpu', 'loading', 'netlog',
  'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-v8.compile',
  'disabled-by-default-v8.cpu_profiler',
].join(',');
await mkdir(out, { recursive: true });

/** Page-side probes: marks around the backdrop's phases and GL call accounting, without changing app behaviour. */
function probe() {
  const mark = (name) => performance.mark(`probe:${name}`);
  const gl = {};
  const slow = [];
  const account = (proto, name, kind) => {
    const original = proto[name];
    if (!original) return;
    proto[name] = function (...args) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally {
        const ms = performance.now() - start;
        const row = gl[kind] ??= { calls: 0, ms: 0, maxMs: 0 };
        row.calls++;
        row.ms += ms;
        if (ms > row.maxMs) row.maxMs = ms;
        if (ms > 8 && slow.length < 400) slow.push({ kind, name, start, ms });
      }
    };
  };
  const proto = WebGL2RenderingContext.prototype;
  for (const name of ['compileShader', 'linkProgram', 'getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'getShaderInfoLog']) account(proto, name, 'shader');
  for (const name of ['bufferData', 'bufferSubData']) account(proto, name, 'buffer');
  for (const name of ['texImage2D', 'texImage3D', 'texSubImage2D', 'texSubImage3D', 'texStorage2D', 'texStorage3D', 'generateMipmap']) account(proto, name, 'texture');
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) account(proto, name, 'draw');
  for (const name of ['readPixels', 'clientWaitSync', 'getError', 'finish']) account(proto, name, 'sync');
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (type === 'webgl2' || type === 'webgpu') mark(`get-context-${type}`);
    const context = getContext.call(this, type, ...rest);
    if (type === 'webgl2' && context && !window.__fpRenderer) {
      const info = context.getExtension('WEBGL_debug_renderer_info');
      window.__fpRenderer = info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER);
      window.__fpParallel = !!context.getExtension('KHR_parallel_shader_compile');
    }
    return context;
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      const name = String(url).split('/').pop().split('-')[0].split('.')[0];
      mark(`worker-${name}-start`);
      let posts = 0;
      const post = this.postMessage;
      this.postMessage = (...args) => { mark(`worker-${name}-post-${++posts}`); return post.apply(this, args); };
      let replies = 0;
      this.addEventListener('message', () => mark(`worker-${name}-reply-${++replies}`));
    }
  };
  const wrap = (object, name, label) => {
    const original = object[name];
    let n = 0;
    object[name] = function (...args) {
      const i = ++n;
      if (i <= 4) mark(`${label}-${i}-start`);
      const result = original.apply(this, args);
      if (i <= 4 && result && typeof result.then === 'function') result.then(() => mark(`${label}-${i}-end`), () => mark(`${label}-${i}-error`));
      return result;
    };
  };
  let runtime;
  Object.defineProperty(window, '__agentCommand', {
    configurable: true,
    get: () => runtime,
    set: (value) => {
      runtime = value;
      mark('runtime-created');
      wrap(value.world, 'setView', 'set-view');
      // compileAsync accounting: calls and time from issue to linked (warm-ups await these).
      const renderer = value.world.renderer;
      const compile = renderer.compileAsync;
      const compiles = window.__fp.compiles = { calls: 0, waitMs: 0, maxMs: 0 };
      renderer.compileAsync = function (...args) {
        const start = performance.now();
        compiles.calls++;
        return compile.apply(this, args).then(() => {
          const ms = performance.now() - start;
          compiles.waitMs += ms;
          if (ms > compiles.maxMs) compiles.maxMs = ms;
        });
      };
      wrap(value.world, 'prepareFirstFrame', 'prepare-first-frame');
    },
  });
  const longTasks = [];
  new PerformanceObserver((list) => { for (const t of list.getEntries()) longTasks.push({ start: t.startTime, duration: t.duration }); }).observe({ type: 'longtask', buffered: true });
  let previous = 0;
  const raf = [];
  const tick = (now) => {
    if (previous && raf.length < 20000) raf.push(now - previous);
    previous = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // index.html's boot shell: its backdrop still (a CSS background) and logo, by Element Timing render time.
  const elements = {};
  new PerformanceObserver((list) => { for (const e of list.getEntries()) elements[e.identifier] ??= e.renderTime || e.loadTime; }).observe({ type: 'element', buffered: true });
  window.__fp = { gl, slow, longTasks, raf, elements };
}

async function trace(cdp, path, run) {
  await cdp.send('Tracing.start', { categories, options: 'record-as-much-as-possible', transferMode: 'ReturnAsStream' });
  try { await run(); } finally {
    const completed = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await completed;
    const file = createWriteStream(path);
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream, size: 1 << 20 });
      if (!file.write(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data)) await once(file, 'drain');
      if (chunk.eof) break;
    }
    file.end();
    await once(file, 'finish');
    await cdp.send('IO.close', { handle: stream });
  }
}

/** Main-thread and worker busy time by top-level task, between navigation and `endMs` (page clock). */
function summarizeTrace(events, origin, endMs) {
  const threads = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name);
  const navStart = events.find((e) => e.name === 'navigationStart' && e.args?.data?.isLoadingMainFrame)?.ts;
  const t0 = navStart ?? Math.min(...events.filter((e) => e.ts > 0).map((e) => e.ts));
  const end = t0 + endMs * 1000;
  const busy = new Map();
  const kinds = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur || e.ts < t0 || e.ts > end) continue;
    const thread = threads.get(`${e.pid}:${e.tid}`) ?? `${e.pid}:${e.tid}`;
    if (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') {
      const row = busy.get(thread) ?? { tasks: 0, ms: 0, maxMs: 0, over50: 0 };
      row.tasks++;
      row.ms += e.dur / 1000;
      row.maxMs = Math.max(row.maxMs, e.dur / 1000);
      if (e.dur > 50000) row.over50++;
      busy.set(thread, row);
    }
    if (/^(CrRendererMain|DedicatedWorker thread)$/.test(thread) && /^(EvaluateScript|v8.compile|v8.compileModule|ParseHTML|FunctionCall|RunMicrotasks|Layout|UpdateLayoutTree|Paint|GPUTask|v8.parseOnBackground|v8.evaluateModule|ResourceReceivedData|TimerFire|FireAnimationFrame|MajorGC|MinorGC|V8.GC_.*)$/.test(e.name)) {
      const key = `${thread}:${e.name}`;
      const row = kinds.get(key) ?? { count: 0, ms: 0 };
      row.count++;
      row.ms += e.dur / 1000;
      kinds.set(key, row);
    }
  }
  const round = (rows) => Object.fromEntries([...rows].sort((a, b) => b[1].ms - a[1].ms).slice(0, 30)
    .map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, Math.round(vv * 10) / 10]))]));
  return { busy: round(busy), kinds: round(kinds), origin };
}

const marksOf = (entries) => Object.fromEntries(entries.map((m) => [m.name, Math.round(m.startTime)]));

/** Bytes on the wire (document included) whose responses completed by `ms` after navigation. */
const bytesBy = (r, ms) => ms === undefined ? undefined
  : r.nav.transfer + r.resources.filter((x) => x.end <= ms).reduce((s, x) => s + x.transfer, 0);

async function measure(context, cdp, page, label, traced) {
  const frames = [];
  const onFrame = async ({ data, metadata, sessionId }) => {
    frames.push({ at: metadata.timestamp * 1000, data });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 800, maxHeight: 450, everyNthFrame: 1 });
  const go = async () => {
    if (label === 'warm') await page.reload({ waitUntil: 'commit' });
    else await page.goto(base.href, { waitUntil: 'commit' });
    await page.waitForFunction(() => performance.getEntriesByName('ac:backdrop-detail').length || performance.getEntriesByName('ac:backdrop-first-frame').length, undefined, { timeout: timeoutMs, polling: 100 });
    // Progressive builds (they show a still) mark full detail; older builds are complete at their first frame.
    await page.waitForFunction(() => performance.getEntriesByName('ac:backdrop-detail').length
      || (!performance.getEntriesByName('ac:backdrop-poster').length && performance.now() > performance.getEntriesByName('ac:backdrop-first-frame')[0].startTime + 4000), undefined, { timeout: timeoutMs, polling: 100 });
    await page.waitForTimeout(Math.max(0, shots.at(-1) - await page.evaluate(() => performance.now())) + 300);
  };
  if (traced) await trace(cdp, join(out, `${label}.trace.json`), go);
  else await go();
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  const result = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
    const resources = performance.getEntriesByType('resource').map((r) => ({
      name: r.name.replace(location.origin, ''), start: Math.round(r.startTime), end: Math.round(r.responseEnd),
      transfer: r.transferSize, decoded: r.decodedBodySize,
    }));
    return {
      origin: performance.timeOrigin,
      marks: performance.getEntriesByType('mark').map((m) => ({ name: m.name, startTime: m.startTime })),
      nav: { responseEnd: Math.round(nav.responseEnd), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), transfer: nav.transferSize },
      paints, resources, renderer: window.__fpRenderer, parallel: window.__fpParallel, probe: window.__fp,
    };
  });
  const marks = marksOf(result.marks);
  for (const [id, ms] of Object.entries(result.probe.elements)) marks[`el:${id}`] = Math.round(ms);
  const end = marks['ac:backdrop-detail'] ?? marks['ac:backdrop-first-frame'];
  const longTasks = result.probe.longTasks.filter((t) => t.start < end + 4000);
  const raf = result.probe.raf;
  // Filmstrip: the last screencast frame at or before each time after navigation.
  const tiles = [];
  for (const at of shots) {
    const frame = frames.filter((f) => f.at - result.origin <= at).at(-1);
    if (!frame) continue;
    const path = join(out, `${label}-${at}ms.jpg`);
    await writeFile(path, Buffer.from(frame.data, 'base64'));
    tiles.push({ at, path });
  }
  if (tiles.length) {
    const w = 400;
    const h = 225;
    const composite = await Promise.all(tiles.map(async (tile, i) => ({ input: await sharp(tile.path).resize(w, h).toBuffer(), left: i * (w + 6), top: 0 })));
    await sharp({ create: { width: tiles.length * (w + 6) - 6, height: h, channels: 3, background: '#000' } }).composite(composite).png().toFile(join(out, `${label}-filmstrip.png`));
  }
  const gl = Object.fromEntries(Object.entries(result.probe.gl).map(([k, v]) => [k, { calls: v.calls, ms: Math.round(v.ms), maxMs: Math.round(v.maxMs) }]));
  return {
    label, marks, paints: result.paints, nav: result.nav, renderer: result.renderer, parallel: result.parallel, gl, compiles: result.probe.compiles,
    slowGl: result.probe.slow.map((s) => ({ ...s, start: Math.round(s.start), ms: Math.round(s.ms) })),
    longTasks: { count: longTasks.length, totalMs: Math.round(longTasks.reduce((s, t) => s + t.duration, 0)), maxMs: Math.round(Math.max(0, ...longTasks.map((t) => t.duration))), over100: longTasks.filter((t) => t.duration > 100).length, list: longTasks.map((t) => [Math.round(t.start), Math.round(t.duration)]) },
    rafOver50: raf.filter((d) => d > 50).length,
    resources: result.resources,
    filmstrip: tiles.map((t) => t.path),
    origin: result.origin,
  };
}

const browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: chromiumArgs });
const report = { base: base.href, startedAt: new Date().toISOString(), chromiumArgs, runs: [] };
try {
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await context.addInitScript(probe);
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error('pageerror', error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle ? 4 : 1 });
    if (throttle) {
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 });
    }
    const traced = run === 0 && flags.includes('--trace');
    const cold = await measure(context, cdp, page, `cold${run}`, traced);
    if (traced) {
      const events = JSON.parse(await readFile(join(out, `cold${run}.trace.json`), 'utf8')).traceEvents ?? [];
      cold.trace = summarizeTrace(events, cold.origin, (cold.marks['ac:backdrop-detail'] ?? cold.marks['ac:backdrop-first-frame']) + 1000);
    }
    report.runs.push(cold);
    if (run === runs - 1) report.runs.push(await measure(context, cdp, page, 'warm', false));
    await context.close();
  }
} finally {
  await browser.close();
}
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
const pick = ['el:shell-logo', 'el:shell-still', 'ac:home-ready', 'ac:backdrop-poster', 'ac:backdrop-first-frame', 'ac:backdrop-detail'];
const kb = (bytes) => bytes === undefined ? '-' : `${Math.round(bytes / 1024)} KB`;
for (const r of report.runs) {
  const m = r.marks;
  // The JS still is inside #app, which stays transparent until the menu is ready: it is visible from the later of the
  // two. The boot shell's still is visible from its own paint.
  const poster = m['ac:backdrop-poster'] === undefined ? undefined : Math.max(m['ac:backdrop-poster'], m['ac:home-ready']);
  const visible = Math.min(m['el:shell-still'] ?? Infinity, poster ?? Infinity, m['ac:backdrop-first-frame'] ?? Infinity);
  const live = r.longTasks.list.filter(([start]) => start >= (m['ac:backdrop-first-frame'] ?? Infinity) && start < (m['ac:backdrop-detail'] ?? Infinity));
  console.log(`${r.label}: fcp ${r.paints['first-contentful-paint']} ms; ${pick.map((k) => `${k.slice(3)} ${m[k] ?? '-'}`).join('; ')}; backdrop visible ${visible} ms (+${visible - m['ac:home-ready']} after menu); longtasks ${r.longTasks.count} (max ${r.longTasks.maxMs} ms, total ${r.longTasks.totalMs} ms; ${live.length} while streaming, max ${Math.max(0, ...live.map(([, d]) => d))} ms); raf>50ms ${r.rafOver50}; compiles ${JSON.stringify(r.compiles)}; ${r.renderer}`);
  console.log(`  bytes before: fcp ${kb(bytesBy(r, r.paints['first-contentful-paint']))}; ${pick.map((k) => `${k.slice(3)} ${kb(bytesBy(r, m[k]))}`).join('; ')}; backdrop visible ${kb(bytesBy(r, visible))}`);
}
console.log(`report: ${join(out, 'report.json')}`);
