/**
 * `pnpm dev` launcher: enables the dev-admin API with `AC_DEV_ADMIN_TOKEN` (a random one when unset), writes the token
 * to apps/server/.data/dev-admin-token (gitignored) for tools/dev-mcp, points the operator console at the session
 * history under DATA_DIR (`HISTORY_DIR`, so Recent sessions survive restarts), the repo's bench-results/
 * (`BENCH_RESULTS_DIR`) and SAFETY.md (`SAFETY_CARD`) unless they are set, then runs the server under `node --watch`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const token = process.env.AC_DEV_ADMIN_TOKEN || randomBytes(24).toString('base64url');
const file = fileURLToPath(new URL('../.data/dev-admin-token', import.meta.url));
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${token}\n`, { mode: 0o600 });
console.log(`PlayerThree DevTools, the operator console (this machine only, no credential): http://localhost:${process.env.PORT || '2567'}/playerthree/devtools`);

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const consoleEnv = {
  ...(process.env.DATA_DIR ? { HISTORY_DIR: process.env.HISTORY_DIR || join(resolve(process.env.DATA_DIR), 'history') } : {}),
  BENCH_RESULTS_DIR: process.env.BENCH_RESULTS_DIR || join(repo, 'bench-results'),
  SAFETY_CARD: process.env.SAFETY_CARD || join(repo, 'SAFETY.md'),
};

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
// SIGTERM means "drain live matches" (production deploys); a dev file-change restart must be immediate, so the
// watcher kills with SIGINT instead, otherwise every edit would leave the dev server draining and refusing Play.
// Watch source trees only (this server, shared benchmark SSR components, workspace packages and sibling PlayerThree).
// Watching the import graph also watched node_modules, whose pnpm files are hard links shared with every other worktree:
// any `pnpm install` elsewhere restarted the server and dropped live lobbies and matches.
const sources = (root: string): string[] => existsSync(root) ? readdirSync(root).map((name) => join(root, name, 'src')).filter(existsSync) : [];
const watched = [join(repo, 'apps/server/src'), join(repo, 'apps/web/src/benchmarks'), ...sources(join(repo, 'packages')), ...sources(resolve(repo, '../player-three/packages'))];
const child = spawn(process.execPath, ['--watch-kill-signal=SIGINT', ...watched.map((path) => `--watch-path=${path}`), main], { stdio: 'inherit', env: { ...process.env, ...consoleEnv, NODE_ENV: process.env.NODE_ENV ?? 'development', AC_DEV_ADMIN_TOKEN: token } });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
