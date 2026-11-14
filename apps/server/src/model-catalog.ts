/** Optional public discovery, isolated from benchmark execution and publication reading. No inference credentials. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createOpenRouterCatalog, MODEL_CATALOG_DISCLAIMER, OPENROUTER_MODELS_URL, searchCatalog, type ModelCatalogState } from '@playerthree/bench/model-catalog';
import { sendJson } from './http.ts';

export function createModelCatalogRoute(catalog: { get(): Promise<ModelCatalogState> } = createOpenRouterCatalog()) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== '/api/benchmarks/models') return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      return true;
    }
    const params = url.searchParams;
    const query = params.get('q') ?? '';
    const limit = params.has('limit') ? Number(params.get('limit')) : 50;
    if ([...params.keys()].some(key => !['q', 'limit', 'tools', 'reasoning'].includes(key) || params.getAll(key).length !== 1)
      || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100
      || ['tools', 'reasoning'].some(key => params.has(key) && !['true', 'false'].includes(params.get(key)!))) {
      sendJson(res, 400, { error: 'invalid_catalog_query' });
      return true;
    }
    const state = await catalog.get();
    const result = state.catalog ? searchCatalog(state.catalog, { query, limit, tools: params.get('tools') === 'true', reasoning: params.get('reasoning') === 'true' }) : { models: [], total: 0, hasMore: false };
    sendJson(res, state.status === 'unavailable' ? 503 : 200, {
      status: state.status, source: OPENROUTER_MODELS_URL, fetchedAt: state.catalog?.fetchedAt ?? null,
      scope: 'default-text-output-catalog', disclaimer: MODEL_CATALOG_DISCLAIMER, ...result,
    }, { 'X-Content-Type-Options': 'nosniff', ...(state.status === 'unavailable' ? { 'Retry-After': '30' } : {}) });
    return true;
  };
}
