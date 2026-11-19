/**
 * The frontier model set, routed through OpenRouter on each family's own API (`wireOf`) with identical harness settings.
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
 * `PRICING.asOf` is a fixed placeholder: the frozen prices are the table below, not a dated catalogue lookup. Qwen4 Max,
 * GPT-6.2 Sol, GPT-6.2 Astra and GPT-6 Astra, added after that catalogue, carry their first-party host's list prices;
 * GLM 5.3's cached-input rate is its pinned host's later, higher list rate. `contextTokens` is the pinned hosts'
 * context window in OpenRouter's catalogue (every pinned host of a model lists the same).
 */
export const PRICING = { version: 'openrouter-catalog+pinned-hosts/1', asOf: '2000-01-01T00:00:00.000Z' } as const;
export const MODELS = {
  'claude-opus-5.5': { model: 'anthropic/claude-opus-5.5', hosts: ['anthropic'], price: { inPerM: 4, outPerM: 20, cacheReadPerM: 0.2 }, contextTokens: 1_000_000 },
  'gemini-4-carbon': { model: 'google/gemini-4-carbon', hosts: ['google-vertex', 'google-ai-studio'], price: { inPerM: 2, outPerM: 10, cacheReadPerM: 0.1 }, contextTokens: 1_048_576 },
  'gpt-6.1-sol': { model: 'openai/gpt-6.1-sol', hosts: ['openai'], price: { inPerM: 2.5, outPerM: 15, cacheReadPerM: 0.1 }, contextTokens: 1_050_000 },
  'deepseek-v4.1-flash': { model: 'deepseek/deepseek-v4.1-flash-1017', hosts: ['deepinfra'], price: { inPerM: 0.15, outPerM: 0.6, cacheReadPerM: 0.003 }, contextTokens: 1_048_576 },
  'kimi-k3.1-pro': { model: 'moonshotai/kimi-k3.1-pro', hosts: ['moonshotai'], price: { inPerM: 2, outPerM: 12, cacheReadPerM: 0.2 }, contextTokens: 1_048_576 },
  'glm-5.3': { model: 'z-ai/glm-5.3', hosts: ['z-ai'], price: { inPerM: 1.4, outPerM: 4.4, cacheReadPerM: 0.26 }, contextTokens: 1_048_576 },
  'qwen4-max': { model: 'qwen/qwen4-max', hosts: ['alibaba'], price: { inPerM: 1.425, outPerM: 4.275, cacheReadPerM: 0.07125 }, contextTokens: 1_000_000 },
  'gpt-6.2-sol': { model: 'openai/gpt-6.2-sol', hosts: ['openai'], price: { inPerM: 2, outPerM: 10, cacheReadPerM: 0.1 }, contextTokens: 1_050_000 },
  'gpt-6.2-astra': { model: 'openai/gpt-6.2-astra', hosts: ['openai'], price: { inPerM: 8, outPerM: 40, cacheReadPerM: 0.4 }, contextTokens: 1_050_000 },
  'gpt-6-astra': { model: 'openai/gpt-6-astra', hosts: ['openai'], price: { inPerM: 10, outPerM: 50, cacheReadPerM: 1 }, contextTokens: 1_050_000 },
} as const;
export type FrontierModel = keyof typeof MODELS;

/**
 * Each model family's own API on OpenRouter, so the reasoning a model returns goes back to it with its tool results
 * (Chat Completions has no field for signed or encrypted reasoning): Claude on Anthropic Messages (`/api/v1/messages`,
 * signed thinking blocks), GPT on OpenAI Responses (`/api/v1/responses`, encrypted reasoning items), every other model on
 * OpenRouter chat with its `reasoning_details` replayed. Each was probed on its pinned hosts.
 */
export const wireOf = (id: FrontierModel) => MODELS[id].model.startsWith('anthropic/') ? 'messages' as const : MODELS[id].model.startsWith('openai/') ? 'responses' as const : 'openrouter-chat' as const;

/** The model on OpenRouter, pinned to its hosts, on its family's wire; reasoning: the series' `authoring.reasoning`, else the provider's default. */
export const openRouter = (id: FrontierModel) => ({
  provider: wireOf(id) === 'messages' ? 'anthropic' as const : 'openai' as const, wire: wireOf(id), model: MODELS[id].model, baseUrl: 'https://openrouter.ai/api', apiKeyEnv: 'OPENROUTER_API_KEY', price: MODELS[id].price, contextTokens: MODELS[id].contextTokens,
  request: { provider: { only: [...MODELS[id].hosts], allow_fallbacks: false, require_parameters: true } },
});
