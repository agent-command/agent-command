/**
 * The ink pass (docs/art/DIRECTIONS.md §1 "Outlines"): one MRT scene pass (colour + view normal + line weight), then
 * one composite: depth-Laplacian silhouettes and normal creases with a hand-inked wobble, coloured by the viewed page
 * (sepia on light paper, chalk on dark), faded with distance; ghosted planes get faint construction-pencil lines.
 * Paper grain, fibres and a soft vignette on top, plus an emissive-only bloom (threshold 1). During a plane dive the
 * same composite draws the plane transition (`dive.ts`) in a branch that idle frames skip.
 */
import { BlendMode, Color, ColorManagement, MaterialBlending, NoToneMapping, NodeUpdateType, PassNode, RenderPipeline, UnsignedByteType, Vector2, type Camera, type MRTNode, type NodeFrame, type NodeMaterial, type Object3D, type QuadMesh, type RenderTarget, type PerspectiveCamera, type Scene, type TextureNode, type WebGPURenderer, type Node } from 'three/webgpu';
import { abs, atan, dot, float, Fn, fract, hash, If, max, mix, mrt, mx_noise_float, output, pass, perspectiveDepthToViewZ, screenSize, screenUV, select, smoothstep, step, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { PLANES, type Plane } from '@agent-command/game/contract';
import { PLANE_ACCENT } from '../dom.ts';
import { inkActive, type DiveLook } from './dive.ts';
import { SCENE_DEPTH, lum, sceneNormal, type F1, type V3 } from './materials.ts';
import { PAPER_C, VIEW } from './palette.ts';
import { afterFrame, yieldStartup } from './startup.ts';
import { QUALITY, type Quality } from './quality.ts';
/** Scene luminance band over which a dark plane's chalk line turns to dark ink (lit floors and pale hulls). */
const INK_UNDER = { lo: 0.42, hi: 0.55 } as const;

/** Camera distance to its focus point: lines start fading beyond ~1.3× it. */
export const LINE_DIST = uniform(30);

/** The plane transition's frame (`setDiveFx`): effect strengths, progress, direction and the destination's colours. */
const DIVE_FX = {
  on: uniform(0), k: uniform(0), dir: uniform(0),
  lines: uniform(0), smear: uniform(0), chroma: uniform(0), tint: uniform(0), grain: uniform(0), wash: uniform(0),
  accent: uniform(new Color()), page: uniform(new Color()),
};
const ACCENT_C = Object.fromEntries(PLANES.map((p) => [p, new Color(PLANE_ACCENT[p])])) as Record<Plane, Color>;
/** Speed lines around the screen: one candidate stroke per angular cell. */
const LINE_CELLS = 150;
/** Speed lines are redrawn this many times over a dive, like hand-drawn frames on twos. */
const LINE_BEATS = 14;

/** Copy the camera's dive frame into the composite (`dir` +1 up, -1 down; `to` the destination plane). */
export function setDiveFx(look: DiveLook, to: Plane, dir: number): void {
  const f = DIVE_FX;
  f.on.value = inkActive(look) ? 1 : 0;
  f.k.value = look.k;
  f.dir.value = dir;
  f.lines.value = look.lines;
  f.smear.value = look.smear;
  f.chroma.value = look.chroma;
  f.tint.value = look.tint;
  f.grain.value = look.grain;
  f.wash.value = look.wash;
  f.accent.value.copy(ACCENT_C[to]);
  f.page.value.copy(PAPER_C[to]);
}


const scenePasses = new WeakMap<RenderPipeline, { pass: PassNode; scene: Scene }>();

/** Draw compiles whose programs may link at once: keeps the driver's parallel compile threads busy
 *  (KHR_parallel_shader_compile, createRenderPipelineAsync) without a completion-poll storm stalling frames. */
const LINKING = 8;
const drawingBuffer = new Vector2();

/** Size and format the scene pass's target exactly as PassNode.setup does, so warmed pipeline keys match frames. */
function preparePass(renderer: RenderPipeline['renderer'], scenePass: PassNode): void {
  renderer.getDrawingBufferSize(drawingBuffer);
  scenePass.renderTarget.samples = renderer.samples;
  scenePass.renderTarget.texture.type = renderer.getOutputBufferType();
  scenePass.setSize(drawingBuffer.x, drawingBuffer.y);
}

export interface SceneWarmOptions {
  /** Abandon the remaining draws (links in flight finish unobserved). */
  stop?: () => boolean;
  /** One draw's programs have linked. */
  linked?: () => void;
  /** Frames render meanwhile: start draws for at most this long (ms) between rendered frames. */
  frameSliceMs?: number;
}

/**
 * Warm the scene pass's pipelines for `draws` (admitted draws and detached templates), including off-camera ones a
 * later pan or dive exposes. One compile session starts per task and up to LINKING programs link concurrently: a
 * session's node build runs in its task (three re-applies its target and MRT around its own yields), so frames may
 * render between tasks. Each draw is admitted (visible, unculled) only for its synchronous queueing call. The scene
 * pass's target and MRT stay bound after a session (three restores a session's starting target per item):
 * World.frame unbinds them before drawing, and so does the end of the warm-up.
 */
export async function compileInkScene(pipe: RenderPipeline, draws: readonly Object3D[], options: SceneWarmOptions = {}): Promise<void> {
  const { stop, linked, frameSliceMs } = options;
  const { pass: scenePass, scene } = scenePasses.get(pipe)!;
  const renderer = pipe.renderer;
  const linking = new Set<Promise<void>>();
  scene.updateMatrixWorld();
  let slice = performance.now();
  try {
    for (const object of draws) {
      while (linking.size >= LINKING) await Promise.race(linking);
      if (frameSliceMs !== undefined && performance.now() - slice >= frameSliceMs) {
        await afterFrame();
        slice = performance.now();
      } else await yieldStartup();
      if (stop?.()) return;
      preparePass(renderer, scenePass);
      renderer.setRenderTarget(scenePass.renderTarget);
      renderer.setMRT(scenePass.getMRT());
      const { visible, frustumCulled } = object;
      object.visible = true;
      object.frustumCulled = false;
      let compiled: Promise<void>;
      try {
        compiled = renderer.compileAsync(object, scenePass.camera, scene);
      } finally {
        object.visible = visible;
        object.frustumCulled = frustumCulled;
      }
      const link: Promise<void> = compiled.then(() => {
        linking.delete(link);
        linked?.();
      });
      linking.add(link);
    }
    await Promise.all(linking);
  } finally {
    for (const link of linking) link.catch(() => {});
    renderer.setRenderTarget(null);
    renderer.setMRT(null);
  }
}

/**
 * Warm the composite and bloom quads (r187 has no RenderPipeline.compileAsync: its internal entrypoints stay here,
 * never in frame code). Holds the pipeline's output state across awaits, so no frame may render meanwhile.
 */
export async function compileInkOutput(pipe: RenderPipeline): Promise<void> {
  const renderer = pipe.renderer;
  const tone = renderer.toneMapping;
  const color = renderer.outputColorSpace;
  const context = renderer.contextNode;
  const render = renderer.render;
  // RenderPipeline changes output state before its quads render to the canvas: capture them in that same state.
  const internals = pipe as unknown as { _update(): void; _quadMesh: QuadMesh };
  internals._update();
  renderer.toneMapping = NoToneMapping;
  renderer.outputColorSpace = ColorManagement.workingColorSpace;
  try {
    renderer.setRenderTarget(null);
    renderer.setMRT(null);
    // Bloom's updateBefore renders its own quads even during compilation. Capture the actual
    // object/material/vertex/target/context combinations and compile each rather than drawing cold shaders.
    const draws: { object: QuadMesh; material: NodeMaterial; vertex: NodeMaterial['vertexNode']; camera: Camera; target: RenderTarget | null; mrt: MRTNode | null; context: WebGPURenderer['contextNode']; tone: typeof tone; color: typeof color }[] = [];
    renderer.render = (object, camera) => {
      // Scene passes warm separately: the main scene by compileInkScene, the storm pass by StormClouds.compile.
      if ('isScene' in object) return;
      const mesh = object as QuadMesh;
      const material = mesh.material as NodeMaterial;
      const target = renderer.getRenderTarget();
      const mrt = renderer.getMRT();
      const context = renderer.contextNode;
      const tone = renderer.toneMapping;
      const color = renderer.outputColorSpace;
      if (draws.some((draw) => draw.object === mesh && draw.material === material && draw.vertex === material.vertexNode
        && draw.target === target && draw.mrt === mrt && draw.context === context && draw.tone === tone && draw.color === color)) return;
      draws.push({ object: mesh, material, vertex: material.vertexNode, camera, target, mrt, context, tone, color });
    };
    internals._quadMesh.render(renderer);
    for (let i = 0; i < draws.length; i++) {
      await yieldStartup();
      const draw = draws[i]!;
      const material = draw.object.material;
      const vertex = draw.material.vertexNode;
      renderer.setRenderTarget(draw.target);
      renderer.setMRT(draw.mrt);
      renderer.contextNode = draw.context;
      draw.object.material = draw.material;
      draw.material.vertexNode = draw.vertex;
      renderer.toneMapping = draw.tone;
      renderer.outputColorSpace = draw.color;
      try {
        await renderer.compileAsync(draw.object, draw.camera);
      } finally {
        draw.object.material = material;
        draw.material.vertexNode = vertex;
      }
    }
  } finally {
    renderer.render = render;
    renderer.setRenderTarget(null);
    renderer.setMRT(null);
    renderer.contextNode = context;
    renderer.toneMapping = tone;
    renderer.outputColorSpace = color;
  }
}

/** The viewer's command overlays (selection markers, order lines) on a transparent page: cleared to alpha 0, each
 * fragment depth-tested against the scene pass's depth (`commandOverlay`), so terrain and Spires still hide them, then
 * laid over everything (the Sky's storms included). Renders only while something shows. */
class OverlayPass extends PassNode {
  shown = false;
  readonly weight = uniform(0);
  /** Rendered first (once per frame, NodeFrame dedupes), so overlays test this frame's depth whatever order the
   * composite graph lists the passes in. */
  private readonly scenePass: PassNode;
  constructor(scenePass: PassNode, overlays: Scene, camera: Camera) {
    super(PassNode.COLOR, overlays, camera);
    this.scenePass = scenePass;
  }
  override getUpdateBeforeType(): NodeUpdateType {
    return this.shown ? NodeUpdateType.FRAME : NodeUpdateType.NONE;
  }
  override updateBefore(frame: NodeFrame): boolean | undefined {
    frame.updateBeforeNode(this.scenePass);
    const renderer = frame.renderer as WebGPURenderer, alpha = renderer.getClearAlpha();
    renderer.setClearAlpha(0);
    try {
      return super.updateBefore(frame) as boolean | undefined;
    } finally {
      renderer.setClearAlpha(alpha);
    }
  }
}
const overlayPasses = new WeakMap<RenderPipeline, OverlayPass>();

/** Draw the pipeline's overlay scene this frame or skip its pass entirely. */
export function showInkOverlays(pipe: RenderPipeline, shown: boolean): void {
  const overlay = overlayPasses.get(pipe);
  if (!overlay) return;
  overlay.shown = shown;
  overlay.weight.value = shown ? 1 : 0;
}

/** `look`: the tier's optional extras (`quality.ts`); without bloom the composite reads no blur chain at all, without
 *  grain the page keeps its vignette but drops the two paper-noise evaluations per pixel. */
export function inkPipeline(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera, cloudComposite?: (base: V3, depth: TextureNode, edge: F1) => V3, overlays?: Scene, look: Pick<Quality, 'bloom' | 'grain'> = QUALITY.full): RenderPipeline {
  const scenePass = pass(scene, camera);
  // MRT outputs other than `output` default to no blending, and the WebGL backend applies the *pass* MRT's modes:
  // blend `normal` with each material's mode so overlays (zero normal, zero alpha) leave the lines below untouched
  scenePass.setMRT(mrt({ output, normal: sceneNormal(1) }).setBlendMode('normal', new BlendMode(MaterialBlending)));
  scenePass.getTexture('normal').type = UnsignedByteType;
  const col = scenePass.getTextureNode('output');
  const nrm = scenePass.getTextureNode('normal');
  const dep = scenePass.getTextureNode('depth');
  const near = uniform(camera.near);
  const far = uniform(camera.far);

  // 5 depth + 5 normal taps, offsets wobbled by low-frequency screen noise
  const jitter = mx_noise_float(vec3(screenUV.mul(vec2(9, 6)), 1)).mul(0.35).add(1);
  const o = vec2(1.25, 1.25).div(screenSize).mul(jitter);
  const taps = [screenUV, screenUV.add(vec2(o.x, 0)), screenUV.sub(vec2(o.x, 0)), screenUV.add(vec2(0, o.y)), screenUV.sub(vec2(0, o.y))];
  const z = taps.map((u) => perspectiveDepthToViewZ(dep.sample(u).r, near, far).negate() as F1);
  const s = taps.map((u) => nrm.sample(u) as Node<'vec4'>);
  const n = s.map((t) => t.xyz.mul(2).sub(1) as V3);
  const z0 = z[0]!;
  const lap = abs(z[1]!.add(z[2]!).sub(z0.mul(2))).add(abs(z[3]!.add(z[4]!).sub(z0.mul(2)))).div(z0);
  const depthEdge = smoothstep(0.006, 0.02, lap);
  const n0 = n[0]!;
  const nd = float(4).sub(dot(n0, n[1]!).add(dot(n0, n[2]!)).add(dot(n0, n[3]!)).add(dot(n0, n[4]!)));
  const normalEdge = smoothstep(0.3, 0.65, nd);
  // line weight (a): 1 painted plane, 0.5 ghost plane, 0 nothing (background, overlays)
  const w = max(max(s[0]!.w, s[1]!.w), max(max(s[2]!.w, s[3]!.w), s[4]!.w));
  const focus = w.mul(2).sub(1).clamp(0, 1);
  const weight = smoothstep(0.02, 0.1, w).mul(mix(float(0.42), float(1), focus));
  const distFade = mix(float(1), float(0.35), smoothstep(LINE_DIST.mul(1.3), LINE_DIST.mul(3), z0));
  const e = max(depthEdge, normalEdge).mul(weight).mul(distFade).mul(VIEW.lineK);
  // On the dark papers the line is chalk; where the pixel under it is lit (the Depths' tunnel floor, Orbit's cream
  // hulls) chalk would vanish, so the line turns to the plane's dark ink there.
  const lightUnder = smoothstep(INK_UNDER.lo, INK_UNDER.hi, lum(col.rgb as unknown as V3)).mul(VIEW.dark).mul(focus);
  const lineCol = mix(mix(VIEW.ghostPencil, VIEW.line, focus), VIEW.ink, lightUnder) as V3;
  const pipe = new RenderPipeline(renderer);
  scenePasses.set(pipe, { pass: scenePass, scene });
  const g = look.grain ? mx_noise_float(vec3(screenUV.mul(vec2(520, 300)), 0)).mul(0.035) : float(0);
  const fib = look.grain ? mx_noise_float(vec3(screenUV.mul(vec2(60, 900)), 3)).mul(0.02) : float(0);
  const vig = float(1).sub(screenUV.sub(0.5).length().mul(0.35));
  let top: Node<'vec4'> | undefined;
  if (overlays) {
    // Same MRT as the scene pass (overlay materials write a zero line normal), so warmed programs match.
    SCENE_DEPTH.value = scenePass.getTexture('depth');
    const overlay = new OverlayPass(scenePass, overlays, camera);
    overlay.setMRT(mrt({ output, normal: sceneNormal(1) }).setBlendMode('normal', new BlendMode(MaterialBlending)));
    overlay.getTexture('normal').type = UnsignedByteType;
    overlayPasses.set(pipe, overlay);
    top = overlay.getTextureNode('output').mul(overlay.weight) as Node<'vec4'>;
  }
  // Normal blending onto (0, 0, 0, 0) leaves the overlays' premultiplied colour and coverage. They bloom with the scene
  // (the hot head of a falling rock's trail), so the bloom reads both.
  const glow = look.bloom ? bloom(top ? vec4(col.rgb.mul(float(1).sub(top.a)).add(top.rgb), 1) : col, 0.45, 0.3, 1.0).rgb : vec3(0);
  // The reduced-motion page wash covers the bloom too (a cheap lerp, 0 outside reduced-motion dives).
  const lit = transitionComposite(col, lineCol, e as F1, g.add(fib) as F1, vig as F1).add(glow);
  const painted = cloudComposite ? cloudComposite(lit as V3, dep, e as F1) : lit;
  // Overlays first in the graph: the overlay pass then renders before the bloom that reads it (passes run in the order
  // the graph first reaches them). The page grain, vignette and bloom apply as they did to overlays drawn in the scene
  // pass.
  const marked = top ? top.rgb.mul(g.add(fib).add(1)).mul(vig).add(glow.mul(top.a)).add(painted.mul(float(1).sub(top.a))) : painted;
  pipe.outputNode = mix(marked, DIVE_FX.page, DIVE_FX.wash);
  return pipe;
}

/**
 * The main composite (scene colour, ink lines, paper grain and vignette) with the plane transition drawn over a dive:
 * a radial zoom smear of the scene colour with red and blue split apart at the peak (the ink lines stay crisp on top,
 * like a cel's line art), the grain swelling, a ragged wash of the destination's accent spreading from where the camera
 * is headed (the centre falling in, the edges pulling out) and radial speed lines whose dashes travel with the dive.
 * Uniform-gated: idle frames skip both branches.
 */
function transitionComposite(col: TextureNode, lineCol: V3, e: F1, grain: F1, vig: F1): V3 {
  const f = DIVE_FX;
  const on = f.on.greaterThan(0.5);
  return Fn(() => {
    const c = col.rgb.toVar();
    If(on, () => {
      const d = screenUV.sub(0.5);
      const s = d.mul(f.smear.mul(0.08));
      const smear = c.add(col.sample(screenUV.sub(s.mul(1 / 3))).rgb).add(col.sample(screenUV.sub(s.mul(2 / 3))).rgb).add(col.sample(screenUV.sub(s)).rgb).mul(0.25);
      const split = d.mul(f.chroma.mul(0.02));
      c.assign(vec3(mix(smear.x, col.sample(screenUV.add(split)).r, f.chroma), smear.y, mix(smear.z, col.sample(screenUV.sub(split)).b, f.chroma)));
    });
    const o = mix(c, lineCol, e).mul(grain.mul(f.grain.mul(2.5).add(1)).add(1)).mul(vig).toVar();
    If(on, () => {
      const d = screenUV.sub(0.5);
      const p = vec2(d.x.mul(screenSize.x.div(screenSize.y)), d.y);
      const r = p.length();
      // The accent wash keeps spreading as it fades (its reach follows progress, its strength `tint`), with a ragged
      // edge and the watercolour's darker pigment rim where it stops.
      const bleed = mx_noise_float(vec3(p.mul(3.5), f.k.mul(2))).mul(0.12);
      const reach = smoothstep(0.25, 0.9, f.k).mul(1.3);
      const fromCentre = float(1).sub(smoothstep(reach.sub(0.18), reach, r.add(bleed)));
      const fromEdges = smoothstep(float(0.97).sub(reach), float(1.15).sub(reach), r.add(bleed));
      const region = select(f.dir.greaterThan(0), fromEdges, fromCentre);
      o.assign(mix(o, f.accent, region.mul(f.tint).mul(0.38)).mul(float(1).sub(region.mul(region.oneMinus()).mul(f.tint).mul(0.7))));
      // Speed lines: one candidate stroke per angular cell, re-picked on every beat, tapering to a point inward.
      const a = atan(p.y, p.x).mul(LINE_CELLS / (2 * Math.PI)).add(LINE_CELLS / 2);
      const cell = a.floor();
      const beat = f.k.mul(LINE_BEATS).floor();
      const pick = hash(cell.add(beat.mul(173)));
      const thick = hash(cell.mul(3.7).add(beat.mul(41)).add(11));
      const inner = mix(float(0.78), float(0.18), f.lines).add(thick.mul(0.2));
      const half = thick.mul(0.26).add(0.05).mul(smoothstep(inner, inner.add(0.45), r));
      const across = abs(fract(a).sub(0.5)).mul(2);
      const stroke = float(1).sub(smoothstep(half.mul(0.55), half, across));
      // Dashes travel outward falling in (dir -1) and inward pulling out (dir +1).
      const dash = smoothstep(0.08, 0.22, fract(r.mul(2.2).add(f.dir.mul(f.k).mul(2.6)).add(hash(cell.mul(1.9).add(5)))));
      const ink = stroke.mul(step(0.42, pick)).mul(dash).mul(smoothstep(inner, inner.add(0.04), r)).mul(f.lines);
      o.assign(mix(o, VIEW.line, ink.mul(0.9)));
    });
    return o;
  })() as unknown as V3;
}
