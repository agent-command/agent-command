// Agent Command's built-in bot library: packages/game/src/bots/posts.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * The Surface bot's forward posts (DESIGN §4.2 Outposts): small trooper detachments take and retake our home posts
 * (veteran: also the nearest enemy-held post once the army has left home), a squad races for the nearest contested
 * point (veteran: the centre too, dug in), and damaged units out of danger fall back to heal at the nearest post we
 * hold. Posts are public entities and matchData.posts tells home posts from contested points, so nothing here reads
 * beyond the observation.
 */
import { footprintDistance, isStatKind } from '../rules/stats.js';
import { cellCentreX, cellCentreY } from '../util/grid.js';
import { dist } from '../util/math.js';
import { cellDist, centroid, ids, } from './context.js';
import { AT_POINT, CONTEST_RADIUS, OUTMATCHED, POINT_SEAT_REACH, POST_HEAL_SHARE, POST_REACH, POST_SAFE_RADIUS, TIE_SITE, tieWins, } from './tuning.js';

/** Is `e` within `r` of `p`, or already headed there? */
const headed = (e, p, r) => dist(e, p) <= r || (e.tx !== undefined && e.ty !== undefined && dist({ x: e.tx, y: e.ty }, p) <= r);



/** pointSide's walk workspace, shared by every call in this realm (calls never nest): visit stamps and the BFS queue. */
let sideSeen = new Int32Array(0);
let sideQueue = new Int32Array(0);
let sideStamp = 0;
/** Largest visit stamp (Int32Array): the workspace restarts before it. */
const STAMP_MAX = 0x7fffffff;

/** cellDist from cell `k` to `p`, Infinity beyond POINT_SEAT_REACH's box (one tile of margin) without a hypot. */
function seatDist(k, size, p) {
  const x = k % size;
  if (Math.abs(x + 0.5 - p.x) > POINT_SEAT_REACH + 1 || Math.abs((k - x) / size + 0.5 - p.y) > POINT_SEAT_REACH + 1) return Infinity;
  return cellDist(k, size, p);
}

/**
 * The cells round point `p` a member walking from `from` holds it from (public terrain): the walkable cells within
 * POINT_SEAT_REACH tiles of `p` joined to the first of them its walk reaches (nearest `p`, then in frame order, among
 * those an equally short walk reaches). A walk, not a straight line: across a canyon the nearer rim is not the side
 * the member comes out on. Undefined when it cannot walk there.
 */
function pointSide(c, from, p) {
  const size = c.size, cells = size * size;
  const walk = c.walkMask();
  const start = c.frame.pointCell(from.x, from.y);
  if (!walk[start]) return undefined;
  if (sideSeen.length !== cells || sideStamp === STAMP_MAX) {
    sideSeen = new Int32Array(cells);
    sideQueue = new Int32Array(cells);
    sideStamp = 0;
  }
  const seen = sideSeen, queue = sideQueue, mark = ++sideStamp;
  seen[start] = mark;
  queue[0] = start;
  // Breadth-first, a layer (one more step) at a time, until a layer holds a cell near `p`.
  let head = 0, tail = 1, entry = -1, entryDist = Infinity;
  while (head < tail && entry < 0) {
    const end = tail;
    for (let i = head; i < end; i++) {
      const k = queue[i];
      const d = seatDist(k, size, p);
      if (d > POINT_SEAT_REACH) continue;
      if (entry < 0 || d < entryDist || (d === entryDist && c.frame.cellKey(k) < c.frame.cellKey(entry))) {
        entry = k;
        entryDist = d;
      }
    }
    if (entry >= 0) break;
    for (let i = head; i < end; i++) {
      const k = queue[i], x = k % size;
      // The four cells sharing an edge (cliff corners meeting diagonally close a pinch).
      for (let edge = 0; edge < 4; edge++) {
        const n = edge === 0 ? (x > 0 ? k - 1 : -1) : edge === 1 ? (x < size - 1 ? k + 1 : -1) : edge === 2 ? k - size : k + size;
        if (n < 0 || n >= cells || seen[n] === mark || !walk[n]) continue;
        seen[n] = mark;
        queue[tail++] = n;
      }
    }
    head = end;
  }
  if (entry < 0) return undefined;
  const out = new Set([entry]);
  queue[0] = entry;
  tail = 1;
  for (let i = 0; i < tail; i++) {
    const k = queue[i], x = k % size;
    for (let edge = 0; edge < 4; edge++) {
      const n = edge === 0 ? (x > 0 ? k - 1 : -1) : edge === 1 ? (x < size - 1 ? k + 1 : -1) : edge === 2 ? k - size : k + size;
      if (n < 0 || n >= cells || out.has(n) || !walk[n] || seatDist(n, size, p) > POINT_SEAT_REACH) continue;
      out.add(n);
      queue[tail++] = n;
    }
  }
  return out;
}

/**
 * Squad member `e`'s seat for point `p` on the side it walks to (`pointSide`): the free cell nearest `p` inside the
 * capture radius `reach` (none it `tried`), else the free cell nearest `p` beside it. Free: not in `taken` (seats handed
 * out this decision), no visible Surface unit or structure on it and no own unit headed for it.
 */
function seatFor(c, e, p, reach, taken, tried) {
  const cells = pointSide(c, e, p);
  if (!cells) return undefined;
  const size = c.size;
  const bodies = [...c.own, ...c.foes].filter((o) => o.id !== e.id && o.plane === 'surface' && o.kind !== 'post');
  const free = (n) => {
    if (!cells.has(n) || taken.has(n)) return false;
    const x = cellCentreX(n, size);
    const y = cellCentreY(n, size);
    return !bodies.some((o) => (isStatKind(o.kind) && c.stats[o.kind].footprint !== undefined ? footprintDistance(o.kind, o.x, o.y, x, y) === 0 : c.frame.pointCell(o.x, o.y) === n)
      || (o.side === c.army && o.tx !== undefined && o.ty !== undefined && c.frame.pointCell(o.tx, o.ty) === n));
  };
  const on = c.spot(p.x, p.y, reach, (n) => !tried.has(n) && free(n));
  const at = on ?? c.spot(p.x, p.y, POINT_SEAT_REACH, free);
  return at ? { cell: c.frame.pointCell(at.x, at.y), at, on: on !== null } : undefined;
}

/** Hand `seat` to squad member `m` (its next destination). */
function sit(m, seat, taken) {
  taken.add(seat.cell);
  if (seat.on) m.tried.add(seat.cell);
  m.rest = undefined;
  return seat.at;
}

/**
 * Where squad member `e` goes this decision: nowhere while it stands on `p` or is under way, nor while it fights; onto
 * a free seat on the point when one opens on its side; otherwise back to a seat (`'point'`: the plain point order
 * when its side has none) only once something pulled it off the spot its last order left it on. A member resting there
 * stays: sending it again would not bring it nearer. (Sent again every decision, a member cliffs kept off the point
 * never settled and gave up every fight it started: it paced back and forth across the canyon from the other army's.)
 */
function recall(c, e, m, p, reach, taken) {
  if (dist(e, p) <= reach) {
    m.tried.clear();
    return undefined;
  }
  if (e.tx !== undefined && e.ty !== undefined) return undefined;
  if (e.state === 'attacking') {
    m.rest = null;
    return undefined;
  }
  const seat = seatFor(c, e, p, reach, taken, m.tried);
  if (seat?.on) return sit(m, seat, taken);
  if (m.rest === undefined) {
    m.rest = { x: e.x, y: e.y };
    return undefined;
  }
  if (m.rest !== null && dist(e, m.rest) <= AT_POINT) return undefined;
  return seat ? sit(m, seat, taken) : 'point';
}

/** A live post destination or an unfinished capture is already a job, not a fresh patrol recruit. */
export function postCommitted(c, e) {
  return c.posts.some((p) =>
    (e.tx !== undefined && e.ty !== undefined && dist({ x: e.tx, y: e.ty }, p) <= c.econ.postCaptureRadius) ||
    ((p.side === 'neutral' || c.hostile(p.side)) && dist(e, p) <= c.econ.postCaptureRadius));
}

/**
 * Contested point squads for this decision (Tier pointSquad, from pointAt): a squad of pointSquad troopers takes and
 * holds the contested point nearest our Spire and retakes it when lost; `pointCentre` sends a second squad to the
 * centre point when that is not the nearest, and `pointDigIn` digs squad members in on a point we hold. `squads` is the
 * bot's memory (unit id → its point and resting spot): members stay with their point and leave `army` until they die,
 * another task takes them or `release` (the sudden death push, or an army outmatched on its own side) disbands every
 * squad. A squad is (re)filled only whole and is pulled back while the hostile fighters at its point outvalue it.
 * Members walk to seats on their side of the point (`seatFor`; the plain point order only when their side has none),
 * take a seat on the point when one opens, and are sent again only once something pulled them off their spot
 * (`recall`). Frame order, so rotated bots pick rotated points.
 */
export function pointOrders(c, t, army, out, squads, release, reserved) {
  if (t.pointSquad <= 0 || c.obs.tick < t.pointAt || release) {
    squads.clear();
    return;
  }
  const kinds = new Map(c.match.posts.map((p) => [p.id, p]));
  const points = c.frame.order(c.posts.filter((p) => kinds.get(p.id)?.kind === 'contested'));
  if (!points.length) return;
  // A stable sort keeps the frame order on equal distances (both C2 flank points are as far from a Spire); a
  // personality's tie order (tieOrder) may take a later one of the equally near points instead.
  const nearest = points.toSorted((a, b) => dist(a, c.home) - dist(b, c.home));
  const near = dist(nearest[0], c.home);
  let first = nearest[0];
  for (let i = 1; i < nearest.length && dist(nearest[i], c.home) === near; i++) if (tieWins(t.tieOrder, TIE_SITE.point, i)) first = nearest[i];
  const targets = [first];
  const centre = points.find((p) => kinds.get(p.id).x === c.size / 2 && kinds.get(p.id).y === c.size / 2);
  if (t.pointCentre && centre && centre !== targets[0]) targets.push(centre);
  const present = new Set(army.map((e) => e.id));
  for (const [id, m] of squads) if (!present.has(id) || !targets.some((p) => p.id === m.point)) squads.delete(id);
  const reach = c.econ.postCaptureRadius;
  const dig = [];
  const worth = (es) => es.reduce((a, e) => a + c.statsOf(e).alloy + c.statsOf(e).energy, 0);
  const fighters = c.foes.filter((e) => e.plane === 'surface' && (e.kind === 'trooper' || e.kind === 'tank' || e.kind === 'flak' || e.kind === 'breacher'));
  for (const p of targets) {
    const members = c.frame.order(army.filter((e) => squads.get(e.id)?.point === p.id));
    // A point is not worth a squad's life: hostile fighters at it worth more than the whole squad (OUTMATCHED) send its
    // members back toward the Spire (a plain move: they do not stop to trade shots on the way) to rejoin the army, and
    // keep fresh troopers off it until they are gone.
    const squadWorth = worth(members) + Math.max(0, t.pointSquad - members.length) * (c.stats.trooper.alloy + c.stats.trooper.energy);
    if (worth(fighters.filter((e) => dist(e, p) < CONTEST_RADIUS)) > OUTMATCHED * squadWorth) {
      for (const e of members) squads.delete(e.id);
      if (members.length) out.push({ kind: 'move', units: ids(members), x: c.home.x, y: c.home.y });
      continue;
    }
    const go = [];
    const taken = new Set();
    for (const e of members) {
      const order = recall(c, e, squads.get(e.id), p, reach, taken);
      if (order === 'point') go.push(e);
      else if (order) out.push({ kind: 'move', units: [e.id], x: order.x, y: order.y, mode: 'fight' });
    }
    // Fresh troopers join only enough at once to make the squad whole: one at a time, each walked into the fight that
    // killed the last and died there, and the army never grew past the point's toll.
    const want = Math.max(0, t.pointSquad - members.length);
    let fresh = c.frame.order(army.filter((e) => e.kind === 'trooper' && !squads.has(e.id) && !reserved.has(e.id)))
      .sort((a, b) => dist(a, p) - dist(b, p))
      .slice(0, want);
    if (fresh.length < want) fresh = [];
    for (const e of fresh) {
      const m = { point: p.id, tried: new Set() };
      squads.set(e.id, m);
      if (headed(e, p, reach)) continue;
      const seat = seatFor(c, e, p, reach, taken, m.tried);
      if (!seat) go.push(e);
      else {
        const at = sit(m, seat, taken);
        out.push({ kind: 'move', units: [e.id], x: at.x, y: at.y, mode: 'fight' });
      }
    }
    members.push(...fresh);
    for (const e of go) squads.get(e.id).rest = undefined;
    if (go.length) out.push({ kind: 'attack', units: ids(go), target: p.id });
    const held = p.side !== 'neutral' && !c.hostile(p.side);
    if (t.pointDigIn && c.econ.digInEnabled && held) for (const e of members) if (e.state === 'idle' && dist(e, p) <= reach) dig.push(e.id);
  }
  army.splice(0, army.length, ...army.filter((e) => !squads.has(e.id)));
  if (dig.length) out.push({ kind: 'deploy', units: dig, on: true });
}

/**
 * Post orders for this decision. Detached and healing units leave `army` (so army orders leave them alone); a unit
 * already standing at its post or headed there gets no new order.
 */
export function postOrders(c, t, leftHome, army, out, reserved) {
  if (c.posts.length === 0) return;
  const ours = (p) => p.side !== 'neutral' && !c.hostile(p.side);
  // Frame order, so rotated bots in rotated situations pick rotated posts and units.
  const posts = c.frame.order(c.posts);
  const reach = c.econ.postCaptureRadius;
  const take = (p, squad) => {
    const go = squad.filter((e) => !headed(e, p, reach));
    if (go.length) out.push({ kind: 'attack', units: ids(go), target: p.id });
    army.splice(0, army.length, ...army.filter((e) => !squad.includes(e)));
  };
  if (t.postGuards > 0) {
    const home = new Set(c.match.posts.filter((p) => p.home === c.army).map((p) => p.id));
    const targets = posts.filter((p) => home.has(p.id) && !ours(p));
    if (t.contestPosts && leftHome && army.length) {
      const at = centroid(army);
      const foe = posts.filter((p) => p.side !== 'neutral' && c.hostile(p.side)).sort((a, b) => dist(a, at) - dist(b, at))[0];
      if (foe && !targets.includes(foe)) targets.push(foe);
    }
    for (const p of targets) {
      const squad = c.frame.order(army.filter((e) => e.kind === 'trooper' && dist(e, p) <= POST_REACH && (home.has(p.id) || !reserved.has(e.id))))
        .sort((a, b) => dist(a, p) - dist(b, p))
        .slice(0, t.postGuards);
      if (squad.length) take(p, squad);
    }
  }
  const havens = posts.filter(ours);
  if (!havens.length) return;
  const healing = new Map();
  for (const e of c.frame.order(army)) {
    if (e.hp >= e.maxHp * POST_HEAL_SHARE || c.foes.some((f) => f.plane === 'surface' && dist(f, e) < POST_SAFE_RADIUS)) continue;
    const p = havens.reduce((a, b) => (dist(b, e) < dist(a, e) ? b : a));
    if (!healing.has(p)) healing.set(p, []);
    healing.get(p).push(e);
  }
  for (const [p, group] of healing) {
    const go = group.filter((e) => !headed(e, p, c.econ.postHealRadius));
    if (go.length) out.push({ kind: 'attack', units: ids(go), target: p.id });
    army.splice(0, army.length, ...army.filter((e) => !group.includes(e)));
  }
}
