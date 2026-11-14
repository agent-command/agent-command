/**
 * Falling asteroids: the inked rock with its brush-streak fire trail (hot emissive head that blooms, pigment body,
 * ink-grey smoke tail). Driven by `view.impacts`; the impact-zone stamps are telegraphs (`telegraphs.ts`), the
 * explosion and shockwaves come from `combat.ts` (view.fx).
 */
import { ConeGeometry, DodecahedronGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import { abs, color, float, mix, mx_noise_float, normalWorld, positionLocal, sin, smoothstep, time, uv, vec3 } from 'three/tsl';
import { ECON, PLANE_Y, TICK_RATE, type View } from '@agent-command/game/contract';
import { fadeValue } from './fade.ts';
import { asteroidPosition, rockResource, rockScale, type Fall } from './asteroid.ts';
import { SUN, aboveStorm, cel, planeLines, type V3 } from './materials.ts';
import { SHADOW } from './palette.ts';

interface Faller {
  group: Group;
  rock: Mesh;
  /** The trail's own copy of the rock's frame, in `aboveStorm`. */
  trailFrame: Group;
  trail: Mesh;
}

export class Fx {
  readonly root = new Group();
  /** Trails, drawn after the Sky's storms (`aboveStorm`): a rock falling in front of a storm keeps its streak. */
  readonly aboveStorm = new Group();
  /** Whether a trail draws this frame (the ink overlay pass is skipped otherwise). */
  aboveStormShown = false;
  /** Observed resource/volatile variants; public falls use unidentified paint. */
  readonly shaderTemplates: readonly Mesh[];
  private readonly fallers: Faller[] = [];
  private impacts: View['impacts'] = [];
  private tick = 0;
  private readonly rockMats: MeshBasicNodeMaterial[] = [];
  /** Keep trajectories by entity id, not target coordinates: several rocks can share one landing cell.
   * `until` is an exclusive server tick. A missing live impact retires at the snapshot boundary unless its
   * terminal event supplies the exact tick, including when the entity was never received.
   */
  private readonly trajectories = new Map<string, { fall: Fall; until: number; scale: number; material: number }>();

  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.root.renderOrder = 70; // groupOrder: after layers and entities
    // cel rock with ink lines, its lee side glowing hot
    for (let variant = 0; variant < 6; variant++) {
      const resource = variant % 3, volatile = variant >= 3;
      const rockMat = new MeshBasicNodeMaterial();
      const vein = abs(sin(positionLocal.x.mul(8).add(positionLocal.y.mul(5)).add(sin(positionLocal.z.mul(9)))));
      const seam = float(1).sub(smoothstep(0.14, 0.3, vein));
      const body = resource === 0 ? color('#8a6a58') : resource === 1 ? mix(color('#8a6a58'), color('#71d6bf'), seam) : mix(color('#70b9dc'), color('#ecfbff'), seam);
      const pigment = volatile ? mix(body, color('#ffd59b'), float(1).sub(smoothstep(0.05, 0.13, vein))) : body;
      rockMat.colorNode = cel(pigment as unknown as V3, SHADOW.surface).add(color('#ff6a1f').mul(sin(time.mul(14)).mul(0.3).add(1.2)).mul(smoothstep(0.2, -0.6, normalWorld.dot(SUN))));
      rockMat.mrtNode = planeLines('surface');
      this.rockMats.push(rockMat);
    }
    // brush streak: bristle lines along the trail, hot at the head, pigment, then ink-grey smoke at the tail
    const trailMat = aboveStorm(new MeshBasicNodeMaterial({ side: DoubleSide }));
    const h = positionLocal.y;
    const bristle = mx_noise_float(vec3(uv().x.mul(14), h.mul(2).sub(time.mul(3)), 0)).mul(0.5).add(0.5);
    const hot = mix(color('#ffd27a').mul(1.6), color('#ec5a24'), smoothstep(0, 0.25, h));
    trailMat.colorNode = mix(hot, color('#5a4c4a'), smoothstep(0.25, 0.9, h));
    trailMat.opacityNode = float(1).sub(h).pow(1.3).mul(smoothstep(0.25, 0.6, bristle).mul(0.55).add(0.35));
    const trailDir = new Vector3(-6, PLANE_Y.orbit - PLANE_Y.surface, -3).normalize();
    for (let i = 0; i < 16; i++) {
      const g = new Group();
      const rock = new Mesh(new DodecahedronGeometry(0.9, 0), this.rockMats[0]!);
      // trail points back along the shared asteroid trajectory
      const trailFrame = new Group();
      const trail = new Mesh(new ConeGeometry(0.85, 1, 12, 1, true).translate(0, 0.5, 0), trailMat);
      trail.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), trailDir);
      rock.renderOrder = 65;
      trail.renderOrder = 66;
      g.add(rock);
      trailFrame.add(trail);
      g.visible = trailFrame.visible = false;
      this.root.add(g);
      this.aboveStorm.add(trailFrame);
      this.fallers.push({ group: g, rock, trailFrame, trail });
    }
    const first = this.fallers[0]!;
    this.shaderTemplates = [...this.rockMats.map(material => new Mesh(first.rock.geometry, material)), first.trail];
  }

  /** Forget the previous match (back to the lobby). */
  reset(): void {
    this.impacts = [];
    this.trajectories.clear();
  }

  ingest(view: View): void {
    this.impacts = view.impacts;
    this.tick = view.tick;
    // Each view replaces the public impact list (it is not a delta); terminal FX have a short retention window.
    // After a packet gap, stop displaying absent entries at this snapshot instead of leaving a missed
    // interception falling until landing. Live entries and exact terminal events below restore their bounds.
    for (const trajectory of this.trajectories.values()) trajectory.until = Math.min(trajectory.until, view.tick);
    for (const fall of view.impacts) this.trajectory(view, fall, fall.tick);
    // The entity is already absent when its termination arrives. Retain/reconstruct the rock until
    // that event reaches the interpolation clock, including when this is our first snapshot.
    for (const f of view.fx) {
      if (f.fall && (f.kind === 'intercept' || f.kind === 'impact')) {
        this.trajectory(view, f.fall, f.tick);
      }
    }
  }

  private trajectory(view: View, fall: Fall, until: number): void {
    const rock = view.entities.find(e => e.id === fall.id);
    const previous = this.trajectories.get(fall.id);
    this.trajectories.set(fall.id, {
      fall, until,
      scale: rock ? rockScale(rock) : previous?.scale ?? (fall.radius ?? ECON.impactRadius) / ECON.impactRadius,
      material: rock ? rockResource(rock) * 2 + (rock.volatile === true ? 3 : 0) : 0,
    });
  }

  /** Use the entity interpolation clock, not newest-view time; combat retires/spawns at this same boundary. */
  frame(now: number, renderTick: number): void {
    const shown = fadeValue.surface > 0.03 || fadeValue.sky > 0.03 || fadeValue.orbit > 0.03;
    let i = 0;
    for (const [id, trajectory] of this.trajectories) {
      if (renderTick >= trajectory.until) {
        this.trajectories.delete(id);
        continue;
      }
      if (i === this.fallers.length) break;
      const f = this.fallers[i++]!;
      const p = asteroidPosition(trajectory.fall, renderTick, f.group.position, this.size);
      f.group.visible = f.trailFrame.visible = shown;
      f.group.scale.setScalar(trajectory.scale);
      f.trailFrame.position.copy(f.group.position);
      f.trailFrame.scale.copy(f.group.scale);
      f.rock.material = this.rockMats[trajectory.material]!;
      f.rock.rotation.set(now * 0.003, now * 0.002, 0);
      f.trail.scale.set(1, 3 + p * 9, 1);
    }
    this.aboveStormShown = i > 0 && shown;
    for (; i < this.fallers.length; i++) this.fallers[i]!.group.visible = this.fallers[i]!.trailFrame.visible = false;
  }

  /** Seconds until impact `i` (for overlay labels). */
  secondsLeft(i: View['impacts'][number], sinceView: number): number {
    return Math.max(0, (i.tick - (this.tick + sinceView * TICK_RATE)) / TICK_RATE);
  }

  get falling(): View['impacts'] {
    return this.impacts;
  }
}
