// Agent Command — DEPTHS starter: the built-in Depths bot (policies/game/bots/depths.js, the code every built-in
// Depths seat plays) at its sandbox tier, bounded to fit the policy sandbox's per-call budget.
// Deploy it by reference and tune its knobs (`knobs` below: every knob, its bounds and default; all optional):
//   policy_deploy {"from":"agent-command-strategy/policies/depths.js","knobs":{"diggers":12,"routeSearches":2}}
// practice_run takes the same {from, knobs} as its artifact. To change more, fork it: copy this file into your
// policy modules (the imports become './agent-command-strategy/policies/game/…'), then override a DepthsBot method in
// StarterDepthsBot or wrap think below. policies.md, "Starters", shows both.
import { DepthsBot } from './game/bots/depths.js';
import { starterKnobs, starterPolicy } from './game/bots/starter.js';

export const knobs = starterKnobs('depths');
// The bot reads every plane in full, as the built-in bot does.
export const detail = 'all';

// ---- Subclass: change one decision ----
// Override any DepthsBot or PlaneBot method; call super to keep the built-in behaviour around your change, e.g.
//   decide(c) { const out = super.decide(c); /* edit out */ return out; }
class StarterDepthsBot extends DepthsBot {}

// One seat (the policy ABI's instance): `values` are the deploy's knobs (null: every default).
export function createPolicy(values) {
  const seat = starterPolicy(StarterDepthsBot, 'depths', values);
  return {
    init: (matchData) => seat.init(matchData),
    // ---- think wrapper: filter, add or reorder the bot's intents ----
    think: (obs) => seat.think(obs),
  };
}
