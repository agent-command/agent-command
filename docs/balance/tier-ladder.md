# Tier ladder

Built-in bot tiers against each other on the ACBench scoring maps. Every seat is a bot of the named tier on all four planes. The target: each stronger tier wins with the lower bound of its 95% Wilson interval above 55%.

## Method

- Maps: `crossfire`, `twin_fords`, `crown`.
- Seeds: the ACBench scoring seeds from 5101. Veteran vs standard plays 8 seeds (5101–5808); the two novice pairings play 4 (5101–5404).
- Both sides: every seed is played twice, with the stronger tier as nw (blue) and as se (red).
- Full length, to the 30-minute cap. Each match counts as the game decides it, as ACBench scores it: a match still running at the cap goes to the side that lost fewer crowns, then to more total Spire HP, then to more contested-point score, and is a draw only when all three tie (DESIGN §2, time cap).
- Runner: the balance harness (`tools/balance`, `runBalance`), 2 workers per chunk, chunked by pairing and seed range across two pairs of cores.

The maps are mirrored, so a seed often plays out the same from either side. In every pairing each seed × map went the same way from both sides; the results differ between sides only in Spire HP in 11 of the 24 veteran-vs-standard seed × map pairs. Counted per seed × map, veteran beats standard in 23 of 24 (Wilson lower bound 80%), standard beats the novice in 10 of 12 (55%) and veteran beats the novice in 12 of 12 (76%). The match-level intervals below treat both sides as independent, so they are narrower than the data supports.

## Results

W–L–D is from the stronger tier's side. "Spire kills" are wins before the cap; "won at cap" counts the capped matches the stronger tier won on the cap verdict.

| pairing | n | W–L–D | win rate [95% Wilson] | wins as nw | wins as se | Spire kills | capped | won at cap | median length (min) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| veteran vs standard | 48 | 46–2–0 | 96% [86%–99%] | 23/24 | 23/24 | 15 | 33 | 31/33 | 30.0 |
| standard vs novice | 24 | 20–4–0 | 83% [64%–93%] | 10/12 | 10/12 | 0 | 22 | 20/22 | 30.0 |
| veteran vs novice | 24 | 24–0–0 | 100% [86%–100%] | 12/12 | 12/12 | 2 | 22 | 22/22 | 30.0 |

### Per map

| pairing @ map | n | W–L–D | win rate [95% Wilson] | wins nw / se | Spire kills | capped | won at cap | median length (min) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| veteran vs standard @ crossfire | 16 | 16–0–0 | 100% [81%–100%] | 8/8 / 8/8 | 9 | 7 | 7/7 | 28.5 |
| veteran vs standard @ twin_fords | 16 | 16–0–0 | 100% [81%–100%] | 8/8 / 8/8 | 0 | 16 | 16/16 | 30.0 |
| veteran vs standard @ crown | 16 | 14–2–0 | 88% [64%–97%] | 7/8 / 7/8 | 6 | 10 | 8/10 | 30.0 |
| standard vs novice @ crossfire | 8 | 8–0–0 | 100% [68%–100%] | 4/4 / 4/4 | 0 | 8 | 8/8 | 30.0 |
| standard vs novice @ twin_fords | 8 | 8–0–0 | 100% [68%–100%] | 4/4 / 4/4 | 0 | 8 | 8/8 | 30.0 |
| standard vs novice @ crown | 8 | 4–4–0 | 50% [22%–78%] | 2/4 / 2/4 | 0 | 6 | 4/6 | 30.0 |
| veteran vs novice @ crossfire | 8 | 8–0–0 | 100% [68%–100%] | 4/4 / 4/4 | 0 | 8 | 8/8 | 30.0 |
| veteran vs novice @ twin_fords | 8 | 8–0–0 | 100% [68%–100%] | 4/4 / 4/4 | 2 | 6 | 6/6 | 30.0 |
| veteran vs novice @ crown | 8 | 8–0–0 | 100% [68%–100%] | 4/4 / 4/4 | 0 | 8 | 8/8 | 30.0 |

## Verdict

**The ladder holds on all three pairings.** Veteran beats standard 46–2 (lower bound 86%), standard beats the novice 20–4 (64%) and veteran beats the novice 24–0 (86%).

- Veteran's only losses to standard are crown seed 5303 from both sides, on the cap verdict (Spire HP 9,200–10,200 against 12,600). In its 31 capped wins veteran keeps 13,700–14,500 Spire HP against standard's 3,200–12,000.
- Standard's four losses to the novice are all on crown. Seed 5101 falls to the novice's opening rush at 4.9 minutes from both sides; seed 5303 goes to the novice on the cap verdict.

## Veteran's tier

What took veteran from losing this ladder to leading it (`packages/game/src/bots/tuning.ts`, the veteran tier):

1. **Army first** (`armyFirst` 12). Until 12 Surface fighters stand at once, or `ARMY_FIRST_OPENING` (6 minutes) at the latest, and again while a stronger hostile Surface force is in sight or the Surface Spire segment is under attack, no seat buys research or commits anything but the Surface army and a first Headframe before the free bank covers it. The army gathers at the Spire, not at the forward rally point. Under attack, unpaid entries outside the Surface army are cancelled so the defending fighter is paid first. Before this, unpaid research and economy entries split the shared income, and the novice's opening rush met a Surface lane with almost none.
2. **Tunnel only from a lead** (`depthsLead` 1). The tunnel and sapper waves wait while the digger crew is short or the Depths fighters are outnumbered; outnumbered below, Wardens come before the rest of the crew. Lost diggers are re-bought at most 4 times (`diggerRebuys`).
3. **Fewer troopers sent down** (`troopersDown` 3, `breachEvery` 180 s), standard's values.
4. **Anti-air in the mix** (`flakFloor` 2). A flak floor once the army stands, plus one flak per hostile bomber or gunship seen in the last minute.
