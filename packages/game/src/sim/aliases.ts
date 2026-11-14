/**
 * Per-army entity names (fog safety). Sim ids come from one global sequence, so a raw id would tell a team how many
 * entities every army created (a gap between two of its own ids, the number on an enemy unit it sees) and in what
 * order. Every fogged output (observations, views, intents) names entities by the viewing army's alias instead: its
 * own entities in creation order, everything else in the order it first saw them, so an alias says only what the army
 * already knew. Islands and forward posts are public, static objects: they take the first aliases in spawn order, the
 * same for every army (a preview numbers them without a sim). The omniscient observer keeps sim ids.
 *
 * A pure function of the match history, like fog memory: cloned, not hashed (an alias table that diverged would resolve
 * intents differently, which the entity state shows). Aliases never change and are never reused.
 */
import { KIND_CODE } from './hash.ts';
import { type Army, canonX, canonY, isArmy, type SideId } from '../util/teams.ts';
import type { Ent } from './ent.ts';
import type { Sim } from './sim.ts';
import type { OreCache } from './state.ts';

/** One army's names: `of[simId]` its alias (0: not named yet), `sim[alias]` the sim id, `count` aliases given. */
export interface AliasTable {
  of: Int32Array;
  sim: Int32Array;
  count: number;
}

/** First table sizes (sim ids, aliases); both grow by doubling. */
const ALIAS_TABLE_START = 1024;

export function aliasTable(): AliasTable {
  return { of: new Int32Array(ALIAS_TABLE_START), sim: new Int32Array(ALIAS_TABLE_START), count: 0 };
}

/** noteSightings scratch (module-level: never match state, so a clone never carries it). */
const sighted: Ent[] = [];
const sightedCaches: OreCache[] = [];
let sortSim: Sim | null = null;
let sortArmy: Army = 0;

/** The sighting batch order seen from `sortArmy`: its own frame's position (y, then x), kind, relative owner, owner serial. */
function sightOrder(a: Ent, b: Ent): number {
  const sim = sortSim!;
  const k = sim.armyFrame[sortArmy]!, size = sim.size;
  return canonY(k, a.x, a.y, size) - canonY(k, b.x, b.y, size) || canonX(k, a.x, a.y, size) - canonX(k, b.x, b.y, size)
    || KIND_CODE[a.kind] - KIND_CODE[b.kind] || ownerOrder(sim, sortArmy, a.side) - ownerOrder(sim, sortArmy, b.side) || a.seq - b.seq;
}

/** Caches by their surface position in the viewer's frame; two caches never share a point, the id only settles a tie. */
function cacheOrder(a: OreCache, b: OreCache): number {
  const sim = sortSim!;
  const k = sim.armyFrame[sortArmy]!, size = sim.size;
  return canonY(k, a.x, a.y, size) - canonY(k, b.x, b.y, size) || canonX(k, a.x, a.y, size) - canonX(k, b.x, b.y, size) || a.id - b.id;
}

/** Owners clockwise from `army` (itself first), neutral last. */
function ownerOrder(sim: Sim, army: Army, side: SideId): number {
  return isArmy(side) ? sim.rel(army, side) : sim.sides;
}

export class SimAliases {
  /** `army`'s alias of sim id `id` (0: it has no name for it). */
  aliasOf(this: Sim, army: Army, id: number): number {
    const table = this.armies[army]!.aliases;
    return id > 0 && id < table.of.length ? table.of[id]! : 0;
  }

  /** The sim id `army` names `alias` (0: no such alias). */
  aliasTarget(this: Sim, army: Army, alias: number): number {
    const table = this.armies[army]!.aliases;
    return Number.isInteger(alias) && alias > 0 && alias <= table.count ? table.sim[alias]! : 0;
  }

  /** Name sim id `id` for `army` (the next alias), unless it has a name already. */
  giveAlias(this: Sim, army: Army, id: number): void {
    const table = this.armies[army]!.aliases;
    if (id >= table.of.length) {
      const of = new Int32Array(Math.max(id + 1, table.of.length * 2));
      of.set(table.of);
      table.of = of;
    } else if (table.of[id] !== 0) return;
    const alias = ++table.count;
    if (alias >= table.sim.length) {
      const sim = new Int32Array(table.sim.length * 2);
      sim.set(table.sim);
      table.sim = sim;
    }
    table.of[id] = alias;
    table.sim[alias] = id;
  }

  /**
   * End of construction: every army names the islands, then the forward posts (spawn order, public), then its own start
   * entities in creation order; from here on `add` names each new entity for its owner at once (noteSightings: the rest).
   */
  openAliases(this: Sim): void {
    for (const army of this.allArmies) {
      for (const e of this.ents) if (e.kind === 'island') this.giveAlias(army, e.id);
      for (const post of this.posts) this.giveAlias(army, post.id);
      for (const e of this.ents) if (e.side === army) this.giveAlias(army, e.id);
    }
    this.aliasesOpen = true;
  }

  /**
   * Name what each army sees now and has no name for (Sim.sees, ore caches as presented): after every vision refresh
   * and at the end of every step, so every observation between two steps finds a name for all it shows. One batch per
   * army takes its own frame's order, so rotated armies name rotated twins alike.
   */
  noteSightings(this: Sim): void {
    sortSim = this;
    for (const army of this.allArmies) {
      sortArmy = army;
      for (const e of this.ents) if (!e.dead && this.aliasOf(army, e.id) === 0 && this.sees(army, e)) sighted.push(e);
      if (sighted.length) {
        sighted.sort(sightOrder);
        for (const e of sighted) this.giveAlias(army, e.id);
        sighted.length = 0;
      }
      for (const cache of this.oreCaches) if (this.aliasOf(army, cache.id) === 0 && this.cacheSight(army, cache) !== 0) sightedCaches.push(cache);
      if (sightedCaches.length) {
        sightedCaches.sort(cacheOrder);
        for (const cache of sightedCaches) this.giveAlias(army, cache.id);
        sightedCaches.length = 0;
      }
    }
    sortSim = null;
  }
}
