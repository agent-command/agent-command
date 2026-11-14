# Spider Mech and Space Elevator: a late-game cross-plane chain

> **Design memo only.** Nothing here is built. Every
> claim about the game as it stood cites `docs/DESIGN.md` (§ and line) or source (`packages/game/src/...:line`). Numbers
> in **Proposed** tables are starting points for a sweep, not tuned values. No sweeps were run. §4.6 names the
> experiments that would measure them. `DESIGN.md` § and line citations point into the design doc as it then stood;
> it has since been rewritten (current: [DESIGN](../DESIGN.md), [ROADMAP](../ROADMAP.md)).

**The owner's pitch:** "you can build devastating spider mechs in space and build a space elevator on an island
and transport to the ground... all points would be potentially broken... tugs become builders as well... build it
and then ship it down the elevator... the spider mech could do some serious laser damage."

**Short answer.** The idea fits the game's pillars well. Very few of its parts are new:

- Sky→Surface column travel already exists (the airdrop transit).
- So do the following:
  - towable Orbit objects with public lift events (the derelict core);
  - fixed-position islands (Mooring Towers);
  - deploy stances (siege);
  - the shared hold-zone module behind posts.

These are the parts that are genuinely new:

- the **first Orbit structure** (a gantry);
- tugs that **crew construction**;
- a **big walker** unit with its own armour class;
- a **descent transit** that can be shot at while it travels and that aborts safely.

Every stage can be interrupted from at least two planes, using counters that already exist. That is a better
counterplay picture than most shipped features have.

**Verdict: post-launch.**

- Ship it first as an off-by-default rule (`rules.mech.enabled`). It then counts as Custom rules: unranked and
  outside the Standard guardrails (§2.4, line 108).
- Build it after the fresh baseline sweep (§12 Next, line 861).
- Build it after the first Orbit structure lands (the planned orbital capacitor, §5.2, line 406).

Reasons are in §6.3.

---

## 1. The feature as a cross-plane chain

The chain runs in five stages. Each stage is owned by one seat, and the seats hand off to each other:

**Orbit** assembles the hull → **Orbit** tows it to the cable head → **Sky** runs the elevator and the descent →
**Surface** owns the landing pad and the walker.

The Depths has no build role. It is the plane that can ruin the landing (§3).

### 1.1 Orbit: the gantry and tug crews

**What exists today**

- Tugs have the `tow` capability (`rules/stats.ts:168`). They grapple, tow, release and deorbit. They also
  mine rocks while latched (`mine_asteroid`, `rules/intents.ts:167-171`).
- No Orbit structure exists. Every `STRUCTURE_KINDS` entry sits on Surface, Sky or Depths
  (`rules/vocabulary.ts:77`). Solar arrays are units that use a deploy stance.
- The only planned Orbit structure is the orbital capacitor (§5.2, line 406).
- The derelict core is the model for a **towable, public, shootable Orbit object** (§4.4, line 328;
  `skills/.../planes/derelict.md`):
  - It tows at ×0.4 speed.
  - Leaving the hull publishes `coreLifted {tick, x, y, side}` and the alert `core_lifted` to every army.
  - Any Orbit weapon can shoot it while an enemy tows it.
  - It cashes in automatically within `dockRadius` (3) of the own segment.
- The `build` capability flag already exists. Only diggers have it today (`rules/stats.ts:97,154`). Several
  diggers can stack work on one job: dig damage belongs to the cell, and extra diggers join rails for free
  (§4.1).

**Two options**

| | **A. Home Gantry** (recommended) | **B. Derelict-style salvage** |
|---|---|---|
| Site | A new Orbit structure, `gantry`, queued in the Orbit lane. It is placed within `mech.gantryRadius` of the own Orbit segment. | A neutral **mech frame** regrows in the derelict chamber, like the core (`core_regrows` schedule). |
| Tug role | Tugs **crew** the gantry. Assembly progresses only while at least one own tug is latched within `mech.crewReach`, at `mech.crewRate` per tug, up to `mech.crewMax`. | Tugs grapple the frame through the open-gate windows and tow it home. The gantry then finishes it, or there is no gantry at all. |
| Reuse | Tow latch and crew stacking (the Mother Lode crew-per-cell pattern, §4.1). Segment beam and Bastion PD near home. | Nearly all the core code: grapple, `haul_core`-style macro, schedule, public lift. |
| Fairness | One per army. Every army gets the same home opportunity, and C2/C4 placement mirrors in the army's frame. | One frame for the whole map. Exactly symmetric (the centre is the only fixed point of C2 and C4), but **winner-takes-all**: the strongest Orbit fleet wins it. |
| New | The first Orbit structure: placement with no terrain, footprint in Orbit ORCA/steering, memory ghosts on Orbit, and the build-radius equivalent. | A second neutral object inside the ruin, with radiation and tie rules. |

Option A meets the wish that tugs "become builders". It is also not a pure lead amplifier. Option B is cheaper
if the Orbit structure groundwork is not ready, but it concentrates the mech in whoever already leads Orbit
(§4.5).

**The hull.** When assembly finishes, the gantry releases a `mech_hull`. This is an Orbit object with no
engine: it is towable like the core and has hull HP. A tug tows it to the **cable head**, which is the Orbit
column above the elevator island (same x/y, different altitude, §2 line 42). Docking happens automatically
within `mech.headDockRadius`, the same way the core cashes in automatically.

The tow is the Orbit stage's exposed moment. It uses:

- the existing escort formations (`formation: escort`, §4.4, line 329);
- the existing "shootable under tow" rule.

### 1.2 Sky: the Space Elevator

**What exists today**

- **Main build slot.** Each island has exactly one main build slot: Relay, Aerie, Stormcatcher or Seeder
  (§4.3, line 275). Island structures have `island` armour. Flak and turrets never target them by default
  (line 277; `sim/combat.ts:330-331`).
- **Captures.** A capture takes 12 s against a built main structure and drains it. Capturing destroys every
  attachment (line 273).
- **Drift.** Islands drift on fixed public rings (line 273).
- **Mooring.** A Surface **Mooring Tower** lowers an island 8 tiles at unchanged x/y and **stops its drift**.
  While moored, `orbitDelay++` holds it in place (`planes/sky.ts:219-221`). This costs 3 energy/s upkeep. When
  the tower is destroyed or power runs out, the island rises back (`sky.ts:227`; §4.3, line 278).
- **Planned advanced builds.** Skyspear and Siphon are listed as planned advanced builds behind Sky Spire
  tier 2 (line 302-305). Neither exists in code: there are no `skyspear` hits under `packages/game/src`.

**Proposal: `elevator` as a fifth main-slot structure** (`ISLAND_STRUCTURES`, queued in the Sky lane)

- **The cable is a column, not an entity.** It is drawn from the island to Orbit. The cable head is the Orbit
  point at the island's x/y.
- **Descent needs a moored island, and the tower must belong to the elevator's owner.** This is the key
  decision, for three reasons:
  1. **A drifting cable sweeps the map.** A descent from a drifting island would land wherever the ring carries
     it, possibly over an enemy base. DESIGN has already decided that an island pass over a base "must be a
     contest, not an execution" (§2.3, line 102).
  2. **Mooring fixes the landing zone for a long time, publicly.** The Depths and the enemy Surface can plan
     against a known spot (Pillar 5, line 27).
  3. **It gives the Surface a role before landing.** The Mooring Tower is a Surface structure. It needs the
     build radius (§6, line 449) and catches an island within `mooringRange` 10 (line 278). So the pad is in
     or next to own territory. That matches the planned own-territory rule for deliveries and relocations
     (§5.2, line 417; §8.1, line 613).
- **The elevator island is not covered by its own Sky beam.** At the default inset the outer ring's closest
  approach to the Spire is 8.99 tiles, which clears the Sky beam's 7.71 reach to a relay (§2.3 table, lines
  86-91). A home-side elevator therefore sits just outside its own Sky segment's beam.

### 1.3 Transit: descending the cable

**What exists today**

`TRANSITS` is a registry (`rules/stats.ts:46-87`). The `airdrop` entry (lines 82-86) is a timed Sky→Surface
column descent: `stationary: true`, `arrival: 'column'`, `telegraph: 'contrail'`, travel `aerieDropTravel`
(2 s).

While it travels, the unit stays on the `sky` plane. It cannot fire (`canHit` returns false for stationary
transits, `sim/combat.ts:75-77`), but it **is a Sky target**:

- Sky aircraft can hit it.
- Surface flak and turrets can hit it (they reach Surface→Sky; `canHitPlane`, `stats.ts:329-336`).
- The **Lancer Lens** can hit it, because the Lens beams Sky *units* (`combat.ts:336-337`).
- Bastion point defence cannot, because it hits the Sky only against payloads (`combat.ts:341`).

In the code that is exactly the "Skyspear / Lancer Lens strike during the descent" the owner asks for, minus
Skyspear.

**Proposal: a new `TRANSITS.elevator` entry**

```ts
elevator: { from: 'sky', to: 'surface', kinds: ['spider_mech'], cost: { alloy: 0, energy: 'mechDescentEnergy' },
            prep: 'mechDescentPrep', travel: 'mechDescentTravel', stay: 0, cooldown: 0,
            telegraph: 'contrail', arrival: 'column', stationary: true }
```

The registry entry and its lifecycle are reused: `startTransit`, `updateTransits`, `arriveTransit` and the
observation `transit {to, at, until}` (§8.1, line 607). These parts are **genuinely new**:

1. **A docking hand-off from Orbit to Sky.** The hull docks at the cable head in Orbit and becomes a
   `spider_mech` on the Sky deck. It is still stationary and still a Sky target. This is an Orbit→Sky step,
   which is adjacent (Pillar 2). It is **not** a second Orbit→Surface skip: the mech crosses each plane
   boundary over a structure the next plane owns. DESIGN §3 (lines 151-156) still needs a line saying so.
2. **Abort rules.** These are what "cutting the cable" means:
   - The elevator is destroyed or captured mid-descent, or the island un-moors. The mech then makes a **hard
     landing** at its column x/y: fall damage `mech.cutFallDamage` (proposed ×2 the 25% `surface.fallDamage`),
     plus `mech.cutStun` seconds unable to move or fire.
   - Before descent starts (hull docked, prep running), the same events eject the hull back into Orbit at the
     cable head. It is towable again.
3. **Re-checking the landing cell at arrival.** Today a column arrival sets the plane without checking the
   ground (`planes/transit.ts:108`). Airdrops check `block`/`holes` only at launch
   (`agent/intents.ts:274-275`). A 3×3-body walker needs an arrival rule. A hole under the pad at arrival
   means the mech falls into the Depths (§3.4).
4. **Telegraph content** (§3.6): a public schedule entry and alert, not just the contrail.

DESIGN already lists "configurable travel targetability" as planned transit work (§8.1, line 608). The
descent is its first real customer.

### 1.4 Surface: the walker

**What exists today**

- **Siege, the deploy stance.** Tanks siege for reach 9 against structures and 7.5 against units, with a 3 s
  setup and pack (§4.2, line 253). This runs on the generic deploy registry (`rules/deploy.ts`, line 248).
- **Edge-measured beams.** The Spire beam measures from its footprint edge, so no bearing out-ranges a segment
  (§6, line 445). Sieged tanks against the Spire are deliberately held to `siegeSpireRange` 7 so that "the beam
  always answers" (§2, line 40).
- **The `beam` weapon.** It already exists: ×1 against every armour class except `small` (`stats.ts:30`).
- **No walker yet.** There are no walking or legged units. Surface movement is flow fields with terrain costs
  (§6, line 444).

**Proposal: `spider_mech`, a Surface unit**

| Property | Proposed | Reuse / new |
|---|---|---|
| Armour | A new class `heavy`: cannon ×1.0, bomb ×1.0, rifle ×0.3, turret ×0.5, flamer ×0.25, beam ×1, missile ×1, flak ×0.5, point_defence ×0.1 | **New** `DAMAGE_VS` row. The table is fixed by contract, not a rule (§2.1, line 54), so this needs a code change and a design-doc line. |
| HP / speed / body | 4000 HP, speed 1.2, body radius 1.0 | Stats area: match rules automatically |
| Mobile weapon | `beam`, 25 dmg / 1 s, range 6, Surface targets only | `beam` weapon, `fixed` mount |
| **Braced** (deploy stance `braced`) | 3 s to brace, 3 s to pack, cannot move. Heavy beam 80 dmg / 2 s with a 1-tile line pierce. Reach 9 against structures and units, **capped at `spire.range` against Spire segments** (a validated rule, as `orbit.deorbitRange` is validated against beam reach, §4.4, line 359). | Deploy registry (reach, minimum range, damage taken, fires). Pierce reuses the sun-lance swept-path code (§8, line 595), moved to the Surface. |
| Movement | Ordinary Surface nav. **No** cliff-walking in the first version. | A "spider" that climbs cliffs would be a new movement class across flow fields, ORCA and the client: deferred. |
| Plane reach | Surface only. Optional rule `mech.beamReachesSky`: the braced beam also hits Sky targets in reach, which includes the **Sky Spire segment** at the same x/y. | `canHitPlane` already permits Surface→Sky (`stats.ts:335`). |

The proposed armour row keeps the existing counters honest:

- Tanks (cannon) and bombers answer the mech.
- Rifles and turrets are poor against it.
- Flamers are almost useless against it.

That is the readable "bring anti-armour" message (§3.5).

### 1.5 Reuse vs new, at a glance

| Stage | Reuses | Genuinely new |
|---|---|---|
| Unlock | Upgrade registry `unlock` effect (§8, line 524). `research.enemy` reveal. | One new upgrade id (`orbital_gantry`). |
| Gantry | Queue lanes. `structureCap`. Segment beam/PD near home. Fog memory. | **First Orbit structure** (shared groundwork with the capacitor). Tug `crew` work. |
| Hull tow | Grapple/tow/escort. Public lift like `coreLifted`. Enemy tows shootable. | A towable `mech_hull` kind. Auto-dock at the cable head. |
| Elevator | Island main slot. Captures. Mooring hold. Upkeep. Storms/forecast. | `elevator` structure. "Moored by own tower" requirement. |
| Descent | `TRANSITS` lifecycle. Stationary Sky-plane travel. Sky/flak/turret/Lens targeting. | Orbit→Sky hand-off. Abort/hard landing. Arrival cell re-check. Public schedule entry. |
| Walker | Deploy registry. `beam` weapon. Flow fields. Hold-zone module. | `heavy` armour. Pierce on the Surface. Post-breaking aura. Walker art. |

---

## 2. What "all points would be potentially broken" should mean

Read literally, "broken" means unstoppable. That would break three hard rules:

- Pillar 3, every threat is telegraphed and countered (line 26).
- The Spire-always-answers invariant (lines 40, 445).
- The balance rule that every counter lives on another plane (§11, line 777).

The wish maps instead onto three counterable effects, all tied to one unit that can only be in one place.

### 2.1 The mech breaks posts and contested points it stands near

Posts and contested points run on the shared hold-zone module (`planes/capture.ts`). Each tick the module counts
every army's capturing units inside the radius into `holders`. One alliance present gives a claimant. Hostile
alliances present together freeze the zone (`contested`). A `blocked` flag freezes a hostile claim (the island
Gun Platform uses it, `capture.ts:62-76`).

Posts give their holder (§4.2, line 232):

- vision 7;
- a home-post build radius of 7;
- a capped heal pool of 12 HP/s;
- for contested points, `postScore` 1/s, the last time-cap tiebreak.

**Proposal: a "Breaker" aura.** A living mech within `mech.breakRadius` (proposed 4, larger than
`postCaptureRadius` 2.5) of a post does two things:

1. **Freezes the zone for every other alliance.** It sets `blocked` for hostile claimants and `contested` for
   the holder. Capture progress stops.
2. **Suspends the holder's post benefits** while the mech stays: no heal pool, no post vision, no build radius,
   no `postScore`. Structures already standing outside a shrunken radius keep working (`stats.ts:302-309`), so
   breaking a post never deletes buildings.

The mech also **counts as `mech.captureWeight` holders** (proposed 3) for its own army. It can take a point
alone, at the normal capture time.

This is counterable for four reasons:

- It breaks one area at a time. The 3 points on C2 and 5 on C4 (line 232) cannot all be broken at once.
- It must stand there, within reach of tanks and bombers.
- Posts are never damaged (line 232), so the effect ends the moment the mech dies or leaves.
- The holder's capture state survives. The holder does not have to retake the post afterwards; it only waits
  out the freeze.

### 2.2 The braced beam out-ranges turrets (but not the Spire)

The guardrail "tanks out-range turrets" uses these ranges (line 227):

- a flat turret reaches 7.6 from its centre to a unit's edge;
- a turret on high ground keeps 8.6;
- a sieged tank reaches 9 against structures.

The braced mech matches the sieged tank at **9 against structures and units**. That out-ranges every turret and
keeps the plateau niche honest: a high-ground turret still out-ranges the *mobile* mech (6).

Against Spire segments the mech is capped at `spire.range` (7, edge-measured), which keeps the invariant "no
bearing out-ranges a segment". The Spire beam (30 dmg / 1 s, `stats.ts:177`) answers the mech in full, since
beam ×1 applies to `heavy`.

### 2.3 It threatens Spire segments

- **Surface segment.** It takes braced beam damage. In sudden death that damage is ×1.5, because the mech is not
  rock-borne (§2, line 39; `match-rules.ts:494`).
- **Sky segment**, only if `mech.beamReachesSky` is on. Under the crowns rule (§2, line 36) that is one crown
  from a second angle. This is the strongest "all points broken" lever, so it should start **off** and be
  measured (E5).
- **Never Orbit or Depths.** Those planes are not adjacent to the Surface by weapon (Pillar 2).

**Starting arithmetic (unswept):**

- *Mech alone at a Surface segment.* The braced beam does 80 dmg / 2 s = 40 DPS, ×1 against `structure` with
  `beam`. Against a 7,000 HP segment that is 175 s, or ~117 s in sudden death. The Spire returns 30 DPS, so a
  4,000 HP mech lasts ~133 s. **A lone mech loses to a lone Spire.** It is a siege multiplier that needs an
  escort, not an army in one unit.
- *Ten tanks against the mech.* Each tank does 30 per 2 s at ×1.0 = 15 DPS, so ten do 150 DPS. The mech dies in
  ~27 s. That is 1,350 cost-equivalent of tanks, against a mech whose chain costs ~2,500 (§4.2). It is "serious
  laser damage" and still clearly answerable.

---

## 3. Counterplay at every stage, on every plane

DESIGN §11 rule 1: "Every counter lives on a different plane than the threat it answers" (line 777). The table
lists, for each stage, the planes that can interrupt it and whether the tool exists today.

| Stage (owner) | Orbit | Sky | Surface | Depths |
|---|---|---|---|---|
| **Gantry assembly** (Orbit) | Lancers/Skiffs raid the gantry and kill crew tugs (light armour, rifle ×1.25, line 325). Sun lance pierces the gantry and tugs (×0.5 vs structures). **Exists.** | Ascent raiders hit tugs and the gantry (line 564). **Exists** (research). Skyspear straight up at the gantry, **planned D**. | Scan reveals progress (`scan`, all planes). **Exists.** | — |
| **Hull tow** (Orbit) | Shoot the towed hull (the enemy-towed-core rule). Intercept with Skiffs on the tow lane. **Exists (pattern).** | Ascent raids on the tug. **Exists.** | — | — |
| **Elevator build/hold** (Sky) | Lancer Lens kills the Sky screen guarding the island (line 352). **Exists.** | **Capture the island**: 12 s with a built structure, which destroys the elevator (line 273). Interceptors and gunships on the structure. A Gun Platform or mortar on the hardpoint blocks a capture until destroyed (line 276). **Exists.** | **Kill the Mooring Tower** (400 HP, `stats.ts:180`): the island rises and descent is blocked. **Moor-jack**: an enemy tower catches the elevator island while it is un-moored (any visible island is eligible, line 278). **Exists.** | **Sapper collapse under the Mooring Tower**: a 400 HP tower falls to one 400-damage charge (`cross-plane.md:27`). **Exists.** |
| **Descent** (Sky) | **Lancer Lens** beams the descending mech, a Sky unit, within 1.5 tiles horizontally at ×0.5 (`combat.ts:336-337`). Skyspear, **planned D**. | Interceptors and gunships shoot the stationary Sky unit. **Exists.** The enemy Sky segment beam hits it if the column is within 7. **Exists.** **Storms** (below). | **Flak** (emplaced reach 9 against the Sky, line 254) and **turrets** shoot it (Surface→Sky). **Exists.** | — |
| **Landing** (Surface) | Rock drop on the public landing marker (pebble 4 s, medium 8 s warning, line 342-345). **Exists.** | Bombers and the Island Mortar (60 dmg, splash 2.5, line 280) on the pad. **Exists.** | Pre-positioned sieged tanks on the pad during `mechLandingDeploy`. **Exists.** | **Sinkhole or chasm under the pad**: the mech falls into the Depths (§3.4). Breach squads behind it. **Exists (rules), new (big-body fall).** |
| **Walker** (Surface) | Rock drops on a braced mech, which cannot dodge. Scans keep it visible. **Exists.** | Bombers (×1.0 vs `heavy`). Relay vision on it. **Exists.** | Tanks (cannon ×1.0). Flank under the braced minimum range. Retake posts once it leaves. **Exists.** | Chasms cut its route (impassable, line 195). Charges against it while it is braced and holding still. **Exists.** |

### 3.1 Orbit hits the gantry

The gantry sits within `mech.gantryRadius` of the own Orbit segment. The segment's beam and point-defence battery
(3.5 / 6 / 0.2 s, line 327) cover it, but raids are deliberately cheaper than sieges: "Raiding exposed economy is
cheaper than sieging the segment" (line 327). Crew tugs are the soft target. Killing them **pauses** assembly
without destroying progress, the way a digger leaving keeps its progress in the rock (line 189). The defender then
chooses between re-crewing and the tugs' mining income. That trade-off is the Orbit decision.

### 3.2 Sky captures the elevator, bombs it, or cuts the cable

- **Capture** is the clean, full counter: it destroys every attachment.
- **Bombing.** Bombers cannot reach the Sky. "Bombs" here means air units hitting the island structure with
  interceptor missiles (×0.75 vs `island`) or gunship rifles.
- **Cutting the cable** is the abort rule (§1.3): destroy or capture the elevator, or kill the Mooring Tower,
  while the mech is in the column.
- **Storms block descent.** A *start* rule: `descend` fails with `storm` while the island is inside a current
  natural or seeded storm cell at strength ≥ `mech.stormBlock` (proposed 0.5). Storm lifecycles and forecasts
  are public (line 288), so the window is plannable (Pillar 5). An enemy **Storm Seeder** within 7 of the
  elevator island can deny a window: it has a 3 s public telegraph, lasts 30 s and has a 75 s cooldown
  (line 300).
- **Storms during a descent.** Under today's rules a storm that grows over a descent already in progress
  *conceals* the mech from flak, turrets and Orbit (line 285). Sky-to-Sky fire is not concealed. Keep that
  consistency. Do not make storms a special case for the mech.

### 3.3 Skyspear or Lens during the descent

The Lens works today against a Sky-plane stationary unit. To use it, a Lancer must hold the Orbit column within 1.5
tiles of the cable. That is also where the hull docks, so the cable head becomes an Orbit fight before and during
descent. Skyspear (line 302) is planned for Sky tier 2. If it ships, it fires straight up at Orbit units, which
means the gantry, the hull under tow, or Lancers guarding the cable head. The Skyspear is not a prerequisite;
the Lens and flak already cover the descent.

### 3.4 The Depths under the landing zone

The pad is the moored island's x/y: fixed and public from the moment the descent is announced (§3.6). The Depths
can:

- **Undermine the pad.** A charge is fogged until its last 5 s (`chargePublicTime`, line 193). A sinkhole opened
  under the mech's body drops it into the Depths with 25% max-HP fall damage (`cross-plane.md:49-50`).
- **Open a fault chasm** across its route. Chasms are impassable and need backfill: 30 alloy and 8 s per cell
  (line 196).
- **Breach** troopers out behind a braced mech (line 194).

**A decision this forces.** What happens to "Surface vehicles that fall into the Depths" is an open plan decision
(§12, line 867). The suggestion there: "stranded and crippled". For the mech, stranded and crippled is the right
answer: it cannot climb back, its beam is useless in tunnels, and Wardens and troopers grind it down. It makes
the landing a real Depths target, so the Depths gets a hero moment in a Surface story. Decide this before the mech
ships.

### 3.5 Surface anti-armour after landing

Tanks (cannon), bombers and rock drops are the answers, chosen by the `heavy` row. The braced stance costs 3 s to
pack, and a minimum range (proposed 2, as for siege) gives flankers a blind spot. Rifles and turrets are poor
against it, so a turtle cannot ignore it. That is the "bring anti-armour" read. Post-breaking ends as soon as the
mech leaves or dies (§2.1).

### 3.6 Telegraphs: a readable public event

Everything below would be **public by rule**. That is fog-safe as long as only the declared fields travel: a
public schedule leaks nothing hidden when the rule makes it public, as with `derelict_open`, `sudden_death` and
impact markers (§7, line 500-504; `rules/observation.ts:604`). Each item needs a twin-world test (§7, line 508).

| Step | Who sees | Content | Proposed timing |
|---|---|---|---|
| Research `orbital_gantry` done | `research.enemy` once an effect is observed (§8, line 512) | — | 30 s research |
| Gantry placed | **Public** event `mech_gantry` + minimap stamp, like the Awakening's start stamp (line 537) | army, x, y | — |
| Assembly | Fogged progress; **public** stage ticks at 50% and 100% | `progress` to own and allies; others by scan | `mech.assemblyTime` 90 crew-seconds |
| Hull lifted from the gantry | **Public** `mechLifted {tick, x, y, side}` + Orbit alert, like `core_lifted` | position needs vision afterwards | tow ×0.4 |
| Docked; descent prep | **Public schedule** `mech_descent {tick, until, x, y}` + alert `mech_descent` on **every plane** + HUD/observer banner + the alert chirp (as for sudden death, line 39) | landing x, y and tick | `mech.descentPrep` 20 s |
| In the column | Contrail (existing `telegraph: 'contrail'`) + public landing marker, like an impact marker | — | `mech.descentTravel` 12 s |
| Landed | Public event `mech_landed` | — | `mech.landingDeploy` 3 s before it can move or fire |

From the hull lifting off to the first beam shot, the warning is at least ~35 s plus the tow. That is longer than
a large rock's 12 s (line 345), in keeping with the payoff.

---

## 4. Balance and gating

### 4.1 Unlock timing

| Option | Pro | Con |
|---|---|---|
| **Research** `orbital_gantry` at the Orbit segment (upgrade registry `unlock`, §8, line 524) | Fits shipped research. Refunded if the segment dies. A readable signal. | Alone it allows an early mech rush. |
| **Time gate** `mech.unlockAt` (proposed 12:00) | Public and symmetric. Keeps the target band (10–15 min, line 44) intact for matches that end on time. | Arbitrary. A stalled match at 12:00 is often already decided. |
| Spire tier 2 (planned D, line 532) | The intended home for "advanced" content. | Not shipped: blocks the feature on D. |
| Sudden death (`suddenDeathAt` 22:00, line 39) | Clear late-game identity. | Too late: the chain takes ~3 min, so the mech would land ~25:00 against a 30:00 cap (line 37). Redundant with sudden death, which already "ends long matches". |
| Crowns: unlock or discount after losing a crown | A comeback tool (Pillar 6). | Under the default `surface` loss rule a crown is the whole game. Under crowns it rewards losing a side segment, an exploit to hunt. |

**Recommendation: research plus a time gate.** `research` can be queued from `mech.unlockAt − researchTime`, and
the gantry can be placed from `mech.unlockAt`. The time gate appears as a public schedule entry
(`mech_unlock`).

The mech then fills the gap between "matches should end" (~15:00) and sudden death (22:00). Recorded medians
show matches do run there: combined-b2 veteran 22.9 min (line 789); the mounts check had 27 of 36 matches still
running at a 20 min cap (line 483). Whether that gap still exists on today's build is exactly what the
outstanding fresh baseline sweep (line 861) must show first.

### 4.2 Cost through the shared economy lanes

There is one bank with four output-plane lanes. Only each lane's head holds funds, and direct spends use the free
bank plus the acting seat's own lane holds (§5, lines 420-434). Split the cost so that **all three upper lanes
pay**:

| Piece | Lane | Proposed | Note |
|---|---|---|---|
| Research `orbital_gantry` | Orbit | 200 alloy + 150 energy | Research slot, not the unit slot |
| Gantry | Orbit | 300 alloy, 800 HP, 2×2 | Counts toward `structureCap` |
| Hull assembly | Orbit, **paid per crew second** like rails per cell (§4.1, line 186) | 900 alloy + 500 energy total | Avoids a 1,400-cost queue head that stalls the Orbit lane for minutes. Pauses when unpaid. |
| Elevator | Sky | 250 alloy + 150 energy, upkeep 2 e/s | The same upkeep pool as Aeries (line 284) |
| Mooring Tower | Surface | existing 100 alloy + 60 energy, 3 e/s while moored | Already shipped |
| Descent | Sky, direct spend like `airdrop`/`seed` | 100 energy | |

The total is about 1,850 alloy + 960 energy, roughly 3,300 cost-equivalent at alloy + 1.5 × energy (the tank's
convention, `stats.ts:157`). For comparison:

- the Spire Awakening is ~600 + 400 (line 536);
- a segment rebuild is 400 + 200 (§5.1, line 399).

Against a healthy main economy of 15–20 alloy/s (line 384), the mech is roughly 1.5–2 minutes of alloy.

### 4.3 Limits and caps

- **One per army**: `mech.max` 1, counting the gantry's hull, the hull in transit and the walker. Plus
  `mech.rebuildCooldown` (proposed 180 s from death) and `mech.perMatch` (proposed 2). This mirrors
  `spire.rebuilds` (line 399) and the `drillYardMax` style (`production.ts:458`).
- **`popCap` 160** (`econ.ts:664`). Do not add pop weights. The per-plane supply memo measured bots peaking at
  44/160 and never waiting on `pop_cap` (`per-plane-supply.md:18-19`), so a pop weight would be cosmetic. The
  mech counts 1 like every unit (`ArmyState.pop`, `per-plane-supply.md:36-40`).
- **`structureCap` 30** (`econ.ts:665`). The gantry, the elevator and the tower each count 1. The cap includes
  sites, and the Gun Platform already shifts pop into structures (`sky.ts:152-159`).

### 4.4 Sudden death

- The mech's beam on segments gets the ×1.5 (it is not rock-borne). That is intended: it is a closer.
- The Orbit segment stops repairing docked ships in sudden death (line 39). That weakens the gantry defence late,
  which is fine.
- **Proposal:** the descent is blocked from `suddenDeathAt − suddenDeathWarning` *unless* the hull docked
  earlier. This prevents a 21:59 descent that nobody can plan against while every seat is already pushing.
  Measure it (E4) rather than assume it.

### 4.5 FFA, 4-army fairness and snowball vs comeback

- **Symmetry.** Option A gives every army the same home opportunity:
  - gantry near its own segment;
  - islands one per slot per ring (line 273);
  - towers within its own build radius.

  Placement is player-chosen, so C4 exactness is a bot and policy duty, as for every structure: rotate the plan
  by frame (`armies.md:13-20`). Same-tick ties (two descents, two mechs on one post) use the sector-relative order
  the hold-zone module already uses (`capture.ts:33-44`).
- **Snowball risk.** A 3,300-cost item is affordable first by the leading economy. Mitigations:
  1. It is answerable at its cheapest stage. Killing a 400 HP Mooring Tower or capturing an island costs far
     less than the chain.
  2. It lands in the builder's own territory (§1.2), so it must walk across the map.
  3. A lone mech loses to a lone Spire (§2.3).
- **FFA kingmaking.** In FFA, "expect the survivors to come for whoever is strongest" (`armies.md:45-46`). The
  public descent banner tells *both* neighbours. Veteran bots already avoid feeding the strongest visible army
  (`leaderPenalty`, `bots/tuning.ts:172-175`). A public mech should feed that heuristic.
- **Comeback.** Do not build in a crown discount (§4.1). Pillar 6's comeback here is the *counter*: a trailing
  army that kills a mech in the column has burned the leader's ~3,300 for the cost of a Lens pass or a flak line.
  Report mech kills by stage (E3).

### 4.6 Novice vs veteran bots

The tiers differ in think period: novice 4 s, standard 1.5 s, veteran 0.5 s, and queue depth 1/2/2
(`bots/tuning.ts:203-357`). The guardrail is veteran beats novice ≥ 80% (§11, line 781).

| Tier | Builds | Counters |
|---|---|---|
| Novice | Never | Passive only: Spire beam, auto-firing flak and turrets, auto-intercept does not apply (it is not a rock). Must still fight a landed mech with its normal army. |
| Standard | Fixed timing: research at unlock, 2 crew tugs, descent on the first storm-free window | Fires at the public descent with its flak, Lens Lancers sent to the column, Sky capture order on the elevator island. Tanks focus the walker. |
| Veteran | Times the descent against the storm forecast and the enemy Lens. Escorts the tow with Bastions. Moors over a site its Depths has fortified. | Picks the cheapest stage: tower snipe, moor-jack, a charge under the pad. Leader penalty against the builder. |

Every number that would need a sweep: `unlockAt`, all costs, `assemblyTime`, `crewRate`/`crewMax`, hull HP,
`descentPrep`, `descentTravel`, `stormBlock`, `cutFallDamage`, mech HP, speed, both beam rows, `breakRadius`,
`captureWeight`, `rebuildCooldown`, `perMatch`, the `heavy` armour row, and `beamReachesSky`.

**Named experiments** (all A/B with `mech.enabled` on/off; ≥ 20 seeds per tier and side, §11.3; C2 duel and C4
FFA; S48 and M64):

- **E1 Paired baseline.**
  - Side bias per mirror.
  - Median length (target 10–15 min unchanged or shorter).
  - Veteran vs novice ≥ 80%.
  - Per-plane Spire-damage share by plane of origin (no plane > 60%, line 875). Count mech damage as Surface,
    and also report it separately.
- **E2 Forced probe `mech-rush`** (a new `tools/balance/src/probes.ts` entry). Every seat spends on the chain from
  unlock; win rate ≤ 65% against its tier (line 781).
- **E3 Counter attribution.** Where mechs die, by stage and plane: gantry, tow, elevator, column, landing,
  walker. Target: no single stage > 60% of kills, and at least three planes credited.
- **E4 Descent survival.** Survival against Lens/flak density and storms. Check the sudden-death descent block.
- **E5 Post-breaking and the Sky beam.** Contested-point seconds, tiebreak flips and crowns lost, with
  `beamReachesSky` off and on.
- **E6 FFA rank distribution.** Builder vs neighbours: does building the mech raise rank 1 share beyond the
  guardrail, and does the leader penalty engage?
- **E7 Performance.** Sim ms/tick with mechs alive (well under 2 ms budget noise, §14). Client frame time of the
  cable render across planes on the phone tier.

---

## 5. Fit with the goals

### 5.1 Plane identity and teamwork

- **Each plane keeps its verb.**
  - Orbit: logistics and towing. "Logistician with a doomsday button" (line 318) finally builds the button.
  - Sky: holding and timing an island against drift and storms (line 269).
  - Surface: holding ground. The mooring pad, then the escort.
  - Depths: reshaping the map under the pad.
- **It needs all three upper planes.** No seat can finish the chain alone:
  - Orbit builds and tows;
  - Sky holds the island and triggers the descent;
  - Surface moors the island and commands the walker.

  That is the "Warden + trooper combo" principle (line 183) at match scale: the reward for cooperating, here also
  a requirement. Signals already carry the asks: `defend`, `request_support` (§9.2). A new signal kind
  `mech_window` (Sky → Orbit: "dock now") would be the one addition.
- **Risk to watch.** A feature that requires three seats punishes armies with a `none` or weak seat. That is by
  design (Pillar 1, "Too much for one human"), but it widens the gap between full-commander and partial armies.
  Report it in E1 by seat composition.

### 5.2 Spectator and Director appeal

It is a natural "event" moment: a public countdown, a fixed landing spot, a fight in a column across two planes,
and a hero unit.

The Director already ranks public telegraphs and urgent events (`apps/web/src/observer-director.ts:125-149,
365-371`):

- Add `mech_descent` as a telegraph that builds like falling-rock markers (`AHEAD_S` 8 s).
- Add `mech_landed` and `mech_destroyed` as urgent events (weight comparable to `crown_lost` 40 / `lode_erupted`
  20).
- Add the hull lift at core-lift weight 10.

The plane dive (×0.85 cost) suits a Sky→Surface descent shot.

The Featured playlist's rules showcase (§2.4, line 116) can feature a "Titans" preset with `mech.enabled` on,
without touching Standard guardrails.

### 5.3 Agents and policies

| Surface | Additions |
|---|---|
| Intents | `queue_add {item:'gantry', x, y}` (Orbit; Orbit-plane placement is new); `crew {units:[tug], gantry}` / release via existing `release`; reuse `grapple` on `mech_hull` (+ macro `haul_mech` like `haul_core`); `queue_add {item:'elevator', island}` (existing island path); `descend {elevator}` (Sky); mech control via existing `move`/`attack`/`deploy {on}` (Surface). Errors: `not_moored`, `storm`, `mech_limit`, `locked` (time gate). |
| Observation | Own: gantry `progress`, `crew`; hull HP; elevator `ready`. **Public:** `mechs[] {army, stage, x?, y?, tick}` (like `coreLifted`, `observation.ts:608`); schedule kinds `mech_unlock`, `mech_descent` (`SCHEDULE_KINDS`, `observation.ts:604`); alert `mech_descent` (`ALERT_KINDS`, line 640); events `mech_gantry`, `mech_lifted`, `mech_descended`, `mech_landed`, `mech_destroyed`, `mech_cut`; `posts[].broken`. The observation cap stays 128 KiB (§2.1, line 52); these are small. |
| Briefing topics | `cross-plane/mech` (the chain and its counters), `orbit/gantry`, `sky/elevator`, `surface/mech`, `intent/crew`, `intent/descend`. Skill: a new `mech.md` plus checklist lines in `SKILL.md` for Orbit, Sky and Surface. |
| Policies | All four example policies (`skills/.../policies/*.js`): Orbit crew/tow, Sky descent timing, Surface pad and walker, Depths "charge the pad". The per-call 25 ms sandbox budget applies (§12, line 840-852). |
| Bench | Every intent, schema, doc and policy change re-pins `bench/surface.ts` (`pnpm bench:pin`). Results across a pin are not comparable (§15.9, line 1179). That applies even with `mech.enabled` off by default, because the schemas change. |

---

## 6. Scope and recommendation

### 6.1 Rough effort

These are engineer-day estimates for someone who knows the codebase. They follow the shipped definition of done:
bots, skills, policies, briefing, screenshots and a sweep report (§12, lines 886-892).

| Area | Days | Main items |
|---|---:|---|
| Sim: walker | 5–7 | `spider_mech` stats, `heavy` armour row, `braced` deploy stance, Surface pierce, Spire-range validation, post Breaker in `capture.ts`/`posts.ts`, big-body hole fall (+ the stranded decision) |
| Sim: elevator + descent | 5–7 | `elevator` main-slot structure, moored-by-own-tower requirement, `TRANSITS.elevator`, Orbit→Sky hand-off, abort/hard landing, arrival re-check, storm block |
| Sim: Orbit | 7–10 | First Orbit structure (placement, footprint in Orbit steering/ORCA, ghosts, beam/PD interplay), tug `crew` work and pay-as-you-go, `mech_hull` towable and auto-dock |
| Telegraphs + fog | 3–4 | Schedule, alerts, public events, `mechs[]`, twin-world tests |
| Bots | 8–12 | Orbit/Sky/Surface builders × standard/veteran; counters on all four seats; Depths pad charges; C4 frame mirroring |
| Example policies | 4–6 | Four policies + libs under the CPU budget |
| Briefing / skill / manifest / pin | 2–3 | Topics, intent docs, `mech.md`, bench re-pin |
| Client | 12–18 | Walker model and leg animation (no walker exists; `apps/web/src/world/models.ts` is procedural), cable render that spans stacked planes and dives, gantry and hull models, beam/brace VFX, descent telegraph and landing marker, HUD buttons/tooltips, minimap, Director weights, generated SFX (§14, line 921) |
| Tests + balance | 6–9 | Determinism/mirror (C2 + C4), intent/fog/abort unit tests, policy fixtures, perf; E1–E7 runtime and analysis |
| **Total** | **52–76** | Roughly 2.5–3.5 months for one engineer |

### 6.2 Minimal first slice (proves the fun, ~12–16 days)

**Slice 0, dev only (2–3 days, no player surface).**

- `spider_mech` stats plus the braced beam, `elevator` structure and `TRANSITS.elevator`.
- Spawn both via `ac_cheat`. Trigger the descent from a cheat at a fixed moored island on a fixed seed.
- Capture it with `ac_screenshot` and an observer run.

Question it answers: does a public 20 s countdown plus a 12 s column fight plus a braced siege read as an event?
No bots, no policies.

**Slice 1, playable behind `rules.mech.enabled` (10–13 days).**

- No tugs and no gantry. The Sky lane queues `spider_mech` at a completed `elevator` on an island moored by an
  own tower. The hull "arrives" at the cable head after `assemblyTime`.
- Descent prep, the public schedule and alert, abort rules, the arrival re-check and the storm block.
- Breaker posts. `beamReachesSky` off.
- Standard bots only:
  - Sky builds the elevator; Surface moors and fights.
  - Every seat counters with existing tools: flak, Lens, island capture, tower focus, a Depths pad charge.
- Briefing topics, one skill page, a policy stub in the Surface policy.
- Run E1 and E2 at small scale.

What this proves:

- whether the chain is fun;
- whether counterplay from every plane happens without new counter tools;
- whether matches get shorter or longer.

It reuses the most code and defers the most expensive new system, the first Orbit structure.

**Slice 2: tugs build.** The gantry, tug crews, the hull tow and the Orbit→Sky hand-off. Land it together with or
after the orbital capacitor, so the "first Orbit structure" work is done once.

**Slice 3: full.** Veteran bots, all policies, art polish, the Director preset, the full E1–E7 sweep. Decide
`beamReachesSky`. Skyspear joins whenever Phase D ships it.

### 6.3 Verdict: post-launch

1. **The game is not balance-certified on current master.** The fresh baseline sweep (line 861) and new balance,
   performance and WebGPU acceptance (line 15) are outstanding. A cross-plane late-game power unit cannot be
   tuned against a baseline that does not exist, and it would confound the outstanding pacing fixes (line 789).
2. **Its best parts depend on unbuilt groundwork:**
   - the first Orbit structure (capacitor, §5.2);
   - configurable travel targetability (§8.1, line 608);
   - the vehicles-in-the-Depths decision (line 867);
   - optionally Skyspear and tier 2 (Phase D).

   Building it pre-launch means building that groundwork in a hurry.
3. **It changes the agent surface.** Shipping it pre-launch churns the benchmark pin while ACBench and the ladder
   are being established. Shipping it after launch as a pinned, announced content drop is cleaner.
4. **It is worth doing, so not "not at all".** It is the only proposal that needs Orbit, Sky and Surface
   cooperating and lets every plane, Depths included, interrupt it. It adds a planned spectator moment where the
   Director already knows how to look. It reuses more shipped machinery than it adds.

**Plan:**

- After launch, ship Slice 1 as an opt-in rule and showcase preset.
- Promote it to Standard only if E1–E3 pass, i.e. guardrails hold and kills spread across planes.
- Then ship Slice 2 (the tugs) with the capacitor.

### 6.4 Doc changes the feature would need

These are noted for the implementer. They are not made here.

- §3 (lines 151-156): the chain is two adjacent hops, not a second skip.
- §2.1 (line 54): the `heavy` armour row joins the fixed damage table.
- §4.3 and §4.4 tables: the elevator and the gantry.
- §8.1: the `elevator` transit.
- §12: the vehicles-in-Depths decision recorded.
- CHANGELOG.
