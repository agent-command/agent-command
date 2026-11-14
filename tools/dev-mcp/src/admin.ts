/** Client for the game server's dev-admin API (`/dev/*`, apps/server/src/dev-admin.ts) and `/healthz`. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ArmyId, Colour, TerrainPreset } from '@agent-command/game';

/** Where `pnpm dev` (apps/server/scripts/dev.ts) writes the dev-admin token. */
export const TOKEN_FILE = fileURLToPath(new URL('../../../apps/server/.data/dev-admin-token', import.meta.url));

export interface MatchInfo {
  roomId: string;
  mode: 'bots' | 'pvp' | 'agents' | 'ffa';
  /** The match's armies in slot order with their colours. */
  armies: { id: ArmyId; colour: Colour }[];
  tick: number;
  /** Game ticks per room tick (0 = paused); null: the match runs in real time by itself. */
  speed: number | null;
  /** The match's world: seed and surface terrain preset. */
  seed?: number;
  terrain?: TerrainPreset;
  outcomes: Record<string, string>;
  /** army → role → controller (`+agent` when an agent is connected) */
  seats: Record<string, Record<string, string>>;
  readyCheck?: boolean;
  /** One owner token per army of the match, plus the spectator's. */
  tokens?: Partial<Record<ArmyId, string>> & { spectator: string };
}

export class AdminError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`dev-admin ${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

export class DevAdminClient {
  readonly url: string;
  readonly #token: string | undefined;
  readonly #tokenFile: string;

  /** `token` (AC_DEV_ADMIN_TOKEN) wins; otherwise the token file is read per request (it changes per `pnpm dev`). */
  constructor(url: string, token?: string, tokenFile = TOKEN_FILE) {
    this.url = url.replace(/\/+$/, '');
    this.#token = token || undefined;
    this.#tokenFile = tokenFile;
  }

  #auth(): string {
    if (this.#token) return this.#token;
    try {
      return readFileSync(this.#tokenFile, 'utf8').trim();
    } catch {
      throw new AdminError(0, `no dev-admin token: set AC_DEV_ADMIN_TOKEN or run \`pnpm dev\` (writes ${this.#tokenFile})`);
    }
  }

  async health(): Promise<{ ok: boolean; matches: number; maxMatches: number }> {
    const res = await fetch(`${this.url}/healthz`);
    if (!res.ok) throw new AdminError(res.status, 'unhealthy');
    return (await res.json()) as { ok: boolean; matches: number; maxMatches: number };
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#auth()}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (!res.ok) {
      const hint = res.status === 404 && path === '/dev/matches' ? 'dev_admin_disabled (start the server with AC_DEV_ADMIN_TOKEN)' : String(data.error ?? 'error');
      throw new AdminError(res.status, hint);
    }
    return data as T;
  }

  matches(): Promise<{ matches: MatchInfo[] }> {
    return this.request('GET', '/dev/matches');
  }

  match(roomId: string): Promise<MatchInfo> {
    return this.request('GET', `/dev/matches/${encodeURIComponent(roomId)}`);
  }
}
