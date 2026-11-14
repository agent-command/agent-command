# The team build queue and teamwork

Contents: shared queue etiquette · structure placement · build radius · research in the queue · rootless diggers.

## One bank, four production lanes

All four seats share the authoritative alloy/energy bank and `obs.queue`, but funding order is local to each
output plane. Shared resources never grant shared control. Every caller, including a human owner, uses an
authorized credential for that output role to queue its units, structures, research and rebuilds. A solo owner
routes through each owned role; a multi-role commander does the same. Never take over a human-controlled plane.
Ask teammates for support with existing [typed signals](signals.md).
`queue_add` structures use `x, y` for Surface sites, `x, y, digger?` for Depths sites, and `island` for Sky sites.

The next eligible normal commitment in each lane holds actual banked alloy/energy toward its cost. Only that
head is protected, not its whole future wishlist. Blocked heads receive no further allocation and retain existing
holds only for the configured blocked grace; idle capacity is reused. Producers still build in parallel.
The allocator does not create resources: normal progress needs
the required resource income or existing bank. Zero income cannot fund an unmet cost; a lost/busy/unpowered
producer, missing builder, unseen site or population cap can prevent eligibility. There is no global funding
priority or promised waiting ETA. Building progress describes work, not a promise about future funding.

Entries expose requester role `by`, controller kind `byCtl`, trusted `automatic`, status/reason, cost, progress,
`heldAlloy`, `heldEnergy` and `recovery`. Paid and non-head entries have zero held amounts and `recovery: false`.
`res.alloy`/`energy` remain actual bank totals. Use `res.freeAlloy`/`freeEnergy` for new spending: the server has
already accounted for total `heldAlloy`/`heldEnergy` and finite energy `upkeepHeld`. The separately reported
`recoveryAlloy`/`recoveryEnergy` are subsets of total holds. Never subtract waiting costs or these earmarks again.

- Keep your lane small (`rules.queue.seatMax` bounds each lane); count every queued entry of a kind to avoid duplicates.
- Commit the first desired expensive unit without waiting for surplus; preserve it while income accumulates.
  Cancel only your own impossible automatic plans, not a valid commitment merely because cheaper work could start.
- Depths must still submit a real authorized digger request. Below `rules.queue.recoveryWorkers` (default 2),
  the sim verifies live workers plus paid pending replacements and funds recovery separately. Zero-HP entities
  awaiting cleanup are not live workers; deduplicate all pending digger requests. While normal demand exists, recovery receives
  at most `rules.queue.recoveryFraction` (default 0.2); idle normal capacity can be reused. Queue position cannot
  manufacture recovery or override another lane. Growth above the minimum uses ordinary lane funding.
- Cancel/move authority stays on the requesting/output role regardless of caller source. Agents cannot mutate
  owner commitments; policies/bots mutate only their role's automatic entries, never explicit agent/owner work.
  Human changes also route through the owned output role, never another owner's credential or priority.
- `queue_add.index` and `queue_move {entry, index}` retain global array indices on the wire, but change only
  the entry's plane-lane order. Do not spam moves toward global index 0. A defence reorder must actually change
  local order and respect paid, explicit, rebuild and recovery protections. Explicit moves adopt automatic work.
  Changes emit `queue_added` / `queue_cancelled` / `queue_moved`.
- Human-only `queue_priority {entry}` is different from lane reordering: invoke it through the entry's authorized
  role. The host derives its current same-owner, human-authorized roles and reallocates only those lanes' holds.
  A human claim/delegation survives bot/agent handover; initial agent/benchmark ownership alone grants no human
  authority. Priority changes no ongoing weights and takes no other-owner funds. Never expose owner identifiers.
- Optional buffering, research and surplus structures use `ifAffordable: true`. Admission checks your role's
  spendable funds atomically (free funds plus your own lane's normal holds), including count and Shaft surcharge,
  and may return `cannot_afford` after a teammate claims free funds. Payment occurs at start. Omitted/false creates
  a durable future commitment, not free resources. Locally budget only new requests from this decision; the server
  resolves simultaneous spending.
- Cancelling before start releases held funds; started work refunds `rules.queue.refundStarted`.
- Direct purchases (rail, bridge, priced fortify, conversion, `airdrop`, `seed`, `scan`, `ascend` and abilities)
  use free funds first, then only your own lane's normal holds (never another lane's or recovery), which delays
  your own next entry. Upkeep is paid before holds and draws held energy once free energy runs out.
- Disabled items (`gunship` with `rules.sky.gunshipEnabled` false, `storm_seeder` with `seederEnabled` false)
  fail `queue_add` with `blocked`.
- Surface queues Troopers. For Depths reinforcements, signal `troops` to Surface; Surface can transfer them down
  at an own built Shaft. This handoff does not grant Depths Surface production.

## Structure placement

- Structure `x,y` inputs are integer **minimum cell corners**, not entity centres. Sizes are fixed registry data:
  turret/bulkhead/geothermal 1×1, Shaft 2×2, Headframe/Spire 3×3. Island structures (relay, aerie, storm_seeder,
  stormcatcher) are 1×1 Sky bodies queued by `island`, drift with it and never block the Surface.
  Turn a placement corner by your frame as a footprint centre (minimum corner + w/2, h/2), then subtract w/2, h/2 again;
  turn entity centres as points. Spire centres are in `matchData.armies[].spireAt` (every army, from
  `rules.map.spireInset`; default `nw` (3.5,3.5), `se` (44.5,44.5)); never hard-code them.
- Every Surface footprint cell must currently be visible and free of holes; leave one empty cell between known or
  queued footprints. **One level:** the footprint plus its one-cell apron must be all ground (0) or all high
  ground (3): never straddling a cliff edge or ramp, never touching forest, ford, fault, water or cliff. A structure
  on high ground gets +1 range/+2 vision and is unseen from low ground, like a unit there.
- Shaft sites also require no KNOWN bedrock beneath every cell (your team's Depths knowledge, `depths` code 1).
  A Shaft completed over unknown bedrock still stands, but its cell below stays bedrock: no tunnel opens there and
  troopers cannot transfer down through it.
- Queue observations keep centre coordinates. Structures block movement on their own plane; choose the
  loading apron beside the Depths root, not its centre, for rail staging and route origins.
  Seeing any occupied cell reveals a structure or lode even if its centre is hidden, but placement still
  requires all footprint cells to be visible. Remembered enemy footprints also reserve their known sites.

## Build radius

Shafts and turrets go only inside your build radius (`matchData.buildRadius`): the site's
footprint centre within `radius` of one of your own live, completed sources — Spire 12, Shafts 7, Headframes 7 by
default; turrets and sites still constructing project none. Headframes are exempt (any known lode). Nothing may
stand within `enemySpireNoBuild` (8) tiles of any hostile Spire footprint edge (armies still in play, not in
`obs.eliminated`). Failures are `out_of_radius` and `no_build_zone`, judged before visibility. Compute it yourself
from your own entities and `matchData.armies` (`(x-sx)^2 + (y-sy)^2 <= r^2` per source); hostile radii are never
shown. Build forward by taking a forward
lode: its completed Headframe projects radius for turrets and Shafts there. A queued site that has
not started is cancelled (`queue_cancelled` with `code: 'out_of_radius'`, nothing paid) if its covering source
dies; standing structures keep working. Killing an enemy forward Shaft or Headframe shrinks their radius.

## Research in the queue

- `research {upgrade: "ascent_thrusters"}` adds research to this same queue, with normal funding, cancel and reorder
  rules. Each segment researches one upgrade independently of its unit production. Destroying the researching segment
  removes its pending research; started research refunds `rules.research.segmentLossRefund` (default full cost).
- **Composition before research:** `matchData.upgrades` is the public, rule-priced research catalog:
  `{id, at, alloy, energy, units}`. `units` comes from the registry's beneficiary effects, not guessed upgrade names.
  Standard/veteran bots and the starters require enough beneficiary ships owned or queued across the team
  (current strategy minima: 2 Bastions, 3 Skiffs, 2 interceptors; other beneficiary kinds 2). New production
  intents count, but an empty or single-ship fleet does not justify an upgrade. Start with authoritative free
  resources and budget current-decision production plus the next desired unit before research. Do not subtract
  the global waiting queue or pre-fund a whole future fleet wishlist; either can starve useful technology.

## Rootless diggers

With the Depths root destroyed, the **Depths role** uses `queue_add {item: 'digger', producer: shaftId}` to produce
a digger in Depths at an own, completed **Surface Shaft**. The producer's location does not transfer production
authority to Surface. This is not available while the root lives. Each resource cost is
`ceil(rules.stats.digger[resource] * rules.economy.shaftDiggerMultiplier)` (default multiplier 1.5);
budget that surcharge for new requests; observed free funds already account for waiting entries' actual holds.
