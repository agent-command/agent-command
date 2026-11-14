/**
 * Agent Command — the shared contract between simulation, server, web client and agents (`@agent-command/game/contract`).
 * Everything that crosses the network is described in the rules/ leaf modules with PlayerThree's closed-vocabulary
 * schemas; this barrel only re-exports them (plus the payload table and the team helpers from util/teams.ts). Modules
 * a leaf imports (maps/document, maps/registry and theirs, util/) must import the leaves, never this barrel, so no
 * runtime import cycle runs through it. rules/schema-fields.ts is internal and not re-exported. The schema-free leaves
 * (vocabulary, terrain, econ, stats, deploy, upgrades, sun, rule-tables, observation-core, opponents, derelict) are
 * what the built-in bot packages bundle: bots import those leaves, never this barrel (bots/build.ts).
 */
export * from './vocabulary.ts';
export * from './terrain.ts';
export * from './econ.ts';
export * from './stats.ts';
export * from './deploy.ts';
export * from './upgrades.ts';
export * from './sun.ts';
export * from './rule-tables.ts';
export * from './match-rules.ts';
export * from './observation-core.ts';
export * from './observation.ts';
export * from './opponents.ts';
export * from './bot-options.ts';
export * from './intents.ts';
export * from './signals.ts';
export * from './derelict.ts';
export { PAYLOADS, resolvePayloads, resolveRocks, type PayloadDrop, type PayloadKind, type ResolvedPayloadDrop, type ResolvedRock } from './payload.ts';
export {
  isArmyId, isArmySide, frameOf, armyIdOfSlot, slotOfArmyId, slotArmyIds, hostileSide,
  rotX, rotY, canonX, canonY, rotVX, rotVY, canonVX, canonVY, rotCell, canonCell, QUARTER_TURN,
} from '../util/teams.ts';
