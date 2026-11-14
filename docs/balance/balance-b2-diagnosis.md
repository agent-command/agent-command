# Combined-b2 guardrail diagnosis

Baseline: [combined-b2](combined-b2.md), diagnosed on the same build. Four mirror seeds (1001–1004), two probe seeds (2001–2002), default rules and terrain. [Raw diagnosis](balance-b2-diagnosis.json) retains damage timings, minute samples, plan-state counts, production and native probe evidence. No thresholds, map seeds, unit stats or match rules were changed.

## Veteran pacing: pressure starts, but replacements stop finishing

The eight native mirror reproductions have the same ending ticks as the combined-b2 report. Damage below is **actual Surface Spire HP lost by blue**, summed across the four seeds of each tier, not incoming damage before mitigation:

| Tier | Impacts | Projectile weapons | Instant weapons | Total |
| --- | ---: | ---: | ---: | ---: |
| standard | 20,452.5 | 487.5 | 60 | 21,000 |
| veteran | 10,800 | 8,032.5 | 80 | 18,912.5 |

No collapse damage landed on these measured Spires. Mirror Surface projectiles are cannons: neither tier produced bombers. Veteran's cannon total is misleading without the seed split: **112.5 / 6,320 / 0 / 1,600**. The two capped veteran mirrors (1001 and 1003) get almost no army finishing damage.

- **Not a delayed first strike:** first veteran impacts arrive at ticks 2670 / 1280 / 1080 / 1130 (2:13.5 / 1:04 / 0:54 / 0:56.5), versus standard 2530 / 2560 / 6100 / none. Stand-off drops operate; they do not simply stop all asteroid attacks. Veteran gets fewer impacts through: the combined-b2 sweep records 9 impacts and 21.3 interceptions per veteran mirror, versus 18.5 and 20.8 standard.
- **Late/absent army contact:** first veteran cannon damage arrives at 8:47.3 / 13:24.5 / never / 14:41.4. A plan marked `attack` is not evidence of a successful siege. Seed 1003 spends 3330 of 3600 sampled decisions in `home`; seed 1001 spends 2658 in `attack` yet does only 112.5 cannon damage.
- **Army sizes, not an enormous wall:** at 3:00 veteran averages 8 Surface units and 12.5 Depths units per side, versus standard 11.3 and 9. At 10:00 veteran averages only 6–6.5 Surface units; its extra underground commitment does not accumulate a finishing force. The combined-b2 veteran production shares are 4% tanks, 28% diggers and 35% troopers (standard 7%, 15%, 42%).
- **A concrete resource deadlock:** `screenFirst` blocks every non-interceptor energy unit while fewer than four interceptors survive, even after the Sky Spire has died and the bot cannot queue replacement interceptors there. Veteran 1003 at 10:00 has **1700 alloy, 13 energy, no Sky segment or interceptor, one tank and two flak**; at 15:00 it has **2420 alloy and 38 energy**, still one tank. The hard reserve exists outside the shared queue and can indefinitely prevent armor replacement.
- **Controlled first repair:** stop reserving that impossible screen after losing the Sky producer. Seed 1003 changes from 3330 to 780 `home` decisions, and has four tanks at 10:00 instead of one. This alone does **not** meet the pacing target: the mirror ticks remain 36000 / 18963 / 36000 / 18944. It repairs a real deadlock, not all siege limitations.
- **Storms and inset distance:** veteran Sky counts collapse from 4 at 3:00 to 0.8 at 5:00; the combined-b2 unattributed-death bucket includes weather, not weather alone. No isolated storm-off or inset-only A/B was run, so neither is established as the root cause. The standard tier passes on the same inset and storms; moving the bases or weakening weather would be a broader rule change than repairing the observed production errors.

## Breach-ambush: its ordinary Orbit support wins the standard matchup

Probe diagnoses use the **authoritative `@playerthree/bench` runner and QuickJS policies**, both orientations. A discarded `node:vm` emulation produced different trajectories and is not evidence. The standard reproductions match the combined-b2 4/4 wins and ending ticks exactly. The veteran diagnostic already includes the dead-Sky reserve repair; all four still lose.

| Standard defender, both orientations | Seed 2001 | Seed 2002 |
| --- | ---: | ---: |
| Probe first breach opens | 3:29.15 | 2:34.4 |
| Defender units within 6 tiles at that breach | 0 | 5 |
| Surface Spire impact damage | 2400 | 7000 |
| Surface Spire instant damage | 48 | 0 |
| Surface Spire projectile damage | 450 | 0 |
| Depths Spire instant damage | 536 | 16 |
| Orbit Spire instant damage | 2500 | 2500 |
| Orbit segment destroyed | 5:31.9 | 5:23.9 |

The second seed's Surface segment dies **entirely to asteroids**, not a troop burst. In the first seed, the first breach deals only 48 Surface HP; the probe wins at the cap after destroying Orbit and repeatedly killing miners. Standard produces **98 diggers** in that 30-minute match, but **zero Lancers**. The probe's ordinary Orbit bot kills 23 units with Lancers. In seed 2002 it kills 22; standard again produces no Lancer. Both orientations show the same mechanism.

The Orbit seat always replaces solar arrays and tugs before building its combat fleet. A scouted enemy fighter can therefore kill every replacement and prevent the counter-unit from ever entering funding. The probe's different spending on its two forced seats lets its otherwise ordinary Orbit bot get an early Lancer and keep that advantage. Veteran also loses its Orbit segment in the first probe seed, but continues generating a successful Surface cannon siege; standard does not recover equivalent pressure.

This evidence does **not** justify blaming new footprint layouts or adding a special anti-breach rule. Local breach coverage is imperfect, but the measured finishing damage and production starvation point to Orbit defence and recovery.

## Rejected experiments and integration boundary

A fog-triggered replacement priority was tried: build the missing baseline combat screen before further civilian replacements when an armed Orbit enemy is currently visible and at least one solar survives. [The full 100-match experiment](balance-b2-rejected-orbit.md) passes only **19/22**: veteran length stays 22.9 minutes, breach-ambush/standard stays 4/4, and bomber-raid/standard regresses from 0/4 to 4/4. It does not recover soon enough when raiders have already removed every array. **The Orbit production change, its policy guidance and its test were removed.**

A second candidate retained the existing minimum late-game attack force (`ceil(tier.attackAt / 3)`) on the Surface before optional greed/breach expeditions; emergency tremor transfers were unchanged. [Its full 100-match sweep](balance-b2-rejected-surface.md) passes **20/22** but moves the wrong guardrail: breach-ambush/standard improves to 2/4, while standard length regresses **13.3 → 23.9 minutes** and veteran remains **23.0 minutes**. The second front is productive pressure, not merely wasted infantry. **This Surface change, example-policy change, briefing and regression test were removed as well.** Neither rejected run is acceptance evidence for the final retained code.

**Only the dead-Sky reserve repair is retained**, with mirrored regression coverage. It fixes an impossible-production deadlock, but its measured four-mirror comparison still has a 22.9-minute veteran median. This assignment therefore does not claim the length guardrail is repaired. Keeping either broader candidate would break an already-passing guardrail; neither a rule change nor seed-specific tuning is justified by these results.

A separate Fleet rewrite (reactive composition, escorts/raids and station point-defence) changes the diagnosed Orbit matchup. Orbit defence is therefore deliberately **not retuned on this legacy roster**. The two seeds' actual source/timing evidence above is input to the post-Fleet combined sweep; a pass on the legacy roster would not certify the fleet implementation.

## Measurement boundary

The temporary wrapper measures actual before/after HP loss around `Sim.damage`; impact/projectile call paths are distinct, and native probe collapse processing is distinct as well. Instant weapons are grouped rather than guessed by kind. Minute counts read the unfogged sim only for offline evidence. Production decisions use normal team observations and do not receive the diagnosis data. No instrumentation or alternate runner ships in the game.
