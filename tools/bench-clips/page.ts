/**
 * Browser half of the clip renderer (render.mjs serves it through the web app's Vite server): the real client's World
 * and Overlay over a bare page, fed the omniscient observer rows of a re-simulated match, one frame per call. The
 * page's clock is virtual (render.mjs installs it), so every frame is an exact 1/fps step whatever the software
 * renderer's speed. No HUD, chat or debug readouts are constructed; the overlay keeps health bars and map labels.
 */
import { ARMIES, frameOf, type ArmyId, type Plane, type View } from '../../packages/game/src/rules/contract.ts';
import { matchView, type MatchView } from '../../apps/web/src/match-view.ts';
import { Overlay } from '../../apps/web/src/overlay.ts';
import { World } from '../../apps/web/src/world/world.ts';
import '../../apps/web/src/style.css';

export interface Shot { x: number; y: number; dist: number; yaw: number; pitch: number }

const gl = document.querySelector<HTMLCanvasElement>('canvas.gl')!;
const ov = document.querySelector<HTMLCanvasElement>('canvas.overlay')!;
const composite = document.createElement('canvas');
const world = new World(gl);
await world.init();
const overlay = new Overlay(ov);
world.observing = 'all';
await Promise.all(['13px "IM Fell English SC"', '700 18px Caveat', '600 17px Caveat'].map((font) => document.fonts.load(font)));
let previous: MatchView | undefined;
/** The overlay draws health bars for damaged hostiles only (and own structures); a clip names no army, so it draws
 *  them as an army outside the match sees them: every damaged unit of every side, in its side's colour. */
let outsider: ArmyId = 'ne';

function resolve(view: View): MatchView {
  const resolved = matchView(view, previous);
  if (!resolved) throw new Error(`frame ${view.tick} does not resolve against its match`);
  // The omniscient row names entities by sim id (observer.ts).
  resolved.names = 'sim';
  previous = resolved;
  return resolved;
}

const api = {
  /** The first row: rest the camera on `plane`, adopt the match and compile every draw the moment can need. */
  async open(view: View, plane: Plane, candidate: ArmyId): Promise<{ backend: string; gpu: string; size: number; yaw: number }> {
    world.rig.setPreparationPlane(plane, performance.now());
    const resolved = resolve(view);
    outsider = ARMIES.find((army) => !resolved.match.armies.some((a) => a.id === army)) ?? outsider;
    await world.setView(resolved);
    await world.prepareFirstFrame();
    // The candidate's own camera frame (camera.ts centerOn): the clip looks across the map as that player does.
    return { backend: world.backend, gpu: world.gpu, size: world.size, yaw: Math.PI * ((1.25 + frameOf(candidate) * 0.5) % 2) };
  },
  ingest(view: View): void {
    void world.setView(resolve(view));
  },
  /** Draw one frame at the current (virtual) time with the camera at `shot` (tiles of a 48 map scale with the map);
   *  `capture`: also return the composited frame (world, then overlay) as a JPEG data URL. It is read in the task
   *  that drew it, while the WebGL drawing buffer is still intact; a page screenshot would wait on a compositor
   *  frame that never comes while the page's clock stands still. */
  frame(shot: Shot, capture: boolean): { tick: number; jpeg?: string } {
    const rig = world.rig;
    rig.lookAtTile(shot.x, shot.y);
    rig.dist = shot.dist * world.size / 48;
    rig.yaw = shot.yaw;
    rig.pitch = shot.pitch;
    world.frame();
    const army = world.army;
    world.army = outsider;
    overlay.draw(world, performance.now());
    world.army = army;
    const tick = world.entities.renderTick;
    if (!capture) return { tick };
    composite.width = gl.width;
    composite.height = gl.height;
    const ctx = composite.getContext('2d')!;
    ctx.drawImage(gl, 0, 0);
    ctx.drawImage(ov, 0, 0, composite.width, composite.height);
    return { tick, jpeg: composite.toDataURL('image/jpeg', 0.94) };
  },
};
declare global { interface Window { __clip?: typeof api } }
window.__clip = api;
