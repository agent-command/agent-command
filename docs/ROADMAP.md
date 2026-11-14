# Agent Command — Roadmap

What is not shipped yet. The shipped game and its rules are in [DESIGN.md](DESIGN.md); notable changes are in the [CHANGELOG](../CHANGELOG.md). When an item ships, its design moves into DESIGN and the item leaves this file. Every new number an item introduces is a named match rule, and every mechanic ships complete (sim, rules, intents, fog-safe observations, bots, example policies, skill, briefing, client, tests), as [AGENTS.md](../AGENTS.md) requires.

- **Next:** the work in front of us now.
- **Later:** designed or researched features, parked until there is a fresh balance baseline and room to change the agent surface.
- **Ideas:** parked options with no plan yet.

## Next

### ACBench v1

The public benchmark measures **policy authoring**: each model commands all four planes with one policy per role, starting from the starter policies at default knobs, through a pinned OpenCode harness (skills over MCP, web search and fetch off) for a fixed 45-minute wall clock with no early exit. Its final policies are scored by win rate against the fixed bot ladder (novice, standard, veteran, and veteran at +15 % and +30 % income: elite, champion; `docs/benchmarks/acbench.md`) on both C2 sides, three maps and several seeds, over five runs per model; the headline is the improvement over the untouched starters on the same ladder, with mean and spread. Live model-vs-model play is an exhibition only, never scored. Sequence: starters and harness fixes, a small pilot, then v1, each step under an approved spend cap. Plan: no memo in `docs/research/` yet.

### Fresh baseline sweep

One sweep on the current build, sized for 95% intervals within ±15 points on the probe ceilings and published as `docs/balance/baseline-c2.md`. It is the reference for everything tuned below and decides three pending defaults: switching `spire.lossRule` to `crowns`, confirming `map.spireInset` (insets compared on match length, side bias, outer-ring structure value, lode contest and array losses), and a bomber energy re-cost if bombers stay rare. Targets it measures: standard and veteran mirror medians of 10–15 minutes; impacts at most a minority share of Surface Spire damage; no plane over 60% of Spire damage and at least three planes above 5%; at least two unit kinds per plane in real use; bombers and scans used; every forced probe (including `derelict-camp`, `siege-turtle`, `lancer-night-siege`) at or under 65%; both sides acting on every plane in the first 60 seconds. Method: [docs/balance](balance/README.md).

### FFA pacing

Four-army free-for-all misses its 12–20 minute band: unequal tiers reach the 30-minute cap with few eliminations on M64 `four_corners` and S48 C4, and a standard bot needs a long time to eliminate an idle army in a C4 duel. The fix is a rules default (smaller FFA maps, a faster economy) or a weakest-neighbour focus rule, chosen by sweeps. No memo yet.

### Derelict core numbers

The bots now contest the core (tug gate, mirror-safe tie back-out and rest, no chamber entry when disabled, fleets outside the radiation). Rerun the memo's experiment on the current bots and re-check the core's numbers. Memo: [derelict core audit](research/derelict-core-audit.md).

### Infantry spacing against tanks

Bots, example policies and the strategy skill should spread infantry into a line against tanks: in the duel lab the same troopers lose as a block and win as a line. The fix is behaviour, not a rule change (`movement.slotGap` is global). Memo: [Surface anti-tank and mooring](research/surface-antitank-and-mooring.md) §A.

### Purposeful mooring

Bots never moor: army production always spends the alloy a tower needs first. Give them reasons: fund towers through the shared queue, then moor to defend, to hold an island over a fight, to catch an enemy island for capture, or to bridge. Add mooring counts to the balance metrics. Memo: [Surface anti-tank and mooring](research/surface-antitank-and-mooring.md) §B.

### Readability and agent tools

The remaining alerts (Surface `breach_near`, Sky `drop` and `pass`, each fog-twin tested); Orbit planning overlays (hostile beam and point-defence rings with the night ring, impact footprint and fuse reach on a selected tow, Surface range rings); fog-safe known ore remaining per cell with a tooltip; and the agent macros `hold_vantage` and `siege`, ported from the Surface bot. No memo yet.

### Performance and coverage

Focused-plane rendering (simulate every plane, spend presentation on the visible one, recover cleanly on a plane switch), WebGPU and representative-hardware coverage, and a quiet-machine measurement of the per-tick sim budget. Triage the known failing tests: `policies.test.ts` map-dimension and example-vs-novice cases, seven `bots.test.ts` unit cases, Surface breach cases, nine collapse-audit cases and the veteran-vs-novice timeout (to the slow lane). No memo yet; capacity background in [scaling](research/scaling.md).

### Public deploy template

The one-click Deploy button and Railway template.

## Later

### Colour teams

Stage 3 of the four-army design: duplicate colours, so armies sharing a colour are allied, with ranked play limited to the `adjacent` and `opposite` 2v2 layouts. It lifts the single-army alliance limit and turns on what [DESIGN §15](DESIGN.md#15-four-armies-free-for-all-and-colour-alliances) already defines: shared vision groups, ally-safe weapons and bulkheads, alliance capture, victory and spectating, contract `allies` with a bench re-pin, alliance focus and ally defence in bots, a derived layout label in the lobby, ally rendering with corner emblems, alliance observer perspectives, a dev-mcp `teams` mode and 2v2 sweeps. Proof: rotation checks for both 2v2 layouts, shared-vision twin-world tests, one test per allied rule. No memo yet.

### Rocketeer

A Trooper converted at the Drill Yard into a rocket infantry unit, the Surface's own answer to massed armour, paid and timed like the Breacher and sharing its yard, so every conversion is a choice between flame and rockets. Memo: [Surface anti-tank and mooring](research/surface-antitank-and-mooring.md) §A4–A6.

### Spider mech and Space Elevator

A late-game cross-plane chain: Orbit builds the walker at a gantry, the Sky hosts the elevator, it descends the cable as a public transit, and the Surface receives a mech that can break posts and threaten Spires. Every plane can interrupt a different step. Needs the first Orbit structure first; a mech that falls into a hole meets the fallen-vehicle rule (`surface.vehicleFallDamage`). Memo: [Spider Mech and Space Elevator](research/spider-mech-elevator.md).

### Combo plays

Cross-plane plays where each step is useful alone, every step is publicly telegraphed, the reward grows with the planes involved, and all of it stays symmetric and fog-safe:

- **Island bridge** (Sky + Surface): a Mooring Tower lowers a captured island over a lava lake or chasm and tanks drive across; shooting the tower lifts it mid-crossing.
- **Undermine** (Depths + Surface): the Depths hollows a cavern under a base and Surface artillery collapses it.
- **Orbital designator** (Orbit + Surface): a Surface spotter paints a target and the Lancer Lens reaches the ground through a gap in the clouds.
- **Deep strike** (Orbit + Sky + Depths): the Sky clears storms over a column, Orbit drops a large rock, and its crater opens a breach for a waiting squad.
- **Geyser launch** (Depths + Surface + Sky): Mother Lode vent pressure, capped by a Surface structure, launches ore to a Sky island.
- **Spire overload** (all): damage on three or four segments of one Spire within seconds stuns it.
- **Operations** (all): named multi-step plays that agents coordinate through team signals, shown to teammates and observers.

No memo yet; the closest is [Spider Mech and Space Elevator](research/spider-mech-elevator.md).

### Water floods

A Surface hole opened beside water or a ford floods the tunnels below it, using the magma flood's spread: up to `waterFloodCells` connected tunnel cells over `waterSpreadTicks`, from the hole outward, as a new Depths cell code. Flooded tunnel is passable but slow (`waterSpeed`), deals no damage and blocks digging from inside it. The flood drains `waterDrainTicks` after its source closes (the hole backfilled), and water that reaches magma or a lava lake cools it to rock, so flooding a lava channel is a way across without a bridge. The hole shows a waterfall from the Surface, so the flood is telegraphed; the Depths army sees flooded cells it can see. Bots weigh flooded cells in routing, and Surface and Orbit bots can crater beside water over enemy tunnels to slow a push. Client: a waterfall sheet and mist at the hole, a water surface on flooded cells. Open question first: map generation turns Depths cells under Surface water into bedrock, so a flood needs a hole on the bank over a tunnel; scan the presets for how often that occurs, and decide whether generation should route some tunnels near water. No memo yet.

### Island storm shelter

A resource island structure projects a storm shelter: own aircraft parked within `shelterRadius` take `shelterStormDamage` × storm damage (partial, not immunity) while its army pays the structure's upkeep, and the shelter glows visibly so enemies know something may be parked there. It gives a reason to hold and park at resource islands and makes them worth defending. Today only the Aerie hangar (no damage, but occupants cannot fight) and a Storm Seeder's own storm reduce storm damage. Open decision first: the main slot (beside Relay, Aerie, Stormcatcher and Seeder, so it competes with them) or the secondary hardpoint (beside the Ore Extractor, Gun Platform and Island Mortar, possibly as a property of the Ore Extractor itself). Balance trap to test: storms already hide air from flak, turrets and Orbit, so a shelter inside a storm must not make a fleet both hidden and near-immune.

### Per-plane supply

Replace the one army population cap with per-plane supply. Parked at experiment E0: the cap never binds today, so the first step only measures. Memo: [per-plane supply](research/per-plane-supply.md).

### Orbit events and hazards

The rest of Orbit as a mini space RTS: **comets** (public paths, two tugs to catch, dock or drop), **mega rocks**, **solar flares** (public warning; lit arrays earn more but take damage, folded arrays are safe; with *Folding Arrays* research), **debris fields** from wrecks (a hazard and cover), the tug **shove**, **island strikes** (a rock landing under an island hits its structure and spares the Surface), and escorts that draw the segment beam. Each follows the C4 orbit rule. No memo yet.

### Capacitors and relocation

**Orbital capacitors** store undelivered solar for the night as a raidable upgrade of the solar bank, capped per army. **Relocation** is one registry verb for a structure kind (`relocate {to, becomes, keeps, time}`): a capacitor dropped to the Surface as a ground capacitor, a Relay launched into Orbit as a relay satellite. Guard rails keep it a rescue: only below half segment HP, slow and telegraphed, lossy, once per structure, landing only in own territory with no impact damage. The same payload pipeline then carries **deliveries** (supply crates, drop pods). No memo yet.

### Spire progression and research

**Spire tier 2** per segment (advanced builds and a second research slot). **Spire Awakening:** once per match an army awakens one segment and picks its passive or active path (eight options: Foundry with *Quake*, a damage-only shockwave; Citadel with *Overcharge*; Tempest with *Gale*; Observatory with *Sunfall*), publicly telegraphed, visibly drawn on the segment, and balanced so every option wins 45–55% against every other in mirrored sweeps. Content waiting on it: *Foundations* and *Field Repair* (Surface research), the damage-only **seismic mortar** (Surface into the Depths), the **Skyspear** and **Siphon** island builds, rails gated by Depths tier 2, and researched Spire shields under the one shield cap. If *Foundations* ships (−75% collapse and impact damage), recheck the sapper stack math first: two stacked sappers fell a Headframe or Shaft today (the bots' and starters' `stackFor`), and since a hole never empties a lode, felling the Headframe is the only lode raid. No memo yet.

### Community bots and maps

An in-game gallery to browse, fork and adopt published bot packages, with lineage on each bot (import and export already ship), and a built-in map editor over the map document, including explicit lode anchors. No memo yet.

### 24/7 streaming

Watch live as a nonstop broadcast: a budget-limited match scheduler and a separate broadcast service (rendering, encoding, platform output, moderation and a kill switch). No memo in `docs/research/` yet.

### Fast lane for player policies

Run user policies in V8 isolates (`isolated-vm`) for V8 speed with isolation, against QuickJS's smaller security surface and memory footprint. Determinism stays with deterministic math in the policy runtime. No memo yet.

## Ideas

- **Barracks:** a second Surface production line for infantry. Deferred; revisit only if it can also build tanks.
- **More Surface units:** veterancy, a Medic, a Motor Pool, *Proximity Fuses* for flak; only if sweeps leave room.
- **Orbit abilities:** Tug Slingshot, Lancer Refract and Sever.
- **Surface wreck salvage**, if sweeps show the alloy fallback is too low.
- **A weapon-specific moving-fire penalty**, if measurements call for one.
- **The Sky segment beam ignoring island structures**, if passes over a base still end in automatic kills.
- **Taped notes:** the masking-tape and paper-grain look for commander notes, chat and toasts, in a dark variant.
- **Transit extensions:** relocation with kind conversion, public climb and dive trails, and configurable targetability while travelling, for content that needs them (see the [Spider Mech memo](research/spider-mech-elevator.md)).
