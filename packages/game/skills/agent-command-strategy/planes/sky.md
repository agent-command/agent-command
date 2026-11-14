# Sky

## Islands

- Reserve sticky capture guards for owned investments/queued construction before support, repair, escorts or
  interception. Replace missing/displaced guards; release surplus after eight calm seconds. Surplus/new air
  share an unheld-island target. Badly damaged guards may repair at a powered Aerie only from quiet completed sites.
- Capture: 5 s uncontested (`captureTime`), 12 s with built enemy structure (`captureStructureTime`).
  Capture drains maxHp/12 per second; early structure death permits capture after 5 s. Bomb/shoot it first.
  Hostile aircraft freeze progress (`contested`); empty progress decays. Own islands under capture show
  `capturing`, progress and `island_contested`: `capture` to contest before 1.
- One shared slot: Relay (delivery/vision), Stormcatcher (storm energy), Aerie (production/shelter/repair),
  Storm Seeder (storms). `queue_add {item,island}`; inspect the team queue. Recapture destroys enemy sites.
  Surface Mooring Towers can hold any island without changing its ownership or slots; coordinate with Surface.
- Invest on uncontested, non-advancing owned islands with defenders inside `captureRadius` outnumbering
  and outlasting visible local armed Sky threats. First Relay, then demanded repair/production Aerie.
  Second Relay needs `res.solarRate > res.energyCap`; Stormcatcher/Seeder follow. Count constructing sites once.
- Aerie, Stormcatcher and Storm Seeder can only be QUEUED while your Sky Spire segment lives (`segment_destroyed`,
  also a waiting entry's blocked reason); a Relay can be queued without it. Built ones keep working after Sky loss.
- Island structures are armour `island` (missiles ×0.75); flak and turrets never target them unless
  `rules.sky.groundHitsIslandStructures` (then flak ×0.35, turrets ×0.25). Captures and air take them.

## Air units and counters

- Gunship (`heavy_air`, 320 HP, rifle range 3, can capture) vs interceptor (range 5): interceptors out-range and
  out-trade it per cost; it beats interceptors that close. Flak and missiles hit it ×1.25 (air ×1.5), so per cost it
  outlasts interceptors under flak: escort bombers with it. `rules.sky.gunshipEnabled` off: `blocked`.
- The Gunship turret fires while moving. `emplace {unit, island}`: a Gunship within `captureRadius` of your island
  lands on its empty hardpoint (public `islands[].hardpoint`) as a permanent, storm-proof Gun Platform (same HP
  fraction, range +1). Hostile captures stall while it lives; flak and out-ranging interceptors counter it. Emplace
  where hostile air closes on a Relay; shoot enemy platforms down before capturing.

## Island Mortar

- Sky `queue_add {item:'island_mortar',island}` builds on an own island's secondary gunner hardpoint,
  mutually exclusive with Gun Platform and Ore Extractor. Never consumes or replaces the Aerie/Relay/Stormcatcher/Seeder main slot.
  Defaults: 140 alloy + 80 energy, 20 s, 300 HP, `island` armour; needs a living Sky segment to queue.
- Completed mortars take Sky `attack {units:[mortarId],target:surfaceEntityId}` orders against currently visible
  hostile Surface entities only. Use existing team Lens sight and `detail:['surface']`, not remembered contacts.
  Horizontal reach 8, damage 60 every 6 s, splash 2.5; unified nonhoming bomb rounds travel at 5 tiles/s with
  `rules.sky.mortarFlightTime` (default 2 s) minimum flight. The fixed impact point and arrival are telegraphed;
  moving targets can escape. No map-wide fire or extra vision.
- Works while drifting or moored. Lowering does not change planes, weather, fog or ownership. Like Gun Platforms,
  a live armed hostile mortar blocks capture: destroy the hardpoint before trying to take its island.
- Built-in bots and the starter buy at most one mortar at a time, only after the interceptor screen is ready,
  on a quiet guarded own island with a completed main structure and a nearby visible Surface target.
  Keep costs of queued purchases, an alloy reserve and at least the next interceptor/ten seconds of upkeep in energy.
  Do not fight a pending Gunship emplacement for its hardpoint or sacrifice island guards for mortar fire.

## Ore islands and extraction

- Read `game_briefing {topic:'sky/ore'}`. Public `oreCapacity` identifies finite deposits, not remaining ore.
  Entity `oreRemaining` requires ownership or actual current Sky-cell sight; `oreBuffer` is exact-owner-only,
  including zero. Public island paths never disclose either dynamic field. Missing means unknown, not depleted.
- `queue_add {item:'ore_extractor',island}` needs an own positive deposit, live Sky segment and unoccupied,
  unreserved secondary hardpoint. Exclusive with Gun Platform/Mortar; the main slot stays independent.
  Defaults: 80 alloy, 40 energy, 20 s, 250 HP, unarmed/no vision. No capture-blocking weapon.
- `rules.sky.extractorRate` (0.5 alloy/s) transfers remaining ore into `oreBuffer` while shared power pays
  `extractorUpkeep` (1 energy/s), up to `extractorBuffer` (40). Owner-only `extractorPowered` reports actual grid
  payment; `state:'mining'` means actual paid work. Full/depleted/unpowered pauses; no idle work upkeep.
  Drifting and moored work identically. This is supplemental economy, not a replacement for rich lodes.
- Native and bundled JS keep the existing screen, main-slot priorities, guards, queue commitments and reserves.
  Useful safe ore slightly improves capture/investment ranking; no weapon displacement or speculative hidden reserves.
- `drop_ore {island}` releases the whole positive owner buffer as the SAME ordinary Surface cache used by
  asteroid ore, at the column's nearest legal cell. No direct income, crater, damage or underground share.
  Anyone can collect. Wait for `surfaceVision` of clear ground and healthy friendly trooper/flak service within
  cache radius minus one tile (rounding margin); refuse observed enemies, hazards and blocked/unknown ground.
  Sky never assigns collectors: the existing Surface cache detachment remains the sole assignment path.
- `dismantle {structure:extractorId}` retires a completed own extractor, no refund. This intent also removes other completed own static buildings on their commanded plane (not Spires, objectives or mobile units); ordinary destruction consequences apply, so do not demolish useful buildings indiscriminately. Incomplete sites use `queue_cancel`. On depletion,
  dismantle even if unsafe ground delays the drop. Cargo belongs to the island: drop later by island ID without
  a live/powered extractor. Capture transfers remaining ore and undropped cargo; attachment loss/rebuild never resets it.
- A queued extractor with reason `blocked` on an own island with observed `oreRemaining:0` cannot recover.
  A new queue request on an already exhausted deposit instead fails the action with `invalid_target`.
  Both implementations cancel only their own role's trusted automatic entry; unknown reserves, manual plans,
  other seats' entries and temporarily waiting work are preserved. Disabled hardpoints also invalidate the entry.
- Follow ordinary seat/mandate gates. `drop_ore` is not `deorbit`: the `asteroidDrops:false` house rule forbids
  asteroid strikes, not harmless cargo release.

## Storms, fog and jets

- `weather.storms` describes current natural cells; `weather.forecast` announces cells 20–30 s ahead.
  Tick zero has forecasts only. Fields: id, x/y/radius/strength/stage, maxRadius, originX/originY,
  dx/dy (tiles/tick), start/grown/breaking/end (absolute ticks), turns.
  `sampleStorm(cell,tick,out,frame,size)` from `@agent-command/game/weather` samples linear canonical drift,
  quarter-turns around map centre and radius growth/hold/shrink (frame 0 = world).
  Never extrapolate unannounced sites/repeating tracks. Forecasts cause no concealment, damage, slowdown or income.
- Inside a current storm's radius, concealment hides units from outside sight and blocks flak, turret and Orbit
  targeting of Sky units and structures except scans; Spire beams and Sky-to-Sky fire ignore storms. At full
  strength air slows to ×0.6 and takes 4 dps; `strength` scales the speed penalty and damage during growth/breakup.
  `weather.fog` gives current fog positions and halves observer sight; cached `match.fogPaths` gives their public
  circular paths. Scans reveal defenders inside storms.
- Researched enemy Lancer Lens (`research.seen` after a seen shot) beams aircraft within `orbit.lensReach`
  (1.5 tiles horizontally) at `lensDamageMultiplier` (×0.5). Avoid loitering below; storms hide you.
- Cached `match.jets` are the jet lanes. Air units in Sky inside a lane's half-width get a speed factor that scales
  with alignment: with c = cos(angle between travel and lane direction), factor = 1 + (jetWith − 1)·c for c ≥ 0 and
  1 − (1 − jetAgainst)·|c| for c < 0 (`rules.sky.jetWith` 1.8, `jetAgainst` 0.6 are the fully aligned defaults);
  crosswind is about ×1 and overlapping lanes multiply.
- Storm evade (`rules.sky.stormEvadeEnabled`): idle air a damaging storm reaches steps out on its own, unless its
  own order ended inside or it is on `hold`. Moving, capturing and attacking air never evades: detour around storms,
  ride jets your way; stay in only on purpose (an attack, a storm-hidden approach past flak, an Aerie).

## Stormcatchers

Up to 1.5 energy/s while the island centre is inside a current storm, no delivery cap or upkeep (natural output
scales with `strength`; seeded pays in full). Seeder radius 7 > `islandClearance` 6: your Seeder on a neighbouring
island reaches it within 7 tiles; one seeded storm pays it 45 energy for the 40-energy seed. Plan on announced
storm geometry, not averages.

## Aerie, hangar, repair and airdrop

- An Aerie queues aircraft with `queue_add {item, producer:aerieId}` even after the Sky segment falls.
  `hangar {units,target:aerieId}` shelters up to four aircraft within `rules.sky.aerieDockRadius` (3) tiles
  (`invalid_target` otherwise); housed units cannot see, fight or capture. `launch {units}` takes 2 s. A destroyed
  Aerie evacuates them at half HP (`aerieLossHealth`).
  Hangar admission requires your own powered Aerie. At the wrong elevation the aircraft first approaches and
  descends to its deck, still visible and vulnerable until docking. Newly produced aircraft start at deck
  elevation; aircraft leaving a lowered island climb. Gunship `emplace` also requires matching island elevation:
  capture or move near the island first rather than attempting to emplace from normal Sky height.
- A powered Aerie repairs housed aircraft `rules.sky.aerieRepair` (4) HP/s (off with `aerieRepairEnabled`): hangar
  damaged air between fights or through a passing storm, launch it healed.
- Aircraft queues retain work through temporary Aerie power loss. Cancel aircraft entries only when their named
  producer is missing/dead, or their implicit Sky segment is dead. Immediately requeue the same aircraft through
  a surviving powered Aerie (canonical-frame order), otherwise a live segment, reserving its cost without
  duplicating production. If no producer survives, cancel only and resume natural demand when one returns.
  Do not cancel every `blocked` entry.
- `airdrop {aerie:aerieId}` buys three normal-cost troopers down the column every 30 s, paid at once outside the
  team queue: leave room for teammates' entries and coordinate the Surface attack.

## Storm Seeder and Mooring Tower

Values below are unvalidated balance defaults: read `rules.sky` for Seeder and `rules.surface` for mooring (seconds).
- `seed {seeder}` (40 energy): `weather.seedWarnings` {x, y, radius, from} telegraphs 3 s, then a radius-7 storm
  follows the Seeder's island for 30 s (`weather.seeded`); cooldown 75 s (own Seeder `ready`, `activeUntil`).
  No upkeep by default (`seederUpkeep`); power loss ends it. Your air takes ×0.5 storm damage in your own storm,
  hidden from flak, turrets and Orbit. Enemy telegraphs warn you: move clear or scan inside.
- Surface builds `queue_add {item:'mooring_tower',x,y}`: integer minimum corner, 2×2, 400 HP,
  100 alloy + 60 energy, 25 s construction, vision 7; normal Surface build radius, visibility and spacing apply.
- Surface `moor {tower,island}` selects an observed island for your completed tower; `unmoor {tower}` releases.
  Own, allied, hostile and neutral islands are eligible. This never changes ownership, production, building
  access or slot capacity. One island per tower, no army-wide cap.
- With `rules.surface.mooringEnabled`, wait for `mooringRange` (10), then lower vertically at the same x/y
  over `mooringTravelTime` (3 s). Every ring is eligible; ordinary drifting islands pass overhead.
- Lowering/held towers pay `mooringUpkeep` (3 energy/s). Unpaid upkeep or power loss spends a nonrenewable
  `mooringGraceTime` (3 s) budget: flickering power never refills it. Grace exhaustion, tower destruction or
  manual release raises the island into a safe gap on its original delayed circle, without catch-up or teleport.
  Only rejoin starts `mooringCooldown` (20 s); no handoff of lowered/raising islands.
- Prefer useful owned Relays near a fight, Aeries near a front, or Stormcatchers in storms. Budget sustained
  surplus and an energy reserve, not merely the construction cost; a cheap waiting tower is not a free hold.
- Aircraft physically descend at the selected lowered island and climb when leaving; weather and fog remain planar.

## Intercepting asteroids

Idle interceptors not on `hold` auto-intercept hostile rocks whose blast would hit your Surface structures within
`rules.sky.autoInterceptRadius` (8) of their post. Otherwise assign only surplus interceptors with explicit
`attack {units, target: impact.id}` orders, sized per falling payload (visible HP and time remaining, or a small
fallback group when only the public impact is known). Preserve island guards and continue other decisions;
`macro intercept` redirects every interceptor and abandons their captures. Two interceptors plus the Sky Spire
segment shoot down one asteroid (300 HP); flak near the impact point helps.

## Bombers and spotting

- Bombers (60 damage, range 1.5 by default) finish structures once you own the sky. Build a pair behind your
  interceptor screen once you hold two islands and **match** the enemy's visible sky anti-air (equal is enough: a
  mirror never gets a strict lead); with energy to spare (the bots: > 200) over two held islands, build one pair
  anyway. Explicitly attack visible turrets, Headframes and the Surface Spire, or fight-move toward a
  remembered structure to regain sight. Their surface spotting also reveals high ground and forests.
- Bombers (3 tiles) and relays (surface vision below the island) are what spot enemies on high ground and in
  forests; low ground cannot see them. Put one over the hill your army is about to fight for.

## Ascent Thrusters

`research {upgrade: "ascent_thrusters"}` (defaults 150 alloy, 100 energy, 30 s).
Buy it once the interceptor screen, committed production and the next aircraft are funded and at least two
interceptors are owned or queued; do not wait for island control (that gates bombers and raids). Research has its
own producer slot, so a full production buffer does not block it.
Once completed, `ascend {units}` sends interceptors into Orbit: 25 energy each, 2 s telegraphed climb,
20 s raid, 45 s cooldown. Read `rules.research` and `rules.ascent` for the match's values.
Keep an interceptor screen in Sky; send surplus aircraft after enemy arrays, tugs and Lancers.
Stop reserving energy for a missing screen after its Sky producer is destroyed; fund surviving planes instead.
Join a nearby Lancer fleet for a segment siege rather than sending one or two raiders into its beam.
`attack_nearest` alone cannot reach Orbit from Sky.
They fall at their current x/y: plan a safe return rather than landing above enemy flak.
Ascended interceptors have shields only in Orbit.
