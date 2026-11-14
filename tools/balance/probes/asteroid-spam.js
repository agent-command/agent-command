// Balance probe: ASTEROID SPAM (PlayerThree JS policy ABI, orbit seat).
// Forces one strategy: two solar arrays, then every alloy into tugs; grab every asteroid and drop it on the focus
// Spire the moment it is in range, one by one (no pairing, no scans). Asks: is the one damage skip (Orbit → Surface)
// answerable when it is spammed?

var TPS = 20;
var SOLARS = 2;
var MAX_TUGS = 5;
var DROP_RANGE = 7; // inside rules.orbit.deorbitRange (default 10) with a margin for drift
var claims = {};

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

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function think(obs) {
  if (!matchData || matchData.rulesHash !== obs.rulesHash) throw new Error('missing or mismatched match bootstrap');
  ARMY = armyRow(obs.army);
  var focus = focusArmy(obs);
  var out = [];
  if (!focus) return out;
  var enemy = focus.spireAt;
  var mine = obs.entities.filter(function (e) { return e.side === obs.army && e.plane === 'orbit'; });
  var solars = mine.filter(function (e) { return e.kind === 'solar'; });
  var tugs = mine.filter(function (e) { return e.kind === 'tug'; });
  var queued = obs.queue.filter(function (q) { return q.by === obs.role; }).length;

  if (queued === 0) {
    if (solars.length < SOLARS && obs.res.alloy >= 60) out.push({ kind: 'queue_add', item: 'solar', count: 1 });
    else if (tugs.length < MAX_TUGS && obs.res.alloy >= 100 && obs.res.energy >= 20) out.push({ kind: 'queue_add', item: 'tug', count: 1 });
  }

  var towing = tugs.filter(function (g) { return g.link !== undefined; });
  var inRange = towing.filter(function (g) { return dist(g, enemy) <= DROP_RANGE; });
  if (inRange.length) {
    out.push({ kind: 'deorbit', units: inRange.map(function (g) { return g.id; }), x: enemy.x, y: enemy.y });
    log('drop x' + inRange.length + ' at tick ' + obs.tick);
  }
  var hauling = towing.filter(function (g) { return inRange.indexOf(g) < 0 && g.state !== 'moving'; });
  if (hauling.length) out.push({ kind: 'move', units: hauling.map(function (g) { return g.id; }), x: enemy.x, y: enemy.y });

  var free = obs.entities.filter(function (e) { return e.kind === 'asteroid' && e.state === 'drifting'; });
  tugs.forEach(function (g) {
    if (g.link !== undefined) {
      delete claims[g.id];
      return;
    }
    if (g.state === 'grappling') return;
    var taken = Object.keys(claims).filter(function (k) { return k !== g.id; }).map(function (k) { return claims[k]; });
    var pick = free
      .filter(function (a) { return taken.indexOf(a.id) < 0; })
      .reduce(function (b, a) { return !b || dist(a, g) < dist(b, g) ? a : b; }, null);
    if (pick) {
      claims[g.id] = pick.id;
      out.push({ kind: 'grapple', units: [g.id], asteroid: pick.id });
    } else if (g.state === 'idle') {
      out.push({ kind: 'move', units: [g.id], x: MAP / 2, y: MAP / 2 }); // asteroids are only visible near your orbit units
    }
  });
  return out;
}
