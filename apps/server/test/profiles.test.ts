import { describe, expect, it } from 'vitest';
import { Profiles, postgresProfileStore, type StoredProfile } from '../src/profiles.ts';
import type { PostgresStorage } from 'playerthree/postgres';

const saved: StoredProfile = { id: 'abcdefghijklmnop', secretDigest: 'a'.repeat(64), createdAt: 1234 };

describe('profile stores', () => {
  it('awaits asynchronous loading and serializes writes before flush resolves', async () => {
    const load = Promise.withResolvers<StoredProfile[]>();
    const first = Promise.withResolvers<void>();
    const writes: StoredProfile[] = [];
    const profiles = new Profiles({
      load: () => load.promise,
      async save(profile) {
        writes.push(profile);
        if (writes.length === 1) await first.promise;
      },
    });
    expect(profiles.size).toBe(0);
    load.resolve([saved]);
    await profiles.ready;
    expect(profiles.size).toBe(1);
    const one = profiles.create();
    const two = profiles.create();
    expect(profiles.authenticate(one.secret)).toBe(one.id);
    expect(profiles.authenticate(two.secret)).toBe(two.id);
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    first.resolve();
    await profiles.flush();
    expect(writes.map((p) => p.id)).toEqual([one.id, two.id]);
    expect(writes[0]!.secretDigest).not.toBe(one.secret);
  });

  it('rejects readiness when persistent loading fails', async () => {
    const profiles = new Profiles({ load: () => Promise.reject(new Error('database unavailable')), save() {} });
    await expect(profiles.ready).rejects.toThrow('database unavailable');
  });

  it('uses parameterized profile SQL and converts database timestamps', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return params ? [] : [{ id: saved.id, secret_digest: saved.secretDigest, created_at: String(saved.createdAt) }];
      },
    } as unknown as PostgresStorage;
    const store = postgresProfileStore(db);
    expect(await store.load()).toEqual([saved]);
    await store.save(saved);
    expect(calls[1]!.sql).toContain('VALUES ($1, $2, $3)');
    expect(calls[1]!.params).toEqual([saved.id, saved.secretDigest, saved.createdAt]);
  });
});
