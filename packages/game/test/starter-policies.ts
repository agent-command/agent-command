/**
 * Each plane's starter (skill `policies/<plane>.js`) as a by-reference deploy builds it (`policy_deploy {from, knobs}`):
 * PlayerThree's generated entry over the starter, bundled into one script with the policy ABI's globals.
 */
import { buildStarter, parseStarterRef, starterCatalog } from 'playerthree/policy';
import { manifest, STARTERS, STRATEGY_SKILL } from '../src/agent/manifest.ts';
import { PLANES, type Plane } from '../src/rules/contract.ts';
import { starterKnobs } from '../src/bots/starter.ts';

const catalog = starterCatalog(manifest);

/** The starter for `plane` built with `knobs` (null: its defaults), validated against its knobs schema. */
export async function starterScript(plane: Plane, knobs: Readonly<Record<string, unknown>> | null = null): Promise<string> {
  const built = await buildStarter(parseStarterRef(catalog, STARTERS[plane], knobs ?? undefined, plane), [STRATEGY_SKILL]);
  if (!built.ok) throw new Error(`${plane} starter does not build: ${built.message} (${built.location.file}:${built.location.line})`);
  return built.code;
}

export const STARTER_POLICIES: Readonly<Record<Plane, string>> = Object.fromEntries(await Promise.all(PLANES.map(async (plane) => [plane, await starterScript(plane)] as const))) as Record<Plane, string>;

/**
 * Depths knobs for fixtures that check one decision rather than the sandbox work bounds: a fresh instance's first call
 * decides (prepareAhead off; on, that call only builds the next decision's worker-route fields).
 */
export const DECIDE_FIRST = { prepareAhead: false } as const;
/** DECIDE_FIRST, and every planner searches afresh each decision (routeSearches at the top of its range, no routeReuse), as the built-in tiers do. */
export const UNBOUNDED = { ...DECIDE_FIRST, routeSearches: 16, routeReuse: 0 } as const;
/**
 * Sandbox CPU per call (ms) for tests of what a starter does, not what it costs: generous, so their behaviour never
 * depends on a loaded machine's timing (a call over its budget kills the instance and its state). The real budget,
 * manifest.control.policy.msPerCall, is asserted once, least of several runs (depths-starter-budget.test.ts).
 */
export const FUNCTIONAL_TEST_MS_PER_CALL = 200;
/** The manifest's policy limits with FUNCTIONAL_TEST_MS_PER_CALL. */
export const FUNCTIONAL_LIMITS = { ...manifest.control.policy, msPerCall: FUNCTIONAL_TEST_MS_PER_CALL };
/** Each plane's starter deciding on a fresh instance's first call: the Depths one built with DECIDE_FIRST, the others as they are. */
export const DECIDING_STARTERS: Readonly<Record<Plane, string>> = { ...STARTER_POLICIES, depths: await starterScript('depths', DECIDE_FIRST) };

/** The default of `plane`'s starter knob `name` (its knobs schema). */
export const knobDefault = (plane: Plane, name: string): number => (starterKnobs(plane).properties as Record<string, { default: number }>)[name]!.default;
/** A starter's default ticks between decisions: a call sooner than that after a decision decides nothing. */
export const periodOf = (plane: Plane): number => knobDefault(plane, 'period');
