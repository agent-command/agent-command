# Depths bot designation sweep

Baseline: the build before the bot designation change; candidate: `bot-dig` (Mounts/diagonal designation integrations included).

72 headless matches, run serially in the reserved timing slot: 6 seeds (1–6) × 3 presets × standard/veteran for each revision. Both teams use the same tier. Matches stop at outcome or 30 minutes. Ore means delivered mining alloy (`stats.alloyMined`), not carried loads. Tunnel counts count dig effects; tags count published designation cells. Companion [JSON](bot-dig.json) retains per-seed economy and separate side summaries.

## Decision

The missing plan was route publication, not automatic miners overriding designations: automatic mining already yields to the tag scheduler. Keep the elastic automatic mining/digging crew and explicit lode miners rather than introducing a rigid split. Publish ore expansion, lode, fault-guard, bulkhead, sapper and breach approaches. All candidate matches issued **zero direct dig orders**. Normal-tag cleanup is bot-memory-only; never clear urgent tags or claim preexisting teammate tags. Same-priority teammate adoption cannot be detected (DESIGN §4.1).

The requested ±10% minute-5 economy check passed 9/12 groups. Integration accepted the three exceptions as recorded regression-guard observations, **not a passing ±10% result**: the change deliberately changes digging allocation, and canyons/veteran improves by 12.96%. No thresholds or seed-specific bot behavior were changed to manufacture a pass.

## Minute-5 economy: first three seeds

Each row is the mean of seeds 1–3, separately by side; individual seeds can vary more than these means.

| Preset | Tier | Side | Baseline alloy | Candidate alloy | Change | ±10% |
| --- | --- | --- | ---: | ---: | ---: | --- |
| open | standard | blue | 3840.00 | 3403.33 | -11.37% | outside |
| open | standard | red | 3840.00 | 3683.33 | -4.08% | within |
| open | veteran | blue | 3963.33 | 4220.00 | +6.48% | within |
| open | veteran | red | 3963.33 | 4220.00 | +6.48% | within |
| ridges | standard | blue | 4103.33 | 3763.33 | -8.29% | within |
| ridges | standard | red | 4103.33 | 3763.33 | -8.29% | within |
| ridges | veteran | blue | 3660.00 | 3306.67 | -9.65% | within |
| ridges | veteran | red | 3660.00 | 3306.67 | -9.65% | within |
| canyons | standard | blue | 3893.33 | 4006.67 | +2.91% | within |
| canyons | standard | red | 3893.33 | 4006.67 | +2.91% | within |
| canyons | veteran | blue | 3856.67 | 4356.67 | +12.96% | outside |
| canyons | veteran | red | 3856.67 | 4356.67 | +12.96% | outside |

**Mirror-asymmetry lead recorded by this sweep:** open/standard seed 1 has baseline 4240 alloy on both sides, but candidate blue 3200 versus red 4040. Seeds 2 and 3 match between sides. This produces the blue −11.37% versus red −4.08% group difference. The targeted mirrored designation tests passed; the full-match divergence was unexplained at the time and was not proof that designation planning caused it.

**Resolved in the extended-mirror repair:** on checkpoint b1, open/standard seed 1 first diverged in Surface troop movement at tick 2701, not in mining. The undiscovered contested-lode search mirrored integer world anchors and then added `0.5` to both sides, sending the armies to points summing to 49 rather than 48; rim offsets also used the same world direction. Constructing the search as canonical cells and mirroring the cells fixes this cause. Exact end-to-end regressions additionally cover paired-island rounding and simultaneous rail completion. These repairs do not retroactively change the sweep numbers above.

## Six-seed sweep

Arrows show baseline → candidate. Ore, tunnels, unique tagged cells and peak live tags are per-side averages over all six seeds; match duration averages six matches. Outcomes are blue wins/red wins/draws, making side bias visible without interpreting a six-game sample as statistically conclusive.

| Preset | Tier | Alloy at 5 min | Tunnels | Unique tagged cells | Peak tags | Minutes | B/R/D |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| open | standard | 3742.50 → 3738.33 | 386.17 → 361.17 | 15.83 → 93.33 | 13.83 → 10.08 | 22.80 → 21.24 | 1/0/5 → 1/1/4 |
| open | veteran | 3215.00 → 3556.67 | 438.83 → 470.50 | 49.17 → 182.33 | 38.33 → 17.50 | 24.48 → 25.78 | 0/0/6 → 0/0/6 |
| ridges | standard | 3925.00 → 3726.67 | 470.92 → 464.00 | 10.00 → 145.83 | 6.17 → 14.17 | 28.45 → 30.00 | 1/0/5 → 1/0/5 |
| ridges | veteran | 3625.00 → 3315.00 | 428.75 → 472.67 | 43.83 → 186.33 | 34.00 → 15.83 | 25.93 → 27.60 | 0/1/5 → 1/0/5 |
| canyons | standard | 3911.67 → 3171.67 | 432.17 → 476.67 | 11.83 → 140.17 | 10.00 → 14.00 | 26.46 → 27.18 | 0/1/5 → 0/0/6 |
| canyons | veteran | 3491.67 → 3673.33 | 352.00 → 405.75 | 56.50 → 149.17 | 40.67 → 16.17 | 20.30 → 19.76 | 0/0/6 → 0/1/5 |

## Checks

Reserved-slot policy tests 28/28, determinism 21/21, motion 1/1 passed. The back-to-back performance comparison used the unchanged ~624-entity test with three trials per revision: the clean baseline failed at best 2.239 ms/tick (3.949, 2.790, 2.239); candidate passed the unchanged <2 ms threshold (passing Vitest output suppressed exact trial numbers). This benchmark measures simulation stepping, not presentation/view projection. An earlier standalone candidate run failed at 2.043 ms/tick; the paired result does not establish a stable performance improvement.
