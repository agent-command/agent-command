// Agent Command — DEPTHS skeleton: the economy only. It keeps a digging crew and sends idle diggers to mine (the
// `auto_mine` macro hauls ore to the root). No Wardens, sappers, bulkheads, rails, tunnels or research: no army and no
// attack. A starting point to write your own policy on, not a bot; it loses to every built-in tier.
// Deploy it by reference: policy_deploy {"from":"agent-command-strategy/policies/skeleton/depths.js"}. To grow it, copy it
// into your policy modules (policies.md, "Skeletons"). The built-in Depths bot's source, policies/game/bots/depths.js,
// shows how the bots plan everything this leaves out.

/** Diggers to keep (the built-in tiers keep 5 to 10). */
const CREW = 8;

const alive = (obs, plane) => obs.spire.some((s) => s.plane === plane && s.hp > 0);

export function createPolicy() {
  return {
    think(obs) {
      if (obs.outcome !== 'running') return [];
      const out = [];
      const diggers = obs.entities.filter((e) => e.side === obs.army && e.kind === 'digger' && e.plane === 'depths' && e.hp > 0);
      // One digger in the queue at a time: it saves up at the head of the Depths lane until it is paid.
      const queued = obs.queue.some((q) => q.item === 'digger');
      if (!queued && diggers.length < CREW && alive(obs, 'depths')) out.push({ kind: 'queue_add', item: 'digger' });
      if (diggers.some((d) => d.state === 'idle')) out.push({ kind: 'macro', action: 'auto_mine' });
      return out;
    },
  };
}
