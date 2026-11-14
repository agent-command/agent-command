// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PLANES, type Plane } from '@agent-command/game/contract';
import { ACTIVITY, ACTIVITY_IDS, AMBIENCE_IDS, SFX, SFX_IDS, loopOf, type ActivityId, type AmbienceId, type SfxId, type SoundKey } from '../src/audio/catalog.ts';
import type { OneShot } from '../src/audio/director.ts';
import { AudioEngine } from '../src/audio/engine.ts';
import { MusicDeck } from '../src/audio/music.ts';
import { fakeBuffer, fakeContext, fakeListener } from './audio-fake.ts';

const WEATHER: readonly Plane[] = ['sky', 'surface'];
const ORBIT: readonly Plane[] = ['orbit'];
const SKY: readonly Plane[] = ['sky'];
const SURFACE: readonly Plane[] = ['surface'];
const DEPTHS: readonly Plane[] = ['depths'];
const UNDERGROUND: readonly Plane[] = ['surface', 'depths'];

/** Planes in view where each plane-bound sound is heard; every other sound is heard from all four. */
const HEARD: Readonly<Partial<Record<SfxId, readonly Plane[]>>> = {
  thunder: WEATHER, seeder_charge: WEATHER, seeder_burst: WEATHER, wind_loop: WEATHER, storm_loop: WEATHER,
  // the ruin's gate loop doubles as the Mother Lode's pressure rumble in the Depths
  gate_loop: ['orbit', 'depths'], radiation_loop: ORBIT, core_pickup: ORBIT, core_heat: ORBIT, vent_hiss: ORBIT, meltdown: ORBIT,
  hum_orbit: ORBIT, tow_loop: ORBIT, tug_tow: ORBIT, lance_charge: ORBIT, lance_fire: ORBIT,
  mine_loop: ORBIT, mine_extract: ORBIT, mine_depleted: ORBIT, cargo_unload: ORBIT, tug_drop: ORBIT,
  hum_air: SKY, rotor_loop: SKY, anchor_on: SKY, anchor_off: SKY, attach_lock: SKY, attach_release: SKY, attach_servo: SKY, gunship_land: SKY,
  treads_loop: SURFACE, machinery_loop: SURFACE, yard_loop: SURFACE, convert_done: SURFACE, flag_loop: SURFACE, post_capture: SURFACE,
  siege_lock: SURFACE, siege_unlock: SURFACE, flak_emplace: SURFACE,
  shaft_lift: UNDERGROUND, breach: UNDERGROUND, dig_in: UNDERGROUND,
  hum_depths: DEPTHS, drill_loop: DEPTHS, dig: DEPTHS, magma: DEPTHS, lode_pick: DEPTHS, backfill: DEPTHS, tremor: DEPTHS,
  w_shotgun: DEPTHS, wall_deploy: DEPTHS, wall_undeploy: DEPTHS, flare_launch: DEPTHS, flare_fizz: DEPTHS,
};
const heard = (id: SfxId, plane: Plane): boolean => (HEARD[id] ?? PLANES).includes(plane);

const ONE_SHOTS = Object.keys(SFX) as OneShot[];
/** Every loop file with how to drive it: an ambience id or an activity category. */
const LOOPS: { id: SfxId; drive: { ambience: AmbienceId } | { activity: ActivityId } }[] = [
  ...AMBIENCE_IDS.map((id) => ({ id, drive: { ambience: id } })),
  ...ACTIVITY_IDS.map((a) => ({ id: ACTIVITY[a].loop, drive: { activity: a } })),
];

/**
 * A match engine on a fake context with `plane` in view; each file decodes to a buffer tagged with its URL, just long
 * enough for its loop (a match decodes every effect: ~300 cases of 95 s fakes outgrew the worker's memory).
 */
function engine(plane: Plane) {
  const listener = fakeListener();
  listener.plane = plane;
  listener.level = PLANES.indexOf(plane);
  listener.dist = 20;
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => new Response(new TextEncoder().encode(String(input)));
  const e = new AudioEngine(listener, fetcher as typeof fetch, new MusicDeck());
  const fake = fakeContext(async (bytes) => {
    const url = new TextDecoder().decode(bytes);
    const key = /(?:music|sfx)\/\w+(?=\.ogg)/.exec(url)?.[0] as SoundKey | undefined;
    return Object.assign(fakeBuffer((key && loopOf(key)?.end) ?? 1), { url });
  });
  e.start(() => fake.ctx);
  e.setScene('match');
  const of = (id: SfxId) => fake.starts.filter((s) => (s.buffer as AudioBuffer & { url: string }).url.includes(`/${id}.ogg`));
  /** Gain target of the loop playing `id` (its source's gain node, last automation). */
  const target = (id: SfxId): number => {
    const gain = of(id)[0]!.src.connect.mock.calls[0]![0] as { gain: { setTargetAtTime: { mock: { calls: number[][] } } } };
    return gain.gain.setTargetAtTime.mock.calls.at(-1)![0]!;
  };
  let t = 1000;
  const frame = (): void => e.frame((t += 16));
  return { e, listener, of, target, frame };
}

describe('plane-bound sounds', () => {
  it('cover every catalog sound: each is a one-shot or a driven loop', () => {
    expect(new Set([...ONE_SHOTS, ...LOOPS.map((l) => l.id)])).toEqual(new Set(SFX_IDS));
  });

  const shots = ONE_SHOTS.flatMap((id) => PLANES.map((plane) => ({ id, plane, audible: heard(id, plane) })));
  it.each(shots)('$id with the $plane in view: audible $audible', async ({ id, plane, audible }) => {
    const { e, of } = engine(plane);
    await e.load(`sfx/${id}`);
    e.sfx(id, plane, 24, 24, 0);
    expect(of(id)).toHaveLength(audible ? 1 : 0);
  });

  const loops = LOOPS.flatMap((loop) => PLANES.map((plane) => ({ ...loop, plane, audible: heard(loop.id, plane) })));
  it.each(loops)('$id loop with the $plane in view: audible $audible', async (loop) => {
    const { e, listener, of, target, frame } = engine(loop.plane);
    if ('ambience' in loop.drive) e.loop(loop.drive.ambience, 0.8);
    else e.activity(loop.drive.activity, 0, 0.8, 0);
    frame();
    await e.load(`sfx/${loop.id}`);
    frame();
    if (!loop.audible) {
      expect(of(loop.id)).toEqual([]);
      return;
    }
    expect(target(loop.id)).toBeGreaterThan(0);
    // the view leaves for a plane where it is silent: retargeted to 0 on the next frame, before any new view
    const away = PLANES.find((p) => !heard(loop.id, p));
    if (!away) return;
    listener.plane = away;
    frame();
    expect(target(loop.id)).toBe(0);
  });
});
