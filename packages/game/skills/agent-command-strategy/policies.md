# Policies: starters, knobs, forks, the ABI and practice

Contents: why a policy · deploy a starter by reference · tune its knobs · fork the source · the built-in bots' source ·
writing your own (ABI) · practice loop.

## Why a policy

Every plane has a chore that never ends (routes for diggers, drifting islands, the moving sun, asteroid towing).
LLM round-trips are too slow for these; a policy runs twice per game second. Deploy one early, then spend your own
turns on strategy (following your owner's mandate, timing attacks, reading reports).

## Deploy a starter by reference

Every plane has a starter, `policies/<plane>.js`: the built-in bot of that plane (the code every built-in seat plays,
`policies/game/`) at its **sandbox tier**, bounded so one call fits the sandbox's per-call budget with room to spare.
Depths, Surface and Orbit play the `standard` tier (Depths with its route searches bounded); Sky plays `veteran`.
Deploy one in one call:

```
policy_deploy {from:'agent-command-strategy/policies/depths.js'}
practice_run {artifact:{from:'agent-command-strategy/policies/depths.js'}, …}
```

The host builds it like any modules deploy (size limits, probe, versioning) and records `from` and `knobs` with the
version (`policy_status`, exports). Only the four starters can be deployed by reference.

## Tune its knobs

`knobs` sets the tier fields worth tuning; every knob is optional and bounded, and the rest keep the sandbox tier:

```
policy_deploy {from:'agent-command-strategy/policies/surface.js', knobs:{attackAt:12, deploy:'sharp', reserve:0}}
```

`game_briefing {topic:'starters'}` lists the four starters and every knob (type and bounds, default, a line on it),
then their exact JSON Schemas (each starter's `export const knobs`, built in `policies/game/bots/starter.js`).
Every starter has `period` (ticks between decisions), `reserve` (alloy held back)
and the lobby bot options `aggression` and `economyReserve`, which rescale army sizes, offensive times and reserves
unless those knobs are set. Times are in ticks (20 per second); the top of a time knob's range means never. A wrong
name or an out-of-range value fails the deploy with the knob's path and expected type.

Cost: a Depths think is mostly its worker-route fields, dig-route and lava-crossing searches and bulkhead cut
planning. `routeSearches` (fresh searches per decision; 0.5 is one every other decision), `routeReuse` (ticks a
planner keeps a route that still holds), `prepareAhead` (build the worker-route fields on the call before the
decision) and `gateWalks` (whole-map walks per decision for bulkhead cuts) bound them; more searches or walks,
`prepareAhead` off or a shorter `period` cost more of the per-call budget. A call over it is a `timeout`: it returns no
intents, but the instance keeps its state (routes, remembered shields and bulkheads) as of the interruption; three
timeouts with no successful call in between reload it fresh, losing that state. With `prepareAhead` on, a fresh
instance's first call only prepares and returns no intents: its first decision is the next call. Turn it off to see a
decision from a single call.

## Fork the source

When knobs are not enough, copy the starter into your own modules and edit it:

1. Read it (`game_skill … path:'policies/<plane>.js'`) and save it as a module, e.g. `depths.js`; its imports
   become `./agent-command-strategy/policies/game/…`.
2. Change one decision: override a `DepthsBot` (or `PlaneBot`) method in `StarterDepthsBot` and call `super` around
   your change, or edit the `think` wrapper in `createPolicy` (filter, add or reorder the bot's intents).
3. Add an entry that runs one seat and deploy `{runtime:'js', modules, entry}`:
   `import { createPolicy, detail } from './depths.js'; const seat = createPolicy(null); export { detail };
   export function init(d) { seat.init(d); } export function think(o) { return seat.think(o); }`

Keep the bot's discipline when you fork: plan in your army's frame (`Frame`), break ties in its order, and read only
the observation and match data, so rotated armies play rotated games.

Affordability uses `obs.res.freeAlloy`/`freeEnergy`, never bank totals minus every waiting entry. The simulator
already protects each eligible lane head, verified worker recovery and finite upkeep; budget only new requests from
the current decision. Keep a durable first expensive production request; optional buys use `ifAffordable`. Do not
repeatedly move entries to global index 0: indices are global on the wire but order is local to the output plane.
Recovery reads `matchData.rules.queue.recoveryWorkers`, not the starting workforce.

## The built-in bots' source

`policies/game/` is the built-in bots' own code: every module the `novice`, `standard` and `veteran` bots run
(`bots/<plane>.js`, `bots/plane-bot.js`, `bots/tuning.js` with each tier and the sandbox tiers, `bots/starter.js`
with the knobs, and the rules, geometry and nav they import), as JavaScript. Every bot seat plays exactly this code as
a PlayerThree policy package. Read it for how a bot plans, prioritises and answers team signals, e.g.
`game_skill {name:'agent-command-strategy', path:'policies/game/bots/depths.js'}`. The starters answer and send team
signals as the bots do (signals.md); with `rules.signals.enabled` false they send none.

## Writing your own (ABI)

```js
var memory = {};                 // globals persist between calls within a match
var match;
function init(data) { match = data; } // separate bootstrap, not part of the observation byte budget
function think(obs) {
  if (!match || match.rulesHash !== obs.rulesHash) throw new Error('missing match bootstrap');
  log('tick ' + obs.tick);       // your own log lines; returned to you, never to anyone else
  return [{ kind: 'macro', action: 'auto_mine' }];   // intents, same shapes as game_act
}
```

Deploy it as `{runtime:'js', code}`, or as ES modules `{runtime:'js', modules, entry}` (the entry exports `think`,
optional `init` and `detail`; imports of `./agent-command-strategy/…` resolve against this skill). No I/O, no clock
(Date is frozen, Math.random is seeded), hard per-call time and memory limits; see `game_briefing {topic:'modes'}`.
Intents are validated exactly like `game_act` input; rejected ones are counted in `policy_status.intentsRejected` by
error code. `init(matchData)` receives the same match data as `game_briefing {topic:'match-data'}`; decoding recipes
are in `observation.md`. A policy sees its own plane in full and the others summarised (`obs.planes`); declare the
planes it reads in full once: `detail = ['surface']` (or `'all'`, as the starters do).

## Practice loop

1. **Practice before you trust it.** Within the `playerthree-policy-author` workflow, compare `standard` and `veteran`. Read the
   report: `armies` rows (per army: rank, alloyMined, energyDelivered, kills, islandTicks, spireDamageDealt) tell you
   which plane is losing; the timeline tells you when. Read your policy's `log()` lines in the practice result.
2. **Revise one thing at a time** (one knob, one override) and practise again with the same seed so the comparison is
   fair.
3. Deploy the winner with `policy_deploy`, then monitor `policy_status` (rejected intents by error code) while you
   keep the `game_wait` loop running.
