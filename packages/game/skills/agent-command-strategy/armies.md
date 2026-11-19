# Armies, frames, focus and elimination

A match has 2–4 armies. Each is a full player (own Spire, economy, queue and four seats) on a map corner; its id is
that corner: `nw`, `ne`, `se`, `sw`. Two-slot maps use `nw` and `se`; four-slot maps (four_corners, or a generated
map with `map.params.slots: 4`) all four. `obs.army` is yours. `matchData.armies` lists every army of the match as
`{id, slot, frame, colour, spireAt}`; read Spire centres there (48-default `nw` (3.5,3.5), `se` (44.5,44.5)), never
infer them from size. `colour` (blue, red, green, violet) is the alliance: another colour is hostile, and in
free-for-all every army has its own colour. Entity, event, charge and impact `side` is an army id or `neutral`:
treat `side !== obs.army && side !== 'neutral'` as "some other army", and look up its colour for hostility.

## Frames

`frame` (0..3) is the quarter turns carrying the NW corner onto the army's corner. One turn maps a world point
`(x, y) → (size − y, x)` and a cell `(x, y) → (size − 1 − y, x)`; frame 2 is the point mirror
`(size − x, size − y)`. Two-slot maps are point-symmetric (C2), four-slot maps quarter-turn symmetric (C4,
`matchData.symmetry`). Plan in the canonical NW frame and turn the plan by your frame; break ties by the cell's
index in your frame, so rotated armies take rotated decisions. For a cell-based scouting pattern, turn the complete
cell pattern, then add `0.5` to reach each cell centre; turning an integer world point and adding `0.5` afterward
shifts the pattern by one tile. Weather paths carry `turns` instead: evaluate the canonical point, then turn it.
Structure anchors turn as footprints ([queue-and-teamwork.md](queue-and-teamwork.md)).

## Focus

With several hostile armies, pick one to attack and keep it: the built-in bots (and so the starters) take the live
hostile army with the nearest Spire (distance between `spireAt` centres), then the lowest last-known Spire HP
(hostile `spire` entities you have seen; unseen segments count full), then clockwise relative order
`(frame(them) − frame(you)) mod 4`, so equidistant FFA neighbours resolve clockwise and every seat of one army agrees.
Re-focus only when the focus is eliminated. Defend against any hostile at home, and count threats over all
hostiles. Veteran bots also avoid feeding the strongest visible army. The rule and the frame helpers are in
`policies/game/bots/context.js` (`chooseFocus`, `Frame`: `toWorld`, `toCanon`, `cell`, `cellKey`).

## Elimination, crowns and ranks

`rules.spire.lossRule` decides when an army is out. `surface`: its Surface segment falls. `crowns`: a fallen Surface
segment costs `crownsSurface` (2) crowns, any other segment `crownsSide` (1), and the army is out at `crownsToLose`
(2): the Surface alone, or any two side segments (3,500 HP each there). `obs.crowns` lists every army's crowns lost
and fallen segments, and every fall is the public event `crown_lost`: one crown from out is match point, so defend
(alert `segment_threatened` → signal `defend`, [signals.md](signals.md)) and rebuild (`queue_add` `rebuild` with its
`plane`: once per match, it returns the crown; it pauses while an enemy you see stands near). Then pick the
cheapest crown: least known HP per crown; the built-in bots push it with the seat of its plane. A forfeit also ends
an army. Out: every remaining entity of it is removed, a public `army_eliminated` event names it (`side`), the plane
that decided it and the `killer`, and `obs.eliminated` lists every army out so far. Your own intents then fail with
`eliminated`. The match goes on until at most one alliance remains; at the time cap fewest crowns lost, then most
Spire HP wins. `obs.rank` (1 = winner, ties share) appears once your result is final, and the report's `armies`
rows carry every army's rank. In FFA, an eliminated neighbour opens its corner: re-focus, and expect the survivors
to come for whoever is strongest.

## FFA strategy

Two neighbours flank you and the far corner waits. Do not throw the whole army at the first target while the other
neighbour walks in behind it: keep a home guard and turrets on both approaches, take the flank lodes on your own
edges, and time your push for when your focus is already fighting someone else. Orbit strikes and Sky captures pay
off against whoever is weakest; the centre is contested by everyone.
