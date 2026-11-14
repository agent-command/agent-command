/** Full three-terrain balance acceptance config for the same CLI as the LLM benchmark. */
import { DEFAULT_TIME_CAP_TICKS } from '../packages/game/src/rules/contract.ts';
import { balanceConfigs } from '../tools/balance/src/bench.ts';
import { standardPlan } from '../tools/balance/src/spec.ts';

export default balanceConfigs(standardPlan({
  seeds: 24,
  probeSeeds: 10,
  probeLevels: ['standard', 'veteran'],
  terrains: ['open', 'ridges', 'canyons'],
}), DEFAULT_TIME_CAP_TICKS + 1);
