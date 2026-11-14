import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Mesh, type Object3D } from 'three/webgpu';
import { PLANES } from '@agent-command/game/contract';
import { World } from '../src/world/world.ts';
import { applyFade, fadeValue } from '../src/world/fade.ts';

const { scene: compileScene, output: compileOutput } = vi.hoisted(() => ({ scene: vi.fn(), output: vi.fn() }));
vi.mock('../src/world/ink.ts', () => ({ compileInkScene: compileScene, compileInkOutput: compileOutput, inkPipeline: vi.fn(), LINE_DIST: { value: 0 } }));
vi.mock('../src/world/startup.ts', () => ({ yieldStartup: async () => {}, prepareStartup: async () => {} }));
afterEach(() => {
  compileScene.mockReset();
  compileOutput.mockReset();
});

function firstView() {
  const world = new World({} as HTMLCanvasElement);
  const scene = world.scene;
  const visible = new Mesh();
  const inactive = new Mesh();
  inactive.name = 'canonical-kind';
  inactive.visible = false;
  const scope = new Group();
  scope.visible = false;
  const scopeDraw = new Mesh();
  scope.add(scopeDraw);
  const planes = PLANES.map((plane) => {
    const draw = new Mesh();
    draw.name = plane;
    scene.add(draw);
    return draw;
  });
  scene.add(visible, inactive, scope);
  const focuses: string[] = [];
  const updateScene = vi.fn(() => {
    applyFade(world.rig.level);
    focuses.push(world.rig.focus);
    for (const draw of planes) draw.visible = draw.name === world.rig.focus;
  });
  const pipeline = {};
  // The home preview's Orbit approach regions: hidden in every startup pose (shown only while the preview focuses Orbit).
  const regions = new Mesh();
  regions.name = 'orbit-regions';
  regions.visible = false;
  scene.add(regions);
  // The derelict's close-zoom dressing: hidden in a far startup pose, warmed as a template once its art is built.
  const ruinDetail = new Mesh();
  ruinDetail.name = 'ruin-detail';
  ruinDetail.visible = false;
  scene.add(ruinDetail);
  let built = false;
  const ruin = { ready: async () => { built = true; }, get shaderTemplates() { return built ? [ruinDetail] : []; } };
  // The storm pass warms its own programs against its own target after the output composite.
  const storms = { compile: vi.fn(async () => {}) };
  Object.assign(world, { updateScene, pipeline, storms, entities: { shaderTemplates: [inactive] }, fx: { shaderTemplates: [] }, groundAmbience: { shaderTemplates: [] }, airAmbience: { shaderTemplates: [] }, layers: { surface: { ready: async () => {} }, depths: { ready: async () => {} }, orbit: { regions, ruin } } });
  return { world, scene, visible, inactive, scope, scopeDraw, updateScene, pipeline, planes, focuses, regions, ruinDetail, storms };
}

describe('first-frame shader admission', () => {
  it('compiles every exact plane focus\'s draws and a detached template, with the live view restored meanwhile', async () => {
    const view = firstView();
    let draws: Object3D[] = [];
    compileScene.mockImplementation(async (pipeline: unknown, compiled: Object3D[]) => {
      expect(pipeline).toBe(view.pipeline);
      draws = compiled;
      // Frames may render while the draws compile: the live camera, fades and visibility are already back.
      expect(view.world.rig.focus).toBe('surface');
      expect(fadeValue.orbit).toBe(0);
    });
    expect(await view.world.prepareFirstFrame()).toBe(true);
    expect(view.storms.compile).toHaveBeenCalledOnce();
    expect(view.focuses.filter((_, i) => i % 2 === 0)).toEqual(PLANES);
    expect(view.updateScene).toHaveBeenCalledTimes(PLANES.length * 2);
    expect(draws).toContain(view.visible);
    for (const draw of view.planes) expect(draws).toContain(draw);
    expect(draws).not.toContain(view.inactive);
    expect(draws).not.toContain(view.scopeDraw);
    const template = draws.find((draw) => draw.name === 'canonical-kind')!;
    const regions = draws.find((draw) => draw.name === 'orbit-regions')!;
    expect(regions).not.toBe(view.regions);
    expect(regions.parent).toBeNull();
    expect(view.regions.visible).toBe(false);
    const ruinDetail = draws.find((draw) => draw.name === 'ruin-detail')!;
    expect(ruinDetail).not.toBe(view.ruinDetail);
    expect(ruinDetail.parent).toBeNull();
    expect(view.ruinDetail.visible).toBe(false);
    expect(template.parent).toBeNull();
    expect((template as Mesh).geometry).toBe(view.inactive.geometry);
    expect(new Set(draws).size).toBe(draws.length);
    expect(compileOutput).toHaveBeenCalledTimes(1);
    // No frames render during a blocking warm-up: it starts compiles at full speed.
    expect(compileScene.mock.calls[0]![2].frameSliceMs).toBeUndefined();
    expect(view.world.view).toBeUndefined();
    expect(view.world.rig.level).toBe(1);
    expect(view.inactive.visible).toBe(false);
    expect(view.scope.visible).toBe(false);
    expect(view.visible.frustumCulled).toBe(true);
  });

  it('warms only the asked planes, without templates; a live warm-up leaves the output composite alone', async () => {
    const view = firstView();
    let draws: Object3D[] = [];
    compileScene.mockImplementation(async (_pipeline: unknown, compiled: Object3D[]) => { draws = compiled; });
    await view.world.prepareFirstFrame({ planes: ['surface'], templates: false, live: true });
    expect(draws).toContain(view.planes[PLANES.indexOf('surface')]);
    expect(draws).not.toContain(view.planes[PLANES.indexOf('orbit')]);
    expect(draws.some((draw) => draw.name === 'canonical-kind' || draw.name === 'orbit-regions' || draw.name === 'ruin-detail')).toBe(false);
    expect(compileOutput).not.toHaveBeenCalled();
    expect(compileScene.mock.calls[0]![2].frameSliceMs).toBeGreaterThan(0);
  });

  it('stops and reports a warm-up superseded by a reset', async () => {
    const view = firstView();
    // A reset bumps World's private generation; this view has no real layers to reset.
    const internals = view.world as unknown as { generation: number };
    compileScene.mockImplementation(async (_pipeline: unknown, _draws: Object3D[], { stop }: { stop: () => boolean }) => {
      expect(stop()).toBe(false);
      internals.generation++;
      expect(stop()).toBe(true);
    });
    expect(await view.world.prepareFirstFrame()).toBe(false);
    expect(compileOutput).not.toHaveBeenCalled();
  });

  it('does not change the camera, visibility or culling when shader preparation fails', async () => {
    const view = firstView();
    const failure = new Error('shader compilation failed');
    view.world.rig.goTo('sky', performance.now(), 'jump');
    view.world.rig.holdDive(0.4);
    view.world.rig.update(performance.now(), 0, 0);
    const level = view.world.rig.level;
    const camera = view.world.rig.camera.clone();
    compileScene.mockRejectedValue(failure);
    await expect(view.world.prepareFirstFrame()).rejects.toBe(failure);
    expect(view.inactive.visible).toBe(false);
    expect(view.scope.visible).toBe(false);
    expect(view.visible.frustumCulled).toBe(true);
    expect(view.world.rig.focus).toBe('sky');
    expect(view.world.rig.level).toBe(level);
    expect(view.world.rig.diving).toBe(true);
    expect(view.world.rig.camera.position.equals(camera.position)).toBe(true);
    expect(view.world.rig.camera.projectionMatrix.equals(camera.projectionMatrix)).toBe(true);
    expect(view.updateScene).toHaveBeenCalledTimes(PLANES.length * 2);
  });
});
