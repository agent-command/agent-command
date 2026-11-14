# Balance reports

Sweep, guardrail and exploit-hunt reports configured by [`tools/balance`](../../tools/balance) (DESIGN §11) and executed by PlayerThree's canonical series runner. Each heterogeneous run set has its own `SeriesSpec`, preserving its seeds, side permutations, policies, options and guardrails without cross-pairing unrelated sets. `--workers` controls concurrent matches (`0` means serial). Sweeps retain their detailed markdown/JSON projection and write canonical `playerthree.results` envelopes and artifacts under `bench-results/balance-<label>/<set>/`; exploit-hunt evaluation uses `bench-results/hunt-<role>-v<version>/<set>/`.

The policy reference config authors its model once with the shared six-turn, 120,000-token, $1 and 60-second limits, then evaluates the deployed surface policy on held-out seeds 17011/29009 against all three tiers in both orientations (12 matches). Practice remains restricted to seeds 17/29. Match schedules retain resolved rules/map hashes and logical entrant-to-physical-side bindings. Raw exports contain no provider credentials; unavailable usage stays `null`. Historical reports below describe their recorded revisions, not a current-map balance certification.

Reference bot and policy series use an explicit accelerated simulation multiplier of `1000`; `--workers` controls concurrency independently. A multiplier of `1` would pace game time at real-time speed even with the accelerated clock.

| Report | What |
|---|---|
| [baseline-pass2](baseline-pass2.md) | Pass 2 baseline: the reference point for the Phase A sweeps |
| [hunt-pass2-smoke](hunt-pass2-smoke.md) | Exploit-hunt smoke run on pass 2 (surface seat, gpt-5-mini, $0.06) |
| [phase-a](phase-a.md) | Final Phase A sweep: 1608 matches on open, ridges and canyons; all 66 guardrails pass |
| [hunt-phase-a](hunt-phase-a.md) | Exploit hunt on Phase A: four roles, gpt-5-mini, $0.16 |
| [phase-a-rail-economy](phase-a-rail-economy.md) | Confirmation of the hunt's rail-economy finding as a probe |
| [lode-zones](lode-zones.md) | Short paired lode-zone diagnostic: six seeds × three terrains × standard/veteran, a baseline revision versus the lode-zone revision; not a full acceptance sweep |
| [research](research.json) | Controlled 36-match research-content smoke: the build without research versus the research candidate; summarized below |
| [checkpoint-b1](checkpoint-b1.md) | Checkpoint b1: small 100-match sweep (4 seeds per set, 2 per probe); 18/22 guardrails pass; match length and two probe ceilings fail |
| [combined-b2](combined-b2.md) | Combined 100-match baseline: 20/22 pass; veteran length and breach-ambush/standard fail |
| [balance-b2 diagnosis](balance-b2-diagnosis.md) | Source-attributed Spire damage, attack timings, army samples, screen-reserve deadlock and legacy Orbit probe mechanism; rejected Orbit experiment retained separately |
| [balance-b2](balance-b2.md) | Retained dead-Sky reserve repair; two rejected 100-match experiments and explicit residuals; no final 22/22 claim |
| [pacing-diagnosis](pacing-diagnosis.md) | Post-b1 pacing diagnosis behind the b2 pacing changes |
| [bot-dig](bot-dig.md) | Depths bot designation sweep: 72 paired matches, a baseline revision versus the `bot-dig` candidate |
| [mounts-sweep](mounts-sweep.json) | Raw paired data from the weapon-mounts (move-by-default) check against the build before mounts: identical outcomes, no added side bias |
| [tier-ladder](tier-ladder.md) | Tier ladder on the ACBench maps with the early-rush defence and breach fixes: 96 full-length matches; veteran does not beat standard (0–2–46) and loses to the novice's rush on crown |

## Research-content smoke

[Raw paired results](research.json): seeds 1–6, standard/veteran mirrors on all three presets, capped at 720 seconds. All 72 candidate teams completed Ascent Thrusters. Completion times are sampled to the next second; usage/damage totals below combine six matches. Orbit damage is inflicted by blue/red respectively.

| Level / preset | Research median (s) | Lancers / shots | Ascents / Orbit shots | Orbit damage blue / red |
|---|---:|---:|---:|---:|
| Standard / open | 111 | 14 / 378 | 163 / 2553 | 6073 / 6883 |
| Standard / ridges | 116.5 | 13 / 154 | 155 / 2610 | 5704 / 3204 |
| Standard / canyons | 119.5 | 14 / 212 | 127 / 2270 | 3366 / 3222 |
| Veteran / open | 150.5 | 12 / 144 | 30 / 358 | 180 / 180 |
| Veteran / ridges | 161.5 | 12 / 144 | 42 / 686 | 1161 / 1161 |
| Veteran / canyons | 146.5 | 12 / 170 | 32 / 476 | 207 / 207 |

The baseline had no research, Lancers, Ascent or Orbit-segment damage. Candidate totals: 77 Lancers / 1202 shots, 549 ascents / 8953 Orbit shots, 31,548 Orbit-segment damage; 10 bombers / 34 shots versus the baseline's 1 / 4. The first candidate completed no research because bomber replacement and spare-funds gates starved it; reserving the upgrade's place in the shared queue fixed this, without free resources or reduced costs.

Side outcomes (blue wins / red wins / draws / still-running at cap): baseline **2 / 5 / 11 / 18**, candidate **1 / 0 / 3 / 32**. Candidate Orbit damage split was **16,691 / 14,857**. Six seeds per set and so many capped matches cannot establish side fairness or full-match pacing; this is content-usage evidence, not a balance-guardrail pass. This controlled comparison does not include Designations.

### Policy sandbox headroom

The research observation does not serialize capability flags, cached stats or the upgrade registry per entity. Relative to the baseline, match rules add 305 JSON bytes and the research state adds 76 bytes on the seed-21 example-policy fixture; ascent timestamps are sparse, dynamic entity fields. A capped 600-entity fixture now guards a 128 KiB observation ceiling without a timing assertion.

Static-match payload cutover (`obs-diet`): resolved rules, packed terrain, faults, Spire centres,
sun parameters, jet lanes and fog paths now travel once through the match bootstrap; each tick keeps a numeric
`rulesHash`. The fixed time cap is derived from bootstrap rules. No observation cap or policy CPU limit changed.

UTF-8 compact `JSON.stringify` measurements below estimate tokens as `ceil(bytes / 4)`; these are not tokenizer
counts. The busy fixture is the research regression's seed 9 with completed Ascent research and 600 interceptors
carrying active transit timestamps. The normal fixture is seed 3, standard bots on both teams, 3,000 ticks
(150 game seconds), with decisions every 20 ticks in blue/red plane order and 63 observed entities.

| Fixture / role | Before bytes | After bytes | Before estimated tokens | After estimated tokens |
|---|---:|---:|---:|---:|
| Busy 600 / Depths | 130,474 | 123,417 | 32,619 | 30,855 |
| Busy 600 / Surface | 125,856 | 118,799 | 31,464 | 29,700 |
| Busy 600 / Sky | 127,147 | 120,090 | 31,787 | 30,023 |
| Busy 600 / Orbit | 125,854 | 118,797 | 31,464 | 29,700 |
| Normal mid-match / Depths | 23,473 | 16,838 | 5,869 | 4,210 |
| Normal mid-match / Surface | 18,855 | 12,220 | 4,714 | 3,055 |
| Normal mid-match / Sky | 18,851 | 12,216 | 4,713 | 3,054 |
| Normal mid-match / Orbit | 18,853 | 12,218 | 4,714 | 3,055 |

This saves 7,057 bytes per busy tick and 6,635 bytes per normal mid-match tick (about 1.7k estimated tokens).
Bootstrap data is delivered separately to policy `init(matchData)`, never embedded in the first observation.
It has an independent 128 KiB JSON bound and regression; deployments into busy matches therefore retain the full
dynamic observation headroom rather than combining static rules with a capped entity list.
The busy fixture's separate bootstrap is 7,076 bytes (1,769 estimated tokens), independent of entity count.

The example Depths policy reuses its reachability bitmap and BFS queue, computes neighbors without allocating an array per visited cell, skips empty packed designation words, and checks only the twelve cells beside each lode instead of scanning all 2304 cells per lode. The scratch buffers are cleared on every decision, and mirror-team tests cover knowledge and designation changes between calls. Policy budgets remain unchanged.

[Paired policy measurements](research-policy.json) replay every decision from seed 21 through the unchanged 25 ms QuickJS sandbox, baseline then research, twice before and after the optimization. The no-op control includes JSON decoding/parsing and empty-output validation; it estimates marshalling cost rather than directly instrumenting phases.

| Depths call time (ms) | p50, runs 1 / 2 | p95, runs 1 / 2 | max, runs 1 / 2 |
|---|---:|---:|---:|
| Research before | 3.041 / 3.364 | 9.446 / 7.988 | 24.521 / 30.345 |
| Research after | 2.118 / 2.050 | 7.340 / 5.488 | 14.177 / 17.124 |
| Paired baseline after | 3.112 / 2.920 | 7.852 / 6.455 | 36.120 / 14.676 |

Both optimized runs produced identical Depths intents at all 546 decisions and retained the tick-5459 victory. Observation sizes are unchanged by the optimization (Depths p50/p95/max 19,377 / 22,516 / 23,201 bytes). The baseline itself timed out twice in 13,520 measured full calls across four runs (Orbit 29.315 ms and Depths 36.120 ms); a no-op research call also reached 32.423 ms without timing out under the sandbox's existing CPU-time guard. Therefore these measurements show improved policy headroom, not a guarantee against host scheduling/GC outliers for arbitrary agent policies. Per-plane full/no-op timings and sizes for every run are in the linked JSON.

The full game pass also exposed an outdated fog-test oracle: a climbing interceptor is visible to an observer of its Orbit endpoint even while its reported plane is still Sky. The oracle now checks that endpoint geometrically during the climb only; production fog rules and all distance allowances are unchanged. Both formerly failing seeded property cases pass with the complete 40-test fog file.

Visual WebGL smoke found a separate shader-coordinate bug: instanced `positionLocal.y` includes altitude, so it drove contrail and altitude-stalk opacity above one. Using cylinder-local `positionGeometry.y` fixes the translucent gradients. The isolated client exercised research queue/progress/completion, Lancer production, ascent/climb/Orbit/return, and three bombers destroying a turret. Screenshots and recorded observations are under `/tmp/ac-research/` (final ascent captures `16`–`19`); the isolated servers were stopped afterward.

## Final Phase A sweep

The final Phase A sweep supersedes the interim balance findings. Its 66 run sets contain 216 mirror matches, 432 ladder matches and 960 probe matches. All **66 guardrails pass**: 9 side-bias tests (Bonferroni threshold 0.05/9), 3 veteran-over-novice tests, 6 competent-mirror length tests and 48 probe ceilings.

- Veteran beats novice 48/48 on each preset. Standard mirror medians are 13.0/13.0/13.2 min and veteran medians 13.6/12.7/14.1 min (open/ridges/canyons).
- No probe exceeds 50%, below the 65% ceiling. Turret-turtle is 0% in all six sets; rail-economy is 20%/50%/30% against standard and 15%/15%/10% against veteran.
- Shipped responses include **0.25 energy/s upkeep per built turret**, offline turrets when the team cannot pay, **+2 tank range against non-Spire structures**, siege/anti-greed bot decisions, **finite ore veins** that become tunnels when depleted, body-aware Spire/Shaft transfers, and fog-oracle fixes covered by twin-world tests. See [DESIGN](../DESIGN.md).

Open caveats, not failing guardrails:

- Novice mirrors remain slow (28.4–29.2 min median); 27/72 hit the cap and 9/72 draw. They are deliberately excluded from the 10–15 min length rule.
- 34/48 probe sets win under 20%; surface-rush, turret-turtle and breach-ambush win none. Passing the ceiling is not evidence that every forced strategy is viable.
- Both sides act on every plane in the first minute in 96–100% of mirror matches, not universally. No mirror records a `collapse_kills` interaction.
- Probe health is not a guardrail: the JSON records **36 policy errors, 82 timeouts and 1049 rejected intents out of 510700 intents**. These limit the strength of the probe evidence; a green `check` does not certify sandbox health.
- The exploit-hunt and rail-economy reports describe earlier Phase A builds, not a new hunt on the final build. Win-rate intervals are finite-sample estimates; structure edges are correlational.

The final sweep is retained as measured; it was not rerun or retuned.

## Commands

From the repository root:

```sh
# Standard sweep → docs/balance/<label>.md + .json and bench-results/balance-<label>/
# The benchmark directory contains results.json, report.md and replays/; devtools discovers it automatically.
# Add --check to exit 1 on a failing declarative benchmark guardrail.
# --terrain plays every run set on each listed preset (keys get an @<preset> suffix).
node tools/balance/src/main.ts sweep --label my-sweep [--seeds 24] [--probe-seeds 10] [--terrain open,ridges,canyons]

# Four-army FFA sweep on the C4 recipe (map.params.slots 4), per map size (keys get an @s48/@m64 suffix).
node tools/balance/src/main.ts sweep --label ffa --layout ffa --size 48,64 --mirror-levels standard,veteran [--probes ffa-turtle,ffa-vulture]

# Short artifact/runner smoke, not a full pacing or balance acceptance run:
node tools/balance/src/main.ts sweep --label bots-smoke --seeds 1 --probes none --terrain open --workers 0 --ticks 1200

# Direct shared benchmark CLI: full three-terrain config (1608 matches, 66 guardrails).
# This emits the standard benchmark artifacts; use the sweep wrapper above for historical detailed tables too.
pnpm exec playerthree-bench --config bench/bots.config.ts --out bench-results/balance-standard

# Guardrails of an existing sweep (exit 1 if any fails)
node tools/balance/src/main.ts check docs/balance/phase-a.json

# Rewrite a report's markdown from its JSON (after report or guardrail changes; no matches are replayed)
node tools/balance/src/main.ts render docs/balance/phase-a.json

# LLM exploit hunt (OPENAI_API_KEY or ANTHROPIC_API_KEY; hard total budget)
node tools/balance/src/main.ts hunt --label my-hunt --max-usd 0.50

# Research-content smoke: six fixed seeds × standard/veteran × three presets, 12-minute observation window.
# First argument selects the checkout to measure, so the same recorder can compare a detached baseline worktree.
node tools/balance/src/research.ts . /tmp/research.json 720
node tools/balance/src/research.ts ../ac-research-baseline /tmp/research-baseline.json 720

# Focused lode diagnostic (36 mirrors; existing side-bias and pacing guardrails unchanged)
node tools/balance/src/lode-sweep.ts --label lode-zones-current --workers 2
# Static home terrain preparation on seeds 1–100, all three presets
node tools/balance/src/lode-preparation.ts
# Compare against the same harness run in an isolated baseline checkout
node tools/balance/src/lode-report.ts docs/balance/lode-zones-baseline.json docs/balance/lode-zones-current.json docs/balance/lode-zones.md
```

`node tools/balance/src/main.ts --help` lists every option. Existing `--label`, `--seeds`, `--probe-seeds`, `--terrain`, `--probes`, `--probe-levels`, `--workers`, `--out` and `--check` flags are retained. `--layout duel|ffa` picks the map layout every run set plays (default `duel`), `--size` the map sizes and `--mirror-levels` the mirror bot levels. `--out` controls the historical detailed reports; `--bench-out` overrides the benchmark artifact directory. Keep the latter at the `bench-results` root or an immediate child for automatic devtools discovery. `--ticks` is an optional diagnostic cap; the default remains the game's 30-minute cap plus one tick.

## What a sweep runs

Every match is deterministic and headless, on the PlayerThree host's bot cadence: every seat observes the start-of-tick world before any intent lands. Both bot-only matches and matches with probe or hunt policies run through `@playerthree/bench` and the in-process host (`realtime: false`); policies execute in its QuickJS sandbox and every intent is validated, as in live matches and practice. The shared runner owns worker scheduling and lifecycle; balance defaults to half the available cores and `--workers 0` runs inline. No separate balance runner, pool or worker remains.

`tools/balance/src/spec.ts` projects the report's run-set labels to `BotSet` configs: seed lists, tick caps, match options, logical sides A/B with bot tiers and per-role policy artifacts, and `mirrored` orientation expansion. `balanceConfig` in `src/bench.ts` adds the module URL/export for the game definition, the reviewed surface pin and declarative guardrails. Sweeps and lode diagnostics call `runBench`; hunt evaluation calls the public `runBotMatches` with `expandBotSets(config.sets)`. Hunt policy authoring remains a budgeted LLM session.

`bench/bots.config.ts` is the full three-terrain config loadable directly by the same benchmark CLI as `bench/bench.config.ts` (the LLM/policy benchmark). The dev-only MCP `ac_sweep` also delegates to `runBotMatches`, keeping its compact matchup/timeout report without a second worker pool.

The game owns `definition.metrics(game)`: its recorder collects after every tick, including the final tick, then returns finite numeric match/side maps keyed by army id (`nw`, `ne`, `se`, `sw`). A run set (`RunSet { entrants[], layout, permutations }`) has one entrant per army; each permutation lists the entrant index per layout slot, and the runner binds them as logical entrants A–D. The report projection restores each match's entrant per slot and all historical `MatchSummary` fields (including unit samples, action/cross-plane tallies, production, structures, kills, raw kinds, lode geometry/income, Spire HP, ranks, cap status and policy-health counters). Wall time is observational, not deterministic. The game never imports the balance tools.

For direct paired-summary comparisons, construct a `RunSet`, call `balanceConfig([set], ticks, workers)`, then `runBotMatches({ definition: config.definition, surfaceHash: config.surfaceHash, trials: expandBotSets(config.sets), workers })` and map each result with `matchSummary(result, set)`. Use `runBench(config, { outDir })` instead when standard artifacts and replays are required.

The [cutover equivalence evidence](bench-bots-equivalence.json) compares the old in-repo balance harness with the shared runner: seeds 1001 and 1002, standard mirrors, open terrain, 1200 ticks. Every per-match outcome and metric is identical, excluding only wall-clock duration, both inline and with one worker thread. These short capped matches deliberately fail the unchanged 10–15 minute pacing guardrail; they prove execution equivalence, not balance acceptance. The same run's standard artifacts were opened in the headless `/playerthree/devtools#bench` page, including its guardrail results and two replay links. A separate 20-tick CLI smoke exercised the preserved flags, real worker execution, detailed reports and standard artifacts; `--check` correctly exited 1 for the unchanged pacing and tier guardrails.

| Run set | Matches (defaults) | Measures |
|---|---|---|
| `mirror-<level>` for novice, standard, veteran | 24 seeds each | slot bias, match length, units per plane, plane activity, cross-plane interactions, production and kill shares |
| `veteran-vs-novice`, `veteran-vs-standard`, `standard-vs-novice` (duel only) | 24 seeds × both orientations | the tier ladder |
| `probe-<id>-<level>` for every probe of the layout at standard and veteran | 10 seeds × every rotation (2 in a duel, 4 in FFA) | forced strategies against bots of their own level |

FFA sweeps (`--layout ffa`) prefix every key with `ffa-` and play four entrants per set: four equal bots in a mirror, the probe plus three bots of its level in a probe set. Rotations play the probe on every slot once.

Seeds start at 1001 (sweeps) and 2001 (probes), away from unit-test seeds.

## Metric definitions

- **Win rate:** wins over all matches (draws are not wins), with a 95% Wilson interval.
- **Slot bias:** in a mirror, decisive wins per layout slot, tested against equal shares: the exact two-sided binomial test against 50% with two slots, the exact multinomial test (Pearson's χ² once the outcome space exceeds two million) with four. Each slot's share of decisive matches carries a 95% Wilson interval.
- **Match length:** game minutes until a Surface Spire segment falls or the 30 min cap decides on total Spire HP. Quantiles are interpolated. Histogram buckets are 5 min wide, and the last bucket is the cap.
- **Units per plane:** units alive per army at 1, 3, 5 and 10 min. Each value is averaged over the matches still running at that minute. Structures are not counted.
- **Pillar 4, meaningful actions in the first 60 s:** counted per army and plane.
  - Depths: ore deliveries, charges planted, charges defused (credited to the defuser), enemy tunnels broken into, breaches, chasms opened or bridged.
  - Any plane: structures completed and portal transfers count on the plane where they happen.
  - Sky: island captures, asteroid interceptions.
  - Orbit: grapples, deorbits, scans.
  - Every plane: kills on that plane, credited to the killer.
  - Not actions: production, digging, drifting.
  - "All active" is the share of matches in which every army acted on that plane at least once.
- **Cross-plane interactions:** counted per match from game events, effects and attributed kills, and listed in the report. A sweep recorded before an interaction was counted shows `–` for it.
- **Kill attribution:** a death is attributed to a collapse or impact in the same tick within its radius plus a margin. Otherwise it goes to the nearest enemy shot that lands on the victim's plane that tick (shot effects carry the shooter's kind; instant hits land in the tick they are fired). A death with neither is `unattributed`; reports show that share (≈2% at pass 2).
- **Production and kill shares:** fractions of all units produced and of all attributed kills, all armies pooled.
- **Spire damage by segment:** Spire HP actually lost (overkill excluded) per match, all armies pooled, per segment: the share by the plane the damage came from (`none` for storms, floods, scorch and other sources without one) and by cause (the killer kind, or a named cause such as `impact`, `collapse`, `sun_lance`). Asteroid `impact` and the derelict `core_drop` are separate causes, so the impact share that sets `spire.impactMultiplier` is never confounded. The findings list the Surface impact share and the plane-of-origin split for every mirror.
- **Sappers and chasms:** per match, for the tested entrant and its opponents (a mirror pools its armies): undermine intents accepted, rejected for want of a tunnel (`no_path`, or the cell is no known tunnel) and otherwise; charges planted, defused, gone off without damaging a hostile structure (dud) and with (hit), and the HP the charges took. Chasm attempts are undermine intents on an unopened fault cell, accepted and rejected.
- **Unit mix:** per plane, production by kind pooled over the armies: units per match, the Shannon entropy of the kind shares in bits (0 for a single kind, log₂ k for k equal kinds), and the kinds at ≥ 15% of the plane's production (the balance targets ask for two per plane in veteran mirrors).
- **Structure edge:** among matches in which one army completed more of a structure than every other, the share that army won. This is correlational, because winners also build more. Forced probes are the causal test.
- **Placement:** in probe and ladder sets, the tested entrant's finishing ranks (1 = winner; ties share) and their mean, from the host's ranks.
- **Lode diagnostics:** the recorder also stores exact earned alloy, lode-pocket deliveries plus Headframe trickles, and completed/lost Headframes per side. The short report pools lode alloy / earned alloy and counts flank Headframes using a fixed geographic classifier on both revisions; unfinished flank-site losses are separate. See [lode-zones](lode-zones.md) for coordinates, definitions, sample-size caveats and reproducible commands. Legacy JSON without these counters cannot supply them retrospectively.

## Guardrails (`check`)

| Guardrail | Rule |
|---|---|
| `slot_bias` | Every mirror: slot-bias p ≥ 0.05 / number of mirrors (Bonferroni across run sets). Two-army mirrors are the exact binomial test of the former `side_bias`. |
| `veteran_over_novice` | Veteran wins ≥ 80% of the duel `veteran-vs-novice`, both orientations pooled; draws count against it |
| `length_band` | Duel: median length of the standard and veteran mirrors within 10–15 min (DESIGN §2); novice mirrors are exempt (deliberately weak bots; final Phase A medians 28.4–29.2 min, 27/72 capped and 9/72 draws). Four-army FFA: median of the standard mirror within 12–20 min per map and size (DESIGN §15.13). |
| `probe_ceiling` | No strategy probe wins more than 1.3× the uniform share against bots of its own level: 65% in a duel, 32.5% in four-army FFA (DESIGN §11.5, §15.13) |

The config emits guardrails only for sets with evidence. Across all three terrain presets the duel sweep keeps 78 checks: nine exact-binomial slot-bias tests on `nw` at 0.05/9, three logical-A veteran win-rate floors, six inclusive median-minute bands, and 60 logical-A probe ceilings. The shared runner has no multinomial aggregation, so four-army slot bias is evaluated by `check` (and `--check`) only. Thresholds live in `src/guardrails.ts` and are expressed as metric, aggregation, comparator, threshold and scope data for the generic runner. `check` and `render` read detailed JSON written by this version without replaying matches.

## Strategy probes

Each probe is a JS policy in [`tools/balance/probes`](../../tools/balance/probes) (the PlayerThree policy ABI any agent uses) that forces one strategy on its seat. The rest of the probe's army is built-in bots at the opponents' level. A probe's win rate therefore compares the strategy against bots of the same tier. Probes carry the example policies' frame helper (`matchData.armies[].frame`, map size from `matchData.rules.map.size`) and focus rule (the nearest live hostile Spire, then the lowest known Spire HP, then clockwise order), so the same source plays any corner of a duel or FFA. The report lists policy errors and rejected intents; its JSON also records timeouts. Inspect these alongside win rates: `check` evaluates the four guardrails above, not policy health.

| Probe | Seat | Layouts | Strategy |
|---|---|---|---|
| `surface-rush` | surface | duel, FFA | troopers only, all-in waves at the focus Spire from 1:00 |
| `turret-turtle` | surface | duel, FFA | turret ring around the Spire, defensive army, never attacks |
| `sapper-swarm` | depths | duel, FFA | tunnel into collapse reach of the focus Spire from 0:00 (the nearest known tunnel cell within collapseRadius + collapseStructureReach of its footprint edge), sapper waves every 12 s |
| `asteroid-spam` | orbit | duel, FFA | every alloy into tugs, unpaired drops on the focus Spire |
| `lancer-night-siege` | orbit | duel, FFA | arrays then Lancers only; while the stand-off is dark they siege the focus Orbit segment from its diagonal, past its night detection (spire vision × nightSignature) and inside their reach from the footprint corner, scanning it to see it; by day they wait out of beam range |
| `volatile-tows` | orbit | duel, FFA | tug-heavy volatile-only strikes with fuse-reachable acquisition |
| `island-turtle` | sky | duel, FFA | 12 interceptors hold every island with relays, never raid |
| `bomber-raid` | sky | duel, FFA | bombers only (3 interceptor screen), packs at the focus Spire |
| `rail-economy` | depths | duel, FFA | 20 diggers on auto-mine, rail the cavern to the centre from 1:00 (found by the Phase A exploit hunt) |
| `breach-ambush` | depths + surface | duel, FFA | trooper squads go down from 2:00, tunnel next to the focus base and break out behind its lines (Phase A breach) |
| `ffa-turtle` | surface | FFA | hold a mixed army at home until one hostile army is eliminated, then all-in at the weakest survivor |
| `ffa-vulture` | surface | FFA | trooper/tank waves at whichever hostile army has the lowest known Spire HP |

A layout's standard plan runs every probe that lists it; FFA-only probes are rejected in a duel. Ground probes march to the focus Spire footprint's centre-facing corner: a move into the footprint is rejected `blocked`. `test/probes.test.ts` plays a minute of every probe in every layout and fails one whose intents are 20% or more rejected.

## Exploit hunt

For each role in turn, the hunt does the following:

1. It serves an in-process PlayerThree host over a loopback MCP endpoint, so the agent gets the same tools as players.
2. It runs the PlayerThree runner's agent loop with a commander token in the lobby.
3. A red-team brief tells the model to find degenerate strategies: write a policy, `practice_run` it against the veteran bots, iterate, and summarise.
4. The run stops at the role's share of `--max-usd`, at `--max-turns`, or when the agent idles.
5. Every deploy (with its source) and every practice result is captured.
6. Each role's final deployed policy is re-played through the sweep harness against standard and veteran bots in both duel orientations (lobby practice and re-play are duels: the tested seat plays `nw` in practice). A final policy above 65% is a finding, and findings become tests.

## Typical durations

Measured on an 8-core WSL2 machine with 4 workers (the default, half the cores):

| Job | Matches | Wall time |
|---|---|---|
| Standard sweep (defaults, pass 2) | 456 | 5.5 min |
| Mirrors and ladder only (`--probes none`) | 216 | 2 min |
| Final Phase A, three presets and 8 probes | 1608 | 48.1 min (4 workers) |
| One match | 1 | Pass-2 CPU time: 1–3 s; actual cost varies with game revision and sandbox policies |
| Exploit hunt smoke: one role, 11 model turns, 8 re-play matches (gpt-5-mini, $0.06) | 8 | 0.8 min |
| `pnpm --filter @agent-command/balance test` | – | ~5 s |
