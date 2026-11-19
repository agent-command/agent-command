/** Private durable world seed derivation. Never serialize the key or realization into result rows. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** `configured` is the validated `ARENA_SEED_KEY` from `loadConfig`; without it the key file under `dataDir` is used. */
export function arenaSeedSource(dataDir?: string, configured?: string): (seriesId: string, block: string) => Promise<number> {
  let material: Promise<Buffer> | undefined;
  async function load(): Promise<Buffer> {
    if (configured !== undefined) {
      if (!/^[a-f0-9]{64}$/i.test(configured)) throw new Error('ARENA_SEED_KEY must be 32 bytes encoded as hexadecimal');
      return Buffer.from(configured, 'hex');
    }
    if (!dataDir) throw new Error('Durable arena seeds require DATA_DIR or ARENA_SEED_KEY');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, 'arena-seed-key');
    const temporary = join(dataDir, `.arena-seed-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(randomBytes(32)); await file.sync(); } finally { await file.close(); }
    try {
      // Only a fully written key becomes visible; concurrent server starts cannot read a partial secret.
      await link(temporary, path);
      const directory = await open(dataDir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { await unlink(temporary); }
    const key = await readFile(path);
    if (key.byteLength !== 32) throw new Error('Invalid durable arena seed material');
    return key;
  }
  return async (seriesId, block) => Number(createHmac('sha256', await (material ??= load())).update(JSON.stringify(['ac-arena-world-v1', seriesId, block])).digest().readBigUInt64BE() >> 11n);
}
