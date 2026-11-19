// Balance probe: TURRET TURTLE (PlayerThree JS policy ABI, surface seat).
// Forces one strategy: ring the Spire with turrets (they hit surface and sky), keep a defensive army at home and
// never attack. Asks: does static defence alone outlast a balanced opponent (time-cap wins on Spire HP)?

var TPS = 20;
var MAX_TURRETS = 12;
// Ring cells as offsets from the Spire's centre cell in our canonical frame (Spire in the north-west corner), the
// side facing the map centre first; toWorld rotates them to our corner. Offsets that fall off the map are skipped.
var RING = [[4, 1], [1, 4], [3, 3], [5, -2], [-2, 5], [6, 4], [4, 6], [6, 1], [1, 6], [-3, 3], [3, -3], [-4, -4]];
var nextBuild = 0;
var nextOrder = 0;
var tried = {};

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
  var out = [];
  var home = ARMY.spireAt;
  var centre = toCanon(home);
  var mine = obs.entities.filter(function (e) { return e.side === obs.army && e.plane === 'surface'; });
  var turrets = mine.filter(function (e) { return e.kind === 'turret'; });
  var army = mine.filter(function (e) { return e.kind === 'trooper' || e.kind === 'tank' || e.kind === 'flak'; });
  var queued = obs.queue.filter(function (q) { return q.by === obs.role; }).length;

  if (obs.tick >= nextBuild && turrets.length < MAX_TURRETS && obs.res.alloy >= 80 && obs.res.energy >= 20) {
    for (var i = 0; i < RING.length; i++) {
      var cx = Math.floor(centre.x) + RING[i][0];
      var cy = Math.floor(centre.y) + RING[i][1];
      if (cx < 1 || cy < 1 || cx > MAP - 2 || cy > MAP - 2) continue;
      // A cell's centre rotates to the rotated cell's centre.
      var cell = toWorld({ x: cx + 0.5, y: cy + 0.5 });
      var x = Math.floor(cell.x);
      var y = Math.floor(cell.y);
      var key = x + ',' + y;
      var taken = turrets.some(function (t) { return Math.floor(t.x) === x && Math.floor(t.y) === y; }) ||
        obs.queue.some(function (q) { return q.item === 'turret' && Math.floor(q.x) === x && Math.floor(q.y) === y; });
      if (taken || (tried[key] || 0) > obs.tick) continue;
      out.push({ kind: 'queue_add', item: 'turret', x: x, y: y });
      tried[key] = obs.tick + 30 * TPS; // a blocked cell is retried later, not every call
      nextBuild = obs.tick + 2 * TPS;
      break;
    }
  }

  // A small home guard: flak for the sky, tanks and troopers for the ground. Turrets come first.
  var spare = obs.res.alloy - (turrets.length < MAX_TURRETS ? 80 : 0);
  if (queued === 0 && army.length < 16 && spare >= 90 && obs.res.energy >= 60) {
    var flak = army.filter(function (e) { return e.kind === 'flak'; }).length;
    out.push({ kind: 'queue_add', item: flak * 3 < army.length ? 'flak' : army.length % 2 ? 'tank' : 'trooper', count: 1 });
  }

  if (obs.tick < nextOrder || army.length === 0) return out;
  nextOrder = obs.tick + 2 * TPS;
  var ids = army.slice(0, 64).map(function (e) { return e.id; });
  var threats = obs.entities.filter(function (e) {
    return hostile(e.side) && e.plane === 'surface' && e.kind !== 'spire' && dist(e, home) < 12;
  });
  var post = threats.length ? threats[0] : fromSpire(ARMY, 3, 3);
  out.push({ kind: 'move', units: ids, x: post.x, y: post.y, mode: 'fight' });
  return out;
}
