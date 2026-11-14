import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { projectOpenRouterCatalog, type ModelCatalogState } from '@playerthree/bench/model-catalog';
import { createModelCatalogRoute } from '../src/model-catalog.ts';

const catalog = projectOpenRouterCatalog({ data: [
  { id: 'fixture/tool', name: 'Fixture Tool', supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' }, internal: 'must-not-project' },
  { id: 'fixture/unknown' },
] }, '2000-01-01T00:00:00.000Z');
let state: ModelCatalogState = { status: 'available', catalog };
const get = vi.fn(async () => state);
let server: Server;
let origin: string;
beforeAll(async () => {
  const route = createModelCatalogRoute({ get });
  server = createServer((req, res) => {
    void route(req, res, new URL(req.url!, 'http://localhost')).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected HTTP port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(error => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
});

describe('optional public model catalog route', () => {
  it('serves dated bounded metadata with an explicit non-attestation disclaimer', async () => {
    const reply = await fetch(`${origin}/api/benchmarks/models?q=tool&tools=true&limit=1`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    const body = await reply.json();
    expect(body).toMatchObject({ status: 'available', fetchedAt: catalog.fetchedAt, total: 1, hasMore: false, disclaimer: expect.any(String), models: [{ id: 'fixture/tool', pricing: { currency: 'USD', basis: 'catalog-list-price' } }] });
    expect(JSON.stringify(body)).not.toContain('must-not-project');
    const head = await fetch(`${origin}/api/benchmarks/models`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('rejects invalid queries and unsupported methods before consulting the provider cache', async () => {
    get.mockClear();
    for (const query of ['?limit=101', '?limit=0', '?q=a&q=b', '?unknown=1', '?tools=maybe', `?q=${'a'.repeat(201)}`]) {
      const reply = await fetch(`${origin}/api/benchmarks/models${query}`);
      expect(reply.status).toBe(400);
      expect(await reply.json()).toEqual({ error: 'invalid_catalog_query' });
    }
    const reply = await fetch(`${origin}/api/benchmarks/models`, { method: 'POST' });
    expect(reply.status).toBe(405);
    expect(reply.headers.get('allow')).toBe('GET, HEAD');
    expect(get).not.toHaveBeenCalled();
    expect((await fetch(`${origin}/api/benchmarks`)).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it('labels stale values and fails only discovery when the catalog is unavailable', async () => {
    state = { status: 'stale', catalog };
    let reply = await fetch(`${origin}/api/benchmarks/models`);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ status: 'stale', fetchedAt: catalog.fetchedAt });
    state = { status: 'unavailable', catalog: null };
    reply = await fetch(`${origin}/api/benchmarks/models`);
    expect(reply.status).toBe(503);
    expect(reply.headers.get('retry-after')).toBe('30');
    expect(await reply.json()).toMatchObject({ status: 'unavailable', fetchedAt: null, models: [], total: 0 });
  });
});
