# Per-plane supply instead of one team popCap

> **Design memo, analysis only.** Nothing here is implemented. The measurements are a 6-match headless run on the
> revision it was written against (method in the appendix), plus the balance reports they are compared with. They are
> not a balance sweep. `DESIGN.md:N` citations point into the design doc at that revision; it has since been rewritten
> (current: [DESIGN](../DESIGN.md), [ROADMAP](../ROADMAP.md)).

**Question.** Should the single team-wide `economy.popCap` (160 units alive per army; there is also `structureCap`
30) be replaced by **per-plane population caps that supply structures raise**, the way StarCraft supply depots
work? There would be no global max, only a max per plane, so "every plane really does end up having a primary job"
("Surface controls pop by building depots"). Three variants:

- **A. Surface supplies everyone:** Surface depots raise every plane's cap.
- **B. Each plane supplies itself:** Surface depots, Sky islands or relays, Orbit arrays or stations, Depths
  chambers.
- **Hybrid:** a per-plane base cap from the Spire segment, plus supply buildings.

**Short answer.** Variant A is a bad idea. B and the hybrid could work, but nothing shows the game needs them:
the cap never binds today. Bots peak at 44 of 160 units (27.5%) and never once wait on `pop_cap`. Any supply
system only bites if its numbers are set low enough to bind, and that is a new economy constraint, not a
clean-up. Run the experiments in §4 before building any supply structure.

---

## 1. Today's behaviour

### 1.1 What the rules do

| Rule | Default | Where | Effect |
|---|---:|---|---|
| `economy.popCap` | 160 | `rules/econ.ts:664`, `match-rules.ts:60` (int 1–240) | Most units alive per army, **all four planes pooled**. "Production waits at the cap." |
| `economy.structureCap` | 30 | `econ.ts:665`, `match-rules.ts:61` (int 1–60) | Most structures per army, sites included; the Spire and lava bridges do not count (`sim/combat.ts:817-818`). |
| `queue.recoverySupply` | 2 | `econ.ts:660`, `match-rules.ts:428` (int 0–16) | Pop slots ordinary units leave free while the army has fewer than `queue.recoveryWorkers` (2) live plus paid diggers. |

Mechanics:

- **Counting.** `ArmyState.pop` goes up on every spawn (`sim/spawn.ts:78`, the Shaft-digger path
  `production.ts:409`, the Aerie airdrop `agent/intents.ts:282`). It goes down on death (`combat.ts:829`) and
  when a Gunship becomes a Gun Platform (`planes/sky.ts:152`): the platform moves from population to
  `structureCap`. Pop counts each unit wherever it is, so a trooper sent down a Shaft or an interceptor on an
  Ascent raid still counts once for its army.
- **Queue block.** `Sim.queueBlock` (`sim/production.ts:441-450`) marks a unit entry `pop_cap` when
  `pop + started unit entries ≥ popCap − headroom`, where `headroom = min(recoverySupply, recoveryWorkers −
  viableWorkers)`. Replacement diggers ignore that headroom (`recovery = e.item === 'digger'`). The waiting
  reason is `pop_cap` in `QUEUE_REASONS` (`rules/vocabulary.ts:122,133`). A blocked head keeps its backing only
  for `queue.blockedGrace` (5 s, `econ.ts:659`), then releases it (`production.ts:161`).
- **Admission.** `queue_add` for a Shaft-produced unit fails `queue_full` at the cap (`intents.ts:906`). The
  Aerie airdrop checks the same headroom (`intents.ts:271-272`).
- **Visibility.** The observation's `res` has **no pop or cap field** (`agent/present.ts:607-626`). The web HUD
  shows population nowhere. The only visible traces are the queue reason "Pop cap"
  (`apps/web/src/queue-panel.ts:79`, `text.ts:351`) and one briefing line, "Max 160 units per team"
  (`agent/docs/economy.ts:104`). The dev `ac_god` dump shows `pop` (`agent/adapter.ts:140`).
- **Bots never read it.** No file under `packages/game/src/bots/` mentions `popCap`. Each tier stops itself much
  earlier, through its own targets in `bots/tuning.ts`. Surface `armyCap` is 16/30/45 for
  novice/standard/veteran (lines 218, 294, 369). Veteran wants about 10 diggers, 3 sappers, 3 Wardens, 4
  interceptors (+2 screen pairs), 2 bombers, 3 gunships, 8 solars, 2 tugs and 3 Lancers.

### 1.2 How often bots hit it

`.data/history` holds one 57-second operator match, so there are no replays to mine. The balance reports record
units per plane but not cap pressure. To fill that gap I ran the smallest measurement: 3 seeds × {standard,
veteran} mirrors, default ridges C4 duel (nw vs se), 6000 ticks (5 min). It took 36 s of CPU in total, under
`flock -w 300 /tmp/ac-test.lock taskset -c 0,1 nice -n 15`. Each match was sampled once per game second,
1,800 army-samples per tier. The two armies were bit-identical in every match, as the mirror guarantees.

Peak units alive per army: the min–max of each phase's peak over the 3 seeds. A plane's count is by the plane the
unit is on.

| Tier | Phase | Total (cap 160) | Depths | Surface | Sky | Orbit | Structures (cap 30) | Samples ≥ 158 | Samples with a `pop_cap` entry |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| standard | 0–2 min | 23–29 | 8–11 | 7 | 3–5 | 7–9 | ≤ 3 | 0 | 0 |
| standard | 2–4 min | 36–40 | 11 | 7–11 | 6–7 | 12–14 | ≤ 7 | 0 | 0 |
| standard | 4–5 min | 34–38 | 11–13 | 5–10 | 3–6 | 13–17 | ≤ 7 | 0 | 0 |
| veteran | 0–2 min | 20–27 | 8–11 | 7 | 3–4 | 7–9 | ≤ 3 | 0 | 0 |
| veteran | 2–4 min | 37–41 | 13–16 | 7–9 | 4–5 | 13–15 | ≤ 7 | 0 | 0 |
| veteran | 4–5 min | 42–44 | 16–18 | 7–9 | 4–5 | 15–17 | ≤ 7 | 0 | 0 |

There were zero `queue_full` rejections of `queue_add` in any match.

The balance reports cover the whole match and novice. They give **mean** units alive per army at 1/3/5/10 min:

- [combined-b2](../balance/combined-b2.md#units-per-plane-mirrors): totals 20.8–30.5. Novice holds a flat
  ~26 (5 / 13–16 / 3 / 2–3).
- [phase-a](../balance/phase-a.md): totals 14.1–26.2.
- ffa-stage2 (private archive): four-army FFA, 16.0–37.0 per army. The largest is M64 standard
  at 10:00, at 9 / 16 / 4 / 8.

DESIGN §2 targets "~15–30 units per side across planes" by 3:00 (`DESIGN.md:44`).

**Findings.**

1. **No tier hits `popCap`, on any plane, in any phase.** The highest total ever seen is 44, 27.5% of the cap.
   Novice cannot reach it at all: its own targets sum to about 30.
2. **Bots stop at their own targets or run out of money first.** The economy binds; population does not. Surface
   in particular stays far below its `armyCap` (peak 11 of 30–45): alloy and losses limit it.
3. **The mix by plane is stable.** Depths is the biggest plane in veteran, Orbit the biggest in the standard late
   game (mostly solar arrays, which are units), and Sky the smallest (3–7). Depths and Orbit population is mostly
   **economy workers** (diggers, arrays, tugs).
4. **`structureCap` does not bind early either** (peak 7 of 30 at 5 min).

So today `popCap` is a safety valve against degenerate spam (for example 160 interceptors), not a pacing tool.

---

## 2. Gains and risks of each variant

Common ground for every variant:

- **Count each unit on its home plane** (`STATS[kind].plane`), not the plane it stands on. Otherwise
  `descend`/`emerge` troopers (the Depths Warden push asks for 3–4, `troopersDown`), Aerie airdrops and Ascent
  interceptors (`TRANSITS`, `rules/stats.ts:65-87`) would fail or flip supply in mid-move.
- **Over the cap, units never die.** Production just waits, as SC2 does.
- An airdropped trooper is a Surface unit that the Sky seat paid for, so it uses Surface supply.

### 2.1 Plane identity

- **A (Surface depots):** this adds a Surface job but takes one from the other planes, because three seats' unit
  counts become the Surface's decision. The Surface already is the win condition and "the front"
  (`DESIGN.md:218`). DESIGN gives "logistician" to **Orbit** (`DESIGN.md:318`), not the Surface. Surface depots
  do fill a real gap, though: Pillar 4 shows the Surface as the one plane with **0 meaningful actions in the
  first 60 s** in every mirror ([combined-b2 Pillar 4](../balance/combined-b2.md#pillar-4-meaningful-actions-in-the-first-60-s)).
  An opening depot would count as one.
- **B (each plane supplies itself):** this fits the §5.1 pattern. Each plane has a main job (Depths alloy, Orbit
  energy, Sky delivery, Surface the line) and its own way to recover (`DESIGN.md:374-381`). It adds a chore on
  every plane, but a chore is not a job: it creates no new cross-plane verb. Sky supply from held islands is the
  best fit, because holding islands already is the Sky's verb. An Orbit "station" would be the first Orbit
  **structure** kind ever, since Orbit has none in `STATS` (`stats.ts:153-199`). Supply from solar arrays is
  circular, because arrays are units that use Orbit supply themselves.
- **Hybrid:** the base supply from the Spire segment makes the segment worth more on every plane, which suits
  the crowns loss rule (`DESIGN.md:36`). Identity then comes from the per-plane supply source, as in B.

### 2.2 Raid targets

- **A:** every depot is a priority raid target for all three hostile neighbours: bombers, breaches, collapses,
  asteroids and Island Mortars all hit Surface structures (`DESIGN.md:162`, the most-threatened plane). That is
  good for tempo raids. It is also a single point of failure (§2.3).
- **B:** each plane's supply is a target answered from a different plane, as §11.1 demands (`DESIGN.md:777`):
  - Depths chambers: sappers, breaches, collapses.
  - Sky islands: captures, flak.
  - Orbit stations: Lancers, Ascent raids.
  - Surface depots: everything above.

  This is consistent, but it is four more things to defend.
- **Hybrid:** like B, and the Spire segment's base supply is also a target. Segment damage already has
  telegraphs and a rebuild path (`spire.rebuilds`, `DESIGN.md:399`).

### 2.3 Cross-plane dependency and the "kill Surface, cripple everything" snowball

- **A, high risk.** Losing depots freezes production on all four planes. Depths and Orbit population is mostly
  workers, so a depot raid also **stops alloy and energy growth**. Then the depots cannot be rebuilt quickly.
  That runs against "Losing a plane hurts a lot but never ends the economy" (`DESIGN.md:374`). Under the default
  `spire.lossRule: surface` the Surface segment is already the life, so A puts the win condition *and* everyone's
  supply on one plane. The worst case: an Island Mortar or bomber depot raid while the Depths is replacing
  diggers. `recoverySupply` only protects 2 digger slots, so the alloy recovery path dies.
- **B, low risk.** Losses stay local. A Sky that loses its islands cannot rebuild its own air, much as losing
  Relays already caps energy delivery.
- **Hybrid, medium risk.** A fallen segment takes away its plane's base supply. That doubles the cost of losing a
  segment and conflicts with the §5.1 fallbacks. Shaft diggers are queued while the Depths root is down
  (`DESIGN.md:393`), and with no Depths base supply they could be blocked forever. **Required:** a floor kept
  after the segment falls, at least `queue.recoveryWorkers`.

### 2.4 FFA and 4-army scaling

- A gain for **every** variant: the per-plane ceiling bounds how many entities can crowd **one plane**. Today an
  army can put all 160 units on one plane, and four armies can put 640 there. With a 40-per-plane ceiling that
  worst case drops to 160. That helps focused-plane performance (still "outstanding", `DESIGN.md:15`) and the
  observation bound (128 KiB, tested with a 600-entity fixture, `docs/balance/README.md`). The memory and frame
  benefit is `[INFERENCE]`, not measured.
- **A:** in FFA the third army picks off whichever army's depots are exposed, so the snowball compounds. Two
  attackers can freeze a third on four planes at once.
- **B and hybrid:** no cross-army effects. Supply is per army, so no new tie-break or order dependency appears.
- Colour alliances (stage 3, `DESIGN.md:1426`) need a decision in any variant: do allied depots supply allies?
  Recommend no; supply stays per army.

### 2.5 Agent and policy workload

- Supply is a routine chore, and policies handle routine well: "keep supply ≥ used + one production cycle" is
  about 10 lines in `policies/lib/common.js`. That is the paradox. A chore a policy does perfectly creates no
  decision, so it adds no identity for agents. It only taxes LLM agents on slow cadences and humans.
- **A** also adds coordination: Sky, Orbit and Depths cannot queue Surface items (role authority,
  `DESIGN.md:426`). They need a new `request_support` need `supply` (vocabulary `rules/signals.ts`,
  `DESIGN.md:692`), and the Surface must answer it. That fits the game's theme ("bring your agents"), but it also
  stalls three seats whenever the Surface seat is an AFK human or a slow agent.
- **B and hybrid:** each seat looks after itself. The new obligation (observe `supply`, build when short) goes into
  four role docs, four example policies and each bot.

### 2.6 Novice vs veteran bots

- Novice bots think every 4 s and queue one entry deep (`tuning.ts:204-206`). Each supply block costs them more
  than it costs veterans. That widens the veteran>novice gap, which helps a guardrail that already passes 48/48,
  and slows novice further. Novice mirrors already run 28–30 min, the cap, and are exempt from the length rule
  (`docs/balance/README.md`, Phase A).
- Veteran's bigger Depths and Orbit crews (peaks 18 and 17) would hit low caps first. Supply would then cap the
  tier's economic advantage, unless the caps follow the veteran targets.
- Bots need explicit build-ahead logic. Without it, the binding caps leave lanes blocked for whole decision periods.

### 2.7 UI clarity

- Today population shows nowhere (§1.1), so any variant must add it first:
  - a HUD supply chip for the focused plane (used/cap);
  - four supply rows in the resource tooltip;
  - a `res.supply` observation field;
  - observer scoreboard cells: 4 per army, so 16 in FFA;
  - the queue reason gains its plane ("Sky supply").
- **A** is the easiest to explain ("Surface builds supply") and the hardest to read: the cause sits on another plane.
- **B** needs four different supply sources taught and drawn, and a new art kit for each new kind
  (`docs/art/DIRECTIONS.md`).

### 2.8 Shared economy lanes and the queue's worker recovery

- **Gain for every variant:** production lanes are already per output plane (`DESIGN.md:420-432`), so per-plane
  caps fit them better than one global cap. Today, in principle, one plane's spam can block another lane with
  `pop_cap`. Per plane, a supply block stays inside its own lane.
- **A:** depots are Surface-lane items. They compete with the Surface's own head under `laneSlots` 1 and
  `seatMax` 8, and they spend the shared bank on other planes' behalf. One lane carries four planes' needs, which
  goes against lane fairness.
- **Recovery:** `queue.recoverySupply` becomes a Depths-only reserve. Recommended rule: replacement diggers below
  `queue.recoveryWorkers` **ignore supply entirely**, as they already ignore the headroom
  (`production.ts:448-449`). Recovery then never depends on a depot (A), a chamber (B) or a live segment
  (hybrid). A blocked head's holds release after `queue.blockedGrace`, which stays the same.
- `structureCap` 30 applies to supply structures too. Either count them (an opportunity cost; bots used 7 of 30
  by 5 min) or exempt them like lava bridges (`combat.ts:817`). Decide this explicitly.

### 2.9 The mirrored C2/C4 symmetry rules

- The rules are the same for every army, recorded with the seed, and placement is mirrored, never per army
  (`DESIGN.md:51`). Supply is per-army arithmetic, so it adds no tie-break that depends on army order. **Low
  risk.**
- **Real risk: bot depot placement.** A new site picker must choose cells in the canonical frame. The
  extended-mirror fixes record what broke before: anchors mirrored as world points rather than cells
  (`DESIGN.md:838`). `test/mirror.test.ts`, `determinism.test.ts` and `bots-ffa.test.ts` must cover the new
  builder. Sky supply from islands is symmetric by construction (complete C2/C4 island groups). An Orbit station
  must follow the four-wedge sun in C4 (`DESIGN.md:1128`).
- State hashes change in every variant: `ArmyState.pop` becomes per plane, and the digest covers it.

---

## 3. Changes required

### 3.1 Rules: every number a named match rule

Replace `economy.popCap` with a new `supply` scalar group (`match-rules.ts`, the same `scalarGroup` pattern as
`queueRules`; ECON keys `supply*`). `structureCap` stays in `economy`.

| Rule | Variants | Suggested start | Purpose |
|---|---|---|---|
| `supply.max.{depths,surface,sky,orbit}` | all | 40 each (= 160 total, parity) | Hard per-plane ceiling (the SC2 200). Replaces `economy.popCap`. |
| `supply.start.{plane}` | A, B | 12 / 12 / 8 / 14 (≈ standard 5-min peak, §1.2) | Supply each plane has with no supply structures. |
| `supply.base.{plane}` | hybrid | as `start` | Granted while that plane's Spire segment lives. |
| `supply.baseFallen.{plane}` | hybrid | Depths ≥ `queue.recoveryWorkers`, others 4 | Floor kept after the segment falls (the §5.1 fallback). |
| `supply.depot` | A, B | A: +3 on each plane; B: +6 Surface | Supply one Surface depot adds. |
| `stats.supply_depot.{alloy,energy,build,hp}` | A, B | 100 / 0 / 10 s / 400 | Through the existing `stats` rules (footprint 2×2 in `STATS`, not a rule). |
| `supply.island` | B, hybrid | +3 per own island with a built main slot | Sky supply; held islands, not a new kind. |
| `supply.chamber`, `stats.chamber.*` | B, hybrid | +4; 60 / 0 / 5 s / 300 | Depths: a digger-built 1×1 tunnel structure (the bulkhead/geothermal build path). |
| `supply.station`, `stats.orbit_station.*` | B, hybrid | +4; 120 / 40 / 12 s / 300 | Orbit: the first Orbit structure kind. Alternatively give the planned capacitor (§5.2) supply. |
| `supply.structuresCount` (bool) | all | true | Whether supply structures count toward `structureCap`. |
| `queue.recoverySupply` | all | 2, Depths only | Re-scoped: the Depths reserve for replacement diggers. |

The plane each unit counts on is not a rule. It is fixed: `STATS[kind].plane`.

### 3.2 Code surfaces

- **Sim and rules:**
  - `rules/econ.ts`, `match-rules.ts`; `stats.ts` and `vocabulary.ts` (`BUILDABLE`, new kinds,
    `QUEUE_REASONS`: keep `pop_cap`, the plane is implied by the entry's lane);
  - `ArmyState.pop` becomes `Record<Plane, number>`, with every ± site in §1.1 and the digest;
  - `production.ts` `queueBlock`; `intents.ts:271-272, 906`;
  - supply-structure build and death bookkeeping;
  - a check that a new structure kind passes the fog and memory (ghost) rules.
- **Observation, contract and briefing:**
  - `present.ts` `res.supply {plane: {used, cap}}` and its schema in `rules/observation.ts`;
  - `agent/docs/economy.ts` CAPS line, `agent/docs/planes.ts`, the role docs;
  - A: the `request_support` need `supply` in `rules/signals.ts`;
  - then re-pin the bench surface with `pnpm bench:pin` and commit `bench/surface.ts` (§15.9); saved policies need
    activation re-validation.
- **Bots:**
  - every plane bot keeps headroom (A: Surface `bots/surface.ts` builds for all and answers `supply` signals;
    B: each of `depths*.ts`, `surface.ts`, `sky.ts`, `orbit.ts`);
  - a canonical-frame site picker (`bots/posts.ts`/Surface site helpers);
  - tier knobs in `bots/tuning.ts` (`supplyAhead`, by tier).
  - **Note:** `bots/depths*`, `bots/tuning.ts` and the Depths policy lib are being edited by other agents right now,
    so any bot work must be scheduled after them.
- **Policies and skill:**
  - `skills/agent-command-strategy/policies/{depths,surface,sky,orbit}.js` and `lib/common.js`;
  - `economy.md`, `queue-and-teamwork.md`, `signals.md` (A), the plane docs, `SKILL.md`.
- **UI:**
  - `apps/web/src/queue-panel.ts`/`text.ts` reason wording;
  - a HUD supply chip and resource tooltip rows;
  - the disabled reason on command-card production buttons;
  - placement preview and a model for each new kind; icons; observer scoreboard and phone strip;
  - rules-editor fields come from the schema for free.
- **Tests:**
  - `queue.test.ts` and `queue-recovery.test.ts` (they assert `popCap` today: lines 421-432 and 108-121);
  - mirror, determinism, bots-ffa, fog and briefing-size tests.
- **Tooling:**
  - `src/metrics/metrics.ts`: per-plane supply-blocked seconds and peak supply, so sweeps report them;
  - balance probes for a forced depot raid.
- **Docs:** DESIGN §2.1, §5 (a new §5.x Supply), the plane tables in §4, §10 HUD; CHANGELOG.

### 3.3 Rough effort (one engineer, including tests and docs, excluding sweep CPU time)

| Work | Estimate |
|---|---|
| Fixed per-plane caps only (`supply.max`/`start`, no structures; bots unchanged, since the queue already waits) | 2–3 days |
| + Variant A (one Surface kind, the `supply` signal, Surface bot and policy, a HUD chip, art) | + 7–10 days |
| + Variant B (four sources, incl. the first Orbit structure and a Depths chamber, four bots and policies, four art kits) | + 18–25 days |
| + Hybrid base on top of A or B (segment hook, fallen floor) | + 1–2 days |
| Acceptance sweep (the 100-match combined set plus a depot-raid probe) and retuning | 2–4 days |

---

## 4. Recommendation

**Do not build variant A.** It puts the win condition, the most-threatened plane and all four planes' production
on one target. Its snowball cuts straight through the §5.1 promise that a lost plane never ends the economy. It
also sends the Surface's lane money to other planes. Its one real gain is a Surface job in the first 60 s, and an
opening build that is not a supply dependency would give the same gain.

**Do not build any supply structures yet.** The data in §1.2 shows the cap never binds (peak 44/160, no
`pop_cap` waits). The economy limits every plane first. A supply system therefore matters only if its numbers
bind, and that would be a new pacing constraint on the economy planes' workers. Nothing shows the game needs it.

**If the owner still wants per-plane identity through supply, choose the Hybrid-B form:**

- a per-plane base from the live Spire segment, with a fallen floor;
- local supply sources answered from other planes. Sky islands come first: they need no new kind and reinforce
  the Sky's verb.
- replacement diggers exempt from supply;
- supply structures counted toward `structureCap`.

It keeps losses local, fits the per-plane lanes and adds the FFA per-plane entity bound.

**Smallest experiments that would prove it, in order:**

1. **E0, no code.** Can a binding global cap matter at all? Run `ac_sweep` (or `tools/balance sweep`) with the
   existing rule `economy.popCap` set to 160, 40 and 30. Use 6 seeds × standard and veteran mirrors plus veteran vs
   standard on ridges, reading the existing report columns: length, veteran win rate, units per plane, Pillar 4.
   If 30–40 changes nothing but length, caps are not a lever for plane identity.
2. **E1, the 2–3 day branch** (fixed per-plane caps only, §3.3 row 1). Set `supply.start` at the
   §1.2 standard peaks (binding for veteran Depths/Orbit), then at 75% of them. Add per-plane supply-blocked
   seconds to `metrics.ts`. Success criteria:
   - mirrors stay in 10–15 min;
   - veteran still beats standard;
   - no plane spends more than 20% of the match supply-blocked;
   - the units-per-plane mix becomes more even (Sky's share goes up).

   If E1 fails these, no structure-based variant can succeed: its caps would be at least as tight.
3. **E2, only if E1 passes:** add Sky island supply (`supply.island`) and a forced "island-raid" probe. It must stay
   under the 65% probe ceiling (`DESIGN.md:781`). Only then consider depots or chambers.

---

## Appendix: measurement method

Throwaway script (deleted after the run; not committed). It was run from a worktree of that revision, with
`packages/game` imported directly:

```ts
// playBotMatch (bots/play.ts) with onTick every 20 ticks:
//   per army: t.pop, t.structures, units alive by e.plane, t.queue.some(e => e.reason === 'pop_cap');
//   onIntent: count queue_add results with code 'queue_full'.
// options: { terrain: 'ridges', map: { params: { slots: 4 } } }, armies slotArmyIds(2) (C4 duel, as ac_sweep's sweepSetup)
// levels standard|veteran on both armies, seeds 1–3, maxTicks 6000.
```

Command:
`timeout 1500 flock -w 300 /tmp/ac-test.lock taskset -c 0,1 nice -n 15 node /tmp/ac-pop-measure.ts standard,veteran 1,2,3 6000`.
All matches were still running at 6000 ticks. Wall time was 4.8–9.1 s per match.
