// Balance probe: FFA VULTURE (PlayerThree JS policy ABI, surface seat; four-army free-for-all).
// Forces one strategy: troopers and tanks thrown in waves at whichever hostile army has the lowest known Spire HP,
// re-chosen before every order. Asks: does always finishing the weakest army (kill-stealing) win a free-for-all?

var TPS = 20;
// Fixed registry footprint width of a Spire (all footprints are square; not a match rule). Positions are centres.
var SPIRE_FOOTPRINT = 3;
var WAVE = 8;
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

// Last-known total Spire HP of an army (unseen segments count at full HP), as the focus rule scores it.
function knownHp(a) {
  var hp = 0, known = spireKnown[a.id] || {};
  for (var plane in matchData.rules.spire.hp) hp += known[plane] !== undefined ? known[plane] : matchData.rules.spire.hp[plane];
  return hp;
}

// The live hostile army with the lowest known Spire HP, then the nearest Spire, then clockwise relative order.
function weakest(obs) {
  var best = null, bhp = 0, bd = 0, bo = 0;
  matchData.armies.forEach(function (a) {
    if (!hostile(a.id) || obs.eliminated.indexOf(a.id) >= 0) return;
    var hp = knownHp(a), d = Math.hypot(a.spireAt.x - ARMY.spireAt.x, a.spireAt.y - ARMY.spireAt.y), o = (a.frame - ARMY.frame + 4) % 4;
    if (!best || hp < bhp || (hp === bhp && (d < bd || (d === bd && o < bo)))) { best = a; bhp = hp; bd = d; bo = o; }
  });
  return best;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Every unit at the target's surface Spire: attack it once in reach of any of them, else fight-move there.
function strike(obs, out, units, target) {
  var ids = units.slice(0, 64).map(function (e) { return e.id; });
  var spire = obs.entities.find(function (e) { return e.kind === 'spire' && e.plane === 'surface' && e.side === target.id; });
  if (spire && units.some(function (e) { return dist(e, spire) < 9; })) out.push({ kind: 'attack', units: ids, target: spire.id });
  else {
    // The Spire footprint is not open ground (a move into it is rejected `blocked`): march to its centre-facing corner.
    var edge = SPIRE_FOOTPRINT / 2 + 1, at = fromSpire(target, edge, edge);
    out.push({ kind: 'move', units: ids, x: at.x, y: at.y, mode: 'fight' });
  }
}

function think(obs) {
  if (!matchData || matchData.rulesHash !== obs.rulesHash) throw new Error('missing or mismatched match bootstrap');
  ARMY = armyRow(obs.army);
  var focus = focusArmy(obs);
  var out = [];
  if (!focus) return out;
  var army = obs.entities.filter(function (e) {
    return e.side === obs.army && e.plane === 'surface' && (e.kind === 'trooper' || e.kind === 'tank');
  });
  var queued = obs.queue.filter(function (q) { return q.by === obs.role; }).length;

  if (!rallied) {
    var gather = fromSpire(ARMY, 4.5, 4.5);
    out.push({ kind: 'rally', x: gather.x, y: gather.y });
    rallied = true;
  }
  if (queued < 2) {
    var tanks = army.filter(function (e) { return e.kind === 'tank'; }).length;
    if (tanks * 3 < army.length && obs.res.alloy >= 120 && obs.res.energy >= 60) out.push({ kind: 'queue_add', item: 'tank', count: 1 });
    else if (obs.res.alloy >= 40) out.push({ kind: 'queue_add', item: 'trooper', count: 2 });
  }

  // Waves: the first one leaves at WAVE units (or at 1:30), then everything streams in.
  if (obs.tick < nextOrder || army.length === 0 || (army.length < WAVE && obs.tick < 90 * TPS)) return out;
  nextOrder = obs.tick + 3 * TPS;
  var target = weakest(obs);
  if (target) strike(obs, out, army, target);
  return out;
}
