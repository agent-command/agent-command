// Balance probe: VOLATILE TOWS (Orbit policy ABI).
// Forces fragile live-bomb hauling rather than mixed salvage; tests whether visible escorts/PD deny the payoff.
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

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function towSpeed(rock) {
  var r = matchData.rules.orbit;
  return matchData.rules.stats.tug.speed * (rock.rockSize === 'pebble' ? r.pebbleTowSpeed : rock.rockSize === 'large' ? r.largeTowSpeed : r.towSpeed);
}
function travel(rock, target) { return Math.max(0, dist(rock, target) - matchData.rules.orbit.deorbitRange) / towSpeed(rock); }
function think(obs) {
  if (!matchData || matchData.rulesHash !== obs.rulesHash) throw new Error('missing or mismatched match bootstrap');
  ARMY = armyRow(obs.army);
  var focus = focusArmy(obs);
  var r = matchData.rules.orbit, out = [];
  if (!focus) return out;
  var target = focus.spireAt;
  var own = obs.entities.filter(function(e) { return e.side === obs.army; });
  var tugs = own.filter(function(e) { return e.kind === 'tug' && e.plane === 'orbit'; });
  var solars = own.filter(function(e) { return e.kind === 'solar'; });
  if (!obs.queue.some(function(q) { return q.by === 'orbit'; })) {
    if (solars.length < 2) out.push({kind:'queue_add',item:'solar'});
    else if (tugs.length < 5) out.push({kind:'queue_add',item:'tug'});
  }
  if (obs.mandate.limits && obs.mandate.limits.asteroidDrops === false) return out;
  tugs.forEach(function(tug) {
    if (tug.link) {
      delete claims[tug.id];
      var rock = obs.entities.find(function(e) { return e.id === tug.link; });
      if (!rock || rock.volatile !== true) return;
      if (dist(rock,target) <= r.deorbitRange) {
        out.push({kind:'deorbit',units:[tug.id],x:target.x,y:target.y});
      } else if (rock.fuseUntil !== undefined && travel(rock,target) + 1 >= (rock.fuseUntil - obs.tick) / 20) {
        // A fuse that cannot reach the base is spent on clear ground, not flown home into our arrays. Cells are scanned
        // in our canonical frame, so every army searches the same way.
        var landing;
        var radius = (rock.rockSize === 'pebble' ? r.pebbleImpactRadius : rock.rockSize === 'large' ? r.largeImpactRadius : r.impactRadius) * r.volatileRadiusMultiplier;
        for (var c=0;c<MAP*MAP;c++) {
          var p=toWorld({x:c%MAP+0.5,y:Math.floor(c/MAP)+0.5});
          if (dist(rock,p)>r.deorbitRange || own.some(function(e) { return (e.plane==='surface' || e.plane==='orbit') && dist(e,p)<=radius+3; })) continue;
          landing=p; break;
        }
        if (landing) out.push({kind:'deorbit',units:[tug.id],x:landing.x,y:landing.y});
      } else if (tug.tx !== target.x || tug.ty !== target.y) out.push({kind:'move',units:[tug.id],x:target.x,y:target.y});
      return;
    }
    var taken=Object.keys(claims).filter(function(k) { return k!==tug.id; }).map(function(k) { return claims[k]; });
    var pick=obs.entities.filter(function(e) {
      return e.kind==='asteroid' && e.state==='drifting' && e.volatile===true && taken.indexOf(e.id)<0 && travel(e,target)<r.volatileFuse;
    }).reduce(function(best,e) { return !best || dist(e,tug)<dist(best,tug)?e:best; },null);
    if (pick && claims[tug.id]!==pick.id) { claims[tug.id]=pick.id; out.push({kind:'grapple',units:[tug.id],asteroid:pick.id}); }
    else if (!pick && tug.state==='idle') out.push({kind:'move',units:[tug.id],x:MAP/2,y:MAP/2});
  });
  return out;
}
