import { describe, expect, it } from 'vitest';
import { ALERT_KINDS, ARMIES, CELL, COLOURS, DEFAULT_RULES, EVENT_KINDS, UPGRADES, frameOf, type ArmyId, type GameEvent, type MatchData, type Rules } from '@agent-command/game/contract';
import { ALERT_LABEL, ALERT_TEXT, alertPlanes, depthsCellTip, eventText, motherLodeTip, stateLabel, upgradeTip } from '../src/text.ts';

const armies = (ids: readonly ArmyId[]): Pick<MatchData, 'armies'> => ({
  armies: ids.map((id, slot) => ({ id, slot, frame: frameOf(id), colour: COLOURS[slot]!, spireAt: { x: 0, y: 0 } })),
});
const DUEL = armies(['nw', 'se']), FFA = armies(ARMIES);
const ev = (kind: GameEvent['kind'], extra: Partial<GameEvent> = {}): GameEvent => ({ tick: 10, kind, plane: 'surface', x: 5, y: 5, ...extra });

describe('event presentation', () => {
  it('has a label for every event kind', () => {
    for (const kind of EVENT_KINDS) expect(eventText(ev(kind), 'nw', DUEL).text.length).toBeGreaterThan(0);
  });

  it('treats spire_damaged as an attack on our own Spire (side is the attacker)', () => {
    const e = ev('spire_damaged', { plane: 'sky', side: 'se', subject: 'spire' });
    expect(eventText(e, 'nw', DUEL).sev).toBe('warn');
    expect(alertPlanes(e, 'nw')).toEqual(['sky']);
  });

  it('warns both threatened planes about an enemy impact but not about our own', () => {
    expect(alertPlanes(ev('impact_incoming', { side: 'se' }), 'nw')).toEqual(['surface', 'sky']);
    expect(alertPlanes(ev('impact_incoming', { side: 'nw' }), 'nw')).toEqual([]);
    expect(eventText(ev('impact_incoming', { side: 'nw' }), 'nw', DUEL).sev).toBe('good');
  });

  it('warns about a witnessed volatile blast regardless of the tug owner', () => {
    for (const side of [undefined, 'nw', 'se'] as const) {
      const event = ev('volatile_detonation', { plane: 'orbit', side });
      expect(eventText(event, 'nw', DUEL)).toEqual({ text: 'Volatile asteroid detonated in Orbit', sev: 'warn' });
      expect(alertPlanes(event, 'nw')).toEqual(['orbit']);
    }
  });

  it('flags enemy collapses on the surface and in the depths', () => {
    expect(alertPlanes(ev('collapse', { side: 'se' }), 'nw')).toEqual(['surface', 'depths']);
    expect(eventText(ev('collapse', { side: 'nw' }), 'nw', DUEL).sev).toBe('good');
  });

  it('names who changed the team build queue and whose entry it was', () => {
    const added = ev('queue_added', { plane: 'sky', by: 'sky', byCtl: 'agent', owner: 'sky', ownerCtl: 'agent', entry: 'q_1', subject: 'interceptor', index: 3 });
    expect(eventText(added, 'nw', DUEL)).toEqual({ text: 'Sky agent queued Interceptor', sev: 'info' });
    const cancelled = ev('queue_cancelled', { by: 'surface', byCtl: 'human', owner: 'sky', ownerCtl: 'bot', entry: 'q_2', subject: 'interceptor', index: 0 });
    expect(eventText(cancelled, 'nw', DUEL).text).toBe('Surface human cancelled Sky bot’s Interceptor');
    const own = ev('queue_cancelled', { by: 'sky', byCtl: 'bot', owner: 'sky', ownerCtl: 'bot', entry: 'q_2', subject: 'interceptor', index: 0 });
    expect(eventText(own, 'nw', DUEL).text).toBe('Sky bot cancelled its Interceptor');
    const moved = (index: number, from: number) => eventText(ev('queue_moved', { by: 'sky', byCtl: 'agent', owner: 'surface', ownerCtl: 'human', entry: 'q_3', subject: 'tank', index, from }), 'nw', DUEL).text;
    expect(moved(0, 4)).toBe('Sky agent moved Surface human’s Tank to the top');
    expect(moved(1, 4)).toBe('Sky agent moved Surface human’s Tank up to #2');
    expect(moved(5, 2)).toBe('Sky agent moved Surface human’s Tank down to #6');
  });

  it('never lights alert pips for queue changes', () => {
    for (const kind of ['queue_added', 'queue_cancelled', 'queue_moved'] as const) expect(alertPlanes(ev(kind, { by: 'sky', byCtl: 'bot', side: 'nw' }), 'nw')).toEqual([]);
  });

  it('names the eliminated army and its killer by colour from every perspective', () => {
    const out = ev('army_eliminated', { side: 'ne', killer: 'se' });
    expect(eventText(out, 'ne', FFA)).toEqual({ text: 'Our Spire fell — eliminated', sev: 'bad' });
    expect(eventText(out, 'se', FFA)).toEqual({ text: 'Red eliminated by us', sev: 'good' });
    expect(eventText(out, 'nw', FFA)).toEqual({ text: 'Red eliminated by Green', sev: 'info' });
    expect(eventText(ev('army_eliminated', { side: 'sw' }), 'nw', FFA)).toEqual({ text: 'Violet eliminated', sev: 'info' });
  });

  it('tells the derelict core story: lifted (enemy warns Orbit), regrown, melted down, vented', () => {
    const lifted = (side: ArmyId) => ev('core_lifted', { plane: 'orbit', side, subject: 'core' });
    expect(eventText(lifted('se'), 'nw', DUEL)).toEqual({ text: 'Enemy towed the derelict core out', sev: 'warn' });
    expect(alertPlanes(lifted('se'), 'nw')).toEqual(['orbit']);
    expect(eventText(lifted('nw'), 'nw', DUEL).sev).toBe('info');
    expect(alertPlanes(lifted('nw'), 'nw')).toEqual([]);
    expect(eventText(ev('core_regrows', { plane: 'orbit', subject: 'core' }), 'nw', DUEL)).toEqual({ text: 'A new derelict core grew in the ruin', sev: 'info' });
    const meltdown = ev('core_meltdown', { plane: 'orbit', subject: 'core' });
    expect(eventText(meltdown, 'nw', DUEL).sev).toBe('warn');
    expect(alertPlanes(meltdown, 'nw')).toEqual(['orbit']);
    expect(alertPlanes(ev('core_vented', { plane: 'orbit', side: 'nw', subject: 'core' }), 'nw')).toEqual([]);
    expect(eventText(ev('impact_incoming', { side: 'se', subject: 'core' }), 'nw', DUEL).text).toBe('CORE STRIKE INCOMING');
  });
});

describe('alert text', () => {
  it('labels every alert kind, the core lift included', () => {
    for (const kind of ALERT_KINDS) expect(ALERT_LABEL[kind].length * ALERT_TEXT[kind].length).toBeGreaterThan(0);
    expect(ALERT_LABEL.core_lifted).toBe('Core out');
  });
});

describe('Depths research, Mother Lode and backfill text', () => {
  const depths = (patch: Partial<Rules['depths']>): Rules => ({ ...DEFAULT_RULES, depths: { ...DEFAULT_RULES.depths, ...patch } });

  it('tunes the Depths research tooltips to the match rules', () => {
    const r = DEFAULT_RULES, d = r.depths;
    const drill = upgradeTip('drill_bits', r);
    expect(drill.startsWith(UPGRADES.drill_bits.docs)).toBe(true);
    expect(drill).toContain(`Dig time ×${d.drillBitsDigMultiplier}: rock ${d.digRockTime}s → ${d.digRockTime * d.drillBitsDigMultiplier}s`);
    expect(drill.endsWith(`Research time: ${r.research.drillBitsTime}s`)).toBe(true);
    const shaped = upgradeTip('shaped_charges', depths({ shapedChargesUndermineTime: 5, shapedChargesChasmReach: 9 }));
    expect(shaped).toContain(`Fuse ${d.undermineTime}s → 5s · a fault splits ${d.chasmReach} → 9 cells each way`);
    expect(shaped.endsWith(`Research time: ${r.research.shapedChargesTime}s`)).toBe(true);
    expect(upgradeTip('night_cloak', r)).toBe(`${UPGRADES.night_cloak.docs}\nResearch time: ${r.research.nightCloakTime}s`);
  });

  it('describes the Mother Lode only when the match has one', () => {
    const d = DEFAULT_RULES.depths;
    const lode = (patch: Partial<Rules['map']['motherLode']>): Rules => ({ ...DEFAULT_RULES, map: { ...DEFAULT_RULES.map, motherLode: { ...DEFAULT_RULES.map.motherLode, ...patch } } });
    expect(motherLodeTip(DEFAULT_RULES)).toContain(`Mother Lode (map centre)`);
    expect(motherLodeTip(DEFAULT_RULES)).toContain(`${d.motherLodeAlloyPerLoad} alloy a load every ${d.digOreTime * d.motherLodeDig}s`);
    expect(motherLodeTip(lode({ placement: 'ring' }))).toContain(`Mother Lode (ring around the centre)`);
    expect(motherLodeTip(depths({ motherLodeCrewPerCell: 2, motherLodeLoads: 30, motherLodeRegen: 0.5 }))).toContain('2 diggers mine each cell at a time, others wait beside it · ');
    expect(motherLodeTip(depths({ motherLodeLoads: 30, motherLodeRegen: 0.5 }))).toContain('· 30 loads a cell, +0.5/s');
    expect(motherLodeTip(depths({ motherLodeLoads: 0 }))).toContain('· never runs out');
    expect(motherLodeTip(lode({ enabled: false }))).toBe('');
    // A two-slot map rounds one cell down to no orbit.
    expect(motherLodeTip(lode({ cells: 1 }))).toBe('');
  });

  it('names lava lakes, lava bridges and green ore at the pointer with the match numbers, nothing for other cells', () => {
    const r = depths({ lavaBridgeCost: 55, lavaBridgeTime: 7, lavaBridgeSpan: 4, richLoad: 30, chargeBridgeReach: 2 });
    expect(depthsCellTip(CELL.lake, r)).toEqual({ title: 'Lava lake', description: `Burns ${r.depths.magmaDps}/s, never cools · diggers bridge it: 55 alloy, 7s a cell, up to 4 cells out from dry ground` });
    expect(depthsCellTip(CELL.bridge, r)?.description).toContain('a charge within 2 tiles');
    expect(depthsCellTip(CELL.rich, r)).toMatchObject({ title: 'Green ore', description: expect.stringContaining(`30 alloy a load (ore: ${r.economy.oreLoad})`) });
    for (const code of [CELL.tunnel, CELL.ore, CELL.magma, CELL.lode]) expect(depthsCellTip(code, r)).toBeUndefined();
  });

  it('reads a waiting digger, a backfilling one and one bridging lava in player words, other states as they are', () => {
    const at = { x: 2.5, y: 2.5 };
    expect(stateLabel({ kind: 'digger', state: 'contested', ...at })).toBe('waiting at the Mother Lode');
    expect(stateLabel({ kind: 'digger', state: 'bridging', ...at })).toBe('backfilling');
    expect(stateLabel({ kind: 'island', state: 'contested', ...at })).toBe('contested');
    // A 5×5 Depths: a lake at (3, 2) east of the digger, a hole at (1, 2) west of it.
    const depths = new Array<number>(25).fill(CELL.tunnel);
    depths[2 * 5 + 3] = CELL.lake;
    const lakeOnly = { depths, holes: [], size: 5 }, both = { depths, holes: [{ x: 1, y: 2 }], size: 5 };
    // Own digger: its work cell decides.
    expect(stateLabel({ kind: 'digger', state: 'bridging', ...at, work: { x: 3.5, y: 2.5 } }, both)).toBe('bridging lava');
    expect(stateLabel({ kind: 'digger', state: 'bridging', ...at, work: { x: 1.5, y: 2.5 } }, both)).toBe('backfilling');
    // Hostile digger (no work point): a hole beside it first, else a lake beside it.
    expect(stateLabel({ kind: 'digger', state: 'bridging', ...at }, lakeOnly)).toBe('bridging lava');
    expect(stateLabel({ kind: 'digger', state: 'bridging', ...at }, both)).toBe('backfilling');
  });
});
