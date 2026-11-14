/**
 * `?stats`: a corner readout for measuring on a real device (Home backdrop, matches and the observer alike): the
 * backend, the render tier, the pixel ratio in use against the device's, the drawing buffer, frame rate, main-thread
 * frame time, the last frame's draw calls, render passes and compute dispatches, and the GPU's name. Refreshed once a
 * second, when the world closes its frame-rate window; pointer-transparent so it never takes a touch.
 */
import { h } from './dom.ts';
import type { World } from './world/world.ts';

export function statsWanted(search: string = location.search): boolean {
  return new URLSearchParams(search).has('stats');
}

export class StatsReadout {
  readonly el = h('pre', { class: 'stats-readout', 'aria-hidden': 'true' });
  /** The frame-rate window last shown (`World.perf.since`). */
  private shown = 0;

  update(world: World): void {
    const p = world.perf;
    if (p.since === this.shown) return;
    this.shown = p.since;
    const ratio = world.renderer.getPixelRatio();
    this.el.textContent = `${world.backend} · ${world.quality.tier} tier · ${p.fps.toFixed(0)} fps · ${p.frameMs.toFixed(1)} ms main\n`
      + `DPR ${ratio.toFixed(2)} of ${devicePixelRatio.toFixed(2)} (cap ${world.quality.maxPixelRatio}) · ${world.canvas.width}×${world.canvas.height} px · MSAA ${world.quality.msaa ? 'on' : 'off'}\n`
      + `${p.draws} draws · ${p.passes} passes · ${p.computes} compute\n`
      + (world.gpu || 'GPU not named');
  }
}
