# Economy: energy delivery, upkeep, segment loss and fallbacks

Rules and defaults: `game_briefing {topic:'resources'}` and `{topic:'geothermal'}`; how `res.income` is reported
is in `observation.md`.

Shared income does not grant control of other planes. Recovery production stays with its authorized role:
Depths queues replacement diggers (including through Surface Shafts) and geothermal taps, Surface queues
Shafts and Headframes, Sky queues Relays and aircraft, and Orbit queues arrays. Leave human planes and owner
commitments alone; coordinate spending and request support rather than queueing another role's recovery.

The shared bank is not four wallets. `res.alloy`/`energy` are totals; `freeAlloy`/`freeEnergy` are the authoritative
availability for new purchases after total lane holds and finite energy `upkeepHeld`. Reported recovery holds
are subsets of total holds, not additional deductions. Do not subtract waiting costs again; direct spending may add
only your own lane's normal holds. Blocked heads gain no more funds and retain holds only for the configured grace.
Recovery below `rules.queue.recoveryWorkers` (default 2) still needs a real Depths digger request and valid producer;
`rules.queue.recoveryFraction` (default 0.2) caps recovery while normal demand exists. No allocator invents income:
zero income and insufficient bank cannot finish funding, and producer blocks require their own remedy.
See [queue and teamwork](queue-and-teamwork.md) for role-local order and mutation authority; there is no global ETA.

## Energy delivery

- Orbit solar arrays make the bulk of the energy; delivery to the team is capped at `res.energyCap`.
- The base delivery cap is `rules.economy.baseEnergyCap` (default 4 energy/s) while your Sky Spire segment lives;
  each Relay adds `relayEnergyCap` (default 4 energy/s). Losing the Sky segment drops the base to
  `minimumEnergyCap` (default 1 energy/s); surviving Relays still add their normal cap. Tanks, interceptors and
  bombers stall when delivery collapses.
- Stormcatchers (Sky), geothermal taps (Depths), ice docking/mining cargo and the derelict cash-in deliver directly and bypass the delivery cap.
- **Solar bank:** solar above the cap is not wasted. `rules.economy.solarBankRate` (default 1) of the surplus
  charges `res.energyBank`, up to `rules.economy.solarBankMax` (default 300 energy). Whenever solar falls below
  the cap (night, dead arrays) the bank discharges through it, topping delivery back up to the cap, never above.
  Five home arrays make 10/s by day and 4/s at night against the base cap of 6: the day's 240 surplus covers the
  night's 120 gap. Past that, more arrays only help after more Relays. The bank is team storage: it cannot be raided.

## Upkeep

Built consumers draw energy every second, pooled in `res.upkeep`: turret `turretUpkeep` 0.25 and Aerie
`aerieUpkeep` 0.5 energy/s by default; a Storm Seeder only while its seeded storm blows (`seederUpkeep`, default 0).
Activations pay at once instead: `seed` (`rules.sky.seederCost`, default 40). Surface Mooring Towers draw
`rules.surface.mooringUpkeep` (default 3 energy/s) while lowering/held, not while waiting.
When the team cannot pay upkeep, consumers lose power: turrets stop firing, Aeries stop producing,
airdropping and repairing, seeded storms end. Moorings spend their nonrenewable unpaid/power-loss grace
(`mooringGraceTime`, default 3 s), then raise into safe gaps on their original delayed routes; restored power never
refills that grace. Rejoin starts the island cooldown (`mooringCooldown`, default 20 s).

Ore Extractors transfer finite island ore into an owner buffer at `rules.sky.extractorRate` (default 0.5 alloy/s),
paying `extractorUpkeep` (1 energy/s) only while working, until `extractorBuffer` (40) is full. No direct income:
Sky `drop_ore {island}` releases an ordinary cache; Surface collects it. Full/depleted pauses draw no work upkeep.
Preserve rich-lode priorities and sustainable energy; lifecycle and privacy: `game_briefing {topic:'sky/ore'}`.

## Survive segment loss

Existing miners keep working when the root falls, but its production stops and the
Spire alloy trickle halves (default 2 → 1 alloy/s). Protect Shafts as drop-offs and emergency digger producers;
the rootless digger surcharge (`queue-and-teamwork.md`) keeps the Depths as the main alloy plane rather than moving
its job to the Surface.
Losing Sky leaves `rules.economy.minimumEnergyCap` (default 1 energy/s) base delivery, plus surviving
Relays' normal cap. Losing Orbit stops scans and new Orbit production, not surviving arrays, the solar bank or
local taps (which then run at the full `geothermalRate`).

## Geothermal fallback (Depths seat)

Only after losing the Orbit segment, use `queue_add {item: 'geothermal', x, y, digger?}`
on **known rock cardinally beside a located sealed pocket** in `pockets`. One tap per pocket; count teammates'
queued taps too. Dig an approach beside the site without digging the site or breaching its pocket.
A free digger builds it like a bulkhead: default 120 alloy, 0 energy, 5 s, 300 HP (`rules.stats.geothermal`).
It earns `rules.economy.geothermalRate` (default 0.5 energy/s) once your Orbit segment is destroyed, but only
`rules.economy.geothermalHealthyRate` (default 0.15 energy/s) while it lives; no delivery-cap requirement.
Breaching its pocket multiplies output by `rules.economy.geothermalSurgeMultiplier` (default 4) during
the flood (`rules.depths.magmaCoolTime`, default 60 s); then the lava cools to open tunnel and the tap earns nothing. Lava is not a tap site.
Enemy diggers or sappers can breach the pocket, so defend the access; do not intentionally burn a steady source.
The built-in bots and starters build **no taps while Orbit is healthy**: fallback income must not
replace bulk solar (healthy-Orbit fallback share should stay below about 10%).
