/** Orbit plane: asteroid schedule, registry shields, Sun Lance, Aegis and cloaking. */
import { TICK_RATE } from '../rules/contract.ts';
import { DEPLOY_NONE, SNAP_EPS } from '../sim/constants.ts';
import { Ent } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import { clampPos } from '../util/grid.ts';
import { canonX, canonY, isArmy, NEUTRAL, rotX, rotY } from '../util/teams.ts';
import { norm, norm2, sq } from '../util/math.ts';

export class OrbitPlane {
  /** Next tick a pair of drifting asteroids may spawn (public schedule). */
  nextAsteroidSpawn(this: Sim): number {
    const p = this.econ.asteroidSpawnTicks;
    const o = this.econ.asteroidSpawnOffset % p;
    const k = Math.floor((this.tick - o) / p) + 1;
    return k * p + o;
  }

  /** Registry shields exist only in Orbit; service shares the segment's salvage docking radius. */
  updateOrbitShields(this: Sim): void {
    for (const e of this.ents) {
      if (e.dead || !e.unit || !e.built || !isArmy(e.side) || (e.plane !== 'orbit' && e.maxShield === 0)) continue;
      const s = this.statsOf(e)!;
      const capacity = e.plane === 'orbit' ? s.shield ?? 0 : 0;
      if (capacity !== e.maxShield) {
        e.shield = capacity > e.maxShield ? capacity : Math.min(e.shield, capacity);
        e.maxShield = capacity;
      }
      if (e.plane !== 'orbit' || e.hangar || e.transitKind?.stationary) continue;
      const calm = e.combatAt < 0 || this.tick - e.combatAt >= (s.shieldDelay ?? 0);
      if (capacity > 0 && calm) e.shield = Math.min(capacity, e.shield + (s.shieldRegen ?? 0) / TICK_RATE);
      // A packed (not anchored) solar array patches its own hull once out of combat: fold to heal, or stay to earn.
      if (e.kind === 'solar' && e.deploy === DEPLOY_NONE && (e.combatAt < 0 || this.tick - e.combatAt >= this.econ.arrayRepairDelay)) {
        e.hp = Math.min(e.maxHp, e.hp + this.econ.arrayRepair / TICK_RATE);
      }
      // Docking repairs every own Orbit unit at the own segment, shield or none, and never in sudden death.
      const segment = this.armies[e.side]!.spire.orbit;
      if (!segment || segment.dead || segment.hp <= 0 || this.suddenDeath() || norm2(e.x - segment.x, e.y - segment.y) > sq(this.econ.dockRadius)) continue;
      e.hp = Math.min(e.maxHp, e.hp + this.econ.orbitDockHull / TICK_RATE);
      if (capacity > 0) e.shield = Math.min(capacity, e.shield + this.econ.orbitDockShield / TICK_RATE);
    }
  }

  canSunLance(this: Sim, e: Ent, x: number, y: number): boolean {
    return !e.dead && e.hp > 0 && e.built && !e.hangar && !e.transitKind && isArmy(e.side)
      && this.hasAbility(e, 'sun_lance') && e.abilityReady <= this.tick && e.lanceAt === 0
      && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= this.size && y >= 0 && y <= this.size
      && norm(x - e.x, y - e.y) > SNAP_EPS && this.lit(e.x, e.y)
      && this.canSpend(e.side, 0, this.econ.lanceEnergy, e.plane);
  }

  sunLance(this: Sim, e: Ent, x: number, y: number): boolean {
    if (!this.canSunLance(e, x, y)) return false;
    if (!this.spend(e.side, 0, this.econ.lanceEnergy, e.plane)) return false;
    e.abilityReady = this.tick + this.econ.lanceCooldown;
    e.lanceAt = this.tick + this.econ.lanceCharge;
    e.lanceX = x;
    e.lanceY = y;
    this.revealAbility(e, 'sun_lance');
    return true;
  }

  canAegis(this: Sim, e: Ent): boolean {
    return !e.dead && e.hp > 0 && e.built && !e.hangar && !e.transitKind && isArmy(e.side)
      && this.hasAbility(e, 'aegis') && e.abilityReady <= this.tick && e.aegisUntil <= this.tick
      && e.shield > 0 && this.canSpend(e.side, 0, this.econ.aegisEnergy, e.plane);
  }

  activateAegis(this: Sim, e: Ent): boolean {
    if (!this.canAegis(e)) return false;
    if (!this.spend(e.side, 0, this.econ.aegisEnergy, e.plane)) return false;
    e.abilityReady = this.tick + this.econ.aegisCooldown;
    e.aegisUntil = this.tick + this.econ.aegisDuration;
    e.aegisPool = e.shield * this.econ.aegisShieldMultiplier;
    e.vx = e.vy = 0;
    this.revealAbility(e, 'aegis');
    return true;
  }

  breakCloak(this: Sim, e: Ent): void {
    if (e.kind !== 'skiff' || !this.hasAbility(e, 'night_cloak')) return;
    e.cloaked = false;
    e.cloakReady = this.tick + this.econ.cloakBreakTime;
  }

  /** Refresh before decisions and after movement; charged shots launch only after movement. */
  updateOrbitAbilities(this: Sim, fire: boolean): void {
    for (const e of this.ents) {
      if (e.dead || e.hp <= 0) continue;
      if (e.aegisUntil && (e.aegisUntil <= this.tick || e.aegisPool <= 0 || e.plane !== 'orbit')) {
        e.aegisUntil = e.aegisPool = 0;
      }
      if (e.kind === 'skiff') {
        const eligible = e.built && !e.hangar && !e.transitKind?.stationary && this.hasAbility(e, 'night_cloak');
        if (!eligible) e.cloaked = false;
        else if (this.lit(e.x, e.y)) {
          if (e.cloaked) this.breakCloak(e);
        } else if (e.cloakReady <= this.tick) e.cloaked = true;
      }
      if (!fire || e.lanceAt === 0 || e.lanceAt > this.tick) continue;
      e.lanceAt = 0;
      if (!this.hasAbility(e, 'sun_lance') || !this.lit(e.x, e.y) || e.hangar || e.transitKind) continue;
      const by = e.side;
      // The bolt flies in the firing army's frame: rotated lances sweep exactly rotated paths.
      const k = e.frame;
      const x = canonX(k, e.x, e.y, this.size);
      const y = canonY(k, e.x, e.y, this.size);
      const dx = canonX(k, e.lanceX, e.lanceY, this.size) - x;
      const dy = canonY(k, e.lanceX, e.lanceY, this.size) - y;
      const length = norm(dx, dy);
      if (length <= SNAP_EPS) continue;
      const ux = dx / length;
      const uy = dy / length;
      this.lances.push({ by, x, y, dx: ux, dy: uy, distance: 0, hit: new Set() });
      e.shield = 0;
      e.combatAt = this.tick;
      const tx = x + ux * this.econ.lanceRange;
      const ty = y + uy * this.econ.lanceRange;
      this.fxAdd('lance', 'orbit', e.x, e.y, by, false, {
        tx: clampPos(rotX(k, tx, ty, this.size), this.size), ty: clampPos(rotY(k, tx, ty, this.size), this.size),
        arrive: this.tick + Math.ceil(this.econ.lanceRange * TICK_RATE / this.econ.lanceSpeed),
        side: by, subject: e.kind, src: e.id,
      });
    }
  }

  advanceLances(this: Sim): void {
    let keep = 0;
    for (const bolt of this.lances) {
      const k = this.armyFrame[bolt.by]!;
      const end = Math.min(this.econ.lanceRange, bolt.distance + this.econ.lanceSpeed / TICK_RATE);
      // Find contacts in physical order, not entity/bucket storage order. Each entity is hit once per bolt.
      for (;;) {
        let target: Ent | undefined;
        let nearest = Infinity;
        for (const e of this.ents) {
          // No friendly fire: the bolt passes every army that is not hostile to its owner (own and allied) and neutrals.
          if (e.dead || e.hp <= 0 || e.hangar || e.plane !== 'orbit' || !this.hostile(bolt.by, e.side)
            || (!e.unit && !e.structure) || bolt.hit.has(e.id)) continue;
          const x = canonX(k, e.x, e.y, this.size) - bolt.x;
          const y = canonY(k, e.x, e.y, this.size) - bolt.y;
          const f = e.structure ? this.statsOf(e)?.footprint : undefined;
          let enter: number;
          let exit: number;
          if (f) {
            const w = f.w / 2 + this.econ.lanceWidth;
            const h = f.h / 2 + this.econ.lanceWidth;
            if ((bolt.dx === 0 && Math.abs(x) > w) || (bolt.dy === 0 && Math.abs(y) > h)) continue;
            const ax = bolt.dx === 0 ? -Infinity : (x - w) / bolt.dx;
            const bx = bolt.dx === 0 ? Infinity : (x + w) / bolt.dx;
            const ay = bolt.dy === 0 ? -Infinity : (y - h) / bolt.dy;
            const by = bolt.dy === 0 ? Infinity : (y + h) / bolt.dy;
            enter = Math.max(Math.min(ax, bx), Math.min(ay, by));
            exit = Math.min(Math.max(ax, bx), Math.max(ay, by));
          } else {
            const along = x * bolt.dx + y * bolt.dy;
            const across = x * bolt.dy - y * bolt.dx;
            const radius = e.radius + this.econ.lanceWidth;
            if (across * across > radius * radius) continue;
            const half = Math.sqrt(Math.max(0, radius * radius - across * across));
            enter = along - half;
            exit = along + half;
          }
          if (exit < bolt.distance || enter > end || enter > exit) continue;
          const at = Math.max(bolt.distance, enter);
          // Equal contact: lower serial, then (rotated twins of two hostile armies) relative order from the owner.
          if (at < nearest || (at === nearest && (e.seq < (target?.seq ?? Infinity)
            || (e.seq === target?.seq && this.rel(bolt.by, e.side) < this.rel(bolt.by, target.side))))) {
            target = e;
            nearest = at;
          }
        }
        if (!target) break;
        // Structures (the Orbit Spire segment included) take a share: the lance is a ship-killer, not a siege gun.
        const damage = (bolt.hit.size === 0 ? this.econ.lanceDamage : this.econ.lancePierceDamage) * (target.structure ? this.econ.lanceStructureMultiplier : 1);
        bolt.hit.add(target.id);
        this.damage(target, damage, bolt.by, false, 'sun_lance', 'orbit', 'lancer');
        const x = bolt.x + bolt.dx * nearest;
        const y = bolt.y + bolt.dy * nearest;
        this.fxAdd('lance_hit', 'orbit', clampPos(rotX(k, x, y, this.size), this.size), clampPos(rotY(k, x, y, this.size), this.size), NEUTRAL, false, {
          side: bolt.by, subject: target.kind,
        });
      }
      bolt.distance = end;
      if (end < this.econ.lanceRange) this.lances[keep++] = bolt;
    }
    this.lances.length = keep;
  }
}
