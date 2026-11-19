/** Package entry (`@agent-command/game`): the contract, the PlayerThree game definition, built-in bots and native metrics. */
export * from './rules/contract.ts';
export { diggerCarryMax } from './rules/economy.ts';
export { manifest, STRATEGY_SKILL, type AgentCommandManifest } from './agent/manifest.ts';
export { lobbySummary, type LobbySummaryInput } from './agent/lobby-summary.ts';
export { AgentCommandGame, createGame, definition, matchArmies, type AgentCommandSeat } from './agent/adapter.ts';
export { createBot } from './bots/bots.ts';
export { personalityTraits } from './bots/tuning.ts';
export { botVersion } from './bots/packages.ts';
export { BOT_PERIOD, playBotMatch, type BotMatchOptions, type BotMatchResult } from './bots/play.ts';
export type { AgentCommandIntent } from './agent/intents.ts';
export {
  createMetrics, measurementsFromMetrics, metricDefinitions, eventDefinitions,
  type ArenaMetricRecorder, type IntentAccounting, type NativeRows, type MetricDefinition,
} from './metrics/metrics.ts';
export { actionOf, CROSS, perArmy, summarize, type MatchMeasurements, type PerArmy } from './metrics/summary.ts';
export { Recorder } from './metrics/record.ts';
export { isFlank, LodeRecorder, type LodeMetrics, type LodeSideMetrics } from './metrics/lodes.ts';
export { DAMAGE_ORIGINS, REC, SAPPER_FIELDS, type DamageOrigin, type MatchTrace, type SapperMetrics, type SpireDamage, type TraceEvent, type UnitSample } from './metrics/trace.ts';
/** Host-side boundary: the sim's numeric armies (`Sim.armyIds`, `Sim.armyIndex`, `Sim.sideId` name them for the contract). */
export { NEUTRAL, type Army } from './util/teams.ts';
