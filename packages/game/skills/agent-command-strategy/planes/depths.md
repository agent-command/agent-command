# Depths

Contents: the Depths principle · economy · dig plans ([dig-plans.md](dig-plans.md)) · rails · defence (defuse, gates, cracks, fortify,
faults) · Wardens · lode pockets · the Mother Lode · research · offence (breach raids, faults, sapper strike) · magma · lava lakes, bridges and green ore · crater ore. Wardens, the
trooper combo and sapper stacking: [wardens.md](wardens.md); energy fallbacks in `economy.md`; collapse, hole and
transfer rules in `cross-plane.md`.

**Tunnels never collapse. The Surface breaks; the Depths endures.** Nothing fills a tunnel (craters open the
Depths, magma cools back to tunnel); only a door you choose blocks one: a bulkhead or a Warden's shield wall.

## Economy

- Economy first: aim for 12+ diggers (each carries up to 4 loads = 40 alloy); keep most earning while access opens.
  `macro auto_mine` gives idle workers routine mining orders that already yield to reachable shared tags:
  these workers form an elastic dig crew and resume mining when no tag is reachable. Explicit `mine`, even
  without x/y, overrides tags; the bot uses it for targeted lode crews and temporary safe-ore reassignment.
  If deliberately moving an explicit miner onto tags, send `stop` once on that transition, not every policy call:
  repeated stops reset ongoing tag work. Miners explore automatically when no ore is known.
  Ore runs out (5 loads per cell at home up to 16 in the centre; the home veins last a few minutes), so the rich centre is what you fight
  over — and a big unguarded mining crew invites raids: keep Wardens near your miners and the cavern chokes.
- **The Mother Lode** (`rules.map.motherLode`; default the centre 2×2, known to all): code-8 solid ore ringed by
  tunnel. `motherLodeCrewPerCell` diggers (1) mine a cell at once from beside it, a load every 6 s; a rival waits
  (`contested`). `motherLodeLoads` per cell (0: endless) refill at `motherLodeRegen`/s. Only `mine {x, y}` at a lode
  cell mines it (plain `mine`/auto_mine keep to ore; `motherLodeAutoMine`): pick the crew, hold it with Wardens.
- **Lode pressure** (`obs.motherLode`, shared, public): each load adds `lodePressurePerLoad`, it bleeds
  `lodePressureBleed`/s; one digger about breaks even. `warn` glows. At `critical` the fuse burns: it vents at `ventAt`
  whatever anyone does (alert `lode_critical`): `lodeVentBlast` kills the ring's diggers, magma floods the ring and
  beyond, then `cooling` until `until`. Run on the fuse; an enemy crew that stays is caught.

## Dig plans

Publish shared dig corridors with `designate` (any seat); details and the bot's tag rules: [dig-plans.md](dig-plans.md).

## Rail the cavern

A natural cavern runs from your root to a chamber under the centre. Rail it early: send one digger to the root
and `rail` to the chamber (5 alloy per cell; the veteran bot starts at 1:30, the standard bot at 4:00). Rails are
×2.5 speed for miners, raiders and sappers (and for the enemy, if they find your rails). A rail cell cannot carry a
bulkhead: leave a bare tunnel cell at the chokes you mean to gate.

## Defence

- **Defuse.** Enemy charges are hidden until your Depths vision or Surface tremors find them (`charge_spotted`),
  or their last 5 s (`chargePublicTime`). Keep any ONE Depths unit within one cell per axis (`defuseReach`) for 2 s
  in a row (`defuseTime`); leaving resets it.
- **Intruders.** The `intruder` alert (enemies seen in your tunnels near home: `count`, nearest x/y) calls the
  Wardens to wall at them and troopers to hunt; with none below, signal `troops`.
- **Rock hides.** Depths vision floods your tunnels and shows the walls beside them; it never sees through rock,
  not even into a tunnel touching yours only at a corner. A Warden or troopers waiting one wall away are invisible
  until a tunnel opens: hold chokes from round a corner, and expect the same at theirs (flare or scan first).
- **Gate breaches.** On `tunnel_breach` near home, queue a bulkhead on the breach cell (tunnels are never filled
  back), or `deploy` a Warden there until the gate stands. Sappers cannot dig; fortified rock stops them.
- **Cracks are the warning.** Dig damage stays in the rock and stacks across diggers; `cracks` lists the crack stage
  (1–4) last seen on damaged cells. Stages update only in current Depths vision; unseen walls keep their last-seen
  stage, not hidden digging or repairs. A crack flagged `enemy: true` holds enemy dig damage on a wall of your own
  tunnels (also a `wall_dig` alert): someone is digging in, so `fortify` it — that clears the damage and hardens it,
  and fortifying a fortified cell reinforces it (longer to dig, up to a cap). Repair faster than they dig and the
  wall holds.
- **Fortify is free and walls-only.** `fortify` hardens ROCK bordering your own tunnels (never a tunnel cell),
  time only by default (`rules.depths.fortifyCost` 0; 4 s per digger, twice as fast for a Warden). A finished gate
  fortifies the rock beside it by itself (`bulkheadFlankFortify`, one level); harden the next cells out and the
  walls of chokes so raiders cannot dig a wider loop round the door; a sapper blast strips it again.
- **Bulkheads.** `queue_add {item: 'bulkhead', x, y, digger?}` queues a gate on a tunnel cell (not rail); the team
  queue pays for it and your hinted digger (if idle or mining), else your nearest idle or mining digger, builds it. Your units pass, theirs are blocked as by rock until they
  dig through it, shoot it down or blow it with a charge next to it. Gate the cavern a few cells out from your root,
  your mining tunnels and the tunnels under holes near home.
  A gate only holds where it cuts the enemy's walk: a 1-wide choke whose cell severs the route, or every cell of a
  wider passage's cross-section. A lone bulkhead beside an open cell is walked around (the bots keep up
  to two: one choke, or a 2-wide cross-section, else none).
  Enemy bulkheads you have seen stay in your memory: dig through them with several diggers or bring a sapper.
- **Fortify your faults.** A chasm stops spreading at a fortified fault cell. The Depths bot protects
  the nearest known rock cell of each fault on your half within 12 tiles of home, two jobs at a time. It tags
  access beside the wall, then explicitly fortifies it; existing tunnels, ore and teammates' tagged walls stay intact.

## Wardens

Wardens are your fighter: `deploy` one (its shield wall, `on: true`) at a 1-wide choke before the enemy arrives, `flare` unknown corners before
advancing. Troopers in a walled Warden's cover shoot over it; the Surface seat sends them down a Shaft. Alone you hold; with troopers you push ([wardens.md](wardens.md)).

## Lode pockets

`lodes` remembers outcrops your team has discovered, not the whole map. When your Headframe
opens one (`lodes[].open`), tag an approach to the outside of its pocket, then send 2–3 diggers with explicit
`mine {x, y}` at the outcrop: the pocket is rich and the Headframe is its drop-off, so hauls are short.
Rich pockets normally lie on the flanks near `(5*size/6,size/6)` and its transpose, not in the central cavern; follow the observed
outcrop, not a guessed centre coordinate. Never tag a shortcut through pocket ore: dig in from beside and mine it.
Gate the approach against theft; an enemy-opened contested pocket is yours to steal too.

## Research

At your Depths segment (`research {upgrade}`, shared queue; topic research): **Drill Bits** (100/60, 25 s) digs
cells open in ×0.75 of the time — buy it once a real crew is digging; **Shaped Charges** (120/80, 30 s) cuts the
charge fuse from 10 s to 7 s and splits faults ±6 instead of ±4 — buy it before sapper waves. Either may be
switched off by the match (`rules.research.*Enabled`; then it is never in `research.available`).

## Offence

- **Breach raids.** When the surface seat sends a trooper squad down, tag an urgent approach under the enemy
  base if needed, then `breach` a reachable cell 7.5–11 tiles from their Spire (out of its beam) next to their
  Shafts or turrets, under open ground. Six seconds later the squad climbs out behind their army.
  They feel tremors where they have presence or vision: pick a quiet cell.
- **Faults.** `faults` cross the lanes. A charge under a fault cell on the enemy half deals the normal collapse
  damage, then opens a chasm (±4 cells, ±6 with Shaped Charges) instead of a sinkhole: it cuts their army off from
  the centre. A hole near your home (chasm, crater, sinkhole or breach)? `bridge` backfills it (30 alloy, 8 s per
  cell, from the tunnel next to the cell under it; `rules.depths.backfillKinds` says which kinds).
- **Sappers hit what stays put** (structures, turret lines, sieging tanks, gates, walls), not armies: charges take
  10 s (7 s Shaped) and enemies see them only through vision, tremors or the last 5 s. Stack up to three (400 → 800):
  a Headframe or Shaft needs two, a turret one; the blast strips fortification ([wardens.md](wardens.md)). A hole
  never empties the lode under a Headframe: fell it, or it keeps paying.
  Teammates ask with a `collapse` signal at a tile.
- **Sapper strike.** Tag an urgent corridor into the enemy pocket, then `undermine` with three sappers together on
  a cell within 2.5 tiles (`collapseRadius + collapseStructureReach`) of their Spire: they stack. Every Surface
  structure of any army that close takes the damage (keep your Shafts clear); defenders over open tunnel fall into
  yours (25% max HP; tanks and flak are wrecked, your kills). Their root shoots the first sapper: send three.

## Magma

Hidden pockets sit in the rock (often along the caverns). Ask the orbit seat to scan the centre early:
located pockets show as 7 and your diggers route around them; a flood burns depths units for a minute, then cools
back to open tunnel. Lava destroys what it reaches: crater ore (`oreCaches[].below`, event `cache_burned`) and the
load of any digger it kills, so collect crater ore beside a pocket first and keep laden diggers out. A unit caught
in a flood can still `move` out through the connected flowing magma (never into it from dry ground, never through a
located pocket): routes leave the lava by the fewest magma cells, so order flooded units to the nearest dry tunnel.

## Lava lakes, bridges and green ore

Generated maps have permanent lava lakes by default (`rules.map.lavaLakes`; code 11: burns like a flood, never cools,
hidden until seen) and green rich ore (`rules.map.richOre`; code 10, public from the start, `richLoad` alloy a load),
which usually sits behind a lava moat. Every home keeps a dry way to the centre: a lake is a shortcut, never a wall.

- **Bridge.** `bridge {x, y}` on a known lake cell beside dry ground builds a lava bridge (`lavaBridgeCost` alloy,
  `lavaBridgeTicks`); extend a span cell by cell, at most `lavaBridgeSpan` from dry ground. Dig to the shore first
  (the moat is hidden until a tunnel sees it). Bridge toward green ore once your home crew mines (the bots wait for
  six diggers); toward a tunnel target only when the span saves real digging. A bridge is paid like any direct cost:
  free funds plus your own lane's holds, so check that sum, not `freeAlloy` alone (it sits near zero while the
  other lanes save). A bridger that arrived unpaid stands idle at the shore: hold it there until the funds come
  rather than letting auto-mine take it, and one that went back to mining has lost its order, so send another.
- **Crew green ore** like a lode: a few diggers with explicit `mine {x, y}` on the rich cell (the bot keeps
  tier `richCrew`, 2–3), the rest on ordinary ore. Each load pays `richLoad` alloy against `oreLoad`, which is what
  the bridges across the moat buy.
- **Bridges are terrain anyone walks**, a `lava_bridge` structure enemies see only once their vision reaches it. A
  bridge falls to fire or to a charge within `chargeBridgeReach` (the cell is lava again, burning whoever stands on
  it): wall a Warden on the dry cell beside yours when armed foes come near; send idle troopers (or one sapper
  undermining the shore) against theirs before their raid crosses. When yours falls, the crew beyond it has no way
  home: let it mine elsewhere, wait out the raid (the bots hold every new bridge back for about 45 s), then bridge
  again or take the dry way round.

## Crater ore from below

A visible `oreCaches[].below` is a finite underground reserve. Move one free,
unladen digger whose own connected tunnel component reaches that exact coordinate and keep it standing there;
another digger or Shaft reaching it does not make it reachable by this worker. Collection is automatic,
not a `mine` order or a haul. Avoid visible enemy guards and leave most workers on ordinary ore.
