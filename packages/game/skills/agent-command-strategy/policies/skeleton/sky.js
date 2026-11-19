// Agent Command — SKY skeleton: the economy only, and the Sky has no economy chore it can run without aircraft at work
// (Relays need a captured island), so it gives no orders: the starting interceptors hold at home, where idle ones
// still shoot down rocks falling on the base. No production, captures, island structures, bombing or storms. A
// starting point to write your own policy on, not a bot; it loses to every built-in tier.
// Deploy it by reference: policy_deploy {"from":"agent-command-strategy/policies/skeleton/sky.js"}. To grow it, copy it
// into your policy modules (policies.md, "Skeletons"). The built-in Sky bot's source, policies/game/bots/sky.js, shows
// how the bots plan everything this leaves out.

export function createPolicy() {
  return {
    think() {
      return [];
    },
  };
}
