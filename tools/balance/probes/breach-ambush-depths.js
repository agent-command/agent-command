// Balance probe: BREACH AMBUSH, depths half (PlayerThree JS policy ABI, depths seat; pairs with breach-ambush-surface.js).
// Forces one strategy: tunnel to a staging cell just outside the focus Spire's reach, gather the troopers the surface
// seat sends down, and break out behind their lines. Asks: is a telegraphed breach (tremors) an unanswerable flank?

var TPS = 20;
var MINERS = 8;
var TUNNELERS = 2;
var SQUAD = 6;
var tunnelers = [];
var nextBreach = 0;

// --- frames and the focus rule, as the built-in bots play them (skill policies/game/bots/context.js) ---
var matchData = null, MAP = 0;
var ARMY = null, FOCUS = null, spireKnown = {};
function armyRow(id) { for (var i = 0; i < matchData.armies.length; i++) if (matchData.armies[i].id === id) return matchData.armies[i]; return null; }
// p rotated k quarter turns about the map centre: one turn (x, y) → (MAP − y, x).
function rotate(k, p) { k = ((k % 4) + 4) % 4; return k === 0 ? { x: p.x, y: p.y } : k === 1 ? { x: MAP - p.y, y: p.x } : k === 2 ? { x: MAP - p.x, y: MAP - p.y } : { x: p.y, y: MAP - p.x }; }
function toWorld(p) { return rotate(ARMY.frame, p); }   // canonical NW plan → our corner
function toCanon(p) { return rotate(4 - ARMY.frame, p); } // world → canonical
function hostile(side) { var a = side === 'neutral' ? null : armyRow(side); return !!a && a.colour !== ARMY.colour; }
// Focus: live hostile army with the nearest Spire, then lowest last-known Spire HP, then clockwise relative order; kept until eliminated.
function focusArmy(obs) {
  obs.entities.forEach(function (e) { if (e.kind === 'spire' && hostile(e.side)) (spireKnown[e.side] = spireKnown[e.side] || {})[e.plane] = e.hp; });
  if (FOCUS && obs.eliminated.indexOf(FOCUS.id) < 0) return FOCUS;
  var best = null, bd = 0, bhp = 0, bo = 0;
  matchData.armies.forEach(function (a) {
    if (!hostile(a.id) || obs.eliminated.indexOf(a.id) >= 0) return;
    var d = Math.hypot(a.spireAt.x - ARMY.spireAt.x, a.spireAt.y - ARMY.spireAt.y), hp = 0, known = spireKnown[a.id] || {};
    for (var plane in matchData.rules.spire.hp) hp += known[plane] !== undefined ? known[plane] : matchData.rules.spire.hp[plane];
    var o = (a.frame - ARMY.frame + 4) % 4;
    if (!best || d < bd || (d === bd && (hp < bhp || (hp === bhp && o < bo)))) { best = a; bd = d; bhp = hp; bo = o; }
  });
  return (FOCUS = best);
}
// --- end shared ---

function init(data) { matchData = data; MAP = data.rules.map.size; }

// A point dx, dy tiles from `army`'s Spire in that army's own frame (positive: toward the map centre).
function fromSpire(army, dx, dy) { var c = rotate(4 - army.frame, army.spireAt); return rotate(army.frame, { x: c.x + dx, y: c.y + dy }); }

function own(obs, kind) {
  return obs.entities.filter(function (e) { return e.side === obs.army && e.kind === kind && e.plane === 'depths'; });
}

// Breadth-first search over KNOWN walkable cells (tunnel 4, rail 6) from our Spire root.
function connected(grid, root, goal) {
  var start = Math.floor(root.y) * MAP + Math.floor(root.x);
  var target = goal.y * MAP + goal.x;
  var seen = new Uint8Array(MAP * MAP);
  var queue = [start];
  seen[start] = 1;
  for (var i = 0; i < queue.length; i++) {
    var c = queue[i];
    if (c === target) return true;
    var x = c % MAP;
    var next = [x < MAP - 1 ? c + 1 : -1, x > 0 ? c - 1 : -1, c + MAP, c - MAP];
    for (var k = 0; k < 4; k++) {
      var n = next[k];
      if (n < 0 || n >= MAP * MAP || seen[n] || (grid[n] !== 4 && grid[n] !== 6)) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return false;
}

function think(obs) {
  if (!matchData || matchData.rulesHash !== obs.rulesHash) throw new Error('missing or mismatched match bootstrap');
  ARMY = armyRow(obs.army);
  var focus = focusArmy(obs);
  var out = [];
  if (!focus) return out;
  var root = ARMY.spireAt;
  // ~8.5 tiles from the focus Spire toward the map centre: outside its beam, close enough to reach it before the
  // defence turns around.
  var at = fromSpire(focus, 5, 5);
  var stage = { x: Math.floor(at.x), y: Math.floor(at.y) };
  var diggers = own(obs, 'digger');
  var troopers = own(obs, 'trooper');
  var linked = connected(obs.depths || [], root, stage);
  var queued = obs.queue.filter(function (q) { return q.by === obs.role; }).length;

  if (queued === 0 && diggers.length < MINERS + TUNNELERS && obs.res.alloy >= 50) out.push({ kind: 'queue_add', item: 'digger', count: 1 });

  tunnelers = tunnelers.filter(function (id) { return diggers.some(function (d) { return d.id === id; }); });
  if (!linked) {
    diggers.forEach(function (d) {
      if (tunnelers.length < TUNNELERS && tunnelers.indexOf(d.id) < 0 && d.carry === undefined) tunnelers.push(d.id);
    });
    var lagging = diggers.filter(function (d) {
      return tunnelers.indexOf(d.id) >= 0 && (d.tx !== stage.x + 0.5 || d.ty !== stage.y + 0.5);
    });
    if (lagging.length) out.push({ kind: 'dig', units: lagging.map(function (d) { return d.id; }), x: stage.x, y: stage.y });
  } else if (tunnelers.length) {
    log('staging tunnel ready at tick ' + obs.tick);
    tunnelers = [];
  }
  var idle = diggers.filter(function (d) { return d.state === 'idle' && tunnelers.indexOf(d.id) < 0; });
  if (idle.length) out.push({ kind: 'mine', units: idle.map(function (d) { return d.id; }) });

  // Troopers arriving from the surface wait at home until the tunnel is through and a full squad is down.
  var ready = troopers.filter(function (t) { return t.state !== 'breaching'; });
  if (linked && ready.length >= SQUAD && obs.tick >= nextBreach) {
    out.push({ kind: 'breach', units: ready.slice(0, 64).map(function (t) { return t.id; }), x: stage.x, y: stage.y });
    nextBreach = obs.tick + 30 * TPS;
    log('breach with ' + ready.length + ' troopers at tick ' + obs.tick);
  }
  return out;
}
