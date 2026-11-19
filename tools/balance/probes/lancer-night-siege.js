// Balance probe: LANCER NIGHT SIEGE (PlayerThree JS policy ABI, orbit seat).
// Forces one strategy: solar arrays for energy, then Lancers only. While the focus Orbit segment's diagonal stand-off
// is in the night wedge, the Lancers siege the segment from there: beyond its night detection (spire vision ×
// nightSignature), inside their own reach (Lancer range from the footprint corner), with scans to see it. By day they
// wait farther out on the same diagonal. Asks: is a night siege the segment cannot answer a degenerate win?

var TPS = 20;
var SIEGE = 3; // Lancers before the first siege
var ORDER_EVERY = 3 * TPS;
var nextOrder = 0;
var besieging = false;

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

// Fixed registry sizes (not match rules): a Spire's square footprint width and a Lancer's hull radius. Positions are centres.
var SPIRE_FOOTPRINT = 3;
var LANCER_RADIUS = 0.5;

// A point dx, dy tiles from `army`'s Spire in that army's own frame (positive: toward the map centre).
function fromSpire(army, dx, dy) { var c = rotate(4 - army.frame, army.spireAt); return rotate(army.frame, { x: c.x + dx, y: c.y + dy }); }
// The point `r` tiles from `army`'s Spire centre along its diagonal toward the map centre.
function onDiagonal(army, r) { return fromSpire(army, r / Math.SQRT2, r / Math.SQRT2); }

// Daylight at p (matchData.sun: `wedges` lit wedges of half-width `half` around the map centre at obs.sun.angle).
function lit(p, angle) {
  var period = 2 * Math.PI / matchData.sun.wedges;
  var d = Math.atan2(p.y - MAP / 2, p.x - MAP / 2) - angle;
  d -= period * Math.round(d / period);
  return Math.abs(d) < matchData.sun.half;
}

function think(obs) {
  if (!matchData || matchData.rulesHash !== obs.rulesHash) throw new Error('missing or mismatched match bootstrap');
  ARMY = armyRow(obs.army);
  var focus = focusArmy(obs);
  var out = [];
  if (!focus) return out;
  var rules = matchData.rules, lancer = rules.stats.lancer, solar = rules.stats.solar;
  var mine = obs.entities.filter(function (e) { return e.side === obs.army && e.plane === 'orbit'; });
  var solars = mine.filter(function (e) { return e.kind === 'solar'; });
  var lancers = mine.filter(function (e) { return e.kind === 'lancer'; });
  var queued = obs.queue.filter(function (q) { return q.by === obs.role; }).length;

  // Economy: keep two arrays, otherwise always one Lancer in the shared queue. Funding goes strictly in queue order, so
  // a waiting Lancer takes the army's energy before the bot seats' later entries: the forced strategy.
  if (queued === 0) {
    if (solars.length < 2) {
      if (obs.res.alloy >= solar.alloy) out.push({ kind: 'queue_add', item: 'solar' });
    } else out.push({ kind: 'queue_add', item: 'lancer' });
  }

  // Stand-off on the focus segment's diagonal: past its night detection, inside our reach from the footprint corner.
  var detect = rules.spire.vision * rules.orbit.nightSignature;
  var reach = lancer.range + SPIRE_FOOTPRINT / 2 * Math.SQRT2;
  var stand = onDiagonal(focus, (detect + reach) / 2);
  // By day: wait outside the segment's beam (its range plus our hull from the footprint corner) and our own reach.
  var wait = onDiagonal(focus, Math.max(reach, rules.spire.range + LANCER_RADIUS + SPIRE_FOOTPRINT / 2 * Math.SQRT2) + 3);
  var night = !lit(stand, obs.sun.angle);
  if (lancers.length >= SIEGE) besieging = true;
  if (!lancers.length || obs.tick < nextOrder) return out;
  nextOrder = obs.tick + ORDER_EVERY;
  var ids = lancers.map(function (e) { return e.id; });
  if (!besieging) {
    // Until the siege fleet is up, escort the arrays (raiders on them starve the Lancer queue of energy).
    var guard = solars.length ? solars.reduce(function (c, e) { return { x: c.x + e.x / solars.length, y: c.y + e.y / solars.length }; }, { x: 0, y: 0 }) : fromSpire(ARMY, 4, 4);
    out.push({ kind: 'move', units: ids, x: guard.x, y: guard.y, mode: 'fight' });
    return out;
  }
  if (!night) {
    out.push({ kind: 'move', units: ids, x: wait.x, y: wait.y, mode: 'fight' });
    return out;
  }
  var segment = obs.entities.find(function (e) { return e.kind === 'spire' && e.plane === 'orbit' && e.side === focus.id; });
  var orbitAlive = obs.spire.some(function (s) { return s.plane === 'orbit' && s.hp > 0; });
  var near = lancers.some(function (e) { return Math.hypot(e.x - stand.x, e.y - stand.y) < 2; });
  if (segment) out.push({ kind: 'attack', units: ids, target: segment.id });
  else {
    out.push({ kind: 'move', units: ids, x: stand.x, y: stand.y });
    // Dark cells hide the segment from the stand-off too: scan it once the Lancers are in place.
    if (near && orbitAlive && obs.res.scanReadyAt <= obs.tick && obs.res.energy >= rules.orbit.scanCost) out.push({ kind: 'scan', x: focus.spireAt.x, y: focus.spireAt.y });
  }
  return out;
}
