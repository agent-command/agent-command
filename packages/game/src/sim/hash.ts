/**
 * Allocation-free FNV-1a mixer for `Sim.hash()`. One hash runs at a time (synchronous), so the running value is
 * module state; enumerated strings mix by their registry index, never by length.
 */
import { WEAPONS } from '../rules/stats.ts';
import { KINDS, PLANES, QUEUE_ITEMS, QUEUE_REASONS, QUEUE_STATUSES, STATES, UNIT_STANCES } from '../rules/vocabulary.ts';
import { NEUTRAL, type SideId } from '../util/teams.ts';
import { FNV_OFFSET, FNV_PRIME } from '../util/fnv.ts';
import { type Order, ORDER_KINDS } from './ent.ts';
import type { Controller } from 'playerthree';

/** `mix` keeps this many fractional steps per unit (four decimals). */
const MIX_SCALE = 1e4;

function codes<T extends string>(values: readonly T[]): Record<T, number> {
  const out = {} as Record<T, number>;
  values.forEach((v, i) => { out[v] = i + 1; });
  return out;
}

export const KIND_CODE = codes(KINDS);
/**
 * Owner code: armies 0 and 1 mix as 1 and 2 and neutral as 3 (the two-army codes since the first replays), armies 2
 * and 3 as 4 and 5.
 */
export const sideCode = (s: SideId): number => (s === NEUTRAL ? 3 : s < 2 ? s + 1 : s + 2);
export const STATE_CODE = codes(STATES);
export const STANCE_CODE = codes(UNIT_STANCES);
export const WEAPON_CODE = codes(WEAPONS);
export const ITEM_CODE = codes(QUEUE_ITEMS);
export const STATUS_CODE = codes(QUEUE_STATUSES);
export const REASON_CODE = codes(QUEUE_REASONS);
const PLANE_CODE = codes(PLANES);
const CONTROLLER_CODE: Record<Controller, number> = { human: 1, agent: 2, policy: 3, bot: 4, none: 5 };
const ORDER_CODE: Record<Order['k'], number> = codes(ORDER_KINDS);

let h = 0;

export function hashBegin(): void {
  h = FNV_OFFSET;
}

/** Mixes the integer part and four decimals (floats that differ below 1e-4 can collide). */
export function mix(v: number): void {
  h ^= v | 0;
  h = Math.imul(h, FNV_PRIME);
  h ^= (v * MIX_SCALE) | 0;
  h = Math.imul(h, FNV_PRIME);
}

export function mixBool(v: boolean): void {
  mix(v ? 1 : 0);
}

export function mixController(v: Controller): void {
  mix(CONTROLLER_CODE[v]);
}

export function hashEnd(): string {
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Map entries in insertion order (forEach with a fixed callback allocates nothing). */
const mixEntry = (v: number, k: number): void => {
  mix(k);
  mix(v);
};
export function mixMap(m: ReadonlyMap<number, number>): void {
  mix(m.size);
  m.forEach(mixEntry);
}

export function mixOrder(o: Order): void {
  mix(ORDER_CODE[o.k]);
  switch (o.k) {
    case 'none':
    case 'intercept':
      return;
    case 'move':
      mix(o.x); mix(o.y); mixBool(o.fight); mix(o.speed);
      if (o.fleet) {
        mix(o.ox!); mix(o.oy!);
        mix(o.fleet.x); mix(o.fleet.y); mix(o.fleet.goalX); mix(o.fleet.goalY);
        mix(o.fleet.speed); mix(o.fleet.vx); mix(o.fleet.vy); mix(o.fleet.skirt); mix(o.fleet.updated);
        mixBool(o.fleet.started); mix(o.fleet.anchor); mix(sideCode(o.fleet.side)); mixBool(o.fleet.finished);
        mix(o.fleet.members.length);
        for (const id of o.fleet.members) mix(id);
      }
      return;
    case 'patrol':
      mix(o.ax); mix(o.ay); mix(o.bx); mix(o.by); mixBool(o.toB);
      return;
    case 'attack':
    case 'hangar':
      mix(o.target);
      return;
    case 'dig':
    case 'rail':
      mix(o.c);
      return;
    case 'mine':
      mix(o.ore); mixBool(o.exploring); mix(o.near); mixBool(o.auto === true);
      return;
    case 'fortify':
    case 'bridge':
      mix(o.c); mixBool(o.working);
      return;
    case 'bulkhead':
      mix(o.c); mixBool(o.working); mix(o.entry); mixBool(o.geothermal === true);
      return;
    case 'undermine':
      mix(o.c); mix(o.at);
      return;
    case 'breach':
      mix(o.c); mixBool(o.felt);
      return;
    case 'transfer':
      mix(PLANE_CODE[o.to]); mix(o.shaft);
      return;
    case 'capture':
      mix(o.island);
      return;
    case 'grapple':
      mix(o.asteroid);
      return;
    case 'mine_asteroid':
      mix(o.asteroid); mixBool(o.returning); mixBool(o.exhausted ?? false); mixBool(o.auto === true); mixBool(o.site !== undefined);
      if (o.site) { mix(o.site.x); mix(o.site.y); mix(o.site.vx); mix(o.site.vy); mix(o.site.tick); }
      return;
    case 'convert':
      mix(o.yard);
      mixBool(o.at);
      return;
    case 'vent':
      mix(o.until);
      return;
  }
}
