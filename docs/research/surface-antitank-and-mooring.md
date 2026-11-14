# Surface: an anti-tank conversion, and reasons for bots to moor

Research memo. Nothing here is implemented. All experiments ran headless against one fixed build; the memo adds only
this file.

**Verdicts**

- **A (anti-tank).** The gap is real at unit level. On the Surface only a tank trades evenly with a tank. Massed
  Troopers, dug-in Troopers, Breachers and turrets all lose to tanks at equal cost, and the dug-in Troopers and the
  turrets do zero damage because tanks out-range them. In bot play, though, tank massing does not dominate: the side
  with more tanks wins mirrors at about coin-flip rates, and a forced tank-only bot gets a modest edge that bombers
  answer. If the owner wants a Surface-native answer, build the **Rocketeer**: a Trooper converted at the existing
  Drill Yard (§A4), about 7–8 days of work. The cheaper levers (§A5) don't close the range gap. One of them is still
  worth doing first either way: spreading infantry against tanks. In the duel lab that alone turns a total loss into
  a win.
- **B (mooring).** Bots never moor. There were 0 Mooring Towers and 0 `moor` intents in all 52 recorded matches, and
  0 moorings in 18 measured army-matches on master. The blocking check is alloy: when the energy and island checks
  do pass (1–5 % of decisions), the bot never has the 180 (standard) or 160 (veteran) free alloy it requires, because
  army production has already spent it. §B4–B5 give four purposeful behaviours (defend, hold, catch, bridge) and a
  plan written against the bots-as-policy-packages layout.

## Method and data

| Source | What it gave |
|---|---|
| `.data/history` | 52 session records (50 under `simulation/`, 2 at the top level; 112 army-matches), all bot seats, featured playlist or operator duels. Each replay lists every applied intent (17–35 k per 30-min match), so production and `moor`/`mooring_tower` intents can be counted without re-simulating. The records store no army stats and no bot tier. |
| `docs/balance/*.json` | Per-match `produced`, `kills` by source kind, `winner` and `set` for `baseline-pass2` (456 matches), `phase-a` (1608), `checkpoint-b1` (100), `combined-b2` (100) and `balance-b2-rejected-surface` (100). |
| V1: baseline bots | `playBotMatch` standard mirror and veteran mirror, seeds 1–3, 6000 ticks. Every 30 s, Surface units by kind, plus Surface damage by attacker and cause (a read-only wrap of `sim.damage`). Every Surface decision, the bot's own observation is checked against each `mooring()` condition. |
| V2: tank-only fork | The same matches with one Surface seat running `new SurfaceBot(army, { ...TIERS[level], mix: { tank: 1 }, adaptive: false })` (seed 1 nw, 2 se, 3 nw), standard and veteran. |
| V3: duel lab | `breacher.test.ts` arena (open level ground, Spires far away, `spawnUnit`): equal-cost Surface fights, each run for both armies on point-mirrored layouts (every result mirror-exact except the turret placements, which are cell-snapped). Two probes use only match-rule overrides. |

Every run used `flock -w 300 /tmp/ac-test.lock taskset -c 0,1 nice -n 15` with a finite timeout: 3 seeds × 2 tiers ×
6000 ticks for each of V1 and V2, plus two short duel-lab passes (about 2 min in total). The scripts stayed in
`/tmp` and are not committed. The 6000-tick cap (5 game minutes) is short: no Surface Spire fell in any V1 or V2 run.
The long-horizon evidence comes from the balance reports and the 30-minute history replays.

## A. Should the Surface get an anti-tank unit?

### A1. The counter web as shipped

Cost-equivalent below is alloy + 1.5 × energy, the same measure as the tank comment in `stats.ts`. "DPS vs X"
already includes `DAMAGE_VS`.

| Unit | Cost (eq) | HP / armour | Range (tiles) | DPS vs light | DPS vs armoured | DPS vs structure | Notes |
|---|---|---|---|---|---|---|---|
| trooper | 40 | 100 light | 4 | 10 | 4.8 | 4 | fixed mount. Dug in: ×0.6 from rifle, cannon and turret, +1 vision, cannot move |
| tank | 135 | 300 armoured | 6 (+2 vs non-Spire structures) | 11.25 + splash 0.8 | 22.5 | 18.75 | siege: 7.5 vs units, 9 vs structures, min 2, fires over cliffs |
| breacher | 110 (with its trooper) | 120 light | 1.8 | 33 (44 vs dug-in) | 11 | 27.5 | forward cone splash |
| flak | 130 | 150 armoured | Sky only | — | — | — | cannot hit the ground |
| turret | 110 (+0.25 e/s) | 400 structure | 7 | 15 | 15 | — | also shoots the Sky |
| Spire beam | — | — | 7 | 30 | 30 | — | answers a siege tank (`siegeSpireRange` 7) |
| bomber (Sky) | 250 | 200 air | 1.5 | 20 + splash 1.5 | 25 | 30 | the Surface answers with flak and turrets only |

High ground adds +1 range and +2 vision. Low ground never sees high ground, and bombers or Relays spot onto it.

**Duel lab (V3).** Equal cost, both sides fight-moving at each other from 12 tiles apart unless noted. Results were
mirror-exact for blue and red. "HP left" is the sum of survivors' HP fractions.

| Fight | Winner | Survivors (HP left) | Time |
|---|---|---|---|
| 14 troopers (block, 1.1 spacing) vs 4 tanks | tanks | 4 tanks (2.30) | 20.6 s |
| 18 troopers (block) vs 4 tanks | tanks | 3 tanks (1.16) | 30.9 s |
| **14 troopers in one line, 1.6 apart** vs 4 tanks | **troopers** | **10 troopers (5.40)** | 25.4 s |
| 18 troopers in one line vs 4 tanks | troopers | 13 troopers (9.03) | 20.7 s |
| 14 troopers in two lines, 1.6 apart vs 4 tanks | tanks | 3 tanks (1.43) | 26.6 s |
| 14 troopers dug in vs 4 attacking tanks | tanks | 4 tanks, **no damage taken** | 38.1 s |
| 14 troopers dug in on high ground vs 4 attacking tanks | tanks | 3 tanks (2.34) | 40.7 s |
| 14 troopers (block or line) vs 4 sieged tanks | tanks | 4 (2.18) / 3 (1.27) | 22.9 / 35.6 s |
| 3 troopers vs 1 tank (the `stats.ts` comment) | tank | 1 tank (0.04) | 30.6 s |
| 4 troopers vs 1 tank | troopers | 3 troopers (2.07) | 20.1 s |
| 5 breachers vs 4 tanks | tanks | 4 tanks (2.31) | 12.2 s |
| 5 breachers vs 14 troopers | troopers | 2 troopers (0.35) | 10.6 s |
| 14 troopers dug in vs 5 attacking breachers | breachers | 2 breachers (0.92) | 11.1 s |
| 4 tanks attacking 5 turrets | tanks | 4 tanks, **no damage taken** | 22.8 s |
| 14 troopers attacking 5 turrets | turrets | 5 turrets (3.58) | 26.9 s |
| 4 tanks vs 4 tanks | first-placed side | 1 tank (0.10) | 11.3 s |
| *Probe:* tank hp 225 (≡ rifle ×0.8 vs armoured in a rifle-only fight), 14 troopers (block) vs 4 tanks | tanks | 3 tanks (1.74) | 20.6 s |
| *Probe:* same, troopers dug in | tanks | 4 tanks, no damage taken | 38.1 s |

What this shows:

- **The cycle closes for infantry:** dug-in Troopers beat Troopers, Breachers beat dug-in Troopers, Troopers beat
  Breachers. **It doesn't close for armour:** nothing on the Surface beats tanks per cost. Turrets and dug-in lines
  are out-ranged (6–9 against 4–7) and do no damage at all.
- **Against tanks, formation matters more than any number.** At `rules.movement.slotGap` 0.15, Trooper bodies pack
  0.85 tiles apart, so one tank shell (splash 0.8 to body edge, ×0.5 splash factor) hits several Troopers, and only
  the front rank is within its 4-tile range. Spread into one line, the same 14 Troopers win and keep 10 alive.
  Bot moves use these packed slots.
- **A rifle-multiplier tweak doesn't change outcomes:** the ×0.8-equivalent probe moves the tanks' remaining HP from
  2.30 to 1.74 and changes no winner. Range and splash are what decide these fights, not the multiplier.
- The Surface's real answers to tanks today come from other planes: bombers (×1.25 vs armoured, and Surface ground
  units cannot shoot back), Orbit impacts, and the Spire beam at home.

### A2. Does tank massing dominate in practice?

No. The evidence, by source:

**Balance reports.** "Tank share" is the tanks' share of Surface production cost (trooper, tank, flak). "Higher-tank
side won" counts decisive mirror matches where the sides' shares differ by more than 2 points. Cross-tier sets are
confounded by tier strength, so they are not used for the correlation.

| Report | Tank share: novice / standard / veteran | Kills by tanks: novice / standard / veteran | Higher-tank side won (mirrors) |
|---|---|---|---|
| baseline-pass2 | 0 % / 33 % / 27 % | 3 % / 39 % / 32 % | standard 14/18, veteran 11/20 |
| phase-a (1608 matches) | 24 % / 36 % / 22 % | 32 % / 32 % / 19 % | novice 20/28 (71 %), standard 16/38 (42 %), veteran 17/31 (55 %) |
| checkpoint-b1 | 23 % / 15 % / 9 % | 29 % / 15 % / 8 % | 1/1 |
| combined-b2 | 52 % / 36 % / 36 % | 14 % / 12 % / 11 % | 0/1 (most mirrors capped as draws) |

As the bots matured, tank kill share fell from 30–39 % (standard) to 12 %. In the largest sample (phase-a), the
higher-tank side won 42 % of standard and 55 % of veteran mirrors: no signal. The pass-2 exploit hunt's
`tank_bombard` policy (`hunt-pass2-smoke.md`) dealt the most Spire damage of its three tries and still lost to the
veteran.

**History replays.** Across the 29 recordings of at least 6000 ticks, the median tank share of Surface `queue_add`
cost for bot seats is 33 % (range 14–64 %). There are three bot-vs-bot decisive
matches, and in each the winner had the higher tank share (31 vs 19 %, 34 vs 22 %, 50 vs 44 %). That is too few to
mean much, and confounded: the side ahead affords more 30-energy tanks. Bot tier isn't recorded in session records.

**V1 (master, first 5 minutes).** By value, the Surface army that stays on the Surface is tank-heavy (55–59 %
standard, 70–74 % veteran) but small: the peak is 570–910 cost, about 4–7 units, because Troopers keep going down
to the Depths. Surface damage dealt per side was 786–1403 by Troopers and 318–900 by tanks. Neither Spire was
touched.

**V2 (tank-only fork vs the same tier, 5 minutes).**

| Tier, seed | Fork side | Surface damage dealt, fork / opponent | Peak Surface army value, fork / opponent |
|---|---|---|---|
| standard 1 | nw | 2024 / 1563 | 1620 / 865 |
| standard 2 | se | 1876 / 3240 (bombers dealt 1593, 3 tank kills) | 1080 / 1040 |
| standard 3 | nw | 1670 / 1465 (fork's Spire −360) | 1215 / 735 |
| veteran 1 | nw | 2020 / 1420 | 1215 / 925 |
| veteran 2 | se | 2535 / 1196 | 1350 / 1020 |
| veteran 3 | nw | 2416 / 2392 | 675 / 1095 |

The fork out-damaged its opponent in 4 of 6 matches, was even in 1, and lost one to bombers. It killed no Spire
within 5 minutes. Massing tanks is a modest edge with a cross-plane answer, not a dominant line.

**Conclusion.** There is a real unit-level hole: no Surface-native counter to armour, and dug-in lines and turrets
are helpless against tanks. It isn't a meta problem today, because the bots' Surface armies are small, split with
the Depths, and answered from the Sky. A strong human or LLM who masses tanks and screens out bombers with flak meets
nothing on the Surface that beats them; the duel lab shows exactly that. So a new unit is warranted on design
grounds, not because a current balance metric is failing.

### A3. Real gap, or tune the numbers?

| Lever | Effect on the gap | Catch |
|---|---|---|
| Rifle vs armoured 0.6 → 0.8 | Probe: no winner changes; dug-in lines still deal 0 | `DAMAGE_VS` is code, not a match rule. The rifle row is shared by Skiffs, Gunships and Gun Platforms, so this would also buff Skiffs against Lancers and Bastions in Orbit. Doing it cleanly needs a separate Trooper weapon row. |
| Tank cost up (e.g. 100 + 40) | Fewer tanks; no counter created | `stats.tank.alloy/energy` are match rules, so it's cheap to try. But tanks would still be the only thing that kills tanks, and turrets would still be out-ranged. |
| Research "AT rounds" for Troopers | Troopers become universal; the range problem remains | Surface has no research yet ([ROADMAP](../ROADMAP.md#spire-progression-and-research) plans Foundations and Field Repair). Upgrade modifiers can't change a weapon × armour multiplier (`STAT_KEYS`), so this needs a new effect kind plus a per-army lookup in `Sim.weaponVs`, which is a hot path. |
| Spread infantry against tanks (bot and policy behaviour) | Duel lab: a line wins where a block loses | No roster change. `slotGap` is global (all units, all moves), so the fix belongs in bots, policies and the skill, not the rule. |
| **Rocketeer conversion** (§A4) | Adds the missing Surface counter to armour, with clear weaknesses | The most work (§A6). |

### A4. Lead proposal: the Rocketeer, a Trooper converted at the Drill Yard

**Fantasy.** A Trooper hands in its rifle at the Drill Yard and comes out with a shoulder launcher. It deletes
armour, but it's slow to reload, has a blind spot up close, and is easy prey for rifles, flame and turrets.

**Where it converts: the existing Drill Yard.**

- The plumbing already exists. The `convert {units, to}` intent has an enum `to` (`CONVERTED_UNITS`), the yard
  queue and lineup, the `converting` state and its fog, `finishConversion` (HP share, stance, seat and queued orders
  carry over), the `produced` event, `stats.conversions`, the readiness and smart tools, and the briefing topic.
- One yard per army (`surface.drillYardMax` 1), converting one Trooper at a time, becomes the shared throughput for
  Breachers and Rocketeers. Each conversion is a choice between flame and rockets. Killing the yard stops both.
- The yard already reads as a workshop (gantry, hoist, fuel tanks, crates), so no new structure, model, footprint,
  placement rule or bot site logic is needed.
- Rejected alternative: a new "Armory". It adds a structure kind (model, death profile, site logic in bots and
  policies, readiness, briefing) only to gain a second conversion line, which nothing needs yet.
- The yard becomes buildable when either conversion is enabled. `research.ts:130` and the `convert` intent check
  `breachersEnabled` today, and both become per-target checks.

**Cost, time and cap.**

- `stats.rocketeer.alloy` 25, `.energy` 25 and `.build` 7 s are the conversion, as with the Breacher. The total with
  its Trooper is 65 alloy + 25 energy = 102.5 eq, against 135 for a tank.
- The energy part makes it compete with tanks, flak and interceptors for the same scarce resource.
- No per-army cap rule. Throughput is the cap: at most 60 / 7 ≈ 8.6 per minute per army, shared with Breachers.
  Rocketeers are bad against infantry, so massing them punishes itself. If sweeps show spam anyway, add
  `surface.rocketeerMax`.

**Portals.** Add `rocketeer` to `TRANSITS.descend.kinds` and `TRANSITS.emerge.kinds`, alongside `trooper` and
`breacher`. Its targets are `['surface', 'depths']`. Underground it's a weak unit, because the Depths have no armour,
but it can move with the squad it belongs to. It is not airdropped: the Aerie drops Troopers.

**Stats (all match rules: `stats.rocketeer` via `armedUnit('rocketeer')`, plus one new generic field).**

| Rule | Value | Why |
|---|---|---|
| `stats.rocketeer.hp` | 90 | Below the Trooper's 100, so rifles and flame punish it |
| armour | light | Tank cannon ×0.75, flamer ×1.5, rifle ×1.25 |
| `.speed` | 2.3 | Slightly slower than infantry (2.5), faster than tanks (1.6) |
| `.dmg` / `.cooldown` | 40 / 2.5 s | 80 per hit and 32 DPS against armour, so a tank (300) dies to 4 hits in 7.5 s |
| `.range` | 5 | Mobile tanks still out-range it by 1 (6), sieged tanks by 2.5 (7.5), turrets by 2 (7). High ground (+1) gives 6, the ambush case. |
| `.vision` | 6 | As the Trooper |
| weapon / mount | `rocket`, `fixed` | Must stop and face to fire (`fixedMountArc` 10°): the setup time |
| projectileSpeed / splash | 12 / 0 | Cannon speed: a tank moving at 1.6 t/s stays inside `directHit` + its radius over a 5-tile flight. No splash, so no anti-blob value. |
| `stats.rocketeer.minRange` (new generic `Stats.minRange`) | 2 | Back-blast blind spot, equal to `siegeMinRange`. A Breacher inside 2 tiles (its flamer reaches 1.8) is safe from rockets. |
| `surface.rocketeersEnabled` | true | On/off toggle, like `breachersEnabled` |

New `DAMAGE_VS.rocket` row (code, beside `flamer`): light 0.35, armoured 2.0, structure 0.6, small 0.35, and air 1,
heavy_air 1, island 0.5 (unused, because `targets` excludes the Sky). `rocket` joins `WEAPONS`. Dug-in reduction
stays for rifle, cannon and turret only: rockets are already poor against infantry.

**Where it sits in the counter web** (per-cost Lanchester square-law strengths at a 540-eq budget; the duel lab must
confirm, see acceptance below):

- **Beats tanks.** 5.3 Rocketeers against 4 tanks: 5.3² × 32 × 90 ≈ 80 k against 4² × 11.25 × 300 = 54 k, about
  1.5×. Splash on packed Rocketeers pushes this toward even, which is intended: it's a counter, not a hard one.
- **Loses to Troopers.** 13.5 Troopers against 5.3 Rocketeers: 182 k against 14 k, about 13×.
- **Loses to Breachers up close.** The flamer does 33 DPS against its 90 HP (3 s). Once a Breacher is inside 2 tiles
  the Rocketeer can't fire at all; outside that it needs 9 hits (14 each) to kill one.
- **Loses to turrets.** A turret kills it in 6 s from range 7 > 5. It needs about 40 s for one turret (24 per hit).
  Turret rings and the Spire remain tank-siege work.
- **Siege tanks.** At 7.5 a sieged tank out-ranges it, and it packs in 3 s, so sieged tanks behind a Trooper screen
  beat Rocketeers. Rocketeers that flank to within 5 tiles of an unscreened sieged tank win. Both sides have the same
  2-tile blind spot, and Breachers own that space.
- **High ground.** On a ridge it reaches 6, equal to a mobile tank, and low ground can't see it. That makes the
  Rocketeer a ridge ambusher, and tanks need a Relay or bomber spotter to answer. The Sky gets a new reason to spot.
- **Flak.** Flak (150 HP, armoured, no ground weapon) dies to 2 hits. Troopers already kill undefended flak, so this
  changes little.

Intended cycle: **Troopers > Rocketeers > tanks > Troopers in a packed block**, with Breachers > dug-in Troopers and
Rocketeers up close, and tanks > turrets.

**Acceptance (duel lab plus sweeps).** Write these as mirrored tests in `rocketeer.test.ts`, in the style of
`breacher.test.ts`:

- 5 Rocketeers beat 4 tanks in the open with at least 2 survivors;
- 14 packed Troopers beat 5 Rocketeers, losing at most 3;
- 5 Breachers beat 5 Rocketeers;
- 5 turrets beat 5 attacking Rocketeers and keep more than half their HP;
- 4 sieged tanks behind 6 dug-in Troopers beat 5 attacking Rocketeers;
- the 100-match sweep keeps the 22 guardrails and doesn't lengthen the standard median.

**Toon art and VFX** (`docs/art/DIRECTIONS.md` kit):

- **Model:** the Trooper's upright pill on light boots, plus a long launch tube over the right shoulder (the
  forward-most point, team band ringed on it) and a backpack rack of three finned warheads (the rear mass, so facing
  reads without the weapon), with goggles under the cap.
- **Silhouette:** a pill with one long diagonal tube, distinct from the Breacher's square torso and twin tanks.
  Light tier, at most 160 triangles (6-sided tube, three cone-capped warheads).
- **Anchors:** `ROCKETEER.muzzle` shared by the model, rig and visual, as `BREACHER` does.
- **Animation:** idle is breathing with a tube sway. Move is the Trooper stride. Fire is a tube kick and shoulder
  jolt, a pale back-blast puff *behind* (it reads as a heavy weapon and hints at the close-range blind spot), and one
  rack warhead that hides and reappears over the cooldown (vertex-stage time, no CPU work per frame).
- **Shot:** `WEAPON_VISUALS.rocket`: a short finned bolt on a linear trajectory with a thin smoke trail, a muzzle
  flash, and a medium impact (smaller than the cannon's).
- **Death** (`DEATH_FX.rocketeer`): `INFANTRY` plus a small fireball and two debris chips as the rack cooks off, with
  sound `imp_small` at about 0.6.
- Icon (`icons.ts`), name and tip (`text.ts`), and a `convert_done` sfx case for the new subject.

**What it's weak to:** Troopers (rifles ×1.25, 90 HP), Breachers (flame ×1.5, the 2-tile blind spot), turrets and
the Spire (out-ranged), sieged tanks behind a screen (out-ranged), bombers (it can't shoot the Sky), and losing the
Drill Yard, since one yard feeds both conversions.

### A5. The options for the owner

| Option | Closes the armour gap | Side effects | Effort |
|---|---|---|---|
| 1. Bots, example policies and the skill spread infantry in a line against tanks (the formation finding) | Partly: duel lab line 14 vs 4 wins, keeping 10 | None to the roster; humans and LLMs need the skill hint | 1–2 days after the port |
| 2. Tank cost 90 + 30 → 100 + 40 (match rule) | No | Fewer tanks; turrets still out-ranged | Under 1 day plus a sweep |
| 3. Trooper weapon row split, rifle ×armoured 0.8 | No (probe) | Bench re-pin (the briefing quotes multipliers) | 1 day plus a sweep |
| 4. Surface research "AT rounds" | Partly; the range gap remains | First Surface research, a new upgrade effect kind, a hot-path lookup | 3–4 days |
| **5. Rocketeer conversion** | **Yes**, with designed weaknesses | New kind on every layer | **7–8 days** |

Recommendation: do 1 regardless, because it's cheap and fixes the worst duel. Do 5 if the owner wants the Surface
to own its anti-armour answer. Skip 2–4: they don't fix the range and splash problem.

### A6. Cost of adding the Rocketeer, following the Breacher path

The file list comes from `grep breacher`: 37 files. Most changes are a new list member or a sibling row, not new
logic.

| Layer | Files | Work | Estimate |
|---|---|---|---|
| Rules | `rules/stats.ts` (row, `WEAPONS`, `DAMAGE_VS.rocket`, `TRANSITS` kinds, `Stats.minRange`), `rules/vocabulary.ts` (`CONVERTED_UNITS`), `rules/econ.ts` + `rules/match-rules.ts` (`rocketeersEnabled`, the stat row via `armedUnit`), `rules/intents.ts` (convert doc) | New rows and list members | 0.5 day |
| Sim | `sim/ent.ts` (convert order gains `to`), `sim/hash.ts` (hash `o.to`), `agent/intents.ts` (`convert` accepts both targets and checks the per-target toggle), `planes/drill-yard.ts` (stats and the `add` kind come from the Trooper's order instead of the fixed `breacher` row), `sim/combat.ts` + `sim/movement.ts` (generic `minRange` in reach, acquisition and the firing-spot search, like `inMinRange` for deploy stances), `sim/research.ts:130` (yard eligibility) | Generalise the conversion target; add min range | 1–1.5 days |
| Briefing and observation | `agent/docs/planes.ts` (DRILL YARD AND CONVERSIONS topic), `agent/manifest.ts` (Surface summary), `agent/intents.ts` `COMBAT_SURFACE`. The observation needs nothing new: kinds come from `UNIT_KINDS` and the state from `converting`. | Text | 0.5 day |
| Client | `world/models.ts` (model and anchors), `world/entities.ts` (muzzle), `world/combat.ts` (`WEAPON_VISUALS.rocket`), `world/death-profiles.ts`, `icons.ts`, `text.ts`, `tools/index.ts` + `tools/smart.ts` + `tools/readiness.ts` (the convert tool picks Breacher or Rocketeer), `audio/director.ts`, `docs/art/DIRECTIONS.md` rows | Art, VFX and the tool target choice | 2 days |
| Bots and policies | `bots/surface.ts` (convert Rocketeers when known hostile tanks plus flak value exceed Trooper value; `Tier.rocketeers`: novice 0, standard 2, veteran 4; keep them behind the Troopers and attack tanks, never turrets), `bots/tuning.ts`, the example twin `policies/lib/surface-breach.js` generalised to both conversions, then `pnpm bots:build` | Counter-mix branch | 1.5 days |
| Skill and design | `skills/.../planes/surface.md` (army mix, conversions), DESIGN §4.2 | Text | 0.25 day |
| Tests | `test/rocketeer.test.ts` (mirrored: rows, conversion target, cost and time, min range, DAMAGE row, portals, fog of converting, the acceptance duels above); web `unit-stats`, `icons`, `death-fx`, `projectile`, `state-visuals`, `smart` tests; bot test (converts when tanks are seen) | | 1.5 days |
| ACBench and sweep | `pnpm bench:pin` (manifest, schemas, skill and briefing change), `test:quick`, 100-match sweep (timing slot) | | 0.5–1 day |

Total: **about 7–8 days**, about half of it client art and tests.

## B. Real reasons for bots to moor islands (post-port backlog)

### B1. Measurement: moorings per match

`ArmyStats.moorings` (`sim/state.ts`) is incremented in `SkyPlane.updateMoorings` (`planes/sky.ts:260`) when a tower
starts lowering an island. It reaches agents in the observation's stats (`agent/present.ts:1202`,
`rules/observation.ts:934`). It is not in session records, not in `tools/balance` traces (`metrics/record.ts` has no
mooring field), and not in reports. So the only ways to measure it are counting intents in replays or
re-simulating.

| Source | Tier | Army-matches | Towers queued | `moor` intents | `stats.moorings` |
|---|---|---|---|---|---|
| `.data/history` (52 records, up to 36000 ticks) | featured mix (not recorded) | 112 | 0 | 0 | n/a |
| V1 + V2 non-fork seats, 6000 ticks | standard | 9 | 0 | 0 | 0 |
| V1 + V2 non-fork seats, 6000 ticks | veteran | 9 | 0 | 0 | 0 |

### B2. Why: the gate, decision by decision

Share of Surface decisions passing each `SurfaceBot.mooring()` condition, on the bot's own observation (V1 mirrors,
3600 decisions per tier):

| Condition | Standard | Veteran |
|---|---|---|
| net energy (`energyRate − upkeep`) > 3 e/s | 86 % | 88 % |
| free energy ≥ 90 | 35 % | 28 % |
| owns any island | 98 % | 98 % |
| an own island has any finished main structure | 26 % | 30 % |
| …a finished Relay, Aerie or Stormcatcher, nearer home than any hostile Spire | 9 % | 14 % |
| **all three** (energy, bank, island) | **1.1 %** | **5.3 %** |
| …and free alloy ≥ tower 100 + tier reserve + `SPARE_ALLOY` 40 (180 standard / 160 veteran), free energy ≥ 150 | **0 %** | **0 %** |

In seed 3 neither tier ever had a finished structure on an own island. `mooring()` runs after the army production
commit in `think()`, so the trickle is spent before it is consulted. "Nearer home than the enemy Spire" excludes
half of every ring. The gate also has no reason to moor at all, only that the bot happens to have a useful island:
nothing in it asks whether lowering would help.

### B3. What mooring actually does (the levers a behaviour can pull)

- **It stops the drift.** A lowering or held island skips `placeIsland` and accumulates `orbitDelay`. It stays where
  it was caught and later resumes its own circle, delayed, with no catch-up jump. On S48 duels the rings are at radii
  8, 14 and 20 with periods of 70, 100 and 140 s, two islands per ring, so an island passes a given tower about
  every 35–70 s and stays within the 10-tile `mooringRange` for about 20 s per pass.
- **It makes capture slow and exposed.** Capture needs the aircraft within 0.5 of the deck's elevation
  (`MOORING_CAPTURE_HEIGHT`). A held island sits 8 tiles down (`MOORING_DEPTH`), so capturers spend about 3 s
  descending, then the 5 s capture (12 s against a built structure), all inside whatever covers that column.
  Ground-to-Sky cover means flak (7 tiles, 9 emplaced), turrets (7) and the Spire beam (7). Troopers and tanks can't
  hit the Sky. Lowering changes no targeting, vision, weather or ownership.
- **It costs** 100 alloy + 60 energy and 25 s for the tower, then 3 e/s while lowering or held. That is half the
  6 e/s base delivery, so holds must be purposeful and time-bounded. The 3 s grace is nonrenewable, and the
  cooldown after rejoining is 20 s.
- **It can catch any visible island**, whatever its ownership: own, neutral or hostile.

### B4. Purposeful behaviours

Every number below is a named bot constant in `bots/tuning.ts` or a `Tier` field. Match numbers (upkeep, range,
grace, cooldown, capture times, weapon ranges) are always read from the compiled rules. Priority per tower:
defend > catch > hold. One tower is held by one behaviour at a time.

**0. Build the tower (the precondition that fails today).**

- Trigger: the tier has `mooring.towers > 0`, at least `MOOR_TOWER_AFTER_ARMY` (6) own Surface fighters, and at
  least one candidate ring. A candidate ring is one with an own or neutral island passing within
  `mooringRange − MOOR_RING_MARGIN` (2) of a legal site that is inside the home build radius and inside own
  air-defence cover (an existing or planned turret or flak within its Sky range of the site).
- Site: the cell that minimises |site distance to map centre − ring radius| for the most valuable candidate ring,
  ties to the nearer cell to home.
- Funding: **commit to the shared queue the way tanks are committed** (the "commit the desired mix" pattern in
  `think()`). Call `c.reserveCost` before army production that decision, and gate only on alloy income being
  positive. Dropping the 180-alloy free-bank check is what fixes B2.

**1. Defend a threatened own island.**

- Trigger: own island I with a built main structure or an armed hardpoint, which is either
  - the target of the Sky seat's existing `flak` ask (`askSky`: `SIGNAL_AIR_HEAVY` hostile aircraft within
    `SIGNAL_ISLAND_REACH`, or a hostile drop), or
  - covered by an `island_contested` alert, or
  - within `MOOR_THREAT_REACH` (6) of a hostile capture-capable aircraft,

  and I is within `mooringRange` of an idle own tower, with at least `MOOR_DEFEND_COVER` (1) own flak, turret or the
  Spire within its Sky range of I.
- Energy: net rate ≥ upkeep, or free energy ≥ upkeep × `MOOR_DEFEND_SECONDS` (20 s, so 60).
- Action: `moor`, and answer the same `flak` ask by emplacing flak under I, as today.
- Release (`unmoor`): no threat for `MOOR_CALM` (15 s); or free energy < upkeep × `MOOR_BANK_SECONDS` (10 s, so 30)
  while net is negative, so it never burns the nonrenewable grace; or I is lost.

**2. Hold an own island off a dangerous route.**

- Trigger: own island I with a Relay (+4 e/s delivery cap and spotting), Aerie or Stormcatcher, currently within
  tower range, whose position `MOOR_HOLD_LOOKAHEAD` (20 s) ahead on its public path (`obs.islands`: `r`, `phase`,
  `speed`, `pausedAt` while moored) is either nearer a hostile Spire than ours, or within a known hostile flak or turret's Sky range plus
  `MOOR_HOLD_MARGIN` (2).
- Energy: net rate ≥ upkeep + `MOOR_HOLD_SURPLUS` (1 e/s). Holding is optional; defending isn't.
- Release:
  - the projected route stops being dangerous (the hostile cover is gone or the threat moved), or
  - the hold has lasted `MOOR_HOLD_MAX` (60 s), so it can't sit forever at 180 e/min, or
  - the energy check fails, or
  - a defend or catch needs the tower.
- After release, the 20 s cooldown prevents chained holds.

**3. Catch an enemy, neutral or contested island to capture it.**

- Trigger:
  - the tier has `mooring.catch`;
  - a visible hostile or neutral island I passes within `mooringRange` of an idle own tower and within own Sky
    cover;
  - our Sky has at least `MOOR_CATCH_CAPTURERS` (3) capture-capable aircraft alive and not busy defending;
  - I carries no hostile armed hardpoint (it blocks capture), or our Sky out-numbers the known hostile aircraft
    within `MOOR_THREAT_REACH` of I.
- Energy: net rate ≥ upkeep, and free energy ≥ upkeep × `MOOR_CATCH_SECONDS` (40 s, so 120).
- Action: `moor`, then `desk.ask(c, 'capture', 'sky', I)` (extend `askCapture` with this target). The Sky bot gives
  a moored-by-us island a `MOORED_CAPTURE_BONUS` (×0.5 distance) in `islandValue`, so its capturers go where the
  Surface holds the island.
- Release: I becomes ours (then switch to hold if behaviour 2 applies, else `unmoor`); or `MOOR_CATCH_TIMEOUT`
  (40 s; 12 s structure capture plus the descent plus travel) passes without capture; or the hostile Sky
  out-numbers ours at I.

**4. Island bridge over a chasm (future; needs a mechanic first).**

- Lowering changes nothing on the Surface today: "lowering never grants Surface sight", and a lowered island isn't
  walkable. A bridge needs a sim rule first, for example `surface.islandBridgeEnabled` and
  `surface.islandBridgeRadius`: a fully held island makes the active fault (chasm) and water cells under its
  footprint passable for Surface units, and the bridge collapses on release, with units on it falling with
  `fallDamage`.
- The Depths `lava_bridge` is the precedent for rules, fog and tests. Depths lava is a different plane, so a Sky
  island can only bridge Surface chasms, water and cliff gaps.
- Bot trigger, once the rule exists:
  - the army's route to its focus is blocked (`no_path`), or the bridged route saves at least `MOOR_BRIDGE_SAVING`
    (10) tiles;
  - an island's ring crosses that gap within tower range;
  - the army is at least `MOOR_BRIDGE_ARMY` (8) units.
- Hold for the crossing plus `MOOR_BRIDGE_GRACE` (5 s), then release. Until the mechanic ships this is out of scope
  for bots.

**Per tier** (`Tier.mooring = { towers, defend, hold, catch }`):

| Tier | towers | defend | hold | catch |
|---|---|---|---|---|
| novice | 0 | — | — | — |
| standard | 1 | on | on | — |
| veteran | 2 | on | on | on |

Novice never builds a tower. Standard owners will now see towers and defensive holds. Veteran adds offensive catches
coordinated with the Sky.

### B5. Implementation plan

The built-in bots stay TypeScript classes
in `packages/game/src/bots/`. `bots/library.ts` serves their import graph from the roots `bots/policy.ts` and
`bots/<plane>.ts`, types stripped, in the strategy skill under `policies/game/`. Each plane × level package is
`botPolicy(SurfaceBot, { plane, level, tier? })` (`bots/policy.ts`). Forks replace `Tier` fields through
`BotPolicyConfig.tier`. Bot modules now import rules leaves directly (`rules/stats.ts`, `rules/vocabulary.ts`,
`rules/deploy.ts` …), not `rules/contract.ts` at runtime. The hand-written example policy (`policies/surface.js`
plus `lib/surface-sites.js`) still exists, and `test/bot-parity.ts` compares the bot with it.

1. **`packages/game/src/bots/surface-mooring.ts`** (new library module, imported by `surface.ts`, so `bots:build`
   serves it as `policies/game/bots/surface-mooring.js`): `class MooringPlanner`.
   - Memory per tower: role, island, since, deadline.
   - Methods `plan(c: Ctx, tier: Tier['mooring'], desk: SignalDesk, out: AgentCommandIntent[])` and
     `towerSite(c)`.
   - Imports leaves only (`rules/stats.ts`, `rules/vocabulary.ts`, `util/math.ts`) and the type-only contract.
   - Iterates islands in `c.frame.order` and breaks ties by id, so mirrored armies decide identically.
   - Ring projection reads the public island paths (`obs.islands`: centre, `r`, `phase`, `speed`), so it needs no new
     observation and is computed in the team-canonical frame.
2. **`bots/surface.ts`:**
   - delete `private mooring()`;
   - construct `this.moorings = new MooringPlanner()`;
   - call `this.moorings.plan(...)` **before** the army-production commit, so a due tower's cost is reserved
     (`c.reserveCost`) and production sees it;
   - answer the Sky's `flak` ask through the planner as well (`signals.ts` `answerSurface`).
3. **`bots/tuning.ts`:** `Tier.mooring` with the per-tier table above, and the constants `MOOR_TOWER_AFTER_ARMY`,
   `MOOR_RING_MARGIN`, `MOOR_THREAT_REACH`, `MOOR_DEFEND_COVER`, `MOOR_DEFEND_SECONDS`, `MOOR_CALM`,
   `MOOR_BANK_SECONDS`, `MOOR_HOLD_LOOKAHEAD`, `MOOR_HOLD_MARGIN`, `MOOR_HOLD_SURPLUS`, `MOOR_HOLD_MAX`,
   `MOOR_CATCH_CAPTURERS`, `MOOR_CATCH_SECONDS`, `MOOR_CATCH_TIMEOUT` and `MOORED_CAPTURE_BONUS`. Forks can then tune
   them through `tier.mooring`.
4. **`bots/signals.ts` and `bots/sky.ts`:** extend `askCapture` to ask for a caught island, and give the
   `MOORED_CAPTURE_BONUS` in `SkyBot.islandValue`. Moored islands are public (`mooringState`), so this needs no new
   observation.
5. **Example policy twin:** rewrite `mooring()` in `skills/agent-command-strategy/policies/lib/surface-sites.js` to
   the same behaviours, with knobs at the top of `policies/surface.js`. If the port turns `policies/surface.js` into
   a starter fork over the library, delete the twin instead (clean cutover). Update the skill `planes/surface.md`
   with a short section on when to moor, and DESIGN §4.3's Mooring Tower line (bot behaviour) and the ROADMAP item.
6. **Metrics:** add `moorings` (and catches that ended in capture) to the `tools/balance` trace summary, so sweeps
   report it next to the structure-edge table.
7. **Tests:** `test/mooring-bots.test.ts`, every scenario on point-mirrored layouts for both armies:
   - standard builds one tower by 4:00 when a candidate ring exists, even with cheap units queued (the funding fix);
   - defend: hostile interceptors near an own Relay island in tower range with flak cover → `moor`; `unmoor` after
     calm;
   - hold: a Relay island projected to cross into hostile flak cover → `moor`; release at `MOOR_HOLD_MAX` or when
     net energy drops;
   - catch (veteran): a neutral island passing in range with 3 capturers → `moor` plus a capture ask; the Sky
     captures; timeout releases;
   - never moors with free energy below the bank check (no grace burn);
   - novice never builds;
   - the parity test covers the example twin.
8. **Verification:** typecheck, game tests, `pnpm bots:build`, `pnpm bench:pin` (skill and policy text are
   agent-facing), `test:quick`, then a 100-match sweep in the timing slot.
   - Acceptance: a tower in at least 80 % and at least one mooring in at least 60 % of standard and veteran army
     matches by 10:00, the 22 guardrails hold, and the standard median length doesn't grow.
