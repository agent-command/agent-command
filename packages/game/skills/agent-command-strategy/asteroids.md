# Asteroids: ongoing mining, towing, drops and ore caches

Contents: mine or drop (size table, docking) · resource types · volatile tows · shooting towed rocks · ore caches ·
core bomb · rule knobs · stand-off releases · spawn regions. Full rules: `game_briefing {topic:'rocks'}`.

## Mine or drop

Grapple a visible drifting rock, then move the tug to tow it. Size changes the tradeoff:

| Size | HP | Tow multiplier | Base resource value | Impact damage | Blast radius | Warning |
|---|---:|---:|---:|---:|---:|---:|
| pebble | 60 | 0.9 | 30 | 120 | 1.5 | 4 s |
| medium | 300 | 0.5 | 150 | 600 | 3 | 8 s |
| large | 800 | 0.3 | 400 | 1500 | 4.5 | 12 s |

Docking is automatic when the tug enters `rules.orbit.dockRadius` (default 3) of **its own live Orbit
segment**. A destroyed segment and a held station are not docks; station docking remains deferred.
Metal pays alloy; ice pays energy at `iceEnergyShare` (0.8) × base value, exempt from the energy delivery cap; slag pays nothing. Docking pays remaining value only.
A Spire takes an impact on its **Surface segment only, at ×0.5** (`rules.spire.impactMultiplier`; a medium does 300),
and sudden death does not raise it: drops soften a base, armies take it. One rock per map slot spawns every 30 s while
at most 5 drift (`asteroidSpawnPeriod`, `maxAsteroids`), the same pace for every seat.

`mine_asteroid {units, asteroid, queue?}` explicitly starts ongoing mining of a locally visible metal/ice rock.
The tug approaches a `tugMineReach` (default 3 tiles, centre-to-centre) stand-off and latches exclusively, extracting while the rock drifts at `tugMineRate` (2 resource units/s). Whole-rock `grappleReach` remains 1.5.
Its `cargoAlloy`/`cargoEnergy` hold `tugHold` (50) total; a full hold or exhausted rock sends it home to unload.
Fog during a cargo trip does not cancel the assignment: it returns along the last observed drift (including public field-edge reflections), reacquires locally and resumes. Reaching an empty predicted site ends the assignment; hidden destruction or towing never reveals itself remotely.
Own `miningAssigned` stays true during the whole loop: **do not overwrite it**, even with an empty hold and no visible target. `miningTarget` is present only with local target vision; state is `grappling` on approach, `mining` while harvesting, `returning` on the cargo trip. Own `tx`/`ty` in fog are predicted from observations, not hidden live coordinates.
Move/stop cancels the latch without losing cargo; moving home unloads it. A lost own Orbit segment stops extraction and retains cargo.
Mining strips proportional hull: full ice depletion strips full hull just like metal. Damage caps remaining recoverable value by hull fraction.
Dock and cache payouts use `resourceRemaining`; impact damage scales by remaining hp/maxHp. Mining cannot duplicate full salvage or full-strength bombs.

Web: select a tug, use **' / Mine asteroid**, then click visible metal/ice; right-click also mines and Shift queues.
Use **Tow payload** for whole-rock grappling; right-click slag grapples. Move/Stop detach retaining cargo.
Right-click the own Orbit Spire to bring cargo home.

## Resource type and independent volatility

Local rock vision exposes `resourceType` (metal/ice/slag), `volatile` and `resourceRemaining`.
Metal (45%) and ice (30%) fund mining or whole-rock towing; slag (the remainder) is a drop-only rock, not an inventory resource.
Nonvolatile metal drops leave a cache worth `oreCacheMultiplier` (2) × remaining value.
Drop onto accessible controlled ground clear of friendly units/buildings, then race collection.
Ice and slag never leave a cache. Volatility rolls independently (10%): volatile drops leave no cache,
deal ×1.5 damage at ×1.5 radius and scorch for 10 s at 8 damage/s. Public markers reveal size only, not resource type, value or volatility.

## Volatile tows are live explosives

Grappling starts `volatileFuse` (default 45 s) and scales current
and maximum rock HP by `volatileTowHpFraction` (default 0.5). While still towed, destruction or fuse
expiry detonates in Orbit for `volatileOrbitDamage` (default 300) within `volatileOrbitRadius`
(default 3.5), hitting every army's ships, arrays and structures, including the tug; normal shields apply.
The `volatile_detonation` event/effect is local-vision filtered, not a public warning or owner reveal.
Dropping cancels the fuse, removes `fuseUntil`, and restores ordinary size HP while preserving the
remaining health fraction. The falling rock then uses its normal size and volatile Surface damage,
radius and scorch. Docking cancels the fuse and pays the remaining resource value, not a volatile bonus.

Acquire volatile only when drops are allowed and the intended enemy drop is reachable before the fuse:
`max(0, distance(rock, target) - deorbitRange) / (tug speed × size tow multiplier) < volatileFuse`.
Reassess using the **visible** `fuseUntil` tick and currently scouted hostile weapons along the route.
Release a reachable useful strike immediately; do not wait for a salvo while the fuse runs. If
interception is likely or time is insufficient, deorbit immediately onto clear ground away from your
Surface and Orbit assets, preferring another useful reachable enemy target. Do not acquire volatile
under a no-drops mandate; nonvolatile metal and ice still support mining and docking.

## Shooting towed rocks

Any Orbit weapon may shoot an enemy-towed volatile rock; Bastion point defence may also shoot enemy-towed
rocks that are not volatile (the Orbit segment's station defence may not). Route your own tows away from enemy Bastions.
Lancers, Bastions and other eligible Orbit weapons should explicitly focus an enemy-towed volatile
rock near a hostile tug when its blast is clear of friendly assets and the shooter can engage safely.
Orbit blasts measure unit centres and structure footprint edges; weapon range still reaches the rock's
body edge (`rules.orbit.asteroidRadius`, default 0.8 tiles). This lets a default Bastion shoot from just beyond the default blast radius.
Do not infer volatility or an armed fuse from a tug, public marker or remembered sighting alone.

## Ore caches

Cache collection defaults to a radius of 2 and a 30-alloy load every 3 s while uncontested. When a crater
exposes Depths access, `oreCacheDepthShare` (default 0.25) reserves a quarter below for diggers; the rest
is on the Surface. Every army can race each share. Read visible `alloy`/`below.alloy` rather than assuming
the initial amount remains, and move collectors back to other work when depleted or no longer safe.

## Core bomb

A tug towing the derelict core (`planes/derelict.md`) may `deorbit` it onto a Surface point within `deorbitRange`
once the core is past the ruin's hull (inside it: `invalid_target`; a no-drops mandate: `mandate_limit`). It falls
like a rock: a public marker in `impacts` (subject `core`) for `coreDropTime` (10 s), interceptable while falling
(`coreHp` 500; interceptors, flak, Bastion PD). Damage = `coreDropDamage` + `coreDropCoolBonus` × (1 − heat/100)
(300 + 600 for a cold core), within `coreDropRadius` (3.5), bypassing Spire shields like impacts; it leaves a crater
(`coreDropCrater` 2) and irradiated ground: a scorch over the blast radius for `coreIrradiateTime` (15 s) at
`coreIrradiateDps` (6) to Surface units. A spent core (no vent left to buy time) is worth a strike from the
stand-off circle; a cool one hits harder, but cashing it in at home is usually worth more.
Defend by shooting enemy tows with Lancers (outside the 4-tile meltdown) and intercepting the fall.

## Rule knobs

All values are `rules.orbit` configuration: medium uses `asteroidHp`, `towSpeed`, `dockValue`,
`impactDamage`, `impactRadius`, `impactDelay`, `impactCraterRadius`; pebble/large use `pebbleHp`/`largeHp`,
`pebbleTowSpeed`/`largeTowSpeed`, `pebbleDockValue`/`largeDockValue`, and corresponding
`pebbleImpactDamage/Radius/Delay` and `largeImpactDamage/Radius/Delay`, plus
`pebbleCraterRadius`/`largeCraterRadius`. Cache knobs are `oreCacheMultiplier`, `oreCacheRadius`,
`oreCacheLoad`, `oreCachePeriod`, `oreCacheDepthShare`; volatile knobs are `volatileDamageMultiplier`,
`volatileRadiusMultiplier`, `volatileFuse`, `volatileTowHpFraction`, `volatileOrbitDamage`,
`volatileOrbitRadius`, `scorchDuration`, `scorchDps`. Timings are seconds, observation deadlines ticks.
Spawn mix uses `pebbleChance` (0.65), `largeChance` (0.1), `metalChance` (0.45),
`iceChance` (0.30), slag remainder, and independent `volatileChance` (0.1). `asteroidDrift` defaults to 0.3 tiles/s/axis;
`asteroidEdge` defaults to 2. Read custom match values rather than assuming these defaults.

## Stand-off releases

The enemy Orbit segment's beam covers Orbit (`rules.spire.range` + the target's radius, tug 0.5, measured from its
3×3 footprint edge: up to 7 + 2.12 + 0.5 = 9.62 from the centre on the diagonal): tugs must release from a stand-off point outside that reach, within `rules.orbit.deorbitRange`
(default 10) of the target (the rules keep it beyond the beam on every bearing), never from over the Spire.

## Spawn regions

You only see asteroids near your Orbit units. Retained `matchData.orbitRegions` describes likely spawn areas and
approach lanes, not future events: position idle scouts near high-weight own-side region centres, clear of the
enemy station beam, and screen observed traffic with escorts/interceptors. Use the initial drift and spread to
understand the approach, not to invent a hidden rock or its arrival time. Placement does not introduce new
movement, reward or collision physics. Only actual visible asteroids authorize grapple/attack decisions;
public falling markers still disclose no unseen resource type, remaining value, volatility or fuse. The Orbit example stages idle tugs from
these retained lanes and switches to explicit mining of observed metal/ice, or grappling for requested drops and safe volatile strikes.
