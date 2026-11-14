// Agent Command's built-in bot library: packages/game/src/rules/deploy.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * Deploy stances: one generic mechanism for a unit that roots itself for a stronger posture (DESIGN §4.1 Warden shield
 * wall, §4.2 Surface wave 1). A unit kind names at most one stance on its STATS row (`deploy`); the `deploy` intent
 * turns it on or off. Every number is a match rule: the spec only names ECON keys.
 *
 * Invariants for every stance: a deploying, deployed or packing unit never moves (any move-type order packs it
 * first; `attack` and `stop` keep it deployed) and never fires during a transition. Phases and their timing are
 * public: anyone who sees the unit sees its state and transition progress.
 * Blocking shield bearers must finish separating from friendly shield bearers before starting a stance.
 */

export const DEPLOY_STANCES = ['walled', 'dug_in', 'siege', 'emplaced', 'unfurled'];



export const DEPLOY_SPECS = {
  walled: {
    plane: 'depths', enabled: 'wallEnabled', deployTicks: 'wallDeployTicks', packTicks: 'wallUndeployTicks',
    states: ['walling', 'walled', 'unwalling'], fires: true, damageTaken: 'wallDamageTaken', blocksCell: true,
    cover: { reach: 'wallCoverReach', damageTaken: 'wallCoverDamageTaken', range: 'wallCoverRange' },
  },
  dug_in: {
    plane: 'surface', enabled: 'digInEnabled', deployTicks: 'digInTicks', packTicks: 'digOutTicks',
    states: ['digging_in', 'dug_in', 'digging_out'], fires: true, damageTaken: 'dugInDamageTaken',
    damageFrom: ['rifle', 'cannon', 'turret'], vision: 'dugInVision', blocksCell: false,
  },
  siege: {
    plane: 'surface', enabled: 'siegeEnabled', deployTicks: 'siegeDeployTicks', packTicks: 'siegePackTicks',
    states: ['sieging', 'sieged', 'unsieging'], fires: true, blocksCell: false,
    range: { structures: 'siegeRangeStructures', units: 'siegeRangeUnits', spire: 'siegeSpireRange', min: 'siegeMinRange', indirect: true },
  },
  emplaced: {
    plane: 'surface', enabled: 'emplaceEnabled', deployTicks: 'emplaceTicks', packTicks: 'unemplaceTicks',
    states: ['emplacing', 'emplaced', 'unemplacing'], fires: true, blocksCell: false,
    range: { structures: 'emplacedFlakRange', units: 'emplacedFlakRange', indirect: false }, cooldown: 'emplacedFlakCooldown',
  },
  unfurled: {
    plane: 'orbit', deployTicks: 'solarDeployTicks', packTicks: 'solarPackTicks', auto: true,
    states: ['unfurling', 'unfurled', 'furling'], fires: false, blocksCell: false,
  },
};
