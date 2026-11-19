# Depths fighting: Wardens, the trooper combo and sappers

Rules: `game_briefing {topic:'depths/wardens'}` and `{topic:'collapses'}`. Depths basics are in
[depths.md](depths.md).

## Wardens

`queue_add {item: 'warden'}` at your root: 60 alloy + 20 energy, 160 HP, light armour, a range-2 shotgun that shreds
diggers, sappers and troopers in corridors (weak against structures). Wardens never leave the Depths. Keep two or
three once the mining crew is up, more under pressure.

- **Shield wall.** `deploy {units, on: true}` raises it where the Warden stands (2 s, no firing). Walled, it cannot move, takes
  ×0.4 damage (`wallDamageTaken`), fires normally, and blocks hostile units while friendly units pass through.
  The shield opens and closes for friendly traffic without packing; fire passes over it both ways. Own units within `wallCoverReach` (1.5 tiles) are in its cover: ×0.8 damage from enemy fire and
  +`wallCoverRange` (1.5) weapon range. Any order but `attack` or `stop` lowers the wall first (1 s, no firing);
  `deploy {units, on: false}` lowers it on purpose. The raise and the lowering are its vulnerable windows: wall BEFORE
  the enemy arrives. Off when `rules.depths.wallEnabled` is false.
  Deployment rejects overlapping bodies. Let Wardens separate first; do not deploy while their own `deployBlocked`
  flag is present. Rounded observation coordinates cannot reliably reproduce the exact clearance check.
- **Where to wall.** A 1-wide choke on the enemy's walk to your root (or to your miners), a few cells short of where
  they are, so the wall is up when they reach it. A wall in a 2-wide tunnel is walked around. Friendly mining and
  reinforcement routes remain open through it; do not pack a wall merely to let your workers pass. Hostiles stay
  blocked even while the shield opens for a friendly unit.
- **Flare.** `flare {unit, x, y}` onto a known open cell within 5 tiles lights the tunnels within 5 tiles of it
  (never through rock) for 6 s. Free; 20 s cooldown per Warden (`abilityReady` on your own Warden, omitted when
  ready). Flare unknown corners before you advance, and toward where a foe vanished while you hold a wall.
  `flares` shows yours, your allies' and any whose cell you see: the enemy sees your flare where it can see it.
- **Fortify.** Wardens fortify at twice a digger's rate (free, walls-only): hardening held ground — the rock beside
  your gates and wall chokes — is their job, so diggers keep mining.

## The combo: Wardens + troopers

A walled Warden soaks the choke; troopers right behind it, in its cover, shoot over it with rifle range 4 + 1.5, and
enemy Wardens (range 2) cannot reach them. Alone, the Depths holds its tunnels; with troopers it pushes. The combo
is the reward for two seats cooperating, not a requirement.

- Troopers come from the Surface seat: it `transfer`s them down at an own Shaft (ask with a `troops` team signal at the wall's tile, [signals.md](../signals.md)). Keep a tunnel
  to its landing open (a `sealed` Shaft takes no transfers) and wall a choke on their way to the front.
- A lone walled Warden loses to two troopers, which out-range it: never leave a wall without shooters behind it
  against a ranged push.

## Sappers are for things that stay put

Charges take 10 s and become public with their detonation tick for their last 5 s (before that only enemy Depths
vision or tremors find them), so a moving army still steps away. Use them on structures, turret lines, sieging
tanks, gates and fortified walls — not armies.

- **Stacking.** Sappers arriving within `chargeStackReach` (1 cell) of your pending charge join it: one fuse, one
  defuse, +50% of `collapseDamage` per extra sapper up to `chargeStackMax` 3 (400 → 800). Own charges show `stack`.
- **Below the blast.** It strips every fortification level within `chargeStripReach` (1.5 tiles) and deals
  `chargeUnitDamage` 60 to hostile Depths units there; the tunnel itself stays open. Blow a fortified wall or a gate,
  then walk in.

## The bots and starters

The standard and veteran Depths bots (and the Depths starter) keep two or three Wardens after their diggers (first
under threat), wall the choke toward foes near home with the rest of the force behind it, flare while the wall holds,
harden the rock beside their doors, gate breaches with a bulkhead and tunnel to sealed Shafts. From the tier's
`wardenPushAt` (standard 4:00, veteran 3:00) two Wardens raid on their own (enemy diggers in our tunnels, else the
centre chamber) while the Surface is asked for `troopersDown` troopers with a `troops` signal; once they are down the
Wardens push with them, walling the choke when armed enemies meet them. Sapper waves stack under known targets.

## Worker routes

  The starter policy and default bots reserve two available hands for mining/cache service before optional rail,
  fault fortification, repairs and geothermal work; active construction and emergency defence still take precedence.
  A rich site is not automatically serviceable: crews need a known open connection to its approach and a live own
  root, Shaft or Headframe drop-off, outside currently observed weapon clearance. Displaced crews carry preserved
  ore home along known safe routes, then choose safe ore or dig frontiers; a distant enemy alone does not freeze
  them. Resuming mining at a live own drop-off unloads partial cargo first, without changing active extraction.
  Observed hostile shields also block route planning. Crews remember those obstacles until scouting confirms the
  route is clear; if no safe work remains, they shelter or stop rather than repeatedly returning to the same wall.
  Unknown frontiers still receive dig plans. This is not an escort or immunity: unseen enemies, moving raiders
  and combat on the return trip remain dangerous.
