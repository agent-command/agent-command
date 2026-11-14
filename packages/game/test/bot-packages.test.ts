/**
 * The built-in bots as policy packages (pnpm bots:build, bots/build.ts): the committed bot library is the bots' current
 * source, every plane × level has a package for the current surface, and one recorded match per plane plays exactly
 * the recorded decisions both through the packages (PlayerThree's trusted runner, as every bot seat plays) and
 * in-process (`createBot`, PlayerThree's fallback). The full gate is test/bot-parity.ts.
 *
 * A bot change moves the recorded traces: check the parity gate, then replace the hashes with the ones reported here.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { surfaceHash, type BotCommander } from 'playerthree';
import { seatBot, type SeatBot } from 'playerthree/host';
import { describe, expect, it } from 'vitest';
import { definition } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import type { AgentCommandManifest } from '../src/agent/manifest.ts';
import { BOT_LIBRARY_DIR, botLibrary } from '../src/bots/library.ts';
import { BOT_LEVELS } from '../src/bots/packages.ts';
import { playBotMatch, type BotMatchOptions } from '../src/bots/play.ts';
import { PLANES, type ArmyId, type Plane } from '../src/rules/contract.ts';
import { exactJson } from './bot-trace.ts';

const SKILL = new URL('../skills/agent-command-strategy/', import.meta.url);
/** Match length of a recorded trace: past the openings, into the first fights. */
const TICKS = 3000;
/** One recorded standard vs standard match per plane: its seed and the sha256 of the plane's decision trace. */
const TRACES: Readonly<Record<Plane, { seed: number; hash: string }>> = {
  surface: { seed: 1, hash: '42d67972e8ca63799ead9174b5faeba41c30c4298c2e1ce55c9d12dc235eca8f' },
  sky: { seed: 2, hash: '84661eb78ef276b603e62fd9c87e0f16d0de7de8d0bd8723b914455521612d32' },
  orbit: { seed: 3, hash: '1f9081eefeb50902dfee83b4a5fdc6d35492d530dbe50274e0115b3a41709ce6' },
  depths: { seed: 4, hash: '1825dce97e8e24971245d3894c8ae02a796a7237b16bdd85f8b13154ea4d5fd2' },
};

type Make = (team: ArmyId, role: Plane) => BotCommander<AgentCommandManifest>;

/** sha256 of `plane`'s decisions (every think answer of its seats, in seat order each round) and the final state. */
function trace(plane: Plane, seed: number, make: Make): string {
  const levels = { nw: 'standard', se: 'standard' } as const;
  const seats: NonNullable<BotMatchOptions['seats']> = {};
  for (const team of ['nw', 'se'] as const) seats[team] = Object.fromEntries(PLANES.map((role) => [role, make(team, role)]));
  const hash = createHash('sha256');
  const { game } = playBotMatch({
    seed, levels, maxTicks: TICKS, seats,
    onDecision: (g, seat, intents) => { if (seat.role === plane) hash.update(`${g.tick} ${seat.team} ${exactJson(intents)}\n`); },
  });
  return hash.update(game.stateHash()).digest('hex');
}

describe('built-in bot packages', () => {
  it('serve the bots\' current source as the strategy skill\'s bot library', () => {
    const library = botLibrary();
    const committed = readdirSync(new URL(BOT_LIBRARY_DIR, SKILL), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => `${e.parentPath.slice(new URL(SKILL).pathname.length)}/${e.name}`).sort();
    expect(committed, 'run pnpm bots:build and commit the skill').toEqual([...library.files.keys()]);
    for (const [path, text] of library.files) expect(readFileSync(new URL(path, SKILL), 'utf8'), `${path}: run pnpm bots:build`).toBe(text);
  });

  it('are built for the current surface', () => {
    const surface = surfaceHash(definition.manifest);
    for (const level of BOT_LEVELS) {
      for (const role of PLANES) expect(definition.botPackages?.(level, role)?.surfaceHash, `${level}/${role}: run pnpm bots:build`).toBe(surface);
    }
  });

  // Two 3000-tick matches each: the timing lane's long full-match cases (pnpm test:timing, nightly).
  for (const plane of PLANES) {
    const { seed, hash } = TRACES[plane];
    it(`${plane} seed ${seed}: the packages and the in-process bots play the recorded decisions`, { tags: ['timing'], timeout: 600_000 }, () => {
      const packaged = trace(plane, seed, (team, role) => {
        const bot = seatBot(definition, { team, role }, 'standard', undefined, seed);
        // playBotMatch disposes every seat at the end.
        const seat: BotCommander<AgentCommandManifest> & Pick<SeatBot, 'dispose'> = {
          init: (d) => { bot.init?.(d); if (bot.packageHash === undefined) throw new Error(`${team}/${role}: no current package`); },
          think: (o) => bot.think(o) as AgentCommandIntent[],
          dispose: () => bot.dispose?.(),
        };
        return seat;
      });
      const inProcess = trace(plane, seed, (team, role) => definition.createBot({ team, role }, 'standard'));
      expect(packaged).toBe(inProcess);
      expect(packaged).toBe(hash);
    });
  }
});
