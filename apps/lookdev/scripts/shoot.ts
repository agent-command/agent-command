/**
 * Screenshot every direction × plane into docs/art/shots/ (WebGL2 backend, frozen clock).
 *   node scripts/shoot.ts [dir…] [plane…]      e.g. `node scripts/shoot.ts ink surface`
 * CHROME overrides the browser binary (default: the Playwright chromium under ~/.cache/ms-playwright).
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const DIRS = ['ink', 'table', 'signal'];
const VIEWS = ['surface', 'depths', 'sky', 'orbit', 'stack'];
const args = process.argv.slice(2);
const dirs = DIRS.filter((d) => args.length === 0 || args.includes(d) || !args.some((a) => DIRS.includes(a)));
const views = VIEWS.filter((v) => args.length === 0 || args.includes(v) || !args.some((a) => VIEWS.includes(a)));

const root = fileURLToPath(new URL('..', import.meta.url));
const out = fileURLToPath(new URL('../../../docs/art/shots/', import.meta.url));
mkdirSync(out, { recursive: true });

const server = await createServer({ root, logLevel: 'warn', server: { port: 5191, strictPort: false } });
await server.listen();
const base = server.resolvedUrls?.local[0] ?? 'http://localhost:5191/';
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? `${homedir()}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
  args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  for (const d of dirs)
    for (const v of views) {
      const t0 = Date.now();
      await page.goto(`${base}?dir=${d}&plane=${v}&t=3&hud=0&renderer=webgl`);
      await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 180_000 });
      const info = await page.evaluate(() => window.__info);
      const file = `${out}${d}-${v}.png`;
      await page.screenshot({ path: file });
      console.log(`${d}-${v}.png  ${Date.now() - t0} ms  ${JSON.stringify(info)}`);
    }
} finally {
  await browser.close();
  await server.close();
}
