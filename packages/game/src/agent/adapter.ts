/**
 * PlayerThree bindings: one `AgentCommandGame` per match (GameAdapter) and the `definition` factory.
 */
import { SignalBoard, type ApplyResult, type BotCommander, type Controller, type FinalOutcome, type GameAdapter, type GameDefinition, type IntentContext, type MandateOf, type MatchSides, type Seat, type SignalLimits } from 'playerthree';
import type { Infer } from 'playerthree/schema';
import { createBot } from '../bots/bots.ts';
import { botPackages } from '../bots/packages.ts';
import {
  ARMIES, COLOURS, PLANES, TICK_RATE, botOptionsSchema, checkRules, matchOptionsSchema, resolveRules, signalLimitsOf,
  type ArmyId, type Colour, type FxKind, type GameEvent, type Kind, type MatchArmy, type FullObservation, type MatchData, type Observation, type ObserverView, type Opponent, type Outcome, type Plane, type Report, type View,
} from '../rules/contract.ts';
import { applyIntent, simIntent, type AgentCommandIntent } from './intents.ts';
import { manifest, type AgentCommandManifest } from './manifest.ts';
import { eventsSince, matchData, observe, observerView, outcomeOf, rankOf, report, view } from './present.ts';
import { Sim, type ArmySpec } from '../sim/sim.ts';
import { recordIntent } from '../sim/recording.ts';
import { resolveMapSides } from '../maps/maps.ts';
import { createMetrics } from '../metrics/metrics.ts';
import { isArmyId, slotOfArmyId } from '../util/teams.ts';

/** debugView: most entities listed in one dump (the rest are counted in `entitiesOmitted`). */
const DEBUG_ENTITY_CAP = 2048;
/** debugView: most recent events listed per army. */
const DEBUG_EVENT_CAP = 40;

export type AgentCommandSeat = Seat<AgentCommandManifest>;

export class AgentCommandGame implements GameAdapter<AgentCommandManifest> {
  readonly manifest = manifest;
  readonly sim: Sim;
  /**
   * Team signals when no PlayerThree host runs the match (playBotMatch, tests, sweeps): observe/view attach its slices
   * and apply answers signal intents with it. Under a host it stays empty: the host owns signals, intercepts their
   * intents before apply and replaces the observation/view `signals` member with its own board's.
   */
  readonly signals: SignalBoard;

  /** Has each army's broadcast carried the public immutable match bootstrap? */
  private readonly matchSent: Partial<Record<ArmyId, boolean>> = {};

  /**
   * `options`: the match rules (throws on rules out of bounds; the PlayerThree host validates them before this).
   * `armies`: who plays (corners of the resolved map, any order) in which colour; default every slot of the map, the
   * k-th in slot order coloured COLOURS[k] (a two-slot map: nw blue against se red).
   */
  constructor(seed: number, options: unknown = {}, armies?: readonly MatchArmy[]) {
    const checked = checkRules(options);
    if (!checked.ok) throw new Error(`invalid match rules: ${checked.error}`);
    if (!armies) this.sim = new Sim(seed, checked.options);
    else {
      // Only the slot count is needed here: the Sim resolves the document itself, so a generated map keeps its public
      // identity (mapHash of the public layers only).
      const sides = resolveMapSides(resolveRules(checked.options).map, checked.options.map);
      const specs: ArmySpec[] = armies.map((a) => {
        const slot = isArmyId(a.id) ? slotOfArmyId(a.id, sides) : -1;
        if (slot < 0) throw new Error(`army ${String(a.id)} is no corner of this ${sides}-slot map`);
        return { slot, colour: a.colour };
      }).sort((a, b) => a.slot - b.slot);
      this.sim = new Sim(seed, checked.options, undefined, specs);
    }
    this.signals = new SignalBoard(manifest, this.sim.armyIds, signalLimitsOf(this.sim.econ));
  }

  /** Preserve broadcast state as well as the simulation; the immutable game manifest is shared. */
  clone(): AgentCommandGame {
    return Object.assign(Object.create(AgentCommandGame.prototype) as AgentCommandGame, {
      manifest: this.manifest,
      sim: this.sim.clone(),
      signals: this.signals.clone(),
      matchSent: { ...this.matchSent },
    });
  }

  get tick(): number {
    return this.sim.tick;
  }

  step(): void {
    this.sim.step();
    this.signals.advance(this.sim.tick);
  }

  outcome(army: ArmyId): Outcome {
    return outcomeOf(this.sim, army);
  }

  /** Final placement (1 = winner), read by the host once the army's outcome is final. */
  rank(army: ArmyId): number {
    const rank = rankOf(this.sim, army);
    if (rank === null) throw new Error(`army ${army} has no final placement yet`);
    return rank;
  }

  /** The army concedes: it is eliminated at the end of the next tick, and the match goes on for the others. */
  forfeit(army: ArmyId): void {
    this.sim.forfeit(this.sim.armyIndex(army));
  }

  /**
   * The host ended the match early (operator console, `PlayerThreeMatch.end`): the sim adopts the outcomes and placements
   * for views and reports. The host passes every match army.
   */
  end(outcomes: Partial<Record<ArmyId, FinalOutcome>>, ranks: Partial<Record<ArmyId, number>>): void {
    const sim = this.sim;
    sim.finish(sim.armyIds.map((id) => outcomes[id]!), sim.armyIds.map((id) => ranks[id]!));
  }

  view(army: ArmyId, opts?: { snapshot: boolean }): View {
    const withMatch = opts?.snapshot === true || !this.matchSent[army];
    if (opts?.snapshot !== true) this.matchSent[army] = true;
    return { ...view(this.sim, army, withMatch), signals: this.signals.team(army) as View['signals'] };
  }

  /** Separate read-only observer boundary; authorization and wall-clock delay belong to the host. */
  observerView(): ObserverView {
    return observerView(this.sim);
  }

  /** Bounded unfogged JSON for local developer tools; never part of a player's view or an agent observation. */
  debugView(opts: { plane?: Plane; detail?: 'summary' | 'entities' | 'events' } = {}): Record<string, unknown> {
    const sim = this.sim;
    const planes = opts.plane ? [opts.plane] : PLANES;
    const detail = opts.detail ?? 'entities';
    /** Debug numbers to one decimal. */
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const armies: Partial<Record<ArmyId, unknown>> = {};
    for (const army of sim.allArmies) {
      const t = sim.armies[army]!;
      const units: Partial<Record<Plane, Partial<Record<Kind, number>>>> = {};
      const structures: Partial<Record<Plane, Partial<Record<Kind, number>>>> = {};
      for (const e of sim.ents) {
        if (e.dead || e.side !== army || !planes.includes(e.plane)) continue;
        const bucket = e.unit ? units : e.structure && e.kind !== 'spire' ? structures : undefined;
        if (!bucket) continue;
        const byKind = (bucket[e.plane] ??= {});
        byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      }
      armies[sim.armyIds[army]!] = {
        colour: sim.armyColour[army], ...(sim.inPlay(army) ? {} : { eliminatedAt: sim.eliminatedAt[army] }),
        alloy: Math.floor(t.alloy), energy: Math.floor(t.energy), alloyRate: r1(sim.alloyRate(army)),
        solar: r1(t.solar), energyCap: r1(t.cap), energyBank: Math.floor(t.energyBank), pop: t.pop,
        spire: Object.fromEntries(planes.map((p) => [p, `${Math.max(0, Math.round(t.spire[p].hp))}/${t.spire[p].maxHp}`])),
        units, structures,
        stats: Object.fromEntries(Object.entries(t.stats).map(([k, v]) => [k, Math.round(v)])),
      };
    }
    const fights: Partial<Record<Plane, Partial<Record<FxKind, number>>>> = {};
    for (const f of sim.fx) {
      if (!planes.includes(f.fx.plane)) continue;
      const byKind = (fights[f.fx.plane] ??= {});
      byKind[f.fx.kind] = (byKind[f.fx.kind] ?? 0) + 1;
    }
    const result = sim.result;
    const out: Record<string, unknown> = {
      tick: sim.tick, seconds: r1(sim.tick / TICK_RATE),
      result: result ? Object.fromEntries(sim.armyIds.map((id, a) => [id, { outcome: result.outcome[a], rank: result.rank[a] }])) : 'running',
      sunAngle: Math.round(sim.sunAngle * 1000) / 1000, armies, fights,
      projectiles: sim.projectiles.filter((p) => planes.includes(p.plane)).length, charges: sim.charges.length,
    };
    if (detail === 'entities') {
      const entities = [];
      let total = 0;
      for (const e of sim.ents) {
        if (e.dead || !planes.includes(e.plane)) continue;
        total++;
        if (entities.length >= DEBUG_ENTITY_CAP) continue;
        entities.push({
          id: `e_${e.id}`, kind: e.kind, side: sim.sideId(e.side), plane: e.plane, x: r1(e.x), y: r1(e.y),
          hp: Math.max(0, Math.round(e.hp)), maxHp: e.maxHp, state: e.state,
          ...(e.order.k !== 'none' ? { order: e.order.k } : {}),
          ...(e.order.k === 'attack' ? { target: `e_${e.order.target}` } : {}),
          ...(e.queue.length ? { queue: e.queue.map((q) => ({ order: q.k, ...(q.k === 'attack' ? { target: `e_${q.target}` } : {}) })) } : {}),
          ...(e.built ? {} : { building: r1(e.progress) }), ...(e.link ? { link: `e_${e.link}` } : {}),
        });
      }
      out.entities = entities;
      out.entitiesOmitted = total - entities.length;
    }
    if (detail === 'events') {
      out.events = Object.fromEntries(sim.armyIds.map((id) => [id, eventsSince(sim, id, -1).filter((ev) => planes.includes(ev.plane)).slice(-DEBUG_EVENT_CAP)]));
    }
    return out;
  }

  matchData(seat: AgentCommandSeat): MatchData {
    return matchData(this.sim, this.sim.armyIndex(seat.team));
  }

  /**
   * Sim entity `id` as `team`'s observations, views and intents name it (sim/aliases.ts): for game code that holds a
   * sim entity (tests, developer tools). Throws for an entity the army has no name for (it never saw it).
   */
  entityId(team: ArmyId, id: number): string {
    const alias = this.sim.aliasOf(this.sim.armyIndex(team), id);
    if (alias === 0) throw new Error(`army ${team} has no name for entity ${id}`);
    return `e_${alias}`;
  }

  /**
   * `detail`: the planes rendered in full, in plane order (the host passes the seat's resolved observation scope);
   * omitted, every plane — game code (built-in bots, headless bot matches, tests) sees everything its army knows.
   */
  observe(seat: AgentCommandSeat, sinceTick: number): FullObservation;
  observe(seat: AgentCommandSeat, sinceTick: number, detail: readonly Plane[]): Observation;
  observe(seat: AgentCommandSeat, sinceTick: number, detail: readonly Plane[] = PLANES): Observation {
    return { ...observe(this.sim, seat.team, seat.role, sinceTick, detail), signals: this.signals.seat(seat.team, seat.role) as Observation['signals'] };
  }

  /** The match's `signals` rules: narrowed limits, or null when signals are off. */
  signalLimits(): SignalLimits | null {
    return signalLimitsOf(this.sim.econ);
  }

  /** `intent` names entities as the seat's army does (its aliases); the sim reads, and recordings see, sim ids. */
  apply(seat: AgentCommandSeat, intent: AgentCommandIntent, context?: IntentContext): ApplyResult<AgentCommandManifest> {
    const army = this.sim.armyIndex(seat.team);
    let result: ApplyResult<AgentCommandManifest>;
    const resolved = simIntent(this.sim, army, intent);
    if (resolved.kind === 'signal' || resolved.kind === 'signal_update') {
      // Headless only: a host never passes signal intents to apply.
      result = this.signals.apply(seat.team, seat.role, resolved, this.sim.tick).ok ? { ok: true } : { ok: false, code: 'signal_refused' };
    } else result = applyIntent(this.sim, army, seat.role, resolved, context?.source ?? 'owner', context?.ownerRoles);
    recordIntent(this.sim, army, seat.role, resolved, result);
    return result;
  }

  report(army: ArmyId): Report {
    return report(this.sim, army);
  }

  events(seat: AgentCommandSeat, sinceTick: number): GameEvent[] {
    return eventsSince(this.sim, seat.team, sinceTick);
  }

  setSeatInfo(seat: AgentCommandSeat, info: { controller: Controller; mandate: MandateOf<AgentCommandManifest> }): void {
    const { mandate } = info;
    this.sim.armies[this.sim.armyIndex(seat.team)]!.seats[seat.role] = {
      controller: info.controller,
      mandate: { ...mandate, directive: { ...mandate.directive }, ...(mandate.limits === undefined ? {} : { limits: { ...mandate.limits } }) },
    };
  }

  /** Hash of the full authoritative state (determinism checks, replay verification). */
  stateHash(): string {
    return this.sim.hash();
  }
}

export function createGame(opts: { seed: number; options?: Infer<typeof matchOptionsSchema>; armies?: readonly MatchArmy[] }): AgentCommandGame {
  return new AgentCommandGame(opts.seed, opts.options, opts.armies);
}

/**
 * The armies of an PlayerThree match: `teams` are army ids; alliances are keyed by colour (stage 2: one army each).
 * Without alliances the k-th army in slot order takes COLOURS[k].
 */
export function matchArmies(sides: MatchSides<AgentCommandManifest>): MatchArmy[] {
  const colourOf = new Map<ArmyId, Colour>();
  for (const [id, members] of Object.entries(sides.alliances ?? {})) {
    if (!(COLOURS as readonly string[]).includes(id)) throw new Error(`unsupported alliance ${id}: alliances are army colours`);
    // Alliances (several armies of one colour) are colour teams, on the roadmap (docs/ROADMAP.md).
    if (members.length !== 1) throw new Error('unsupported alliances: every army plays on its own');
    colourOf.set(members[0]!, id as Colour);
  }
  // Slot order is corner order within any one map, so the default colouring follows the corners.
  const ids = [...sides.teams].sort((a, b) => ARMIES.indexOf(a) - ARMIES.indexOf(b));
  return ids.map((id, k) => ({ id, colour: colourOf.get(id) ?? COLOURS[k]! }));
}

export const definition: GameDefinition<AgentCommandManifest> = {
  manifest,
  create(opts: { seed: number; options?: Infer<typeof matchOptionsSchema> } & MatchSides<AgentCommandManifest>): AgentCommandGame {
    return new AgentCommandGame(opts.seed, opts.options, matchArmies(opts));
  },
  metrics: (game, options) => createMetrics(game as AgentCommandGame, options?.sampleEveryTicks),
  botOptions: botOptionsSchema,
  /** Every bot seat plays its tier's built package through PlayerThree's trusted runner (bots/packages.ts). */
  botPackages: (level, role) => botPackages(manifest).get(`${level}/${role}`),
  /** PlayerThree's fallback for a stale, missing, failed or hung package: the same bot in-process. */
  createBot(seat: AgentCommandSeat, opponent: Opponent, options?: Record<string, number | boolean>): BotCommander<AgentCommandManifest> {
    return createBot(seat.team, seat.role, opponent, options);
  },
};
