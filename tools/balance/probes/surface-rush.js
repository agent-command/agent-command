// Balance probe: SURFACE RUSH (PlayerThree JS policy ABI, surface seat).
// Forces one strategy: only troopers (the cheapest unit), produced nonstop, thrown at the focus Spire in waves
// from the first minute. Asks: can a pure early all-in end the match before the other planes matter?

var TPS = 20;
var WAVE = 8;
// Fixed registry footprint width of a Spire (all footprints are square; not a match rule). Positions are centres.
var SPIRE_FOOTPRINT = 3;
var nextOrder = 0;
var rallied = false;

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

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function think(obs) {
  if (!matchData || matchData.rulesHash !== obs.rulesHash) throw new Error('missing or mismatched match bootstrap');
  ARMY = armyRow(obs.army);
  var focus = focusArmy(obs);
  var out = [];
  if (!focus) return out;
  // The Spire footprint is not open ground (a move into it is rejected `blocked`): march to the corner that faces the
  // map centre in the focus army's frame, one tile clear of the footprint.
  var edge = SPIRE_FOOTPRINT / 2 + 1;
  var enemy = fromSpire(focus, edge, edge);
  var gather = fromSpire(ARMY, 4.5, 4.5);
  var army = obs.entities.filter(function (e) {
    return e.side === obs.army && e.plane === 'surface' && (e.kind === 'trooper' || e.kind === 'tank');
  });
  var queued = obs.queue.filter(function (q) { return q.by === obs.role; }).length;

  if (!rallied) {
    out.push({ kind: 'rally', x: gather.x, y: gather.y });
    rallied = true;
  }
  var cost = matchData.rules.stats.trooper.alloy;
  if (queued < 3 && obs.res.alloy >= cost) out.push({ kind: 'queue_add', item: 'trooper', count: Math.min(3, Math.floor(obs.res.alloy / cost)) });

  // Waves: the first one leaves at WAVE units (or at 1:00), then everything streams in.
  if (obs.tick < nextOrder || army.length === 0 || (army.length < WAVE && obs.tick < 60 * TPS)) return out;
  nextOrder = obs.tick + 3 * TPS;
  var ids = army.slice(0, 64).map(function (e) { return e.id; });
  var spire = obs.entities.find(function (e) { return e.kind === 'spire' && e.plane === 'surface' && e.side === focus.id; });
  if (spire && army.some(function (e) { return dist(e, spire) < 9; })) out.push({ kind: 'attack', units: ids, target: spire.id });
  else out.push({ kind: 'move', units: ids, x: enemy.x, y: enemy.y, mode: 'fight' });
  return out;
}
