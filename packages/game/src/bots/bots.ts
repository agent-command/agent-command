/**
 * Built-in commanders in-process: `GameDefinition.createBot`, the fallback PlayerThree's bot-package contract keeps
 * (spec §11 *Bot packages*): a seat whose package is stale for the surface, fails to load or hangs gets this bot.
 * Every bot seat otherwise plays its tier's package (bots/packages.ts), the same code bundled (bots/policy.ts).
 * They see exactly the fogged observation an agent sees and act only through intents.
 */
import type { BotCommander } from 'playerthree';
import { resolveBotOptions, type ArmyId, type Opponent, type Plane } from '../rules/contract.ts';
import type { AgentCommandIntent } from '../agent/intents.ts';
import type { AgentCommandManifest } from '../agent/manifest.ts';
import type { PlaneBotClass } from './policy.ts';
import { botTier } from './tuning.ts';
import { DepthsBot } from './depths.ts';
import { SurfaceBot } from './surface.ts';
import { SkyBot } from './sky.ts';
import { OrbitBot } from './orbit.ts';

/** Each plane's bot class (a plane's package bundles only its own: bots/build.ts). */
const PLANE_BOTS: Readonly<Record<Plane, PlaneBotClass>> = { depths: DepthsBot, surface: SurfaceBot, sky: SkyBot, orbit: OrbitBot };

class IdleBot implements BotCommander<AgentCommandManifest> {
  think(): AgentCommandIntent[] {
    return [];
  }
}

export function createBot(army: ArmyId, role: Plane, opponent: Opponent, options: unknown = {}): BotCommander<AgentCommandManifest> {
  const resolved = resolveBotOptions(opponent, options);
  if (opponent === 'idle') return new IdleBot();
  return new PLANE_BOTS[role](army, botTier(opponent, resolved));
}
