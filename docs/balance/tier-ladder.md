# Tier ladder

Built-in bot tiers against each other on the ACBench scoring maps, with the early-rush defence and breach fixes (bot library rebuilt, traces re-recorded). Every seat is a bot of the named tier on all four planes.

- Maps: `crossfire`, `twin_fords`, `crown`. Seeds: the ACBench scoring seeds from 5101 (veteran vs standard: 8 seeds; the novice pairings: 4 seeds).
- Both sides: every seed is played twice, with the stronger tier as nw (blue) and as se (red).
- Full length: the 30-minute cap. A capped match counts as a draw, as in ACBench scoring.
- Runner: the balance harness (`tools/balance`, `runBalance`), 2 workers, on cores 0–1, chunked by pairing and map.

The maps are mirrored, so a seed often plays out identically from either side. Only 33 of the 48 veteran-vs-standard matches have distinct outcomes, and 12 of the 24 in each novice pairing do. The Wilson intervals below treat all matches as independent, so they are narrower than the data supports.

## Results

W–L–D is from the stronger tier's side, with capped matches counted as draws. "Ahead at cap" counts the capped matches in which the stronger tier had more total Spire HP when the cap hit.

| pairing | n | W–L–D | win rate [95% Wilson] | score (draw ½) | wins as nw | wins as se | capped | ahead at cap | median length (min) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| veteran vs standard | 48 | 0–2–46 | 0% [0%–7%] | 48% | 0/24 | 0/24 | 46 | 4/46 | 30.0 |
| standard vs novice | 24 | 0–2–22 | 0% [0%–14%] | 46% | 0/12 | 0/12 | 22 | 20/22 | 30.0 |
| veteran vs novice | 24 | 2–14–8 | 8% [2%–26%] | 25% | 1/12 | 1/12 | 8 | 8/8 | 14.2 |

### Per map

| pairing @ map | n | W–L–D | win rate [95% Wilson] | score | wins nw / se | capped | median length (min) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| veteran vs standard @ crossfire | 16 | 0–2–14 | 0% [0%–19%] | 44% | 0/8 / 0/8 | 14 | 30.0 |
| veteran vs standard @ twin_fords | 16 | 0–0–16 | 0% [0%–19%] | 50% | 0/8 / 0/8 | 16 | 30.0 |
| veteran vs standard @ crown | 16 | 0–0–16 | 0% [0%–19%] | 50% | 0/8 / 0/8 | 16 | 30.0 |
| standard vs novice @ crossfire | 8 | 0–0–8 | 0% [0%–32%] | 50% | 0/4 / 0/4 | 8 | 30.0 |
| standard vs novice @ twin_fords | 8 | 0–0–8 | 0% [0%–32%] | 50% | 0/4 / 0/4 | 8 | 30.0 |
| standard vs novice @ crown | 8 | 0–2–6 | 0% [0%–32%] | 38% | 0/4 / 0/4 | 6 | 30.0 |
| veteran vs novice @ crossfire | 8 | 0–4–4 | 0% [0%–32%] | 25% | 0/4 / 0/4 | 4 | 17.3 |
| veteran vs novice @ twin_fords | 8 | 2–2–4 | 25% [7%–59%] | 50% | 1/4 / 1/4 | 4 | 27.5 |
| veteran vs novice @ crown | 8 | 0–8–0 | 0% [0%–32%] | 0% | 0/4 / 0/4 | 0 | 4.6 |

## Verdict

**The ladder does not hold on these maps.** Veteran's lower bound against standard is 0%, far below the 55% target. Neither tier breaks the other's Spire inside 30 minutes, and standard leads on Spire HP at the cap in 42 of 46 capped matches (mean 13,682 HP against veteran's 10,775). Veteran also loses to the novice. Standard draws every match against the novice that it doesn't lose, though it leads on HP at the cap in 20 of 22.

## Why veteran loses to the novice (fast losses, about 4.5 minutes)

Twelve of veteran's 14 losses to the novice end between 4.3 and 5.3 minutes, all on crown and crossfire. In every one, the novice's ~36 troopers and 3 tanks kill the Surface Spire. Veteran's Surface produced 2 tanks and at most 1 trooper in that time.

A per-tick trace of crown seed 5101 (`tmp/BotStrength/diag-acb.ts`) shows why. At tick 30 the veteran queues the Surface research `ascent_thrusters`, then a solar, a tank and a digger. All of them are unpaid and waiting, so they share the incoming alloy: `freeAlloy` stays at 0, and at tick 1,170 the queue still holds 262 alloy. The tank queued at tick 180 is still waiting at tick 1,170 (about a minute later). The early troopers die at the centre point and on the headframe walk between ticks 700 and 1,200. From then on, the defend-mode fighter that the Spire-under-attack rule queues can't be funded, because everything ahead of it in the queue holds the money.

The bots.test seeds run on the default map, where veteran beats the novice 9 of 10. These maps punish the early research.

## What standard does better against veteran (all 48 matches, means per match)

| | veteran | standard |
| --- | --- | --- |
| diggers produced | 20.5 | 9.1 |
| sappers produced | 6.3 | 3.1 |
| troopers produced | 8.4 | 22.7 |
| flak produced | 2.9 | 5.5 |
| Wardens produced | 2.7 | 5.9 |
| lancers produced | 3.1 | 6.3 |
| bombers produced | 0 | 4.0 |
| Depths / Surface / Sky / Orbit units at 10 min | 2.5 / 1.8 / 0.6 / 10.3 | 11.0 / 3.9 / 2.8 / 15.3 |
| Surface Spire damage taken from Surface | 1,661 | 333 |
| Surface Spire damage taken from Sky | 691 | 0 |
| Orbit Spire damage taken | 925 | 74 |

Veteran spends its economy on its Depths tunnel and sapper waves (`tunnelAt` 240 s, `sappers` 3, `troopersDown` 4, `breachEvery` 150 s). It replaces the diggers it loses in the tunnel more than twice over. It ends with fewer units on every plane, takes five times the Surface damage, and has no anti-air answer to standard's bombers.

## Proposed veteran changes (not implemented)

1. **No research before an army.** Gate Surface research such as `ascent_thrusters` (and any other unpaid queue item that holds funds) behind a minimum fielded Surface army, or behind `attackAt`. While the Spire is under attack, cancel or dequeue unpaid non-fighter items so the defend-mode fighter is funded first.
2. **Tunnel only from a lead.** Start the `tunnelAt` push and sapper waves only once the Depths holds its own (for example, own Depths fighters ≥ hostile ones seen) and the digger crew is intact. Cap digger re-buys at the tier's `diggers` count plus a small margin.
3. **Fewer troopers sent down.** Use standard's `troopersDown` (3) and `breachEvery` (180 s), or send troopers down only while the Surface army is at or above `attackAt`, so the Surface keeps its trooper count.
4. **Keep anti-air in the mix.** Hold a flak floor (for example, one flak per hostile bomber or gunship seen, at least 2), and answer Sky bombers with interceptors before Orbit or Depths spending.
5. **Re-measure** with this ladder at n ≥ 48 per pairing, since a 30-minute cap draws most matches. A cap tiebreak on Spire HP would separate the tiers far better than wins alone: on HP, standard leads veteran 42 to 4.
