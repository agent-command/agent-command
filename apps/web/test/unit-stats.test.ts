// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { DAMAGE_VS, DEFAULT_RULES, STATS, TICK_RATE, UPGRADES, resolveRules, type Entity, type UpgradeEffect, type View } from '@agent-command/game/contract';
import { kindStats, ruleTables, statCells, statGrid, type StatCell } from '../src/unit-stats.ts';
import { arrayInfo, arrayTip, depositLegend, rockInfo, rockTip } from '../src/rock-panel.ts';

const tables = ruleTables(DEFAULT_RULES);
const values = (cells: readonly StatCell[]) => Object.fromEntries(cells.map((c) => [c.label, c.parts.map(([icon, text]) => (text ? `${icon} ${text}` : icon)).join(' ')]));

describe('unit stats', () => {
  it('reads one kind from the compiled match rules and the damage table', () => {
    const tank = kindStats(tables, 'tank', 'surface', []);
    expect(tank).toMatchObject({ dmg: STATS.tank.dmg, cooldown: STATS.tank.cooldown, range: STATS.tank.range, armor: 'armored', weapon: 'cannon', mount: { kind: 'turret' } });
    const cells = values(statCells([tank], { max: tank.hp, count: 1 }));
    expect(cells).toMatchObject({
      Health: `stat_hp ${STATS.tank.hp}`,
      'Damage per shot': `weapon_cannon ${STATS.tank.dmg}`,
      Cooldown: `stat_rate ${STATS.tank.cooldown / TICK_RATE}s`,
      'Damage per second': `stat_dps ${(STATS.tank.dmg * TICK_RATE) / STATS.tank.cooldown}`,
      Range: `stat_range ${STATS.tank.range}`,
      'Can hit': 'surface',
      'Strong vs': `armor_armored ×${DAMAGE_VS.cannon.armored} armor_structure ×${DAMAGE_VS.cannon.structure} armor_island ×${DAMAGE_VS.cannon.island}`,
      'Weapon mount': 'mount_turret',
      Armor: 'armor_armored',
    });
  });

  it('follows a match rules override, not the default table', () => {
    const rules = resolveRules({ stats: { tank: { dmg: 45, cooldown: 3 } } });
    const tank = kindStats(ruleTables(rules), 'tank', 'surface', []);
    expect(tank.dmg).toBe(45);
    expect(values(statCells([tank]))['Damage per second']).toBe('stat_dps 15');
    expect(ruleTables(rules)).toBe(ruleTables(rules));
  });

  it('shows a group as shared values or ranges, with no single weapon claim', () => {
    const cells = values(statCells([kindStats(tables, 'trooper', 'surface', []), kindStats(tables, 'tank', 'surface', [])], { hp: 250, max: 400, count: 2 }));
    expect(cells.Health).toBe('stat_hp 250/400');
    expect(cells['Damage per shot']).toBe(`stat_dmg ${STATS.trooper.dmg}–${STATS.tank.dmg}`);
    expect(cells['Strong vs']).toBeUndefined();
    expect(cells['Can hit']).toBe('depths surface');
  });

  it('unarmed kinds show only armor, speed and vision', () => {
    expect(Object.keys(values(statCells([kindStats(tables, 'tug', 'orbit', [])])))).toEqual(['Armor', 'Speed', 'Vision']);
  });

  it('shows the Warden shotgun from the Depths-only stats and the shotgun damage table', () => {
    const warden = kindStats(tables, 'warden', 'depths', []);
    expect(warden).toMatchObject({ dmg: STATS.warden.dmg, range: STATS.warden.range, armor: 'light', weapon: 'shotgun' });
    const cells = values(statCells([warden], { max: warden.hp, count: 1 }));
    expect(cells['Damage per shot']).toBe(`weapon_shotgun ${STATS.warden.dmg}`);
    expect(cells['Can hit']).toBe('depths');
    expect(cells['Strong vs']).toContain(`armor_light ×${DAMAGE_VS.shotgun.light}`);
  });

  it('shows the Breacher flamer from its stats and the flamer damage table', () => {
    const breacher = kindStats(tables, 'breacher', 'surface', []);
    expect(breacher).toMatchObject({ dmg: STATS.breacher.dmg, range: STATS.breacher.range, armor: 'light', weapon: 'flamer' });
    const cells = values(statCells([breacher], { max: breacher.hp, count: 1 }));
    expect(cells['Damage per shot']).toBe(`weapon_flamer ${STATS.breacher.dmg}`);
    expect(cells['Strong vs']).toContain(`armor_light ×${DAMAGE_VS.flamer.light}`);
  });

  it('reads shield capacity, regeneration and tick delay from compiled fleet rules', () => {
    const rules = resolveRules({ stats: { bastion: { shield: 175, shieldRegen: 12, shieldDelay: 3.5 } } });
    const bastion = kindStats(ruleTables(rules), 'bastion', 'orbit', []);
    expect(bastion).toMatchObject({ shield: 175, shieldRegen: 12, shieldDelay: 3.5 * TICK_RATE, weapon: 'point_defence' });
    const cells = values(statCells([bastion]));
    expect(cells.Shield).toBe('stat_shield 175');
    expect(cells['Shield recharge']).toBe('stat_shield_regen 12/s');
    expect(cells['Recharge delay']).toBe('stat_shield_delay 3.5s');
    expect(cells['Damage per shot']).toBe(`weapon_point_defence ${STATS.bastion.dmg}`);
    expect(values(statCells([kindStats(tables, 'skiff', 'orbit', [])])).Armor).toBe('armor_small');
  });

  it('shows snapshot shield totals, including depletion, without replacing them with registry capacity', () => {
    const stats = [kindStats(tables, 'skiff', 'orbit', []), kindStats(tables, 'bastion', 'orbit', [])];
    expect(values(statCells(stats, undefined, { shield: 0, max: 193, count: 3 })).Shield).toBe('stat_shield 0/193');
    expect(values(statCells(stats, undefined, { shield: 42.5, max: 193, count: 3 })).Shield).toBe('stat_shield 42.5/193');
    expect(statCells(stats, undefined, { shield: 0, max: 193, count: 3 }).find((c) => c.label === 'Shield')!.detail).toContain('3 shielded units');
    expect(values(statCells(stats))['Shield recharge']).toBe(`stat_shield_regen ${STATS.skiff.shieldRegen}–${STATS.bastion.shieldRegen}/s`);
  });

  it('shows interceptor shields only after ascent to Orbit and never invents shields for workers', () => {
    expect(kindStats(tables, 'interceptor', 'sky', []).shield).toBe(0);
    expect(values(statCells([kindStats(tables, 'interceptor', 'sky', [])])).Shield).toBeUndefined();
    expect(kindStats(tables, 'interceptor', 'orbit', []).shield).toBe(STATS.interceptor.shield);
    expect(values(statCells([kindStats(tables, 'interceptor', 'orbit', [])])).Shield).toBe(`stat_shield ${STATS.interceptor.shield}`);
    expect(values(statCells([kindStats(tables, 'solar', 'orbit', [])])).Shield).toBeUndefined();
  });

  it('applies passive research only when that research is passed in (fog: observed enemy upgrades only)', () => {
    const effects = UPGRADES.ascent_thrusters.effects as UpgradeEffect[];
    effects.push({ kind: 'modifier', target: { kinds: ['interceptor'] }, stat: 'dmg', add: 3, multiply: 2 });
    try {
      expect(kindStats(tables, 'interceptor', 'sky', []).dmg).toBe(STATS.interceptor.dmg);
      expect(kindStats(tables, 'interceptor', 'sky', ['ascent_thrusters']).dmg).toBe((STATS.interceptor.dmg + 3) * 2);
      expect(kindStats(tables, 'bomber', 'sky', ['ascent_thrusters']).dmg).toBe(STATS.bomber.dmg);
    } finally {
      effects.pop();
    }
  });

  it('renders icon cells with a hint each, or captions inside a tooltip', () => {
    const cells = statCells([kindStats(tables, 'flak', 'surface', [])]);
    const grid = statGrid(cells);
    expect(grid.querySelectorAll('.stat')).toHaveLength(cells.length);
    expect(grid.querySelector('.stat')!.getAttribute('data-tip')).toMatch(/^Damage per shot · Flak/);
    expect(grid.querySelector('svg.icon-weapon_flak')).not.toBeNull();
    const captioned = statGrid(cells, true);
    expect(captioned.querySelector('[data-tip]')).toBeNull();
    expect(captioned.querySelector('.stat-caption')!.textContent).toMatch(/^Damage per shot · Flak/);
  });
});

describe('rock inspection affordances', () => {
  const rock: Entity = { id: 'e_1', kind: 'asteroid', side: 'neutral', plane: 'orbit', x: 20, y: 20, hp: 800, maxHp: 800, state: 'drifting', rockSize: 'large' };

  it('keeps unknown resources unidentified even at a revealing-looking HP value', () => {
    const info = rockInfo(rock, DEFAULT_RULES, 0);
    expect(info.textContent).toBe('Large?');
    expect(info.querySelector('.icon-volatile')).toBeNull();
    expect(info.querySelectorAll('[data-tip][tabindex="0"]')).toHaveLength(2);
    expect(rockTip(rock, DEFAULT_RULES, 0).description).toContain('require local vision');
  });

  it('shows remaining mine/drop resources and independent volatility', () => {
    const rules = resolveRules({ orbit: { pebbleDockValue: 45, pebbleImpactDamage: 140, volatileDamageMultiplier: 2, volatileRadiusMultiplier: 2 } });
    const volatile = rockTip({ ...rock, rockSize: 'pebble', resourceType: 'metal', resourceRemaining: 45, volatile: true }, rules, 0);
    expect(volatile.title).toBe('Pebble · Metal · Volatile');
    expect(volatile.description).toContain('45.0 alloy');
    expect(volatile.description).toContain('280.0 damage · radius 3 · 4s warning');
    expect(volatile.description).toContain('No ore cache');
    const ore = rockTip({ ...rock, rockSize: 'pebble', resourceType: 'metal', resourceRemaining: 45, volatile: false }, rules, 0);
    expect(ore.description).toContain('90 alloy before the Depths share');
    const ice = rockTip({ ...rock, resourceType: 'ice', resourceRemaining: 50 }, rules, 0);
    expect(ice.description).toContain('10.0 alloy · 40.0 energy');
    expect(ice.description).toContain('bypasses the solar delivery cap');
  });

  it('counts down only an explicitly visible Orbit fuse using match tuning', () => {
    const rules = resolveRules({ orbit: { volatileFuse: 30, volatileTowHpFraction: 0.4, volatileOrbitDamage: 240, volatileOrbitRadius: 4 } });
    const armed: Entity = { ...rock, resourceType: 'metal', resourceRemaining: 400, volatile: true, fuseUntil: 600 };
    const info = rockTip(armed, rules, 551);
    expect(info.description).toContain('Instability fuse: 3s remaining');
    expect(info.description).toContain('30s fuse · hull ×0.4');
    expect(info.description).toContain('240 damage · radius 4, both teams and tug included');
    expect(info.description).toContain('400.0 alloy');
    expect(rockInfo(armed, rules, 580).textContent).toBe('LargeMetal400.0 remainingVolatile1s');
    expect(rockInfo(armed, rules, 601).querySelector('[aria-label="Instability fuse: 0 seconds remaining"]')).not.toBeNull();
    expect(rockInfo({ ...armed, fuseUntil: undefined }, rules, 580).textContent).toBe('LargeMetal400.0 remainingVolatile');
    for (const hidden of [{ ...armed, volatile: undefined }, { ...armed, plane: 'sky' as const }]) {
      expect(rockTip(hidden, rules, 580).description).not.toContain('Instability fuse:');
      expect(rockInfo(hidden, rules, 580).querySelector('[aria-label^="Instability fuse:"]')).toBeNull();
    }
  });

  it('does not advertise a Surface cache for Depths-only knowledge or expired scorch', () => {
    const view = { tick: 100, oreCaches: [{ id: 1, x: 20, y: 20, alloy: 0, radius: 2, below: { x: 20, y: 20, alloy: 40 } }], scorches: [] } as unknown as View;
    expect(depositLegend(view, DEFAULT_RULES, 'surface')).toBeNull();
    expect(depositLegend(view, DEFAULT_RULES, 'depths')?.querySelector('[aria-label="Ore caches"]')).not.toBeNull();
    expect(depositLegend(view, DEFAULT_RULES, 'orbit')).toBeNull();
    view.scorches = [{ x: 24, y: 24, radius: 4.5, until: 120 }];
    expect(depositLegend(view, DEFAULT_RULES, 'surface')?.querySelector('[aria-label="Scorched ground"]')).not.toBeNull();
    view.tick = 120;
    expect(depositLegend(view, DEFAULT_RULES, 'surface')).toBeNull();
  });
});

describe('solar array inspection', () => {
  const array: Entity = { id: 'e_2', kind: 'solar', side: 'nw', plane: 'orbit', x: 20, y: 20, hp: 100, maxHp: 100, state: 'unfurled', ramp: 0.5 };

  it('reads output (own arrays only) and ramp in the selection chips and their tooltip', () => {
    const start = DEFAULT_RULES.orbit.solarRampStart;
    const own = arrayInfo({ ...array, output: 3.25 }, DEFAULT_RULES);
    expect(own.querySelector('[aria-label="Output: 3.25 energy per second"]')?.textContent).toBe('3.3/s');
    expect(own.querySelector('[aria-label="Exposure ramp: 50%"]')?.textContent).toBe('50%');
    const tip = arrayTip({ ...array, output: 3.25 }, DEFAULT_RULES);
    expect(tip.title).toBe(`Solar array · anchored · 3.25 energy/s · ramp ×${(start + (1 - start) * 0.5).toFixed(2)}`);
    expect(tip.description).toContain('frame lights to the ramp');
    const foreign = arrayInfo({ ...array, side: 'se' }, DEFAULT_RULES);
    expect(foreign.querySelector('[aria-label^="Output"]')).toBeNull();
    expect(foreign.querySelector('[aria-label="Exposure ramp: 50%"]')).not.toBeNull();
    expect(arrayTip({ ...array, state: 'furling', ramp: undefined }, DEFAULT_RULES).title).toBe('Solar array · packing');
  });
});
