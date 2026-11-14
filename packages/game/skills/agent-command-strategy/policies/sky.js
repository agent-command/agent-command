// Agent Command — SKY starter: the built-in Sky bot (policies/game/bots/sky.js, the code every built-in
// Sky seat plays) at its sandbox tier, bounded to fit the policy sandbox's per-call budget.
// Deploy it by reference and tune its knobs (`knobs` below: every knob, its bounds and default; all optional):
//   policy_deploy {"from":"agent-command-strategy/policies/sky.js","knobs":{"interceptors":6,"bombers":3}}
// practice_run takes the same {from, knobs} as its artifact. To change more, fork it: copy this file into your
// policy modules (the imports become './agent-command-strategy/policies/game/…'), then override a SkyBot method in
// StarterSkyBot or wrap think below. policies.md, "Starters", shows both.
import { SkyBot } from './game/bots/sky.js';
import { starterKnobs, starterPolicy } from './game/bots/starter.js';

export const knobs = starterKnobs('sky');
// The bot reads every plane in full, as the built-in bot does.
export const detail = 'all';

// ---- Subclass: change one decision ----
// Override any SkyBot or PlaneBot method; call super to keep the built-in behaviour around your change, e.g.
//   decide(c) { const out = super.decide(c); /* edit out */ return out; }
class StarterSkyBot extends SkyBot {}

// One seat (the policy ABI's instance): `values` are the deploy's knobs (null: every default).
export function createPolicy(values) {
  const seat = starterPolicy(StarterSkyBot, 'sky', values);
  return {
    init: (matchData) => seat.init(matchData),
    // ---- think wrapper: filter, add or reorder the bot's intents ----
    think: (obs) => seat.think(obs),
  };
}
