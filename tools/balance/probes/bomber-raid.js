// Balance probe: BOMBER RAID (PlayerThree JS policy ABI, sky seat).
// Forces one strategy: a minimal interceptor screen, then only bombers, sent in packs straight at the focus army's
// surface Spire. Asks: is air-to-surface damage answered by flak and turrets, or does it end matches on its own?

var TPS = 20;
var SCREEN = 3;
var PACK = 4;
var nextOrder = 0;

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

function think(obs) {
  if (!matchData || matchData.rulesHash !== obs.rulesHash) throw new Error('missing or mismatched match bootstrap');
  ARMY = armyRow(obs.army);
  var focus = focusArmy(obs);
  var out = [];
  if (!focus) return out;
  var enemy = focus.spireAt;
  var mine = obs.entities.filter(function (e) { return e.side === obs.army && e.plane === 'sky'; });
  var screen = mine.filter(function (e) { return e.kind === 'interceptor'; });
  var bombers = mine.filter(function (e) { return e.kind === 'bomber'; });
  var islands = obs.entities.filter(function (e) { return e.kind === 'island'; });
  var queued = obs.queue.filter(function (q) { return q.by === obs.role; }).length;

  if (queued === 0) {
    if (screen.length < SCREEN && obs.res.alloy >= 60 && obs.res.energy >= 50) out.push({ kind: 'queue_add', item: 'interceptor', count: 1 });
    else if (obs.res.alloy >= 100 && obs.res.energy >= 100) out.push({ kind: 'queue_add', item: 'bomber', count: 1 });
  }
  if (obs.tick < nextOrder) return out;
  nextOrder = obs.tick + 4 * TPS;

  var unheld = islands.filter(function (i) { return i.side !== obs.army; })[0];
  if (screen.length && unheld) out.push({ kind: 'capture', units: screen.map(function (e) { return e.id; }), island: unheld.id });

  var idle = bombers.filter(function (e) { return e.state === 'idle'; });
  var busy = bombers.length - idle.length;
  if (idle.length >= PACK || (busy > 0 && idle.length)) {
    var spire = obs.entities.find(function (e) { return e.kind === 'spire' && e.plane === 'surface' && e.side === focus.id; });
    var ids = idle.map(function (e) { return e.id; });
    if (spire) out.push({ kind: 'attack', units: ids, target: spire.id });
    else out.push({ kind: 'move', units: ids, x: enemy.x, y: enemy.y, mode: 'fight' });
    log('bomber pack of ' + ids.length + ' at tick ' + obs.tick);
  }
  return out;
}
