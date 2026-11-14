# Surface

Contents: army mix · ore caches · high ground and woods · turrets · the push · Shafts · Drill Yard and Breachers ·
Headframes and lodes · raids from below · breaches and holes. Placement and build radius rules are in `queue-and-teamwork.md`; terrain
presets in `map.md`.

## Mooring Towers

Build `queue_add {item:'mooring_tower',x,y}` at a visible, legal 2×2 Surface footprint (integer minimum corner):
100 alloy + 60 energy, 25 s, 400 HP, vision 7. Use Surface `moor {tower,island}` and `unmoor {tower}`.
One island per tower, no army cap; own/allied/hostile/neutral ownership is eligible and never changes.
Range 10: lower the island vertically at the same x/y over 3 s (`mooringTravelTime`), so ordinary islands
pass overhead; every ring is eligible. Lowering/held towers cost 3 energy/s, with only 3 s total unpaid/
power-loss grace, never replenished by power flicker. Release or destruction raises it into a safe gap
on its original delayed circle; only rejoin starts the 20 s island cooldown. Aircraft descend at a selected
lowered island and climb on departure; weather/fog stay planar. Defaults in `rules.surface.mooring*` are unvalidated.
The bot/example buys conservatively for a useful owned Relay, Aerie or Stormcatcher near home, only with
sustained surplus and 30 seconds of upkeep reserved. See [Sky](sky.md#storm-seeder-and-mooring-tower).

## Army

- Mix troopers and tanks (≈1:1 once energy flows) with a flak per 6 units against bombers and asteroids.
  Count telegraphed hostile `impacts` within 12 tiles of your structures as air threats (more flak), and park idle
  flak under the soonest marker on your Spire or a Headframe: the rock falls onto its marker, so flak there shoots
  it down on the way in. Flak and turrets cannot target Sky units or structures inside a storm unless your team
  scans the spot; flak hits gunships (`heavy_air`) ×1.25 (×1.5 other air), never island structures (a Surface
  bot asks the Sky to capture one near home).
- **Deploy** (`deploy {units, on}`; `game_briefing {topic:'surface/front'}`; each stance a match-rule toggle). Dig
  troopers in where you hold (×0.6 from rifles, cannons and turrets; breachers, bombs and drops ignore it); siege tanks
  just outside a turret ring (9 vs structures, 7.5 vs units, nothing inside 2: keep infantry in front); a Spire
  only from inside its beam (7 edge to edge, `siegeSpireRange`): the beam answers, so bring numbers;
  emplace flak under drop markers on your Spire and Headframes (9 vs the Sky, +2 and ×2 vs falling rocks). Any move
  packs them first (1–3 s): pack before the army moves, not as it moves. The Surface bot (`policies/game/bots/surface.js`) does this.
- **Sudden death** (22:00, `sudden_death` alert 60 s before): every Spire takes ×1.5 from everything but rocks and
  Orbit docks stop repairing. Push with the whole army; the bots and starters go from the countdown.
- **Race ore caches.** Move a healthy nearby unit inside a visible cache's radius and leave it there.
  Any army can collect; another army's presence contests collection, so do not assume the dropping army owns it.
  Send at most a small detachment to uncontested, connected ground, avoid scorch and incoming impacts,
  and keep the main army defending/pushing. The example reserves at most two collectors and a third of the army.
- **Hold the high ground and the woods.** High ground gives +1 range and +2 vision, sees over cliffs, and is
  invisible from low ground; forests hide your units (and their shots) until an enemy comes within 2 tiles. Hold your
  front and the centre on the nearest hills and forest cells, one cell per unit. Widen a sparse hold area rather
  than gathering on plain ground when the nearest ridge is just outside it; make the enemy walk into you.
  Cliffs block line of fire between low-ground cells; fords and forests slow movement.
- Attack in one block of 15+ units; `attack` the focused hostile surface Spire segment once fewer than three guards
  remain near your army (units shoot the nearest enemy while they walk). Regroup with `defend_spire` when
  the army falls under 40 %.
- **Early rushes.** An army that attacks at ten units arrives in the first half minute. When hostile fighters on your
  half outvalue your whole army, pull every squad back and stand at your Spire (its beam fights with you) instead of
  meeting them piecemeal forward; while your Spire is being hit, keep a fighter queued and move it first.

## Forward posts and contested points

- `matchData.posts` lists every post with its `kind` (off when `rules.surface.postsEnabled` is false). Home posts
  (`home` = whose) start yours: vision over cliffs, a build radius (turrets forward) and healing. Contested points
  (the map centre and one per flank lode) start neutral: take them with any Surface units of one alliance within
  `postCaptureRadius` for `contestedCaptureTime` (8 s; home posts 5 s). Hostile units on it together stop the capture.
- Race three troopers to the centre point in the first seconds (`attack` its id) and dig them in: it gives vision
  and healing (a shared `postHealPool`), no build radius, no income, and its held seconds break a Spire HP tie at the
  time cap. Fall back to any held post to heal; retake on `post_lost` or the `post_contested` alert. Send a squad
  whole, never one trooper at a time into the fight that killed the last, and pull it back when the hostile fighters
  at the point outvalue it. `macro recapture` sends the army to every post you do not hold. Topic surface/front.

## Turrets

- Two turrets on each side facing a hostile approach (inside your radius: no cannon rushes) stop early raids. Each turret costs 0.25 energy/s upkeep (`res.upkeep`);
  when the team runs dry, every turret goes offline. A turret ring does not hold forever: tanks out-range it, and
  bombers, asteroid drops and sapper collapses take it apart. Siege a ring the same way: three or more tanks shell
  the outer turret from just beyond its range while the rest of the army waits two tiles behind them.
- Focus a built turret with `attack {units: [turretId], target}` from its owning Surface seat. The target must be
  a currently visible Surface or Sky enemy; normal range, line of fire and upkeep still apply. Turrets never chase
  and cannot take move, patrol or stance orders. Spire beams remain automatic.

## Shafts

A Shaft toward the depths ore field (at your radius edge nearest it) shortens hauling for your depths seat, is a
second trooper transfer point and pushes your build radius out. Troopers sent down with `transfer` defend the root against sappers — watch `tremors`.

## Drill Yard and Breachers: break the line

A Breacher burns infantry out of foxholes. Build one Drill Yard (`queue_add {item: 'drill_yard', x, y}`, 2×2, at most
`rules.surface.drillYardMax` per team, placed like a Shaft) once you see dug-in Troopers or a turret line, then
`convert {units: [trooper ids], to: 'breacher'}`: the Troopers walk to the yard and go in one at a time; each comes out
a Breacher after `stats.breacher.build` s, paying `stats.breacher` alloy + energy when it goes in (it waits while you
cannot pay). Inside it is hidden and safe but cannot act; it keeps its HP fraction and queued orders. Lose the yard and
the Trooper inside steps out unconverted, its payment lost. Enemies who see the yard only see that it is working.
The flamer (range 1.8) deals ×1.5 vs light, ×`rules.surface.breacherDugInMultiplier` (2) vs a dug-in Trooper
(ignoring its reduction), cooks structures, and splashes a forward cone (`breacherConeArc`) past its target. Tanks
and Troopers out-range it: walk Breachers in behind the army, then `attack` the foxholes and turrets. They use portals
like Troopers. Off when `rules.surface.breachersEnabled` is false.

## Headframes are your economy

`lodes` lists discovered outcrops over sealed ore pockets; undiscovered lodes
are absent. Queue a Headframe (`queue_add {item: 'headframe', x, y}`) on each known home lode early, even before you can
pay for it: the shared queue funds in order, so a waiting entry holds its place while cheaper buys queued after it wait.
Any of its nine pocket cells snaps to the full 3×3 footprint; all nine must currently be visible. Outcrops stand on
plain ground or on a plateau top (outcrop and apron always on one level). A plateau outcrop is only seen from high
ground, the Sky or a scan, so walk a unit up the ramp before queueing; its Headframe and a turret beside it get the
high-ground bonuses and stay hidden from low ground. Value plateau lodes: build on them first and contest the
enemy's from the plateau, not from below. Read `rules.map.homeLodeMinRadius`,
`homeLodeMaxRadius`, `lodeSpacing` and `contestedZones`: each zone has `kind` (`flanks` or `centre`), `sets`
(one lode per map slot per set), `loads`, `minRadius`, `maxRadius` and `maxSkew`. On two-slot maps the default
rich lodes lie near `(5*size/6,size/6)` and its transpose, away from the main lane; on four-slot maps near each
edge midpoint between two corners (your two are `(size/2, size/6)` and `(size/6, size/2)` in the canonical frame).
A centre zone is optional. Scout the expected zones and their rims to discover the actual outcrops; a known
outcrop can suggest its rotated partners, not reveal them automatically. Three uncommitted ground fighters can
search quiet, walkable flank sweep points strictly nearer their own Spire than any hostile Spire, without waiting
for the centre-control army. Home threats, local threats and a defend directive veto that patrol; centre and
enemy-side searches still require the larger force. An empty safe search set means no patrol, not a hidden-site hint.
Once home posts are held, reserve that patrol's three uncommitted fighters before sending fresh replacements to
additional non-home captures. Existing post squads, current capture/healing orders and home-post recovery keep
their jobs; do not feed every arriving third fighter into the centre while two tanks wait forever.
Ordinary staffing/support requests and optional raids also leave committed post guards and the reserved lode
patrol on their jobs; explicit `defend`, actual miner defence and home emergencies can still interrupt those
commitments. Waiting for spare troopers or spotting an unguarded enemy economy is not an emergency.
Secure a rich outcrop with your army or a ground-fighting detachment before queueing its Headframe: one scout
or control of the centre is not control of the flank. A known quiet outcrop on your side needs a local holding squad,
not the larger army needed to contest the centre; leave post guards and home defence on their jobs. Once held and
visible, commit one Headframe even without spare alloy (`index: 0` funds it before optional buys). Keep fighters there
through construction, then route Depths miners in. Pocket loads have the normal mining rate; a larger reserve lasts
longer, not faster. Each Headframe is a drop-off and trickles alloy while ore remains. Raid enemy flank Headframes.
Its solid Surface footprint does not block the pocket below: miners can still approach, walk, mine and deliver
there. A Headframe is not a transfer point: troopers cannot `transfer` through it (use a built Shaft; never the
Spire or a hole). A collapse or crater over the pocket never empties it: only felling the Headframe stops it. Other Surface
structures cannot overlap any known lode pocket cell.

## Raids, breaches and holes

- **Keep a Shaft.** Own built Shafts are your only way down (`transfer`): not the Spire, not holes. Build one beside
  home early; a Shaft completed in rock is `sealed` until the depths seat digs to its landing.
- **Raid from below.** Send 4–5 troopers down (`transfer`) during the midgame build-up, before the main push spends
  them, so the depths seat has time to tunnel and breach beside enemy structures. The example starts at 3:00 and
  repeats every three minutes: a second front while your main army holds.
- **Troopers behind Warden walls.** Down there troopers are the Depths' ranged arm: they stand in a walled Warden's
  cover (×0.8 damage taken, +1.5 range) and shoot over it, where enemy Wardens (range 2) cannot reach them. Only you
  can send them: answer the depths seat's requests with `transfer` at a Shaft.
- **Meet their breaches.** A `breach: true` tremor near home is a squad digging up: fight-move onto that cell and
  shoot them as they climb out. A hole across your lane forces a detour until your depths seat backfills it (`bridge`).
- Holes are no portals for anyone: a breach lets its squad climb out once, never back down; a new hole drops the
  units standing on it where the tunnel below is open (troopers lose 25%; tanks and flak are wrecked) and the rest
  step off. On a `charge_under` alert move everything in its reach clear before `tick`, tanks first
  (the bots' `PlaneBot.stepClear` in `policies/game/bots/plane-bot.js` does this).
