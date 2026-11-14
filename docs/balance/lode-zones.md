# Lode zones: short paired balance comparison

Six seeds (1001–1006) × open/ridges/canyons × standard/veteran mirrors: **36 matches per revision, 72 total**. Every seat uses that revision’s built-in bot; no policies, cheats, custom economy, shorter time cap, ladder or strategy probes. This is diagnostic evidence, not full balance acceptance.

## Findings

- **blue:** lode alloy share 22.7% → 25.4%; flank Headframes built/lost 0/0 → 13/4. Baseline has no outcrops in the measured flank region, so its zero is absence of opportunity, not evidence its bots refuse flanks.
- **red:** lode alloy share 22.5% → 25.6%; flank Headframes built/lost 0/0 → 13/4. Baseline has no outcrops in the measured flank region, so its zero is absence of opportunity, not evidence its bots refuse flanks.
- Pooled median match length 15.15 → 12.83 minutes. Current unchanged guardrail failures: length_band mirror-standard@canyons (median 22.3 min (p25–p75 16.5–27.8)).
- Current run sets with no completed flank Headframe on either side: mirror-veteran@canyons. Flank engagement is therefore reported per terrain and level rather than inferred from placement alone.
- Side-bias conclusions remain inconclusive: many matches draw and every six-seed set is underpowered at the unchanged Bonferroni threshold. Discovery/last-seen lode state, scouting, flank tactics and terrain preparation are included in the current revision; this comparison does not isolate one of those changes.

## Revisions and reproduction

- **Baseline:** game-source SHA256 `4c7361ae6ea89ea0b558451442d8504ae05cf587f5f38cde13ed9c5d84322346`; Node 26.10.0; 2 workers; 3.74 min wall. Raw data: [lode-zones-baseline.json](lode-zones-baseline.json). The JSON retains the game-source diff if uncommitted.
- **Current:** game-source SHA256 `f55a7cd3f0f2048bde1e44c6a05c1210a0900655bd995f6917c2d357b9443a1c`; Node 26.10.0; 2 workers; 4.16 min wall. Raw data: [lode-zones-current.json](lode-zones-current.json). The JSON retains the game-source diff if uncommitted.

Run from the isolated checkout of each revision with the same measurement harness copied in. Never point its game dependency at another worktree; the runner rejects that. The baseline is a detached checkout of the revision being compared against.

```sh
cd <current-checkout>
git worktree add --detach ../ac-lodes-baseline <baseline-revision>
cp tools/balance/src/{lodes,lode-sweep,record,trace,metrics}.ts ../ac-lodes-baseline/tools/balance/src/
cd ../ac-lodes-baseline
pnpm install --offline --ignore-scripts --frozen-lockfile
node tools/balance/src/lode-sweep.ts --label lode-zones-baseline --workers 2 --out <current-checkout>/docs/balance
# In current worktree, after implementation is frozen:
cd <current-checkout>
node tools/balance/src/lode-sweep.ts --label lode-zones-current --workers 2
node tools/balance/src/lode-preparation.ts
node tools/balance/src/lode-report.ts docs/balance/lode-zones-baseline.json docs/balance/lode-zones-current.json docs/balance/lode-zones.md
```

## Metric definitions and limitations

- **Lode alloy:** cumulative `sim.teams[side].stats.lodeAlloy`: delivered ore mined from any lode pocket (including enemy-opened pockets), plus Headframe trickles. It is all lodes, not only flank lodes. Undelivered carried ore is excluded.
- **Earned alloy:** sum of the sim’s current per-tick `income` ring entry after every step: all digger deliveries plus Spire and Headframe trickles. Starting stock, refunds and spending are excluded. **Lode share** is total lode alloy / total earned alloy, pooled across matches for each side (not the average of per-match percentages). Counters remain unrounded in JSON.
- **Flank:** outcrop cell centre within Euclidean distance 9 of (40,8) or (8,40), and absolute distance-to-base skew ≤10 using bases (8,8)/(40,40). This fixed geographic classifier applies to both revisions, independently of `rich` or zone metadata. Old central contested lodes do not become flanks merely because they are rich. Distances use cell centres (cell x+0.5, y+0.5), as the map generator does.
- **Built/lost:** completed Headframes and subsequently destroyed completed Headframes, credited to their owning side; rebuilds count again. Unfinished flank sites destroyed before completion are reported separately. Queue requests and cancellations are not builds or losses. Counts are totals, not per-match means. Deaths do not require kill attribution.
- **Length:** ticks / 20 / 60 game minutes; interpolated quartiles. Cap count means both Surface Spires still stand when the match ends (normal 30-minute cap). B/R/D are blue wins, red wins and draws.
- **Side bias:** blue wins / decisive matches, 95% Wilson interval, exact two-sided binomial p against 50%. Existing guardrails remain unchanged: per-revision six-mirror Bonferroni α=0.05/6, and competent-mirror median 10–15 minutes. With six decisive matches, even 6–0 has p=0.03125: no individual set can reject at α=0.00833. A passing side-bias check here is weak evidence, not proof of fairness. Pooled bias is descriptive: terrain/level runs reuse map seeds and are not independent samples.
- No novice/ladder/probe evidence was collected; their guardrails are unexercised, not passed. These paired revisions may contain other bot or game changes; results describe the combined revision difference, not a causal estimate of lode placement alone. No package test, lint, format or build run is part of this measurement.

## Pooled economy and Headframes

| Revision | Side | Lode alloy | Earned alloy | Lode share | All HF built | All HF lost | Flank built | Flank lost | Flank sites lost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | blue | 68590.90 | 302755.80 | 22.7% | 77 | 7 | 0 | 0 | 0 |
| baseline | red | 68910.23 | 306125.33 | 22.5% | 80 | 7 | 0 | 0 | 0 |
| current | blue | 78636.48 | 309825.48 | 25.4% | 94 | 17 | 13 | 4 | 0 |
| current | red | 78661.58 | 307830.38 | 25.6% | 94 | 16 | 13 | 4 | 0 |

## Match length and side bias

| Revision / set | N | B/R/D | Capped | Median min | Q25–Q75 | Min–max | Blue decisive [95% CI] | Exact p |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline pooled | 36 | 2/3/31 | 4 | 15.15 | 9.81–18.73 | 6.58–30.00 | 40.0% [11.8%–76.9%] | 1.0000 |
| current pooled | 36 | 5/2/29 | 1 | 12.83 | 10.79–16.11 | 5.94–30.00 | 71.4% [35.9%–91.8%] | 0.4531 |
| baseline mirror-standard@open | 6 | 0/0/6 | 3 | 26.00 | 19.81–30.00 | 17.76–30.00 | n/a [0–100%] | 1.0000 |
| current mirror-standard@open | 6 | 2/0/4 | 0 | 14.75 | 13.09–20.96 | 12.13–24.73 | 100.0% [34.2%–100.0%] | 0.5000 |
| baseline mirror-veteran@open | 6 | 0/0/6 | 0 | 12.57 | 11.80–14.58 | 11.27–16.69 | n/a [0–100%] | 1.0000 |
| current mirror-veteran@open | 6 | 1/0/5 | 0 | 10.56 | 9.84–14.27 | 6.93–16.04 | 100.0% [20.7%–100.0%] | 1.0000 |
| baseline mirror-standard@ridges | 6 | 0/0/6 | 0 | 10.65 | 8.45–15.47 | 7.76–29.06 | n/a [0–100%] | 1.0000 |
| current mirror-standard@ridges | 6 | 1/1/4 | 0 | 11.56 | 10.19–11.94 | 5.94–15.83 | 50.0% [9.5%–90.5%] | 1.0000 |
| baseline mirror-veteran@ridges | 6 | 0/2/4 | 0 | 7.93 | 7.69–9.36 | 6.58–14.72 | 0.0% [0.0%–65.8%] | 0.5000 |
| current mirror-veteran@ridges | 6 | 1/1/4 | 0 | 10.62 | 7.64–12.22 | 6.58–19.36 | 50.0% [9.5%–90.5%] | 1.0000 |
| baseline mirror-standard@canyons | 6 | 1/0/5 | 1 | 19.73 | 17.76–21.50 | 9.40–30.00 | 100.0% [20.7%–100.0%] | 1.0000 |
| current mirror-standard@canyons | 6 | 0/0/6 | 1 | 22.26 | 16.47–27.78 | 15.93–30.00 | n/a [0–100%] | 1.0000 |
| baseline mirror-veteran@canyons | 6 | 1/1/4 | 0 | 15.25 | 14.43–15.71 | 9.82–16.94 | 50.0% [9.5%–90.5%] | 1.0000 |
| current mirror-veteran@canyons | 6 | 0/0/6 | 0 | 13.39 | 12.40–14.87 | 8.46–18.23 | n/a [0–100%] | 1.0000 |

## Economy by terrain and level

| Revision / set | Side | Lode alloy | Earned alloy | Lode share | All HF built | All HF lost | Flank built | Flank lost | Flank sites lost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline mirror-standard@open | blue | 6630.00 | 55351.70 | 12.0% | 8 | 0 | 0 | 0 | 0 |
| baseline mirror-standard@open | red | 6630.00 | 55351.70 | 12.0% | 8 | 0 | 0 | 0 | 0 |
| current mirror-standard@open | blue | 16307.75 | 58098.25 | 28.1% | 19 | 4 | 4 | 1 | 0 |
| current mirror-standard@open | red | 16313.13 | 58103.53 | 28.1% | 19 | 4 | 4 | 1 | 0 |
| baseline mirror-veteran@open | blue | 17617.38 | 56294.78 | 31.3% | 17 | 0 | 0 | 0 | 0 |
| baseline mirror-veteran@open | red | 17617.38 | 56294.78 | 31.3% | 17 | 0 | 0 | 0 | 0 |
| current mirror-veteran@open | blue | 11563.38 | 46308.88 | 25.0% | 13 | 1 | 1 | 1 | 0 |
| current mirror-veteran@open | red | 11563.38 | 43388.78 | 26.7% | 13 | 1 | 1 | 1 | 0 |
| baseline mirror-standard@ridges | blue | 9891.75 | 47359.15 | 20.9% | 15 | 5 | 0 | 0 | 0 |
| baseline mirror-standard@ridges | red | 9891.75 | 47359.15 | 20.9% | 15 | 5 | 0 | 0 | 0 |
| current mirror-standard@ridges | blue | 14722.90 | 48625.50 | 30.3% | 17 | 4 | 3 | 0 | 0 |
| current mirror-standard@ridges | red | 14742.63 | 50445.23 | 29.2% | 17 | 3 | 3 | 0 | 0 |
| baseline mirror-veteran@ridges | blue | 8389.58 | 36019.98 | 23.3% | 10 | 1 | 0 | 0 | 0 |
| baseline mirror-veteran@ridges | red | 8667.05 | 38747.65 | 22.4% | 13 | 1 | 0 | 0 | 0 |
| current mirror-veteran@ridges | blue | 9811.98 | 42700.48 | 23.0% | 12 | 1 | 1 | 0 | 0 |
| current mirror-veteran@ridges | red | 9811.98 | 41870.48 | 23.4% | 12 | 1 | 1 | 0 | 0 |
| baseline mirror-standard@canyons | blue | 9960.25 | 53366.55 | 18.7% | 12 | 0 | 0 | 0 | 0 |
| baseline mirror-standard@canyons | red | 9962.10 | 51668.30 | 19.3% | 12 | 1 | 0 | 0 | 0 |
| current mirror-standard@canyons | blue | 16302.38 | 63745.88 | 25.6% | 21 | 7 | 4 | 2 | 0 |
| current mirror-standard@canyons | red | 16302.38 | 63745.88 | 25.6% | 21 | 7 | 4 | 2 | 0 |
| baseline mirror-veteran@canyons | blue | 16101.95 | 54363.65 | 29.6% | 15 | 1 | 0 | 0 | 0 |
| baseline mirror-veteran@canyons | red | 16141.95 | 56703.75 | 28.5% | 15 | 0 | 0 | 0 | 0 |
| current mirror-veteran@canyons | blue | 9928.10 | 50346.50 | 19.7% | 12 | 0 | 0 | 0 | 0 |
| current mirror-veteran@canyons | red | 9928.10 | 50276.50 | 19.7% | 12 | 0 | 0 | 0 | 0 |

## Unchanged guardrails

| Revision | Guardrail | Set | Result | Actual | Target |
| --- | --- | --- | --- | --- | --- |
| baseline | side_bias | mirror-standard@open | pass | blue 0–0 red (6 draws), p = 1.000 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| baseline | side_bias | mirror-veteran@open | pass | blue 0–0 red (6 draws), p = 1.000 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| baseline | side_bias | mirror-standard@ridges | pass | blue 0–0 red (6 draws), p = 1.000 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| baseline | side_bias | mirror-veteran@ridges | pass | blue 0–2 red (4 draws), p = 0.500 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| baseline | side_bias | mirror-standard@canyons | pass | blue 1–0 red (5 draws), p = 1.000 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| baseline | side_bias | mirror-veteran@canyons | pass | blue 1–1 red (4 draws), p = 1.000 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| baseline | length_band | mirror-standard@open | **FAIL** | median 26.0 min (p25–p75 19.8–30.0) | 10–15 min |
| baseline | length_band | mirror-veteran@open | pass | median 12.6 min (p25–p75 11.8–14.6) | 10–15 min |
| baseline | length_band | mirror-standard@ridges | pass | median 10.6 min (p25–p75 8.4–15.5) | 10–15 min |
| baseline | length_band | mirror-veteran@ridges | **FAIL** | median 7.9 min (p25–p75 7.7–9.4) | 10–15 min |
| baseline | length_band | mirror-standard@canyons | **FAIL** | median 19.7 min (p25–p75 17.8–21.5) | 10–15 min |
| baseline | length_band | mirror-veteran@canyons | **FAIL** | median 15.3 min (p25–p75 14.4–15.7) | 10–15 min |
| current | side_bias | mirror-standard@open | pass | blue 2–0 red (4 draws), p = 0.500 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| current | side_bias | mirror-veteran@open | pass | blue 1–0 red (5 draws), p = 1.000 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| current | side_bias | mirror-standard@ridges | pass | blue 1–1 red (4 draws), p = 1.000 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| current | side_bias | mirror-veteran@ridges | pass | blue 1–1 red (4 draws), p = 1.000 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| current | side_bias | mirror-standard@canyons | pass | blue 0–0 red (6 draws), p = 1.000 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| current | side_bias | mirror-veteran@canyons | pass | blue 0–0 red (6 draws), p = 1.000 | p ≥ 0.0083 (α 0.05 / 6 mirrors) |
| current | length_band | mirror-standard@open | pass | median 14.7 min (p25–p75 13.1–21.0) | 10–15 min |
| current | length_band | mirror-veteran@open | pass | median 10.6 min (p25–p75 9.8–14.3) | 10–15 min |
| current | length_band | mirror-standard@ridges | pass | median 11.6 min (p25–p75 10.2–11.9) | 10–15 min |
| current | length_band | mirror-veteran@ridges | pass | median 10.6 min (p25–p75 7.6–12.2) | 10–15 min |
| current | length_band | mirror-standard@canyons | **FAIL** | median 22.3 min (p25–p75 16.5–27.8) | 10–15 min |
| current | length_band | mirror-veteran@canyons | pass | median 13.4 min (p25–p75 12.4–14.9) | 10–15 min |

## Outcrop availability

Counts below pool all 36 maps per revision (the same terrain/seed is repeated at two bot levels). Raw JSON records every outcrop coordinate, richness and load count. Availability is distinct from successful construction.

| Revision | All outcrops | Flank outcrops | Rich outcrops |
| --- | --- | --- | --- |
| baseline | 216 | 0 | 72 |
| current | 216 | 72 | 72 |

## Home terrain preparation (current generator)

Separate static-map measurement on seeds **1–100**, every terrain, using the same `generateTerrain` → `generateWorld(new Rng(seed), ...)` sequence as the sim. Counts are **mirrored pairs** (two outcrops per pair), not changed terrain cells. `cliffPreparedMaps` counts seeds with at least one home pair requiring cliff-to-ground preparation; `preparedPairs` includes all terrain preparation. `fallbackPairs` counts home pairs placed beyond the preferred maximum radius. This does not measure in-game Headframe construction or certify every possible seed.

Raw per-seed summaries: [lode-zones-preparation.json](lode-zones-preparation.json).

| Terrain | Maps | Maps needing cliff prep | Prepared pairs | Cliff-prepared pairs | Fallback pairs | Missing home pairs |
| --- | --- | --- | --- | --- | --- | --- |
| open | 100 | 0 | 4 | 0 | 0 | 0 |
| ridges | 100 | 0 | 1 | 0 | 0 | 0 |
| canyons | 100 | 46 | 56 | 56 | 0 | 0 |
