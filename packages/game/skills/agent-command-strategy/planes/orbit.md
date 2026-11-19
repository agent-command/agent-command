# Orbit

Ongoing tug mining, whole-rock towing, drops and caches are in `asteroids.md`; the derelict ruin and its core are in `derelict.md`.

**Auto-mine** (`macro {action:'auto_mine'}`) enrolls only idle, unqueued owned Orbit tugs without a tow.
It selects visible reachable nonvolatile metal/ice, keeps separate friendly rock assignments through cargo trips,
unloads at your live Orbit segment, resumes a viable site using observed drift, and selects another after depletion.
No available rock means stable idle search, not omniscient scouting; reveal more rocks or move the tug and re-enroll.
Slag, volatile rocks and the derelict core are never acquired. Existing manual mining, core and towing work is untouched.
`miningAssigned` stays true even while searching: bots/policies must not steal these tugs. Move, Stop and Release
cancel immediately retaining cargo; queued explicit work takes over after the current cargo unload (immediately
when empty). Losing the home segment cancels without paying or deleting cargo. Depths `auto_mine` is unchanged.

## Energy and movement

- Arrays anchor where they stop (3 s; a move packs them first) and only anchored ones earn: `solarRate` 2 × light
  (night 0.4) × ramp (0.5 → 1 over 40 s anchored; moving resets it, a hit ≥ 10 halves it) × distance (1 within 10
  tiles of your segment's edge → 0.4 at 20) × shade (−0.25 per own array within 4, floor 0.4); rules
  `rules.orbit.solar*`, topic orbit/economy. Five unshaded home arrays earn 10/s day, 4/s night; the bank holds
  the base cap of 6. Repayment: ~50 s home, ~90 s at 0.4×. Forward fields need Relays and escorts.
- `macro {action:'spread_arrays'}` (**Spread arrays**) spaces arrays at legal home-first berths, never tugs.
  It keeps productive deployments/separated goals; a bounded heuristic leaves unimproved arrays unchanged.
  Empty succeeds; unavailable Orbit home: `invalid_target`. Moves pack arrays and reset their ramp.
- Delivery is capped at `res.energyCap` (6 + 4 per Relay); surplus charges `res.energyBank` (max 300), which
  discharges through the cap at night or after losses. Ascent raids can reach Orbit from Sky.
- Fold a hurt array (`deploy {on:false}`) to repair it (2 HP/s after 8 s unhit; it loses its ramp); ships within
  `dockRadius` of your segment dock for repairs.
- Orbit ships have inertia: per-kind `rules.stats[kind].orbitAcceleration` (tiles/s²) and `orbitTurnRate`
  (rad/s) apply only while in Orbit, including Ascent raids. Stops coast and sharp turns overshoot; leave room.
- Multi-ship `move` uses `formation: 'wedge' | 'line' | 'escort'` (escort also names `escort: shipId`, the tug or
  array you protect); without one, each ship takes its own size-scaled slot round the point. Formations travel at
  the slowest member's speed and wait for stragglers (`rules.orbit.formationSpacing`/`formationSlack`); combat can
  break them.

## Darkness

- Darkness is concealment, not invisibility: an Orbit ship in the night wedge has `rules.orbit.nightVision`
  (default ×0.7) observer vision. A dark cell is detectable at `nightSignature` (default ×0.65) of that radius.
  Read public `sun` to plan dawn/dusk raids; arrays earning in daylight are more exposed.
  Scans/sensor pings bypass both penalties over their normal radius and duration.
- The Orbit segment's own sensor is vision × `nightSignature` from its centre in dark cells, but never less than
  its beam range (`rules.spire.range`, 7) from its footprint edge, day or night: Lancers (range 6) sieging it in the
  dark are always seen and shot back. Beyond that floor an allied scout does not extend the segment's detection; a
  scan does. Stand-off releases remain safest; darkness changes as the sun rotates and is no guarantee of protection.

## Sun lance

**Sun lance is free**, available on the first Lancer, not a research upgrade. Cast
`sun_lance {units:[lancerId],x,y}` from a lit cell. Defaults: 50 energy, 25 s cooldown,
2 s visible aim-line charge, then a travelling plasma bolt at 12 tiles/s over range 14.
It pierces hostile ships and structures: 120 first-hit damage, 60 each thereafter; structures take ×0.5
(`lanceStructureMultiplier`). Firing empties the Lancer's shield. Aim through clustered ships.
Dodge the aim line and travelling bolt, dive the charging caster, or fight on the night side.
Read `rules.orbit.lanceEnergy`, `lanceCooldown`, `lanceCharge`, `lanceSpeed`, `lanceRange`,
`lanceDamage`, `lancePierceDamage`, `lanceWidth`, `lanceStructureMultiplier`; never assume defaults.

## Research

- **Choose Orbit research from scouting.** `research {upgrade:'aegis_projectors'}` costs
  100 alloy/100 energy/25 s by default; `research {upgrade:'night_cloak'}` costs 125/100/30 s.
  Both use the live Orbit segment and shared queue, one research at a time per segment;
  `rules.research` contains this match's costs/times. Check `research.available`, `inProgress`,
  `completed`; hostile upgrades appear in `research.seen` (per army) only when their effects become known.
  Prioritize an actual Bastion counter-composition against a Lancer-heavy scouted fleet, then Aegis once
  at least two Bastions are owned or queued. Prepare at least three Skiffs before cloak against exposed
  economy without Bastions. Research must fit alongside committed production and the next desired ship.
- **Lancer Lens** (`lancer_lens`, 100/100/25 s; off when `rules.orbit.lancerLensEnabled` is false): Lancers also
  beam enemy Sky aircraft (not structures or rocks) within `rules.orbit.lensReach` (1.5 tiles, to the target's edge)
  horizontally, at `lensDamageMultiplier` (×0.5), and see that column except in storms. Buy it once ~3 enemy
  aircraft fly under your Lancers.
- **Aegis:** researched Bastions cast `aegis {units:[bastionId]}`, rooting for 6 s and shielding allies within
  2.5 tiles with a shared pool of 1.5 × current caster shield, drained before allies' shields/hull.
  Depletion ends it. Cost 40 energy; cooldown 30 s (`rules.orbit.aegisEnergy/Cooldown/Radius/Duration/ShieldMultiplier`).
  Cast with shield under focused fire; counter by bursting the pool, baiting cooldown or flanking with Skiffs.
- **Night cloak:** researched Skiffs automatically cloak in the night wedge while not firing;
  there is no activation intent. They disappear from enemy observations/render, with only a faint
  fast-moving shimmer. Firing, damage or entering light breaks cloak and prevents re-cloaking for
  `rules.orbit.cloakBreakTime` (4 s). Route raids through night, then strike at the terminator.
  Ordinary enemy ships detect within `cloakDetectRadius` (1.5 tiles); scans reveal them,
  the Orbit segment detects within its beam reach, and Bastions detect within their PD range.
  Escort working arrays/tugs with Bastions even at night; avoid those escorts when raiding.
  Dawn removes concealment. Missing enemies never prove that a route is safe.
- **Ability observations:** own `abilityReady` is an absolute tick: compare with `obs.tick`,
  not seconds. Visible charge telegraphs are `lance:{x,y,at}`; active bubbles are
  `aegis:{until,pool}`. `cloaked:true` is exposed for own or detected enemy Skiffs only.
  Enemy cooldowns stay private. Do not overwrite a charging Lancer or rooted Bastion with
  ordinary combat moves.

## Scans

`scan` is your support verb onto every plane: scan tremors under your base so the depths and surface seats can
see the intruders, a hostile Spire right before an asteroid salvo, the central caverns early (hidden magma pockets
become known), or a forest the army is about to enter.

## Fleet

- **Build a mixed fleet, not a single fighter type.** Queue `skiff`, `bastion` and `lancer`. Skiffs are cheap,
  fast short-range raiders; Bastions carry rapid short-range turret point defence; Lancers are long-range beam
  frigates. Counter **scouted Orbit enemies only**: add Bastions against Skiffs, Lancers against Bastions, and
  Skiffs against Lancers. Small Skiff armor resists beams; point defence defeats small craft but not armored
  frigates. Unseen units and production never influence the mix.
  With an armed enemy ship in sight, queue the counter before replacing arrays, even with every array dead:
  rebuilt arrays only feed the raiders.
- Keep Bastions close to forward array fields and towing convoys instead of chasing across the map. Send Skiffs
  together after the enemy's forward fields (past its beam) and tugs: a hit halves an array's ramp, a forced move
  resets it. Gather Lancers outside the derelict hull as the main battle line.
  Nearby Ascent support counts, but distant allies cannot rescue an isolated raid.
- Compare **current HP + shield**, matchup-adjusted DPS and local numbers before committing. Retreat even
  already-attacking groups when outmatched; require a clear advantage rather than deliberately trading evenly.
  Orbit warship shields recharge only after their damage-free delay: read `rules.stats.<kind>.shield`,
  `shieldRegen` (HP/s) and `shieldDelay` (seconds). Ascended interceptors have shields only in Orbit.
- Dock damaged hulls within `rules.orbit.dockRadius` of your living Orbit segment: `dockHull` repairs HP/s and
  `dockShield` restores shields/s. Use `move` formations: Skiff `wedge`, Lancer `line`, Bastion `escort`.
  An explicit `escort` anchor must be a selected own Orbit ship; do not overwrite a civilian's economic order
  just to use it as the centre of a combat formation.

## Spire beam and point defence

Every Spire segment fires its beam only on its own plane (`rules.spire`: default 30 damage, range 7 measured from
its 3×3 footprint edge to the target's edge, 1 s cooldown): from the centre that is 7 + 1.5 + radius on an axis and up
to 7 + 2.12 + radius on the diagonal, so no bearing out-ranges it. The Orbit segment also has independent close-range
point defence (`rules.orbit.stationPdDamage`,
`stationPdCooldown`, `stationPdRange`): add both weapons when inside its PD range, especially with small Skiffs.
Long-range Lancers can stay outside that PD bubble. Gather a fleet with a safety margin against remaining segment
HP before siege; never chase an economic target through the beam. Skiffs cannot hit Sky/Surface;
Lancers reach the Sky only through the Lens.
Bastion point defence also intercepts falling payloads in the Sky (the segment's station PD cannot), not arbitrary
Sky aircraft. Bastion point defence also shoots enemy-TOWED rocks in Orbit (any weapon may shoot a towed
volatile): towing past enemy Bastions risks the rock.
Any Orbit fire into the Sky is blind inside a storm: Sky targets within a storm's current radius cannot be targeted
from Orbit unless your team scans the spot (enemy Storm Seeders telegraph theirs in `weather.seedWarnings`).
