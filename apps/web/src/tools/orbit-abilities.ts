import { sunOffset, type Entity, type View } from '@agent-command/game/contract';
import { seatSpendable } from '@agent-command/game/economy';
import { cooldownLeft, WAITING, type AbilityReadiness } from './readiness.ts';

export type OrbitAbility = 'sun_lance' | 'aegis';

/** Only own selected snapshots participate; enemy cooldowns are never inferred. */
export function orbitAbilityReady(e: Entity, ability: OrbitAbility, view: View): boolean {
  if (!view.match || e.side !== view.army || e.plane !== 'orbit' || e.hp <= 0
    || e.kind !== (ability === 'sun_lance' ? 'lancer' : 'bastion')
    || (e.abilityReady ?? 0) > view.tick || e.lance || e.aegis) return false;
  return ability === 'sun_lance'
    ? Math.abs(sunOffset(e.x, e.y, view.sun.angle, view.match.rules.map.size, view.match.sun.wedges)) < view.match.sun.half
    : view.research.completed.includes('aegis_projectors') && (e.shield ?? 0) > 0;
}

export function orbitAbilityState(units: readonly Entity[], ability: OrbitAbility, view: View | undefined): AbilityReadiness {
  const rules = view?.match?.rules.orbit;
  if (!view || !rules) return WAITING;
  const lance = ability === 'sun_lance';
  let count = 0, ready = 0, charging = 0, shielding = 0, dark = 0, next = Infinity;
  for (const e of units) {
    if (e.side !== view.army || e.plane !== 'orbit' || e.kind !== (lance ? 'lancer' : 'bastion')) continue;
    count++;
    if (orbitAbilityReady(e, ability, view)) ready++;
    // The ring runs to the first ship whose cooldown ends: that is when the ability is usable again.
    if ((e.abilityReady ?? 0) > view.tick) next = Math.min(next, e.abilityReady!);
    if (e.lance) charging++;
    if (e.aegis) shielding++;
    if (lance && Math.abs(sunOffset(e.x, e.y, view.sun.angle, view.match!.rules.map.size, view.match!.sun.wedges)) >= view.match!.sun.half) dark++;
  }
  const energy = Math.max(1, ready) * (lance ? rules.lanceEnergy : rules.aegisEnergy);
  const unlocked = lance || view.research.completed.includes('aegis_projectors');
  const cooldown = unlocked && !ready && Number.isFinite(next) ? cooldownLeft(next, view.tick, lance ? rules.lanceCooldown : rules.aegisCooldown) : undefined;
  // The Orbit seat pays: the free bank plus its own lane's earmark, never another lane's.
  const poor = seatSpendable(view.res, view.queue, 'orbit').energy < energy;
  const enabled = unlocked && ready > 0 && !poor;
  const status = !unlocked ? 'Research Aegis Projectors' : !count ? 'Select Orbit ships'
    : ready ? poor ? `Needs ${energy} energy · ${ready} ready` : `${ready}/${count} ready`
      : charging ? `Charging ×${charging}` : shielding ? `Projecting ×${shielding}`
        : cooldown ? `Cooldown ${cooldown.left}s` : dark ? 'Requires sunlight' : 'Requires shield';
  const description = lance
    ? `Base Lancer ability · sunlight required. Aim a direction: charges ${rules.lanceCharge}s, then a travelling lance at ${rules.lanceSpeed} tiles/s, range ${rules.lanceRange}. ${rules.lanceDamage} first hit, ${rules.lancePierceDamage} each piercing hit. Drains own shield on firing. ${rules.lanceEnergy} energy per ready Lancer · ${rules.lanceCooldown}s cooldown.`
    : `Aegis Projectors research. Roots each ready Bastion for ${rules.aegisDuration}s and covers allied Orbit ships within ${rules.aegisRadius} tiles. Shared pool: ${rules.aegisShieldMultiplier}× current shield; ends when depleted. ${rules.aegisEnergy} energy per ready Bastion · ${rules.aegisCooldown}s cooldown.`;
  return { enabled, status, cost: { energy }, description, ...(cooldown ? { cooldown } : {}) };
}
