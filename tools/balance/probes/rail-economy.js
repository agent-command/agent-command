// Balance probe: RAIL ECONOMY (PlayerThree JS policy ABI, depths seat). Found by an exploit hunt
// (docs/balance/hunt-phase-a.md, depths v2) and kept as a regression probe.
// Forces one strategy: 20 diggers on auto-mine, and from 1:00 idle diggers rail the cavern to the centre. No combat
// units, no sappers. Asks: does a pure rail-hauling economy snowball past every answer?

var TPS = 20;
var DIGGERS = 20;
var RAIL_FROM = 60 * TPS;

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
  var out = [{ kind: 'macro', action: 'auto_mine' }];
  var diggers = obs.entities.filter(function (e) { return e.side === obs.army && e.plane === 'depths' && e.kind === 'digger'; });
  // The centre cell on our side of the map centre: the canonical cell just north-west of it, in our frame.
  var at = toWorld({ x: MAP / 2 - 0.5, y: MAP / 2 - 0.5 });
  var centre = { x: Math.floor(at.x), y: Math.floor(at.y) };
  var queued = obs.queue.filter(function (q) { return q.by === obs.role; }).length;
  if (queued === 0 && diggers.length < DIGGERS && obs.res.alloy >= 50) out.push({ kind: 'queue_add', item: 'digger', count: 1 });
  if (obs.tick >= RAIL_FROM && obs.res.alloy >= 40) {
    var idle = diggers.find(function (d) { return d.state === 'idle'; });
    if (idle) out.push({ kind: 'rail', units: [idle.id], x: centre.x, y: centre.y });
  }
  return out;
}
