/**
 * agent-command-dev: stdio MCP server that drives a local Agent Command stack (dev only).
 *
 *   node tools/dev-mcp/src/main.ts
 *
 * Env: AC_URL (game server, default http://localhost:2567), AC_WEB_URL (web client, default http://localhost:5173),
 * AC_DEV_ADMIN_TOKEN (default: read from apps/server/.data/dev-admin-token, written by `pnpm dev`),
 * AC_CHROME (Chromium binary for screenshots; default playwright-core's own install).
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DevMcp } from './tools.ts';

const dev = new DevMcp({
  url: process.env.AC_URL || 'http://localhost:2567',
  webUrl: process.env.AC_WEB_URL || 'http://localhost:5173',
  ...(process.env.AC_DEV_ADMIN_TOKEN ? { token: process.env.AC_DEV_ADMIN_TOKEN } : {}),
  ...(process.env.AC_CHROME ? { chrome: process.env.AC_CHROME } : {}),
});

const handle = serveStdio(() => dev.server(), { onerror: (e) => console.error(`agent-command-dev: ${e.message}`) });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await handle.close().catch(() => {});
  await dev.close().catch(() => {});
  process.exit(0);
}
process.stdin.on('end', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
