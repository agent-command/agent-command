import { describe, expect, it } from 'vitest';
import { validate, type Schema } from 'playerthree/schema';
import {
  DEFAULT_RULES, RULE_FIELDS, RULE_GROUPS, RULE_PRESETS, checkRules, diffRules, hashRules,
  isCustomRules, resolveRules, resolveRulesPreset, ruleValue, rulesOptions, rulesSchema, toTicks,
  type RuleField,
} from '../src/rules/contract.ts';
import { createGame } from '../src/agent/adapter.ts';

function paths(schema: Schema, at: string[] = []): string[] {
  if (schema.t === 'opt') return paths(schema.item as Schema, at);
  if (schema.t === 'obj') return Object.entries(schema.fields as Record<string, Schema>)
    .flatMap(([key, child]) => paths(child, [...at, key]));
  return [at.join('.')];
}
function metadata(field: RuleField): void {
  expect(field.label.length).toBeGreaterThan(0);
  expect(field.description.length, field.path.join('.')).toBeGreaterThan(0);
  expect(RULE_GROUPS.some((group) => group.id === field.group)).toBe(true);
  expect(field.defaultValue).not.toBeUndefined();
  if (field.kind === 'int' || field.kind === 'num') {
    expect(field.defaultValue).toBeGreaterThanOrEqual(field.min!);
    expect(field.defaultValue).toBeLessThanOrEqual(field.max!);
  }
  if (field.kind === 'enum') expect(field.choices).toContain(field.defaultValue);
  for (const child of field.children ?? []) metadata(child);
}

describe('schema-generated lobby rules', () => {
  it('exposes every resolved rule once, including bounded list-item controls', () => {
    expect(RULE_FIELDS.map((field) => field.path.join('.')).sort()).toEqual(paths(rulesSchema as Schema).sort());
    expect(new Set(RULE_FIELDS.map((field) => field.path.join('.'))).size).toBe(RULE_FIELDS.length);
    for (const field of RULE_FIELDS) {
      metadata(field);
      expect(ruleValue(DEFAULT_RULES, field.path)).toEqual(field.defaultValue);
    }
    expect(RULE_FIELDS.find((field) => field.path.join('.') === 'map.contestedZones')?.children?.map((field) => field.path.at(-1)))
      .toEqual(['kind', 'sets', 'loads', 'minRadius', 'maxRadius', 'maxSkew']);
    expect(RULE_FIELDS.find((field) => field.path.join('.') === 'spire.timeCap')).toMatchObject({ group: 'match', unit: 's', min: 60, max: 7200 });
    expect(RULE_FIELDS.find((field) => field.path.join('.') === 'stats.tank.build')).toMatchObject({ group: 'surface', unit: 's' });
    expect(RULE_FIELDS.find((field) => field.path.join('.') === 'spire.hp.orbit')).toMatchObject({ group: 'orbit' });
  });

  it('provides seven fully resolved valid presets with only Standard guarded', () => {
    expect(RULE_PRESETS.map((preset) => preset.id)).toEqual(['standard', 'fast', 'rich-economy', 'no-asteroids', 'calm-skies', 'long-game', 'crowns']);
    for (const preset of RULE_PRESETS) {
      expect(validate(rulesSchema, preset.rules).ok, preset.id).toBe(true);
      expect(checkRules(rulesOptions(preset.rules)).ok, preset.id).toBe(true);
      expect(Object.isFrozen(preset.rules)).toBe(true);
      expect(resolveRulesPreset(preset.id)).toBe(preset.rules);
      expect(isCustomRules(preset.rules)).toBe(preset.id !== 'standard');
      expect(resolveRules(rulesOptions(preset.rules))).toEqual(preset.rules);
    }
    expect(resolveRulesPreset('standard')).toEqual(DEFAULT_RULES);
    expect(resolveRulesPreset('fast').economy.spireAlloyRate).toBeGreaterThan(DEFAULT_RULES.economy.spireAlloyRate);
    expect(resolveRulesPreset('fast').depths.digRockTime).toBeLessThan(DEFAULT_RULES.depths.digRockTime);
    expect(resolveRulesPreset('rich-economy').economy.startAlloy).toBeGreaterThan(DEFAULT_RULES.economy.startAlloy);
    expect(resolveRulesPreset('long-game').spire.timeCap).toBe(3600);
    expect(() => resolveRulesPreset('made-up')).toThrow('Unknown rules preset');
  });

  it('reports all and only actual differences, independently of object order', () => {
    expect(diffRules(DEFAULT_RULES)).toEqual([]);
    const custom = resolveRules({ economy: { startAlloy: 401 }, spire: { timeCap: 60 } });
    expect(diffRules(custom).map((diff) => [diff.field.path.join('.'), diff.standard, diff.value]))
      .toEqual([['economy.startAlloy', DEFAULT_RULES.economy.startAlloy, 401], ['spire.timeCap', DEFAULT_RULES.spire.timeCap, 60]]);
    const copy = structuredClone(DEFAULT_RULES);
    copy.map.contestedZones = copy.map.contestedZones.map((zone) => ({
      maxSkew: zone.maxSkew, maxRadius: zone.maxRadius, minRadius: zone.minRadius,
      loads: zone.loads, sets: zone.sets, kind: zone.kind,
    }));
    expect(diffRules(copy)).toEqual([]);
    copy.map.contestedZones[0]!.loads++;
    expect(diffRules(copy).map((diff) => diff.field.path.join('.'))).toEqual(['map.contestedZones']);
    expect(hashRules(copy)).not.toBe(hashRules(DEFAULT_RULES));
  });
});

describe('truthful disabling presets', () => {
  it('does not spawn asteroids at successive spawn opportunities', () => {
    const game = createGame({ seed: 7, options: rulesOptions(resolveRulesPreset('no-asteroids')) });
    for (let opportunity = 0; opportunity < 4; opportunity++) {
      game.sim.tick = game.sim.nextAsteroidSpawn() - 1;
      game.step();
      expect(game.sim.ents.some((entity) => entity.kind === 'asteroid')).toBe(false);
      expect(game.observe({ team: 'nw', role: 'orbit' }, 0).schedule.some((entry) => entry.kind === 'asteroid_spawn')).toBe(false);
    }
  });

  it('disables natural and seeded storms, not fog and wind', () => {
    const game = createGame({ seed: 7, options: rulesOptions(resolveRulesPreset('calm-skies')) });
    const seeder = game.sim.add('storm_seeder', 0, 'sky', 5, 5);
    for (const tick of [0, toTicks(30), toTicks(60), toTicks(120)]) {
      game.sim.tick = tick;
      game.step();
      expect(game.sim.weather.data.storms).toEqual([]);
      expect(game.sim.weather.data.forecast).toEqual([]);
      expect(game.sim.weather.data.seeded).toEqual([]);
      expect(seeder.state).toBe('idle');
    }
    expect(game.sim.weather.data.fog.length).toBeGreaterThan(0);
    expect(game.sim.weather.data.jets.length).toBeGreaterThan(0);
    const match = game.matchData({ team: 'nw', role: 'sky' });
    expect(match.rules).toEqual(resolveRulesPreset('calm-skies'));
    expect(match.rulesHash).toBe(hashRules(match.rules));
  });
});
