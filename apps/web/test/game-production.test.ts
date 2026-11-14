// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntentAck, SeatInfo } from 'playerthree';
import { PLANES, type Plane, type UnitKind } from '@agent-command/game/contract';
import { Sim } from '../../../packages/game/src/sim/sim.ts';
import { applyIntent, simIntent, type GameIntent } from '../../../packages/game/src/agent/intents.ts';
import { view as gameView } from '../../../packages/game/src/agent/present.ts';
import { Game } from '../src/game.ts';
import { CommandCard } from '../src/command-card.ts';
import { ProductionTabs } from '../src/production-tabs.ts';
import { matchView, type MatchView } from '../src/match-view.ts';
import { KIND_LABEL } from '../src/text.ts';
import type { ConnectionEvents } from '../src/net.ts';

const UNITS = { surface: 'tank', sky: 'interceptor', orbit: 'tug', depths: 'sapper' } satisfies Record<Plane, UnitKind>;

/** Exercise the real Game methods without constructing a renderer or its input listeners. */
interface ProductionGame {
  view: MatchView;
  world: { rig: { focus: Plane } };
  seats: SeatInfo[];
  opts: { readOnly: boolean };
  controls: { selectedTracks(): []; cardActions(): []; armed: undefined };
  conn: { canAct(role: Plane): boolean; act(role: Plane, intents: GameIntent[]): Promise<IntentAck[]> };
  el: Record<'planeTitle' | 'sel' | 'prod' | 'macros' | 'selCol' | 'toasts', HTMLElement>;
  commandCard: CommandCard;
  productionTabs: ProductionTabs;
  renderCard(): void;
  cmdProduce(unit: UnitKind, count: number): void;
  act(role: Plane, intents: GameIntent[]): Promise<boolean>;
}

const cards: CommandCard[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const card of cards.splice(0)) card.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function fixture(roles: readonly Plane[]) {
  const sim = new Sim(31, { terrain: 'open', sky: { stormSets: 0 } });
  sim.armies[0]!.alloy = 10_000;
  sim.armies[0]!.energy = 10_000;
  const view = matchView({ ...gameView(sim, 'nw'), signals: [] });
  if (!view) throw new Error('Simulation must supply its public match bootstrap');
  const allowed = new Set(roles);
  const sent: { role: Plane; intent: GameIntent; ack: IntentAck }[] = [];
  const game: ProductionGame = Object.create(Game.prototype);
  game.view = view;
  game.world = { rig: { focus: 'surface' } };
  game.seats = [];
  game.opts = { readOnly: false };
  game.controls = { selectedTracks: () => [], cardActions: () => [], armed: undefined };
  game.conn = {
    canAct: (role) => allowed.has(role),
    async act(role, intents) {
      // Model only the authenticated role boundary; the real simulator decides every game acknowledgement (on nw's
      // entity names, as the view carries them).
      if (!allowed.has(role)) throw new Error(`No acting credential for ${role}`);
      return intents.map((intent): IntentAck => {
        const result = applyIntent(sim, 0, role, simIntent(sim, 0, intent), 'owner', [...allowed]);
        const ack: IntentAck = result.ok ? result : { ok: false, code: 'game', gameCode: result.code };
        sent.push({ role, intent, ack });
        return ack;
      });
    },
  };
  game.el = {
    planeTitle: document.createElement('div'), sel: document.createElement('div'),
    prod: document.createElement('div'), macros: document.createElement('div'),
    selCol: document.createElement('div'), toasts: document.createElement('div'),
  };
  game.commandCard = new CommandCard();
  cards.push(game.commandCard);
  game.productionTabs = new ProductionTabs(() => game.renderCard());
  document.body.append(...Object.values(game.el), game.commandCard.el, game.productionTabs.el);
  const authorityChanged: NonNullable<ConnectionEvents['authorityChanged']> = () => game.renderCard();
  const button = (role: Plane): HTMLButtonElement => {
    const found = game.el.prod.querySelector<HTMLButtonElement>(`[aria-label="Produce ${KIND_LABEL[UNITS[role]]}"]`);
    if (!found) throw new Error(`Missing ${role} production button`);
    return found;
  };
  return { sim, game, allowed, sent, button, authorityChanged };
}

// Click handlers launch Game.act asynchronously, including the success toast after its acknowledgement.
async function settleProduction(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

describe('Game production with numeric wire rules', () => {
  it('renders and queues a real unit on all four credentialed planes', async () => {
    const { sim, game, sent, button } = fixture(PLANES);
    for (const role of PLANES) {
      const item = UNITS[role];
      // This is the actual public bootstrap, not compiled STATS disguised as wire Rules.
      expect(game.view.match.rules.stats[item]).not.toHaveProperty('plane');
      game.world.rig.focus = role;
      game.renderCard();
      expect(button(role).disabled).toBe(false);
      expect(button(role).getAttribute('aria-disabled')).toBe('false');
      button(role).click();
      await settleProduction();
      expect(sent.at(-1)).toEqual({ role, intent: { kind: 'queue_add', item, count: 1 }, ack: { ok: true } });
      expect(sim.armies[0]!.queue.at(-1)).toMatchObject({ item, plane: role });
    }
    expect(sent).toHaveLength(4);
    expect(sim.armies[0]!.queue).toHaveLength(4);
  });

  it('disables restricted lanes and denies both direct production and queue commands', async () => {
    const { sim, game, sent, button } = fixture(['surface']);
    for (const role of PLANES) {
      game.world.rig.focus = role;
      game.renderCard();
      expect(button(role).disabled).toBe(role !== 'surface');
      if (role === 'surface') continue;
      expect(button(role).getAttribute('aria-disabled')).toBe('true');
      button(role).click();
      game.cmdProduce(UNITS[role], 1);
      expect(await game.act(role, [{ kind: 'queue_add', item: UNITS[role], count: 1 }])).toBe(false);
    }
    await settleProduction();
    expect(sent).toEqual([]);
    expect(sim.armies[0]!.queue).toHaveLength(0);
    game.world.rig.focus = 'surface';
    game.renderCard();
    button('surface').click();
    await settleProduction();
    expect(sent).toEqual([{ role: 'surface', intent: { kind: 'queue_add', item: 'tank', count: 1 }, ack: { ok: true } }]);
    expect(sim.armies[0]!.queue).toHaveLength(1);
  });

  it('refreshes cached production on authority changes without a new view or tick', async () => {
    const { sim, game, allowed, sent, button, authorityChanged } = fixture([]);
    const originalView = game.view;
    game.renderCard();
    const locked = button('surface');
    expect(locked.disabled).toBe(true);
    allowed.add('surface');
    authorityChanged();
    expect(game.view).toBe(originalView);
    expect(button('surface')).not.toBe(locked);
    expect(button('surface').disabled).toBe(false);
    button('surface').click();
    await settleProduction();
    expect(sent[0]?.ack).toEqual({ ok: true });
    expect(sim.armies[0]!.queue).toHaveLength(1);
    allowed.clear();
    authorityChanged();
    expect(game.view).toBe(originalView);
    expect(button('surface').disabled).toBe(true);
    button('surface').click();
    game.cmdProduce('tank', 1);
    await settleProduction();
    expect(sent).toHaveLength(1);
    expect(sim.armies[0]!.queue).toHaveLength(1);
  });
});
