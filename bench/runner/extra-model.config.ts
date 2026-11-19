/**
 * A model pinned after the frozen build (so not in bench/frontier-models.ts), authored in the frozen build's own suite:
 * bench/acbench.config.ts built for a frozen template pin (ACBENCH_MODEL, any key of MODELS on the extra model's wire),
 * with the candidate's route replaced by EXTRA[ACBENCH_EXTRA_MODEL]. The suite, both build digests, the harness and the
 * profile are the template's (none of them depends on the candidate's model); the experiment names this model, its route
 * and price. Run the PlayerThree campaign CLI with `--config bench/runner/extra-model.config.ts` (bench/acbench.ts takes
 * frozen pins only).
 */
import base from '../acbench.config.ts';

/**
 * Same convention as bench/frontier-models.ts: named hosts only, their OpenRouter list prices (USD per 1M tokens), the
 * pinned hosts' context window, and the family's wire (`wireOf`).
 */
const EXTRA = {
  'claude-fable-5.2': { model: 'anthropic/claude-fable-5.2', wire: 'messages', hosts: ['anthropic'], price: { inPerM: 8, outPerM: 40, cacheReadPerM: 0.2 }, contextTokens: 1_000_000 },
  'gemini-4-neon': { model: 'google/gemini-4-neon', wire: 'openrouter-chat', hosts: ['google-vertex', 'google-ai-studio'], price: { inPerM: 3, outPerM: 15, cacheReadPerM: 0.15 }, contextTokens: 1_048_576 },
} as const;
const id = process.env.ACBENCH_EXTRA_MODEL ?? '';
if (!Object.hasOwn(EXTRA, id)) throw new Error(`ACBENCH_EXTRA_MODEL: one of ${Object.keys(EXTRA).join(', ')}`);
const pin = EXTRA[id as keyof typeof EXTRA];
const model = { provider: pin.wire === 'messages' ? 'anthropic' as const : 'openai' as const, wire: pin.wire, model: pin.model, baseUrl: 'https://openrouter.ai/api', apiKeyEnv: 'OPENROUTER_API_KEY', price: pin.price, contextTokens: pin.contextTokens,
  request: { provider: { only: [...pin.hosts], allow_fallbacks: false, require_parameters: true } }, billing: 'openrouter-key' as const };
// The template's profile names its wire, so the template must be a pin on the same wire (Gemini 4 Carbon for Gemini 4 Neon).
if (base.bench.models?.[base.candidateId]?.wire !== model.wire) throw new Error(`ACBENCH_MODEL: a template on the ${model.wire} wire, since the profile names the wire`);

export default { ...base, bench: { ...base.bench, models: { [base.candidateId]: model } },
  system: { ...base.system, id, label: `${id} (via OpenRouter, ${model.wire} wire)`, provider: model.provider, model: pin.model } };
