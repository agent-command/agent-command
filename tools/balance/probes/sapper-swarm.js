// Balance probe: SAPPER SWARM (PlayerThree JS policy ABI, depths seat).
// Forces one strategy: tunnel into collapse reach of the focus Spire from the first second and collapse the ground
// beside it with sapper waves, keeping only a minimal mining economy. Asks: are collapses (public, defusable) a degenerate win?

var TPS = 20;
var MINERS = 6;
var TUNNELERS = 3;
var MAX_SAPPERS = 6;
var WAVE = 2;
var tunnelers = [];
var waveAt = 0;

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

// Fixed registry footprint width of a Spire (all footprints are square; not a match rule). Positions are centres.
var SPIRE_FOOTPRINT = 3;
var BEDROCK = 1, TUNNEL = 4, RAIL = 6;
function open(code) { return code === TUNNEL || code === RAIL; }
// Cell c rotated k quarter turns: cell (x, y) → (MAP − 1 − y, x) per turn.
function rotateCell(k, c) {
  k = ((k % 4) + 4) % 4;
  var x = c % MAP, y = (c - x) / MAP;
  return k === 0 ? c : k === 1 ? x * MAP + MAP - 1 - y : k === 2 ? MAP * MAP - 1 - c : (MAP - 1 - x) * MAP + y;
}
// Our tie-break order of world cell c (its row-major index in our frame), so rotated armies break ties alike.
function cellKey(c) { return rotateCell(4 - ARMY.frame, c); }
function cellOf(e) { return Math.floor(e.y) * MAP + Math.floor(e.x); }
function neighbours(c) {
  var x = c % MAP;
  return [x < MAP - 1 ? c + 1 : -1, x > 0 ? c - 1 : -1, c + MAP < MAP * MAP ? c + MAP : -1, c - MAP];
}

function own(obs, kind) {
  return obs.entities.filter(function (e) { return e.side === obs.army && e.kind === kind && e.plane === 'depths'; });
}

// Cells whose centre lies outside the focus Spire footprint but within collapseRadius + collapseStructureReach of its
// edge: a charge there damages the Surface segment (the sim measures that reach from the footprint edge).
function chargeZone(focus) {
  var rules = matchData.rules.depths, reach = rules.collapseRadius + rules.collapseStructureReach, half = SPIRE_FOOTPRINT / 2;
  var s = focus.spireAt, zone = {}, span = Math.ceil(half + reach);
  for (var y = Math.floor(s.y) - span; y <= Math.floor(s.y) + span; y++) {
    for (var x = Math.floor(s.x) - span; x <= Math.floor(s.x) + span; x++) {
      if (x < 1 || y < 1 || x >= MAP - 1 || y >= MAP - 1) continue;
      var dx = Math.max(0, Math.abs(x + 0.5 - s.x) - half), dy = Math.max(0, Math.abs(y + 0.5 - s.y) - half);
      if (dx === 0 && dy === 0) continue; // under the footprint: the root, never a tunnel
      if (Math.hypot(dx, dy) <= reach) zone[y * MAP + x] = true;
    }
  }
  return zone;
}

// Breadth-first search over KNOWN walkable cells from `sources`; returns walking distance per cell (-1: unreached).
function walk(grid, sources) {
  var d = new Int32Array(MAP * MAP).fill(-1), queue = [];
  sources.forEach(function (c) { if (open(grid[c]) && d[c] < 0) { d[c] = 0; queue.push(c); } });
  for (var i = 0; i < queue.length; i++) {
    var c = queue[i], next = neighbours(c);
    for (var k = 0; k < 4; k++) {
      var n = next[k];
      if (n < 0 || d[n] >= 0 || !open(grid[n])) continue;
      d[n] = d[c] + 1;
      queue.push(n);
    }
  }
  return d;
}

// The nearest (walking) known open cell of the zone reachable from our depths units; ties by our canonical cell order.
function chargeCell(grid, zone, from) {
  var d = walk(grid, from), best = -1;
  Object.keys(zone).forEach(function (k) {
    var c = Number(k);
    if (d[c] < 0) return;
    if (best < 0 || d[c] < d[best] || (d[c] === d[best] && cellKey(c) < cellKey(best))) best = c;
  });
  return best;
}

// Where tunnelers dig while no zone cell is linked: the zone cell nearest our Spire that the team does not know as
// bedrock and has not seen rejected; ties by our canonical cell order.
function digCell(grid, zone, root) {
  var best = -1, bd = 0;
  Object.keys(zone).forEach(function (k) {
    var c = Number(k);
    if (grid[c] === BEDROCK || unreachable[c]) return;
    var d = Math.hypot((c % MAP) + 0.5 - root.x, Math.floor(c / MAP) + 0.5 - root.y);
    if (best < 0 || d < bd || (d === bd && cellKey(c) < cellKey(best))) { best = c; bd = d; }
  });
  return best;
}

var unreachable = {}; // dig cells whose order did not take (the intent was rejected): never retried
var digAt = -1, digIssued = -1;

function think(obs) {
  if (!matchData || matchData.rulesHash !== obs.rulesHash) throw new Error('missing or mismatched match bootstrap');
  ARMY = armyRow(obs.army);
  var focus = focusArmy(obs);
  var out = [];
  if (!focus) return out;
  var grid = obs.depths || [];
  var diggers = own(obs, 'digger');
  var sappers = own(obs, 'sapper');
  var zone = chargeZone(focus);
  var target = chargeCell(grid, zone, diggers.concat(sappers).map(cellOf));
  var queued = obs.queue.filter(function (q) { return q.by === obs.role; }).length;
  var digger = matchData.rules.stats.digger, sapper = matchData.rules.stats.sapper;

  if (queued === 0) {
    if (diggers.length < MINERS + TUNNELERS && obs.res.alloy >= digger.alloy && obs.res.energy >= digger.energy) out.push({ kind: 'queue_add', item: 'digger', count: 1 });
    else if (sappers.length < MAX_SAPPERS && obs.res.alloy >= sapper.alloy && obs.res.energy >= sapper.energy) out.push({ kind: 'queue_add', item: 'sapper', count: 1 });
  }

  tunnelers = tunnelers.filter(function (id) { return diggers.some(function (d) { return d.id === id; }); });
  if (target < 0) {
    diggers.forEach(function (d) {
      if (tunnelers.length < TUNNELERS && tunnelers.indexOf(d.id) < 0 && d.carry === undefined) tunnelers.push(d.id);
    });
    var crew = diggers.filter(function (d) { return tunnelers.indexOf(d.id) >= 0; });
    // A dig issued last decision that no tunneler took was rejected (no known route): drop that cell.
    if (digIssued >= 0 && !crew.some(function (d) { return d.tx === (digIssued % MAP) + 0.5 && d.ty === Math.floor(digIssued / MAP) + 0.5; })) unreachable[digIssued] = true;
    digIssued = -1;
    digAt = digCell(grid, zone, ARMY.spireAt);
    var lagging = crew.filter(function (d) { return d.tx !== (digAt % MAP) + 0.5 || d.ty !== Math.floor(digAt / MAP) + 0.5; });
    if (digAt >= 0 && lagging.length) {
      out.push({ kind: 'dig', units: lagging.map(function (d) { return d.id; }), x: digAt % MAP, y: Math.floor(digAt / MAP) });
      digIssued = digAt;
    }
  } else if (tunnelers.length) {
    log('tunnel to the focus Spire at tick ' + obs.tick);
    tunnelers = [];
    digIssued = -1;
  }

  var idle = diggers.filter(function (d) { return d.state === 'idle' && tunnelers.indexOf(d.id) < 0; });
  if (idle.length) out.push({ kind: 'mine', units: idle.map(function (d) { return d.id; }) });

  if (target >= 0 && obs.tick >= waveAt) {
    // Only sappers walking-connected to the charge cell (undermine rejects the whole wave on one cut-off sapper).
    var linked = walk(grid, [target]);
    var ready = sappers.filter(function (s) { return s.state === 'idle' && linked[cellOf(s)] >= 0; });
    if (ready.length >= WAVE) {
      out.push({ kind: 'undermine', units: ready.map(function (s) { return s.id; }), x: target % MAP, y: Math.floor(target / MAP) });
      waveAt = obs.tick + 12 * TPS;
      log('sapper wave of ' + ready.length);
    }
  }
  return out;
}
