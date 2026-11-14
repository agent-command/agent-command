# Dig plans (`designate`)

Shared Depths dig plans from any seat; back to [depths.md](depths.md).

Any seat can send `designate` with exactly one of `rect: {x0,y0,x1,y1}` (inclusive) or
`cells: [{x,y}, ...]`, and `priority: 1` normal, `2` urgent or `0` clear. Coordinates are integer cells 0..size-1,
not tile centres. Tag a connected corridor from open ground, not only a distant endpoint: default diggers
work the highest-priority reachable frontier, nearest by reachable distance, and expose the next cells.
Diagonal steps work too: the digger opens one shared orthogonal connector before the tag, preferring an already
tagged connector, then rock, ore and fortified rock. It never tunnels other untagged walls to reach a distant plan.
Unreachable tags remain queued (dimmed in the client), not cancelled; worker caps also cover corner connectors.
Tags are shared with the whole team, never the enemy, and can cover unexplored cells without revealing them.
A tag clears when your team knows the cell is open, bedrock or Mother Lode. Read `rules.depths.designateCells` (default 256
cells per intent), `designateMax` (512 per team), and `designateWorkers` (2 diggers per frontier cell); batch longer plans.
Tags do not interrupt explicit tactical orders. The Depths bot tracks only normal tags it creates and clears
them when no current route needs them; observed teammate tags and all urgent tags are preserved. This is
local memory, not server ownership: a teammate adopting the same normal tag without changing its priority
is indistinguishable, so coordinate shared edits. A changed observed priority relinquishes the local claim.
It tags ordinary ore approaches only after reachable veins run out, leaving the ore itself for mining;
without known ordinary ore it tags a short unknown frontier, using only the team's remembered map.

The Depths bot publishes normal ore-expansion, lode, preventive fault-guard and planned sapper approaches, with urgent
bulkhead and breach approaches. Automatic miners work these shared routes without per-tick orders; targeted lode miners
keep earning. Fortification stays an explicit `fortify` order, and gate construction still uses `queue_add`.
Cell scans, route neighbors and equal-distance choices follow the army's frame; routes never read hidden terrain.

