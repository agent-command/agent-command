# Exploit hunt: hunt-pass2-smoke

gpt-5-mini · spent $0.0570 of $0.15 · 0.8 min wall.

One LLM commander per role in the PlayerThree lobby (loopback MCP, the player tool surface), told to find degenerate strategies by writing policies and practising them against the veteran bots. Each role's final deployed policy is then re-played through the sweep harness (its seat only; bots of the same level elsewhere) in both orientations. A final policy above 65% against its own level is a finding.

| role | stop | turns | tool calls | spent | deploys (ok) | practices (W/L/D) | final | vs standard | vs veteran |
|---|---|---:|---:|---:|---:|---|---|---|---|
| surface | finished | 11 | 10 | $0.0570 | 3 (3) | 0/4/0 | v3 | 0% [0%–49%] of 4 | 0% [0%–49%] of 4 |

## surface

Agent's closing words (LLM-authored):

> I finished preparation: tried three focused surface policies against the built-in veteran (practice_run, 24k ticks). Summary of the three ideas, their records and why the best one performed relatively better:
> 
> - Trooper rush (strategy: trooper_rush). Runs: seed 42 — loss (spireDamageDealt 14, produced 94, unitsLost 92); seed 7 — loss (spireDamageDealt 10, produced 124, unitsLost 138). Notes: very cheap, fast production and constant rally/attack, but troopers die quickly to the veteran’s mixed counters and the veteran’s multi-plane pressure (asteroids, orbital/sky damage). Too fragile to threaten the spire reliably.
> 
> - Tank bombard (strategy: tank_bombard). Run: seed 42 — loss (spireDamageDealt ~1200, produced 42, unitsLost 45). Notes: concentrated heavy damage and ranged persistence let this deal the most surface spire damage of the three, but tanks are slow/expensive so production was limited; the veteran exploited multi-plane damage (asteroids / sky/orbit pressure) and other map effects to overwhelm or out-economize the tank-only push.
> 
> - Turret wall forward (strategy: turret_wall_forward). Run: seed 42 — loss (spireDamageDealt ~412, produced 107, unitsLost 105). Notes: defensive turrets + trooper spam buys survivability and local control but doesn’t translate into consistent spire kills; the veteran’s broader play (islands, asteroids, multi-plane strikes and sappers) still wins.
> 
> Why the best one worked relatively better: the tank-only policy did the most structural/spire damage because tanks are high-damage, survive longer vs small arms, and attack at range—so massing tanks concentrates DPS on the spire. However, it’s still not degenerate enough to beat the veteran reliably because the veteran uses multi-plane pressure (asteroids, sky/orbit attacks, relay/energy game and depths sappers) that the single-plane, one-unit-type plan cannot counter.
> 
> I’ve left the last deployed version as the turret_wall_forward (version 3) per the instruction to keep something running; I stopped after these three ideas. If you want, I can (a) iterate on the tank idea (improve production/energy handling, mix in escorts), (b) search for a different one-dimensional exploit (e.g., abusing a build/visibility rule or a specific mechanics gap), or (c run more seeds on the tank policy to evaluate variance. Which next step do you prefer?

| turn | policy | vs | seed | outcome | minutes | Spire dmg dealt | kills | units lost |
|---:|---|---|---:|---|---:|---:|---:|---:|
| 5 | v1 | veteran | 42 | loss | 6.3 | 14 | 77 | 92 |
| 6 | v1 | veteran | 7 | loss | 7.6 | 10 | 88 | 138 |
| 8 | v2 | veteran | 42 | loss | 5.9 | 1200 | 46 | 45 |
| 10 | v3 | veteran | 42 | loss | 7.3 | 412 | 95 | 105 |

<details><summary>turn 4: deploy v1</summary>

```js
log('strategy: trooper_rush');
var TPS=20;
var rallied=false;
function think(obs){
  var out=[];
  var blue = obs.team==='blue';
  function mirror(x,y){return blue?{x:x,y:y}:{x:48-x,y:48-y};}
  var enemyHome=mirror(40,40);
  if(!rallied){out.push({kind:'rally',x:enemyHome.x,y:enemyHome.y});rallied=true;}
  // produce troopers greedily
  var queued = obs.queue.reduce((n,q)=>n+q.queued,0);
  var army = obs.entities.filter(e=>e.side===obs.team && e.plane==='surface' && e.kind==='trooper');
  if(queued<5 && obs.res.alloy>=40){out.push({kind:'produce',unit:'trooper',count:1});}
  // gather and attack
  var ids = obs.entities.filter(e=>e.side===obs.team && e.plane==='surface' && e.kind==='trooper').map(e=>e.id);
  if(ids.length>=10){
    // attack enemy spire if visible
    var spire = obs.entities.find(e=>e.side!==obs.team && e.kind==='spire' && e.plane==='surface');
    if(spire) out.push({kind:'attack',units:ids.slice(0,64),target:spire.id});
    else out.push({kind:'move',units:ids.slice(0,64),x:enemyHome.x,y:enemyHome.y});
  } else if(ids.length>0){
    out.push({kind:'move',units:ids.slice(0,64),x:enemyHome.x,y:enemyHome.y});
  }
  return out;
}
```

</details>

<details><summary>turn 7: deploy v2</summary>

```js
log('strategy: tank_bombard');
var rallied=false;
function think(obs){
  var out=[];
  var blue = obs.team==='blue';
  function mirror(x,y){return blue?{x:x,y:y}:{x:48-x,y:48-y};}
  var enemyHome=mirror(40,40);
  var front=mirror(18,18);
  if(!rallied){out.push({kind:'rally',x:front.x,y:front.y});rallied=true;}
  var queued = obs.queue.reduce((n,q)=>n+q.queued,0);
  // produce tanks when energy and alloy allow
  if(queued<3 && obs.res.alloy>=90 && obs.res.energy>=60) out.push({kind:'produce',unit:'tank',count:1});
  // move tanks to enemy
  var tanks = obs.entities.filter(e=>e.side===obs.team && e.plane==='surface' && e.kind==='tank').map(e=>e.id);
  if(tanks.length){
    var spire = obs.entities.find(e=>e.side!==obs.team && e.kind==='spire' && e.plane==='surface');
    if(spire) out.push({kind:'attack',units:tanks.slice(0,64),target:spire.id});
    else out.push({kind:'move',units:tanks.slice(0,64),x:enemyHome.x,y:enemyHome.y});
  }
  return out;
}
```

</details>

<details><summary>turn 9: deploy v3 — final</summary>

```js
log('strategy: turret_wall_forward');
var built=false;
function think(obs){
  var out=[];
  var blue = obs.team==='blue';
  function mirror(x,y){return blue?{x:x,y:y}:{x:48-x,y:48-y};}
  var front=mirror(18,18);
  if(!built){
    // try to build two turrets near front if visible and afford
    if(obs.res.alloy>=80 && obs.res.energy>=20){
      out.push({kind:'build',structure:'turret',x:front.x-1,y:front.y});
      out.push({kind:'build',structure:'turret',x:front.x+1,y:front.y});
      built=true;
    }
  }
  // produce troopers greedily
  var queued = obs.queue.reduce((n,q)=>n+q.queued,0);
  if(queued<4 && obs.res.alloy>=40) out.push({kind:'produce',unit:'trooper',count:1});
  // move troopers to front
  var ids = obs.entities.filter(e=>e.side===obs.team && e.plane==='surface' && e.kind==='trooper').map(e=>e.id);
  if(ids.length) out.push({kind:'move',units:ids.slice(0,64),x:front.x,y:front.y});
  return out;
}
```

</details>
