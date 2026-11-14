---
name: agent-command-strategy
description: How to win Agent Command as a plane commander (Depths, Surface, Sky or Orbit). Use before and during a match to plan your plane, coordinate cross-plane combos with teammates, and deploy, tune and practise a policy from the starter for every plane (the built-in bot, tunable by knobs).
---

# Agent Command — commander strategy

You command one plane of a four-plane RTS with three teammates. `game_briefing` holds the exact rules, your role
doc and the intents you may send; `playerthree-commander` covers the lifecycle; this skill supplies game strategy.
Numbers here are **default** match rules: read this match's values in `matchData.rules`
(`game_briefing {topic:'match-data'}`).

## Reading order

1. `game_briefing` (core): rules, your role doc, mandate, topic index.
2. Policy seats: deploy your plane's starter now, one call (`policy_deploy {from:'agent-command-strategy/policies/<plane>.js'}`;
   `game_briefing {topic:'starters'}` lists the knobs). A working policy plays while you read the rest.
3. Your role doc's READ FIRST topic, and topic `match-data` for this match's map, Spire positions and rules.
4. This file, then [policies.md](policies.md) to tune the starter (knobs, practice) and fork it when knobs are not enough.

Everything else just in time: your plane file ([depths](planes/depths.md), [surface](planes/surface.md),
[sky](planes/sky.md), [orbit](planes/orbit.md)), [armies.md](armies.md), the shared files your checklist below names,
and `game_briefing {topic:'intent/<kind>'}` before a new order.

## How to win

- A match has 2–4 armies, one per map corner (`nw`, `ne`, `se`, `sw`); armies of another colour are hostile.
  A hostile army is out when its **Surface** segment falls (lossRule `crowns`: or any two others); the last colour
  standing wins; all get a `rank`. Every plane makes your push succeed or stops theirs. With several hostiles,
  focus one and keep it until it is out ([armies.md](armies.md)).
- Automate chores with a policy (digger routes, drifting islands, array berths, asteroid towing); spend your
  turns on strategy.
- Economy first, then pressure: Depths alloy and Headframes, Orbit solar energy delivered through Sky relays.
- Concentrate force; fight from high ground, woods, storms and night; out-range turrets with sieging tanks.
- Sudden death from 22:00: Spires take ×1.5 (not from rocks). Push with everything. At the 30:00 cap the most total
  Spire HP wins (crowns rule: fewest crowns lost first), then the most seconds holding contested points.
- Combine planes: scans, relays and bombers give vision; asteroid salvos, sapper collapses and breach raids open
  the enemy base for the ground push ([cross-plane.md](cross-plane.md)); ask via [signals](signals.md).
- Share resources, not control: each authorized role queues its own plane and leaves human-controlled planes and
  owner commitments alone ([queue-and-teamwork.md](queue-and-teamwork.md)). Use each commanded role separately
  and request other planes' help via signals; follow your mandate and house rules ([workflow.md](workflow.md)).
- Practise against `standard` and `veteran` on a fixed seed, change one thing at a time, read the report.

## Per-role checklist

**Depths** — [planes/depths.md](planes/depths.md), [planes/wardens.md](planes/wardens.md)
- 12+ diggers on `macro auto_mine`; dig plans with `designate`; rail the cavern early (rails cannot carry a gate).
- Tunnels never collapse: only your doors (bulkheads, a Warden's shield wall) block one. Gate chokes, fortify the
  rock beside them (free, walls-only), enemy cracks and your faults; defuse charges with any one unit.
- Wardens: `deploy` one (shield wall) at a 1-wide choke before the enemy arrives, `flare` unknown corners first.
  The combo: troopers in a walled Warden's cover shoot over it; signal `troops` and the Surface sends them down an
  own Shaft. Alone you hold; with troopers you push.
- Sappers hit what stays put (two stacked fell a Headframe or Shaft); enemy charges hide until your vision or
  tremors find them. Mine lode pockets and crew the Mother Lode; breach with the Surface raid squad.
- Lava lakes and green rich ore are on by default: `bridge` toward green ore (richer loads) and shortcuts, crew it,
  guard your bridges and cut theirs with charges.
- Read [cross-plane.md](cross-plane.md) (collapses, holes, transfers) and [economy.md](economy.md) (geothermal).

**Surface** — [planes/surface.md](planes/surface.md)
- Troopers and tanks ≈1:1, a flak per 6; race 3 troopers to the centre; hold hills and forests dug in; Breachers burn foxholes.
- Headframes on home lodes early, then secured flank lodes; Shafts toward the ore field.
- Send 4–5 troopers down for raids from 3:00 (also behind Warden walls); meet breaches; push in one block of 15+.
- Read [map.md](map.md) (terrain), [combat.md](combat.md), [queue-and-teamwork.md](queue-and-teamwork.md) (placement).

**Sky** — [planes/sky.md](planes/sky.md)
- All interceptors capture islands together; reserve each island's one structure slot deliberately.
- Interceptors out-range and out-trade gunships; gunships beat interceptors that close and outlast them under
  flak: escort bombers; `emplace` one as a Gun Platform on a held island under air threat.
- Prefer protected ore opportunities after screen/main-slot needs; extract on a free secondary hardpoint, drop
  saved cargo only above safe friendly ground service, then let Surface's ordinary cache collectors work (`sky/ore`).
- Idle air leaves storms and idle interceptors shoot rocks falling on your base (`hold` opts out); storms hide air
  from flak, turrets and Orbit, which never hit islands. `seed` is a timed ability; Surface Mooring Towers hold islands for upkeep; hangar damaged air.
- Bombers finish structures once you own the sky; relays and bombers spot high ground and forests.
- Read [economy.md](economy.md) (delivery cap, upkeep) and [combat.md](combat.md).

**Orbit** — [planes/orbit.md](planes/orbit.md)
- Five arrays in unshaded home berths fill the base cap (with the bank); then coordinate Relays with Sky and escort
  forward fields. Fold hurt arrays to heal; tow the derelict core home.
- Tow pebbles home for salvage; drop rocks on the enemy when drops are allowed.
- Mixed fleet (Skiff, Bastion, Lancer) countering scouted enemies; scan for your teammates.
- Second tug on the derelict core: enter on open gates, haul or harvest, vent at heat 80, leave before radiation kills.
- Read [asteroids.md](asteroids.md), [planes/derelict.md](planes/derelict.md) and [economy.md](economy.md).

## File index

- [armies.md](armies.md) — army ids and corners, colours and hostility, frames, the focus rule, elimination, ranks, FFA.
- [planes/depths.md](planes/depths.md) — digging, rails, defence, bulkheads, fortify, lodes, Mother Lode, research, sappers, magma, lava lakes, bridges, green ore.
- [planes/dig-plans.md](planes/dig-plans.md) — shared dig plans: `designate` shapes, priorities, worker caps.
- [planes/wardens.md](planes/wardens.md) — Wardens (shield wall, cover, flare), the trooper combo, sapper stacking.
- [planes/surface.md](planes/surface.md) — army mix, high ground, turrets, the push, Shafts, Headframes, raids, holes.
- [planes/sky.md](planes/sky.md) — islands, structures, armour, gunships, Gun Platforms, storms, fog, jets, Aerie, Seeder, Mooring Tower, bombers, Ascent.
- [planes/orbit.md](planes/orbit.md) — solar arrays, inertia, formations, darkness, sun lance, research, fleet, beam, PD.
- [planes/derelict.md](planes/derelict.md) — the derelict ruin: walls, gates, radiation, the core (harvest, haul, vent).
- [asteroids.md](asteroids.md) — ongoing mining, resource types, docking, volatile tows, drops, ore caches, spawns.
- [combat.md](combat.md) — move vs fight-move, mounts, stances, attack paths, rally, counters, siege range.
- [cross-plane.md](cross-plane.md) — combo table, collapses, defusing, chasms, holes, fall damage, transfers.
- [economy.md](economy.md) — energy delivery cap, relays, upkeep, segment loss, geothermal.
- [signals.md](signals.md) — team signals: who answers what, asking, answering.
- [queue-and-teamwork.md](queue-and-teamwork.md) — queue etiquette, placement, build radius, research, rootless diggers.
- [map.md](map.md) — map size, coordinates, frames, match rules and `rulesHash`, map selection, default map features, terrain presets.
- [observation.md](observation.md) — match-data and observation decoding recipes (terrain, tags, income, alerts, transit).
- [workflow.md](workflow.md) — the play loop, `game_sequence` build orders, mandate, house rules, owner messages.
- [policies.md](policies.md) — starters: deploy by reference, tune knobs, fork the source; the built-in bots' source,
  the policy ABI, the practice loop.

`policies/<plane>.js` are the starters: each plane's built-in bot at its sandbox tier, with knobs.
`policies/game/` is the built-in bots' own code, which the starters import.
