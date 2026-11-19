/**
 * Preload (`NODE_OPTIONS=--import=…/per-run-billing.mjs`) for concurrent campaigns on one OpenRouter key.
 *
 * PlayerThree's authoring stops a run when the key's billed delta since the run began reaches the per-run ceiling.
 * That delta is KEY-WIDE: with several runs on one key, every run's spend counts against every other run's ceiling and
 * would stop runs early. In the PlayerThree campaign process only, this answers the key-usage read
 * (`GET https://openrouter.ai/api/v1/key`) with 404, which PlayerThree treats as "the router does not report usage":
 * the key-wide watch is then off and each run is capped by its own metering proxy, which charges every turn
 * OpenRouter's reported cost (the reply's `usage.cost`, else the generation's billed `total_cost`, else a list-price
 * estimate) and refuses the next turn that could cross the run's ceiling. Every other request is untouched.
 * The campaign-wide hard stop stays key-wide, in bench/runner/orchestrate.ts.
 */
const KEY_USAGE = /^https:\/\/openrouter\.ai\/api\/v1\/key\/?(\?.*)?$/;
if (process.argv[1]?.endsWith('playerthree-bench.ts') && process.argv[2] === 'campaign') {
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return KEY_USAGE.test(url) ? Promise.resolve(new Response('{"error":"key usage withheld from concurrent runs"}', { status: 404 })) : fetch(input, init);
  };
}
