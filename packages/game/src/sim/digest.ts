/** Deterministic state digest (`Sim.hash()`): every piece of match state, mixed in a fixed order. */
import { INTENT_SOURCES } from 'playerthree/manifest';
import { PLANES, UPGRADE_IDS } from '../rules/contract.ts';
import { DIGEST_CELL_GATE, DIGEST_CELL_HOLE, DIGEST_CELL_KIND, DIGEST_CELL_TOUGH, DIGEST_HIGH, PLANE_INDEX } from './constants.ts';
import {
  hashBegin,
  hashEnd,
  ITEM_CODE,
  KIND_CODE,
  mix,
  mixBool,
  mixController,
  mixMap,
  mixOrder,
  REASON_CODE,
  sideCode,
  STANCE_CODE,
  STATE_CODE,
  STATUS_CODE,
  WEAPON_CODE,
} from './hash.ts';
import type { Sim } from './sim.ts';

export class SimDigest {
  /**
   * FNV-1a over the authoritative state: entities (with orders, motion, cooldowns and work), terrain and work grids,
   * lodes, projectiles, charges, floods, team economy, research, designations, scans, queues and the RNG. Derived
   * caches (vision, paths, flow fields), fog memory and entity aliases (sim/aliases.ts) are left out. Allocation-free:
   * strings mix by registry index.
   */
  hash(this: Sim): string {
    hashBegin();
    mix(this.tick);
    mix(this.rng.state);
    mix(this.rockRng.state);
    this.weather.mixHash();
    mix(this.nextId);
    mix(this.coreId);
    mix(this.coreRegrowAt);
    mix(this.coreLift.at); mix(this.coreLift.x); mix(this.coreLift.y); mix(sideCode(this.coreLift.side));
    for (const e of this.ents) {
      mix(e.id);
      mix(KIND_CODE[e.kind]);
      mix(sideCode(e.side));
      mix(PLANE_INDEX[e.plane]);
      mix(STATE_CODE[e.state]);
      mix(STANCE_CODE[e.stance]);
      mix(e.x);
      mix(e.y);
      mix(e.elevation);
      mix(e.skyIsland);
      mix(e.vx);
      mix(e.vy);
      mix(e.avx);
      mix(e.avy);
      mix(e.skirt);
      mixBool(e.skim);
      mix(e.heading);
      mix(e.aim);
      mix(e.aimTarget);
      mix(e.faceTarget);
      mix(e.hp);
      mix(e.maxHp);
      mix(e.shield);
      mix(e.maxShield);
      mix(e.combatAt);
      mix(e.stationPdCd);
      mix(e.abilityReady);
      mix(e.lanceAt);
      mix(e.lanceX);
      mix(e.lanceY);
      mix(e.aegisUntil);
      mix(e.aegisPool);
      mix(e.cloakReady);
      mixBool(e.cloaked);
      mixBool(e.stormOk);
      mixBool(e.evading);
      mix(e.deploy);
      mix(e.deployAt);
      mixBool(e.built);
      mix(e.cd);
      mix(e.engage);
      mix(e.workT);
      mix(e.progress);
      mix(e.carry);
      mix(e.lodeCarry);
      mix(e.digAt);
      mix(e.link);
      mix(e.hangar);
      mix(e.hardpoint);
      mix(e.ready);
      mix(e.activeUntil);
      mix(e.orbitDelay);
      mix(e.oreCapacity);
      mix(e.oreRemaining);
      mix(e.oreBuffer);
      mix(e.mooringTarget);
      mix(e.mooringTower);
      mix(e.mooringPhase);
      mix(e.mooringGrace);
      mix(e.mooringDebt);
      mix(e.mooringReadyAt);
      mix(e.mooringAt);
      mix(e.mooringRiseAt);
      mix(e.pocket);
      mix(e.coolAt);
      mix(e.capT);
      mix(sideCode(e.capSide));
      mix(e.transitAt);
      mix(e.transitUntil);
      mix(e.transitReady);
      mix(e.impactTick);
      mix(e.fuseUntil);
      if (e.kind === 'asteroid') {
        mix(e.rockSize === 'pebble' ? 1 : e.rockSize === 'large' ? 2 : 0);
        mix(e.resourceType === 'metal' ? 1 : e.resourceType === 'ice' ? 2 : 0);
        mix(+e.volatile);
        mix(e.resourceRemaining);
        mix(e.miningTug);
      }
      if (e.kind === 'tug') {
        mix(e.miningTarget);
        mix(e.cargoAlloy);
        mix(e.cargoEnergy);
      }
      if (e.kind === 'core') {
        mix(e.vents);
        mix(e.heat);
        mix(e.heatRate);
      }
      if (e.kind === 'solar') {
        mix(e.ramp);
        mix(e.output);
      }
      mix(e.designation);
      mix(e.designationConnector);
      mixOrder(e.order);
      mix(e.queue.length);
      for (const o of e.queue) mixOrder(o);
    }
    for (let c = 0; c < this.n; c++) {
      mix(this.cells[c]! * DIGEST_CELL_KIND + this.holes[c]! * DIGEST_CELL_HOLE + this.owner[c]! + this.gate[c]! * DIGEST_CELL_GATE + this.tough[c]! * DIGEST_CELL_TOUGH);
      if (this.work[c]) mix(c * DIGEST_HIGH + this.work[c]!);
      // The hole's opener (fall credit), only where a hole stands: matches without holes hash as before.
      if (this.holes[c]) mix(c * DIGEST_HIGH + sideCode(this.holeBy[c]!));
    }
    mixMap(this.railWork);
    mixMap(this.bridgeWork);
    for (const l of this.lodes) mix(l.left + (l.open ? DIGEST_HIGH : 0));
    for (const id of this.motherHolders) mix(id);
    for (const loads of this.motherReserve) mix(loads);
    mix(this.lodePressure);
    // Mixed only while a fuse burns, like the window's non-zero slots: matches whose lode never commits hash as before.
    if (this.lodeVentAt) mix(DIGEST_HIGH + this.lodeVentAt);
    mix(this.lodeCoolUntil);
    mix(this.lodeRecent);
    for (let i = 0; i < this.lodeWindow.length; i++) if (this.lodeWindow[i]) mix(i * DIGEST_HIGH + this.lodeWindow[i]!);
    mix(this.projectiles.length);
    for (const p of this.projectiles) {
      mix(sideCode(p.by));
      mix(WEAPON_CODE[p.w]);
      mix(p.dmg);
      mix(p.splash);
      mix(PLANE_INDEX[p.plane]);
      mix(p.x);
      mix(p.y);
      mix(p.sourceElevation);
      mix(p.targetElevation);
      mix(p.target);
      mixBool(p.homing);
      mix(p.arrive);
      mix(p.reserved);
    }
    mix(this.lances.length);
    for (const bolt of this.lances) {
      mix(sideCode(bolt.by)); mix(bolt.x); mix(bolt.y); mix(bolt.dx); mix(bolt.dy); mix(bolt.distance);
      mix(bolt.hit.size);
      for (const id of bolt.hit) mix(id);
    }
    mix(this.oreCaches.length);
    for (const c of this.oreCaches) {
      mix(c.id); mix(c.x); mix(c.y); mix(c.alloy);
      mix(c.belowX); mix(c.belowY); mix(c.belowAlloy);
      mix(sideCode(c.side)); mix(sideCode(c.surfaceHolder)); mix(c.surfaceTicks);
      mix(sideCode(c.depthsHolder)); mix(c.depthsTicks); mixBool(c.placed);
    }
    mix(this.scorches.length);
    for (const s of this.scorches) {
      mix(s.x); mix(s.y); mix(s.radius); mix(s.until); mix(sideCode(s.by)); mix(s.dps); mixBool(s.cause === 'radiation');
    }
    mix(this.charges.length);
    for (const c of this.charges) {
      mix(sideCode(c.side));
      mix(c.c);
      mix(c.at);
      mix(c.defuse);
      mix(c.stack);
      mix(c.reach);
      mix(c.known);
    }
    mix(this.flares.length);
    for (const f of this.flares) {
      mix(sideCode(f.side));
      mix(f.c);
      mix(f.until);
    }
    mix(this.floods.length);
    for (const f of this.floods) {
      mix(sideCode(f.side));
      mix(f.origin);
      mix(f.limit);
      mixBool(f.orbit);
      mix(f.nextAt);
      mix(f.coolAt);
      for (const g of this.groups) mix(f.knownAt[g.id]!);
      mix(f.cells.length);
      for (const c of f.cells) mix(c);
    }
    for (const t of this.armies) {
      mix(t.alloy);
      mix(t.energy);
      mix(t.energyBank);
      mix(t.pop);
      mix(t.spawnI);
      // Contested-point ticks decide the time-cap tiebreak (rules.surface.postScore).
      mix(t.stats.pointTicks);
      for (const plane of PLANES) { mix(t.rally[plane].x); mix(t.rally[plane].y); }
      for (const upgrade of UPGRADE_IDS) {
        mixBool(t.research.has(upgrade));
        // What this army's group has seen of each hostile army, in relative order from the army.
        for (let r = 1; r < this.sides; r++) {
          for (const b of this.allArmies) if (this.rel(t.army, b) === r && this.hostile(t.army, b)) mixBool(t.group.seenResearch[b]!.has(upgrade));
        }
      }
      if (t.designationCount) {
        for (let w = 0; w < this.visionWords; w++) {
          if (t.designationWords.normal[w]) { mix(w); mix(t.designationWords.normal[w]!); }
          if (t.designationWords.urgent[w]) { mix(w + this.visionWords); mix(t.designationWords.urgent[w]!); }
        }
      }
      mix(t.scans.length);
      for (const s of t.scans) {
        mix(s.x);
        mix(s.y);
        mix(s.until);
      }
      mix(t.queueSeq);
      // Mixed only once an army has rebuilt: matches without a rebuild hash as before.
      if (t.rebuilds) mix(DIGEST_HIGH + t.rebuilds);
      mix(t.queue.length);
      for (const e of t.queue) {
        mix(e.id);
        mix(ITEM_CODE[e.item]);
        mix(PLANE_INDEX[e.plane]);
        mix(PLANE_INDEX[e.by]);
        mixController(e.byCtl);
        mix(INTENT_SOURCES.indexOf(e.source));
        mix(e.x);
        mix(e.y);
        mix(e.island);
        mix(e.producer);
        mix(e.pocket);
        mix(STATUS_CODE[e.status]);
        mix(e.reason === null ? 0 : REASON_CODE[e.reason]);
        mix(e.left);
        mix(e.site);
        mixBool(e.started);
        mix(e.heldAlloy);
        mix(e.heldEnergy);
        mixBool(e.funding);
        mixBool(e.recovery);
        mix(e.blockedAt);
        mix(e.digger);
        mix(e.retry);
      }
    }
    // Wider than two armies: owner codes and gate bits outgrow the packed per-cell value above, and armies can be
    // eliminated. (Two-army matches keep their historic digest.)
    if (this.allArmies.length > 2) {
      for (let c = 0; c < this.n; c++) if (this.owner[c]! > 2 || this.gate[c]! > 3) mix(c * DIGEST_HIGH + this.owner[c]! * DIGEST_CELL_GATE + this.gate[c]!);
      for (const a of this.allArmies) { mix(this.eliminatedAt[a]!); mix(this.eliminatedBy[a]!); }
    }
    return hashEnd();
  }
}
