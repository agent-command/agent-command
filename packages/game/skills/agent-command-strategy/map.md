# Map, coordinates and match rules

## Size, coordinates and frames

Retain `size = matchData.rules.map.size` during `init` (an LLM seat reads the same match data with
`game_briefing {topic:'match-data'}`): it is the numeric 48 | 64 | 80 (default 48), shared by all four planes,
never a global active-map setting. World coordinates are tiles (0..size, y down), integer cells are 0..size-1,
row-major cell `c = y * size + x`, and the centre is `(size/2,size/2)`.
Read `matchData.armies[].spireAt` for every army's Spire centre (48-default `nw` (3.5,3.5), `se` (44.5,44.5)); never
infer them from size. The map is symmetric under the turns of its slots (C2: the half turn; C4: every quarter turn).
One quarter turn maps world points `(x, y) → (size − y, x)` and cells `(x, y) → (size − 1 − y, x)`; your army's
`frame` counts the turns from the NW corner (frame 2 is the point mirror `size − x, size − y`). Plan in the NW frame
and turn by your frame. For a cell-based scouting pattern, turn the complete cell pattern first, then add `0.5` to
reach each cell centre; turning an integer world point and adding `0.5` afterward shifts the pattern by one tile.
Details and the focus rule: [armies.md](armies.md).

## Match rules

Numbers in this skill and the briefing are the **default** match rules. A host or match creator can change any of
them; `matchData.rules` (`game_briefing {topic:'match-data'}`) carries this match's actual values (costs, build
times, ranges, timings in seconds, Spire HP, time cap, map generation). Retain the match data for the match. Every
observation carries `rulesHash`, a short numeric identity of the resolved rules; a mismatch means fetch fresh match
data (`game_briefing {topic:'match-data'}`) before acting.
Policies get the full public bootstrap through a separate `init(matchData)` call before the first `think`,
including deployment probes, and retain it in sandbox state. Its independent JSON budget is 128 KiB.
Every observation, including the first, contains dynamic state only plus `rulesHash`; there is no `obs.match` or `obs.rules`.
Read unit and ordinary structure parameters from `matchData.rules.stats[kind]`, but Spire parameters from
`matchData.rules.spire`; Spires are not entries in the per-kind override table.

## Reading and sharing a map

Match creation selects a generated map with `map: {seed, params}` (`params.size` is 48, 64 or 80; `params.slots`
2 for a C2 duel map or 4 for a C4 four-corner map), a registry map with `map: {name}` (e.g. `four_corners`, FFA or a
C4 duel), or an authored map with `map: {document}`. Surface `terrain` selects the generated preset.
The numeric map rules remain in `matchData.rules.map`; there is no `rules.map.id`. Retain the public
`mapId`, `mapSeed` and `mapHash` alongside those rules. The map seed reproduces a generated map's public layers
(Surface, faults, islands) only: its underground cells, ore, magma, lodes and all weather/asteroid events come from
the match's secret seed, which is released with the replay after the match. An authored map's document is public.
A registry name or complete creator-side document is the map selection, not permission to inspect hidden content
during play. The briefing contains only public terrain, faults and schedules; no full map document, underground
cells, ore, magma or undiscovered lodes.

## What a default map contains

Generated maps place these features by default (each a `matchData.rules.map` stage; authored maps carry them as
entities). Plan for all of them:

- **Fault lines** (public, `matchData.faults`) and Sky **islands** drifting on fixed public rings.
- **Home lodes** near each base and **contested lodes** on the flanks (`rules.map.contestedZones`); discovered
  outcrops appear in `lodes` (topic `lodes`).
- **Posts:** home posts near each Spire and contested points at the centre and flanks (`matchData.posts`; topic
  `surface/front`). Contested-point seconds break ties at the time cap.
- **The Mother Lode** under the centre, known to every army from the start (`rules.map.motherLode`; `motherLode` in
  the observation; [planes/depths.md](planes/depths.md)).
- **Green rich ore** (`rules.map.richOre`, Depths code 10, public from the start) behind **lava lakes**
  (`rules.map.lavaLakes`, code 11, hidden until seen) that diggers cross with lava bridges; every home keeps a dry
  route to the centre ([planes/depths.md](planes/depths.md)).
- Natural **caverns** from each base to the centre and hidden **magma pockets** (scans locate them).

## Terrain presets and walkability

All presets use the same public walkability rules: cliffs (1), water (6), holes and known solid footprints block
Surface paths; fords (4) remain walkable. Choose a connected destination and let movement route through actual
gaps instead of assuming the diagonal or a remembered lane exists. Re-evaluate when holes or structures change.

- **Open / ridges / canyons:** use forest concealment, plateaus and ramp approaches; scout alternate lanes.
- **Chokepoint:** gather before the narrow crossing, infantry first with tanks/flak behind; scout a flank before
  committing the whole army into a firing funnel. A Depths breach can create a second front.
- **Archipelago:** follow the public land connections between islands; secure a crossing before sending builders
  or ore collectors. Air spotting and raids can pressure a distant island without abandoning the land bridge.
- **Fortress:** screen the gates and siege from outside turret range instead of feeding infantry through the door;
  use flank vision, bombers, asteroid support or a coordinated breach to dislodge a static defence.
- **Rivers:** count and scout the fords before marching; slow crossings need flak and an established far-bank screen.
  A defended ford is a choke, not a direct lane; use another crossing or breach rather than piling into it.
- **Highlands:** contest ramps, hold elevated firing positions and bring a bomber/relay/scan to reveal defenders.
  Low-ground absence is not proof a plateau is empty. Secure the ramp before advancing a mining/building crew.

The built-in bots (and the starters) resolve blocked/disconnected goals on public ground with frame-ordered
tie-breaking; their templates hold useful high ground/woods, scout flanks and siege known turret rings. This is
not omniscient route safety: unseen defenders still require scouting, and discovered outcrops alone authorize
Headframe sites.

Decode the packed terrain and the other match-data fields with the recipes in `observation.md`; the full rules
are in the `terrain` and `maps` briefing topics.
