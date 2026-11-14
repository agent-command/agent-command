# Fighting (every armed plane)

Exact numbers: `game_briefing {topic:'units'}` (stats, mounts, shields) and `{topic:'damage'}` (weapon × armour).

- `move` defaults to a plain move (`mode: "move"`): units follow their route without stopping or chasing enemies.
  Weapon mounts determine fire on the move: turret mounts fire all around, forward mounts fire only inside their
  facing arc, and fixed mounts do not fire while moving. A tank can retreat while its turret fires back.
- Use `mode: "fight"` explicitly for attack-move: a new move immediately drops the old engagement. While travelling,
  units engage enemies ahead (toward the destination), plus same-plane enemies within one tile of body contact,
  stop to fight, chase within their stance leash, then carry on. Fixed and forward mounts must face their target.
  After arrival, idle defence acquires targets in all directions again, as do attacks and patrols.
  `stance` hold/defensive/aggressive controls chasing; right-click movement does not request attack-move.
  Own-unit observations omit the default `aggressive` stance; missing `stance` means aggressive, not unknown.
- `attack` sends units to the nearest spot they can fire from, around holes and cliffs (a cratered Spire is shot at
  from the rim). It fails `no_path` when none of them can get in range; units cut off later drop the order with a
  `target_unreachable` event. A `move` into a pocket sealed by holes stops at the nearest reachable ground.
- Set a `rally` point forward of your Spire so new units gather at the front line instead of the base.
- Counters (damage table: `game_briefing {topic:'damage'}`): rifles shred light units, cannons crack armor and
  buildings, flak and missiles shred air (less so the gunship's `heavy_air`; `island` structures shrug off turrets
  and flak). MOBILE tanks gain `rules.surface.siegeRange` (default +2) against turrets
  and other structures, so they out-range turrets on level ground (8.5 vs a turret's 7.6 to a tank); a turret on high
  ground (8.6) still out-ranges low-ground tanks. Mobile tanks get no bonus against Spire segments: the beam reaches
  from the footprint edge and out-reaches them on every bearing (7.6 vs 6 beyond the edge). A SIEGED tank (`deploy`,
  3 s set-up) reaches 9 beyond a structure's edge and 7.5 beyond a unit's, never closer than 2, over cliffs at what
  your team sees. Against a Spire segment it reaches only 7 from the footprint edge to its own body edge
  (`siegeSpireRange`): exactly the beam's reach, so the Spire always shoots back. Kill or pull the defenders first
  and bring enough tanks to outlast the beam.
  Screen the siege with infantry/flak; shells and flak fly to where a target *was*, so fast air dodges shells but not missiles.
- Queue orders (`queue: true`) and `patrol` to keep a front without micromanaging.
- Every Spire segment fires its beam only on its own plane (`rules.spire`: default 30 damage, range 7 from its
  footprint edge to the target's edge, 1 s cooldown).
