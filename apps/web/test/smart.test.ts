import { describe, expect, it } from 'vitest';
import { createGame } from '@agent-command/game';
import { CELL, DEFAULT_RULES, PLANES, slotArmyIds, type ArmyId, type Entity, type Kind, type Plane, type View } from '@agent-command/game/contract';
import { resolveSmartAction, SMART_RULES, type SmartHover } from '../src/tools/smart.ts';
import type { ToolSelection } from '../src/tools/types.ts';
import { CURSOR } from '../src/cursors.ts';

const SIZE = 48;
const other = (team: ArmyId): ArmyId => team === 'nw' ? 'se' : 'nw';

/**
 * One team's fogged View with nothing in it but what a case adds: entities seen now, holes, known Depths cells and dig
 * tags. The se army's cases mirror every coordinate through the map centre (the client resolves in absolute map coordinates).
 */
function world(team: ArmyId) {
  const view = createGame({ seed: 1, options: { map: { params: { size: SIZE } } } }).view(team);
  Object.assign(view, {
    entities: [], memory: [], holes: [],
    depths: Array<number>(SIZE * SIZE).fill(CELL.tunnel),
    designations: { normal: Array<number>(Math.ceil(SIZE * SIZE / 30)).fill(0), urgent: Array<number>(Math.ceil(SIZE * SIZE / 30)).fill(0) },
  });
  const m = (v: number) => team === 'nw' ? v : SIZE - v;
  let n = 0;
  const ent = (kind: Kind, plane: Plane, x: number, y: number, side: Entity['side'] = team, extra: Partial<Entity> = {}, visible = true): Entity => {
    const e = { id: `e_${++n}`, kind, side, plane, x: m(x), y: m(y), hp: 100, maxHp: 100, state: 'idle', ...extra } as Entity;
    if (visible) view.entities.push(e);
    return e;
  };
  const cell = (x: number, y: number) => Math.floor(m(y)) * SIZE + Math.floor(m(x));
  const tag = (x: number, y: number) => { const c = cell(x, y); view.designations.normal[Math.floor(c / 30)]! |= 1 << (c % 30); };
  const ground = (plane: Plane, x: number, y: number, entity?: Entity): SmartHover => ({ plane, tile: { x: m(x), y: m(y) }, entity: entity?.id });
  const on = (plane: Plane, e: Entity): SmartHover => ({ plane, tile: { x: e.x, y: e.y }, entity: e.id });
  return { view, m, ent, cell, tag, ground, on, spire: view.match!.armies.find((a) => a.id === team)!.spireAt };
}
type World = ReturnType<typeof world>;
const sel = (...units: Entity[]): ToolSelection => ({ units, spire: false });
const NONE = { shiftKey: false, altKey: false };
/** Known lava-lake cells in the square of half-width `r` cells round (x, y), in the team's coordinates. */
const lake = (w: World, x: number, y: number, r: number): void => {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) w.view.depths[w.cell(x + dx, y + dy)] = CELL.lake;
};

interface Case {
  name: string;
  /** Builds the selection and hover on the team's view. */
  setup(w: World, team: ArmyId): { selection: ToolSelection; hover: SmartHover; modifiers?: { shiftKey: boolean; altKey: boolean } };
  /** Expected action id and label (undefined: nothing resolves) and its intents (absolute coordinates via w). */
  id?: string;
  label?: string;
  intents?(w: World, ids: Record<string, string>): unknown[];
}

const cases: Case[] = [
  ...(['metal', 'ice'] as const).map((resourceType): Case => ({
    name: `visible ${resourceType} asteroid is explicitly mined with queued right-click`,
    setup: (w) => ({ selection: sel(w.ent('tug', 'orbit', 20, 20)), hover: w.on('orbit', w.ent('asteroid', 'orbit', 30, 30, 'neutral', { state: 'drifting', resourceType, resourceRemaining: 50, volatile: true })), modifiers: { shiftKey: true, altKey: false } }),
    id: 'mine_asteroid', label: 'Mine asteroid',
    intents: (_w, ids) => [{ kind: 'mine_asteroid', units: [ids.tug], asteroid: ids.asteroid, queue: true }],
  })),
  {
    name: 'slag remains a whole-rock tow target',
    setup: (w) => ({ selection: sel(w.ent('tug', 'orbit', 20, 20)), hover: w.on('orbit', w.ent('asteroid', 'orbit', 30, 30, 'neutral', { state: 'drifting', resourceType: 'slag', resourceRemaining: 0 })) }),
    id: 'grapple',
  },
  {
    name: 'mining cargo can dock without a whole-rock tow',
    setup: (w) => ({ selection: sel(w.ent('tug', 'orbit', 20, 20, undefined, { cargoAlloy: 10, cargoEnergy: 40 })), hover: w.on('orbit', w.ent('spire', 'orbit', 6, 6)) }),
    id: 'dock',
  },
  // Transfer: troopers through an own built, unsealed Shaft they hover (the only portals), on both planes.
  {
    name: 'surface troopers on an own built Shaft descend through it',
    setup: (w) => { const shaft = w.ent('shaft', 'surface', 14.5, 14.5); return { selection: sel(w.ent('trooper', 'surface', 20, 20)), hover: w.on('surface', shaft) }; },
    id: 'transfer', label: 'Descend', intents: (w, ids) => [{ kind: 'transfer', units: [ids.trooper], to: 'depths', x: w.m(14.5), y: w.m(14.5) }],
  },
  {
    name: 'surface troopers on an unfinished Shaft do not descend',
    setup: (w) => { const shaft = w.ent('shaft', 'surface', 14.5, 14.5, undefined, { progress: 0.5 }); return { selection: sel(w.ent('trooper', 'surface', 20, 20)), hover: w.on('surface', shaft) }; },
    id: 'move',
  },
  {
    name: 'surface troopers on a sealed Shaft do not descend',
    setup: (w) => { const shaft = w.ent('shaft', 'surface', 14.5, 14.5, undefined, { sealed: true }); return { selection: sel(w.ent('trooper', 'surface', 20, 20)), hover: w.on('surface', shaft) }; },
    id: 'move',
  },
  {
    name: 'surface troopers on a public hole do not descend: holes are no portals',
    setup: (w) => { w.view.holes.push({ x: Math.floor(w.m(30.5)), y: Math.floor(w.m(31.5)), kind: 'crater' }); return { selection: sel(w.ent('trooper', 'surface', 20, 20)), hover: w.ground('surface', 30.5, 31.5) }; },
    id: 'move',
  },
  {
    name: 'Depths troopers under the Spire root do not climb: the root is no portal',
    setup: (w) => ({ selection: sel(w.ent('trooper', 'depths', 20, 20)), hover: { plane: 'depths', tile: { x: w.spire.x, y: w.spire.y } } }),
    id: 'move',
  },
  {
    name: 'Depths troopers climb through an own Shaft above the cell',
    setup: (w) => { w.ent('shaft', 'surface', 14.5, 14.5); return { selection: sel(w.ent('trooper', 'depths', 20, 20)), hover: w.ground('depths', 14.6, 14.4) }; },
    id: 'transfer', label: 'Climb', intents: (w, ids) => [{ kind: 'transfer', units: [ids.trooper], to: 'surface', x: w.m(14.5), y: w.m(14.5) }],
  },
  {
    name: 'troopers descend and the tanks with them move to the Shaft',
    setup: (w) => { const shaft = w.ent('shaft', 'surface', 14.5, 14.5); return { selection: sel(w.ent('trooper', 'surface', 20, 20), w.ent('tank', 'surface', 21, 20)), hover: w.on('surface', shaft) }; },
    id: 'transfer', label: 'Descend', intents: (w, ids) => [
      { kind: 'transfer', units: [ids.trooper], to: 'depths', x: w.m(14.5), y: w.m(14.5) },
      { kind: 'move', units: [ids.tank], x: w.m(14.5), y: w.m(14.5), mode: 'move' },
    ],
  },
  {
    name: 'tanks alone on an own Shaft just move (no transfer capability)',
    setup: (w) => { const shaft = w.ent('shaft', 'surface', 14.5, 14.5); return { selection: sel(w.ent('tank', 'surface', 20, 20)), hover: w.on('surface', shaft) }; },
    id: 'move', label: 'Move', intents: (w, ids) => [{ kind: 'move', units: [ids.tank], x: w.m(14.5), y: w.m(14.5), mode: 'move' }],
  },
  {
    name: 'troopers on an enemy Shaft attack it instead of descending',
    setup: (w, team) => { const shaft = w.ent('shaft', 'surface', 14.5, 14.5, other(team)); return { selection: sel(w.ent('trooper', 'surface', 20, 20)), hover: w.on('surface', shaft) }; },
    id: 'attack', label: 'Attack', intents: (_, ids) => [{ kind: 'attack', units: [ids.trooper], target: ids.shaft }],
  },
  // Diggers on Depths cells, by what the team knows of them.
  {
    name: 'diggers on known ore mine near it',
    setup: (w) => { w.view.depths[w.cell(30.5, 31.5)] = CELL.ore; return { selection: sel(w.ent('digger', 'depths', 20, 20)), hover: w.ground('depths', 30.5, 31.5) }; },
    id: 'mine', label: 'Mine', intents: (w, ids) => [{ kind: 'mine', units: [ids.digger], x: w.m(30.5), y: w.m(31.5) }],
  },
  {
    name: 'diggers on a Mother Lode cell mine it (it is never dug, even when tagged)',
    setup: (w) => { w.view.depths[w.cell(30.5, 31.5)] = CELL.lode; w.tag(30.5, 31.5); return { selection: sel(w.ent('digger', 'depths', 20, 20)), hover: w.ground('depths', 30.5, 31.5) }; },
    id: 'mine', label: 'Mine the Mother Lode', intents: (w, ids) => [{ kind: 'mine', units: [ids.digger], x: w.m(30.5), y: w.m(31.5) }],
  },
  {
    name: 'diggers on green rich ore mine it',
    setup: (w) => { w.view.depths[w.cell(30.5, 31.5)] = CELL.rich; return { selection: sel(w.ent('digger', 'depths', 20, 20)), hover: w.ground('depths', 30.5, 31.5) }; },
    id: 'mine', label: 'Mine green ore', intents: (w, ids) => [{ kind: 'mine', units: [ids.digger], x: w.m(30.5), y: w.m(31.5) }],
  },
  {
    name: 'diggers on a known lava-lake cell beside dry ground bridge it; troopers stay off the lava',
    setup: (w) => { w.view.depths[w.cell(30.5, 31.5)] = CELL.lake; return { selection: sel(w.ent('digger', 'depths', 20, 20), w.ent('trooper', 'depths', 20, 21)), hover: w.ground('depths', 30.5, 31.5) }; },
    id: 'bridge', label: `Bridge lava · ${DEFAULT_RULES.depths.lavaBridgeCost} alloy`,
    intents: (w, ids) => [{ kind: 'bridge', units: [ids.digger], x: Math.floor(w.m(30.5)), y: Math.floor(w.m(31.5)) }],
  },
  ...([[DEFAULT_RULES.depths.lavaBridgeSpan - 1, 'bridge'], [DEFAULT_RULES.depths.lavaBridgeSpan, 'lava']] as const).map(([bridges, id]): Case => ({
    name: `a lava-lake cell past ${bridges} bridge cells from dry ground resolves to ${id} (rules.depths.lavaBridgeSpan)`,
    setup: (w) => {
      // tunnel at x 30, then a straight span of bridge cells, then the hovered lake cell; lake all round it
      const at = 30.5 + bridges + 1;
      lake(w, at, 31.5, DEFAULT_RULES.depths.lavaBridgeSpan + 2);
      w.view.depths[w.cell(30.5, 31.5)] = CELL.tunnel;
      for (let k = 1; k <= bridges; k++) w.view.depths[w.cell(30.5 + k, 31.5)] = CELL.bridge;
      return { selection: sel(w.ent('digger', 'depths', 20, 20)), hover: w.ground('depths', at, 31.5) };
    },
    id,
    ...(id === 'lava' ? { label: `Too far out to bridge · lava bridges reach ${DEFAULT_RULES.depths.lavaBridgeSpan} cells from dry ground or a bridge`, intents: () => [] } : {}),
  })),
  {
    name: 'troopers on a lake cell refuse rather than walk into the lava',
    setup: (w) => { lake(w, 30.5, 31.5, 1); return { selection: sel(w.ent('trooper', 'depths', 20, 20)), hover: w.ground('depths', 30.5, 31.5) }; },
    id: 'lava', intents: () => [],
  },
  {
    name: 'diggers on unexplored rock dig toward it (unknown ore is never mined)',
    setup: (w) => { w.view.depths[w.cell(30.5, 31.5)] = CELL.unknown; return { selection: sel(w.ent('digger', 'depths', 20, 20)), hover: w.ground('depths', 30.5, 31.5) }; },
    id: 'dig', label: 'Dig', intents: (w, ids) => [{ kind: 'dig', units: [ids.digger], x: Math.floor(w.m(30.5)), y: Math.floor(w.m(31.5)) }],
  },
  {
    name: 'diggers on a tagged rock cell work the tag; troopers follow',
    setup: (w) => { w.view.depths[w.cell(30.5, 31.5)] = CELL.rock; w.tag(30.5, 31.5); return { selection: sel(w.ent('digger', 'depths', 20, 20), w.ent('trooper', 'depths', 20, 21)), hover: w.ground('depths', 30.5, 31.5) }; },
    id: 'work', label: 'Dig tag', intents: (w, ids) => [
      { kind: 'dig', units: [ids.digger], x: Math.floor(w.m(30.5)), y: Math.floor(w.m(31.5)) },
      { kind: 'move', units: [ids.trooper], x: w.m(30.5), y: w.m(31.5), mode: 'move' },
    ],
  },
  {
    name: 'troopers alone on rock move (no dig capability)',
    setup: (w) => { w.view.depths[w.cell(30.5, 31.5)] = CELL.rock; return { selection: sel(w.ent('trooper', 'depths', 20, 20)), hover: w.ground('depths', 30.5, 31.5) }; },
    id: 'move',
  },
  {
    name: 'diggers on a damaged own bulkhead repair it',
    setup: (w) => { const b = w.ent('bulkhead', 'depths', 30.5, 31.5, undefined, { hp: 120, maxHp: 400 }); return { selection: sel(w.ent('digger', 'depths', 20, 20)), hover: w.on('depths', b) }; },
    id: 'repair', label: 'Repair', intents: (w, ids) => [{ kind: 'fortify', units: [ids.digger], x: Math.floor(w.m(30.5)), y: Math.floor(w.m(31.5)) }],
  },
  {
    name: 'diggers on an intact own bulkhead just move',
    setup: (w) => { const b = w.ent('bulkhead', 'depths', 30.5, 31.5, undefined, { hp: 400, maxHp: 400 }); return { selection: sel(w.ent('digger', 'depths', 20, 20)), hover: w.on('depths', b) }; },
    id: 'move',
  },
  // Orbit tugs and ships.
  {
    name: 'free tugs grapple a drifting asteroid; other ships stay out of it',
    setup: (w) => { const rock = w.ent('asteroid', 'orbit', 30, 30, 'neutral', { state: 'drifting' }); return { selection: sel(w.ent('tug', 'orbit', 20, 20), w.ent('lancer', 'orbit', 21, 20)), hover: w.on('orbit', rock) }; },
    id: 'grapple', label: 'Grapple', intents: (_, ids) => [{ kind: 'grapple', units: [ids.tug], asteroid: ids.asteroid }],
  },
  {
    name: 'a towing tug cannot grapple another rock',
    setup: (w) => { const rock = w.ent('asteroid', 'orbit', 30, 30, 'neutral', { state: 'drifting' }); return { selection: sel(w.ent('tug', 'orbit', 20, 20, undefined, { state: 'towing', link: 'e_99' })), hover: w.on('orbit', rock) }; },
    id: 'move',
  },
  {
    name: 'free tugs grapple the resting derelict core',
    setup: (w) => { const core = w.ent('core', 'orbit', 24, 24, 'neutral'); return { selection: sel(w.ent('tug', 'orbit', 20, 20), w.ent('lancer', 'orbit', 21, 20)), hover: w.on('orbit', core) }; },
    id: 'grapple', label: 'Grapple core', intents: (_, ids) => [{ kind: 'grapple', units: [ids.tug], asteroid: ids.core }],
  },
  {
    name: 'a core under tow is not grappled again',
    setup: (w) => { const core = w.ent('core', 'orbit', 30, 30, 'neutral', { state: 'towed', link: 'e_99' }); return { selection: sel(w.ent('tug', 'orbit', 20, 20)), hover: w.on('orbit', core) }; },
    id: 'move',
  },
  {
    name: 'warships attack a core an enemy tug is towing',
    setup: (w, team) => {
      const tug = w.ent('tug', 'orbit', 31, 30, other(team), { state: 'towing' });
      const core = w.ent('core', 'orbit', 31, 30, 'neutral', { state: 'towed', link: tug.id });
      return { selection: sel(w.ent('lancer', 'orbit', 20, 20)), hover: w.on('orbit', core) };
    },
    id: 'attack', label: 'Attack', intents: (_, ids) => [{ kind: 'attack', units: [ids.lancer], target: ids.core }],
  },
  {
    name: 'Orbit ships right-clicked into the open chamber enter the derelict',
    setup: (w) => ({ selection: sel(w.ent('lancer', 'orbit', 20, 20)), hover: w.ground('orbit', 24.4, 24.6) }),
    id: 'enter', label: 'Enter derelict',
  },
  {
    name: 'entering the sealed chamber says the ships wait for the gates',
    setup: (w) => {
      const g = w.view.match!.derelict!;
      w.view.tick = g.open + g.turn + 5;
      return { selection: sel(w.ent('skiff', 'orbit', 20, 20)), hover: w.ground('orbit', 24.4, 24.6) };
    },
    id: 'enter', label: 'Enter derelict · waits for the gates',
  },
  {
    name: 'a towing tug on the own Orbit segment docks',
    setup: (w) => { const seg = w.ent('spire', 'orbit', 0, 0, undefined, { x: w.spire.x, y: w.spire.y } as Partial<Entity>); return { selection: sel(w.ent('tug', 'orbit', 20, 20, undefined, { state: 'towing', link: 'e_99' })), hover: w.on('orbit', seg) }; },
    id: 'dock', label: 'Dock', intents: (w, ids) => [{ kind: 'move', units: [ids.tug], x: w.spire.x, y: w.spire.y, mode: 'move' }],
  },
  {
    name: 'a damaged shielded warship on the own segment docks for repairs',
    setup: (w) => { const seg = w.ent('spire', 'orbit', 0, 0, undefined, { x: w.spire.x, y: w.spire.y } as Partial<Entity>); return { selection: sel(w.ent('lancer', 'orbit', 20, 20, undefined, { hp: 100, maxHp: 240, shield: 80, maxShield: 80 })), hover: w.on('orbit', seg) }; },
    id: 'dock', label: 'Dock',
  },
  {
    name: 'an idle tug on the own segment just moves',
    setup: (w) => { const seg = w.ent('spire', 'orbit', 0, 0, undefined, { x: w.spire.x, y: w.spire.y } as Partial<Entity>); return { selection: sel(w.ent('tug', 'orbit', 20, 20)), hover: w.on('orbit', seg) }; },
    id: 'move',
  },
  // Sky islands through the server's island attack (capture or the slot's structure).
  {
    name: 'interceptors on a neutral island capture it',
    setup: (w) => { const isl = w.ent('island', 'sky', 30, 30, 'neutral'); return { selection: sel(w.ent('interceptor', 'sky', 20, 20)), hover: w.on('sky', isl) }; },
    id: 'capture', label: 'Capture', intents: (_, ids) => [{ kind: 'attack', units: [ids.interceptor], target: ids.island }],
  },
  {
    name: 'interceptors on an enemy island with nothing seen on it capture it',
    setup: (w, team) => { const isl = w.ent('island', 'sky', 30, 30, other(team), { link: 'e_99' }); return { selection: sel(w.ent('interceptor', 'sky', 20, 20)), hover: w.on('sky', isl) }; },
    id: 'capture', label: 'Capture',
  },
  {
    name: 'interceptors on an own island just move',
    setup: (w) => { const isl = w.ent('island', 'sky', 30, 30); return { selection: sel(w.ent('interceptor', 'sky', 20, 20)), hover: w.on('sky', isl) }; },
    id: 'move',
  },
  {
    name: 'a visible enemy slot structure turns the island into an attack; bombers join and the server splits them',
    setup: (w, team) => {
      const isl = w.ent('island', 'sky', 30, 30, other(team));
      const aerie = w.ent('aerie', 'sky', 30, 30, other(team), { link: isl.id });
      isl.link = aerie.id;
      return { selection: sel(w.ent('interceptor', 'sky', 20, 20), w.ent('bomber', 'sky', 21, 20)), hover: w.on('sky', isl) };
    },
    id: 'attack', label: 'Attack', intents: (_, ids) => [{ kind: 'attack', units: [ids.interceptor, ids.bomber], target: ids.island }],
  },
  {
    name: 'bombers alone cannot hit a Sky slot structure and cannot capture past it: they move',
    setup: (w, team) => {
      const isl = w.ent('island', 'sky', 30, 30, other(team));
      isl.link = w.ent('aerie', 'sky', 30, 30, other(team), { link: isl.id }).id;
      return { selection: sel(w.ent('bomber', 'sky', 21, 20)), hover: w.on('sky', isl) };
    },
    id: 'move',
  },
  {
    name: 'a visible enemy Gun Platform on the hardpoint (which freezes capture) is attacked itself',
    setup: (w, team) => {
      const isl = w.ent('island', 'sky', 30, 30, other(team));
      w.ent('gun_platform', 'sky', 30, 30, other(team), { link: isl.id });
      return { selection: sel(w.ent('interceptor', 'sky', 20, 20)), hover: w.on('sky', isl) };
    },
    id: 'attack', label: 'Attack', intents: (_, ids) => [{ kind: 'attack', units: [ids.interceptor], target: ids.gun_platform }],
  },
  {
    name: 'interceptors hangar at an own built Aerie',
    setup: (w) => { const aerie = w.ent('aerie', 'sky', 30, 30); return { selection: sel(w.ent('interceptor', 'sky', 20, 20), w.ent('bomber', 'sky', 21, 20, undefined, { hangar: aerie.id } as Partial<Entity>)), hover: w.on('sky', aerie) }; },
    id: 'hangar', label: 'Hangar', intents: (_, ids) => [{ kind: 'hangar', units: [ids.interceptor], target: ids.aerie }],
  },
  // Armed units on visible enemies.
  {
    name: 'tanks attack a visible enemy; flak cannot hit the Surface and follows',
    setup: (w, team) => { const enemy = w.ent('tank', 'surface', 30, 30, other(team)); return { selection: sel(w.ent('tank', 'surface', 20, 20), w.ent('flak', 'surface', 21, 20)), hover: w.on('surface', enemy) }; },
    id: 'attack', label: 'Attack', intents: (w, ids) => [
      { kind: 'attack', units: [ids.tank], target: ids.enemy },
      { kind: 'move', units: [ids.flak], x: w.m(30), y: w.m(30), mode: 'move' },
    ],
  },
  {
    name: 'a turret emplacement focuses fire on an enemy',
    setup: (w, team) => { const enemy = w.ent('tank', 'surface', 30, 30, other(team)); return { selection: sel(w.ent('turret', 'surface', 25, 25)), hover: w.on('surface', enemy) }; },
    id: 'attack', intents: (_, ids) => [{ kind: 'attack', units: [ids.turret], target: ids.enemy }],
  },
  {
    name: 'flak alone on a Surface enemy moves there (no weapon reaches it)',
    setup: (w, team) => { const enemy = w.ent('tank', 'surface', 30, 30, other(team)); return { selection: sel(w.ent('flak', 'surface', 21, 20)), hover: w.on('surface', enemy) }; },
    id: 'move',
  },
  // Ground, Spire and modifiers.
  {
    name: 'ground moves only mobile units, never selected emplacements',
    setup: (w) => ({ selection: sel(w.ent('tank', 'surface', 20, 20), w.ent('turret', 'surface', 25, 25)), hover: w.ground('surface', 30.25, 31.75) }),
    id: 'move', label: 'Move', intents: (w, ids) => [{ kind: 'move', units: [ids.tank], x: w.m(30.25), y: w.m(31.75), mode: 'move' }],
  },
  {
    name: 'emplacements alone on ground resolve to nothing',
    setup: (w) => ({ selection: sel(w.ent('turret', 'surface', 25, 25)), hover: w.ground('surface', 30.25, 31.75) }),
  },
  {
    name: 'Shift queues the contextual order and its followers',
    setup: (w) => { const shaft = w.ent('shaft', 'surface', 14.5, 14.5); return { selection: sel(w.ent('trooper', 'surface', 20, 20), w.ent('tank', 'surface', 21, 20)), hover: w.on('surface', shaft), modifiers: { shiftKey: true, altKey: false } }; },
    id: 'transfer', intents: (w, ids) => [
      { kind: 'transfer', units: [ids.trooper], to: 'depths', x: w.m(14.5), y: w.m(14.5), queue: true },
      { kind: 'move', units: [ids.tank], x: w.m(14.5), y: w.m(14.5), mode: 'move', queue: true },
    ],
  },
  {
    name: 'Alt bypasses context: a plain move to the ground point',
    setup: (w) => { const shaft = w.ent('shaft', 'surface', 14.5, 14.5); return { selection: sel(w.ent('trooper', 'surface', 20, 20)), hover: { ...w.ground('surface', 14.25, 14.75), entity: shaft.id }, modifiers: { shiftKey: false, altKey: true } }; },
    id: 'move', intents: (w, ids) => [{ kind: 'move', units: [ids.trooper], x: w.m(14.25), y: w.m(14.75), mode: 'move' }],
  },
  {
    name: 'a Spire-only selection sets the rally point',
    setup: (w) => ({ selection: { units: [], spire: true }, hover: w.ground('surface', 30.25, 31.75) }),
    id: 'rally', label: 'Set rally', intents: (w) => [{ kind: 'rally', x: w.m(30.25), y: w.m(31.75) }],
  },
  // Convert: troopers into an own built Drill Yard; Breachers and enemy yards never convert.
  {
    name: 'surface troopers on an own built Drill Yard go in to convert (tanks stay out)',
    setup: (w) => { const yard = w.ent('drill_yard', 'surface', 14, 14); return { selection: sel(w.ent('trooper', 'surface', 20, 20), w.ent('tank', 'surface', 21, 20)), hover: w.on('surface', yard) }; },
    id: 'convert', label: 'Convert', intents: (_w, ids) => [{ kind: 'convert', units: [ids.trooper], to: 'breacher', yard: ids.drill_yard }],
  },
  {
    name: 'a Drill Yard still under construction does not convert',
    setup: (w) => { const yard = w.ent('drill_yard', 'surface', 14, 14, undefined, { state: 'constructing', progress: 0.5 }); return { selection: sel(w.ent('trooper', 'surface', 20, 20)), hover: w.on('surface', yard) }; },
    id: 'move',
  },
  {
    name: 'Breachers descend through an own built Shaft like troopers',
    setup: (w) => { const shaft = w.ent('shaft', 'surface', 14.5, 14.5); return { selection: sel(w.ent('breacher', 'surface', 20, 20)), hover: w.on('surface', shaft) }; },
    id: 'transfer', label: 'Descend', intents: (w, ids) => [{ kind: 'transfer', units: [ids.breacher], to: 'depths', x: w.m(14.5), y: w.m(14.5) }],
  },
  {
    name: 'nothing under the pointer resolves to nothing',
    setup: (w) => ({ selection: sel(w.ent('tank', 'surface', 20, 20)), hover: { plane: 'surface' } }),
  },
];

/** Fog: the same targets, hovered as stale tracks the team does not see now, never resolve to their action. */
const fogged: { name: string; setup(w: World, team: ArmyId): { selection: ToolSelection; hover: SmartHover }; never: string }[] = [
  { name: 'an unseen resource asteroid is never mined', never: 'mine_asteroid', setup: (w) => ({ selection: sel(w.ent('tug', 'orbit', 20, 20)), hover: w.on('orbit', w.ent('asteroid', 'orbit', 30, 30, 'neutral', { state: 'drifting', resourceType: 'ice', resourceRemaining: 50 }, false)) }) },
  { name: 'an unseen enemy is never attacked', never: 'attack', setup: (w, team) => ({ selection: sel(w.ent('tank', 'surface', 20, 20)), hover: w.on('surface', w.ent('tank', 'surface', 30, 30, other(team), {}, false)) }) },
  { name: 'an unseen island is never captured', never: 'capture', setup: (w) => ({ selection: sel(w.ent('interceptor', 'sky', 20, 20)), hover: w.on('sky', w.ent('island', 'sky', 30, 30, 'neutral', {}, false)) }) },
  { name: 'an unseen asteroid is never grappled', never: 'grapple', setup: (w) => ({ selection: sel(w.ent('tug', 'orbit', 20, 20)), hover: w.on('orbit', w.ent('asteroid', 'orbit', 30, 30, 'neutral', { state: 'drifting' }, false)) }) },
  { name: 'an unseen hostile slot never turns capture into attack', never: 'attack', setup: (w, team) => {
    const isl = w.ent('island', 'sky', 30, 30, other(team));
    isl.link = w.ent('aerie', 'sky', 30, 30, other(team), { link: isl.id }, false).id;
    return { selection: sel(w.ent('interceptor', 'sky', 20, 20)), hover: w.on('sky', isl) };
  } },
  { name: 'an unseen hostile Gun Platform never turns capture into attack', never: 'attack', setup: (w, team) => {
    const isl = w.ent('island', 'sky', 30, 30, other(team));
    w.ent('gun_platform', 'sky', 30, 30, other(team), { link: isl.id }, false);
    return { selection: sel(w.ent('interceptor', 'sky', 20, 20)), hover: w.on('sky', isl) };
  } },
  { name: 'an enemy Drill Yard is never a conversion target', never: 'convert', setup: (w, team) => ({ selection: sel(w.ent('trooper', 'surface', 20, 20)), hover: w.on('surface', w.ent('drill_yard', 'surface', 14, 14, other(team))) }) },
  { name: 'unknown ore is never mined', never: 'mine', setup: (w) => ({ selection: sel(w.ent('digger', 'depths', 20, 20)), hover: w.ground('depths', 30.5, 31.5) }) },
  { name: 'an unseen lava-lake cell is never bridged (unknown, however it lies)', never: 'bridge', setup: (w) => { w.view.depths[w.cell(30.5, 31.5)] = CELL.unknown; return { selection: sel(w.ent('digger', 'depths', 20, 20)), hover: w.ground('depths', 30.5, 31.5) }; } },
];

describe('smart right-click resolution', () => {
  it('declares every row once per target kind, on the planes it answers', () => {
    for (const rule of SMART_RULES) expect(rule.planes.every((p) => PLANES.includes(p))).toBe(true);
    expect(new Set(SMART_RULES.map((r) => r.id))).toEqual(new Set(['attack', 'capture', 'hangar', 'convert', 'mine_asteroid', 'grapple', 'dock', 'transfer', 'repair', 'bridge', 'lava', 'work', 'mine', 'dig', 'enter', 'move', 'rally']));
  });

  describe.each(slotArmyIds(2))('%s', (team) => {
    it.each(cases)('$name', (c) => {
      const w = world(team);
      const { selection, hover, modifiers } = c.setup(w, team);
      const ids: Record<string, string> = {};
      for (const e of [...selection.units, ...w.view.entities]) ids[e.side === team || e.side === 'neutral' ? e.kind : 'enemy'] ??= e.id;
      for (const e of w.view.entities) if (e.side !== team && e.side !== 'neutral') ids[e.kind] ??= e.id;
      const action = resolveSmartAction(selection, hover, w.view as View, modifiers ?? NONE);
      if (!c.id) { expect(action).toBeUndefined(); return; }
      expect(action?.id).toBe(c.id);
      if (c.label) expect(action?.label).toBe(c.label);
      expect(action?.cursor).toBe(SMART_RULES.find((r) => r.id === c.id)!.cursor);
      if (c.intents) expect(action?.intents).toEqual(c.intents(w, ids));
      expect(action?.refused).toBe(c.id === 'lava' ? true : undefined);
    });

    it.each(fogged)('$name', (c) => {
      const w = world(team);
      const { selection, hover } = c.setup(w, team);
      const action = resolveSmartAction(selection, hover, w.view as View, NONE);
      expect(action?.id).not.toBe(c.never);
    });
  });

  it('names actions with the cursors the client shows', () => {
    expect(SMART_RULES.find((r) => r.id === 'transfer')!.cursor).toBe(CURSOR.enter);
    expect(SMART_RULES.find((r) => r.id === 'grapple')!.cursor).toBe(CURSOR.grapple);
    expect(SMART_RULES.find((r) => r.id === 'capture')!.cursor).toBe(CURSOR.capture);
  });
});
