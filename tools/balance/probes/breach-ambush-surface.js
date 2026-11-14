// Balance probe: BREACH AMBUSH, surface half (PlayerThree JS policy ABI, surface seat; pairs with breach-ambush-depths.js).
// Holds the home front with a trooper/tank army, sends trooper squads down to the depths seat from 2:00, and throws
// every trooper that surfaced near the focus army (a breach) straight at its Spire.

var TPS = 20;
// Fixed registry footprint width of a Spire (all footprints are square; not a match rule). Positions are centres.
var SPIRE_FOOTPRINT = 3;
var SQUAD = 6;
var DOWN_FROM = 120 * TPS;
var nextDown = 0;
var nextOrder = 0;
var down = {}; // ids sent to the depths: never re-ordered on the surface while they walk to the portal

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
  var home = ARMY.spireAt;
  var enemy = focus.spireAt;
  var front = fromSpire(ARMY, 5.5, 5.5);
  var army = obs.entities.filter(function (e) {
    return e.side === obs.army && e.plane === 'surface' && (e.kind === 'trooper' || e.kind === 'tank');
  });
  var queued = obs.queue.filter(function (q) { return q.by === obs.role; }).length;

  if (queued < 2) {
    var tanks = army.filter(function (e) { return e.kind === 'tank'; }).length;
    if (tanks * 3 < army.length && obs.res.alloy >= 120 && obs.res.energy >= 60) out.push({ kind: 'queue_add', item: 'tank', count: 1 });
    else if (obs.res.alloy >= 40) out.push({ kind: 'queue_add', item: 'trooper', count: 2 });
  }

  // Squads go down at our Spire for the depths seat to lead.
  var atHome = army.filter(function (e) { return e.kind === 'trooper' && !down[e.id] && dist(e, home) < 8; });
  if (obs.tick >= DOWN_FROM && obs.tick >= nextDown && atHome.length >= SQUAD) {
    var squad = atHome.slice(0, SQUAD).map(function (e) { return e.id; });
    squad.forEach(function (id) { down[id] = true; });
    out.push({ kind: 'transfer', units: squad, to: 'depths' });
    nextDown = obs.tick + 40 * TPS;
    log('squad of ' + SQUAD + ' sent down at tick ' + obs.tick);
  }

  if (obs.tick < nextOrder || army.length === 0) return out;
  nextOrder = obs.tick + 3 * TPS;
  var raiders = army.filter(function (e) { return dist(e, enemy) < 16; });
  var guard = army.filter(function (e) { return raiders.indexOf(e) < 0 && !down[e.id]; });
  var spire = obs.entities.find(function (e) { return e.kind === 'spire' && e.plane === 'surface' && e.side === focus.id; });
  if (raiders.length) {
    var ids = raiders.slice(0, 64).map(function (e) { return e.id; });
    if (spire) out.push({ kind: 'attack', units: ids, target: spire.id });
    else {
      // The Spire footprint is not open ground (a move into it is rejected `blocked`): march to its centre-facing corner.
      var edge = SPIRE_FOOTPRINT / 2 + 1, at = fromSpire(focus, edge, edge);
      out.push({ kind: 'move', units: ids, x: at.x, y: at.y, mode: 'fight' });
    }
  }
  if (guard.length) {
    var threats = obs.entities.filter(function (e) {
      return hostile(e.side) && e.plane === 'surface' && e.kind !== 'spire' && dist(e, home) < 14;
    });
    var at = threats.length ? threats[0] : front;
    out.push({ kind: 'move', units: guard.slice(0, 64).map(function (e) { return e.id; }), x: at.x, y: at.y, mode: 'fight' });
  }
  return out;
}
