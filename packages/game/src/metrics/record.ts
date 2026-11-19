/**
 * Recorder: turns one authoritative match into a MatchTrace without mutating it. Captures existing event/effect
 * references before player windows evict them, then resolves them after each tick. Death attribution comes from
 * final damage provenance, including firing planes, payload owners, captures and named environmental causes.
 */
import { toTicks, type ArmyId, type EventKind, type FxKind, type Plane, type Side } from '../rules/contract.ts';
import type { AgentCommandIntent, ApplyResult } from '../agent/intents.ts';
import type { Ent } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import type { FxRec, SimEvent } from '../sim/state.ts';
import { subscribeRecording } from '../sim/recording.ts';
import { isArmy, type Army, type SideId } from '../util/teams.ts';
import { DAMAGE_ORIGINS, REC, type DamageOrigin, type MatchTrace, type SapperMetrics, type SpireDamage, type TraceEvent, type UnitSample } from './trace.ts';
import { LodeRecorder } from './lodes.ts';
import { perArmy, perPlane } from './summary.ts';

/** What the metrics read from a match: the authoritative sim (structurally, an AgentCommandGame). */
export interface MeasuredGame {
  readonly tick: number;
  readonly sim: Sim;
}

/** Minutes at which units per plane are counted. */
export const UNIT_SAMPLE_MINUTES = [1, 3, 5, 10] as const;

/** Effects that duplicate a recorded game event, or that the recorder handles itself. Others become `fx:<kind>`. */
const FX_HANDLED: Partial<Record<FxKind, true>> = {
  shot: true,
  death: true,
  portal: true,
  scan: true,
  deliver: true,
  dig: true,
  collapse: true,
  impact: true,
  breach: true,
  intercept: true,
  defuse: true,
  deorbit: true,
  // public effects that mirror a game event (chasm_opened, breach_opened, hole_bridged)
  chasm: true,
  breakout: true,
  bridge: true,
};
/** Game events replaced by attributed kills, or advisory noise (throttled alerts). */
const EVENTS_SKIPPED: Partial<Record<EventKind, true>> = {
  unit_lost: true,
  enemy_killed: true,
  structure_lost: true,
  structure_destroyed: true,
  spire_damaged: true,
  enemy_sapper_seen: true,
};

export class Recorder {
  private readonly sim: Sim;
  private readonly events: TraceEvent[] = [];
  private readonly samples: UnitSample[] = [];
  private readonly pendingEvents: SimEvent[] = [];
  private readonly pendingFx: FxRec[] = [];
  private readonly unsubscribe: () => void;
  private readonly towed = new Set<number>();
  private nextSample = 0;
  private readonly lodes: LodeRecorder;
  private readonly falls = new Map<Side, number>();
  private readonly seen = new Set<SimEvent>();
  private readonly data: MatchTrace;
  /** Per army index: its Spire segments' damage rows and its sapper tallies (the trace's records, by reference). */
  private readonly spire: Record<Plane, SpireDamage>[] = [];
  private readonly sappers: SapperMetrics[] = [];
  /**
   * HP the detonating charge took from hostile structures so far. A charge deals its damage and then emits its
   * `collapse` or `chasm_opened` event within one synchronous call, so that event closes the tally.
   */
  private chargeDamage = 0;

  constructor(game: MeasuredGame) {
    this.sim = game.sim;
    this.lodes = new LodeRecorder(this.sim);
    const spireDamage: MatchTrace['spireDamage'] = {};
    const sappers: MatchTrace['sappers'] = {};
    for (const army of this.sim.allArmies) {
      const id = this.sim.armyIds[army]!;
      spireDamage[id] = this.spire[army] = perPlane(() => ({ from: Object.fromEntries(DAMAGE_ORIGINS.map((o) => [o, 0])) as Record<DamageOrigin, number>, by: {} }));
      sappers[id] = this.sappers[army] = { ordered: 0, noTunnel: 0, rejected: 0, planted: 0, defused: 0, dud: 0, hit: 0, damage: 0, chasmOrdered: 0, chasmRejected: 0 };
    }
    this.data = { ticks: this.sim.tick, armies: [...this.sim.armyIds], events: this.events, samples: this.samples, spireDamage, sappers, lodes: this.lodes.metrics };
    for (const army of this.sim.allArmies) for (const event of this.sim.armies[army]!.events) {
      if (this.seen.has(event)) continue;
      this.seen.add(event);
      this.pendingEvents.push(event);
    }
    this.seen.clear();
    for (const effect of this.sim.fx) this.pendingFx.push(effect);
    this.unsubscribe = subscribeRecording(this.sim, {
      event: (event) => {
        this.charge(event);
        this.pendingEvents.push(event);
      },
      effect: (effect) => this.pendingFx.push(effect),
      damage: (e, dealt, by, cause, sourcePlane) => this.damage(e, dealt, by, cause, sourcePlane),
      intent: (team, _role, intent, result) => this.intent(team, intent, result),
    });
  }

  /** Spire HP lost by source, and charge damage to hostile structures (runs inside Sim.damage: no allocation). */
  private damage(e: Ent, dealt: number, by: SideId, cause: string, sourcePlane: Plane | undefined): void {
    if (e.kind === 'spire' && isArmy(e.side)) {
      const row = this.spire[e.side]![e.plane];
      row.from[sourcePlane ?? 'none'] += dealt;
      row.by[cause] = (row.by[cause] ?? 0) + dealt;
    }
    if (cause === 'collapse' && e.structure && isArmy(e.side) && this.sim.hostile(by, e.side)) this.chargeDamage += dealt;
  }

  /** Charge outcomes, as the charge events are emitted (before player event windows can evict them). */
  private charge(ev: SimEvent): void {
    if (ev.side === undefined || !isArmy(ev.side)) return;
    const s = this.sappers[ev.side]!;
    switch (ev.kind) {
      case 'charge_planted':
        s.planted++;
        break;
      case 'charge_defused':
        s.defused++;
        break;
      // Only charges collapse ground or open chasms.
      case 'collapse':
      case 'chasm_opened':
        if (this.chargeDamage > 0) s.hit++;
        else s.dud++;
        s.damage += this.chargeDamage;
        this.chargeDamage = 0;
        break;
    }
  }

  /** Undermine intents: accepted, refused for want of a tunnel or otherwise, and those aimed at a fault (a chasm attempt). */
  private intent(team: Army, intent: AgentCommandIntent, result: ApplyResult): void {
    if (intent.kind !== 'undermine') return;
    const s = this.sappers[team]!;
    const { size } = this.sim;
    const c = intent.y * size + intent.x;
    const fault = Number.isInteger(intent.x) && Number.isInteger(intent.y) && intent.x >= 0 && intent.y >= 0 && intent.x < size && intent.y < size
      && this.sim.faultOf[c]! >= 0 && !this.sim.holes[c];
    if (result.ok) {
      s.ordered++;
      if (fault) s.chasmOrdered++;
      return;
    }
    if (result.code === 'no_path' || result.code === 'invalid_target') s.noTunnel++;
    else s.rejected++;
    if (fault) s.chasmRejected++;
  }

  trace(): MatchTrace {
    this.data.ticks = this.sim.tick;
    return this.data;
  }

  /** Release the observational subscription after the final collection. */
  close(): void {
    this.unsubscribe();
  }

  /** Record everything that happened since the last call. Call after every tick (effects live for half a second). */
  collect(): void {
    const sim = this.sim;
    this.lodes.collect();
    const falls = this.collectEvents();
    this.collectFx(falls);
    for (const e of sim.ents) {
      if (e.kind !== 'asteroid') continue;
      if (e.state !== 'towed') this.towed.delete(e.id);
      else if (!this.towed.has(e.id)) {
        this.towed.add(e.id);
        const tug = sim.alive(e.link);
        this.events.push({ t: sim.tick, k: REC.grapple, plane: 'orbit', side: tug ? sim.sideId(tug.side) : 'neutral' });
      }
    }
    while (this.nextSample < UNIT_SAMPLE_MINUTES.length && sim.tick >= toTicks(60 * UNIT_SAMPLE_MINUTES[this.nextSample]!)) {
      const units: UnitSample['units'] = perArmy(sim.armyIds, () => perPlane(() => 0));
      for (const e of sim.ents) if (e.unit && !e.dead && isArmy(e.side)) units[sim.armyIds[e.side]!]![e.plane]++;
      this.samples.push({ minute: UNIT_SAMPLE_MINUTES[this.nextSample]!, units });
      this.nextSample++;
    }
  }

  /** New game events of every army (an event sent to several armies is one object). Returns falls per side. */
  private collectEvents(): Map<Side, number> {
    const { falls } = this;
    falls.clear();
    for (const ev of this.pendingEvents) {
      this.lodes.event(ev);
      if (EVENTS_SKIPPED[ev.kind]) continue;
      const side = ev.side === undefined ? 'neutral' : this.sim.sideId(ev.side);
      this.events.push({
        t: ev.tick, k: ev.kind, plane: ev.plane, side, x: ev.x, y: ev.y,
        ...(ev.subject ? { subject: ev.subject } : {}),
        ...(ev.killer !== undefined && isArmy(ev.killer) ? { killer: this.sim.armyIds[ev.killer]! } : {}),
        ...((ev.by ?? ev.owner) ? { role: ev.by ?? ev.owner } : {}),
        ...(ev.owner ? { ownerRole: ev.owner } : {}),
        ...(ev.entry ? { entry: ev.entry } : {}),
        ...(ev.index === undefined ? {} : { index: ev.index }),
        ...(ev.from === undefined ? {} : { from: ev.from }),
      });
      if (ev.kind === 'fell_into_depths') falls.set(side, (falls.get(side) ?? 0) + 1);
    }
    this.pendingEvents.length = 0;
    return falls;
  }

  private collectFx(falls: Map<Side, number>): void {
    // References are captured at emission, before player event windows can truncate them.
    // Death provenance is filled on the same effect before this post-tick collection.
    for (const rec of this.pendingFx) {
      const f = rec.fx;
      const side = this.sim.sideId(f.side ?? rec.owner);
      switch (f.kind) {
        case 'death':
          if (f.side !== undefined && isArmy(f.side)) this.events.push({
            t: f.tick, k: REC.kill, plane: f.plane, side: this.sim.armyIds[f.side]!, x: f.x, y: f.y,
            ...(f.subject ? { subject: f.subject } : {}),
            by: rec.cause ?? 'unknown',
            ...(rec.killer !== undefined && isArmy(rec.killer) ? { killer: this.sim.armyIds[rec.killer]! as ArmyId } : {}),
            ...(rec.attackerPlane ? { attackerPlane: rec.attackerPlane } : {}),
            ...(rec.attackerKind ? { attackerKind: rec.attackerKind } : {}),
            alloyValue: rec.alloyValue ?? 0,
            energyValue: rec.energyValue ?? 0,
          });
          break;
        case 'scan':
        case 'deliver':
        case 'dig':
          this.events.push({ t: f.tick, k: REC[f.kind], plane: f.plane, side });
          break;
        case 'portal': {
          const fell = falls.get(side) ?? 0;
          if (f.plane === 'surface' && f.tp === 'depths' && fell > 0) falls.set(side, fell - 1);
          else this.events.push({ t: f.tick, k: REC.transfer, plane: f.plane, side, ...(f.subject ? { subject: f.subject } : {}), ...(f.tp ? { to: f.tp } : {}) });
          break;
        }
        default:
          if (!FX_HANDLED[f.kind]) this.events.push({ t: f.tick, k: `fx:${f.kind}`, plane: f.plane, side });
      }
    }
    this.pendingFx.length = 0;
  }

}
