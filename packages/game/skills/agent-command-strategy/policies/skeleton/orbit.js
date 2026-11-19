// Agent Command — ORBIT skeleton: the economy only. It fills the home solar berths (five arrays fill the base energy
// delivery cap, economy.md), spreads new arrays to unshaded berths (`spread_arrays`) and sends idle tugs mining
// (`auto_mine`). No warships, scans, rock drops, derelict runs or research: no army and no attack. A starting point to
// write your own policy on, not a bot; it loses to every built-in tier.
// Deploy it by reference: policy_deploy {"from":"agent-command-strategy/policies/skeleton/orbit.js"}. To grow it, copy it
// into your policy modules (policies.md, "Skeletons"). The built-in Orbit bot's source, policies/game/bots/orbit.js,
// shows how the bots plan everything this leaves out.

/** Solar arrays to keep: the five home berths. */
const ARRAYS = 5;
/** Mining tugs to keep. */
const TUGS = 2;

const alive = (obs, plane) => obs.spire.some((s) => s.plane === plane && s.hp > 0);

export function createPolicy() {
  let arrays = -1;
  return {
    think(obs) {
      if (obs.outcome !== 'running') return [];
      const out = [];
      const own = (kind) => obs.entities.filter((e) => e.side === obs.army && e.kind === kind && e.plane === 'orbit' && e.hp > 0);
      const queued = (item) => obs.queue.filter((q) => q.item === item).length;
      const solars = own('solar');
      const tugs = own('tug');
      // One Orbit entry in the queue at a time: it saves up at the head of the Orbit lane until it is paid.
      if (alive(obs, 'orbit') && !obs.queue.some((q) => q.by === obs.role)) {
        if (solars.length + queued('solar') < ARRAYS) out.push({ kind: 'queue_add', item: 'solar' });
        else if (tugs.length + queued('tug') < TUGS) out.push({ kind: 'queue_add', item: 'tug' });
      }
      // A new (or lost) array: re-spread them all; the macro keeps the productive ones where they are.
      if (solars.length !== arrays) {
        arrays = solars.length;
        out.push({ kind: 'macro', action: 'spread_arrays' });
      }
      if (tugs.some((t) => t.state === 'idle' && !t.miningAssigned)) out.push({ kind: 'macro', action: 'auto_mine' });
      return out;
    },
  };
}
