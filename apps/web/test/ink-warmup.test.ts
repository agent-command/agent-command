import { describe, expect, it, vi } from 'vitest';
import { ColorManagement, Group, HalfFloatType, Mesh, MeshBasicNodeMaterial, NoToneMapping, PerspectiveCamera, PlaneGeometry, RenderTarget, Scene, SRGBColorSpace, Vector2, type MRTNode, type WebGPURenderer } from 'three/webgpu';
import { context, mrt, output } from 'three/tsl';
import { compileInkOutput, compileInkScene, inkPipeline } from '../src/world/ink.ts';

const { afterFrame } = vi.hoisted(() => ({ afterFrame: vi.fn(async () => {}) }));
vi.mock('../src/world/startup.ts', () => ({ yieldStartup: async () => {}, afterFrame }));

function firstPipeline() {
  let target: RenderTarget | null = null;
  let outputs: MRTNode | null = null;
  const renderer = {
    samples: 4,
    toneMapping: NoToneMapping,
    outputColorSpace: SRGBColorSpace,
    contextNode: context({}),
    getRenderTarget: () => target,
    setRenderTarget: (next: RenderTarget | null) => { target = next; },
    getMRT: () => outputs,
    setMRT: (next: typeof outputs) => { outputs = next; },
    getDrawingBufferSize: (size: Vector2) => size.set(32, 32),
    getOutputBufferType: () => HalfFloatType,
    compileAsync: vi.fn(async (..._args: unknown[]) => {}),
    render: vi.fn(),
  };
  const scene = new Scene();
  const material = new MeshBasicNodeMaterial();
  const mesh = new Mesh(new PlaneGeometry(), material);
  mesh.position.x = 10000; // A later pan can expose this admitted draw.
  const faded = new Mesh(mesh.geometry, material);
  faded.visible = false; // admitted by its plane's startup view, hidden in the live one
  const scope = new Group();
  scope.visible = false;
  const scopeDraw = new Mesh(mesh.geometry, material);
  scope.add(scopeDraw);
  scene.add(mesh, faded, scope);
  const pipeline = inkPipeline(renderer as unknown as WebGPURenderer, scene, new PerspectiveCamera());
  return { renderer, pipeline, scene, mesh, faded, scope, scopeDraw };
}

describe('ink shader warmup', () => {
  it('queues each admitted draw in the scene pass target, admitted only while it is queued', async () => {
    const view = firstPipeline();
    const draws: unknown[] = [];
    view.renderer.compileAsync.mockImplementation(async (...args: unknown[]) => {
      const object = args[0] as Mesh;
      draws.push(object);
      expect(args[2]).toBe(view.scene);
      expect(object.visible).toBe(true);
      expect(object.frustumCulled).toBe(false);
      expect(view.renderer.getRenderTarget()!.texture.type).toBe(HalfFloatType);
      expect(view.renderer.getMRT()).not.toBeNull();
    });
    await compileInkScene(view.pipeline, [view.mesh, view.faded]);
    expect(draws).toEqual([view.mesh, view.faded]);
    expect(view.mesh.frustumCulled).toBe(true);
    expect(view.faded.visible).toBe(false);
    expect(view.scope.visible).toBe(false);
    // Frames draw from the canvas defaults.
    expect(view.renderer.getRenderTarget()).toBeNull();
    expect(view.renderer.getMRT()).toBeNull();
  });

  it('starts the next draw while earlier programs are still linking, up to a bounded number', async () => {
    const view = firstPipeline();
    const links: (() => void)[] = [];
    view.renderer.compileAsync.mockImplementation(() => {
      const { promise, resolve } = Promise.withResolvers<void>();
      links.push(resolve);
      return promise;
    });
    const draws = Array.from({ length: 20 }, () => new Mesh(view.mesh.geometry, view.mesh.material));
    let done = 0;
    const warming = compileInkScene(view.pipeline, draws, { linked: () => done++ });
    await vi.waitFor(() => expect(links).toHaveLength(8));
    // With eight programs linking, the warm-up waits for one (no further draw starts however long it waits).
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(view.renderer.compileAsync).toHaveBeenCalledTimes(8);
    links.shift()!();
    await vi.waitFor(() => expect(view.renderer.compileAsync).toHaveBeenCalledTimes(9));
    while (done < 20) {
      await vi.waitFor(() => expect(links.length).toBeGreaterThan(0));
      links.shift()!();
      await Promise.resolve();
    }
    await warming;
    expect(view.renderer.compileAsync).toHaveBeenCalledTimes(20);
  });

  it('abandons the remaining draws when stopped', async () => {
    const view = firstPipeline();
    let stop = false;
    view.renderer.compileAsync.mockImplementation(async () => { stop = true; });
    await compileInkScene(view.pipeline, [view.mesh, view.faded], { stop: () => stop });
    expect(view.renderer.compileAsync).toHaveBeenCalledTimes(1);
    expect(view.renderer.getRenderTarget()).toBeNull();
  });

  it('waits for a rendered frame once a live warm-up has used its slice', async () => {
    const view = firstPipeline();
    afterFrame.mockClear();
    await compileInkScene(view.pipeline, [view.mesh, view.faded]);
    expect(afterFrame).not.toHaveBeenCalled();
    await compileInkScene(view.pipeline, [view.mesh, view.faded], { frameSliceMs: 0 });
    expect(afterFrame).toHaveBeenCalledTimes(2);
  });

  it('restores admission and unbinds the pass if a scene compile rejects', async () => {
    const view = firstPipeline();
    const failure = new Error('compile failed');
    view.renderer.compileAsync.mockRejectedValue(failure);
    await expect(compileInkScene(view.pipeline, [view.mesh, view.faded])).rejects.toBe(failure);
    expect(view.mesh.frustumCulled).toBe(true);
    expect(view.faded.visible).toBe(false);
    expect(view.renderer.getRenderTarget()).toBeNull();
    expect(view.renderer.getMRT()).toBeNull();
  });

  it('warms the output quads in the pipeline output context, never the scene, and restores renderer state', async () => {
    const view = firstPipeline();
    const render = view.renderer.render;
    const contextNode = view.renderer.contextNode;
    const compiled: unknown[] = [];
    view.renderer.compileAsync.mockImplementation(async (...args: unknown[]) => {
      compiled.push(args[0]);
      expect(view.renderer.outputColorSpace).toBe(ColorManagement.workingColorSpace);
      expect(view.renderer.toneMapping).toBe(NoToneMapping);
    });
    await compileInkOutput(view.pipeline);
    expect(compiled.length).toBeGreaterThan(0);
    expect(compiled).not.toContain(view.scene);
    expect(compiled).not.toContain(view.mesh);
    expect(view.renderer.getRenderTarget()).toBeNull();
    expect(view.renderer.getMRT()).toBeNull();
    expect(view.renderer.contextNode).toBe(contextNode);
    expect(view.renderer.outputColorSpace).toBe(SRGBColorSpace);
    expect(view.renderer.render).toBe(render);
  });
});
