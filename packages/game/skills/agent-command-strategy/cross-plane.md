# Cross-plane play: combos, collapses, holes and transfers

Full rules: `game_briefing {topic:'cross-plane'}` and `{topic:'collapses'}`.

## Combos

| Combo | Planes | Effect |
|---|---|---|
| Relay over enemy base → bombers/tanks get vision on the Spire | sky → surface | focus fire without scouting |
| Asteroid salvo, then ground push | orbit → surface | Spire at −1200 before your army arrives; craters split their defence |
| Stacked sapper collapse under their Spire | depths → surface | −400 per charge, +50% per extra sapper up to three (−800); sinkholes drop defenders into your tunnels |
| Troopers behind a walled Warden (the Surface seat `transfer`s them down at an own Shaft) | surface → depths | the Depths holds alone; with troopers in the wall's cover it pushes |
| Collapse or breach under their base | depths → surface | a breach squad climbs out next to their Shafts (one way: holes are no portals) |
| Lose the sky → base energy delivery drops from `baseEnergyCap` 4/s to `minimumEnergyCap` 1/s (each surviving relay still adds `relayEnergyCap` 4/s) | sky → everything | tanks, interceptors and bombers stall |
| Scan + tremors | orbit → depths/surface | find and kill sappers before their charge goes off |
| Collapse their base | depths → surface → depths | defenders on the sinkhole fall into your tunnels (holes are no portals: nobody climbs back) |
| Rail the cavern, then breach behind their army | depths → surface | a raid squad climbs out next to their Shafts |
| Open a fault on their half | depths → surface | a chasm cuts their army off the centre until they backfill it |
| Hold a hill, relay or bomber overhead | surface + sky | you out-range and out-see them; they cannot see you back |

## Collapses (sapper charges)

- A sapper `undermine` plants a charge that collapses after `rules.depths.undermineTime` (default 10 s). Charges are
  fogged (`chargesFogged`): an enemy sees one (`charges`, event `charge_spotted`) only through its Depths vision of
  the cell or a tremor it feels there, and everyone for its last `chargePublicTime` (default 5 s). That is still
  time to step away, so charges are for things that stay put (structures, turret lines, sieging tanks, gates,
  fortified walls), not armies. A Headframe (600 HP) or Shaft (500) needs two stacked; a turret (400) one.
- **Stacking:** sappers arriving within `chargeStackReach` (1) cells of their team's pending charge join it: one
  fuse, one defuse, and each sapper beyond the first adds `chargeStackDamage` (×0.5) of `collapseDamage`, counting
  up to `chargeStackMax` (3) sappers. Own and allied `charges` carry `stack`.
- The collapse deals `collapseDamage` (default 400) to EVERY Surface structure (any army, your own included, Spire
  segments included) whose footprint is within `collapseRadius + collapseStructureReach` (default 1.5 + 1 tiles)
  of the charge cell centre, and opens a sinkhole of `collapseRadius`. A charge also destroys every bulkhead within
  `chargeBulkheadReach` (default 1) tiles per axis.
- Below, the blast strips every fortification level from rock within `chargeStripReach` (default 1.5 tiles) and
  deals `chargeUnitDamage` (default 60) to hostile Depths units there. The tunnel itself stays open: tunnels never
  collapse.
- A charge under a fault cell ALSO deals that collapse damage, then opens a chasm along the fault (`chasmReach`,
  default ±4 cells; ±6 with Shaped Charges) instead of a round sinkhole. A chasm stops spreading at a fortified
  fault cell. Diggers `bridge` (backfill) any hole cell, chasm or not (30 alloy, 8 s per cell by default).
- **Defuse:** ANY ONE Depths unit hostile to the planter, staying within `defuseReach` (default 1) cell per axis of
  the charge cell for `defuseTime` (default 2 s) in a row, defuses it. Leaving resets the timer. Keep Depths eyes or
  Surface presence (tremors) near what you must not lose: hidden charges show up only there.
- House rule `collapses: false` bans every `undermine`, fault charges included.
- Ask for one: a `collapse` signal at a tile sends the Depths' sappers under it (topic signals).

## Holes

- A new hole (sinkhole, crater, chasm, breach) drops the Surface units standing on it into the Depths, but only where
  the Depths cell below is open (tunnel, rail, bridge, lava) with no Depths structure on it; over solid ground
  (bedrock, the Mother Lode, a lode pocket, rich ore) or a bulkhead/tap they step off onto the nearest open ground.
- Troopers and Breachers that fall take `ceil(maxHp × rules.surface.fallDamage)` (default 25% of MAXIMUM HP). Tanks
  and flak can neither climb out nor hit the Depths: they take `rules.surface.vehicleFallDamage` (default 100%: the
  fall wrecks them and frees their population). Falls into a hostile's hole are its kills (cause `fall`).
- Your Surface seat sees a hostile charge it knows of under its units or structures as the `charge_under` alert
  (within `collapseRadius + collapseStructureReach`): move clear before `tick`, tanks first.
- A hole opened over a hidden/sealed magma pocket breaks it and starts a magma flood (`magmaCells` default 6 cells,
  `magmaDps` default 12 damage/s to depths units), which cools back to open tunnel after `magmaCoolTime` (default
  60 s).
- Holes are never portals: no army can `transfer` through a sinkhole, crater, chasm or breach. An airdrop coming
  down into a new hole falls through it (or steps off) too. A `move` into a hole goes to the nearest open ground you
  know of.
- Rock under a hole becomes open tunnel; lode pockets, rich ore, bedrock, the Mother Lode, rails and lava stay, so a
  hole never empties a lode (fell the Headframe instead). Over a lava lake the fallen land in the lava: walk them
  out at once. An ore cache under a new hole moves to the nearest open ground.
- Only the blast damages structures: one that survives stands on over its hole (a surviving Shaft's landing opens).
- Opening a hole reveals the Depths cell under it to every army.

## Transfer points

Units change between Surface and Depths (`transfer`) only at your own BUILT Shafts: never the Spire root, a hole or
an enemy Shaft (`no_shaft`). Troopers arrive below on the Shaft's landing (the cell under its centre) and climb out
beside it. A Shaft completed in rock opens only its landing; until a tunnel reaches it the Shaft is `sealed` (own
entity field) and transfers there fail with `shaft_sealed`: dig to it. A Shaft over bedrock never opens. Headframes
are NOT transfer points: a Headframe's pocket below stays minable and walkable, and it is an ore drop-off.

Troopers reach the Depths only through the Surface seat: the Depths seat asks with a `troops` team signal ([signals.md](signals.md)), the Surface seat
`transfer`s them down at a Shaft, and the Depths seat commands them below.
