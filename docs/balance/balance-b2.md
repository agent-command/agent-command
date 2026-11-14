# Balance-b2: measured residual failures

**Not 22/22 certified.** The retained code has only the mirrored, tested fix for an impossible Sky-screen energy reserve after the Sky Spire is destroyed. No match rules, unit stats, thresholds, seed-specific behavior or legacy Orbit tuning changed in the final code.

## Evidence

- [Detailed diagnosis](balance-b2-diagnosis.md) and [raw source/timing/army evidence](balance-b2-diagnosis.json).
- [combined-b2 baseline](combined-b2.md): 100 matches, **20/22** guardrails; standard median **13.3 min**, veteran **22.9 min**, breach-ambush/standard **4/4**.
- Screen-only controlled veteran mirrors: **36000 / 18963 / 36000 / 18944 ticks**, median **22.9 min**. The repair restores planned armor funding after Sky loss but does not by itself resolve finishing pressure. The baseline same seeds were 36000 / 18963 / 36000 / 18805.
- Authoritative QuickJS probe diagnosis: standard's first troop breaches deal only **48 / 0 Surface Spire HP** on seeds 2001/2002; ordinary Orbit support destroys the defender's Orbit Spire around **5:32 / 5:24**, and impacts deal **2400 / 7000 Surface HP**. Both orientations reproduce the original standard losses. These are not evidence that the troop breach itself is overpowered.

## Two full 100-match candidates, both rejected

| Candidate | Guardrails | Standard mirror | Veteran mirror | Breach vs standard | Reason removed |
| --- | ---: | ---: | ---: | ---: | --- |
| [Visible-threat Orbit replacement priority](balance-b2-rejected-orbit.md) | 19/22 | 12.4 min | 22.9 min | 4/4 | Adds bomber-raid/standard 4/4 failure; does not fix either target |
| [Retain minimum Surface force before optional expeditions](balance-b2-rejected-surface.md) | 20/22 | 23.9 min | 23.0 min | 2/4 | Breaks previously passing standard length; does not fix veteran |

Each used the unchanged command shape `node tools/balance/src/main.ts sweep --label balance-b2 --seeds 4 --probe-seeds 2 --workers 4 --check` in a serialized timing slot; both correctly exited nonzero. Reports/JSON were renamed after the run to make their rejected status explicit. Their measurements and guardrails are retained exactly.

The broader changes, example-policy guidance and tests were removed rather than trading one failing guardrail for another. The final code has **not** had a third full 100-match sweep; the screen-only diagnosis above is its direct pacing evidence. No exhaustive final guardrail count is asserted.

## Residual decision

Veteran length remains unresolved. Measured production starvation and weak sustained cannon contact explain more than a simple first-attack delay: first veteran impacts arrive within 0:54–2:14, yet the two capped mirrors do only 112.5/0 cannon damage. The impossible reserve was a real defect but not the entire cause. Keeping either tested broader candidate would violate the requirement to preserve passing guardrails.

A separate Fleet rewrite (reactive composition, escorts/raids and station point-defence) replaces the diagnosed legacy-Orbit matchup, so additional Orbit tuning was explicitly stopped. **The post-Fleet combined sweep must evaluate veteran pacing and breach-ambush again**; neither the retained fix nor the rejected candidates certify the new roster. Storm-off and inset-only A/B runs were not performed, and no causal claim about those variables is made.

## Default checks on the retained code

- `pnpm -r typecheck`: passed, including test files.
- `pnpm --filter @agent-command/game test`: **434 passed**, 75 timing-tagged tests skipped by the default command.
- `pnpm --filter @agent-command/web exec vitest run --maxWorkers=2`: **608 passed**.
- `pnpm bench:pin`: regenerated the reviewed agent-facing surface pin; committed with the retained briefing/strategy guidance.

The full timing-tagged suite, extended mirror suite and post-Fleet combined acceptance were not run here. No performance gain is claimed.
