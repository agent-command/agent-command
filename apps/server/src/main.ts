/** Agent Command server entrypoint: `node apps/server/src/main.ts` (Node type stripping, no build step). */
import { fileURLToPath } from 'node:url';
import { openPostgresStorage } from 'playerthree/postgres';
import { createGameServer } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
// DATABASE_URL: PlayerThree's tables and this game's (apps/server/migrations) are migrated before anything is served.
const storage = config.databaseUrl
  ? await openPostgresStorage({ url: config.databaseUrl, migrations: { scope: 'agent-command', dir: fileURLToPath(new URL('../migrations', import.meta.url)) } })
  : undefined;
const server = createGameServer(config, storage);
const port = await server.listen();
const base = config.publicUrl?.origin ?? `http://localhost:${port}`;
const store = storage ? 'postgres' : config.dataDir ? `files in ${config.dataDir}` : 'memory';
console.log(`agent-command server on :${port}  web ${base}/  mcp ${base}/mcp${config.devtools ? `  devtools ${base}/playerthree/devtools` : ''}  storage: ${store}`);

let stopping = false;
async function stop(signal: string, code = 0) {
  if (stopping && signal !== 'SIGINT') return;
  stopping = true;
  const drain = signal !== 'SIGINT';
  console.log(`${signal}: ${drain ? 'draining live matches' : 'shutting down'}`);
  // The existing cleanup allowance starts after the drain cap, not when SIGTERM first arrives.
  const force = setTimeout(() => process.exit(1), (drain ? config.drainMaxMs : 0) + 10_000);
  force.unref();
  if (drain) await server.drain();
  else await server.close();
  await storage?.close();
  process.exit(code);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
// Cluster mode: a process that lost the lease never coordinates again. It finishes its matches like a deploy drain,
// then exits non-zero so the platform's restart policy replaces it with a node that may lead.
void server.demoted.then(() => stop('demoted', 1));
