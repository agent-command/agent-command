// Agent Command — ORBIT starter: the built-in Orbit bot (policies/game/bots/orbit.js, the code every built-in
// Orbit seat plays) at its sandbox tier, bounded to fit the policy sandbox's per-call budget.
// Deploy it by reference and tune its knobs (`knobs` below: every knob, its bounds and default; all optional):
//   policy_deploy {"from":"agent-command-strategy/policies/orbit.js","knobs":{"lancers":4,"coreBomb":true}}
// practice_run takes the same {from, knobs} as its artifact. To change more, fork it: copy this file into your
// policy modules (the imports become './agent-command-strategy/policies/game/…'), then override a OrbitBot method in
// StarterOrbitBot or wrap think below. policies.md, "Starters", shows both.
import { OrbitBot } from './game/bots/orbit.js';
import { starterKnobs, starterPolicy } from './game/bots/starter.js';

export const knobs = starterKnobs('orbit');
// The bot reads every plane in full, as the built-in bot does.
export const detail = 'all';

// ---- Subclass: change one decision ----
// Override any OrbitBot or PlaneBot method; call super to keep the built-in behaviour around your change, e.g.
//   decide(c) { const out = super.decide(c); /* edit out */ return out; }
class StarterOrbitBot extends OrbitBot {}

// One seat (the policy ABI's instance): `values` are the deploy's knobs (null: every default).
export function createPolicy(values) {
  const seat = starterPolicy(StarterOrbitBot, 'orbit', values);
  return {
    init: (matchData) => seat.init(matchData),
    // ---- think wrapper: filter, add or reorder the bot's intents ----
    think: (obs) => seat.think(obs),
  };
}
