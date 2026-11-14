/**
 * Schema building blocks shared by the observation and intent schemas (positions, cells, planes, sides, entity
 * ids). Internal to rules/: the `/contract` barrel does not re-export them.
 */
import { t } from 'playerthree/schema';
import { ARMIES, KINDS, MAX_MAP_SIZE, PLANES, SIDES } from './vocabulary.ts';

export const xy = { x: t.num(0, MAX_MAP_SIZE, 'tile x'), y: t.num(0, MAX_MAP_SIZE, 'tile y') };
export const cellXY = { x: t.int(0, MAX_MAP_SIZE - 1, 'cell x'), y: t.int(0, MAX_MAP_SIZE - 1, 'cell y') };
export const plane = t.enum(PLANES);
export const army = t.enum(ARMIES);
export const side = t.enum(SIDES);
export const kind = t.enum(KINDS);
export const eid = t.id('e', 'entity id');
