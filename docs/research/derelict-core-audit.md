# Derelict core audit (Orbit)

**Question.** Is the derelict core worth contesting right now, and does it need rebalancing?

**Verdict: leave the rules as they are. Fix the bots, then measure again.** On paper the core is a good deal: one tug,
about 30 HP of radiation and roughly a minute's tow pay 400 resources every ~3.5 minutes, and half of that is energy past
the delivery cap. In real play it barely exists. Over 34 faithfully re-simulated recorded matches (1,110 army-minutes) it
was lifted 5 times. Each lift was cashed. Nothing ever melted down, vented, dropped or got shot down. Its share of
all income was **0.20%**. Two causes account for this, and neither is a rule number:

1. **The bots only go for the core when they have two tugs idle at once.** Bot and example policy alike pass only free
   tugs (not mining, no cargo) into the core logic and then demand at least two of them. Standard and veteran keep two
   tugs, and both stay on rocks whenever a rock is mineable.
2. **Same-tier mirrors tie forever.** On a C2/C4 map two bots of the same tier send bit-identical tugs, which reach the
   core on the same tick. The tie rule then says nobody latches, and this repeats every window. Most featured matches
   are such mirrors: 26 of the 34 faithful matches.

Give the bots a spare tug (rule `startTugs` 3) and they take the core in the first window: lifted at 31–77 s, cashed by
75–109 s. The taker then ends 5 minutes about **+280 to +350 resources** ahead of the same match without a core.

---

## 1. How the core works now

Rules are `rules.orbit.*` match rules (`packages/game/src/rules/econ.ts`, `match-rules.ts`). Sim:
`packages/game/src/planes/derelict.ts`, `payloads.ts` (tow and cash-in), `combat.ts` (shooting it down).

### Geometry and gate cycle

| Rule | Default | Meaning |
|---|---|---|
| `derelictEnabled` / `coreEnabled` | on / on | Ruin at the map centre / the core in it |
| `derelictHullInner`–`derelictHullOuter` | 11.8–13.5 S48 tiles | Static hull band; 4 axis breaches (`derelictBreaches`), `derelictBreachWidth` 5.8 |
| `derelictRingInner`–`derelictRingOuter` | 7.2–8.4 | Rotating ring; 4 gates (`derelictGates`), `derelictGateWidth` 5.8. The chamber is everything inside `ringInner` |
| `derelictOpen` → `derelictTurn` → `derelictClosed` → `derelictTurn` | 40 s → 2 s → 24 s → 2 s | Public cycle from tick 0, period 68 s; a turning ring pushes ships out of the gates without damage |
| `derelictLane` | 4.8 | The hull plus the lane always stays outside every Spire's Orbit beam and deorbit stand-off (`derelictScale`) |

Distances scale by size/48, or less where the Spires stand closer.

### The core

| Rule | Default | Behaviour |
|---|---|---|
| `derelictRadiation` | 2.5 /s | To every Orbit unit inside the ring. Shields absorb it first and their regen pauses; Aegis does not cover it. One sealed span (24 + 2 + 2 s) = 70 HP |
| `grappleReach` | 1.5 | A tug on `grapple` within reach of a resting core latches after movement. **If tugs of two hostile alliances are in reach, nobody latches** (`latchCore`) |
| `coreTowSpeed` | ×0.4 | Loaded tug 2 → 0.8 tiles/s; leaves only through an open gate |
| `coreTransitHeat`, `coreTransitScale` | 1 /s on S48, ×(48/size)^1 | Heats only outside the hull, towed or left there: 100 / 133 / 167 s from cold on S48 / M64 / L80. Holds steady in the corridor |
| `coreCoolRate` | 5 /s | Cools in the chamber |
| `coreRewardAlloy` + `coreRewardEnergy` | 200 + 200 | Paid once when a tug brings it within `dockRadius` (3) of its own live Orbit segment. Goes straight to stock past the delivery cap, booked as Orbit income |
| `coreRegrowTime` | 150 s | After a cash-in, drop or meltdown. Towing it out does not start the timer |
| `coreVentTime`, `coreVentFloor`, `coreVentDamage`, `coreVentRadius` | 8 s, 25, 40, 3 | The tug holds still; heat drops to vents so far × 25; a pulse hits every Orbit unit within 3, own units included |
| `coreHp`, `coreMeltdownDamage`, `coreMeltdownRadius` | 500, 400, 4 | Meltdown at heat 100, or when it is destroyed under tow: 400 to Orbit units and structures within 4 |
| `coreDropTime`, `coreDropDamage` + `coreDropCoolBonus`, `coreDropRadius`, `coreDropCrater`, `coreIrradiateTime` / `Dps` | 10 s, 300 + 600 × (1 − heat/100), 3.5, 2, 15 s at 6 /s | Deorbit once past the hull. The Spire takes ×`spireImpactMultiplier` 0.5. Barred by mandate `asteroidDrops: false` |

### A clean, uncontested run on S48

The tug (150 HP, no shield, 100 α + 20 e) waits at the ruin post, hull + 1.5 tiles out on the diagonal. Then:

- **Inbound:** about 8 s through a breach and an open gate to the centre.
- **In the chamber:** about 3.6 s in at 2 tiles/s and 9 s back out under tow at 0.8 tiles/s, so **≈ 32 HP of radiation**.
  The tug repairs it at 3 HP/s once docked.
- **Corridor and hull:** about 8 s.
- **Home:** about 19 tiles to the dock, ≈ 24 s. Heat on arrival is about 24 of 100.
- **Total:** grab to cash ≈ 40–45 s. Recorded and headless lifts took 27–73 s from lift to cash.
- **Best cadence:** about 150 s regrow + the wait for a window (gates are shut 28 of every 68 s) + a ~55 s run ≈ 210 s per
  core. That is at most **≈ 1.9 resources/s**, half of it cap-exempt energy.

### Who sees what

- **Public to every army:** the ruin geometry (`matchData.derelict`), the next two `derelict_open` windows, `core_regrows`
  in the schedule and as an event, `coreLifted {tick, x, y, side}` with the Orbit alert `core_lifted` while the core is
  out of the ruin, and `core_cashed`.
- **Hidden:** the chamber. Only ships inside it or a scan see in, so a resting core, a holder or an empty chamber all look
  the same from outside. `heat`, `heatRate` and `vents` show only with sight of the core.
- **Seen only by armies that see its cell:** `core_meltdown`.
- **Own army only:** `core_vented` and `irradiated`.
- **The Director** (`apps/web/src/observer-director.ts`) weights `core_lifted` 10, `core_cashed` 12 and `core_meltdown`
  12, among the highest objective and hazard weights.

### Bot and policy logic

`bots/orbit.ts` `derelict()`, mirrored by `policies/lib/orbit-core.js` `coreJobs()`:

| Tier | Core | Timing | Spent core |
|---|---|---|---|
| novice | off (`core: false`; also `tugs: 0`) | – | – |
| standard | on | sets out once the gates are open | drops only opportunistically |
| veteran | on | `coreEarly`: at the gate mouth 3 s before the window | `coreBomb`: a core with no vents left is dropped on the focus |

Both on-tiers do the same things otherwise:

- re-check radiation and enemy fire every think and leave on time;
- fight intruders out of the chamber when they trade well (`ORBIT_TRADE_MARGIN`);
- shoot down an enemy tow with ships that out-range the meltdown;
- tow home while the projected heat on arrival stays under 90, vent below 80, and otherwise cool the core in the chamber
  or drop it.

**The gate:** `derelict()` receives `tugs.filter(!miningAssigned && !cargo)` (`orbit.ts:261`), then requires
`tugs.length >= CORE_TUGS_MIN` (2) of that already-free list (`orbit.ts:586`). The example policy does the same
(`policies/orbit.js:112` → `orbit-core.js:190`, `tugs.length >= 2`).

---

## 2. Evidence

### 2.1 Data

**Recorded matches.** `.data/history` held **52 files**:

- 2 top-level operator sessions and 50 simulation-pool matches. Two of the pool matches arrived during the audit.
- 12 are under 1,200 ticks (smoke tests and aborts) and were skipped.
- 40 were re-simulated on the audited build from their recorded intents, with no bots. A match counts as **faithful** if it
  reproduces its recorded outcome and its intent rejections stay ≤ 20%, the bots' own level (0–15%).
- **34 are faithful.** 6 diverged: they were recorded within one half-hour on older working-tree code, 39–78% of their
  intents were rejected, and their outcomes were not reproduced. They are excluded.

| Faithful set | Matches |
|---|---|
| Duels S48 / M64 / L80 | 26 / 3 / 2 |
| FFA (4 armies) S48 / L80 | 2 / 1 |
| Featured playlist / lobby | 27 / 7 |
| Bit-symmetric mirrors (every per-army number identical) | **26** |
| Outcome | 19 cut off while running, 11 draws at the time cap, 4 decided |
| Length | 508 match-minutes, 74 armies, 1,110 army-minutes |

Tiers are not recorded. Each army's Orbit tier was taken from its first centre scan: `scanCentreAt` is 60 s for standard,
45 s for veteran, and never for novice. That gives 47 standard, 12 veteran and 1 novice army, 11 that are standard or
veteran but unclear (scan delayed), and 3 empty lobby armies (`none`).

**Headless runs.** Three variants, each 3 seeds × 2 pairings × 6,000 ticks (5 min) on S48, through the shared lock.

- Same-tier mirrors tie, so every pairing is cross-tier.
- The baseline used standard vs veteran in both orientations. The swap turned out to replay the same match mirrored.
- The other two variants used standard vs veteran and veteran vs novice.
- Overrides went through match options only (`economy.startTugs`, `orbit.coreEnabled`); no code was changed.
- **Method:** `playBotMatch` and the re-simulation (`createGame` + recorded intents) were run with a
  `subscribeRecording` listener for core events, damage by cause, Orbit unit losses and the income ledger. The scripts
  were throwaway and are not committed.

### 2.2 Engagement per tier (recorded)

"Went" means the army ordered at least one `grapple` on the match's first core.

| Orbit tier | Armies | Went | Core grapples | Lifts | Cashes |
|---|---|---|---|---|---|
| novice | 1 | 0 | 0 | 0 | 0 |
| standard | 47 | 35 | 142 | **0** | 0 |
| veteran | 12 | 6 | 14 | 4 | 4 |
| standard or veteran (unclear) | 11 | 6 | 16 | 1 | 1 |
| empty army | 3 | 0 | 0 | 0 | 0 |
| **All** | 74 | 47 | 172 | **5** | **5** |

- **Symmetric mirrors** (26 matches): 19 of them sent tugs, 162 grapples, **0 lifts**.
- **Asymmetric matches** (8): 10 grapples, 5 lifts.

A trace of one symmetric match shows the tie step by step. Both tugs reach r = 2.0 on the same tick (8,780), the core stays idle,
both turn back at 136–144 HP, and the same happens on the next window.

### 2.3 Time to first lift, lifts and cashes per match

- **First decision to go**, standard: median 3.6 min.
- **First lift** in the 3 recorded matches with one: 2.5 min (FFA L80), 3.0 min (veteran vs standard), 5.2 min (veteran vs
  an empty army).
- **Lifts per match:** 5 lifts and 5 cashes over 34 matches, **0.15 per match**. That fails the plan's own target of
  "≥ 1 cash-in per match" (gameplay phase plan, private archive, W3 verify).
- **Lift to cash:** 27, 44, 53, 57 and 58 s.
- **Cash to next lift:** 175 s and 253 s, against a 150 s regrow.
- **Never observed, recorded or headless:** meltdowns, vents, drops, or a core shot down under tow.

### 2.4 Core share of income

Income averaged 909 per army-minute: 481 alloy and 428 energy.

| Scope | Share of all income |
|---|---|
| All armies | **0.20%** |
| Asymmetric matches | 0.81% |
| Veteran armies | 1.17% |
| Veteran vs an empty army (3 cashes in 15.3 min) | 9.4% of income, 10.2% of energy |
| Veteran vs standard (1 cash by 3.6 min) | 8.6% of income, 14.3% of energy |
| FFA L80 army (1 cash in 18 min) | 2.0% |

The design target is "core energy ≤ 15% of delivered energy for the holder" (W2-O1 verify). The single sustained taker,
the unopposed veteran, sits at 10.2%, just under it.

### 2.5 Orbit losses spent on it

- **Radiation:** 161 HP per army per 10 minutes and 54 radiation final blows over 1,110 army-minutes, about 0.5 per army
  per 10 min. These go to **warships, not tugs**. One 30-min standard mirror (`66276135`), per army: Lancers 443 HP,
  tugs 152, Bastions 120, Skiffs 29. Its kills were 2 Lancers, 1 Bastion and 1 Skiff. In mirrors both fleets "fight the
  intruders out" of the chamber at once and trade inside the radiation.
- **Losses within hull + 1 tile:** 462 of 943 Orbit unit losses (84.5k of 143.9k value). Most of this is not the core:
  the bots' idle-fleet gather point (`ruinPost`) sits at hull + 1.5 on the diagonal, so the main Orbit battles happen
  there.
- **Core-specific losses:** 0 meltdown or vent damage, and about 32 HP of radiation per successful lift (31 HP in the
  veteran-vs-standard lift).

### 2.6 Win rate with and without a cash; first-cash advantage

**Recorded matches cannot answer this.** Only 3 armies ever cashed:

- one won against an empty lobby army;
- one was the army eliminated in an FFA;
- one match was cut off while running.

Only 4 of the 34 matches were decided at all. Win rate by cash is **not measurable** from this data.

**Headless first-cash advantage**, 5-min income per army (`startTugs` 3 vs the same with `coreEnabled` off):

| Variant (S48, 6,000 ticks) | Pairing | Lift / cash (s) | Taker income | Opponent income | Taker / opponent radiation HP |
|---|---|---|---|---|---|
| baseline (defaults) | standard vs veteran, ×2 orientations | no lifts (0/6) | 6,433 (std) | 6,449 (vet) | 3 / 7 |
| `startTugs` 3 | standard vs veteran | 31 / 85–104 (3/3, standard takes it) | **6,553** | 6,212 | 39 / 54 |
| `startTugs` 3 | veteran vs novice | 44–77 / 75–109 (3/3; 2nd lift at 4.7 min in 2/3) | **6,799** | 4,136 | 135 / 0 |
| `startTugs` 3, `coreEnabled` off | standard vs veteran | – | 6,200 | 6,345 | 265 / 178 |
| `startTugs` 3, `coreEnabled` off | veteran vs novice | – | 6,517 | 4,059 | 180 / 0 |

- **Net value at 5 minutes.** One cash is worth **+353** to the standard taker and **+282** to the veteran taker. Against
  its opponent the standard taker swings **+486**.
- **This is an upper bound.** In the no-core variant, bots still send a tug into an empty chamber every window and burn
  in the radiation. That depresses the no-core baseline (§4, follow-up 3).
- **Nothing beyond income** shows at 5 minutes: no Spire was damaged, and Orbit unit counts were equal (14.3 vs 14.3).
- **Contest:** with a spare tug, standard beat veteran to the core in 3 of 3 seeds. The veteran never shot the tow down.

### 2.7 FFA: does it snowball?

No. In all three faithful FFAs it was taken less often, not more.

- **FFA 1** (4 × standard, S48, C4-symmetric): a four-way tie, 7 grapples per army and 0 lifts in 17.6 min.
- **FFA 2** (mixed tiers, L80): one army cashed at 3.4 min and was later the one eliminated (rank 4). The core
  regrew at 5.9 min and was never lifted again in the following 12 minutes.
- **FFA 3** (mixed tiers, S48): 3 grapples by two armies and 0 lifts in 11 min.

The centre is equidistant to every corner, so FFA latch races tie or end in mutual retreat.

---

## 3. Is it worth it right now?

These are expected values per tug at S48 defaults; the headless net figures are in §2.6.

| Use of a tug (or fleet) | Yield | Risk and cost |
|---|---|---|
| **Core, uncontested** | 400 per ~210 s cycle, at most ≈ 1.9 /s, half of it **energy past the delivery cap** | ≈ 32 HP radiation per run (repaired at the dock); tow time ≈ 1 min; the lift is public |
| Rocks: a second mining tug | One rock per map slot per 30 s. Mix 65/25/10% pebble / medium / large (30 / 150 / 400), 45% metal, 30% ice (×0.8), 25% slag ⇒ ≈ 67 resources per rock ≈ **2.2 /s for the whole side**, shared by all its tugs | Rock supply caps the side, not the tug count: a second tug adds well under 1 /s, a third almost nothing |
| Solar arrays (60 α each) | ≈ 1.4 e/s average (2 × light × ramp) | Energy above the delivery cap (6 /s base) only banks: arrays past about the fifth are near-worthless, whereas core energy bypasses the cap |
| Fleet: siege / contest | The core needs **no fleet** when uncontested | Contesting in the chamber costs 2.5 /s per ship on top of combat; in mirrors this kills Lancers and Bastions (§2.5) |

**Assessment: balanced to slightly strong, not a trap and not a must-take.**

- **For a player or agent with a spare tug:** it is clearly worth taking. It roughly doubles what that tug would add on
  rocks, it pays in capped energy, and it costs no fleet.
- **It does not decide matches.** Its ceiling is about 12–13% of average income for an unopposed taker, under the design's
  15% energy cap. A cash at 5 minutes is ~6% of income so far.
- **Contesting it is a fleet fight in radiation.** You win it only by trading well, which is the intended texture.

**Interesting to play and to watch?** The mechanics are rich: a public lift, a heat clock, vents, meltdown, the bomb
option, interception and a hidden chamber. But the bots never exercise them: 0 vents, meltdowns, drops or interceptions in
1,110 army-minutes. The Director's high-weight moments (`core_lifted` 10, `core_cashed` 12, `core_meltdown` 12) fire
about 0.15 times per match, and the heat and vent drama never fires. Today the core is almost invisible to viewers. Its
best moment is the lift at 30–75 s once bots engage, which would give every featured match an early Orbit objective.

---

## 4. Recommendation

**Leave the rule numbers as they are.** The core is not under-rewarded; it is under-played. Tuning the reward, regrow or
radiation cannot change bot engagement, because the bots never read those numbers when deciding whether to go: the gate
is tug availability. Any measurement of a tuned value before the bot fix would measure the bug.

### Named match rules: no change now, with triggers for the re-check after the bot fix

| Rule | Current | Proposed now | Re-check trigger → change | Predicted effect of that change |
|---|---|---|---|---|
| `coreRewardAlloy` / `coreRewardEnergy` | 200 / 200 | unchanged | Taker's core energy > 15% of delivered energy, or first-cash win edge > 60% → 200 / 150 | Takes the cap-exempt part from ≈ 0.95 to ≈ 0.7 e/s; net 5-min edge ≈ +300 → +250 |
| `coreRegrowTime` | 150 s | unchanged | < 1 cash per match with fixed bots → 120 s | Best cycle 210 → 180 s (+17% cadence), about one more core per 22 min |
| `derelictRadiation` | 2.5 /s | unchanged | Warship radiation kills stay > 0.5 per army per 10 min after the bot fix → 2.0 | Sealed span 70 → 56 HP; contest fights in the chamber become less lethal. Prefer fixing the bots' contest logic first |
| `coreTransitHeat` / `coreTowSpeed` | 1 /s / ×0.4 | unchanged | Leave. Observed lift-to-cash times were 27–73 s, so heat on arrival stays ≤ ~75 of 100: the clock bounds a human's detours and interception without forcing vents | – |
| `startTugs` | 1 | unchanged | Not a core rule. It is used here only as the experiment lever | – |

**One structural question for the owner, not a named rule.** The hostile tie in `latchCore` ("two hostile alliances in
reach: nobody latches") deadlocks every exactly symmetric match: same-tier featured duels and C4 FFAs. It is fair for
humans and agents, who are never bit-identical. For the featured playlist it removes the objective entirely. The
alternatives are:

- **Bot side (preferred, no rule change):** stagger or jitter the core run, or fight-move the fleet in on the next window
  to break the tie, as `planes/derelict.md` already tells agents to do.
- **Sim side:** a deterministic C2/C4-fair tie-break, for example the core stays put but the tied tugs are pushed apart.
  That is a rework item with symmetry tests (`test:mirrors`).

### Smallest confirming experiment, once follow-up 1 is fixed

- **Setup:** the same harness and lock budget as here. Default rules (no `startTugs` override), 3 seeds × {standard vs
  veteran, veteran vs novice} × 6,000 ticks, with `coreEnabled` on and off.
- **Pass if:**
  - every match lifts the core within 2 minutes;
  - the taker's net 5-min income gain is +200 to +400;
  - no tug dies to radiation.
- **Then:** one full-length 20-match standard-vs-veteran set (the balance runner), checking a first-cash win edge ≤ 60% and
  the taker's core energy share ≤ 15%. Only if a trigger in the table fires, try that one change as the single variant.

### Bot behaviour follow-ups

**Status:** 1, 3, 4 and 6 are fixed in the bots (and so in the starters); 2 is
handled bot-side without a `latchCore` change: a tie backs the tug out, the fleet holds the rival's gate mouth from
outside the ring on the next window, and tier `coreTies` tied windows in a row rest the core work `coreTieRest`.
Exact mirrors still never lift it, by construction; any real asymmetry decides. 5 is unchanged.

1. **The two-free-tugs gate starves the core.** At `orbit.ts:261` + `:586` (and `policies/orbit.js:112` +
   `lib/orbit-core.js:190`) the bot counts free tugs against `CORE_TUGS_MIN`. The comment intends "new grapples leave a
   tug on the rocks", so the check should count all tugs, including miners. Standard and veteran keep 2 tugs (`tugs: 2`),
   so with any mineable rock the core is never taken. Evidence: a spare tug (`startTugs` 3) gives a lift in the first
   window in 6 of 6 runs, against 0 of 6 at defaults.
2. **Mirror deadlock.** Same-tier mirrors send identical tugs and tie forever: 162 grapples and 0 lifts in 26 recorded
   mirrors. Each attempt chips 6–14 HP of radiation off both tugs. This needs a tie-break (see above).
3. **Tugs fly into radiation when the core is off.** With `coreEnabled: false` but the ruin on, there is no
   `core_regrows` entry and the chamber is hidden, so a tug heads into the empty chamber every window (`orbit.ts:580–628`).
   Radiation rises from 40–135 to 180–265 HP per army in 5 min, and tugs died in 2 of 6 runs. The bot should check
   `econ.coreEnabled`. The example policy should check the rules the same way.
4. **Contest fights happen inside the radiation.** In mirrors both fleets take the "fight intruders out" branch together
   and trade inside the chamber. Warships (Lancers first) take most of the radiation and the radiation final blows.
5. **Dead features in bot play:** 0 vents, 0 drops (veteran `coreBomb`), 0 shoot-downs of an enemy tow, and the veteran
   lost the race to the standard bot in 3 of 3 seeds despite `coreEarly`. Worth a scripted test once follow-up 1 lands.
6. **Stale comments** (code only, not agent-facing):
   - `bots/orbit.ts:405` says "its power field lights every array in it, so it rides with our array cluster", and
     `bots/tuning.ts:90` says "power the arrays with it". The power field (`coreYieldOutside`) was replaced by the one-off
     cash-in.
   - `apps/web/src/tools/readiness.ts:243` says "the price is a share of the core's charge"; there is no charge any more.

No agent-facing text was found wrong: the briefing `orbit/derelict`, `planes/derelict.md`, the manifest and the client
tooltips match the rules above. So no doc fix was made and no bench re-pin was needed.
