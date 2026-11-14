/**
 * Team signals through the PlayerThree host, mirrored for both duel armies: a request reaches only its target teammate,
 * the enemy never sees any of it, the match rules can turn it off, and replays reproduce the boards.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPlayerThreeHost, replayMatch } from 'playerthree/host';
import type { PlayerThreeHost, SignalEntry } from 'playerthree';
import { definition } from '../src/agent/adapter.ts';
import type { AgentCommandManifest } from '../src/agent/manifest.ts';
import { DEFAULT_RULES, PLANES, type ArmyId, type MatchOptions, type Plane } from '../src/rules/contract.ts';

const DUEL = ['nw', 'se'] as const;
const enemyOf = (army: ArmyId): ArmyId => (army === 'nw' ? 'se' : 'nw');
/** A duel's armies are point mirrors: tile (x, y) of one is (size − 1 − x, size − 1 − y) of the other. */
const mirror = (army: ArmyId, x: number, y: number, size: number) => (army === 'nw' ? { x, y } : { x: size - 1 - x, y: size - 1 - y });

let host: PlayerThreeHost<AgentCommandManifest> | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
});

/** Every seat an agent (nothing else acts), so only the test's signals exist. */
function agentMatch(options?: MatchOptions) {
  host = createPlayerThreeHost({ definition });
  const agents: Record<Plane, 'agent'> = { depths: 'agent', surface: 'agent', sky: 'agent', orbit: 'agent' };
  const controllers = { nw: agents, se: agents };
  const match = host.createMatch({ seed: 4, realtime: false, teams: [...DUEL], controllers, ...(options ? { options } : {}) });
  const seat = (army: ArmyId, plane: Plane) => host!.agentSession(match.mintSeatToken(army, plane))!.control;
  return { match, seat };
}

type Slice = { inbox: SignalEntry[]; sent: SignalEntry[] };
const slice = async (control: { observe(): Promise<unknown> }): Promise<Slice> => ((await control.observe()) as { signals: Slice }).signals;

describe('team signals in Agent Command (host)', () => {
  for (const army of DUEL) {
    it(`${army}: a Depths troop request reaches only its Surface, never the enemy`, async () => {
      const { match, seat } = agentMatch();
      const at = mirror(army, 20, 22, DEFAULT_RULES.map.size);
      const depths = seat(army, 'depths');
      expect(await depths.act([{ kind: 'signal', signal: { kind: 'request_support', to: 'surface', need: 'troops', count: 4, ...at } }])).toEqual([{ ok: true }]);
      const want = { kind: 'request_support', id: 'sg_1', from: 'depths', to: 'surface', need: 'troops', count: 4, ...at, state: 'submitted' };
      expect((await slice(seat(army, 'surface'))).inbox).toMatchObject([want]);
      expect((await slice(depths)).sent).toMatchObject([want]);
      for (const plane of ['sky', 'orbit'] as const) expect((await slice(seat(army, plane))).inbox).toEqual([]);
      // The enemy: no observation, view or wait shows it.
      const enemy = enemyOf(army);
      for (const plane of PLANES) {
        const s = await slice(seat(enemy, plane));
        expect(s).toEqual({ inbox: [], sent: [] });
      }
      expect((match.view(enemy) as { signals: unknown[] }).signals).toEqual([]);
      expect((match.view(army) as { signals: unknown[] }).signals).toHaveLength(1);
      // Asking a plane that cannot help is refused; the Surface answers.
      expect(await depths.act([{ kind: 'signal', signal: { kind: 'request_support', to: 'orbit', need: 'troops' } }])).toEqual([{ ok: false, code: 'signal', signalCode: 'unsupported' }]);
      expect(await seat(army, 'surface').act([{ kind: 'signal_update', id: 'sg_1', update: 'ack' }])).toEqual([{ ok: true }]);
      expect((await slice(depths)).sent[0]).toMatchObject({ state: 'working', by: 'surface' });
      // The enemy cannot touch it either: its board has no such id.
      expect(await seat(enemy, 'surface').act([{ kind: 'signal_update', id: 'sg_1', update: 'decline' }])).toEqual([{ ok: false, code: 'signal', signalCode: 'unknown_signal' }]);
    });

    it(`${army}: a team-wide troop request reaches both troop planes and the first ack takes it`, async () => {
      const { seat } = agentMatch();
      await seat(army, 'sky').act([{ kind: 'signal', signal: { kind: 'request_support', to: 'team', need: 'troops', x: 30, y: 30 } }]);
      expect((await slice(seat(army, 'surface'))).inbox).toHaveLength(1);
      expect((await slice(seat(army, 'depths'))).inbox).toHaveLength(1);
      expect((await slice(seat(army, 'orbit'))).inbox).toEqual([]);
      expect(await seat(army, 'depths').act([{ kind: 'signal_update', id: 'sg_1', update: 'ack' }])).toEqual([{ ok: true }]);
      expect(await seat(army, 'surface').act([{ kind: 'signal_update', id: 'sg_1', update: 'ack' }])).toEqual([{ ok: false, code: 'signal', signalCode: 'not_recipient' }]);
    });
  }

  it('wakes the target agent; the wait carries its slice', async () => {
    const { seat } = agentMatch();
    const orbit = seat('nw', 'orbit');
    const waiting = orbit.wait({ seconds: 30 });
    await seat('nw', 'surface').act([{ kind: 'signal', signal: { kind: 'request_support', to: 'orbit', need: 'scan', x: 30, y: 30 } }]);
    expect(await waiting).toMatchObject({ wake: 'signal', signals: { inbox: [{ need: 'scan', from: 'surface' }] } });
  });

  it('the signals match rules narrow the limits or turn signals off', async () => {
    const off = agentMatch({ signals: { enabled: false } });
    expect(await off.seat('nw', 'depths').act([{ kind: 'signal', signal: { kind: 'request_support', to: 'surface', need: 'troops' } }])).toEqual([{ ok: false, code: 'signal', signalCode: 'disabled' }]);
    host!.dispose();
    const narrow = agentMatch({ signals: { maxOpen: 1 } });
    const ask = { kind: 'signal', signal: { kind: 'request_support', to: 'orbit', need: 'scan' } };
    expect(await narrow.seat('nw', 'sky').act([ask, ask])).toEqual([{ ok: true }, { ok: false, code: 'signal', signalCode: 'too_many_open' }]);
  });

  it('replays reproduce both armies\' boards', async () => {
    const { match, seat } = agentMatch();
    for (const army of DUEL) {
      await seat(army, 'orbit').act([{ kind: 'signal', signal: { kind: 'request_support', to: 'sky', need: 'air_cover', count: 3, x: 10, y: 10 } }]);
      await seat(army, 'sky').act([{ kind: 'signal_update', id: 'sg_1', update: 'ack' }]);
    }
    await match.step(5);
    await seat('se', 'sky').act([{ kind: 'signal_update', id: 'sg_1', update: 'done' }]);
    await match.step(5);
    const replay = JSON.parse(JSON.stringify(match.replay()));
    const result = replayMatch(definition, replay);
    for (const army of DUEL) expect(result.signals!.team(army)).toEqual((match.view(army) as { signals: unknown }).signals);
    expect(result.signals!.team('se')[0]!.state).toBe('completed');
    expect(result.signals!.team('nw')[0]!.state).toBe('working');
  });
});
