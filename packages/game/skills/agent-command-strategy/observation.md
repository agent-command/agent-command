# Reading the observation and match data

Field-by-field docs: `game_briefing {topic:'observation'}` and `{topic:'observation/<field>'}`; match data:
`game_briefing {topic:'match-data'}`. These are the facts that matter for strategy and policies.

## Match data (`init(matchData)`)

- Briefing match data (`game_briefing {topic:'match-data'}`, the policy `init(matchData)` input) has `preset`,
  packed `terrain`, `faults`, `armies` (`{id, slot, frame, colour, spireAt}` per army), `symmetry` (`C2` or `C4`),
  fixed `sun.speed`/`sun.half`/`sun.wedges` (one lit wedge per map slot), jet lanes (`jets`, rotated per slot: a lane
  runs along x or along y) and index-aligned `fogPaths` for `obs.weather.fog` (each with `turns`: evaluate the
  canonical point, then turn it).
  Retain `orbitRegions` too: public, fully rotated Orbit placement rectangles with centre `x/y`, `width/height`,
  initial drift `dx/dy`, relative spawn `weight` and drift `spread`. Bounds are x±width/2,y±height/2.
- Decode terrain with `(match.terrain[Math.floor(c / 7)] >>> (4 * (c % 7))) & 15`:
  0 ground, 1 cliff, 2 forest, 3 high ground, 4 ford, 5 fault, 6 water; 10 high forest, 12 high ford, 13 high fault, 14 high water.
  High = `code === 3 || (code & 8) !== 0`; feature = `code === 3 ? 0 : code & 7`. Cover/speed and elevation rules both apply.
  Water is impassable/unbuildable at either level; fords remain walkable, and a connected water/ford body has one level.
  `holes` remains dynamic and lists every hole with its `kind` (sinkhole, crater, chasm, breach).
- `sun.angle` and weather storm/forecast/fog positions remain per tick. Island phases and pauses change when the
  Surface Mooring Tower moves or holds one; asteroid deadlines advance and discovered magma floods expire, so these schedules remain dynamic.
  An island path's `hardpoint` {kind, side} (public) names what occupies its attach slot (absent = empty).
  `pausedAt` freezes the route clock while lowered or raising. `elevation` is vertical displacement in tiles
  (negative below the normal Sky plane). Release waits for physical raising into a safe gap before drift resumes.
  The fixed time cap is `match.rules.spire.timeCap` in seconds, not an entry repeated in `obs.schedule`; sudden
  death (`rules.spire.suddenDeathAt`) is, as `sudden_death` at its start tick, during its `suddenDeathWarning` countdown.

## Observation scope

- Your plane is in full (`detail`); every other plane is one compact entry in `planes`: `counts` (what your army sees
  there now, by kind: `own`/`hostile`/`neutral`), `events` (that plane's events left out of `events`), `transit` (your
  units leaving it for another plane), Surface `shafts` (your troop portals) and Sky `islands` (positions now).
- Always present: `alerts` (every plane), `impacts`, `schedule`, Spire, queue, research, resources, and cross-plane
  events (eliminations, Spire hits, breaches, island and core swings). Plane fields come with their planes: entities,
  `holes`/`lodes`/`oreCaches`/`charges`/`tremors` (Surface or Depths), `scorches`/`surfaceVision` (Surface), `weather`/`islands` (Sky),
  `depths`/`cracks`/`pockets`/`designations`/`flares` (Depths).
- Need another plane? `game_observe {detail: ['surface']}` (or `'all'`) for that call; a policy declares
  `var detail = ['surface'];` once. Read summaries first: they are smaller and cheaper to parse.

## Observation facts

- `mandate` carries autonomy, `directive`, optional `limits`, and `whenAbsent`; policies receive current owner intent.
- `charges` are the planted sapper charges your team knows of, with their detonation tick (own and allied ones also
  carry `stack`, the sappers on them): a hostile one only once your Depths vision covers it, you feel a tremor there,
  or in its last `chargePublicTime` (also `schedule` `collapse`); `flares` are Warden flares (yours, allies' and any whose cell you see) lit until `until`;
  `tremors` are enemy depths units under your surface units/buildings; `res.scanReadyAt` says when the orbital scan
  is ready; `rally` your rally points. Own Wardens carry
  `abilityReady` (flare cooldown tick) until the flare is ready; own Storm Seeders carry `ready` (seed cooldown end)
  and `activeUntil` (storm end). `weather.seedWarnings` (public, no owner) telegraph seeded storms forming at
  `from`; `weather.seeded` lists the active ones.
- Own Mooring Towers always expose `mooringPowered`. `mooringGrace` (remaining unpaid/power-loss ticks,
  never replenished during that selection) remains defined while a target is pending/held, even if obscured:
  its presence, including zero, means the tower is busy. `mooringTarget` (selected island ID) and tower
  `mooringState` are exposed only while the target's Sky cell is currently seen; Surface tower sight alone
  never reveals hidden island identity or state. `mooringState` is `waiting|lowering|held|raising`;
  islands expose `mooringReadyAt` (cooldown tick after rejoin). An island's `mooringTower` ID is present
  only while the tower is visible; never infer hidden tower identity.
- Shot FX may carry `sourceElevation` and `targetElevation`: world-tile vertical offsets snapshotted at
  firing time, not the endpoints' later positions. Unknown endpoint heights are omitted. For incoming-only
  fogged shots, `sourceElevation` carries the known impact height; shooter ID/side and `targetElevation`
  are omitted. Never infer a hidden shooter's identity or altitude from that incoming-only field.
- A tremor with `breach: true` is enemy troopers digging up to the surface right there (6 s warning).
- `entities` holds own units (with `tx`/`ty` for their current order), visible enemies, all islands and asteroids you can see.
- `surfaceVision` is your alliance's current raw Surface sight, packed as 30 cells per word:
  `((obs.surfaceVision[Math.floor(c / 30)] >>> (c % 30)) & 1) !== 0`. It includes captured posts'
  rule-defined sight (`rules.surface.postVision`), scans, spotting from above, and low-ground terrain occlusion.
  Any lit footprint cell reveals a structure; forest units still need close spotting. Missing detail gives no
  sight information. Do not forget a hidden structure just because an own unit is nearby; at the 600-entity
  observation cap, absence from `entities` is not proof of destruction either.
- Own diggers carry `carry` alloy while hauling; own Spire segments show their queued unit count in `carry`.
- Islands: `side` = holder, `link` = its slot structure, `progress` = capture progress of whoever is taking it;
  `state` is `capturing` (one alliance is taking it), `contested` (hostile alliances are on it together: progress
  frozen) or `drifting`. The holder and the capturing army follow state and progress from anywhere; everyone else
  only where they see the island (`contested` included).
- `impacts` lists every falling asteroid with its impact `tick` and `side` (who dropped it).
- `rockSize` is pebble/medium/large. `resourceType` is metal/ice/slag, `volatile` is an independent boolean,
  and `resourceRemaining` is remaining economic value, all only with local rock vision (including scans).
  Armed tows expose `fuseUntil` only locally too; public falling markers expose size, none of these fields.
- Tugs expose `cargoAlloy`/`cargoEnergy`; the owner's `miningTarget` is an observed entity ID, never a hidden-target oracle.
- `oreCaches` lists fog-filtered `{id, x, y, alloy, radius, below?}`; `below` has `{x, y, alloy}` for
  the underground share. A Depths-only view sets x/y to below and surface alloy to 0, never leaking its hidden
  Surface location. `scorches` lists visible `{x, y, radius, until}` hazards, not a global hazard oracle.
- `depths` (depths seat only) is your team's map knowledge, `y * size + x` (4 tunnel, 6 rail, 7 magma): the whole grid
  on a first observation (no `since`) or with detail "all"; otherwise `depthsChanges` lists `[cell, code, …]` changed
  since your `since` tick, to apply to the grid you keep.
- `pockets` lists only `{x, y, id}` cells your team remembers as located, **sealed** magma pockets; all cells
  of one pocket share `id`. Code 7 alone also includes flowing lava and is not enough to choose a tap.
  Pocket memory can be stale until observed again; deduplicate tapped and queued pockets by `id`, not cell.
- `res.income` is `{depths, surface, sky, orbit}`, each `{alloy, energy, upkeep}` in resources/second.
  Alloy is actual gross received over the rolling last 10 seconds (including mining deliveries and salvage);
  energy is instantaneous gross delivered, not potential generation or net of upkeep. Orbit reports
  `min(solarRate, energyCap)` plus any solar-bank discharge (never above `energyCap`); local Sky fallbacks and Depths
  taps bypass that delivery cap. `res.energyRate` is total gross delivered energy across planes; subtract upkeep
  separately when budgeting. `res.energyBank` is your stored solar surplus (0..`rules.economy.solarBankMax`).
- `res.alloy`/`energy` are bank totals. `freeAlloy`/`freeEnergy` are authoritative availability after total
  `heldAlloy`/`heldEnergy` and finite energy `upkeepHeld`; `recoveryAlloy`/`recoveryEnergy` are subsets of total holds.
  Never subtract the waiting queue or these holds again. Queue entries expose `heldAlloy`, `heldEnergy`,
  `recovery` (zero/false for paid/non-head work). Global array order controls only each output plane's lane;
  no global funding ETA is promised.
- `designations.normal` and `.urgent` (every seat) are team-only dig tags, packed as 30 cells per word like vision:
  `((obs.designations.urgent[Math.floor(c / 30)] >>> (c % 30)) & 1) !== 0`. Each mask has `Math.ceil(size * size / 30)` words.
- `alerts` is the per-plane digest the human's top bar shows, built only from your own fields above: up to 3 per
  plane, planes in order depths, surface, sky, orbit, most relevant first. Every plane leads with `sudden_death`
  (its start `tick`) during the countdown. Orbit `rocks` (next asteroid spawn
  `tick`); Sky threats first: `island_contested` (an island you hold whose `state` is `capturing` or `contested`,
  furthest capture first), then the next storm: `storm_forming` (forms at `tick`), then
  `storm_growing`/`storm_peak`/`storm_breaking` (that stage ends at `tick`); Surface threats first: `charge_under` (a known enemy charge blowing at `tick` within collapse reach of `count` of your Surface units or structures: step clear), `post_contested` (a forward post you hold being taken or fought over), then `drop` (telegraphed impact at `tick`, `side` = whose); Depths threats first:
  `intruder` (hostile Depths units you see in your tunnels near home: `count`, nearest x/y), `wall_dig` (enemy
  digging into your wall, crack `stage`), `charge` (known enemy charge blows at `tick`), then `breach`,
  `tremor` (`count` cells), then `magma` (flood cools at `tick`). `x`/`y` is the spot when there is one.
- `research.available`, `research.inProgress` and `research.completed` contain upgrade IDs; `research.seen` lists,
  per hostile army, `{army, upgrades}` whose effects your army has observed. Hostile completions become known only
  after an effect is observed; absence from `seen` does not mean unresearched.
- Entities expose an active `transit { to, at, until, return? }`: destination plane, arrival tick (0 after arrival),
  return tick (0 for a permanent move), and optional return plane (omitted while it equals the unit's current
  plane). Own units expose `transitReady`, the cooldown tick (missing/zero means ready). Ascent uses
  `to: 'orbit'` and, once there, `return: 'sky'`; the Sky seat retains command in Orbit.
- Own-unit observations omit the default `aggressive` stance; missing `stance` means aggressive, not unknown.
  Inactive `transit` is omitted, and `transitReady` is omitted once the cooldown has elapsed.
