/** The live menu diorama's attract camera; imported only after the interactive DOM has painted. */
import type { Plane } from '@agent-command/game/contract';
import type { World } from './world/world.ts';

const ATTRACT_PLANES = ['surface', 'sky', 'orbit', 'sky', 'surface', 'depths'] as const;

/** Camera distance per map tile and centre drift per map tile: the whole previewed map stays in frame at any size. */
const ATTRACT_DIST = 0.96;
const ATTRACT_DRIFT = 1 / 12;
/** After a map is (re)shown, stay on the Surface this long so the player sees the map they picked before the tour. */
const SHOWCASE_MS = 12000;

/** Slow orbit framing the whole previewed map; `t` restarts whenever a map is shown. `pinned` (the home plane picker)
 *  holds that plane instead of touring. Until `toured` (every plane's pipelines are warm) it stays on the Surface:
 *  diving into a cold plane would build its shaders synchronously. */
export function attract(world: World, t: number, dt: number, pinned: Plane | undefined, toured: boolean): void {
  const rig = world.rig;
  rig.yaw += dt * 0.06;
  rig.dist = world.size * ATTRACT_DIST;
  rig.pitch = 0.78;
  rig.tx = Math.sin(t / 9000) * world.size * ATTRACT_DRIFT;
  rig.tz = Math.cos(t / 11000) * world.size * ATTRACT_DRIFT;
  const plane = !toured ? 'surface' : pinned ?? (t < SHOWCASE_MS ? 'surface' : ATTRACT_PLANES[Math.floor((t - SHOWCASE_MS) / 5200) % ATTRACT_PLANES.length]!);
  if (rig.focus !== plane && !rig.diving) rig.goTo(plane, performance.now(), 'tour');
}
