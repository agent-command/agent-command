import { Color, Group, InstancedMesh, Object3D, Vector2, type BufferGeometry, type MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import { abs, attribute, float, mix, normalWorld, positionGeometry, positionLocal, positionWorld, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import { weatherStormAt } from '@agent-command/game/weather';
import type { View } from '@agent-command/game/contract';
import { clock, inkMaterial, rgb, windBend, type F1, type V3 } from './materials.ts';
import type { FogField } from './fog.ts';
import type { Track } from './entities.ts';
import { islandPlantModel, islandPlants, turnAngle } from './models.ts';
import { prepareStartup } from './startup.ts';

/** Shared immutable species kit; each island shares one weather uniform/material across its trees. */
const species: BufferGeometry[] = [];
/** Seconds for an island's wet look to ease fully in or out as it enters or leaves a storm. */
const WET_EASE_S = 1.5;

function speciesModel(kind: number): BufferGeometry {
  return (species[kind] ??= islandPlantModel(kind));
}

/** Keep the species recipes out of module evaluation and separate them from the first island's construction task. */
export function prepareIslandGroves(): Promise<void> {
  return prepareStartup((function* () {
    for (let kind = 0; kind < 4; kind++) {
      speciesModel(kind);
      yield;
    }
  })());
}

/** Rain-darkened vegetation and a cool travelling glint tie the exposed island and canopy together. Green pigment
 * selects turf/leaves, not tan slot pads, trunks or ownership accents. This signals exposure, never damage amount. */
export function islandStormPaint(base: V3, storm: Node<'vec2'>, normal: V3, world: V3, eligible: F1 = float(1)): V3 {
  const foliage = smoothstep(0.01, 0.09, base.g.sub(base.r)).mul(eligible).mul(storm.x);
  const sweep = sin(world.x.mul(0.65).add(world.z.mul(0.45)).add(world.y.mul(0.9)).sub(clock.mul(storm.y).mul(2)));
  const glint = smoothstep(0.78, 0.98, sweep).mul(0.27);
  const rim = float(1).sub(abs(normal.y)).pow(2).mul(0.22);
  const wet = base.mul(rgb('#869ac4')) as V3;
  const charged = mix(wet, rgb('#b9e8ff'), glint.add(rim)) as V3;
  return mix(base, charged, foliage) as V3;
}

export class IslandGrove {
  readonly group = new Group();
  /** x = storm exposure easing toward canonical membership (0..1, `WET_EASE_S`), y = permitted cosmetic motion; both
   * zero when fog-hidden. */
  readonly storm = uniform(new Vector2());
  private readonly material: MeshBasicNodeMaterial;

  /** `barren`: the public ore-crag phenotype (oreCapacity > 0) keeps only sparse dry scrub. */
  constructor(seed: number, turns: number, barren = false) {
    const plants = islandPlants(seed, turns, barren);
    const pose = new Object3D();
    const tint = new Color();
    this.group.name = 'island-grove';
    this.material = inkMaterial('sky', islandStormPaint(attribute('paint', 'vec3'), this.storm, normalWorld, positionWorld), { fog: false });
    const bend = sin(clock.mul(2.1).add(positionGeometry.y.mul(3))).mul(positionGeometry.y.max(0).pow(2).min(1.5))
      .mul(this.storm.x).mul(this.storm.y).mul(0.08);
    // the storm bend rides on the Surface's constant breeze, so groves are never frozen between storms
    this.material.positionNode = positionLocal.add(vec3(bend, 0, bend.mul(0.35))).add(windBend(positionGeometry.y as F1));
    for (let kind = 0; kind < 4; kind++) {
      const grove = plants.filter((plant) => plant.species === kind);
      if (!grove.length) continue;
      const mesh = new InstancedMesh(speciesModel(kind), this.material, grove.length);
      mesh.name = `island-species-${kind}`;
      for (let i = 0; i < grove.length; i++) {
        const plant = grove[i]!;
        pose.position.set(plant.x, plant.y, plant.z);
        if (turns === 2) pose.scale.set(-plant.scale, plant.scale, -plant.scale);
        else {
          pose.scale.setScalar(plant.scale);
          pose.rotation.y = turnAngle(turns);
        }
        pose.updateMatrix();
        mesh.setMatrixAt(i, pose.matrix);
        mesh.setColorAt(i, tint.setRGB(plant.tint, plant.tint, plant.tint));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      this.group.add(mesh);
    }
  }

  /** Match the authoritative snapshot's weather membership, not the decorative cloud mesh or feather radius.
   * Islands are public tracks, so rendered + currently visible is an additional mandatory gate for this response.
   * Entering or leaving a storm eases the wet look over `WET_EASE_S` (`dt` seconds this frame); reduced motion and
   * losing sight are immediate. */
  updateWeather(weather: View['weather'], track: Track, size: number, fogField: FogField | undefined, reducedMotion: boolean, dt: number): void {
    const visible = track.visible && (!fogField || fogField.tileVisible('sky', track.rx, track.ry));
    const target = visible && weatherStormAt(weather, track.e.x, track.e.y, size) ? 1 : 0;
    const wet = this.storm.value.x;
    // A rewound frame clock (negative dt) holds the ramp rather than running it away from the target.
    const step = Math.max(0, dt) / WET_EASE_S;
    const next = !visible || reducedMotion ? target : wet + Math.max(-step, Math.min(step, target - wet));
    this.storm.value.set(next, next > 0 && !reducedMotion ? 1 : 0);
  }

  dispose(): void {
    for (const child of this.group.children) (child as InstancedMesh).dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }
}
