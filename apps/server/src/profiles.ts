/**
 * Anonymous player profiles: an id plus a secret the browser keeps in localStorage. The server stores only the
 * secret's SHA-256 digest and looks profiles up by it. The profile id is the PlayerThree commander-roster owner id
 * (it never reaches agents or opponents). Kept in memory (authoritative for the process) and written through a
 * `ProfileStore`: Postgres with DATABASE_URL, `profiles.json` under DATA_DIR, or nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PostgresStorage } from 'playerthree/postgres';

export const PROFILE_ID_RE = /^[A-Za-z0-9_-]{16}$/;
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export interface StoredProfile {
  id: string;
  secretDigest: string;
  createdAt: number;
}

/** Storage behind the profiles. Methods may be sync or async; writes are issued in order. */
export interface ProfileStore {
  load(): StoredProfile[] | Promise<StoredProfile[]>;
  save(profile: StoredProfile): void | Promise<void>;
}

function checked(p: StoredProfile, where: string): StoredProfile {
  if (typeof p?.id !== 'string' || !PROFILE_ID_RE.test(p.id) || typeof p.secretDigest !== 'string' || !DIGEST_RE.test(p.secretDigest)) {
    throw new Error(`${where}: malformed profile`);
  }
  return { id: p.id, secretDigest: p.secretDigest, createdAt: Number(p.createdAt) || 0 };
}

export function memoryProfileStore(): ProfileStore {
  return { load: () => [], save() {} };
}

/** `<dir>/profiles.json`, rewritten atomically (temp file + rename) on every change. */
export function jsonProfileStore(dir: string): ProfileStore {
  const file = join(dir, 'profiles.json');
  const all = new Map<string, StoredProfile>();
  return {
    load() {
      mkdirSync(dir, { recursive: true });
      if (!existsSync(file)) return [];
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { profiles?: unknown };
      if (!Array.isArray(raw.profiles)) throw new Error('profiles.json: malformed');
      for (const p of raw.profiles as StoredProfile[]) all.set(p.secretDigest, checked(p, 'profiles.json'));
      return [...all.values()];
    },
    save(p) {
      all.set(p.secretDigest, p);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, profiles: [...all.values()] }), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

/** The `ac_profiles` table (apps/server/migrations). */
export function postgresProfileStore(db: PostgresStorage): ProfileStore {
  return {
    async load() {
      const rows = await db.query<{ id: string; secret_digest: string; created_at: string }>('SELECT id, secret_digest, created_at FROM ac_profiles');
      return rows.map((r) => checked({ id: r.id, secretDigest: r.secret_digest, createdAt: Number(r.created_at) }, 'ac_profiles'));
    },
    async save(p) {
      await db.query(
        'INSERT INTO ac_profiles (id, secret_digest, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET secret_digest = EXCLUDED.secret_digest',
        [p.id, p.secretDigest, p.createdAt],
      );
    },
  };
}

const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex');

export class Profiles {
  readonly #store: ProfileStore;
  readonly #byDigest = new Map<string, StoredProfile>();
  #writes: Promise<void> = Promise.resolve();
  /** Resolves once the store has loaded; profiles do not authenticate before that. Rejects if loading fails. */
  readonly ready: Promise<void>;

  constructor(store: ProfileStore = memoryProfileStore()) {
    this.#store = store;
    this.ready = (async () => {
      for (const p of await store.load()) this.#byDigest.set(p.secretDigest, p);
    })();
    // The server awaits `ready` before it listens; an unawaited rejection must not crash a test that never listens.
    this.ready.catch(() => {});
  }

  get size(): number {
    return this.#byDigest.size;
  }

  /** New profile. The secret is returned exactly once. */
  create(): { id: string; secret: string } {
    const id = randomBytes(12).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const record: StoredProfile = { id, secretDigest: digest(secret), createdAt: Date.now() };
    this.#byDigest.set(record.secretDigest, record);
    const store = this.#store;
    this.#writes = this.#writes.then(() => store.save(record)).catch((e: unknown) => console.error('profiles: write failed', e));
    return { id, secret };
  }

  /** Profile id for a secret, by digest lookup (a guessed secret never meets a timing-dependent string compare). */
  authenticate(secret: unknown): string | undefined {
    if (typeof secret !== 'string' || !SECRET_RE.test(secret)) return undefined;
    return this.#byDigest.get(digest(secret))?.id;
  }

  /** Resolves once every write issued so far has settled. */
  flush(): Promise<void> {
    return this.#writes;
  }
}
