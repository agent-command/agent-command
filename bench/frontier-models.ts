/**
 * The frontier model set, routed through OpenRouter's Responses API with identical harness settings.
 *
 * Each model is pinned to named upstreams (`only`, no fallbacks, `require_parameters`): unpinned, OpenRouter's price
 * routing picked whichever host was cheapest, and one GLM 5.3 host returned every tool call with only its enum
 * arguments (`policy_deploy` arrived as `{"runtime":"js","role":"surface"}`), which scored as a model failure. The
 * first-party host is pinned where OpenRouter offers it to this account; DeepSeek's is not, so a host that passed the
 * tool-argument probe stands in. The bench's preflight re-probes the pinned route before any authoring.
 *
 * Prices (USD per 1M tokens) are the pinned hosts' OpenRouter list prices, raised to the catalogue ceiling at pinning
 * time where that was higher, so the runner's hard caps over- rather than under-count. Billed spend is reconciled
 * against the key's usage separately. `cacheReadPerM` is that catalogue's cached-input rate; it prices cached input
 * only when a turn's real cost is unknown (the OpenCode harness charges OpenRouter's reported cost first).
 * `PRICING.asOf` is a fixed placeholder: the frozen prices are the table below, not a dated catalogue lookup.
 */
export const PRICING = { version: 'openrouter-catalog+pinned-hosts/1', asOf: '2000-01-01T00:00:00.000Z' } as const;
export const MODELS = {
  'claude-opus-5.5': { model: 'anthropic/claude-opus-5.5', hosts: ['anthropic'], price: { inPerM: 4, outPerM: 20, cacheReadPerM: 0.2 } },
  'gemini-4-carbon': { model: 'google/gemini-4-carbon', hosts: ['google-vertex', 'google-ai-studio'], price: { inPerM: 2, outPerM: 10, cacheReadPerM: 0.1 } },
  'gpt-6.1-sol': { model: 'openai/gpt-6.1-sol', hosts: ['openai'], price: { inPerM: 2.5, outPerM: 15, cacheReadPerM: 0.1 } },
  'deepseek-v4.1-flash': { model: 'deepseek/deepseek-v4.1-flash-1017', hosts: ['deepinfra'], price: { inPerM: 0.15, outPerM: 0.6, cacheReadPerM: 0.003 } },
  'kimi-k3.1-pro': { model: 'moonshotai/kimi-k3.1-pro', hosts: ['moonshotai'], price: { inPerM: 2, outPerM: 12, cacheReadPerM: 0.2 } },
  'glm-5.3': { model: 'z-ai/glm-5.3', hosts: ['z-ai'], price: { inPerM: 1.4, outPerM: 4.4, cacheReadPerM: 0.079 } },
} as const;
export type FrontierModel = keyof typeof MODELS;

/** The runner's OpenAI Responses provider pointed at OpenRouter, pinned to the model's hosts; default provider reasoning. */
export const openRouter = (id: FrontierModel) => ({
  provider: 'openai' as const, model: MODELS[id].model, baseUrl: 'https://openrouter.ai/api', apiKeyEnv: 'OPENROUTER_API_KEY', price: MODELS[id].price,
  request: { provider: { only: [...MODELS[id].hosts], allow_fallbacks: false, require_parameters: true } },
});
