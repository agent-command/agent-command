/**
 * One live Colyseus connection to a match, exactly like the web client's: an army owner (its fogged view, owner
 * control plane, chat replies) or a spectator (every army's fogged view). Keeps the latest view per army, its static
 * match data (colours, for hostility) and a rolling event log so summaries can show what happened between calls.
 */
import { Client, type Room } from '@colyseus/sdk';
import { applyView, MSG, type ViewMessage, type ViewState } from 'playerthree/protocol';
import type { SeatInfo } from 'playerthree';
import type { ArmyId, GameEvent, MatchData, View } from '@agent-command/game/contract';

export type Viewer = ArmyId | 'spectator';

const EVENT_LOG = 300;
const REQUEST_MS = 15_000;

type ResultMsg = { op: 'result'; seq: number; ok: true; data: unknown } | { op: 'result'; seq: number; ok: false; code: string };

export interface SaidLine {
  role: string;
  tick: number;
  text: string;
}

export class Watch {
  readonly viewer: Viewer;
  readonly room: Room;
  readonly views = new Map<ArmyId, View>();
  /** Each army's static match data, sent once with its first view. */
  readonly matchData = new Map<ArmyId, MatchData>();
  readonly events = new Map<ArmyId, GameEvent[]>();
  readonly said: SaidLine[] = [];
  seats: SeatInfo[] = [];
  left: number | undefined;
  #seq = 1;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  readonly #seen = new Map<ArmyId, Set<string>>();
  readonly #viewWaiters = new Set<() => void>();
  /** Each team's view stream as rebuilt from keyframes and deltas. */
  readonly #streams = new Map<string, ViewState>();

  private constructor(room: Room, viewer: Viewer) {
    this.room = room;
    this.viewer = viewer;
    room.onMessage(MSG.result, (m: ResultMsg) => {
      const p = this.#pending.get(m.seq);
      if (!p) return;
      this.#pending.delete(m.seq);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data);
      else p.reject(new Error(m.code));
    });
    room.onMessage(MSG.view, (m: ViewMessage) => {
      const next = applyView(this.#streams.get(m.team), m);
      if (!next) {
        // A delta without its base is a protocol error: drop the connection rather than show a wrong view.
        this.left = 4002;
        void this.room.leave();
        return;
      }
      this.#streams.set(m.team, next);
      this.#onView(next.view as View);
    });
    room.onMessage(MSG.seats, (m: { seats: SeatInfo[] }) => {
      this.seats = m.seats;
    });
    room.onMessage(MSG.said, (m: SaidLine) => {
      this.said.push({ role: m.role, tick: m.tick, text: m.text });
      if (this.said.length > 100) this.said.shift();
    });
    room.onMessage(MSG.report, () => {});
    room.onMessage(MSG.obs, () => {});
    room.onLeave((code: number) => {
      this.left = code;
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('disconnected'));
      }
      this.#pending.clear();
    });
  }

  static async open(url: string, roomId: string, token: string, viewer: Viewer): Promise<Watch> {
    const room = await new Client(url).joinById(roomId, { token });
    return new Watch(room, viewer);
  }

  get alive(): boolean {
    return this.left === undefined;
  }

  #onView(v: View): void {
    this.views.set(v.army, v);
    if (v.match) this.matchData.set(v.army, v.match);
    const seen = this.#seen.get(v.army) ?? new Set<string>();
    this.#seen.set(v.army, seen);
    const log = this.events.get(v.army) ?? [];
    this.events.set(v.army, log);
    for (const ev of v.events) {
      const key = `${ev.tick}|${ev.kind}|${ev.plane}|${ev.x}|${ev.y}|${ev.subject ?? ''}|${ev.side ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      log.push(ev);
    }
    if (log.length > EVENT_LOG) log.splice(0, log.length - EVENT_LOG);
    if (seen.size > EVENT_LOG * 4) for (const k of [...seen].slice(0, seen.size - EVENT_LOG * 2)) seen.delete(k);
    for (const w of this.#viewWaiters) w();
  }

  /** The latest view of `army`, waiting up to `ms` for the first one (sent on join). */
  async view(army: ArmyId, ms = 5000): Promise<View | undefined> {
    const end = Date.now() + ms;
    while (!this.views.has(army) && this.alive && Date.now() < end) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, end - Date.now());
      this.#viewWaiters.add(resolve);
      await promise;
      clearTimeout(timer);
      this.#viewWaiters.delete(resolve);
    }
    return this.views.get(army);
  }

  /** Control-plane request (`playerthree:call|controller|mandate|resolveApproval|mint|tell`); resolves with the result data. */
  request(type: string, body: Record<string, unknown>): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error('disconnected'));
    const seq = this.#seq++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(seq);
      reject(new Error('timeout'));
    }, REQUEST_MS);
    this.#pending.set(seq, { resolve, reject, timer });
    this.room.send(type, { ...body, seq });
    return promise;
  }

  close(): void {
    if (this.alive) void this.room.leave(true);
  }
}
