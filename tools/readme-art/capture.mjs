// Captures the raw README screenshots (1920×1080 PNG) from the real client against a real, isolated dev server.
// Usage: node tools/readme-art/capture.mjs <rawDir> [scene ...]   then   node tools/readme-art/shots.mjs <rawDir>
// Starts its own game server (dev-admin enabled, DATA_DIR under rawDir) and Vite, drives headless Chromium on WebGL2
// (`?renderer=webgl&debug&quality=full`), stages scenes with dev-admin cheats on real matches, then stops everything.
// Ports: AC_SHOTS_SERVER_PORT (default 2567) and AC_SHOTS_WEB_PORT (default 5173).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = createRequire(`${root}tools/dev-mcp/package.json`)('playwright-core');
const out = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node tools/readme-art/capture.mjs <rawDir> [scene ...]');
const only = new Set(process.argv.slice(3));
const want = (scene) => !only.size || only.has(scene);
mkdirSync(out, { recursive: true });

const serverPort = Number(process.env.AC_SHOTS_SERVER_PORT ?? 2567);
const webPort = Number(process.env.AC_SHOTS_WEB_PORT ?? 5173);
const server = `http://127.0.0.1:${serverPort}`;
const web = `http://localhost:${webPort}`;
const token = randomBytes(24).toString('base64url');
const W = 1920;
const H = 1080;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function admin(path, body) {
  const res = await fetch(`${server}/dev/matches${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`dev-admin ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function startServer() {
  const child = spawn(process.execPath, [join(root, 'apps/server/src/main.ts')], {
    cwd: join(root, 'apps/server'),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(serverPort), HOST: '127.0.0.1', AC_DEV_ADMIN_TOKEN: token,
      DATA_DIR: join(out, '.data'), PUBLIC_URL: web, CORS_ORIGINS: web, MATCHES_PER_IP: '1000',
      // Matches run in this process so dev-admin can pace every one of them (lobby matches too); no featured showcase.
      SIM_WORKERS: '0', FEATURED_MATCH: '0',
    },
  });
  return child;
}

async function healthy() {
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${server}/healthz`)).ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error('server did not become healthy');
}

let serverChild;
let vite;
let browser;
const errors = [];
try {
  serverChild = startServer();
  process.env.AC_SERVER_PORT = String(serverPort);
  const { createServer } = await import(pathToFileURL(join(root, 'apps/web/node_modules/vite/dist/node/index.js')).href);
  vite = await createServer({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'), logLevel: 'warn', server: { port: webPort, strictPort: true, host: '127.0.0.1', hmr: false } });
  await vite.listen();
  await healthy();
  log('servers up');
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const ctx = { context, out, web, admin, log, errors, want, W, H };
  const scenes = await import(pathToFileURL(join(root, 'tools/readme-art/scenes.mjs')).href);
  await scenes.run(ctx);
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill('SIGINT');
    await new Promise((r) => { serverChild.once('exit', r); setTimeout(r, 15000); });
  }
  writeFileSync(join(out, 'errors.json'), JSON.stringify(errors, null, 2));
}
