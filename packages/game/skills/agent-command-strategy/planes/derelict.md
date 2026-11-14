# The derelict ruin (Orbit)

A neutral ruin fixed at the map centre; `matchData.derelict` (absent when `rules.orbit.derelictEnabled` is off) gives
its public geometry: tiles from the centre and the gate cycle in ticks. Read it, never the rule defaults: they are S48
tiles × size/48 (the hull spans 0.56 of the map), smaller where the Spires stand closer (`spireInset`), so the hull
plus `derelictLane` (4.8) always stays outside every Spire's Orbit beam reach and deorbit stand-off.

## Walls, gates, radiation

- **Hull** band `hullInner`–`hullOuter` (default 11.8–13.5 tiles at S48) with `breaches` gaps (`breachWidth` 5.8) on
  the axis bearings E/S/W/N. **Ring** band `ringInner`–`ringOuter` (7.2–8.4) with `gates` (`gateWidth` 5.8). Walls
  block Orbit movement, fire and sight (`rules.orbit.derelictBlocksVision`, cloak detection included); drifting rocks
  glance off the hull. Ship orders route through breaches and open gates on their own; a move into a sealed chamber
  holds at the gate mouth until it opens. A formation split round the ruin sets out from its ship nearest the goal, the
  others going round the walls on their own. A Bastion line (three abreast) fits a gate.
- **Sight** passes the walls only where a shot would: through a breach, or an open gate. A fleet hugging the hull sees
  nothing of the corridor behind it, and a fleet in the corridor nothing outside. Use it: park in the corridor between
  two breaches to ambush ships coming through, and expect the same. Before committing, look through a breach or scan.
  An open gate exposes the chamber along its line: ships lined up on a breach and its gate see (and shoot) in, so a
  chamber ambush sits off the gate lines, and a fleet waiting inside for the window is seen once it opens.
- **Cycle** from tick 0: open `open` → ring turns `turn` → sealed `closed` → turns (default 40 s / 2 s / 24 s, period
  68 s). A turning ring pushes ships out of the gate (no damage). The public `schedule` lists the next two windows
  (`derelict_open {tick, until}`): arrive at the gate mouth before `tick`, never plan to leave after `until`.
- **Chamber** (inside the ring): while sealed only ships inside it or a `scan` see what is there; while open, ships
  outside see in along the gate lines. Every unit in it takes `rules.orbit.derelictRadiation` (2.5/s; shields first,
  regen paused; Aegis does not cover it). A ship that enters must outlast a whole sealed span (28 s = 70 damage by
  default): leave on an open window before that.
  Your ships in it raise the Orbit alert `radiation` (`count`) and the own event `irradiated` (every few seconds).
  Re-check every decision from hp + shield against everything hitting them (radiation and enemy fire, or the loss
  measured since last time): if they cannot last until the window after the coming one, leave on the coming one. Order
  the exit only while the gates are open or about to open within the trip to them; while sealed, hold (a move into
  the shut ring only paces at the gate mouth). A tug sent for the core is committed: it grabs first unless it would
  die before it is out with the core on the next exit, and sets out only if hp + shield lasts from entering to that
  exit. A core tug that cannot tow out in time `release`s it and runs.

## The core

- A core (entity kind `core`, neutral; `coreEnabled`) rests in the chamber. With sight of it: `heat`, `heatRate`
  and `vents`. Holding or capturing it pays nothing by itself: holding the ruin decides who extracts it.
- **Heat** out past the hull, towed or left there: `coreTransitHeat` (1/s on S48, × (48/size)^`coreTransitScale`):
  100 / 133.3 / 166.7 s from cold on S48 / M64 / L80. It cools `coreCoolRate` (5/s) in the chamber; the corridor holds heat steady.
- **Cash-in:** tow it within `dockRadius` (3) of your own Orbit segment and it is spent once for `coreRewardAlloy`
  (200) + `coreRewardEnergy` (200, straight to stock past the cap; public event `core_cashed`). At the default Spire inset,
  nearest cardinal hull-breach to docking range is about 19 / 28 / 37 tiles on S48 / M64 / L80. At 0.8 tiles/s, allow
  24 / 35 / 46 s plus steering: the cold-core heat clock leaves ample detour/interception margin, not unlimited holding.
  Stage outside the hull: on L80, about 23 tiles inward at 2 tiles/s plus 14 tiles back out of the chamber at
  0.8 tiles/s takes about 29 s before turns. The 40 s window fits this extraction with maneuvering margin; missing it
  still costs 70 radiation damage over the sealed span. Extraction inside the hull does not spend the outside heat clock.
- **Haul out:** `grapple {units:[tug], asteroid: coreId}` (or `macro harvest_core`: your nearest free tug grapples a
  visible core, else heads into the ruin to find it; a tug already towing it brings it back to the chamber). Tow
  speed ×`coreTowSpeed` (0.4), out only through an open gate. `macro haul_core`: the towing tug heads home to cash it
  in. Leaving the hull publishes `coreLifted {tick, x, y, side}` and the Orbit alert `core_lifted` to every army.
  `release {units}` lets go where the tug is.
- **Vent:** `vent {units:[tug]}`: the towing tug holds still `coreVentTime` (8 s; moving restarts it); heat drops to
  vents so far × `coreVentFloor` (25): each vent buys less time. It pulses `coreVentDamage` (40) to every Orbit unit
  within `coreVentRadius` (3), yours included: vent away from your own ships. Its pale steam pulse is nonterminal:
  the core stays attached. A fiery meltdown consumes it; do not confuse a heat purge with destruction.
- **Meltdown:** heat 100, or the core destroyed (`coreHp` 500) while towed: `coreMeltdownDamage` (400) to every Orbit
  unit and structure within `coreMeltdownRadius` (4); the core is gone, the tug free. Any Orbit weapon may shoot an
  enemy-towed core: Lancers (range 6) out-range the blast; Skiffs and Bastions do not.
- **Drop:** `deorbit` a towed core onto the Surface once it is past the hull (see `asteroids.md`, core bomb).
- **Regrowth:** a cashed-in, dropped or melted core regrows after `coreRegrowTime` (150 s): `schedule` `core_regrows {tick}` and the
  public event `core_regrows`. Towing it out does not start the timer.

## Play

- Keep one tug on rocks and one on the core (with two tugs, pull an empty miner off the rocks for the run). Stage it
  outside the hull between two breaches (ships parked in a breach mouth block your own tows), enter on the open
  window when no armed enemy is inside, latch on, and tow it home to cash it in. With `coreEnabled` off the chamber
  is empty: stay out of its radiation.
- Escort it: it is shootable under tow. Vent if the tow runs hot, bring it back in to cool, or drop it on a target in
  reach once it is spent (a cooler core hits harder).
- Two tugs in reach on the same tick tie: neither latches. Back your tug out of the radiation and, on the next window,
  hold the rival's gate mouth with the fleet from the corridor (outside the ring): whoever holds the gates lifts it.
  An exact mirror ties every time; stop after a few tied windows instead of burning tugs on it.
- An enemy holder is invisible until you look: scan the centre, or send ships in on a window when you can win.
- Gather the fleet by the ruin, not in the chamber.
