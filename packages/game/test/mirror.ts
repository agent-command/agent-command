import type { Sim } from '../src/sim/sim.ts';
import type { Ent, Order } from '../src/sim/ent.ts';
import { type Army, NEUTRAL, rotVX, rotVY, rotX, rotY } from '../src/util/teams.ts';

/**
 * The layout's rotation group (DESIGN §15.4): every quarter-turn count r (a multiple of the map's slot step) that maps
 * each army's slot onto another army's slot with the same alliance structure. Two armies on a C2 map: {0, 2}; four
 * singleton armies on a C4 map: {0, 1, 2, 3}; a C4 duel on opposite slots: {0, 2}.
 */
export function rotationGroup(sim: Sim): number[] {
  const group: number[] = [];
  for (let k = 0; k < sim.sides; k++) {
    const map = armyRotation(sim, k * sim.slotStep);
    if (!map) continue;
    // Alliances must map onto alliances (singletons until stage 3: any slot permutation keeps them).
    if (sim.allArmies.every((a) => sim.allArmies.every((b) => (sim.armyColour[a] === sim.armyColour[b]) === (sim.armyColour[map[a]!] === sim.armyColour[map[b]!])))) group.push(k * sim.slotStep);
  }
  return group;
}

/** Army `a` → the army whose slot is `a`'s slot turned by `r` quarter turns (undefined: some rotated slot is empty). */
function armyRotation(sim: Sim, r: number): Army[] | undefined {
  const out: Army[] = [];
  for (const a of sim.allArmies) {
    const slot = (sim.armySlot[a]! + r / sim.slotStep) % sim.sides;
    const b = sim.allArmies.find((x) => sim.armySlot[x] === slot);
    if (b === undefined) return undefined;
    out.push(b);
  }
  return out;
}

const orderKey = (o: Order, r: number, size: number): string => {
  if (o.k === 'move') return `move ${rotX(r, o.x, o.y, size)},${rotY(r, o.x, o.y, size)} ${o.fight} ${o.speed}`;
  if (o.k === 'patrol') return `patrol ${rotX(r, o.ax, o.ay, size)},${rotY(r, o.ax, o.ay, size)} ${rotX(r, o.bx, o.by, size)},${rotY(r, o.bx, o.by, size)}`;
  if (o.k === 'mine_asteroid') return `mine_asteroid ${o.returning} ${o.exhausted ?? false} ${o.site
    ? `${rotX(r, o.site.x, o.site.y, size)},${rotY(r, o.site.x, o.site.y, size)} ${rotVX(r, o.site.vx, o.site.vy)},${rotVY(r, o.site.vx, o.site.vy)} ${o.site.tick}` : ''}`;
  return o.k;
};

function twinMismatch(sim: Sim, a: Ent, b: Ent, r: number): string | undefined {
  const size = sim.size;
  // Positions and velocities live on the same binary grid: no tolerance may mask a one-quantum drift.
  if (a.kind !== b.kind || a.plane !== b.plane || a.hp !== b.hp || rotX(r, a.x, a.y, size) !== b.x || rotY(r, a.x, a.y, size) !== b.y
    || rotVX(r, a.vx, a.vy) !== b.vx || rotVY(r, a.vx, a.vy) !== b.vy) {
    return `${a.plane} (${a.x}, ${a.y}) hp ${a.hp} velocity (${a.vx}, ${a.vy}) → (${rotX(r, a.x, a.y, size)}, ${rotY(r, a.x, a.y, size)}) vs ${b.kind} ${b.plane} (${b.x}, ${b.y}) hp ${b.hp} velocity (${b.vx}, ${b.vy})`;
  }
  // Headings are stored in each owner's canonical frame: twins face the same way. Facing is cosmetic state (presented
  // to 2 decimals) and the turn-limited Depths heading accumulates last-bit float noise between twins (master's C2
  // mirror too), and atan2 may give π for one twin and −π for the other: compare the facing, not the bits.
  const turn = (h: number, k: number): number => Math.abs(Math.atan2(Math.sin(h - k), Math.cos(h - k)));
  if (turn(a.heading, b.heading) > 1e-9 || turn(a.aim, b.aim) > 1e-9) return `heading ${a.heading}/${a.aim} vs ${b.heading}/${b.aim}`;
  if (a.carry !== b.carry || a.lodeCarry !== b.lodeCarry || a.cargoAlloy !== b.cargoAlloy || a.cargoEnergy !== b.cargoEnergy) return 'asymmetric cargo';
  if (!!a.miningTarget !== !!b.miningTarget) return 'asymmetric mining target';
  if (a.miningTarget && b.miningTarget) {
    const target = sim.byId.get(a.miningTarget), twin = sim.byId.get(b.miningTarget);
    if (!target || !twin || rotX(r, target.x, target.y, size) !== twin.x || rotY(r, target.x, target.y, size) !== twin.y) return 'asymmetric mining target position';
  }
  if (a.state !== b.state) return `state ${a.state} vs ${b.state}`;
  if (orderKey(a.order, r, size) !== orderKey(b.order, 0, size)) return `orders ${orderKey(a.order, r, size)} vs ${orderKey(b.order, 0, size)}`;
  return undefined;
}

/**
 * First broken symmetry of `sim` under its layout's rotation group, checked every tick so later combat/economy drift
 * cannot hide the cause. For every rotation r and army a, each entity of a has a twin with the same `seq` in the army
 * a turns into, matching exactly in position and velocity (rotated), heading (canonical), kind, plane, HP, cargo and
 * orders; islands and asteroids match in orbits of the map's sides, forward posts post-for-post across armies;
 * resources, ore mined and queues are equal across
 * each orbit.
 */
export function orbitAsymmetry(sim: Sim): string | undefined {
  const group = rotationGroup(sim);
  const bySeq = sim.allArmies.map(() => new Map<number, Ent>());
  for (const e of sim.ents) if (!e.dead && e.side !== NEUTRAL && e.kind !== 'asteroid' && e.kind !== 'island' && e.kind !== 'post') bySeq[e.side]!.set(e.seq, e);
  for (const r of group) {
    if (r === 0) continue;
    const map = armyRotation(sim, r)!;
    for (const a of sim.allArmies) {
      const b = map[a]!;
      const label = (e: Ent): string => `tick ${sim.tick}: army ${a} ${e.kind}#${e.seq} turned ${r}`;
      for (const e of bySeq[a]!.values()) {
        const twin = bySeq[b]!.get(e.seq);
        if (!twin) return `${label(e)} has no twin in army ${b}`;
        const why = twinMismatch(sim, e, twin, r);
        if (why) return `${label(e)}: ${why}`;
      }
      if (bySeq[a]!.size !== bySeq[b]!.size) return `tick ${sim.tick}: army ${a} has ${bySeq[a]!.size} entities, army ${b} ${bySeq[b]!.size}`;
      const ta = sim.armies[a]!, tb = sim.armies[b]!;
      if (ta.alloy !== tb.alloy || ta.energy !== tb.energy || ta.stats.alloyMined !== tb.stats.alloyMined) return `tick ${sim.tick}: resources of armies ${a} and ${b} differ`;
      const queue = (t: typeof ta): string => JSON.stringify(t.queue.map((e) => [e.id, e.item, e.by, e.status, e.reason, e.started, e.left]));
      if (queue(ta) !== queue(tb)) return `tick ${sim.tick}: build queues of armies ${a} and ${b} differ`;
      if (sim.inPlay(a) !== sim.inPlay(b)) return `tick ${sim.tick}: army ${a} and ${b} differ in elimination`;
    }
  }
  // Neutral orbits: islands and asteroids come in consecutive blocks of `sides` serials, the k-th turned k slot steps.
  const neutral = new Map<number, Ent>();
  for (const e of sim.ents) if (!e.dead && (e.kind === 'island' || e.kind === 'asteroid')) neutral.set(e.seq + (e.kind === 'asteroid' ? 1e6 : 0), e);
  for (const [key, e] of neutral) {
    const k = e.seq % sim.sides;
    if (k === 0) continue;
    const first = neutral.get(key - k);
    const label = `tick ${sim.tick}: ${e.kind}#${e.seq}`;
    if (!first) return `${label} has no orbit leader`;
    const r = k * sim.slotStep;
    if (!group.includes(r)) continue;
    if (rotX(r, first.x, first.y, sim.size) !== e.x || rotY(r, first.x, first.y, sim.size) !== e.y || first.hp !== e.hp || first.capT !== e.capT || first.state !== e.state) {
      return `${label} is not ${first.kind}#${first.seq} turned ${r}: (${e.x}, ${e.y}) vs (${rotX(r, first.x, first.y, sim.size)}, ${rotY(r, first.x, first.y, sim.size)})`;
    }
    if (first.kind === 'asteroid' && (first.rockSize !== e.rockSize || first.resourceType !== e.resourceType || first.volatile !== e.volatile
      || first.resourceRemaining !== e.resourceRemaining || first.maxHp !== e.maxHp || first.fuseUntil !== e.fuseUntil
      || !!first.miningTug !== !!e.miningTug)) return `${label} has asymmetric rock resources or mining latch`;
    const map = armyRotation(sim, r)!;
    const owner = (s: number): number => (s === NEUTRAL ? NEUTRAL : map[s]!);
    if (owner(first.side) !== e.side || owner(first.capSide) !== e.capSide) return `${label} holder ${e.side}/${e.capSide} vs turned ${owner(first.side)}/${owner(first.capSide)}`;
  }
  // Forward posts: army a's home post k turned r is home post k of the army a turns into; a contested point turned r is
  // the contested point at its turned place, held by the turned holder.
  const homes = sim.allArmies.map((a) => sim.posts.filter((_, i) => sim.postHome[i] === a));
  const points = sim.posts.filter((_, i) => sim.postHome[i]! < 0);
  for (const r of group) {
    if (r === 0) continue;
    const map = armyRotation(sim, r)!;
    const owner = (s: number): number => (s === NEUTRAL ? NEUTRAL : map[s]!);
    const twin = (p: Ent, q: Ent | undefined, label: string): string | undefined => {
      if (!q || rotX(r, p.x, p.y, sim.size) !== q.x || rotY(r, p.x, p.y, sim.size) !== q.y) return `${label} is not at its twin's place`;
      if (p.capT !== q.capT || p.state !== q.state || owner(p.side) !== q.side || owner(p.capSide) !== q.capSide) return `${label}: holder/capture ${p.side}/${p.capSide}/${p.capT} vs ${q.side}/${q.capSide}/${q.capT}`;
      return undefined;
    };
    for (const a of sim.allArmies) {
      for (let k = 0; k < homes[a]!.length; k++) {
        const why = twin(homes[a]![k]!, homes[map[a]!]![k], `tick ${sim.tick}: post ${k} of army ${a} turned ${r}`);
        if (why) return why;
      }
      if (sim.armies[a]!.stats.pointTicks !== sim.armies[map[a]!]!.stats.pointTicks) return `tick ${sim.tick}: contested-point ticks of armies ${a} and ${map[a]} differ`;
    }
    for (const p of points) {
      const why = twin(p, points.find((q) => q.x === rotX(r, p.x, p.y, sim.size) && q.y === rotY(r, p.x, p.y, sim.size)), `tick ${sim.tick}: contested point (${p.x}, ${p.y}) turned ${r}`);
      if (why) return why;
    }
  }
  return undefined;
}
