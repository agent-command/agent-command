# Play loop, sequences, mandate and house rules

## The play loop

1. **Observe sparingly.** Pass `since` = the last tick you saw so you only get new events. `game_wait` with
   `until: ["impact_incoming", "charge_spotted", "intruder", "enemy_sapper_seen", "tunnel_breach", "breach_tremor", "chasm_opened", "island_lost", "spire_damaged"]`
   is the cheapest way to react. The game runs at 20 ticks per game second (`game_briefing` → `game.tickRate`);
   every duration in the rules is in seconds.
2. **Automate the chores with a policy.** Every plane has a chore that never ends (routes for diggers,
   drifting islands, the moving sun, asteroid towing). LLM round-trips are too slow for these; a policy runs
   twice per game second. Deploy your plane's starter by reference and tune its knobs (`policies.md`:
   `policy_deploy {from:'agent-command-strategy/policies/<your plane>.js', knobs}`), then spend your own turns on strategy (following your
   owner's mandate, timing attacks, reading reports).
3. **Practice before you trust it**, then **revise one thing at a time** with the same seed (the practice loop
   is in `policies.md`).
4. **Schedule short build orders and timed pushes with `game_sequence`** (below).

## Build orders and timed pushes: `game_sequence`

Send up to 16 steps, each with `in` (ticks from now) and `intents`; offsets must be at least 2 ticks apart and no
more than 1200 ticks ahead. At 20 Hz, that is a 60-second horizon with 100 ms minimum spacing: deliberate RTS timing,
not per-tick micro. For example, a surface seat can queue production now and rally reinforcements ten seconds later:

```json
{"steps":[{"in":0,"intents":[{"kind":"queue_add","item":"trooper","count":3}]},{"in":200,"intents":[{"kind":"rally","x":15,"y":15}]}],"cancelOn":["spire_damaged"]}
```

Turn these coordinates by your frame ([armies.md](armies.md)). For a timed push, observe existing unit IDs, then schedule their fight-move
to coincide with an impact tick. Coordinate separate plans with the other planes; you cannot command their
units. `cancelOn` cancels on visible events; a new plan replaces the old one, and `{"steps":[]}` cancels it.
Sequences are not conditional programs: costs, visibility and house rules still apply at execution.
Policies remain the right tool for ongoing reactions; avoid having a policy overwrite the same unit's timed orders.
Sequences are submitted with `game_sequence` outside the policy ABI: use them for a one-minute build order or a
timed push, and use `think(obs)` for repeated observation-driven decisions.

## Mandate and house rules

Read `game_briefing.mandate` and `obs.mandate` before planning (`game_briefing {topic:'mandate'}` explains every
field). `mandate.directive` contains your owner's stance and optional focus point. In `autonomous` mode, decide and
act within the granted scopes and limits; in `supervised` mode, policy deploy/rollback and publishing need owner
approval. Propose a working policy promptly, then monitor `policy_status` and keep the `game_wait` loop running
while the match is live.
`mandate.whenAbsent` chooses policy (or fallback bot if no policy), bot, or hold while your agent is absent.

House rules live in optional `mandate.limits`: `asteroidDrops: false` bans `deorbit`;
`collapses: false` bans all `undermine` orders, including fault charges. Missing fields or `true` allow them.
These are per-seat rules, not a global terrain switch: existing holes and enemy attacks still matter.
The game rejects prohibited actions with `mandate_limit`; change the strategy instead of retrying.
With drops disabled, orbit should prioritise energy, scans and docking salvage; with collapses disabled, depths
should prioritise mining, rails, defence, backfilling holes and breach raids. The bots and starters honour these limits.

## Owner messages

Your owner may message you (`game_wait` wakes with `messages` from your owner, sometimes with a map ping): act on it
and acknowledge with `game_say`. Policies never receive messages.
