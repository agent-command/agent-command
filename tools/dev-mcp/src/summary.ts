/** Compact text renderings of fogged army views and god views, sized for an LLM: summary first, details on request. */
import { hostileSide, PLANES, TICK_RATE, type ArmyId, type Entity, type GameEvent, type Kind, type MatchData, type Plane, type Side, type State, type View } from '@agent-command/game/contract';

const r1 = (n: number): number => Math.round(n * 10) / 10;

export function clock(tick: number): string {
  const s = Math.floor(tick / TICK_RATE);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `trooper 5, tank 1` (most first), or `-`. */
export function counts(m: Record<string, number> | undefined): string {
  const parts = Object.entries(m ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(', ') : '-';
}

function tally<T>(items: readonly T[], key: (t: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    if (k !== undefined) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function eventLine(ev: GameEvent): string {
  const who = [ev.subject, ev.side && ev.subject ? `(${ev.side})` : ev.side].filter(Boolean).join(' ');
  return `t${ev.tick} ${ev.plane} ${ev.kind}${who ? ` ${who}` : ''} @${r1(ev.x)},${r1(ev.y)}`;
}

/**
 * Side relation as the army sees it: own, hostile (another colour, DESIGN §15.6) or neutral. Without the static match
 * data (not received yet) every other army counts as hostile, which is exact in free-for-all.
 */
function relation(v: View, match: MatchData | undefined, side: Side): 'own' | 'hostile' | 'neutral' {
  if (side === v.army) return 'own';
  if (side === 'neutral') return 'neutral';
  return !match || hostileSide(match, v.army, side) ? 'hostile' : 'own';
}

/** Summary of an army's fogged view: outcome, resources, Spire, per-plane own/hostile counts, fights, queues, events. */
export function viewSummary(v: View, match: MatchData | undefined, events: readonly GameEvent[], plane?: Plane, eventCount = 8): string {
  const planes = plane ? [plane] : PLANES;
  const r = v.res;
  const lines = [
    `${v.army} view · tick ${v.tick} (${clock(v.tick)}) · ${v.outcome}${v.rank === undefined ? '' : ` · rank ${v.rank}`}${v.eliminated.length ? ` · eliminated ${v.eliminated.join(', ')}` : ''}`,
    `res alloy ${r.alloy} (+${r1(r.alloyRate)}/s) · energy ${r.energy} (+${r1(r.energyRate)}/s, solar ${r1(r.solarRate)}/s, cap ${r1(r.energyCap)}/s, bank ${r.energyBank}) · scan ${r.scanReadyAt <= v.tick ? 'ready' : `at t${r.scanReadyAt}`}`,
    `spire ${v.spire.map((s) => `${s.plane} ${s.hp}/${s.maxHp}`).join(' · ')}`,
    `seats ${v.seats.map((s) => `${s.role}:${s.controller}${s.mandate.directive.stance !== 'economy' ? `/${s.mandate.directive.stance}` : ''}`).join(' ')}`,
  ];
  for (const p of planes) {
    const here = v.entities.filter((e) => e.plane === p && e.kind !== 'spire');
    const own = tally(here, (e) => (relation(v, match, e.side) === 'own' ? e.kind : undefined));
    const hostile = tally(here, (e) => (relation(v, match, e.side) === 'hostile' ? e.kind : undefined));
    const neutral = tally(here, (e) => (e.side === 'neutral' ? e.kind : undefined));
    const fights = tally(
      v.fx.filter((f) => f.plane === p),
      (f) => f.kind,
    );
    const queue = v.queue
      .filter((q) => q.plane === p)
      .slice(0, 6)
      .map((q) => `${q.item}(${q.status}${q.status === 'building' ? ` ${Math.round(q.progress * 100)}%` : q.reason ? ` ${q.reason}` : ''})`);
    const ghosts = v.memory.filter((g) => g.plane === p).length;
    const parts = [`own ${counts(own)}`, `hostile ${counts(hostile)}`];
    if (Object.keys(neutral).length) parts.push(`neutral ${counts(neutral)}`);
    if (Object.keys(fights).length) parts.push(`fights ${counts(fights)}`);
    if (queue.length) parts.push(`queue ${queue.join(' ')}`);
    if (ghosts) parts.push(`ghosts ${ghosts}`);
    lines.push(`${p.padEnd(7)} ${parts.join(' | ')}`);
  }
  if (v.impacts.length) lines.push(`impacts ${v.impacts.map((i) => `${i.side}@${r1(i.x)},${r1(i.y)} t${i.tick}`).join(' · ')}`);
  if (v.charges.length) lines.push(`charges ${v.charges.map((c) => `${c.side}@${c.x},${c.y} t${c.tick}`).join(' · ')}`);
  if (v.tremors.length) lines.push(`tremors ${v.tremors.length}`);
  const recent = events.filter((e) => planes.includes(e.plane)).slice(-eventCount);
  lines.push(recent.length ? `events (last ${recent.length}):` : 'events: none yet');
  for (const ev of recent) lines.push(`  ${eventLine(ev)}`);
  return lines.join('\n');
}

export function entityLine(e: Entity): string {
  const extra: string[] = [];
  if (e.tx !== undefined && e.ty !== undefined) extra.push(`→${r1(e.tx)},${r1(e.ty)}`);
  if (e.carry) extra.push(`carry ${e.carry}`);
  if (e.link) extra.push(`link ${e.link}`);
  if (e.progress !== undefined) extra.push(`${Math.round(e.progress * 100)}%`);
  if (e.stance && e.stance !== 'aggressive') extra.push(e.stance);
  if (e.queue) extra.push(`+${e.queue} queued`);
  return `${e.id} ${e.side} ${e.kind} @${r1(e.x)},${r1(e.y)} hp ${e.hp}/${e.maxHp} ${e.state}${extra.length ? ` ${extra.join(' ')}` : ''}`;
}

/** Every entity the army can see, grouped by plane: own first, then hostile, then neutral. */
export function viewEntities(v: View, match: MatchData | undefined, plane?: Plane): string {
  const lines: string[] = [];
  const order = { own: 0, hostile: 1, neutral: 2 };
  const rank = (e: Entity): number => order[relation(v, match, e.side)];
  for (const p of plane ? [plane] : PLANES) {
    const here = v.entities.filter((e) => e.plane === p).sort((a, b) => rank(a) - rank(b) || a.kind.localeCompare(b.kind));
    lines.push(`${p} (${here.length})`);
    for (const e of here) lines.push(`  ${entityLine(e)}`);
  }
  return lines.join('\n');
}

/** GET /dev/matches/<roomId>/god (apps/server/src/dev-admin.ts). */
export interface GodView {
  roomId: string;
  tick: number;
  speed: number | 'realtime';
  result: 'running' | Partial<Record<ArmyId, { outcome: string; rank: number }>>;
  /** bearing (rad) of one lit sun wedge; the others are evenly spaced */
  sunAngle: number;
  armies: Partial<Record<ArmyId, GodArmy>>;
  fights: Record<string, Record<string, number>>;
  projectiles: number;
  charges: number;
  entities?: GodEntity[];
  events?: Record<string, GameEvent[]>;
}

export interface GodArmy {
  colour: string;
  /** Tick the army was eliminated (Spire fell or it forfeited). */
  eliminatedAt?: number;
  alloy: number;
  energy: number;
  alloyRate: number;
  solar: number;
  energyCap: number;
  energyBank: number;
  pop: number;
  spire: Record<string, string>;
  units: Record<string, Record<string, number>>;
  structures: Record<string, Record<string, number>>;
  stats: Record<string, number>;
}

export interface GodEntity {
  id: string;
  kind: Kind;
  side: Side;
  plane: Plane;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: State;
  order?: string;
  building?: number;
  link?: string;
}

export function godSummary(g: GodView, plane?: Plane): string {
  const planes = plane ? [plane] : PLANES;
  const result = g.result === 'running' ? 'running' : Object.entries(g.result).map(([id, r]) => `${id} ${r!.outcome} (rank ${r!.rank})`).join(', ');
  const lines = [`god · room ${g.roomId} · tick ${g.tick} (${clock(g.tick)}) · speed ${g.speed === 0 ? 'paused' : g.speed} · ${result} · sun ${Math.round((g.sunAngle * 180) / Math.PI)}°`];
  for (const [id, t] of Object.entries(g.armies)) {
    if (!t) continue;
    lines.push(
      `${id} (${t.colour}${t.eliminatedAt === undefined ? '' : `, eliminated t${t.eliminatedAt}`}) alloy ${t.alloy} (+${t.alloyRate}/s) · energy ${t.energy} (solar ${t.solar}/s, cap ${t.energyCap}/s, bank ${t.energyBank}) · pop ${t.pop} · spire ${Object.entries(t.spire)
        .map(([p, hp]) => `${p} ${hp}`)
        .join(' · ')}`,
    );
    for (const p of planes) {
      const s = t.structures[p];
      lines.push(`  ${p.padEnd(7)} units ${counts(t.units[p])}${s ? ` | structures ${counts(s)}` : ''}`);
    }
    lines.push(`  stats ${counts(t.stats)}`);
  }
  const fights = planes.filter((p) => g.fights[p]).map((p) => `${p} ${counts(g.fights[p])}`);
  lines.push(`fights ${fights.length ? fights.join(' | ') : '-'} · projectiles ${g.projectiles} · charges ${g.charges}`);
  return lines.join('\n');
}

export function godEntities(entities: readonly GodEntity[]): string {
  const lines: string[] = [];
  for (const p of PLANES) {
    const here = entities.filter((e) => e.plane === p).sort((a, b) => a.side.localeCompare(b.side) || a.kind.localeCompare(b.kind));
    if (!here.length) continue;
    lines.push(`${p} (${here.length})`);
    for (const e of here) {
      const extra = [e.order, e.building !== undefined ? `building ${Math.round(e.building * 100)}%` : undefined, e.link ? `link ${e.link}` : undefined].filter(Boolean);
      lines.push(`  ${e.id} ${e.side} ${e.kind} @${e.x},${e.y} hp ${e.hp}/${e.maxHp} ${e.state}${extra.length ? ` ${extra.join(' ')}` : ''}`);
    }
  }
  return lines.join('\n');
}
