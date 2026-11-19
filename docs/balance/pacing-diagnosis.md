# Post-b1 pacing diagnosis

## Historical evidence

The b1 acceptance baseline is [checkpoint-b1](checkpoint-b1.md): 100 matches, four seeds per mirror/ladder orientation and two per probe orientation. Standard/veteran mirror medians are 22.3/30.0 minutes; five of eight mirrors reach the cap. Bomber-raid/veteran and rail-economy/standard also fail their ceilings.

Targeted historical runs used seed 1003, the default ridges map, identical standard or veteran seats, and the shared headless runner's normal decision ordering. These are diagnostic comparisons, not independent balance certification:

| Revision | Standard minutes | Veteran minutes | Interpretation |
| --- | ---: | ---: | --- |
| Phase A | 13.58 | 12.34 | Passing balance |
| Pre-research | 12.66 | 9.78 | Queue, lodes and Depths defence already present |
| Post-research | 16.48 | 18.22 | Research/Lancers and lode-zone integration present |
| b1 | 30.00 | 30.00 | Mounts, transits and bot dig-plan integration present |

This brackets a cumulative regression, not proof that one merge is solely responsible. In particular, Depths defence alone did not make this seed stall. The prior [dig-designation sweep](bot-dig.md) also records long matches before the final bot-tag changes, and economy changes in both directions across presets.

## What actually ends the match

Phase A's fast mirrors were largely an **asteroid clock**, not sustained army sieges. A temporary source-attribution hook on the same seed observed 13 red impacts in each tier, no collapses, and 6,650 incoming Surface Spire damage from impacts versus only 75 from ordinary weapons. The first impact on blue's Spire was at 5:00.5 standard / 3:19.5 veteran. Source amounts in this initial hook are incoming damage capped by remaining HP, before the sim's final damage handling; do not treat them as exact HP-loss accounting.

At b1, the same standard mirror has **zero** impacts, and veteran has only **one**, at 20:03. The Surface segments still have 6,521 / 5,745 HP at 30:00. Both sides can fight for minutes without maintaining a viable finishing force.

The ordinary army is small and becomes smaller, rather than accumulating behind an impenetrable turret wall:

| b1 seed 1003, blue | 1:00 troopers/tanks | 5:00 troopers/tanks | 10:00 troopers/tanks | 15:00 troopers/tanks | 15:00 turrets/bulkheads |
| --- | --- | --- | --- | --- | --- |
| standard | 10 / 2 | 0 / 1 | 7 / 1 | 0 / 0 | 0 / 1 |
| veteran | 8 / 2 | 3 / 0 | 9 / 0 | 1 / 0 | 1 / 2 |

Trooper counts include units sent underground. Surface army orders toward the enemy half appear by 3:27 standard / 1:00 veteran; this is not thirty minutes of never issuing an attack. At minute 20, standard has one remaining digger and no tug, tank or ordinary infantry. Its treasury repeatedly sits near 38 alloy while energy grows beyond 2,000 by the cap. Veteran similarly spends the remaining trickle on cheaper replacements. Existing unit production requires the full cost **plus a seat reserve**, after already queued costs: expensive replacements never enter the funding queue before cheap units consume the trickle.

Static defences are not the whole explanation: the standard turret is gone by minute 15 but the match still makes no further Surface progress. Bulkheads remain, and Depths raids consume units, but the primary observed failure is loss of finishing pressure.

## Rejected funding-only experiments

No threshold or seed-specific change was made. Temporary candidates were reverted before testing siege behavior:

- Removing upfront affordability from all unit production restored some finishes (standard/veteran medians 15.1/11.1 minutes), but a full 100-match sweep failed **7/22** guardrails, including several previously passing probes. Merely filling all seats' production queues is not an acceptable fix.
- Allowing only an empty Orbit queue to reserve its next unit produced 17.6/7.9-minute medians on the eight acceptance mirrors: neither length band passed.
- Allowing an empty queue on every seat, while retaining affordability for a second entry, produced 23.0/10.1-minute medians: standard still stalled.

These experiments support the funding-starvation mechanism but do not justify replacing the old impact-only finish with a more aggressive impact-only finish.

## Siege rule identified

B1's tank bonus explicitly excludes Spires (`Sim.siege`, `surface.siegeRange`): cannons have range 6 against the HQ, while its beam has range 7. Its +2 siege range helps against turrets but not against the actual win condition. Ordinary army damage is therefore not a reliable alternative when Orbit pressure fails. Applying the existing host-configurable siege bonus to Spire segments is a design change, with the unchanged surface-rush/turret-turtle ceilings as essential checks.

## Measured siege candidates

All rows use the eight acceptance mirrors, seeds 1001–1004 for standard/veteran, ridges. Later rows include the exact-mirror repairs. None includes the Orbit segment beam.

| Candidate | Standard median min | Veteran median min | Result |
| --- | ---: | ---: | --- |
| +2 siege includes Spire; original funding, before mirror merge | 22.65 | 30.00 | Siege alone cannot replace a missing army |
| +2 siege; Surface fills its queue by desired mix; with the mirror repairs | 9.15 | 8.42 | Too fast; insufficient resources left for the air screen |
| +2 siege; only Surface may reserve its first unfunded entry; screen priority retained | 20.82 | 10.75 | Some cannon finishes, but economy replacement can still starve |
| +2 siege; every seat may reserve its first entry; needs-based army mix; screen priority retained | **8.59** | **10.43** | Standard below band; promising mixed damage, not accepted |
| **Committed +2 siege plus Orbit segment beam/fleet behavior** | **unrun** | **unrun** | Measured by the combined sweep ([combined-b2](combined-b2.md)) |

The last measured +2 variant's exact ticks:

- Standard: **9220, 21910, 11403, 7660**.
- Veteran: **8350, 12660, 13010, 12380**.

Measured Surface Spire **actual HP loss**, blue victim across those four matches per tier:

| Tier | Impacts | Cannons | Instant weapons | Bombs / collapses |
| --- | ---: | ---: | ---: | ---: |
| standard | 17,616 (62.9%) | 10,172 (36.3%) | 212 (0.8%) | 0 / 0 |
| veteran | 26,776 (95.6%) | 1,200 (4.3%) | 24 (0.1%) | 0 / 0 |

Standard seed 1003 finishes with cannons/infantry alone. Veteran remains strongly impact-dependent: this is an unresolved limitation, not a claim that every plane now contributes finishing damage. The companion [JSON](pacing-diagnosis.json) retains the exact measured variant, per-seed damage first/last ticks, five-minute army/economy samples and baseline attribution.

The HP-loss hook measures the before/after change around the sim's damage application. Impacts/collapses are identified by their call path; projectile weapons by same-tick target/owner/damage matching. Instant weapons are grouped rather than guessed by unit kind. No diagnostic hook ships in the runtime.

## Committed candidate and recommendation

The candidate keeps the narrowest promising combination: one fair production reservation per seat (optional extra buffering still needs funds), army composition chosen by need rather than current treasury, and cannon siege range that applies to the HQ. A +1 default was tried, but it fails the existing guardrail test "tanks out-range turrets (siege range) and shell them without being hit back": the tank's reach of 7.7 is only 0.1 tile beyond the turret's 7.6, and the test requires a 0.5-tile margin. The default therefore stays at **+2**. The +1 vs +2 sweep was not run; the combined sweep measures +2.

Fair funding also starved Headframes. Every empty seat keeps an unfunded unit entry, so the team usually carries an energy debt. `affordableCost` treated that debt as blocking even alloy-only items, so veteran bots never queued a rich contested Headframe ("discovers and completes a rich flank Headframe" failed). An item with no energy cost is now only checked against alloy. It still queues behind the funding front.

The subsequently requested Orbit change is implemented: the Orbit segment uses the same own-plane beam as the other three. Built-in Lancers/Ascent raiders and the Orbit example gather or raid exposed ships until nearby fleet HP/DPS supports a segment siege. Fleet size derives from match-rule beam damage/cooldown, segment HP and Lancer stats rather than a new balance constant. The Sky example's short raids target ships rather than blindly attacking the segment.

Regression coverage was added for cannon siege, unchanged unreachable-target rejection with a sufficiently wide moat, planned armor funding, Orbit-only beam fire and lone-Lancer versus gathered-fleet decisions. Strategy skill, examples, briefing and DESIGN §§4.2/4.4/6/11/12 describe the candidate and pending acceptance.

## Exact pending acceptance

No timing work was run for this diagnosis:

- Typecheck is clean. Non-timing game files passed except the 4 failures fixed above; combat and bots files were rerun after the fixes, and web passes. Policy/determinism/motion tests, the long `test:mirrors` suite and the perf A/B are unrun (timing slot).
- **The committed +2 / Orbit-beam candidate has no mirror measurements or final 100-match sweep.** Run the unchanged CLI with `--seeds 4 --probe-seeds 2 --check`, preserving every guardrail. The only 100-match experiment exercised here was the rejected unrestricted-queue candidate above.
- The +2 fair-funding candidate had a real symmetry divergence: veteran/ridges seed 1004 ended in a red win at tick **12380** with the mirror repairs in place. First-divergence tick was not captured. Existing side-bias significance is not a substitute for fixing exact mirroring.

Acceptance is therefore **not complete**. No threshold was weakened, no seed-specific behavior was introduced, and no screenshots or performance gains are claimed.
