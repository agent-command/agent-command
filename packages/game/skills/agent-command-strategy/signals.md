# Team signals — asking teammates for help

Your three teammates (humans, agents, policies or built-in bots) answer typed support requests. A signal carries a
need, an optional count and an optional tile — never text — and only your team ever sees it. Briefing topic
`signals` has the exact shapes, states and refusal codes; this page is how to use them well.

## Who answers what

| need | answered by | what the answerer does |
|---|---|---|
| `troops` | Surface, Depths | Surface: troopers to the tile; for the Depths they `transfer` down the own Shaft nearest the tile (own built, unsealed Shafts are the only portals). Depths: troopers up an own Shaft near the tile. |
| `flak` | Surface | Flak moves under the tile and holds (rocks, enemy air over an island's path). |
| `air_cover` | Sky | Interceptors screen the tile. For Orbit, researched interceptors `ascend` over its arrays or tugs. |
| `bombers` | Sky | Bombers attack a visible structure at the tile once the sky is safe. |
| `scan` | Orbit | A scan at the tile (energy and cooldown permitting). |
| `escort` | Orbit | The fleet (Bastions first) moves to the tile in orbit: an ascended raid, a tow. |
| `collapse` | Depths | Sappers undermine the tile from a tunnel below it, stacked as a known structure there needs (else `count`); diggers dig there first if no tunnel reaches. Done once the charge is planted. |
| `drop` | Orbit | The next towed asteroid that can reach is deorbited onto the tile (house rules permitting). |
| `capture` | Sky, Surface | Sky: interceptors take the island nearest the tile; Surface: troopers take the forward post nearest it. Ask `team`. Done once held. |
| `defend` {plane} | everyone (`to: team`) | Help hold our segment on `plane` (x/y = our Spire). Bots: Depths root → Surface troopers down a Shaft; Surface → Depths troopers up; Sky → Surface flak; Orbit → Sky interceptors ascend. |

`to` is the answering plane, or `team` to reach every plane that answers that need (the first to ack takes it).
Asking a plane for something it cannot do is refused (`unsupported`).

## Asking

```json
{"kind":"signal","signal":{"kind":"request_support","to":"surface","need":"troops","count":4,"x":21,"y":30}}
```

- Ask once and follow it in `signals.sent`: `submitted` → `working` (acked; `by` says who) → `completed`, or
  `rejected` / `failed` / `canceled` / `expired`. Cancel what you no longer need (`signal_update` `cancel`).
- Always give the tile. A count is a wish: answerers keep their own plane alive first.
- Good asks: Depths pushing behind a walled Warden → `troops` at the wall; Orbit under raid → `air_cover` at the
  threat; Surface sieging → `scan` and `bombers` on the target, `collapse` under a turret line or Headframe, `drop`
  on a turret ring; Sky with an island's path under enemy air or rocks → `flak` under it; anyone blind → `scan`;
  a post or island you need → `capture`; your alert `segment_threatened` (crowns: a fallen
  segment costs crowns) → `defend` with your plane to `team`.
- Each seat has a small open-signal cap and a send rate (`matchData.rules.signals`); spam gets `rate_limited` or
  `too_many_open`.

## Answering

Your observation's `signals.inbox` lists what teammates asked of you, and `game_wait` returns early with
`wake: "signal"` when one arrives. Answer fast:

```json
{"kind":"signal_update","id":"sg_7","update":"ack"}
```

`ack` when you commit, act, then `done` — or `decline` at once when you cannot spare it, `fail` if it went wrong. An
unanswered request expires (`rules.signals.ttl`). Requests are not orders: weigh them against your mandate, but a
fast `decline` beats silence because the requester can ask elsewhere.

## Policies

`think(obs)` sees the same `obs.signals`. The starters answer their plane's needs and make the asks above as the
bots do (`policies/game/bots/signals.js`, see [policies.md](policies.md)); they check `matchData.rules.signals.enabled`
first. When a match turns signals off, every signal intent is refused `disabled`: plan without help.

## Humans

A human teammate sees requests in the event feed and on the target plane's chip (click jumps to the tile), answers
in one click, and asks from the command card. Ask them exactly as you would ask a bot.
