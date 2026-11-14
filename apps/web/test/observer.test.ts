// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ResultsSummary } from 'playerthree/arena';
import type { ObserverMessage } from 'playerthree/protocol';
import type { World } from '../src/world/world.ts';
import type { Overlay } from '../src/overlay.ts';
import { CanvasCursor, SCROLL_CURSORS } from '../src/cursors.ts';
import type * as SeriesModule from '../src/observer-series.ts';
const transport = vi.hoisted(() => ({ receive: new Map<string, (message: ObserverMessage) => void>(), announce: new Map<string, (match: { roomId: string; delayMs: number; seats: [] }) => void>(), upcoming: new Map<string, (upcoming: { roomId: string; label: string; liveInMs: number } | null) => void>(), perspective: vi.fn(), close: vi.fn(), resync: vi.fn() }));
vi.mock('../src/observer-net.ts', () => {
  const join = async (_identity: unknown, _token: string, grant: { kind: string; team?: string }, receive: (message: ObserverMessage) => void) => {
    transport.receive.set(grant.kind === 'team' ? grant.team! : 'all', receive);
    return { perspective: transport.perspective, close: transport.close, resync: transport.resync };
  };
  class FeaturedObserverConnection {
    constructor(team: string, receive: (message: ObserverMessage) => void, match: (match: { roomId: string; delayMs: number; seats: [] }) => void, upcoming: (upcoming: { roomId: string; label: string; liveInMs: number } | null) => void) { transport.receive.set(team, receive); transport.announce.set(team, match); transport.upcoming.set(team, upcoming); }
    perspective = transport.perspective; close = transport.close; resync = transport.resync;
  }
  return { ObserverConnection: { join }, SeriesObserverConnection: { join }, FeaturedObserverConnection };
});
// The overview draws to a 2D canvas; the panel tests only need its element and its jump callback.
const overview = vi.hoisted(() => ({ jump: undefined as ((plane: string, x: number, y: number) => void) | undefined }));
vi.mock('../src/minimap.ts', () => ({ Minimap: class { el = document.createElement('div'); draw = vi.fn(); constructor(jump: (plane: string, x: number, y: number) => void) { overview.jump = jump; } } }));
const series = vi.hoisted(() => ({ receive: undefined as ((result: ResultsSummary) => void) | undefined }));
vi.mock('../src/observer-series.ts', async (original) => ({ ...await original<typeof SeriesModule>(), watchSeries: (_access: unknown, receive: (result: ResultsSummary) => void) => { series.receive = receive; } }));
const audio = vi.hoisted(() => ({ outcome: vi.fn(), scene: vi.fn() }));
vi.mock('../src/audio/index.ts', async (original) => ({ ...await original<object>(), audioOutcome: audio.outcome, setAudioScene: audio.scene }));
import { ObserverGame, observerStatus, upcomingNotice, type ObserverOptions } from '../src/observer.ts';
import { listener } from '../src/audio/index.ts';

beforeEach(() => { localStorage.clear(); transport.receive.clear(); transport.announce.clear(); transport.upcoming.clear(); });
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); vi.restoreAllMocks(); });
function world() {
  return {
    canvas: document.createElement('canvas'), size: 48, reset: vi.fn(), setView: vi.fn(), pickEntity: vi.fn(), entities: { tracks: new Map() },
    rig: { focus: 'surface', tx: 0, tz: 0, yaw: 0, pitch: 1, dist: 30, level: 1, diving: false, minDist: 12, maxDist: 78, camera: { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } }, keys: new Set(), goTo: vi.fn(), centerOn: vi.fn(), lookAtTile: vi.fn(), pan: vi.fn(), rotate: vi.fn(), zoom: vi.fn(), setSafeArea: vi.fn(), fitDistance: (radius: number, padding: number) => radius * padding * 2 },
  };
}
function overlayOf(canvas = document.createElement('canvas')) { return { canvas, cursor: new CanvasCursor(canvas) }; }
function mount(opts: Omit<ObserverOptions, 'onExit'> & { onExit?: () => void }, overlay = overlayOf()) {
  const renderer = world(); const root = document.createElement('div'); document.body.append(root);
  const game = new ObserverGame(root, renderer as unknown as World, overlay as unknown as Overlay, { onExit: vi.fn(), ...opts } as ObserverOptions);
  return { renderer, root, game, overlay };
}
const omniscient = { kind: 'omniscient' as const, teams: ['nw', 'se'], delayMs: 180000 };
const res = (alloy: number) => ({ alloy, energy: 40, alloyRate: 2.5, energyRate: 1, solarRate: 0, energyCap: 0, energyBank: 0, upkeep: 0, income: {}, scanReadyAt: 0 });
const spire = (hp: number) => [{ plane: 'surface', hp, maxHp: 1000 }, { plane: 'orbit', hp: 500, maxHp: 500 }];
const words = (value: number) => ({ depths: [value], surface: [value], sky: [value], orbit: [value] });
/** A released omniscient projection: both sides' economy, Spire, queue, research, army and event windows. */
function observerFrame(tick: number) {
  const match = { rulesHash: 7, terrain: [], rules: { map: { size: 48 }, spire: { timeCap: 900 }, depths: { chargesFogged: true, chargePublicTime: 5 }, stats: { tank: { alloy: 100, energy: 10 }, trooper: { alloy: 40, energy: 0 } } }, armies: [{ id: 'nw', slot: 0, frame: 0, colour: 'blue', spireAt: { x: 4, y: 4 } }, { id: 'se', slot: 1, frame: 2, colour: 'red', spireAt: { x: 44, y: 44 } }] };
  const entities = [
    { id: 'b1', kind: 'tank', side: 'nw', plane: 'surface', x: 10, y: 10, hp: 100, maxHp: 100, state: 'idle' },
    { id: 'b2', kind: 'tank', side: 'nw', plane: 'surface', x: 11, y: 10, hp: 100, maxHp: 100, state: 'idle' },
    { id: 'r1', kind: 'trooper', side: 'se', plane: 'surface', x: 40, y: 40, hp: 100, maxHp: 100, state: 'idle' },
  ];
  return {
    perspective: 'all', terrain: {},
    world: {
      tick, army: 'nw', rulesHash: 7, match, eliminated: [], entities, fx: [], impacts: [], vision: words(1), spire: [], queue: [], events: [], islands: [], research: { available: [], inProgress: [], completed: [], seen: [] }, alerts: [], weather: { storms: [], forecast: [], fog: [], seeded: [], seedWarnings: [] },
      charges: [], flares: [], schedule: [], depths: [], oreCaches: [], scorches: [], lodes: [], cracks: [], pockets: [], memory: [],
    },
    sides: [
      { army: 'nw', res: res(1234), spire: spire(800), queue: [{ id: 'q1', item: 'tank', plane: 'surface', status: 'building', progress: 0.5 }], research: { available: [], inProgress: [], completed: ['night_cloak'], seen: [] },
        forces: [{ plane: 'surface', units: 2, alloy: 200, energy: 20, structures: 1, structureAlloy: 0, structureEnergy: 0 }],
        events: [{ tick: tick - 1, kind: 'enemy_killed', plane: 'surface', x: 30, y: 30, subject: 'trooper', side: 'se' }], vision: words(0) },
      { army: 'se', res: res(77), spire: spire(250), queue: [], research: { available: ['night_cloak'], inProgress: [], completed: [], seen: [] },
        forces: [{ plane: 'surface', units: 1, alloy: 40, energy: 0, structures: 0, structureAlloy: 0, structureEnergy: 0 }],
        events: [{ tick: tick - 1, kind: 'spire_damaged', plane: 'surface', x: 24, y: 24, subject: 'spire', side: 'nw' }], vision: words(0) },
    ],
  };
}
/** Delivers one keyframe and plays it out (the feed holds it for its jitter margin first). */
function play(game: ObserverGame, perspective: string, message: ObserverMessage, clock: { now: number }) {
  transport.receive.get(perspective)!(message);
  clock.now += 2000; game.frame();
}
/** Delivers a frame recorded just now: released by the server, not yet due on the playout clock. */
function deliver(perspective: string, sequence: number, tick: number, world: unknown, clock: { now: number }, outcomes?: Record<string, 'running' | 'win' | 'loss' | 'draw'>) {
  transport.receive.get(perspective)!({ op: 'observer', state: 'ready', frame: { sequence, tick, recordedAt: clock.now - 10, releaseAt: clock.now - 10, perspective, world, ...(outcomes ? { outcomes } : {}) } });
}
/** The released final frame of a duel blue won: red's Surface segment fell on `tick`; both places are final. */
function finalFrame(tick: number) {
  const frame = observerFrame(tick);
  const fell = { tick, kind: 'army_eliminated', plane: 'surface', x: 44, y: 44, subject: 'spire', side: 'se', killer: 'nw' };
  return {
    ...frame, world: { ...frame.world, eliminated: ['se'], rank: 1 },
    sides: [{ ...frame.sides[0]!, rank: 1, events: [fell] }, { ...frame.sides[1]!, rank: 2, spire: spire(0), events: [fell] }],
  };
}
/** The released final frame of a four-army free-for-all green won (blue fell last, to green). */
function ffaFinal(tick: number) {
  const base = observerFrame(tick);
  const ids = ['nw', 'ne', 'se', 'sw'] as const;
  const colours = { nw: 'blue', ne: 'green', se: 'red', sw: 'violet' };
  const ranks = { nw: 2, ne: 1, se: 4, sw: 3 };
  const match = { ...base.world.match, armies: ids.map((id, slot) => ({ id, slot, frame: slot, colour: colours[id], spireAt: { x: 4, y: 4 } })) };
  const fell = { tick, kind: 'army_eliminated', plane: 'surface', x: 4, y: 4, subject: 'spire', side: 'nw', killer: 'ne' };
  return {
    ...base, world: { ...base.world, match, eliminated: ['se', 'sw', 'nw'], rank: 2 },
    sides: ids.map((army) => ({ ...base.sides[0]!, army, rank: ranks[army], spire: spire(army === 'ne' ? 900 : 0), events: [fell] })),
  };
}

it('shows the real delayed buffering state without granting vision or instantiating command inputs', async () => {
  const { renderer, root, game } = mount({ roomId: 'room', token: 'observer', grant: omniscient });
  expect(root.textContent).toContain('Delayed 180 s · Buffering');
  expect(root.querySelector('.observer-live')?.textContent).toBe('LIVE −180 s');
  expect(renderer.setView).not.toHaveBeenCalled();
  expect(root.querySelector('textarea,input,select,[title]')).toBeNull();
  await game.start();
  expect(transport.receive.has('all')).toBe(true);
  game.dispose(); expect(transport.close).toHaveBeenCalledOnce();
});

it('hands music to the match on its first released view, using that camera rather than the previous match', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const { renderer, game } = mount({ roomId: 'room', token: 'observer', grant: omniscient });
  renderer.rig.focus = 'orbit';
  listener.plane = 'depths';
  await game.start();
  expect(audio.scene).not.toHaveBeenCalled();
  audio.scene.mockImplementationOnce(() => expect(listener.plane).toBe('orbit'));
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 1, tick: 200, recordedAt: 900, releaseAt: 900, perspective: 'all', world: observerFrame(200) } }, clock);
  expect(audio.scene).toHaveBeenCalledExactlyOnceWith('match');
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 2, tick: 220, recordedAt: 2900, releaseAt: 2900, perspective: 'all', world: observerFrame(220) } }, clock);
  expect(audio.scene).toHaveBeenCalledTimes(1);
  game.dispose();
});

it('offers only the perspectives the observer policy permits', async () => {
  const visions = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-vision]')].map((button) => button.dataset.vision);
  const all = mount({ roomId: 'room', token: 'observer', grant: omniscient });
  expect(visions(all.root)).toEqual(['all', 'nw', 'se']);
  all.game.dispose();
  const team = mount({ roomId: 'room', token: 'observer', grant: { kind: 'team', team: 'nw', delayMs: 0 } });
  expect(visions(team.root)).toEqual(['nw']);
  expect(team.root.querySelector('[aria-label="Vision: All"]')).toBeNull();
  // V cycles only through what exists: a fixed team observer stays on its team.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }));
  expect(team.root.querySelector('[data-vision="nw"]')?.getAttribute('aria-checked')).toBe('true');
  team.game.dispose();
  // Watch live: the featured relay serves All first (all bots), each side's fog on its own stream; All alone streams.
  const featured = mount({ source: { kind: 'featured' }, grant: { kind: 'omniscient', teams: ['nw', 'se'], delayMs: 3000 } });
  await featured.game.start();
  expect(visions(featured.root)).toEqual(['all', 'nw', 'se']);
  expect(featured.root.querySelector('[data-vision="all"]')?.getAttribute('aria-checked')).toBe('true');
  expect((featured.renderer as unknown as World).observing).toBe('all');
  expect([...transport.receive.keys()]).toEqual(['all']);
  // A featured match with any non-bot seat announces it serves no All: only each side's fog remains.
  transport.announce.get('all')!({ roomId: 'r1', delayMs: 3000, armies: ['nw', 'se'], seats: [], label: '', omniscient: false } as never);
  expect(visions(featured.root)).toEqual(['nw', 'se']);
  expect(featured.root.querySelector('[data-vision="nw"]')?.getAttribute('aria-checked')).toBe('true');
  expect([...transport.receive.keys()].sort()).toEqual(['all', 'nw', 'se']);
  expect(transport.close).toHaveBeenCalledOnce();
  featured.game.dispose();
});

it('Watch live follows the announced armies: a four-army FFA gets All plus a vision per army, four score columns and its matchup line', async () => {
  const visions = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-vision]')].map((button) => button.dataset.vision);
  const { root, game } = mount({ source: { kind: 'featured' }, grant: { kind: 'omniscient', teams: [], delayMs: 3000 }, label: 'Watch live · featured bots' });
  await game.start();
  expect(visions(root)).toEqual(['all']);
  const ffa = { roomId: 'r1', delayMs: 3000, armies: ['nw', 'ne', 'se', 'sw'], seats: [], label: 'FFA: Veteran ×4 · Canyons 64', omniscient: true };
  transport.announce.get('all')!(ffa as never);
  expect(visions(root)).toEqual(['all', 'nw', 'ne', 'se', 'sw']);
  expect([...root.querySelectorAll<HTMLElement>('.obs-side')].map((side) => side.dataset.team)).toEqual(['nw', 'ne', 'se', 'sw']);
  expect(root.querySelector<HTMLElement>('.obs')!.dataset.armies).toBe('4');
  expect(root.querySelector('.obs-match-label')?.textContent).toBe('FFA: Veteran ×4 · Canyons 64');
  // All alone streams; a side's own fog opens when chosen.
  expect([...transport.receive.keys()]).toEqual(['all']);
  root.querySelector<HTMLElement>('[data-vision="sw"]')!.click();
  expect([...transport.receive.keys()]).toEqual(['all', 'sw']);
  // The next match is a duel: the extra armies' visions and columns go, and the vision falls back to All.
  transport.announce.get('all')!({ ...ffa, roomId: 'r2', armies: ['nw', 'se'], label: 'Veteran vs Standard · Ridges 48' } as never);
  expect(visions(root)).toEqual(['all', 'nw', 'se']);
  expect(root.querySelectorAll('.obs-side')).toHaveLength(2);
  expect(root.querySelector('[data-vision="all"]')?.getAttribute('aria-checked')).toBe('true');
  expect(root.querySelector('.obs-match-label')?.textContent).toBe('Veteran vs Standard · Ridges 48');
  game.dispose();
});

it('the phone strip names four armies by initial', async () => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
  const { root, game } = mount({ source: { kind: 'featured' }, grant: { kind: 'omniscient', teams: [], delayMs: 3000 } });
  await game.start();
  expect(root.querySelector('.obs')?.hasAttribute('data-compact')).toBe(true);
  transport.announce.get('all')!({ roomId: 'r1', delayMs: 3000, armies: ['nw', 'ne', 'se', 'sw'], seats: [], label: '', omniscient: true } as never);
  expect([...root.querySelectorAll<HTMLElement>('[data-vision]')].map((button) => button.textContent)).toEqual(['All', 'B', 'R', 'G', 'V']);
  expect(root.querySelector('[data-vision="sw"]')?.getAttribute('aria-label')).toBe('Vision: Violet');
  game.dispose();
});

it('Watch live counts down to a public game, then cuts over to it on a "Live: public game" loader card at its own delay', async () => {
  const { renderer, root, game } = mount({ source: { kind: 'featured' }, grant: { kind: 'omniscient', teams: [], delayMs: 3000 } });
  await game.start();
  // As many seats as the public game fields: the agents panel must still re-render at the cut.
  const bots = { roomId: 'bots-1', public: false, delayMs: 3000, armies: ['nw', 'se'], seats: [{ team: 'nw', role: 'surface', kind: 'bot', level: 'veteran' }, { team: 'se', role: 'surface', kind: 'bot', level: 'standard' }], label: 'Veteran vs Standard · Ridges 48', omniscient: true };
  transport.announce.get('all')!(bots as never);
  expect(game.loadingNote()).toBeUndefined();
  const notice = root.querySelector<HTMLElement>('.obs-upcoming')!;
  expect(notice.hidden).toBe(true);
  // Announced ahead: the bot match stays on screen with a countdown to the public game's delayed start.
  transport.upcoming.get('all')!({ roomId: 'public-1', label: 'Player 1 vs Standard bot · Open duel', liveInMs: 125_000 });
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toBe('Public game starting · live in 2:05');
  expect(notice.dataset.tip).toBe('Player 1 vs Standard bot · Open duel');
  expect(upcomingNotice(0)).toBe('Public game next');
  // The cut over: the notice goes, the world drops (the runtime's loader returns) and the card names the game.
  const resets = renderer.reset.mock.calls.length;
  transport.upcoming.get('all')!(null);
  expect(notice.hidden).toBe(true);
  transport.announce.get('all')!({ roomId: 'public-1', public: true, delayMs: 180_000, armies: ['nw', 'se'], label: 'Player 1 vs Standard bot · Open duel', omniscient: true,
    seats: [{ team: 'nw', role: 'surface', kind: 'human', name: 'Player 1' }, { team: 'se', role: 'surface', kind: 'bot', level: 'standard' }] } as never);
  expect(renderer.reset.mock.calls.length).toBe(resets + 1);
  expect(game.loadingNote()).toBe('Live: public game · Player 1 vs Standard bot · Open duel');
  expect(root.querySelector('.observer-live')?.textContent).toBe('LIVE −180 s');
  expect(root.querySelector('.obs-match-label')?.textContent).toBe('Player 1 vs Standard bot · Open duel');
  expect(root.querySelector('[data-team="nw"] .obs-seats')?.textContent).toContain('Player 1');
  // Back to the playlist: no card, the bot delay again.
  transport.announce.get('all')!({ ...bots, roomId: 'bots-2' } as never);
  expect(game.loadingNote()).toBeUndefined();
  expect(root.querySelector('.observer-live')?.textContent).toBe('LIVE −3 s');
  game.dispose();
});

it('Watch live opens on All; a side’s vision is that side’s own fogged stream, shown through All’s lens until it plays', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const { renderer, root, game } = mount({ source: { kind: 'featured' }, grant: { kind: 'omniscient', teams: ['nw', 'se'], delayMs: 3000 } });
  await game.start();
  deliver('all', 1, 200, observerFrame(200), clock); clock.now += 2000; game.frame();
  expect(renderer.setView).toHaveBeenLastCalledWith(expect.objectContaining({ entities: expect.arrayContaining([expect.objectContaining({ id: 'b1' }), expect.objectContaining({ id: 'r1' })]) }), false);
  root.querySelector<HTMLElement>('[aria-label="Vision: Red"]')!.click();
  expect((renderer as unknown as World).observing).toBe('se');
  expect([...transport.receive.keys()]).toEqual(['all', 'se']);
  // Until red's stream plays: red's fog through All's lens.
  expect(renderer.setView.mock.lastCall![0].entities.map((entity: { id: string }) => entity.id)).toEqual(['r1']);
  const red = { ...observerFrame(220).world, army: 'se', entities: [{ id: 'r9', kind: 'trooper', side: 'se', plane: 'surface', x: 41, y: 41, hp: 100, maxHp: 100, state: 'idle' }] };
  deliver('se', 1, 220, red, clock); clock.now += 2000; game.frame();
  expect(renderer.setView.mock.lastCall![0].entities.map((entity: { id: string }) => entity.id)).toEqual(['r9']);
  // All still fills the scoreboard: red's own stream never replaces the omniscient board.
  expect(root.querySelector('.obs-side[data-team="se"] [data-stat="alloy"] b')?.textContent).toBe('77');
  root.querySelector<HTMLElement>('[aria-label="Vision: All"]')!.click();
  expect(transport.close).toHaveBeenCalledOnce();
  expect(renderer.setView.mock.lastCall![0].entities.map((entity: { id: string }) => entity.id)).toEqual(['b1', 'b2', 'r1']);
  game.dispose();
});

it('a vision switch shows the other perspective in place (no dropped world, so no loader); a rotation to a new room drops it', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const { renderer, root, game } = mount({ source: { kind: 'featured' }, grant: { kind: 'omniscient', teams: ['nw', 'se'], delayMs: 3000 } });
  await game.start();
  const announce = (roomId: string) => { for (const match of [...transport.announce.values()]) match({ roomId, delayMs: 3000, armies: ['nw', 'se'], seats: [], label: '', omniscient: true } as never); };
  announce('r1');
  deliver('all', 1, 200, observerFrame(200), clock); clock.now += 2000; game.frame();
  expect(renderer.setView.mock.lastCall![1]).toBe(false);
  renderer.reset.mockClear();
  // Red through All's lens, red's own stream (another id namespace), back to All: one match, three perspectives.
  root.querySelector<HTMLElement>('[aria-label="Vision: Red"]')!.click();
  expect(renderer.setView.mock.lastCall).toEqual([expect.objectContaining({ army: 'se' }), true]);
  const red = { ...observerFrame(220).world, army: 'se', entities: [{ id: 'r9', kind: 'trooper', side: 'se', plane: 'surface', x: 41, y: 41, hp: 100, maxHp: 100, state: 'idle' }] };
  deliver('se', 1, 220, red, clock); clock.now += 2000; game.frame();
  expect(renderer.setView.mock.lastCall).toEqual([expect.objectContaining({ army: 'se', entities: [expect.objectContaining({ id: 'r9' })] }), true]);
  root.querySelector<HTMLElement>('[aria-label="Vision: All"]')!.click();
  expect(renderer.setView.mock.lastCall).toEqual([expect.objectContaining({ names: 'sim' }), true]);
  // The same room announced again (a stream's own announcement) is no match change either.
  announce('r1');
  expect(renderer.reset).not.toHaveBeenCalled();
  // The relay rolls on to another room: the shown match is dropped (the runtime's loader returns over it).
  announce('r2');
  expect(renderer.reset).toHaveBeenCalledOnce();
  deliver('all', 1, 20, observerFrame(20), clock); clock.now += 2000; game.frame();
  expect(renderer.setView.mock.lastCall![1]).toBe(false);
  game.dispose();
});

it('a side vision over the omniscient stream is that side’s fog, never a new server request', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const { renderer, root, game } = mount({ roomId: 'room', token: 'observer', grant: { ...omniscient, delayMs: 0 } });
  await game.start();
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 1, tick: 200, recordedAt: 900, releaseAt: 900, perspective: 'all', world: observerFrame(200) } }, clock);
  expect(renderer.setView).toHaveBeenLastCalledWith(expect.objectContaining({ army: 'nw', entities: expect.arrayContaining([expect.objectContaining({ id: 'r1' })]) }), false);
  root.querySelector<HTMLElement>('[aria-label="Vision: Red"]')!.click();
  const shown = renderer.setView.mock.lastCall![0];
  expect(shown.army).toBe('se');
  expect(shown.vision).toEqual(words(0));
  // Red sees its own trooper; the blue tanks stand in red's fog.
  expect(shown.entities.map((entity: { id: string }) => entity.id)).toEqual(['r1']);
  expect(transport.perspective).not.toHaveBeenCalled();
  expect(root.querySelector('[data-vision="se"]')?.getAttribute('aria-checked')).toBe('true');
  game.dispose();
});

it('renders the scoreboard, side tabs, timeline and agents from released observer frames', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const { root, game, renderer } = mount({ roomId: 'room', token: 'observer', grant: { ...omniscient, delayMs: 0 } });
  await game.start();
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 1, tick: 1300, recordedAt: 900, releaseAt: 900, perspective: 'all', world: observerFrame(1300),
    agentCards: [{ team: 'nw', role: 'surface', card: { id: 'e1', label: 'Claude', kind: 'agent', aiPlayer: true, provider: 'anthropic', model: 'opus', harness: { label: 'claude-code', verified: true } } }],
    commentary: [{ id: 'c1', team: 'nw', role: 'surface', tick: 1290, category: 'chat', text: '<b>push</b> mid' }] } }, clock);
  const side = (team: string) => root.querySelector<HTMLElement>(`.obs-side[data-team="${team}"]`)!;
  expect(root.querySelector('.obs-clock')?.textContent).toBe('01:05');
  expect(side('nw').querySelector('[data-stat="alloy"] b')?.textContent).toBe('1234');
  expect(side('nw').querySelector('[data-stat="alloy"] small')?.textContent).toBe('+2.5/s');
  expect(side('nw').querySelector('[data-stat="army"] b')?.textContent).toBe('220');
  expect(side('se').querySelector('[data-stat="alloy"] b')?.textContent).toBe('77');
  expect(side('se').querySelector('[data-plane="surface"]')?.getAttribute('aria-label')).toBe('Surface Spire: 250 / 1000 HP');
  expect(side('se').querySelector<HTMLElement>('[data-plane="surface"]')?.dataset.state).toBe('low');
  expect(side('se').querySelector<HTMLElement>('[data-plane="sky"]')?.dataset.state).toBe('unknown');
  // Production, then research and army composition (P / R / A).
  expect(root.querySelector('.obs-sides')?.textContent).toContain('Tank');
  expect(root.querySelector('.obs-sides')?.textContent).toContain('50%');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
  expect(root.querySelector('.obs-sides [data-team="nw"]')?.textContent).toContain('Night Cloak');
  expect(root.querySelector('.obs-sides [data-team="se"]')?.textContent).toContain('1 available');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u' }));
  expect(root.querySelector('.obs-sides [data-team="nw"] [aria-label="2 Tank"]')).not.toBeNull();
  expect(root.querySelector('.obs-sides [data-team="se"] [aria-label="1 Trooper"]')).not.toBeNull();
  // The timeline: blue's kill and the hit on red's Spire, newest first, clickable to the spot.
  const moments = [...root.querySelectorAll<HTMLButtonElement>('.obs-moment')];
  expect(moments.map((moment) => moment.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Blue destroyed Trooper'), expect.stringContaining("Blue hit Red's Surface Spire")]));
  moments.find((moment) => moment.textContent!.includes('Spire'))!.click();
  expect(renderer.rig.goTo).toHaveBeenLastCalledWith('surface', clock.now, 'jump');
  expect(renderer.rig.lookAtTile).toHaveBeenLastCalledWith(24, 24);
  // Agents: identity chips and plain-text public chatter.
  const agents = root.querySelector('.obs-agents [data-team="nw"]')!;
  expect(agents.textContent).toContain('Claude');
  expect(agents.textContent).toContain('anthropic / opus');
  expect(agents.textContent).toContain('<b>push</b> mid');
  expect(agents.querySelector('b b')).toBeNull();
  expect(root.querySelector('.obs-agents [data-team="se"]')?.textContent).toContain('No public chatter');
  game.dispose();
});

it('stream mode leaves only the scoreboard and the delay badge, and every panel collapses', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(join(import.meta.dirname, '../src/observer.css'), 'utf8');
  document.head.append(style);
  const { root, game } = mount({ roomId: 'room', token: 'observer', grant: omniscient });
  const obs = root.querySelector<HTMLElement>('.obs')!;
  const shown = (selector: string) => getComputedStyle(root.querySelector(selector)!).display !== 'none';
  for (const panel of ['Sides', 'Timeline', 'Agents']) {
    root.querySelector<HTMLElement>(`[aria-label="${panel} panel"]`)!.click();
    expect(root.querySelector(`[aria-label="${panel}"]`)?.getAttribute('data-collapsed')).toBe('true');
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
  expect(obs.hasAttribute('data-stream')).toBe(true);
  expect(shown('.obs-board')).toBe(true);
  expect(shown('.obs-left')).toBe(false); expect(shown('.obs-right')).toBe(false); expect(shown('.obs-dock')).toBe(false);
  expect(root.querySelector('.obs-board .observer-live')?.textContent).toBe('LIVE −180 s');
  // Esc leaves stream mode; the choice persists for the next observer session.
  expect(JSON.parse(localStorage.getItem('ac.observer')!).stream).toBe(true);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(obs.hasAttribute('data-stream')).toBe(false);
  expect(shown('.obs-dock')).toBe(true);
  game.dispose(); style.remove();
});

it('the benchmark preset shows the series, its standings, rotation, side swap, running games and results link', async () => {
  const onExit = vi.fn();
  const { root, game } = mount({ source: { kind: 'series', access: { kind: 'share', token: 'shared-result' }, matchId: 'm2' }, grant: omniscient, onExit });
  expect(root.querySelector<HTMLElement>('.obs')?.dataset.preset).toBe('benchmark');
  expect(await game.start()).toBe(true);
  const schedule = [0, 1, 2].map((index) => ({ trialId: `t${index}`, scheduleIndex: index, mapId: ['ridges', 'canyons', 'ridges'][index], permutationId: index % 2 ? 'swapped' : 'original', sideBindings: index % 2 ? [{ team: 'nw', entrantId: 'b' }, { team: 'se', entrantId: 'a' }] : [{ team: 'nw', entrantId: 'a' }, { team: 'se', entrantId: 'b' }] }));
  const result = {
    revision: 3, state: 'running', summaries: { latency: [{ entrantId: 'a', source: 'runner', samples: 4, p50Ms: 120, p95Ms: 900, method: 'nearest_rank/1' }], usage: [{ entrantId: 'a', phase: 'inference', reporter: 'runner', currency: 'USD', samples: 4, coverage: 'complete', inputTokens: 5000, outputTokens: 800, cacheReadTokens: null, cacheWriteTokens: null, costAmount: '0.0420' }] },
    activeMatches: [{ matchId: 'm2', trialId: 't1', attemptId: 'x', attemptNumber: 1, startedAt: '', releaseAt: 0, spec: { map: { id: 'canyons' } } }, { matchId: 'm3', trialId: 't2', attemptId: 'y', attemptNumber: 1, startedAt: '', releaseAt: 0, spec: { map: { id: 'ridges' } } }],
    tables: {
      entrants: [{ entrantId: 'a', label: 'Claude', kind: 'agent' }, { entrantId: 'b', label: 'Veteran bot', kind: 'bot' }],
      schedule, standings: [{ entrantId: 'a', wins: 1, losses: 0, draws: 0 }, { entrantId: 'b', wins: 0, losses: 1, draws: 0 }],
      matches: [{ matchId: 'm1', trialId: 't0', acceptedAttempt: true }],
      seats: [{ matchId: 'm1', team: 'nw', role: 'surface', entrantId: 'a', submittedIntents: 40, acceptedIntents: 37, rejectedIntents: 3, commandApm: 22.5 }],
    },
  } as unknown as ResultsSummary;
  series.receive!(result);
  const strip = root.querySelector('.obs-series')!;
  expect(strip.textContent).toContain('Claude vs Veteran bot');
  expect(strip.textContent).toContain('Game 2 of 3');
  expect(strip.querySelector('[aria-label="Standings"]')?.textContent).toContain('Claude 1–0');
  expect(strip.querySelector('.obs-map.current')?.getAttribute('aria-label')).toBe('Game 2 canyons');
  expect(strip.querySelector('[aria-label="Sides swapped"]')).not.toBeNull();
  expect([...strip.querySelectorAll('[aria-label="Running games"] button')].map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  const link = strip.querySelector<HTMLAnchorElement>('a[aria-label="Series results"]')!;
  expect(link.getAttribute('href')).toBe('/arena/share/shared-result');
  link.click(); expect(onExit).toHaveBeenCalledOnce();
  // Sides are named by their entrant in this game (swapped), with series stats for the agent.
  expect(root.querySelector('.obs-side[data-team="se"] .obs-side-name')?.textContent).toBe('Claude');
  const stats = root.querySelector('.obs-agents [data-team="se"] .obs-agent-stats')!;
  expect(stats.textContent).toContain('22.5');
  expect(stats.textContent).toContain('37 / 3');
  expect(stats.textContent).toContain('120 / 900 ms');
  expect(stats.textContent).toContain('0.0420 USD');
  game.dispose();
});

it('camera input comes from the overlay canvas on top, and rotates with right-, middle- or Alt+drag like play', () => {
  const { renderer, game, overlay } = mount({ roomId: 'room', token: 'observer', grant: omniscient });
  overlay.canvas.setPointerCapture = vi.fn();
  const drag = (init: PointerEventInit) => {
    overlay.canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, ...init }));
    overlay.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 140, clientY: 110 }));
    overlay.canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 140, clientY: 110 }));
  };
  drag({ button: 2 }); drag({ button: 1 }); drag({ button: 0, altKey: true });
  expect(renderer.rig.rotate).toHaveBeenCalledTimes(3);
  drag({ button: 0 });
  expect(renderer.rig.pan).toHaveBeenCalledOnce();
  game.dispose();
});

it('enters with the page cursor whatever a player session left on the shared canvas, and never sets a game cursor', () => {
  const stale = overlayOf();
  // The player's edge-scroll up arrow (the green arrow), left on the canvas the observer now takes.
  stale.cursor.set(SCROLL_CURSORS[6]);
  const { game, overlay } = mount({ roomId: 'room', token: 'observer', grant: omniscient }, stale);
  expect(overlay.canvas.style.cursor).toBe('');
  overlay.canvas.setPointerCapture = vi.fn();
  for (const [type, x, y] of [['pointermove', 2, 2], ['pointerdown', 300, 2], ['pointermove', 500, 3], ['pointerup', 500, 3], ['pointermove', 300, 300]] as const)
    overlay.canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0 }));
  expect(overlay.canvas.style.cursor).toBe('');
  game.dispose();
});

it('choosing another plane while following a unit releases the follow and dives there (chips, F-keys, overview)', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const { renderer, root, game, overlay } = mount({ roomId: 'room', token: 'observer', grant: { ...omniscient, delayMs: 0 } });
  // As CameraRig.goTo: the dive's destination is the focus at once.
  renderer.rig.goTo.mockImplementation((plane: string) => { renderer.rig.focus = plane; });
  overlay.canvas.setPointerCapture = vi.fn();
  await game.start();
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 1, tick: 200, recordedAt: 900, releaseAt: 900, perspective: 'all', world: observerFrame(200) } }, clock);
  const tank = { e: { id: 'b1', kind: 'tank', plane: 'surface' }, rx: 10, ry: 10 };
  renderer.entities.tracks.set('b1', tank);
  const following = () => root.querySelector('[aria-label="Click a unit to follow it · F or Esc stops"]')!.getAttribute('aria-pressed');
  const frames = () => { for (let i = 0; i < 10; i++) { clock.now += 16; game.frame(); } };
  const choices: [string, () => void][] = [
    ['sky', () => root.querySelector<HTMLElement>('.obs-plane[data-plane="sky"]')!.click()],
    ['orbit', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F4' }))],
    ['depths', () => overview.jump!('depths', 5, 6)],
  ];
  for (const [plane, choose] of choices) {
    renderer.pickEntity.mockReturnValue(tank);
    overlay.canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0 }));
    overlay.canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, button: 0 }));
    frames();
    expect(following()).toBe('true');
    // The followed tank pulls the camera back to the Surface, tracked without the transition ink.
    expect(renderer.rig.focus).toBe('surface');
    choose();
    frames();
    expect(renderer.rig.focus, plane).toBe(plane);
    expect(renderer.rig.goTo).toHaveBeenLastCalledWith(plane, expect.any(Number), 'jump');
    expect(following(), plane).toBe('false');
    if (plane !== 'sky') expect(renderer.rig.goTo).toHaveBeenCalledWith('surface', expect.any(Number), 'track');
  }
  game.dispose();
});

it('labels the shared release clock rather than a client tick-offset delay', () => {
  expect(observerStatus(180000, 'Buffering')).toContain('All channels use the same server release clock');
  expect(observerStatus(0, 'Released playback')).toContain('Private authorized · no delay');
});

it('shows the result once, at the released final frame and never before, with the sting and the lobby exits', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const onExit = vi.fn();
  const { root, game } = mount({ roomId: 'room', token: 'observer', grant: { ...omniscient, delayMs: 0 }, label: 'Lobby match', onExit });
  await game.start();
  const end = () => root.querySelector<HTMLElement>('.obs-end')!;
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 1, tick: 1300, recordedAt: 900, releaseAt: 900, perspective: 'all', world: observerFrame(1300), outcomes: { nw: 'running', se: 'running' } } }, clock);
  expect(end().hidden).toBe(true);
  // Released by the server but not yet due on the playout clock: nothing of the result shows or sounds.
  deliver('all', 2, 1320, finalFrame(1320), clock, { nw: 'win', se: 'loss' });
  game.frame();
  expect(end().hidden).toBe(true);
  expect(audio.outcome).not.toHaveBeenCalled();
  clock.now += 2000; game.frame();
  expect(end().hidden).toBe(false);
  expect(end().dataset.state).toBe('open');
  expect(audio.outcome).toHaveBeenCalledOnce();
  expect(audio.outcome).toHaveBeenCalledWith('win');
  expect(end().querySelector('.outcome-title')?.textContent).toBe('Blue wins');
  expect(end().querySelector('.outcome-meta')?.textContent).toBe('Lobby match · 1m 6s · Surface segment fell');
  const rows = [...end().querySelectorAll<HTMLElement>('.obs-end-ranks li')];
  expect(rows.map((row) => [row.dataset.team, row.querySelector('.obs-end-place')?.textContent, row.querySelector('.obs-end-result')?.textContent])).toEqual([['nw', '1st', 'Win'], ['se', '2nd', 'Loss']]);
  expect(rows[0]!.querySelector('[data-stat="army"]')?.textContent).toBe('2 units · 220');
  expect(rows[1]!.querySelector('[data-stat="spire"]')?.textContent).toBe('500 / 1500');
  // Later final frames refresh the card; it never shows or stings again.
  deliver('all', 3, 1320, finalFrame(1320), clock, { nw: 'win', se: 'loss' });
  clock.now += 2000; game.frame();
  expect(root.querySelectorAll('.obs-end')).toHaveLength(1);
  expect(audio.outcome).toHaveBeenCalledOnce();
  // Esc folds it to a banner over the field (never over the scoreboard); the fold control brings it back.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(end().dataset.state).toBe('banner');
  end().querySelector<HTMLElement>('[data-end-action="fold"]')!.click();
  expect(end().dataset.state).toBe('open');
  // Stream mode keeps a clean caster card: the result without its controls.
  const style = document.createElement('style');
  style.textContent = readFileSync(join(import.meta.dirname, '../src/observer.css'), 'utf8');
  document.head.append(style);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
  expect(getComputedStyle(root.querySelector('.obs-dock')!).display).toBe('none');
  expect(getComputedStyle(end()).display).not.toBe('none');
  expect(getComputedStyle(end().querySelector('.obs-end-actions')!).display).toBe('none');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
  style.remove();
  // A lobby or room observer (an eliminated player too) goes back to the lobby or Home.
  expect(end().querySelector('[data-end-action="next"],[data-end-action="results"]')).toBeNull();
  end().querySelector<HTMLElement>('[data-end-action="lobby"]')!.click();
  expect(onExit).toHaveBeenLastCalledWith('lobby');
  end().querySelector<HTMLElement>('[data-end-action="home"]')!.click();
  expect(onExit).toHaveBeenLastCalledWith('home');
  game.dispose();
});

it('ranks a four-army free-for-all first to fourth, each army in its colour', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const { root, game } = mount({ roomId: 'room', token: 'observer', grant: { kind: 'omniscient', teams: ['nw', 'ne', 'se', 'sw'], delayMs: 0 } });
  await game.start();
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 1, tick: 2400, recordedAt: 900, releaseAt: 900, perspective: 'all', world: ffaFinal(2400), outcomes: { nw: 'loss', ne: 'win', se: 'loss', sw: 'loss' } } }, clock);
  const end = root.querySelector<HTMLElement>('.obs-end')!;
  expect(end.hidden).toBe(false);
  expect(end.querySelector('.outcome-title')?.textContent).toBe('Green wins');
  expect(end.querySelector('.outcome-meta')?.textContent).toBe('2m 0s · Surface segment fell');
  const rows = [...end.querySelectorAll<HTMLElement>('.obs-end-ranks li')];
  expect(rows.map((row) => [row.querySelector('.obs-end-place')?.textContent, row.querySelector('.obs-end-name')?.textContent, row.querySelector('.obs-end-result')?.textContent]))
    .toEqual([['1st', 'Green', 'Win'], ['2nd', 'Blue', 'Loss'], ['3rd', 'Violet', 'Loss'], ['4th', 'Red', 'Loss']]);
  expect(new Set(rows.map((row) => row.style.getPropertyValue('--side-ink'))).size).toBe(4);
  game.dispose();
});

it('under lossRule crowns: crown pips per army on the scoreboard, match point, and an end card naming the fallen segments', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const { root, game } = mount({ roomId: 'room', token: 'observer', grant: { ...omniscient, delayMs: 0 } });
  await game.start();
  const crownsFrame = (tick: number, crowns: unknown, extra: Record<string, unknown> = {}) => {
    const frame = observerFrame(tick);
    const rules = { ...frame.world.match.rules, spire: { timeCap: 900, lossRule: 'crowns', crownsSurface: 2, crownsSide: 1, crownsToLose: 2 } };
    return { ...frame, world: { ...frame.world, match: { ...frame.world.match, rules }, crowns, ...extra } };
  };
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 1, tick: 1300, recordedAt: 900, releaseAt: 900, perspective: 'all',
    world: crownsFrame(1300, [{ army: 'nw', lost: 1, fallen: ['sky'] }, { army: 'se', lost: 0, fallen: [] }]), outcomes: { nw: 'running', se: 'running' } } }, clock);
  const pips = (army: string) => [...root.querySelectorAll<HTMLElement>(`.obs-side[data-team="${army}"] [data-stat="crowns"] .crown-pip`)].map((pip) => pip.dataset.state);
  expect(pips('nw')).toEqual(['standing', 'fallen', 'standing', 'standing']);
  expect(pips('se')).toEqual(['standing', 'standing', 'standing', 'standing']);
  const banner = root.querySelector<HTMLElement>('.obs-center .match-point')!;
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toBe('Match point · Blue');
  // Red loses Sky then Orbit: eliminated on the Orbit segment's fall; its row stays frozen as it fell.
  const fell = { tick: 1320, kind: 'army_eliminated', plane: 'orbit', x: 44, y: 44, subject: 'spire', side: 'se', killer: 'nw' };
  const final = crownsFrame(1320, [{ army: 'nw', lost: 1, fallen: ['sky'] }, { army: 'se', lost: 2, fallen: ['sky', 'orbit'] }], { eliminated: ['se'], rank: 1 });
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 2, tick: 1320, recordedAt: 900, releaseAt: 900, perspective: 'all', outcomes: { nw: 'win', se: 'loss' },
    world: { ...final, sides: [{ ...final.sides[0]!, rank: 1, events: [fell] }, { ...final.sides[1]!, rank: 2, spire: [{ plane: 'surface', hp: 1000, maxHp: 1000 }, { plane: 'orbit', hp: 0, maxHp: 500 }], events: [fell] }] } } }, clock);
  expect(pips('se')).toEqual(['fallen', 'fallen', 'standing', 'standing']);
  expect(root.querySelector('.obs-end .outcome-meta')?.textContent).toBe('1m 6s · Sky and Orbit segments fell');
  game.dispose();
});

it('shows no crowns outside lossRule crowns', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const { root, game } = mount({ roomId: 'room', token: 'observer', grant: { ...omniscient, delayMs: 0 } });
  await game.start();
  const frame = observerFrame(1300);
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 1, tick: 1300, recordedAt: 900, releaseAt: 900, perspective: 'all',
    world: { ...frame, world: { ...frame.world, crowns: [{ army: 'nw', lost: 1, fallen: ['sky'] }] } }, outcomes: { nw: 'running', se: 'running' } } }, clock);
  expect([...root.querySelectorAll<HTMLElement>('[data-stat="crowns"]')].every((el) => el.hidden)).toBe(true);
  expect(root.querySelector<HTMLElement>('.match-point')!.hidden).toBe(true);
  game.dispose();
});

it('Watch live rolls on to the next featured match after a cancelable countdown, holding the result until then', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const onExit = vi.fn();
  const { root, game, renderer } = mount({ source: { kind: 'featured' }, grant: { kind: 'team', team: 'nw', delayMs: 3000 }, onExit });
  await game.start();
  const end = () => root.querySelector<HTMLElement>('.obs-end')!;
  const note = () => end().querySelector('.obs-end-note')?.textContent;
  const action = (id: string) => end().querySelector<HTMLElement>(`[data-end-action="${id}"]`)!;
  const announce = (roomId: string) => { for (const match of transport.announce.values()) match({ roomId, delayMs: 3000, armies: ['nw', 'se'], seats: [], label: '', omniscient: false } as never); };
  /** Blue's own fogged final view of a duel it won. */
  const finish = (tick: number) => {
    deliver('nw', 1, tick, { ...observerFrame(tick).world, rank: 1, outcome: 'win' }, clock, { nw: 'win', se: 'loss' });
    clock.now += 2000; game.frame();
  };
  announce('r1');
  finish(1320);
  expect(end().hidden).toBe(false);
  expect(audio.outcome).toHaveBeenCalledWith('win');
  expect(end().querySelector('.outcome-title')?.textContent).toBe('Blue wins');
  expect(note()).toBe('Next match in 15 s');
  expect(end().querySelector('[data-end-action="lobby"]')).toBeNull();
  // "Watch now" only moves this viewer past the result; the relay rotates for everyone on its own.
  expect(action('next').textContent).toBe('Watch now');
  expect(action('next').dataset.tip).toBe('The next match is already live for everyone. This only skips the result screen for you.');
  expect(action('stay').textContent).toBe('Stay');
  expect(action('stay').dataset.tip).toBe('Keep this result on screen. The broadcast keeps going.');
  vi.advanceTimersByTime(5000);
  expect(note()).toBe('Next match in 10 s');
  // The relay announces its next match while the result shows: it waits off screen and its frames are dropped.
  announce('r2');
  const shown = renderer.setView.mock.calls.length;
  deliver('nw', 1, 20, observerFrame(20).world, clock); clock.now += 2000; game.frame();
  expect(renderer.setView.mock.calls.length).toBe(shown);
  expect(end().hidden).toBe(false);
  expect(transport.resync).not.toHaveBeenCalled();
  vi.advanceTimersByTime(10000);
  expect(end().hidden).toBe(true);
  expect(transport.resync).toHaveBeenCalledTimes(2);
  expect(audio.scene).toHaveBeenCalledWith('match');
  // Stay cancels the countdown: the result holds through the next announcement until Watch now.
  finish(1500);
  expect(note()).toBe('Next match in 15 s');
  action('stay').click();
  expect(note()).toBe('');
  expect(action('stay').hidden).toBe(true);
  announce('r3');
  vi.advanceTimersByTime(60000);
  expect(end().hidden).toBe(false);
  action('next').click();
  expect(end().hidden).toBe(true);
  // Watch now before the relay announced one: it follows as soon as the relay does.
  finish(1500);
  action('next').click();
  expect(note()).toBe('Waiting for the next match…');
  announce('r4');
  expect(end().hidden).toBe(true);
  finish(1500);
  action('home').click();
  expect(onExit).toHaveBeenLastCalledWith('home');
  game.dispose();
  vi.useRealTimers();
});

it('a series game ends on its results link and, while the series runs, the next game', async () => {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const onExit = vi.fn();
  const { root, game } = mount({ source: { kind: 'series', access: { kind: 'share', token: 'shared-result' }, matchId: 'm2' }, grant: { ...omniscient, delayMs: 0 }, onExit });
  await game.start();
  const result = (revision: number, state: string, matches: string[]) => ({
    revision, state, summaries: { latency: [], usage: [] },
    activeMatches: matches.map((matchId, index) => ({ matchId, trialId: `t${index + 1}`, attemptId: matchId, attemptNumber: 1, startedAt: '', releaseAt: 0, spec: { map: { id: 'ridges' } } })),
    tables: {
      entrants: [{ entrantId: 'a', label: 'Claude', kind: 'agent' }, { entrantId: 'b', label: 'Veteran bot', kind: 'bot' }],
      schedule: [0, 1, 2].map((index) => ({ trialId: `t${index}`, scheduleIndex: index, mapId: 'ridges', permutationId: 'original', sideBindings: [{ team: 'nw', entrantId: 'a' }, { team: 'se', entrantId: 'b' }] })),
      standings: [], matches: [], seats: [],
    },
  }) as unknown as ResultsSummary;
  series.receive!(result(1, 'running', ['m2']));
  play(game, 'all', { op: 'observer', state: 'ready', frame: { sequence: 1, tick: 1320, recordedAt: 900, releaseAt: 900, perspective: 'all', world: finalFrame(1320), outcomes: { nw: 'win', se: 'loss' } } }, clock);
  const end = root.querySelector<HTMLElement>('.obs-end')!;
  expect(end.querySelector('.outcome-kicker')?.textContent).toBe('Game 2 of 3 · final');
  expect(end.querySelector('.outcome-title')?.textContent).toBe('Claude wins');
  const step = () => end.querySelector<HTMLButtonElement>('[data-end-action="next-game"]');
  expect(step()?.disabled).toBe(true);
  // The next game starts while the result shows.
  series.receive!(result(2, 'running', ['m2', 'm3']));
  expect(step()?.disabled).toBe(false);
  expect(step()?.getAttribute('aria-label')).toBe('Watch Game 3 · ridges');
  const results = end.querySelector<HTMLAnchorElement>('[data-end-action="results"]')!;
  expect(results.getAttribute('href')).toBe('/arena/share/shared-result');
  results.click();
  expect(onExit).toHaveBeenCalledOnce();
  series.receive!(result(3, 'completed', []));
  expect(step()).toBeNull();
  game.dispose();
});
