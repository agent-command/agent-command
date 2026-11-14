import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGame } from '@agent-command/game';
import { PLANES, PLANE_Y, SURFACE, type Entity, type Plane, type View } from '@agent-command/game/contract';
import { Mesh } from 'three/webgpu';
import { SPIRE_HEIGHT, SPIRE_SPAN, Spires } from '../src/world/spires.ts';
import { Combat } from '../src/world/combat.ts';
import { applyFade } from '../src/world/fade.ts';
import { TerrainField } from '../src/world/terrain.ts';

const base = createGame({ seed: 7 }).view('nw', { snapshot: true });
const own = base.entities.find(e => e.kind === 'spire' && e.plane === 'sky')!;
const enemyAt = base.match!.armies.find(a => a.id === 'se')!.spireAt;
const enemy: Entity = { ...own, id: 'enemy-spire', side: 'se', ...enemyAt };
const death: View['fx'][number] = { kind: 'death', subject: 'spire', side: 'se', plane: 'sky', ...enemyAt, tick: 12 };
const noVision = Object.fromEntries(PLANES.map(p => [p, base.vision[p].map(() => 0)])) as View['vision'];
const fixture = (patch: Partial<View> = {}): View => ({ ...base, tick: 10, entities: [], fx: [], memory: [], eliminated: [], vision: noVision, ...patch });
// Crystals and casings draw in the scene pass (`root`); the connectors between planes draw after the Sky's storms.
const mesh = (s: Spires, army: string, plane: Plane, part: string) => (part === 'link' ? s.aboveStorm : s.root).getObjectByName(`spire-${army}-${plane}-${part}`) as Mesh;
function setup() {
  const s = new Spires(48, false);
  s.place(base.match!.armies);
  applyFade(3);
  return s;
}
afterEach(() => { applyFade(1); vi.restoreAllMocks(); });

describe('Spire visual lifecycle', () => {
  it('seats the Surface crystal, base, adjacent links and muzzle on elevated terrain without moving other planes', () => {
    const terrain = new TerrainField(48);
    terrain.setHeights(new Uint8Array(48 * 48).fill(SURFACE.high), new Map());
    const s = new Spires(48, false, undefined, terrain);
    const at = base.match!.armies.find(a => a.id === 'nw')!.spireAt;
    s.place(base.match!.armies); s.frame(10, 0, true, true);
    const ground = terrain.groundAt(at.x, at.y);
    const surface = s.root.getObjectByName('spire-nw-surface')!;
    expect(ground).toBeGreaterThan(0.6);
    expect(surface.position.y).toBeCloseTo(PLANE_Y.surface + ground);
    expect(s.root.getObjectByName('spire-nw-sky')!.position.y).toBe(PLANE_Y.sky);
    const link = mesh(s, 'nw', 'surface', 'link');
    expect(link.position.y - link.scale.y / 2).toBeCloseTo(surface.position.y + SPIRE_SPAN.surface[1] + 0.3);
    // A connector rising through a storm is a post-storm effect, never a scene-pass draw the storm paints over.
    expect(s.root.getObjectByName('spire-nw-surface-link')).toBeUndefined();
    expect(s.connectorsShown).toBe(true);
    const combat = new Combat(undefined, 48, terrain);
    const shots = vi.spyOn(combat.shots, 'add');
    combat.ingest(fixture({ fx: [{ kind: 'shot', subject: 'spire', w: 'beam', side: 'nw', plane: 'surface', tick: 10, ...at, tp: 'surface', tx: at.x + 3, ty: at.y }] }), t => t * 50);
    expect(shots.mock.calls[0]![3]).toBeCloseTo(surface.position.y + SPIRE_HEIGHT.surface);
    terrain.setHeights(new Uint8Array(48 * 48).fill(SURFACE.ground), new Map());
    s.frame(10, 1, true, true);
    expect(surface.position.y).toBeCloseTo(PLANE_Y.surface + terrain.groundAt(at.x, at.y));
    s.dispose();
  });

  it('keeps crystal scale and motion coherent across planes and freezes reduced motion without a pose jump', () => {
    const s = setup();
    s.frame(0, 1, false, true);
    const first = mesh(s, 'nw', 'surface', 'core');
    const height = first.position.y, angle = first.rotation.y;
    s.frame(0, 1.1, false, true);
    expect(first.position.y).not.toBe(height);
    expect(first.rotation.y).toBeGreaterThan(angle);
    for (const plane of PLANES) {
      const core = mesh(s, 'nw', plane, 'core');
      expect(core.geometry).toBe(first.geometry);
      expect(core.position.y).toBe(first.position.y);
      expect(core.rotation.y).toBe(first.rotation.y);
      expect(core.scale.toArray()).toEqual([1, 1, 1]);
    }
    const frozen = [first.position.y, first.rotation.y];
    s.frame(0, 20, true, true);
    applyFade(0.5); s.frame(0, 40, true, true);
    expect([first.position.y, first.rotation.y]).toEqual(frozen);
    s.frame(0, 40.01, false, true);
    expect(first.rotation.y - frozen[1]!).toBeCloseTo(0.0014);
    s.reset(); s.frame(0, 100, true, true);
    expect(first.rotation.y).toBe(0);
    s.dispose();
  });

  it('retains hidden last-known segments, destroys only the observed segment, and rebuilds despite an old FX tail', () => {
    const s = setup();
    s.ingest(fixture({ entities: [enemy] })); s.frame(10, 0, false, false);
    s.ingest(fixture({ tick: 11 })); s.frame(11, 0, false, false);
    expect(mesh(s, 'se', 'sky', 'core').visible).toBe(true);
    s.ingest(fixture({ tick: 12, fx: [death] })); s.frame(11.9, 0, false, false);
    expect(mesh(s, 'se', 'sky', 'core').visible).toBe(true);
    s.frame(12, 0, false, false);
    expect(mesh(s, 'se', 'sky', 'core').visible).toBe(false);
    expect(mesh(s, 'se', 'surface', 'core').visible).toBe(true);
    expect(mesh(s, 'se', 'surface', 'link').visible).toBe(false);
    expect(mesh(s, 'se', 'sky', 'link').visible).toBe(false);
    s.ingest(fixture({ tick: 13, entities: [enemy], fx: [death] })); s.frame(13, 0, false, false);
    expect(mesh(s, 'se', 'sky', 'core').visible).toBe(true);
    expect(mesh(s, 'se', 'sky', 'link').visible).toBe(true);
    s.ingest(fixture({ tick: 14, fx: [death] })); s.frame(14, 0, false, false);
    expect(mesh(s, 'se', 'sky', 'core').visible).toBe(true);
    s.dispose();
  });

  it('uses visible empty cells as evidence of a missing enemy segment, never fog absence', () => {
    const s = setup();
    s.ingest(fixture({ entities: [enemy] })); s.frame(10, 0, false, false);
    const vision = { ...noVision, sky: base.vision.sky.map(() => 1073741823) };
    s.ingest(fixture({ tick: 11, vision })); s.frame(11, 0, false, false);
    expect(mesh(s, 'se', 'sky', 'core').visible).toBe(false);
    expect(mesh(s, 'se', 'orbit', 'core').visible).toBe(true);
    s.dispose();
  });

  it('removes every connector on public elimination and restores lobby/new-match state without allocating new draws', () => {
    const s = setup(), draws = [...s.shaderTemplates];
    s.ingest(fixture({ eliminated: ['se'] })); s.frame(10, 0, false, false);
    for (const p of PLANES) expect(mesh(s, 'se', p, 'core').visible).toBe(false);
    for (let i = 0; i < PLANES.length - 1; i++) {
      applyFade(i); s.frame(10, 0, false, false);
      expect(mesh(s, 'se', PLANES[i]!, 'link').visible).toBe(false);
    }
    s.reset(); s.frame(0, 0, false, true);
    expect(s.shaderTemplates).toEqual(draws);
    for (const p of PLANES) expect(mesh(s, 'se', p, 'core').visible).toBe(true);
    for (let i = 0; i < PLANES.length - 1; i++) {
      applyFade(i); s.frame(0, 0, false, true);
      expect(mesh(s, 'se', PLANES[i]!, 'link').visible).toBe(true);
    }
    s.place(base.match!.armies.filter(a => a.id === 'nw'));
    s.frame(0, 0, false, false);
    expect(s.root.getObjectByName('spire-se-sky')!.visible).toBe(false);
    s.dispose();
  });

  it('never reveals an underground root from Surface sight or memory', () => {
    const s = setup(); applyFade(0);
    s.ingest(fixture({ entities: [{ ...enemy, plane: 'surface' }] })); s.frame(10, 0, false, false);
    expect(s.root.getObjectByName('spire-se-depths')!.visible).toBe(false);
    s.ingest(fixture({ tick: 11, entities: [{ ...enemy, plane: 'depths' }] })); s.frame(11, 0, false, false);
    expect(s.root.getObjectByName('spire-se-depths')!.visible).toBe(true);
    s.reset(); s.frame(0, 0, false, false);
    expect(s.root.getObjectByName('spire-se-depths')!.visible).toBe(false);
    s.dispose();
  });

  it('emits one pooled death at the render boundary, not snapshot receipt or a repeated FX tail', () => {
    const combat = new Combat(undefined, 48);
    combat.ingest(fixture(), t => t * 50);
    combat.ingest(fixture({ tick: 12, fx: [death] }), t => t * 50);
    expect(combat.debris.n).toBe(0);
    combat.frame(595, 0, 100, 11.9);
    expect(combat.debris.n).toBe(0);
    combat.frame(600, 0, 100, 12);
    expect(combat.debris.n).toBe(8);
    expect(combat.rings.n).toBe(1);
    combat.ingest(fixture({ tick: 13, fx: [death] }), t => t * 50);
    combat.frame(650, 0, 100, 13);
    expect(combat.debris.n).toBe(8);
    combat.reset();
    combat.frame(700, 0, 100, 14);
    expect(combat.debris.n + combat.rings.n).toBe(0);
  });

  it('keeps reduced-motion destruction legible without flying fragments and clears pending deaths on reset', () => {
    const combat = new Combat(undefined, 48);
    vi.spyOn(combat, 'reducedMotion', 'get').mockReturnValue(true);
    combat.ingest(fixture(), t => t * 50);
    combat.ingest(fixture({ tick: 12, fx: [death] }), t => t * 50);
    combat.frame(600, 0, 100, 12);
    expect(combat.debris.n).toBe(0);
    expect(combat.rings.n).toBe(1);
    combat.reset();
    combat.ingest(fixture({ tick: 12, fx: [death] }), t => t * 50);
    combat.reset(); combat.frame(600, 0, 100, 12);
    expect(combat.debris.n + combat.rings.n).toBe(0);
  });
});
