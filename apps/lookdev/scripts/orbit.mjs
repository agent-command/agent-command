/** Headless, frozen-clock Orbit atlas captures. Own Vite server; always closes both server and browser. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const out = resolve(process.argv[2] ?? fileURLToPath(new URL('../../../docs/art/shots', import.meta.url)));
mkdirSync(out, { recursive: true });
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'warn', server: { host: '127.0.0.1', port: 5217, strictPort: true } });
await server.listen();
let browser;
const evidence = { viewport: { width: 1440, height: 1000 }, errors: [], captures: [] };
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? `${homedir()}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`, headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: evidence.viewport, deviceScaleFactor: 1 });
  page.on('pageerror', e => evidence.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') evidence.errors.push(m.text()); });
  const frames = [
    ['normal', 'normal', 1.35], ['wide', 'wide', 1.35], ['close', 'close', 1.35],
    ['skirmish-01', 'normal', 0.4], ['skirmish-02', 'normal', 0.95],
    ['skirmish-03', 'normal', 1.15], ['skirmish-04', 'normal', 1.45],
    ['skirmish-05', 'normal', 1.85], ['skirmish-06', 'normal', 2.8],
  ];
  for (const [name, zoom, time] of frames) {
    await page.goto(`http://127.0.0.1:5217/?dir=atlas&plane=orbit&renderer=webgl&hud=0&zoom=${zoom}&t=${time}`);
    await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
    const info = await page.evaluate(() => window.__info);
    const file = `orbit-${name}.png`;
    await page.screenshot({ path: resolve(out, file) });
    evidence.captures.push({ file, time, zoom, ...info });
  }
  // Exercise the live clock too, without replacing the reproducible frozen evidence above.
  await page.goto('http://127.0.0.1:5217/?dir=atlas&renderer=webgl&hud=0');
  await page.waitForFunction(() => window.__frames > 30, null, { timeout: 60000 });
  evidence.liveFrames = await page.evaluate(() => window.__frames);
  writeFileSync(resolve(out, 'orbit-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.errors.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
