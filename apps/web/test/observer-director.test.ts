import { describe, expect, it } from 'vitest';
import { VISION_BITS_PER_WORD, type ArmyId, type Entity, type GameEvent, type Plane } from '@agent-command/game/contract';
import { ACTION_MIN, DIRECTOR_LIVE, DIRECTOR_STREAM, Director, DirectorCamera, PHONE_FRAMING, type DirectedRig } from '../src/observer-director.ts';
import { lensView, type ObserverSideData } from '../src/observer-model.ts';
import type { MatchView } from '../src/match-view.ts';

const SIZE = 48;
const COLOURS = ['blue', 'red', 'green', 'violet'] as const;
const army = (id: ArmyId, i: number) => ({ id, slot: i, frame: i, colour: COLOURS[i]!, spireAt: { x: 6, y: 6 } });
const RULES = { map: { size: SIZE }, depths: { chargesFogged: true, chargePublicTime: 5 } };
const DUEL = { rules: RULES, terrain: [], armies: [army('nw', 0), army('se', 1)] };
const FFA = { rules: RULES, terrain: [], armies: [army('nw', 0), army('ne', 1), army('se', 2), army('sw', 3)] };
const WORDS = Math.ceil(SIZE * SIZE / VISION_BITS_PER_WORD);
const blind = () => ({ depths: new Array<number>(WORDS).fill(0), surface: new Array<number>(WORDS).fill(0), sky: new Array<number>(WORDS).fill(0), orbit: new Array<number>(WORDS).fill(0) });

interface Fight { x: number; y: number; shots: number; plane?: Plane; side?: string }
interface Scene { fights?: Fight[]; units?: Entity[]; events?: GameEvent[]; match?: typeof DUEL }
interface Clock { tick: number; now: number }

let serial = 0;
const unit = (side: string, kind: string, x: number, y: number, plane: Plane = 'surface') => ({ id: `e_${++serial}`, side, kind, plane, x, y, hp: 100, maxHp: 100, state: 'idle' }) as unknown as Entity;
const squad = (side: string, x: number, y: number, n = 4, kind = 'tank') => Array.from({ length: n }, (_, i) => unit(side, kind, x + (i % 2), y + Math.floor(i / 2)));

function view(clock: Clock, scene: Scene, extra: Partial<MatchView> = {}): MatchView {
  const fx = (scene.fights ?? []).flatMap((f) => Array.from({ length: f.shots }, () => ({ tick: clock.tick, kind: 'shot', plane: f.plane ?? 'surface', x: f.x, y: f.y, side: f.side })));
  return {
    tick: clock.tick, army: 'nw', eliminated: [], fx, events: scene.events ?? [], entities: scene.units ?? [], impacts: [], memory: [], charges: [], flares: [],
    schedule: [], depths: [], islands: [], oreCaches: [], scorches: [], lodes: [], cracks: [], pockets: [],
    weather: { storms: [], forecast: [], fog: [], seeded: [], seedWarnings: [] }, vision: blind(), match: scene.match ?? DUEL, ...extra,
  } as unknown as MatchView;
}

/** Advance `ms` of playback in 250 ms decisions (5 ticks each); returns every cut (shot id change). */
function run(director: Director, clock: Clock, ms: number, scene: Scene | ((clock: Clock) => Scene), perspective = 'all') {
  const cuts: { at: number; reason: string; plane: Plane; x: number; y: number }[] = [];
  for (let t = 0; t < ms; t += 250) {
    clock.tick += 5; clock.now += 250;
    director.ingest(view(clock, typeof scene === 'function' ? scene(clock) : scene), perspective);
    const id = director.shot.id;
    director.decide(clock.now);
    const shot = director.shot;
    if (shot.id !== id) cuts.push({ at: clock.now, reason: shot.reason, plane: shot.plane, x: shot.x, y: shot.y });
  }
  return cuts;
}
const near = (shot: { x: number; y: number }, x: number, y: number, r = 6) => Math.hypot(shot.x - x, shot.y - y) <= r;

describe('interest model', () => {
  it('opens on an establishing overview, then cuts to the fight and frames it', () => {
    const director = new Director(), clock = { tick: 100, now: 1000 };
    const cuts = run(director, clock, 4000, { fights: [{ x: 10, y: 10, shots: 2 }] });
    expect(cuts[0]).toMatchObject({ reason: 'overview', x: SIZE / 2, y: SIZE / 2 });
    expect(cuts.at(-1)).toMatchObject({ reason: 'fight', plane: 'surface' });
    expect(near(director.shot, 10, 10, 3)).toBe(true);
    expect(director.shot.radius).toBeGreaterThanOrEqual(DIRECTOR_LIVE.minRadius);
  });

  it('weighs a fight by the value at stake: a lost tank outweighs the same shots over troopers', () => {
    const director = new Director(), clock = { tick: 100, now: 1000 };
    const kill = (x: number, subject: string) => ({ tick: clock.tick + 5, kind: 'enemy_killed', plane: 'surface', x, y: 30, subject, side: 'se' }) as unknown as GameEvent;
    const both = [{ x: 8, y: 30, shots: 2 }, { x: 40, y: 30, shots: 2 }];
    run(director, clock, 250, { fights: both, events: [kill(8, 'trooper'), kill(40, 'tank')] });
    run(director, clock, 3000, { fights: both });
    expect(director.shot.reason).toBe('fight');
    expect(near(director.shot, 40, 30)).toBe(true);
  });

  it('anticipates: forces closing in draw the camera before the first shot is fired', () => {
    const director = new Director(), clock = { tick: 100, now: 1000 };
    const closing = (c: Clock) => {
      const k = Math.min(1, (c.now - 1000) / 8000);
      return { units: [...squad('nw', 6 + 14 * k, 24), ...squad('se', 40 - 14 * k, 24)] };
    };
    const cuts = run(director, clock, 9000, closing);
    const push = cuts.find((cut) => cut.reason === 'push');
    expect(push, JSON.stringify(cuts)).toBeDefined();
    expect(push!.x).toBeGreaterThan(14);
    expect(push!.x).toBeLessThan(34);
  });

  it('reads public telegraphs: a falling rock about to land and a Mother Lode about to vent', () => {
    const director = new Director(), clock = { tick: 100, now: 1000 };
    run(director, clock, 6500, {});
    expect(director.shot.reason).toMatch(/overview|spotlight/);
    const lode = { pressure: 95, rate: 2, state: 'critical', ventAt: clock.tick + 40, x: 24, y: 24 };
    for (let i = 0; i < 20; i++) {
      clock.tick += 5; clock.now += 250;
      director.ingest(view(clock, {}, { motherLode: lode } as Partial<MatchView>), 'all');
      director.decide(clock.now);
    }
    expect(director.shot).toMatchObject({ plane: 'depths', reason: 'hazard' });
    // A rock announced 8 s (160 ticks) out: the camera is on its landing site before it lands.
    const impacts = [{ x: 30, y: 12, tick: clock.tick + 160, side: 'neutral', id: 'e_9' }];
    let landed = false;
    for (let i = 0; i < 28 && !landed; i++) {
      clock.tick += 5; clock.now += 250;
      director.ingest(view(clock, {}, { impacts } as Partial<MatchView>), 'all');
      director.decide(clock.now);
      landed = director.shot.reason === 'hazard' && director.shot.plane === 'surface';
    }
    expect(landed).toBe(true);
    expect(clock.tick).toBeLessThan(impacts[0]!.tick);
    expect(near(director.shot, 30, 12)).toBe(true);
  });

  it('objectives: a storm over a contested island draws the sky; a cut lava bridge draws the depths', () => {
    const director = new Director(), clock = { tick: 100, now: 1000 };
    const island = { ...unit('neutral', 'island', 20, 30, 'sky'), state: 'contested' } as Entity;
    const storm = { id: 1, x: 22, y: 30, radius: 6, maxRadius: 6, strength: 1, stage: 'mature' };
    const stormy = (c: Clock) => view(c, { units: [island] }, { weather: { storms: [storm], forecast: [], fog: [], seeded: [], seedWarnings: [] } } as unknown as Partial<MatchView>);
    for (let i = 0; i < 16; i++) { clock.tick += 5; clock.now += 250; director.ingest(stormy(clock), 'all'); director.decide(clock.now); }
    expect(director.shot).toMatchObject({ plane: 'sky', reason: 'hazard' });
    expect(near(director.shot, 20, 30)).toBe(true);
    const cut = (c: Clock) => [{ tick: c.tick, kind: 'structure_destroyed', plane: 'depths', x: 36, y: 14, subject: 'lava_bridge', side: 'se' }] as unknown as GameEvent[];
    const cuts = run(director, clock, 9000, (c) => ({ events: c.now % 2000 === 0 ? cut(c) : [], fights: [{ x: 36, y: 14, shots: 1, plane: 'depths' }] }));
    expect(cuts.at(-1)).toMatchObject({ plane: 'depths' });
    expect(near(director.shot, 36, 14)).toBe(true);
  });
});

describe('cut policy', () => {
  /** Settle on fight A at (10, 10), two shots a step: about 25 interest. */
  function onA(preset = DIRECTOR_LIVE) {
    const director = new Director(); director.preset = preset;
    const clock = { tick: 100, now: 1000 };
    run(director, clock, 6000, { fights: [{ x: 10, y: 10, shots: 2 }] });
    expect(near(director.shot, 10, 10)).toBe(true);
    return { director, clock, since: director.shot.since };
  }

  it('holds the minimum dwell, then cuts only to a clearly bigger fight (hysteresis)', () => {
    const { director, clock, since } = onA();
    // B 1.5× A: never enough to leave A while A stays hot (until the max dwell).
    const slight = run(director, clock, 10_000, { fights: [{ x: 10, y: 10, shots: 2 }, { x: 38, y: 38, shots: 3 }] });
    expect(slight).toEqual([]);
    expect(clock.now - since).toBeLessThan(DIRECTOR_LIVE.maxDwellMs);
    // B 4× A: a cut, and never before the minimum dwell.
    const fresh = onA();
    const cuts = run(fresh.director, fresh.clock, 8000, (c) => ({ fights: [{ x: 10, y: 10, shots: 2 }, ...(c.now >= fresh.since + 1000 ? [{ x: 38, y: 38, shots: 8 }] : [])] }));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.at - fresh.since).toBeGreaterThanOrEqual(DIRECTOR_LIVE.minDwellMs);
    expect(near(cuts[0]!, 38, 38)).toBe(true);
  });

  it('never ping-pongs: a location just shown needs far more to win the camera back', () => {
    const { director, clock } = onA();
    run(director, clock, 6000, { fights: [{ x: 10, y: 10, shots: 2 }, { x: 38, y: 38, shots: 8 }] });
    expect(near(director.shot, 38, 38)).toBe(true);
    // A flares to 1.6× B: without the revisit cooldown that would be a cut back after the dwell.
    const back = run(director, clock, 12_000, { fights: [{ x: 10, y: 10, shots: 7 }, { x: 38, y: 38, shots: 4 }] });
    expect(back).toEqual([]);
  });

  it('leaves a shot that went quiet, and varies after the maximum dwell', () => {
    const { director, clock } = onA();
    const quiet = run(director, clock, 9000, (c) => ({ fights: c.now < 7000 ? [{ x: 10, y: 10, shots: 2 }] : [{ x: 36, y: 12, shots: 1 }] }));
    expect(quiet.at(-1)).toMatchObject({ reason: 'fight' });
    expect(near(director.shot, 36, 12)).toBe(true);
    const long = onA();
    const varied = run(long.director, long.clock, DIRECTOR_LIVE.maxDwellMs + 1000, { fights: [{ x: 10, y: 10, shots: 3 }, { x: 38, y: 38, shots: 2 }] });
    expect(varied).toHaveLength(1);
    expect(varied[0]!.at - long.since).toBeGreaterThanOrEqual(DIRECTOR_LIVE.maxDwellMs);
  });

  it('an urgent moment cuts in early and holds, even against a hotter fight', () => {
    const { director, clock, since } = onA();
    let at = 0;
    const fall = (c: Clock) => [{ tick: (at ||= c.tick), kind: 'army_eliminated', plane: 'surface', x: 40, y: 40, side: 'se', killer: 'nw' }] as unknown as GameEvent[];
    const cuts = run(director, clock, 8000, (c) => ({ fights: [{ x: 10, y: 10, shots: 6 }], events: c.now >= since + 2000 ? fall(c) : [] }));
    expect(cuts[0]).toMatchObject({ reason: 'elimination' });
    expect(cuts[0]!.at - since).toBeLessThan(DIRECTOR_LIVE.minDwellMs);
    expect(near(cuts[0]!, 40, 40)).toBe(true);
    // Held for the urgent hold even though A is hotter; only then back to the action.
    expect(cuts.length === 1 || cuts[1]!.at - cuts[0]!.at >= DIRECTOR_LIVE.urgentHoldMs).toBe(true);
  });

  it('the stream preset takes a breather overview during a long, moderate fight, then returns', () => {
    const director = new Director(); director.preset = DIRECTOR_STREAM;
    const clock = { tick: 100, now: 1000 };
    const cuts = run(director, clock, 100_000, { fights: [{ x: 10, y: 10, shots: 1 }] });
    const first = cuts.findIndex((cut) => cut.reason === 'fight');
    const breather = cuts.findIndex((cut, i) => i > first && cut.reason === 'overview');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(breather, JSON.stringify(cuts)).toBeGreaterThan(first);
    expect(cuts[breather]!.at - cuts[0]!.at).toBeGreaterThanOrEqual(DIRECTOR_STREAM.overviewEveryMs);
    expect(cuts[breather]!.at - cuts[breather - 1]!.at).toBeGreaterThanOrEqual(DIRECTOR_STREAM.maxDwellMs / 2);
    expect(cuts[breather + 1]).toMatchObject({ reason: 'fight' });
  });

  it('the stream preset holds longer and roomier than the live one', () => {
    const live = onA(DIRECTOR_LIVE), stream = onA(DIRECTOR_STREAM);
    const big = { fights: [{ x: 10, y: 10, shots: 2 }, { x: 38, y: 38, shots: 10 }] };
    const liveCut = run(live.director, live.clock, 9000, big)[0]!;
    const streamCut = run(stream.director, stream.clock, 9000, big)[0]!;
    expect(streamCut.at - stream.since).toBeGreaterThan(liveCut.at - live.since);
    expect(streamCut.at - stream.since).toBeGreaterThanOrEqual(DIRECTOR_STREAM.minDwellMs);
    expect(stream.director.shot.radius).toBeGreaterThanOrEqual(live.director.shot.radius);
  });

  it('quiet stretches alternate the overview with a spotlight on the army shown least', () => {
    const director = new Director(), clock = { tick: 100, now: 1000 };
    const units = [...squad('nw', 8, 8, 2, 'trooper'), ...squad('se', 40, 40, 2, 'trooper')];
    const cuts = run(director, clock, DIRECTOR_LIVE.overviewMs * 3 + 500, { units });
    expect(cuts.map((cut) => cut.reason)).toEqual(['overview', 'spotlight', 'overview', 'spotlight']);
    expect(near(cuts[1]!, 8, 8) || near(cuts[1]!, 40, 40)).toBe(true);
    expect(near(cuts[3]!, 8, 8) !== near(cuts[1]!, 8, 8)).toBe(true);
  });

  it('is fair across armies: between equal fights it shows the armies it has shown least', () => {
    const director = new Director(), clock = { tick: 100, now: 1000 };
    // A long nw-vs-ne fight at C, then it ends; A (nw vs ne, a third hotter) and B (se vs sw) begin.
    const c = { fights: [{ x: 24, y: 40, shots: 3 }], units: [...squad('nw', 24, 40, 2, 'trooper'), ...squad('ne', 25, 41, 2, 'trooper')], match: FFA };
    run(director, clock, 15_000, c);
    expect(near(director.shot, 24, 40)).toBe(true);
    const ab = {
      fights: [{ x: 8, y: 8, shots: 4 }, { x: 40, y: 8, shots: 3 }], match: FFA,
      units: [...squad('nw', 8, 8, 2, 'trooper'), ...squad('ne', 9, 9, 2, 'trooper'), ...squad('se', 40, 8, 2, 'trooper'), ...squad('sw', 41, 9, 2, 'trooper')],
    };
    const cuts = run(director, clock, 12_000, ab);
    expect(cuts.length).toBeGreaterThan(0);
    expect(near(cuts[0]!, 40, 8), JSON.stringify(cuts)).toBe(true);
  });
});

describe('fog', () => {
  /** nw sees only the top-left 16×16 tiles; ne and se fight unseen at (40, 40). */
  function scene(clock: Clock) {
    const vision = blind();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const cell = y * SIZE + x; vision.surface[Math.floor(cell / VISION_BITS_PER_WORD)]! |= 1 << (cell % VISION_BITS_PER_WORD); }
    const units = [...squad('nw', 8, 8, 2, 'trooper'), ...squad('ne', 40, 40), ...squad('se', 41, 41)];
    const fx = Array.from({ length: 8 }, () => ({ tick: clock.tick, kind: 'shot', plane: 'surface', x: 40, y: 40, side: 'ne' }));
    const events = [{ tick: clock.tick, kind: 'enemy_killed', plane: 'surface', x: 40, y: 40, subject: 'tank', side: 'se' }] as unknown as GameEvent[];
    const world = { ...view(clock, { units, match: FFA }), fx } as unknown as MatchView;
    const sides = (['nw', 'ne', 'se', 'sw'] as const).map((id) => ({ army: id, vision: id === 'nw' ? vision : blind(), events: id === 'ne' ? events : [], res: {}, spire: [], queue: [], research: {}, forces: [] })) as unknown as ObserverSideData[];
    return { world, sides };
  }

  it('never targets units or fights hidden by an army lens, and forgets what All showed on a perspective change', () => {
    const director = new Director(), clock = { tick: 100, now: 1000 };
    // Sanity: the omniscient perspective goes to the hidden fight.
    for (let i = 0; i < 24; i++) {
      clock.tick += 5; clock.now += 250;
      const { world, sides } = scene(clock);
      director.ingest(world, 'all', sides);
      director.decide(clock.now);
    }
    expect(near(director.shot, 40, 40)).toBe(true);
    // nw's lens: the shot drops at once and nothing near the fight is ever chosen.
    for (let i = 0; i < 160; i++) {
      clock.tick += 5; clock.now += 250;
      const { world, sides } = scene(clock);
      director.ingest(lensView(world, sides[0]!), 'nw');
      director.decide(clock.now);
      expect(director.shot.active).toBe(true);
      if (director.shot.reason !== 'overview') expect(near(director.shot, 40, 40, 14), `${i} ${JSON.stringify(director.shot)}`).toBe(false);
    }
  });

  it('a fogged perspective never reads other armies\' event windows', () => {
    const director = new Director(), clock = { tick: 100, now: 1000 };
    const fall = (c: Clock) => [{ tick: c.tick, kind: 'army_eliminated', plane: 'surface', x: 40, y: 40, side: 'se', killer: 'nw' }] as unknown as GameEvent[];
    // Windows passed with a fogged perspective are ignored: calm, an establishing shot.
    for (let i = 0; i < 24; i++) {
      clock.tick += 5; clock.now += 250;
      director.ingest(view(clock, {}), 'nw', [{ events: [] }, { events: fall(clock) }]);
      director.decide(clock.now);
      expect(director.shot.reason).toBe('overview');
    }
    // The same elimination in that perspective's own window is read: an urgent cut.
    const cuts = run(director, clock, 1000, (c) => ({ events: fall(c) }), 'nw');
    expect(cuts[0]).toMatchObject({ reason: 'elimination' });
  });
});

describe('camera operator', () => {
  /** A plain rig the operator can drive (it satisfies DirectedRig); the test moves its dive level by hand. */
  function rig() {
    const r = {
      tx: -20, tz: -20, dist: 30, yaw: 0, focus: 'surface' as Plane, level: 1, diving: false, minDist: 12, maxDist: 78, dives: [] as Plane[],
      goTo(plane: Plane) { r.dives.push(plane); r.focus = plane; r.diving = true; },
      fitDistance: (radius: number, padding: number) => radius * padding * 2,
    };
    return r satisfies DirectedRig;
  }
  function aimed(x: number, y: number, plane: Plane = 'surface', radius = 10) {
    const director = new Director(), clock = { tick: 100, now: 1000 };
    director.ingest(view(clock, {}), 'all');
    Object.assign(director.shot, { active: true, id: 7, plane, x, y, radius, reason: 'fight', since: 0 });
    return director;
  }

  it('eases out and in under a speed limit, frames the action and never overshoots', () => {
    const r = rig(), director = aimed(44, 44), camera = new DirectorCamera();
    const goal = { x: 44 - SIZE / 2, z: 44 - SIZE / 2 };
    let last = Math.hypot(goal.x - r.tx, goal.z - r.tz), firstStep = 0, maxStep = 0;
    for (let i = 0; i < 300; i++) {
      const before = { x: r.tx, z: r.tz };
      camera.frame(r, director, i * 16, 1 / 60, false);
      const step = Math.hypot(r.tx - before.x, r.tz - before.z);
      if (i === 0) firstStep = step;
      maxStep = Math.max(maxStep, step);
      const left = Math.hypot(goal.x - r.tx, goal.z - r.tz);
      expect(left).toBeLessThanOrEqual(last + 1e-6);
      last = left;
    }
    expect(firstStep).toBeLessThan(maxStep / 4);
    expect(maxStep * 60).toBeLessThanOrEqual(Math.max(DIRECTOR_LIVE.panSpeed * 78, 0) + 1e-6);
    expect(last).toBeLessThan(0.2);
    expect(r.dist).toBeGreaterThan(10 * DIRECTOR_LIVE.padding * 2 * 0.9);
    expect(r.dist).toBeLessThan(10 * DIRECTOR_LIVE.padding * 2 * 1.05);
  });

  it('drifts gently while holding; reduced motion cuts instead of moving and never drifts', () => {
    const r = rig(), director = aimed(24, 24), camera = new DirectorCamera();
    for (let i = 0; i < 600; i++) camera.frame(r, director, i * 16, 1 / 60, false);
    expect(Math.abs(r.yaw)).toBeGreaterThan(0.05);
    expect(Math.abs(r.yaw)).toBeLessThan(0.5);
    const still = rig(), cut = new DirectorCamera();
    cut.frame(still, director, 0, 1 / 60, true);
    expect(still).toMatchObject({ tx: 0, tz: 0, dist: 10 * DIRECTOR_LIVE.padding * 2, yaw: 0 });
    for (let i = 1; i < 300; i++) cut.frame(still, director, i * 16, 1 / 60, true);
    expect(still.yaw).toBe(0);
  });

  it('frames tighter on a phone, by PHONE_FRAMING, without changing desktop framing', () => {
    const director = aimed(24, 24);
    const desk = rig(), phone = rig();
    new DirectorCamera().frame(desk, director, 0, 1 / 60, true);
    new DirectorCamera(PHONE_FRAMING).frame(phone, director, 0, 1 / 60, true);
    expect(PHONE_FRAMING).toBeLessThan(1);
    expect(desk.dist).toBe(10 * DIRECTOR_LIVE.padding * 2);
    expect(phone.dist).toBeCloseTo(desk.dist * PHONE_FRAMING);
  });

  it('dives to another plane and jumps under the dive, not before its midpoint', () => {
    const r = rig(), director = aimed(40, 8, 'orbit'), camera = new DirectorCamera();
    camera.frame(r, director, 0, 1 / 60, false);
    expect(r.dives).toEqual(['orbit']);
    expect(r.tx).toBe(-20);
    r.level = 1.8;
    camera.frame(r, director, 16, 1 / 60, false);
    expect(r.tx).toBe(-20);
    r.level = 2.2;
    camera.frame(r, director, 32, 1 / 60, false);
    expect({ tx: r.tx, tz: r.tz }).toEqual({ tx: 40 - SIZE / 2, tz: 8 - SIZE / 2 });
    camera.frame(r, director, 48, 1 / 60, false);
    expect(r.dives).toEqual(['orbit']);
  });
});
