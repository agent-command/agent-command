// Agent Command — SURFACE starter: the built-in Surface bot (policies/game/bots/surface.js, the code every built-in
// Surface seat plays) at its sandbox tier, bounded to fit the policy sandbox's per-call budget.
// Deploy it by reference and tune its knobs (`knobs` below: every knob, its bounds and default; all optional):
//   policy_deploy {"from":"agent-command-strategy/policies/surface.js","knobs":{"attackAt":12,"deploy":"sharp"}}
// practice_run takes the same {from, knobs} as its artifact. To change more, fork it: copy this file into your
// policy modules (the imports become './agent-command-strategy/policies/game/…'), then override a SurfaceBot method in
// StarterSurfaceBot or wrap think below. policies.md, "Starters", shows both.
import { SurfaceBot } from './game/bots/surface.js';
import { starterKnobs, starterPolicy } from './game/bots/starter.js';

export const knobs = starterKnobs('surface');
// The bot reads every plane in full, as the built-in bot does.
export const detail = 'all';

// ---- Subclass: change one decision ----
// Override any SurfaceBot or PlaneBot method; call super to keep the built-in behaviour around your change, e.g.
//   decide(c) { const out = super.decide(c); /* edit out */ return out; }
class StarterSurfaceBot extends SurfaceBot {}

// One seat (the policy ABI's instance): `values` are the deploy's knobs (null: every default).
export function createPolicy(values) {
  const seat = starterPolicy(StarterSurfaceBot, 'surface', values);
  return {
    init: (matchData) => seat.init(matchData),
    // ---- think wrapper: filter, add or reorder the bot's intents ----
    think: (obs) => seat.think(obs),
  };
}
