/**
 * Shared helpers and generated tables for the briefing text: everything interpolates the default rules, so the
 * docs never drift from `ECON` / `DEFAULT_RULES` / `STATS`.
 */
import { ARMORS, DAMAGE_VS, DEFAULT_RULES, STATS, TICK_RATE, WEAPONS, spirePositions } from '../../rules/contract.ts';

/** On-demand briefing topic: one-line `summary` (≤ 160 chars) for the index, `text` (≤ 8,000 chars) on demand. */
export interface Topic {
  summary: string;
  text: string;
}

/** Ticks as game seconds. */
export const s = (ticks: number): string => `${ticks / TICK_RATE} s`;
export const pct = (v: number): string => `${Math.round(v * 100)}%`;

export const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);
export const ORBIT = DEFAULT_RULES.orbit;

/** Weapon-vs-armour multipliers, one line per weapon, one column per armour class. */
export const DAMAGE_TABLE = WEAPONS.map((w) => `${w}: ${ARMORS.map((a) => `${a} ${pct(DAMAGE_VS[w][a])}`).join(', ')}`).join('\n');

/** Every unit and structure kind with its default stats (rules.stats / rules.spire override them per match). */
export const UNIT_TABLE = (Object.keys(STATS) as (keyof typeof STATS)[])
  .map((k) => {
    const u = STATS[k];
    const m = u.mount;
    const mount = !m ? '' : m.kind === 'turret' ? `, turret mount ${+m.traverse.toFixed(2)} rad/s` : m.kind === 'forward' ? `, forward mount ${m.arc}° arc` : ', fixed mount';
    const shield = u.shield ? `, shield ${u.shield} (+${u.shieldRegen}/s after ${s(u.shieldDelay ?? 0)})` : '';
    const orbit = u.orbitAcceleration ? `, Orbit accel ${u.orbitAcceleration} tiles/s² turn ${u.orbitTurnRate} rad/s` : '';
    const weapon = u.weapon
      ? `${u.weapon} ${u.dmg} dmg / ${s(u.cooldown)}, range ${u.range}, hits ${u.targets.join('+')}${u.projectileSpeed ? `, projectile ${u.projectileSpeed} tiles/s` : ', instant'}${u.splash ? `, splash ${u.splash}` : ''}${mount}`
      : 'unarmed';
    const body = 'footprint' in u && u.footprint ? `footprint ${u.footprint.w}×${u.footprint.h}` : `speed ${u.speed}`;
    const capabilities = Object.entries(u.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(', ') || 'none';
    return `${k} (${u.plane}): ${u.hp} HP${shield}, ${u.armor}, radius ${u.radius}, ${body}${orbit}, ${weapon}, vision ${u.vision}, cost ${u.alloy}+${u.energy}, ${s(u.build)}; capabilities: ${capabilities}; abilities: ${u.abilities.join(', ') || 'none'}`;
  })
  .join('\n');

export const ROCK_TABLE = `size | HP | tow multiplier | dock alloy | impact damage | radius | warning
pebble | ${ORBIT.pebbleHp} | ${ORBIT.pebbleTowSpeed} | ${ORBIT.pebbleDockValue} | ${ORBIT.pebbleImpactDamage} | ${ORBIT.pebbleImpactRadius} | ${ORBIT.pebbleImpactDelay} s
medium | ${ORBIT.asteroidHp} | ${ORBIT.towSpeed} | ${ORBIT.dockValue} | ${ORBIT.impactDamage} | ${ORBIT.impactRadius} | ${ORBIT.impactDelay} s
large | ${ORBIT.largeHp} | ${ORBIT.largeTowSpeed} | ${ORBIT.largeDockValue} | ${ORBIT.largeImpactDamage} | ${ORBIT.largeImpactRadius} | ${ORBIT.largeImpactDelay} s`;
