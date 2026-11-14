/**
 * Lookdev sandbox entry. URL params:
 *   dir      ink | table | signal | atlas | weather (atlas: isolated Orbit fleet study; weather: Sky weather VFX study)
 *   plane    surface | depths | sky | orbit | stack   (camera preset, default surface)
 *   t        seconds to freeze the animation clock at (screenshots); omit to animate
 *   renderer webgl                        force the WebGL2 backend
 *   hud      0 hides the switcher
 *   zoom     normal | wide | close       atlas camera distances: 30 | 52 | 18; weather: 30 | 78 (normal | wide)
 *   labels   0 hides atlas editorial labels (independent of the switcher)
 */
import { Color, Group, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { mix, screenUV, uniform } from 'three/tsl';
import { FOCUS, assemble, clock, type Ctx, type Look } from './kit.ts';
import { PLANE_Y, PLANES, type Plane } from './world.ts';
import { ink } from './dirs/ink.ts';
import { table } from './dirs/table.ts';
import { signal } from './dirs/signal.ts';
import { assembleAtlas } from './orbit-atlas.ts';
import { assembleSkyWeather } from './sky-weather.ts';

const LOOKS: Record<string, Look> = { ink, table, signal, atlas: { ...ink, name: 'Orbit · Star atlas' }, weather: { ...ink, name: 'Sky · weather VFX' } };
const q = new URLSearchParams(location.search);
const dirKey = q.get('dir') && LOOKS[q.get('dir')!] ? q.get('dir')! : 'ink';
const look = LOOKS[dirKey]!;
const weather = dirKey === 'weather';
const viewParam = dirKey === 'atlas' ? 'orbit' : weather ? 'sky' : q.get('plane') ?? 'surface';
const view: Plane | 'stack' = viewParam === 'stack' || (PLANES as readonly string[]).includes(viewParam) ? (viewParam as Plane | 'stack') : 'surface';
const frozen = q.get('t');
const atlas = dirKey === 'atlas';
const study = atlas || weather;

const hud = document.getElementById('hud')!;
if (q.get('hud') === '0') hud.classList.add('hide');
if (atlas) { hud.style.left = 'auto'; hud.style.right = '20px'; }
const link = (d: string, p: string): string => `?dir=${d}&plane=${p}${q.get('renderer') ? `&renderer=${q.get('renderer')}` : ''}`;
hud.innerHTML =
  `<b>${look.name}</b> · ${view}<br>` +
  Object.keys(LOOKS).map((d) => `<a href="${link(d, view)}">${d}</a>`).join('') +
  '<br>' +
  ['depths', 'surface', 'sky', 'orbit', 'stack'].map((p) => `<a href="${link(dirKey, p)}">${p}</a>`).join('');

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: q.get('renderer') === 'webgl' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight, false);
await renderer.init();

const scene = new Scene();
const camera = new PerspectiveCamera(study ? 50 : view === 'stack' ? 34 : 45, innerWidth / innerHeight, 0.3, 400);
// RTS framing like the game's rig (yaw 45°, pitch ~57°); the stack shot looks across all four planes
const yaw = Math.PI * 0.25;
const pitch = study ? 1 : view === 'stack' ? 0.34 : 0.98;
const zoom = q.get('zoom') ?? 'normal';
const dist = atlas ? ({ normal: 30, wide: 52, close: 18 }[zoom] ?? 30) : weather ? (zoom === 'wide' ? 78 : 30) : view === 'stack' ? 84 : 21;
const ty = study ? 0 : view === 'stack' ? (PLANE_Y.depths + PLANE_Y.orbit) / 2 + 2 : PLANE_Y[view];
camera.position.set(Math.cos(yaw) * Math.cos(pitch) * dist + 0.6, ty + Math.sin(pitch) * dist, Math.sin(yaw) * Math.cos(pitch) * dist + 0.6);
camera.lookAt(0.6, ty, 0.6);

for (const p of PLANES) FOCUS[p].value = view === 'stack' || view === p ? 1 : 0;

const bgTop = uniform(new Color(look.bg[view][0]));
const bgBottom = uniform(new Color(look.bg[view][1]));
scene.backgroundNode = mix(bgBottom, bgTop, screenUV.y.oneMinus());

const roots = { depths: new Group(), surface: new Group(), sky: new Group(), orbit: new Group() };
const ctx: Ctx = { scene, camera, renderer, view, roots, fields: {} };
const atlasScene = atlas ? assembleAtlas(ctx) : undefined;
const weatherScene = weather ? assembleSkyWeather(ctx) : undefined;
if (!study) assemble(ctx, look);
const pipeline = weatherScene ? weatherScene.post() : look.post(ctx);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const t0 = performance.now();
let frames = 0;
declare global {
  interface Window {
    __frames: number;
    __ready: boolean;
    __info: unknown;
  }
}
renderer.setAnimationLoop(() => {
  clock.value = frozen !== null ? Number(frozen) : (performance.now() - t0) / 1000;
  atlasScene?.update(clock.value);
  weatherScene?.update(clock.value);
  pipeline.render();
  frames++;
  window.__frames = frames;
  if (frames === 4) {
    window.__ready = true;
    const backend = 'isWebGPUBackend' in renderer.backend && renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    window.__info = { backend, calls: renderer.info.render.drawCalls, tris: renderer.info.render.triangles, cameraDistance: dist, shipTriangles: atlasScene?.triangles, ships: atlasScene?.ships };
  }
});
