import { describe, expect, it, vi } from 'vitest';
import { InstancedBufferGeometry, Mesh } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { KINDS, PLANE_Y, VISION_BITS_PER_WORD, type Kind, type View } from '@agent-command/game/contract';
import { GROUND } from '../src/world/common.ts';
import { Combat } from '../src/world/combat.ts';
import { DEATH_STAGE_CAP, DeathPlayer, REDUCED_FADE_MS } from '../src/world/death-fx.ts';
import { DEATH_FX, DEATH_PLANES, deathClass, deathProfile, deathScale } from '../src/world/death-profiles.ts';
import { Entities } from '../src/world/entities.ts';
import { FogField } from '../src/world/fog.ts';
import { REVEALED, type ParticlePool } from '../src/world/gpu-particles.ts';
import { QUALITY } from '../src/world/quality.ts';
import { TerrainField } from '../src/world/terrain.ts';
import { WeatherLayer } from '../src/world/weather.ts';
import { cpuPool } from './cpu-pool.ts';

type FxEntry = View['fx'][number];
const game = createGame({ seed: 7 });
const base = game.view('nw');
const size = game.sim.size;
const WORDS = Math.ceil((size * size) / VISION_BITS_PER_WORD);
const ALL = 2 ** VISION_BITS_PER_WORD - 1;
const noSelection = new Set<string>();
/** Sight of every plane, the Sky's cells as given (0: the storm closed over them). */
const sight = (sky: number): View['vision'] => ({
  depths: new Array<number>(WORDS).fill(ALL), surface: new Array<number>(WORDS).fill(ALL),
  sky: new Array<number>(WORDS).fill(sky), orbit: new Array<number>(WORDS).fill(ALL),
});
const flyer = base.entities.find((e) => e.kind === 'interceptor' && e.side === 'nw')!;

/** Live particle heights, from the CPU pool's instance matrices (offline renderers and tests). */
const heights = (pool: ParticlePool): number[] => {
  const m = cpuPool(pool).mesh.instanceMatrix.array;
  return Array.from({ length: pool.n }, (_, i) => m[i * 16 + 13]!);
};
/** Unit models drawn (every kind's instanced draw, renderOrder 40). */
const drawn = (units: Entities): number => units.root.children.reduce((n, child) =>
  n + (child instanceof Mesh && child.renderOrder === 40 && child.geometry instanceof InstancedBufferGeometry ? child.geometry.instanceCount : 0), 0);

function scene() {
  const terrain = new TerrainField(size), fog = new FogField(size);
  const units = new Entities(false, undefined, size, terrain, fog);
  const combat = new Combat(undefined, size, terrain, fog);
  combat.tracks = units.tracks;
  units.deaths = combat.deaths;
  const weather = new WeatherLayer(size);
  let now = 1000;
  const show = (view: View) => {
    units.ingest(view, now);
    fog.ingestVision(view);
    combat.ingest(view, (tick) => units.tickTime(tick, now));
  };
  /** Frames at 60 fps for `ms`, in World's order (entities, storm openings, effects). */
  const run = (ms: number) => {
    for (const end = now + ms; now < end; now += 16) {
      units.frame(now, now / 1000, noSelection, undefined, 'nw', 'sky', 26);
      weather.cutaways(units.tracks, units.root, fog, undefined, combat.deaths);
      combat.frame(now, 0.016, 100, units.renderTick);
    }
  };
  return { terrain, fog, units, combat, weather, show, run, view: (tick: number, patch: Partial<View> = {}): View => ({ ...base, tick, entities: [], fx: [], ...patch }) };
}

describe('death profiles', () => {
  it.each(KINDS)('%s resolves to a profile its player can run', (kind) => {
    const p = deathProfile(kind);
    expect(p.stages.length).toBeGreaterThan(0);
    expect(p.stages.length).toBeLessThanOrEqual(DEATH_STAGE_CAP);
    expect((p.landing ?? []).length).toBeLessThanOrEqual(DEATH_STAGE_CAP);
    expect(deathScale(kind)).toBeGreaterThan(0);
    expect(Number.isFinite(deathScale(kind))).toBe(true);
    for (const s of p.stages) expect(s.at).toBeGreaterThanOrEqual(0);
    // every drawn model leaves through its death (Spire segments: spires.ts draws the casing)
    if (kind !== 'spire') expect(p.stages.some((s) => s.kind === 'collapse' || s.kind === 'wreck')).toBe(true);
  });

  it('inherits by class and keeps per-kind looks in the table', () => {
    expect(['trooper', 'breacher'].map((k) => deathClass(k as Kind))).toEqual(['infantry', 'infantry']);
    expect(['tank', 'flak'].map((k) => deathClass(k as Kind))).toEqual(['vehicle', 'vehicle']);
    expect(['interceptor', 'bomber', 'gunship'].map((k) => deathClass(k as Kind))).toEqual(['air', 'air', 'air']);
    expect(['solar', 'tug', 'lancer', 'skiff', 'bastion'].every((k) => deathClass(k as Kind) === 'orbit')).toBe(true);
    expect(['digger', 'sapper', 'warden'].every((k) => deathClass(k as Kind) === 'depths')).toBe(true);
    expect(['shaft', 'turret', 'relay', 'headframe', 'bulkhead'].every((k) => deathClass(k as Kind) === 'structure')).toBe(true);
    expect(deathClass('spire')).toBe('spire');
    for (const kind of Object.keys(DEATH_FX)) expect(KINDS).toContain(kind);
    // aircraft fall; Orbit ships never smoke; buildings come down in stages
    for (const k of ['interceptor', 'bomber', 'gunship'] as const) expect(deathProfile(k).stages.some((s) => s.kind === 'wreck')).toBe(true);
    for (const k of ['solar', 'tug', 'lancer', 'skiff', 'bastion'] as const) expect(deathProfile(k).stages.some((s) => s.kind === 'smoke')).toBe(false);
    expect(new Set(deathProfile('shaft').stages.map((s) => s.at)).size).toBeGreaterThanOrEqual(4);
    expect(deathScale('headframe')).toBeGreaterThan(deathScale('turret'));
    expect(deathScale('tank')).toBeGreaterThan(deathScale('trooper'));
  });
});

describe('death player', () => {
  it('plays an owned aircraft\'s death inside a storm before the track leaves: corpse, unfogged particles, an opening', () => {
    const w = scene();
    const x = 24.5, y = 24.5;
    for (let t = 0; t <= 10; t++) {
      w.show(w.view(t, { entities: [{ ...flyer, x, y, state: 'idle' }], vision: sight(ALL) }));
      w.run(50);
    }
    expect(drawn(w.units)).toBe(1);
    const spawn = vi.spyOn(w.combat.sparks, 'spawn');
    // It dies in a storm: the record arrives as the storm takes its cell back (it was the last eye there).
    const death: FxEntry = { tick: 11, kind: 'death', plane: 'sky', x, y, side: 'nw', subject: 'interceptor' };
    w.show(w.view(11, { fx: [death], vision: sight(0) }));
    expect(w.fog.tileVisible('sky', x, y)).toBe(false);
    expect(w.units.tracks.size).toBe(0);
    expect(w.combat.deaths.active).toBe(1);
    w.run(16);
    // still drawn while its tick is not yet on screen, and the storm stays open round it
    expect(drawn(w.units)).toBe(1);
    expect(w.weather.unitCount).toBe(1);
    w.run(250);
    expect(spawn).toHaveBeenCalled();
    // the record proved the view may watch: no fog fade, though no one sees the cell now
    expect(spawn.mock.calls.every(([plane]) => plane >= REVEALED)).toBe(true);
    expect(drawn(w.units)).toBe(1);
    expect(w.weather.unitCount).toBe(1);
    // the wreck falls out of the Sky, smoking, and is gone once it strikes the ground
    const top = w.weather.units[0]!.y;
    w.run(600);
    expect(w.weather.units[0]!.y).toBeLessThan(top - 1);
    expect(w.combat.smoke.n).toBeGreaterThan(0);
    w.run(2500);
    expect(drawn(w.units)).toBe(0);
    expect(w.weather.unitCount).toBe(0);
    w.run(4000);
    expect(w.combat.deaths.active).toBe(0);
  });

  it('a unit leaving the view without a death record goes at once and plays nothing', () => {
    const w = scene();
    for (let t = 0; t <= 6; t++) {
      w.show(w.view(t, { entities: [{ ...flyer, x: 20, y: 20, state: 'idle' }] }));
      w.run(50);
    }
    // a record elsewhere (another unit's) is not this one's death
    w.show(w.view(7, { fx: [{ tick: 7, kind: 'death', plane: 'sky', x: 40, y: 40, side: 'nw', subject: 'interceptor' }] }));
    w.run(16);
    expect(drawn(w.units)).toBe(0);
    expect(w.combat.deaths.slots.filter((d) => d.live && d.corpse)).toEqual([]);
  });

  it('reduced motion: the model fades in place, with no particles, rings or shake', () => {
    const terrain = new TerrainField(size);
    const combat = new Combat(undefined, size, terrain);
    const player = new DeathPlayer({ sparks: combat.sparks, smoke: combat.smoke, debris: combat.debris, rings: combat.rings }, size, terrain, undefined, () => true);
    player.add({ tick: 20, kind: 'death', plane: 'surface', x: 24, y: 24, side: 'nw', subject: 'tank' }, 0, 0.5, 0, 1000);
    player.frame(1000, 0.016, 20);
    player.frame(1000 + REDUCED_FADE_MS / 2, 0.016, 21);
    const slot = player.slots.find((d) => d.live)!;
    expect(slot.alpha).toBeCloseTo(0.5, 1);
    expect([slot.pitch, slot.oy, slot.build, slot.scaleK]).toEqual([0, 0, 1, 1]);
    expect(combat.sparks.n + combat.smoke.n + combat.debris.n + combat.rings.n).toBe(0);
    expect(player.shake).toBe(0);
    player.frame(1001 + REDUCED_FADE_MS, 0.016, 22);
    expect(player.active).toBe(0);
  });

  it('caps concurrent deaths per tier and thins the phone tier\'s particles', () => {
    const terrain = new TerrainField(size);
    const spawned = (tier: keyof typeof QUALITY, deaths: number) => {
      const combat = new Combat(undefined, size, terrain);
      combat.deaths.configure(QUALITY[tier]);
      const fx: FxEntry[] = Array.from({ length: deaths }, (_, i) => ({ tick: 30, kind: 'death', plane: 'surface', x: 4 + i, y: 24, side: 'se', subject: 'tank' }));
      combat.ingest({ ...base, tick: 30, fx }, (t) => t * 50);
      combat.frame(2000, 0, 100, 30);
      // the chunks fly 30-60 ms in
      combat.frame(2100, 0, 100, 32);
      return { active: combat.deaths.active, debris: combat.debris.n };
    };
    expect(spawned('full', 40).active).toBe(QUALITY.full.deaths.cap);
    expect(spawned('phone', 40).active).toBe(QUALITY.phone.deaths.cap);
    const full = spawned('full', 1).debris, phone = spawned('phone', 1).debris;
    expect(phone).toBeLessThan(full);
    expect(phone).toBeGreaterThan(0);
  });

  it('keeps a Depths death inside its tunnel, and an Orbit death a vacuum burst: no smoke, nothing falls', () => {
    const terrain = new TerrainField(size);
    const depths = new Combat(undefined, size, terrain);
    depths.ingest({ ...base, tick: 30, fx: [{ tick: 30, kind: 'death', plane: 'depths', x: 24, y: 24, side: 'nw', subject: 'warden' }] } as View, (t) => t * 50);
    const roof = PLANE_Y.depths + GROUND.depths + DEATH_PLANES.depths.ceiling;
    let peak = -Infinity;
    for (let f = 0; f < 90; f++) {
      depths.frame(2000 + f * 16, 0.016, 100, 30 + f);
      for (const pool of [depths.sparks, depths.smoke, depths.debris]) for (const h of heights(pool)) peak = Math.max(peak, h);
    }
    expect(peak).toBeGreaterThan(PLANE_Y.depths);
    expect(peak).toBeLessThanOrEqual(roof + 0.6);
    const orbit = new Combat(undefined, size, terrain);
    orbit.ingest({ ...base, tick: 30, fx: [{ tick: 30, kind: 'death', plane: 'orbit', x: 24, y: 24, side: 'nw', subject: 'bastion' }] } as View, (t) => t * 50);
    let smoke = 0, sparks = 0, rings = 0;
    for (let f = 0; f < 120; f++) {
      orbit.frame(2000 + f * 16, 0.016, 100, 30 + f);
      smoke = Math.max(smoke, orbit.smoke.n);
      sparks = Math.max(sparks, orbit.sparks.n);
      rings = Math.max(rings, orbit.rings.n);
      // a second in, the hull plates still drift in the plane, off its floor
      if (f === 60) {
        expect(orbit.debris.n).toBeGreaterThan(10);
        for (const h of heights(orbit.debris)) expect(h).toBeGreaterThan(PLANE_Y.orbit + GROUND.orbit + 0.05);
      }
    }
    expect(smoke).toBe(0);
    expect(sparks).toBeGreaterThan(10);
    expect(rings).toBeGreaterThanOrEqual(2);
  });
});
