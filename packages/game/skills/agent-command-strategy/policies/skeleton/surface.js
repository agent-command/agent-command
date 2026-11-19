// Agent Command — SURFACE skeleton: the economy only, and the Surface has no economy chore of its own to run (alloy is
// mined below, energy collected in Orbit), so it gives no orders: the starting army stands at home and fights only what
// comes into range. No production, Shafts, Headframes, posts or attacks. A starting point to write your own policy on,
// not a bot; it loses to every built-in tier.
// Deploy it by reference: policy_deploy {"from":"agent-command-strategy/policies/skeleton/surface.js"}. To grow it, copy
// it into your policy modules (policies.md, "Skeletons"). The built-in Surface bot's source,
// policies/game/bots/surface.js, shows how the bots plan everything this leaves out.

export function createPolicy() {
  return {
    think() {
      return [];
    },
  };
}
