// Diagnostic replay (production build/server must already be running; this script never builds):
//   node apps/web/scripts/check-load-followup.mjs http://127.0.0.1:2641 before
//   node apps/web/scripts/check-load-followup.mjs http://127.0.0.1:2642 after
//   node apps/web/scripts/check-load-followup.mjs http://127.0.0.1:2641 home --home-only
// AC_LOAD_OUTPUT defaults to /tmp/ac-load-followup; each LABEL gets its own directory.
// AC_LOAD_HOME_MS=8000, AC_LOAD_SETTLE_MS=600, AC_LOAD_TIMEOUT_MS=180000.
// AC_LOAD_RUN_KIND records operator-declared slot provenance; the harness cannot infer isolation.
// --expect-backdrop waits for ac:backdrop-first-frame and asserts home-to-match World reuse.
// --analyze-only refreshes summaries from existing trace files, without launching a browser.
// Uses the real home Play button (private auto-start lobby vs idle bots), Game.goTo, and unmodified scene
// visibility/materials/fog.
// "first/second" are incoming switch visits. Surface is necessarily already visible at loader
// completion; its first row is the first return from Depths, NOT a cold Surface exposure.
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const [baseArg = 'http://127.0.0.1:2641', label = 'diagnostic', ...flags] = process.argv.slice(2);
assert(/^[a-zA-Z0-9_-]+$/.test(label), 'LABEL must contain only letters, numbers, underscores, or hyphens');
assert(flags.every((flag) => ['--home-only', '--expect-backdrop', '--analyze-only'].includes(flag)), 'Supported flags: --home-only, --expect-backdrop, --analyze-only');
const homeOnly = flags.includes('--home-only');
const analyzeOnly = flags.includes('--analyze-only');
const expectBackdrop = flags.includes('--expect-backdrop');
const base = new URL(baseArg);
base.hash = '';
base.searchParams.set('renderer', 'webgl');
base.searchParams.set('debug', '');
const out = join(process.env.AC_LOAD_OUTPUT ?? '/tmp/ac-load-followup', label);
const homeMs = Number(process.env.AC_LOAD_HOME_MS ?? 8000);
const settleMs = Number(process.env.AC_LOAD_SETTLE_MS ?? 600);
const timeoutMs = Number(process.env.AC_LOAD_TIMEOUT_MS ?? 180000);
assert([homeMs, settleMs, timeoutMs].every((n) => Number.isFinite(n) && n > 0), 'Timing overrides must be positive milliseconds');
const require = createRequire(new URL('../../../tools/dev-mcp/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const chromiumPath = process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
const chromiumArgs = ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'];
const categories = [
  'toplevel', 'devtools.timeline', 'blink.user_timing', 'v8', 'gpu',
  'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-v8.compile',
  'disabled-by-default-v8.cpu_profiler',
].join(',');
await mkdir(out, { recursive: true });
const report = {
  schema: 1, label, base: base.href, kind: process.env.AC_LOAD_RUN_KIND ?? 'diagnostic (operator has not declared host isolation)',
  startedAt: new Date().toISOString(), chromiumPath, chromiumArgs,
  policy: {
    homeMs, settleMs, timeoutMs, viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1,
    expectBackdrop,
    loaderGate: 'exact performance mark ac:match-first-frame; a populated game/view is not sufficient',
    visitWindow: 'immediately before Game.goTo until rig.focus matches, rig.diving is false, then a full settling interval',
    surface: 'Surface is loader-initial focus. First/second rows measure first/second incoming transitions from Depths, not first shader exposure.',
    sequence: ['depths', 'surface', 'sky', 'orbit', 'depths', 'surface', 'sky', 'orbit'],
    limitations: 'Headless GL diagnostics include trace overhead and shared-host noise. World.frame CPU time is not GPU execution time; RAF intervals include scheduling and GPU stalls. No browser cache survives a fresh run. Incoming Depths source differs on visit two; source and span are reported.',
  },
  errors: [], console: [], visits: [], artifacts: [],
};
const browser = analyzeOnly ? undefined : await chromium.launch({ headless: true, executablePath: chromiumPath, args: chromiumArgs });
let tracing = false;
let cdp;

function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, maxMs: null, p95Ms: null, medianMs: null, over50ms: 0 };
  return {
    count: sorted.length, maxMs: sorted.at(-1), p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1], over50ms: sorted.filter((n) => n > 50).length,
  };
}
function summarize(samples, start, end) {
  const frames = samples.frames.filter((frame) => frame.start >= start && frame.start < end);
  const raf = samples.raf.filter((frame) => frame.start >= start && frame.start < end);
  const longTasks = samples.longTasks.filter((task) => task.start < end && task.start + task.duration > start);
  return {
    worldFrame: stats(frames.filter((frame) => frame.render).map((frame) => frame.duration)),
    worldUpdateOnly: stats(frames.filter((frame) => !frame.render).map((frame) => frame.duration)),
    rafInterval: stats(raf.map((frame) => frame.interval)),
    longTask: { ...stats(longTasks.map((task) => task.duration)), totalMs: longTasks.reduce((sum, task) => sum + task.duration, 0) },
    worstWorldFrames: frames.toSorted((a, b) => b.duration - a.duration).slice(0, 12),
    longTasks,
  };
}
function summarizeTrace(events, name) {
  const traceMarks = events.filter((event) => event.cat?.includes('user_timing') && /^(ac:|load-followup:)/.test(event.name))
    .map((event) => ({ name: event.name, ts: event.ts, ph: event.ph }));
  const startName = name === 'match-startup' ? 'load-followup:match-entry' : `load-followup:${name}:start`;
  const endName = name === 'home' ? 'load-followup:home-window-end'
    : name === 'match-startup' ? 'load-followup:match-warmed' : `load-followup:${name}:end`;
  const start = traceMarks.find((mark) => mark.name === startName)?.ts ?? -Infinity;
  const end = traceMarks.find((mark) => mark.name === endName)?.ts ?? Infinity;
  const eventGroups = new Map();
  for (const event of events) {
    if (event.ph !== 'X' || !event.dur || event.ts >= end || event.ts + event.dur <= start) continue;
    const key = `${event.cat}:${event.name}`;
    let group = eventGroups.get(key);
    if (!group) eventGroups.set(key, group = { category: event.cat, name: event.name, count: 0, totalMs: 0, maxMs: 0 });
    const duration = (Math.min(end, event.ts + event.dur) - Math.max(start, event.ts)) / 1000;
    group.count++;
    group.totalMs += duration;
    group.maxMs = Math.max(group.maxMs, duration);
  }
  // Trace CPU profiles are sampled wall time, including blocking native GL calls, not GPU time.
  const profiles = new Map();
  for (const event of events) {
    if (event.name !== 'Profile' && event.name !== 'ProfileChunk') continue;
    const key = `${event.pid}:${event.id}`;
    let profile = profiles.get(key);
    if (!profile) profiles.set(key, profile = { time: event.args?.data?.startTime ?? event.ts, nodes: new Map(), chunks: [] });
    if (event.name === 'Profile') profile.time = event.args?.data?.startTime ?? event.ts;
    const data = event.args?.data;
    for (const node of data?.cpuProfile?.nodes ?? []) profile.nodes.set(node.id, node);
    if (data?.cpuProfile?.samples) profile.chunks.push(data);
  }
  const sampled = new Map();
  for (const profile of profiles.values()) {
    for (const chunk of profile.chunks) {
      for (let i = 0; i < chunk.cpuProfile.samples.length; i++) {
        const delta = chunk.timeDeltas?.[i] ?? 0;
        const sampleStart = profile.time;
        profile.time += delta;
        const weight = (Math.min(end, profile.time) - Math.max(start, sampleStart)) / 1000;
        if (weight <= 0) continue;
        let node = profile.nodes.get(chunk.cpuProfile.samples[i]);
        let self = true;
        while (node) {
          const frame = node.callFrame;
          const key = JSON.stringify(frame);
          let group = sampled.get(key);
          if (!group) sampled.set(key, group = { ...frame, selfMs: 0, inclusiveMs: 0 });
          if (self) group.selfMs += weight;
          group.inclusiveMs += weight;
          self = false;
          node = profile.nodes.get(node.parent);
        }
      }
    }
  }
  const scriptSources = [...new Set([
    ...events.map((event) => event.args?.data?.url),
    ...[...sampled.values()].map((frame) => frame.url),
  ].filter((url) => typeof url === 'string' && /^https?:/.test(url)))];
  return {
    window: { startMark: Number.isFinite(start) ? startName : null, endMark: Number.isFinite(end) ? endName : null, startUs: Number.isFinite(start) ? start : null, endUs: Number.isFinite(end) ? end : null },
    topEventsByMax: [...eventGroups.values()].sort((a, b) => b.maxMs - a.maxMs).slice(0, 35),
    shaderEvents: [...eventGroups.values()].filter((event) => /shader|compile|linkprogram|pipeline/i.test(event.name)),
    sampledSelf: [...sampled.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 35),
    sampledInclusive: [...sampled.values()].sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 35),
    scriptSources, traceMarks,
  };
}

async function startTrace() {
  assert(!tracing, 'A trace is already running');
  await cdp.send('Tracing.start', { categories, options: 'record-as-much-as-possible', transferMode: 'ReturnAsStream' });
  tracing = true;
}
async function stopTrace(name) {
  assert(tracing, 'No trace is running');
  const completed = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  const { stream, dataLossOccurred = false } = await completed;
  tracing = false;
  const path = join(out, `${name}.trace.json`);
  const file = createWriteStream(path);
  try {
    while (true) {
      const chunk = await cdp.send('IO.read', { handle: stream, size: 1024 * 1024 });
      const data = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data;
      if (!file.write(data)) await once(file, 'drain');
      if (chunk.eof) break;
    }
    file.end();
    await once(file, 'finish');
  } finally {
    await cdp.send('IO.close', { handle: stream });
  }
  const trace = JSON.parse(await readFile(path, 'utf8'));
  const events = trace.traceEvents ?? [];
  const summary = { path, bytes: (await stat(path)).size, dataLossOccurred, ...summarizeTrace(events, name) };
  report.artifacts.push({ name, ...summary });
  return summary;
}

try {
  if (analyzeOnly) {
    const captured = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    Object.assign(report, captured);
    if (process.env.AC_LOAD_RUN_KIND) report.kind = process.env.AC_LOAD_RUN_KIND;
    report.artifacts = [];
    for (const name of ['home', ...(report.matchStartup ? ['match-startup'] : []), ...report.visits.map((row) => `${row.plane}-${row.visit}`)]) {
      const target = name === 'home' ? report.home : name === 'match-startup' ? report.matchStartup
        : report.visits.find((row) => `${row.plane}-${row.visit}` === name);
      const trace = JSON.parse(await readFile(target.trace.path, 'utf8'));
      target.trace = { ...target.trace, ...summarizeTrace(trace.traceEvents ?? [], name) };
      report.artifacts.push({ name, ...target.trace });
      await writeFile(join(out, `${name}.json`), JSON.stringify(target, null, 2));
    }
    report.analysisUpdatedAt = new Date().toISOString();
  } else {
  const context = await browser.newContext({ viewport: report.policy.viewport, deviceScaleFactor: 1 });
  // Home Play uses the remembered practice level; idle bots keep the measured scene free of combat effects.
  await context.addInitScript(() => localStorage.setItem('agent-command.practice-level', 'idle'));
  // Fixed-capacity numeric buffers avoid creating a diagnostic object every render/RAF.
  await context.addInitScript(() => {
    const capacity = 120000;
    const planes = ['depths', 'surface', 'sky', 'orbit'];
    const frameStart = new Float64Array(capacity);
    const frameDuration = new Float64Array(capacity);
    const frameLevel = new Float64Array(capacity);
    const framePlane = new Int8Array(capacity);
    const frameDiving = new Uint8Array(capacity);
    const frameRender = new Uint8Array(capacity);
    const frameWorld = new Uint16Array(capacity);
    const rafStart = new Float64Array(capacity);
    const rafInterval = new Float64Array(capacity);
    const worldIds = new WeakMap();
    const hooked = new WeakSet();
    const longTasks = [];
    const stages = [];
    let frameCount = 0;
    let rafCount = 0;
    let worldCount = 0;
    let previousRaf;
    let homeWorld;
    const worldId = (world) => {
      if (!world) return null;
      if (!worldIds.has(world)) worldIds.set(world, ++worldCount);
      return worldIds.get(world);
    };
    function hookWorld() {
      const world = window.__agentCommand?.world;
      if (!world || hooked.has(world)) return;
      hooked.add(world);
      const id = worldId(world);
      const original = world.frame;
      world.frame = function (render) {
        const start = performance.now();
        try { return original.call(this, render); }
        finally {
          if (frameCount < capacity) {
            const i = frameCount++;
            frameStart[i] = start;
            frameDuration[i] = performance.now() - start;
            frameLevel[i] = this.rig.level;
            framePlane[i] = planes.indexOf(this.rig.focus);
            frameDiving[i] = Number(this.rig.diving);
            frameRender[i] = Number(render !== false);
            frameWorld[i] = id;
          }
        }
      };
      performance.mark(`load-followup:world-observed:${id}`);
    }
    new PerformanceObserver((list) => {
      for (const task of list.getEntries()) longTasks.push({
        start: task.startTime, duration: task.duration, name: task.name,
        attribution: [...(task.attribution ?? [])].map((a) => ({ name: a.name, containerType: a.containerType, containerSrc: a.containerSrc })),
      });
    }).observe({ type: 'longtask', buffered: true });
    addEventListener('DOMContentLoaded', () => {
      performance.mark('load-followup:dom-content-loaded');
      new MutationObserver(() => {
        const stage = document.documentElement.dataset.loading ?? null;
        if (stages.at(-1)?.stage !== stage) stages.push({ start: performance.now(), stage, caption: document.getElementById('load-stage')?.textContent });
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-loading'] });
    }, { once: true });
    function observeRaf(now) {
      hookWorld();
      if (previousRaf !== undefined && rafCount < capacity) {
        rafStart[rafCount] = previousRaf;
        rafInterval[rafCount++] = now - previousRaf;
      }
      previousRaf = now;
      requestAnimationFrame(observeRaf);
    }
    requestAnimationFrame(observeRaf);
    window.__loadFollowup = {
      snapshot() {
        const world = window.__agentCommand?.world;
        const renderer = world?.renderer;
        const info = renderer?.info;
        const gl = world?.canvas.getContext('webgl2');
        const gpuDebug = gl?.getExtension('WEBGL_debug_renderer_info');
        return {
          now: performance.now(), focus: world?.rig.focus ?? null, level: world?.rig.level ?? null,
          diving: world?.rig.diving ?? null, worldId: worldId(world), hasView: !!world?.view,
          hasGame: !!window.__agentCommand?.game?.(), tick: world?.view?.tick ?? null,
          backend: world?.backend ?? null, rendererMemory: info?.memory ? { ...info.memory } : null,
          gpu: gl ? {
            vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION),
            unmaskedVendor: gpuDebug ? gl.getParameter(gpuDebug.UNMASKED_VENDOR_WEBGL) : null,
            unmaskedRenderer: gpuDebug ? gl.getParameter(gpuDebug.UNMASKED_RENDERER_WEBGL) : null,
          } : null,
          rendererRender: info?.render ? { ...info.render } : null,
          canvas: world ? { width: world.canvas.width, height: world.canvas.height, cssWidth: world.canvas.clientWidth, cssHeight: world.canvas.clientHeight } : null,
          loading: document.documentElement.dataset.loading ?? null,
        };
      },
      captureHomeWorld() { homeWorld = window.__agentCommand?.world; return worldId(homeWorld); },
      reusedHomeWorld() { return homeWorld ? homeWorld === window.__agentCommand?.world : null; },
      samples(start = 0, end = Infinity) {
        const frames = [];
        const raf = [];
        for (let i = 0; i < frameCount; i++) if (frameStart[i] >= start && frameStart[i] < end) frames.push({
          start: frameStart[i], duration: frameDuration[i], level: frameLevel[i], focus: planes[framePlane[i]],
          diving: !!frameDiving[i], render: !!frameRender[i], worldId: frameWorld[i],
        });
        for (let i = 0; i < rafCount; i++) if (rafStart[i] >= start && rafStart[i] < end) raf.push({ start: rafStart[i], interval: rafInterval[i] });
        return {
          frames, raf, longTasks: longTasks.filter((task) => task.start < end && task.start + task.duration > start), stages,
          marks: performance.getEntriesByType('mark').map((mark) => ({ name: mark.name, start: mark.startTime })),
          navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
          paints: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
          overflow: { frames: frameCount === capacity, raf: rafCount === capacity },
        };
      },
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.on('pageerror', (error) => report.errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') report.console.push({ type: message.type(), text: message.text() });
  });
  cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await startTrace();
  await page.goto(base.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => performance.getEntriesByName('ac:home-ready', 'mark').length > 0, null, { timeout: timeoutMs });
  await page.evaluate((duration) => new Promise((resolve) => setTimeout(resolve, duration)), homeMs);
  if (expectBackdrop) {
    await page.waitForFunction(() => performance.getEntriesByName('ac:backdrop-first-frame', 'mark').length > 0, null, { timeout: timeoutMs });
    await page.evaluate((duration) => new Promise((resolve) => setTimeout(resolve, duration)), settleMs);
  }
  await page.evaluate(() => performance.mark('load-followup:home-window-end'));
  const homeEnd = await page.evaluate(() => window.__loadFollowup.snapshot());
  const homeWorldId = await page.evaluate(() => window.__loadFollowup.captureHomeWorld());
  const homeSamples = await page.evaluate(() => window.__loadFollowup.samples());
  const homeScreenshot = join(out, 'home.png');
  await page.screenshot({ path: homeScreenshot });
  report.home = {
    end: homeEnd, homeWorldId, samples: homeSamples, summary: summarize(homeSamples, 0, homeEnd.now),
    homeReadyMark: homeSamples.marks.find((mark) => mark.name === 'ac:home-ready') ?? null,
    backdropFirstFrameMark: homeSamples.marks.find((mark) => mark.name === 'ac:backdrop-first-frame') ?? null,
    cdpMetrics: (await cdp.send('Performance.getMetrics')).metrics, screenshot: homeScreenshot,
    trace: await stopTrace('home'),
  };
  await writeFile(join(out, 'home.json'), JSON.stringify(report.home, null, 2));
  if (!homeOnly) {
    await startTrace();
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/lobbies' && response.request().method() === 'POST');
    const entryStart = await page.evaluate(() => {
      performance.mark('load-followup:match-entry');
      return performance.now();
    });
    await page.locator('[data-lobby-action="play"]').first().click();
    const lobby = await (await created).json();
    if (!lobby.code) throw new Error(`Real lobby admission failed: ${JSON.stringify(lobby)}`);
    // Quick Play opens the practice room (You vs Bot) with Start one click away.
    await page.locator('[data-lobby-action="start-lobby"]:not([disabled])').click({ timeout: timeoutMs });
    report.match = { lobbyCode: lobby.code, mode: 'bots', opponent: 'idle' };
    report.match.seed = null;
    report.match.seedSource = 'The lobby handoff ticket and MatchData schema do not expose the random seed; the real public map bootstrap is captured after loading.';
    report.match.entrySource = 'Entry starts at the home Play click and includes lobby allocation and handoff.';
    // Do not substitute game/view existence, loading state, or a timeout for this exact marker.
    await page.waitForFunction(() => performance.getEntriesByName('ac:match-first-frame', 'mark').length > 0, null, { timeout: timeoutMs });
    const matchFirstFrame = await page.evaluate(() => performance.getEntriesByName('ac:match-first-frame', 'mark').at(-1).startTime);
    await page.waitForFunction(() => {
      const api = window.__agentCommand;
      return !!api?.game?.()?.view && !api.world.rig.diving;
    });
    await page.evaluate((duration) => new Promise((resolve) => setTimeout(resolve, duration)), settleMs);
    await page.evaluate(() => performance.mark('load-followup:match-warmed'));
    const warmed = await page.evaluate(() => window.__loadFollowup.snapshot());
    assert.equal(warmed.focus, 'surface', 'Expected real match loader to start at Surface');
    const startupSamples = await page.evaluate(({ start, end }) => window.__loadFollowup.samples(start, end), { start: entryStart, end: warmed.now });
    report.match.matchData = await page.evaluate(() => window.__agentCommand.world.view.match);
    report.matchStartup = {
      entryStart, matchFirstFrame, loaderMs: matchFirstFrame - entryStart, warmed,
      reusedHomeWorld: await page.evaluate(() => window.__loadFollowup.reusedHomeWorld()),
      homeWorldId, matchWorldId: warmed.worldId,
      summary: summarize(startupSamples, entryStart, warmed.now), samples: startupSamples,
      initialSurfaceWindow: summarize(startupSamples, matchFirstFrame, warmed.now),
      trace: await stopTrace('match-startup'),
    };
    if (expectBackdrop) assert.equal(report.matchStartup.reusedHomeWorld, true, 'Match must reuse the exact home backdrop World');
    await writeFile(join(out, 'match-startup.json'), JSON.stringify(report.matchStartup, null, 2));
    const counts = new Map();
    for (const plane of report.policy.sequence) {
      const visit = (counts.get(plane) ?? 0) + 1;
      counts.set(plane, visit);
      const name = `${plane}-${visit}`;
      await startTrace();
      const before = await page.evaluate(() => window.__loadFollowup.snapshot());
      assert.notEqual(before.focus, plane, `${name} must be a real incoming switch`);
      const windowResult = await page.evaluate(async ({ plane, name, settleMs, timeoutMs }) => {
        const api = window.__agentCommand;
        const rig = api.world.rig;
        const start = performance.now();
        performance.mark(`load-followup:${name}:start`);
        api.game().goTo(plane);
        let arrived;
        let firstRaf;
        let sawDiving = rig.diving;
        await new Promise((resolve, reject) => {
          function wait(now) {
            firstRaf ??= now;
            sawDiving ||= rig.diving;
            if (now - start > timeoutMs) { reject(new Error(`${name}: plane transition timed out`)); return; }
            if (rig.focus === plane && !rig.diving) {
              if (arrived === undefined) {
                arrived = performance.now();
                performance.mark(`load-followup:${name}:arrived`);
              }
              if (performance.now() - arrived >= settleMs) { resolve(); return; }
            } else arrived = undefined;
            requestAnimationFrame(wait);
          }
          requestAnimationFrame(wait);
        });
        const end = performance.now();
        performance.mark(`load-followup:${name}:end`);
        return { start, arrived, end, durationMs: end - start, transitionMs: arrived - start, firstRafDelayMs: firstRaf - start, sawDiving };
      }, { plane, name, settleMs, timeoutMs });
      const after = await page.evaluate(() => window.__loadFollowup.snapshot());
      const samples = await page.evaluate(({ start, end }) => window.__loadFollowup.samples(start, end), windowResult);
      const trace = await stopTrace(name);
      const screenshot = join(out, `${name}.png`);
      await page.screenshot({ path: screenshot });
      const row = {
        plane, visit, from: before.focus, sourceLevel: before.level,
        initialFocusAlreadyRendered: plane === 'surface', ...windowResult, before, after,
        summary: summarize(samples, windowResult.start, windowResult.end),
        transitionSummary: summarize(samples, windowResult.start, windowResult.arrived),
        settleSummary: summarize(samples, windowResult.arrived, windowResult.end),
        samples, screenshot, trace,
      };
      report.visits.push(row);
      await writeFile(join(out, `${name}.json`), JSON.stringify(row, null, 2));
      console.log(JSON.stringify({ name, from: row.from, durationMs: row.durationMs, worldFrame: row.summary.worldFrame, rafInterval: row.summary.rafInterval, longTask: row.summary.longTask }));
    }
  }
  }
} catch (error) {
  report.errors.push({ type: 'harness', message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  if (tracing) {
    try { await stopTrace('interrupted'); }
    catch (error) { report.errors.push({ type: 'trace', message: error.message }); }
  }
  await browser?.close();
  if (!analyzeOnly) report.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: join(out, 'report.json'), visits: report.visits.length, errors: report.errors }));
}
