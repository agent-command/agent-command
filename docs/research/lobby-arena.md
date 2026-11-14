# One lobby, any seat: play, observe and benchmark

**Status: implemented in both repositories.** Sections 1–10 are the approved design; implementation notes are §7.4 and §8.4.

> **Historical record.** This is the design as approved; [DESIGN §2.4](../DESIGN.md#24-unified-lobby-observers-and-benchmark-arena) and the README describe current behaviour. Since then: four-army free-for-all ships on four-corner maps (only 2v2 colour teams remain disabled), Home's **Play vs bots** became **Quick Play** (*You vs Agents or Bots*), and the `LobbyKind`, `/api/match*` routes and per-role roster found in §3 are gone.

This proposal supersedes the separate quick-play/private-host setup concepts in [DESIGN §2.4, §9 and §10](../DESIGN.md) and the single-owner-per-army restriction in [lobby-networking.md](lobby-networking.md) only where explicitly stated below. It preserves exact-seat authorization, sealed agent channels, tick-zero preparation, map-owned layouts, and server-authoritative simulation. PlayerThree is the protocol/SDK name; this document uses the current coordinated repository and package identities.

## 1. Decisions

1. **A match is a map/layout plus sides with seats, not “you versus an enemy.”** Every entry point uses one lobby model and one screen. Occupancy is configured identically on either side.
2. **Play vs bots remains one click.** It creates the normal pre-filled private lobby and immediately requests start. Its adjacent **Customise** action opens that same preset without starting. There is no second match-creation implementation.
3. **Commanders are my connections and policy entries.** A roster entry has an identity, compatible roles, connection information and status. It has no permanent team or enemy designation. A lobby references an entry, never copies its credentials.
4. **Observers are separate principals.** Omniscient world viewing is read-only, explicitly authorized, never a player/agent permission, and separately authorized from access to voluntarily disclosed agent commentary.
5. **PlayerThree runs benchmarks; the game plays matches.** Extend the existing `@playerthree/bench` tracks with a reusable series service. Scheduling, bindings, concurrency, retries/aborts, live standings, rating calculation, results, exports, persistence and share links belong to PlayerThree. Agent Command supplies match-host hooks and renders the setup, observer and results UI.
6. **Full export is a product requirement.** The canonical versioned JSON includes the frozen series/match specs, all scheduled attempts, outcomes, samples, per-seat accounting and sanitized event timeline; CSV contains one file per table. No secret-bearing debug trace is treated as a public export.
7. **Public sharing is opt-in and revocable.** A secret result URL exposes an allowlisted projection and server-rendered social image, not the owner's private series object. The same results screen updates while the series runs.
8. **N-side-ready contracts now, two-side simulation now.** Arrays of physical sides, logical entrants, alliances and explicit permutations support the DeepSeek/OpenAI/Claude/GLM FFA example without claiming that its four-army simulation already exists.
9. **Clean break.** No legacy formats, producers, aliases, deprecated paths, compatibility readers or data conversions. Replace schemas and every caller outright. Existing affected development/production data may be deliberately reset by the operator; never reset it silently.

### Mockups

All numbers, model names and dialogue in these illustrations are illustrative, not observed benchmark results. SVGs are design artifacts, not production icons or implementation screenshots.

- [Unified lobby and benchmark setup variant](lobby-arena-lobby.svg)
- [Omniscient/delayed observer](lobby-arena-observer.svg)
- [Live benchmark standings, exports and sharing](lobby-arena-results.svg)
- [Commanders as connections](lobby-arena-commanders.svg)

Production follows existing `icon()`, `tip()`/`data-tip`, keyboard/focus behavior and dark logo-sampled semantic tokens. No native `title=` tooltips; SVG accessibility titles are not HTML control tooltips. Translucent panels reserve a clear battlefield region. Side identity uses label/icon plus accessible colors, not color alone.

## 2. Primary-source research

Evidence below is scoped to the cited product/version. **NR** means not reported in inspected sources, not that a feature does not exist. Proposed behavior is a design decision, not an assertion about a competitor's implementation. Publisher APIs and patch notes establish particular capabilities; they do not necessarily reproduce today's retail dropdown labels.

### 2.1 StarCraft II: roles, lobby controls and observing

[Blizzard's Arcade improvements](https://news.blizzard.com/en-us/article/21048080/patch-3-19-preview-arcade-improvements) show independent named lobbies, team/human/AI/open-slot previews and explicit create/join; automatic start-on-full was removed. This supports a shared pregame room rather than a setup form masquerading as a lobby.

| Requested comparison | Primary evidence and limits |
|---|---|
| Open / Closed slots | Arcade documentation establishes open-slot previews. The complete retail Open/Closed submenu and its ordering were not established by inspected primary sources; do not present an invented exact screenshot reconstruction. Availability is distinct from the controller that eventually plays. |
| Computer, difficulty, race and strategy | Blizzard's [SC2 protocol](https://github.com/Blizzard/s2client-proto/blob/master/s2clientprotocol/sc2api.proto) declares `Participant`, `Computer`, `Observer`; `PlayerSetup` separately contains race, difficulty and `ai_build`. Difficulties include `VeryEasy` through `VeryHard` and explicitly named cheat variants; builds include rush, timing, power, macro and air. [Patch 2.0.4](https://news.blizzard.com/en-us/article/8724162/starcraft-ii-wings-of-liberty-patch-2-0-4) documents retail AI build choices such as Full Rush, Timing Attack and Straight to Air. [Patch 2.0.10](https://news.blizzard.com/en-us/article/10530389/starcraft-ii-2-0-10-patch-notes) says custom lobbies remember selected race. Protocol identifiers are not a guarantee of identical retail labels. |
| Observer / Referee | `Observer` is explicit in the protocol. Blizzard's [replay/recovery article](https://news.blizzard.com/en-gb/article/10054757/new-replay-and-resume-features-coming-in-heart-of-the-swarm) says a referee or players can unpause a recovered match; 2.0.10 separately names players, spectators and referees in speed-change notifications. Neither source supplies a complete referee permission matrix or proves that all roles are in the same slot dropdown. |
| Production, units and army analysis | 2.0.4 documents clickable Units/Structures/Production icons, cycling units and camera focus, plus Structures/Upgrades tabs. 2.0.10 documents supply/resources layouts and Units Lost. These substantiate production/army-oriented analysis; exact current “Army” tab labels, army-value formula and hotkeys were not established. Our Army tab below has its own explicit formula. |
| Team colors | 2.0.4 documents team-colored life bars; 2.0.10 adds alternate team-play colors in Color Blind Mode. This does not establish a particular current observer forced-red/blue toggle. Keep visual palette independent from vision permission. |
| Vision / player-perspective switching | 2.0.4 explicitly refers to observers viewing **Everyone**. The replay article documents independent player-vision controls per viewer. Flipping scoreboard positions with Ctrl+X is not vision switching. The API has a `player_perspective` field marked **Not implemented**; its presence is not proof of API functionality or absence of retail functionality. |
| Broadcast UI | [Patch 5.0.3](https://news.blizzard.com/en-us/article/23492556/starcraft-ii-5-0-3-patch-notes) documents Pro 2020, support for 1v1–4v4, larger broadcast-readable numbers/icons and less text. Compact, legible summaries are a stronger precedent than copying a particular skin. |

**Delay is not one universal SC2 setting.** No reviewed primary source establishes a universal ranked-ladder spectator service, ranked delay, tournament delay or common numerical duration. [ASUS ROG Summer 2019 rules §3.5](https://tournaments.assembly.org/summer19/pages/view/23) admit only approved streamers/admins as observers and forbid players watching/listening to tournament streams. Its replay rules control saving, publication and recovery inspection separately. [EPIC44 rules](https://tournaments.epiclan.co.uk/tournaments/epic44-starcraft2/rules) make broadcast permission distinct from lobby access. These are organizer rules, not a universal Blizzard ranked policy.

**Replays are a separate viewing product.** Blizzard's replay article describes Watch with Others creating a lobby, synchronized timeline/speed under host control, independent viewer vision/panels, Take Command branching and Recover Game with original players. 2.0.10 describes scrubbing. Adopt versioned artifacts and independent camera/vision controls; do not promise replay compatibility or live recovery merely because an action log exists.

### 2.2 AoE2 DE, Warcraft III and Company of Heroes

| Game and primary source | What is verified | Consequence and limits |
|---|---|---|
| AoE2 DE [official hosting instructions](https://support.ageofempires.com/hc/en-us/articles/360047306372-How-do-I-create-a-multiplayer-match-in-Age-of-Empires-II-Definitive-Edition) | Human/AI player count, AI Difficulty, Open slots filled before ready/start, teams, civilization hiding, Allow Spectators, Spectator Delay and Record Game. | Familiar compact slots plus separate game rules. The article does not enumerate every slot dropdown entry, all difficulty names, or per-AI overrides; its difficulty setting is match-level. Do not conflate AI implementation/version with difficulty. |
| AoE2 DE [official replay support](https://support.ageofempires.com/hc/en-us/articles/9897722830100-Age-II-DE-Replays-on-PC) | Recorded games, saved replay files and sharing; previous-update replays are unsupported and may terminate early. | Record engine/build and distinguish availability of a replay from guaranteed future playback. |
| Warcraft III [Blizzard multiplayer FAQ](https://classic.battle.net/war3/faq/multiplayer.shtml) | Custom colors, observers, computer allies, shared vision/control. | The historical FAQ is not a current Reforged feature matrix. Exact Open/Closed/Computer dropdown ordering, difficulty names and race/observer menu placement were not verified in primary documentation. Community guides report Easy/Normal/Insane, but that is not elevated to a publisher-backed current contract here. |
| Company of Heroes **mobile adaptation**, [Feral official FAQ](https://www.feralinteractive.com/en/faqs/companyofheroes/1.0.2/ios/) | Tap an Allies/Axis slot: Move to this Team; other slots: Easy/Normal/Hard/Expert AI or Close; wait for humans in online skirmish. Maps set capacity; at least one army per side. | Direct primary evidence of slot-local AI/difficulty/exclusion. This is not a verified desktop CoH2/CoH3 menu. |
| CoH2 [Feral desktop manual](https://www.feralinteractive.com/en/manuals/companyofheroes2/latest/steam/#spread9) | Custom battles against humans, AI or mixtures, with separate victory conditions. | Supports one lobby across opponent types, not identical mobile/desktop dropdown labels. |

**Design inference:** combine Open/Closed/Human/Bot/Commander in a familiar row interaction, but keep availability, controller configuration, side/alliance and observer authority separate in the model. We do not need a race dropdown because Agent Command has one faction. We do not need a referee superuser to deliver a read-only observer.

### 2.3 AI arenas and game benchmarks

| System | Match specification / series / seeds / side balancing | Ratings | Cost, latency and artifacts |
|---|---|---|---|
| [SC2 AI Arena architecture](https://aiarena.github.io/general/architecture.html), [rules](https://aiarena.net/wiki/rules/) | Competition defines game, mode, rules, map pool and divisions. Round robin within divisions; requested matches separate. Code and persistent data bundles matter. Mandatory fixed seed suite or paired side swaps: NR. | Per-competition Elo, usually initialized at 1600 according to architecture; requested matches do not affect it. Exact constants NR. | Public replays; bot logs author-private. Standard per-match dollars/tokens/latency NR. Persistent bot data means code version alone does not reproduce an entrant. |
| [Lux AI Season 3 specification](https://github.com/Lux-AI-Challenge/Lux-Design-S3/blob/main/docs/specs.md), [local runner](https://github.com/Lux-AI-Challenge/Lux-Design-S3/blob/main/src/luxai_runner/README.md), [Kaggle environments](https://github.com/Kaggle/kaggle-environments) | Lux game is five 100-step matches with shared randomized mechanics/context and evolving map state. Local fixed seeds supported. A best-of-five is not five independent seed trials. Mandatory seed-paired side swaps NR. Kaggle has observation/configuration/action specs and distinct timeout/error/invalid states. | Lux **local** runner: Elo K=32 or W/T/L, random pairing. This is not evidence of Kaggle's hosted leaderboard formula. | JSON/HTML replays and visualizer; CLI elapsed time; framework action/init timeouts. Standard monetary/token and latency-percentile reports NR. |
| [Halite organizers' paper](https://arxiv.org/html/1710.07738v1), original 2016–17 competition | Simultaneous turn-based, 2–6 participants, random maps; fixed seed suite/paired swaps NR. Not a claim about Halite II/III or Kaggle Halite. | TrueSkill live ladder. | CPU/memory/network sandbox; all server game replays public. Standard per-match cost/decision-latency report NR. |
| [MIT Battlecode 2025 spec v3.1.0](https://releases.battlecode.org/specs/battlecode25/3.1.0/specs.pdf), [engine](https://github.com/battlecode/battlecode25) | Two robot teams, symmetric maps, precise win/tiebreak rules and 2,000-round cap. Tournament-wide seed/series/swap/rating policy NR in these inspected sources. | Game outcomes defined; do not invent a tournament ladder formula. | Bytecode budgets: 17,500/robot/turn and 20,000/tower/turn; separate execution-time limit. Deterministic compute budgets are not dollar/latency measurements. Engine and replay client available. |
| [LMSYS Chatbot Arena paper](https://arxiv.org/html/2403.04132v1), [official statistical explanation](https://arena.ai/blog/extended-arena) | Anonymous paired models, common user prompt, possible multiple turns, identities revealed after vote. Nonuniform/adaptive pairing; not a seed-matched game series. | Historically Elo; paper uses Bradley–Terry coefficients with intervals/sampling-aware estimates. Elo-looking scale does not mean online Elo. | Preference is not a cost-adjusted score. Standardized per-battle cost/latency accounting NR in inspected methodology. Transcripts permit analysis, not deterministic regeneration. |
| [TextArena paper v2](https://arxiv.org/html/2504.11442v2), [repository](https://github.com/TextArena/TextArena) | Reset/observe/action/close interface, solo/two/multiplayer environments and online play. Universal fixed seed suite/minimum series/side swaps NR. | TrueSkill, initial μ=25 and σ=25/3; environment skill profiles. | Standard per-game dollars/tokens/latency NR. Open environments; current repository links a released MindGames trajectory dataset, not necessarily every historical game. |
| [BALROG paper v2](https://arxiv.org/html/2411.13543v2), [evaluation guide](https://github.com/balrog-ai/BALROG/blob/main/docs/evaluation.md) | Single-agent tasks across six environments, explicit model/scaffold distinction. Seed replicates, not adversarial side swaps: e.g. BabyAI 25/task, Crafter 10, TextWorld 20/task. | Normalized completion/progress and standard errors, not Elo. | Trajectories/resumable evaluations/configuration. Paper discusses budgets, not a standard cost/latency scoreboard. Its large NetHack context example is not a measured bill. |
| [GameBench paper](https://arxiv.org/html/2406.06613v1), [repository/data](https://github.com/Joshuaclymer/GameBench) | Nine strategy games; model plus scaffold, state retained within game and destroyed afterward. Unequal game sampling; universal seed/paired-seat protocol NR. | Exponential Bradley–Terry, weighted bootstrap, 10,000 replicates and 90% intervals. Game selection influences aggregate ranks. | Paper explicitly says cost estimates were not obtained. Relative CoT/RAP costs are assumptions. Published match data/scripts are not evidence of a full deterministic action replay archive. |

**Adopt:** immutable evaluation specs; distinguish logical competitor from physical side; publish raw outcomes before ratings; record engine/surface/rules/map/scaffold/artifact identities; reset cross-match agent state by default; isolate held-out seeds; report usage provenance and uncertainty. Optional anonymized display is useful for a future human-voted exhibition, not necessary to determine objective RTS wins. AI Player disclosure is never anonymized away. There is no reason to import Chatbot Arena's preference vote into a simulation with an authoritative outcome.

## 3. Current repository boundaries

These are source findings at design time, not claims about future merges:

- [`packages/game/src/lobby/lobby.ts`](../../packages/game/src/lobby/lobby.ts) has `LobbyKind`, independent `open`, fixed team/role seat rows, a boolean spectator member, map/layout descriptors and N-side-shaped `sides`. Map descriptors only enable the current duel layout.
- [`apps/server/src/lobby.ts`](../../apps/server/src/lobby.ts) already owns atomic claims, private/public listings, serialized preparation, held-match readiness, handoff and leases. Its member owns one team and a role→kind map. That ownership shape cannot express an observer placing two of their own commanders on opposite sides.
- [`apps/web/src/lobby.ts`](../../apps/web/src/lobby.ts) has distinct play/home/host/join/lobby panes; direct quick-play `createMatch` and roster-aware creation remain separate from pregame. [`apps/server/src/app.ts`](../../apps/server/src/app.ts) still has `/api/match`, `/api/match/ready` and `/api/match/start` creation/start paths. Their capacity/worker optimizations must be retained behind one allocator, not retained as a second public setup API.
- [`apps/server/src/roster.ts`](../../apps/server/src/roster.ts) exposes one persistent commander per role and mixes profile response, token, preference, seated team and chat. In PlayerThree, `CommanderStatus`, `StoredCommander` and OAuth routing similarly key identity by owner×role, and one `seated` target exists. Named competing commanders require replacing that identity/routing model and resetting affected stored data, not preserving the old shape.
- PlayerThree [`spec/SPEC.md` §20](https://github.com/player-three-gg/player-three/blob/main/spec/SPEC.md#20-lobby-integration-profile--proposed) already separates `open` from controllers, declares `{team,role}` seats, identity cards, reservations/readiness and broader-view coaching restrictions. It does **not** yet define the full series/results service. The profile remains Proposed where implementation is incomplete; this design must not relabel unrelated reservation/sidecar features as shipped.
- PlayerThree `packages/bench/src/config.ts`, `run.ts`, `bots-config.ts`, `bot-match.ts` and `report.ts` already implement `policy`/`live`/`bots`, held-out seeds, shared budgets, side mirrors, surface pins, numeric game metrics, replays and JSON reports. They currently enforce one/two-side limits (bots exactly two), and fixed A/B bot sets. Generalize these internals; do not create an Agent Command series loop.
- [`packages/game/src/metrics/metrics.ts`](../../packages/game/src/metrics/metrics.ts) exports side numeric maps, snapshots/production/kills/lode measurements, not the complete requested economy/army time series or exact per-seat cause accounting. Extend the recorder rather than claiming the current summary already satisfies raw export.
- PlayerThree `host/history.ts` bounds session history (default 50 / 24 h / 64 MiB). `HistoryStore` saves one released session and optional replay, not an active series with incremental tables/shares. `postgres/index.ts` already provides scoped transactional SQL migrations under an advisory lock and parameterized queries. This is sufficient infrastructure; **no Prisma and no second migration mechanism**.

Map registry work can add descriptor identity/size/tags and more presets independently. Consume that registry's actual supported sizes/layouts; do not copy a competing registry into the lobby. Freeze resolved map identity, seed and options in the match spec, whether delivered by today's terrain preset or the richer registry.

## 4. Unified interaction model

### 4.1 Entry points and navigation

Home has **Play vs bots**, an adjacent **Customise**, **Host**, **Browse**, **Benchmark**, and **Commanders**. Join by code is a small action within Browse; invitations open `#l=<code>` directly. Host is an entry action, not a separate form/screen.

| Entry | Same lobby preset | Start behavior |
|---|---|---|
| Play vs bots | Private practice; first side all You, opposing side all Standard Bot; last chosen valid map/level | Immediately submit normal start flow; loading shows **Customise**. Before start commit it cancels auto-start and opens the lobby. After commit it offers **New match → Customise**, never rewinds a live sim. |
| Customise | Identical Play preset | Stay in lobby; no timer to race. |
| Host | Private; You on first side, other side Open | Stay; copy code, configure, ready/start. |
| Browse / Join | Join the selected existing public/private lobby | Same lobby screen with server-derived permissions. |
| Benchmark | Private; you in Observers, both sides Standard Bot | Same lobby with series drawer open; Start series. |

Anonymous quick play retains an ephemeral visitor principal; persistent commanders, saved series and share links require the existing lazy profile identity. No setup step is added to one-click Play. Preparation still holds ticks until real human room joins. Browser reuse/recovery and capacity queues retain existing bounded leases and opaque-code rules.

### 4.2 Side rows and seats

A side is an army/Spire/economy occupying a map slot; an alliance groups sides. The layout drives the side list and seat roles. The UI initially shows **Northwest · Whole army: Bot · Standard** or **Northwest · Whole army: You**. Expand to Orbit, Sky, Surface, Depths. This is presentation compression only: four explicit seat assignments exist in the server snapshot.

- Selecting a whole-army value atomically changes all compatible seats, with confirmation if it replaces another member's reservation. Permissions never follow from being organizer.
- All four identical semantic occupants/settings collapse to the common row; otherwise the collapsed summary is **Mixed · 4 planes**. No separate “whole-army controller” can disagree with child seats.
- Every seat exposes **You**, **Open**, **Bot**, **Commander**, **Closed**. You is translated to an authenticated human membership reference; it is not a controller kind sent to the sim. An occupied human appears as the member's display name to others.
- Open is an invitation for a human to claim that seat, with an optional “join whole army” convenience. Open does not secretly run a bot. Closed is deliberately inactive (`none` at match creation). Open blocks start; Closed does not. A side with no active seats cannot start; benchmark requires every active seat to be Bot or Commander, with Closed allowed only where the layout marks the role optional.
- Bot shows level (`idle`/`novice`/`standard`/`veteran`, manifest-derived) and **Tune**. Initial useful knobs: aggression and economy reserve, each normalized 0–1 with tier defaults, implemented in deterministic bot decisions. Descriptor carries default/bounds/step and explanation. These are bot strategy options, not per-side combat/economy cheats or shared world-rule overrides. Persist exact values and bot implementation version. Unsupported knobs are not drawn.
- Commander opens **my** roster filtered by compatible role; rows show name, live/policy type, provider/model badge where reported, connection state and preparation readiness. “Connect another” opens the existing connection flow and returns to this lobby. A policy choice pins a specific version/hash at series start.
- Organizer may choose bots/open/closed in unclaimed sides and select their own commanders on either side where fair-play rules allow. They cannot pick another owner's private roster or impersonate that owner's human membership. A human/commander owner retains control over their assigned seat; replacing them requires explicit release/kick and normal revocation.
- Only the owning member edits their claimed human/commander seats; organizer configuration changes touching occupied seats require release first. All mutations carry expected revision, are atomic, and clear readiness/countdown. This prevents stale UI overwrite.

### 4.3 Observers and layout picker

The **Observers** list sits below sides. **Move me to Observers** atomically releases the member's human seats and sets observer admission intent; it need not remove that owner's commanders. In a running match, changing role does not grant live omniscience: the player-history restriction below still applies. The list displays perspective and delay, not tokens.

Map → layout determines side slots, roles, supported sizes and alliance structure. Today's playable layout is 1v1. **2v2** and **FFA** appear disabled with the reason **Requires four-army sim**. Future 2v2 means four separate armies in two alliances, not two humans sharing one Spire. Unsupported layouts fail server validation even if a caller forges a request.

### 4.4 Commanders = my connections

Roster cards have a stable commander ID, owner-private name, live/policy kind, compatible roles, model/provider self-report, harness identity/verification, outbound MCP connection status, last seen, policy artifact/version and readiness prerequisites. Settings cover permissions/fallbacks and connection setup, not a permanent side, human preference or enemy level. Assignment and bot settings move to the lobby.

One owner can have **multiple named commanders for the same role**: e.g. DeepSeek, OpenAI, Claude and GLM all supporting Surface. A connection may command several compatible roles on one side; each assigned seat remains a separately guarded lane. For opposing sides, **separate isolated harness sessions are mandatory**. A single conversation consuming both sides' observations is not “separate agents” just because it uses two tokens. The host enforces distinct seat/session capabilities; an external harness must declare independent-session support, and its isolation claim is recorded as declared, not externally proven.

A roster entry can be reusable, but its assignment is an exclusive execution lease unless its connector advertises isolated parallel lanes. Default series concurrency for live connections is one. Same owner across opponents is permitted in an observer/benchmark match; it does not confer cross-seat agent visibility. Coaching is disabled for that owner while they hold a broader view or opposing seat.

If an owner is also a playing human and owns opposing commanders, show **Unranked practice · cross-side owner** before start and in results. Ranked admission rejects it. Unranked practice does not waive perspective parity or enable cross-side coaching. Multiple accounts/externally shared screenshots are outside enforceable single-profile guarantees and are not described as prevented.

### 4.5 Rules are part of the match

User addition approved with the design: put **Rules · Standard** beside the map picker, not behind a developer console. Offer curated plain rules objects: **Standard**, **Fast** (shorter timers / higher income), **Rich economy**, **No asteroids**, **Calm skies** (no storms), **Long game**. Standard resolves to `DEFAULT_RULES` and alone carries the standard balance-guardrail claim. Every off-default field—including a curated nonstandard preset—shows **Custom rules · Unranked**.

**Advanced** expands schema-driven groups **Orbit**, **Sky**, **Surface**, **Depths**, **Economy**, **Map**, **Match**. Existing bounded `matchOptionsSchema` / rule descriptors remain authoritative: add human label, unit, group and description metadata where absent; do not hand-write a separate input for each field. Each generated control displays actual default/bounds/unit and reset; each group has Reset group. World rules and execution speed are distinct typed values even when shown together in Match. Disabled environmental presets must correspond to real bounded enable/count semantics, not a label hiding an active mechanic.

Every participant sees the effective rules and the **diff from Standard before Ready**; preset/group/field changes are revisioned server mutations that clear readiness/countdown. Selecting a preset replaces the current rule selection with that plain preset's resolved values; no hidden prior custom override survives. Agents continue receiving the complete resolved rules through `briefing.matchData`. Benchmark acceptance freezes those exact values and their canonical `rulesHash`; raw JSON/CSV, owner/public result pages and replay manifests expose them, not merely the preset label.

## 5. Observer policy and transport

### 5.1 Permission matrix

| Principal / mode | Allowed vision | Delay / private channels |
|---|---|---|
| Human player or any agent/policy | Only its authorized side/alliance's guarded view | No omniscient capability. Exact owned-seat operations only. |
| Eliminated or former player in that match | Former authorized side view | Cannot upgrade to omniscient during that live match by leaving, moving to Observers, changing connection or rejoining. Historical participation is retained until end. |
| Private/benchmark observer with no player history | Omniscient **All**, or a chosen side's actual fogged projection | Zero delay allowed by explicit room policy. Read-only; coaching disabled where broader view applies. |
| Public observer | Omniscient All/per-side, only through delayed stream | **180 seconds minimum**, an Agent Command product choice, not a claimed SC2 standard. Organizer may increase, never reduce below server public minimum. |
| Existing team-perspective spectator | Fixed authorized side | Retain this principal as the safe restricted alternative, distinct from omniscient observer. No cross-side switch. |
| Operator/debug principal | Existing separate development authority | Not issued by lobbies, share URLs or observer membership. Production developer surfaces remain disabled. |

A match cannot quietly become public after issuing zero-delay omniscient leases. Changing visibility/policy before start revokes and reissues grants; once started those policies are frozen. A private observer token never authorizes a public stream under weaker rules.

### 5.2 All-seeing is not internal-state access

Add an explicitly declared **observer projection schema** to the game definition: full battlefield/terrain visibility and public side economy/production/army state, not the sim object or `debugView`. Do not form it by merging player views: union-of-fog can still omit unseen entities. Agents continue using the unchanged guarded seat observation path.

Omniscient projection is constructed server-side only after principal admission. Observer-only transport accepts view/perspective requests, never act/tell/mint/mandate/deploy/control. Perspective changes select a server-produced fogged side view or the observer schema. Do not ship all-side data to a player and hide it in CSS. Do not cache omniscient state in player transports or reuse a player endpoint with a client-side `noFog` flag.

The UI has independently controlled **vision**, **camera focus**, **stats focus**, **team palette** and **plane**. All shows no fog; side perspective is that side's fog, not just a camera jump. Resources/production/army tables cover every permitted side. Selecting a production/army row focuses a relevant visible entity without changing authority.

### 5.3 Delay covers every correlated channel

Use one server release clock and bounded append-only frames: `{sequence,tick,recordedAt,releaseAt,world,sideSummaries,events,commentary?,outcome?}`. Release only when `now >= releaseAt`; never merely subtract ticks at accelerated speed. Wall-clock delay is preserved even when sim speed is 20×. Snapshot bootstrap, terrain changes, event/detail requests, agent commentary, metrics, standings, completion notices, replay/download endpoints and outcome metadata obey the same viewer release watermark. Public results cannot reveal a still-hidden match's winner through a counter or social image.

During initial fill show **Delayed 180 s · Buffering**, not a live bootstrap. After the real match ends, continue delayed playback until its end watermark. Reconnection, resume cursors and late joins start at an authorized released frame. No live `ended` push, current tick, winner, active-game count change or private raw-data URL may bypass the delay. Backpressure drops a viewer or resynchronizes it to an older released snapshot, never skips forward to live data. Delay storage has explicit byte/age bounds; if a required frame cannot be retained, fail the stream closed rather than weaken the promise.

The existing featured **Watch live** stream's three-second team-perspective policy is not silently upgraded to omniscience. It either remains explicitly team-perspective with its own policy, or is migrated to the public omniscient 180-second policy; the chosen perspective/delay is visible in the card.

### 5.4 Agent panes are voluntary disclosed commentary

The observer pane groups agents by side and seat, showing their identity cards and **agent-emitted summaries/game chat expressly approved for observers**. It never requests hidden chain-of-thought, provider prompts, raw harness transcript, credentials, policy source, private notes, approval data or another owner's private messages. “Reasoning not shared” is a real state.

Vision permission and commentary permission are separate. Default observer/public/export commentary is off. Each affected owner opts in to specific agent-emitted summary and chat categories for that series; the organizer cannot consent on their behalf. Public Share has a second explicit **Include agent commentary** control and preview; inclusion requires both consent layers. Withdrawing disclosure stops subsequent delivery and revokes existing share projections. Already downloaded or externally cached data cannot be recalled. Read-only observer panes never become owner→agent coaching inputs.

## 6. PlayerThree contract changes (spec first)

Keep `{team,role}` on the existing agent wire: `team` means physical side ID, not an alliance. Do not rename the whole protocol to `side` during this feature. New lobby/series DTOs use explicit side lists and map them to that pair. No game colors, plane names or two-entrant assumptions enter the generic contract.

### 6.1 Proposed §20 edits

| Section | Exact normative change |
|---|---|
| §20.1 Seats/controller kinds | Retain five runtime controllers. Replace ambiguous pregame `kind + open` combinations with the tagged `SlotOccupant` below. Open/Closed are pregame states, not new runtime controllers. A start spec cannot contain Open. Explicit physical sides/alliance IDs; no A/B-only container. |
| §20.2 Identity cards | Add stable **public entrant ID** scoped to the series plus optional self-reported provider/model/scaffold/version metadata and connection/execution-mode summaries. Stable private roster IDs, owner IDs and endpoints do not become public. AI Player remains mandatory. |
| §20.3 Bring-your-own commanders | Replace owner×role identity with owner×commander ID and compatible-role set. Bind a commander version to an exact seat per assignment. Require isolated execution lanes for opposing seats and bounded exclusive leases; agents still cannot browse/join/reserve. |
| §20.4 Reservation | Add commander reference to trusted game-side assignments and atomic batch binding/release. Private refs resolve only under authenticated owner authority. Observer grants are distinct read-only capabilities, never an owner token. Existing-session drops remain governed by explicit game cutoffs. |
| §20.5 Readiness | Retain current state vocabulary and actual-session activation probe. Distinguish connection availability from prepared/ready seat. Whole-army changes validate all seats atomically. Freeze artifact/config versions before series scheduling. |
| §20.6 Capabilities | Add role compatibility and isolated-lane/concurrency capabilities; keep model identity out of gameplay capability matching. Report bot knob schemas from game-owned descriptors. |
| §20.7 Fair play | Specify historical player restriction, cross-side ownership labeling, broader-view coaching denial, per-viewer delay watermark and optional commentary consent. No observer data reaches player/agent scopes. Ratings stay in separate evaluation pools. |
| New §20.9 Observers | Define team-perspective vs omniscient grant, allowed perspectives, minimum delay, independent commentary disclosure and revocation. Game owns policy; SDK enforces capability and transport filtering. |
| New §20.10 Match/series profile | Define frozen specs, logical entrants, physical side permutations, series state machine, attempt identity, host hooks and independent series-service authority. |
| New §20.11 Results/export/storage/sharing | Define the common envelope/tables below, metrics provenance, live revisions, algorithm-versioned ratings, durable result commits, CSV projection, share scope/expiry/revocation and retention metadata. |

This does not require the unrelated Proposed §20.8 sidecar to be implemented. Its eventual engine protocol can carry the same specs/results; the reference in-process host is sufficient for this cutover.

### 6.2 Shared pregame and frozen spec types

The signatures below are proposed public contracts, not copied existing SDK APIs. All IDs are bounded opaque strings; enum-like game keys are manifest/schema validated. Unknown fields are rejected. Provider/model are owner-authored human-facing metadata, never gameplay observations or an excuse to accept keys.

```ts
type SeatRef = { team: string; role: string };
type ExecutionKind = 'agent' | 'policy';
type CommanderRef = { id: string; kind: ExecutionKind; version?: number };
type SlotOccupant =
  | { kind: 'human'; memberId: string }
  | { kind: 'open' }
  | { kind: 'bot'; level: string; options: Record<string, number | boolean> }
  | { kind: 'commander'; ref: CommanderRef }
  | { kind: 'closed' };
type ObserverGrant =
  | { kind: 'team'; team: string; delayMs: number }
  | { kind: 'omniscient'; teams: readonly string[]; delayMs: number };
interface SideSpec {
  id: string; spawnSlot: string; alliance: string;
  seats: readonly { role: string; occupant: SlotOccupant }[];
}
interface EntrantCard {
  id: string; label: string; kind: 'bot' | 'agent' | 'policy' | 'human';
  aiPlayer: boolean;
  provider?: string; model?: string; selfReported?: true;
  harness?: { label: string; verified: boolean };
  scaffoldVersion?: string; artifactHash?: string;
}
interface MatchSpec {
  format: 'playerthree.match'; version: 1;
  game: string; gameVersion: string; surfaceHash: string; rulesHash: string;
  seed: number;
  map: { id: string; identity: string; seed: number; layout: string };
  options: Record<string, unknown>; // game-declared schema; resolved rules, no secrets
  sides: readonly SideSpec[];
  bindings: readonly { seat: SeatRef; entrantId: string }[];
  observerPolicy: { allowOmniscient: boolean; minDelayMs: number };
  rules: { ranked: boolean; coaching: 'off' | 'owner' | 'game'; practiceReasons: readonly string[] };
}
interface SeriesSpec {
  format: 'playerthree.series'; version: 1;
  game: string; gameVersion: string; surfaceHash: string;
  track: 'bots' | 'policy' | 'live';
  entrants: readonly EntrantCard[];
  template: MatchSpec;
  scenarios: readonly { id: string; seed: number; map: MatchSpec['map']; options: Record<string, unknown> }[];
  permutations: readonly { id: string; sideEntrants: readonly { team: string; entrantId: string }[] }[];
  repetitions: number;
  execution: {
    concurrency: number; speed: number;
    clock: 'realtime' | 'accelerated' | 'decision_barrier';
    maxTicks: number; maxWallMs: number; maxInfraRetries: number;
    state: 'reset_each_match' | 'carry_within_series';
  };
  budgets: { maxTokens: number | null; maxCostUsd: string | null; maxTurns: number | null };
  rating: RatingConfig;
  telemetry: { sampleEveryTicks: number; includeCommentary: boolean };
}
type RatingConfig =
  | { algorithm: 'elo'; version: 1; initial: number; k: number; scale: number }
  | { algorithm: 'trueskill'; version: 1; mu: number; sigma: number; beta: number; tau: number; drawProbability: number };
```

`CommanderRef` is owner-private input, not a public shared lobby payload. Public `SlotView` replaces it with `{kind:'commander',entrantId,card,ready}`; owner-specific response includes only that owner's refs. Frozen private `MatchSpec` may contain references, but **export spec projects them to series-local entrant IDs**; credentials/opaque owner IDs are never serialized. Cards have bounded text and disclosure provenance. An Open field in a frozen template is allowed only before schedule validation; accepted start specs must be fully resolved and have none.

`rulesHash` identifies canonical resolved game rules (and its hash algorithm/version in the schema definition), not a stringified partial override. Keep the game's existing numeric runtime rules hash for observations; export additionally records the canonical SHA-256 and algorithm name so cross-build comparisons do not confuse the two. `surfaceHash` is the existing agent-surface pin. Map identity includes the exact registry/document/generator version; event seed stays `MatchSpec.seed` today, separately record any future explicit event/map seed. A seed cannot identify an unversioned generator.

Schedule consists of scenarios × permutations × repetitions in a canonical order fixed at acceptance. UI **N games** is the resulting total, not an ambiguous “N before swaps.” Editing N requires a complete balanced schedule: do not silently drop a side swap or round. Default 10 seeds × one map × two assignments × one repetition = **20 games**. Map/seed lists are exported in full. Repeated seeds are separate repetition IDs, not independent evidence.

For FFA, four logical entrants map to four physical sides; default four cyclic assignments balance corners (not all 24 permutations). Full permutation schedules are representable explicitly. Alliances are physical-layout data and swaps must preserve valid layouts. Agent Command rejects four-side specs until its simulation advertises them; another game with four supported sides can already use the runner.

**North-star example:** four logical entrants `deepseek`, `openai`, `claude`, `glm`, each with four independently guarded plane executions, bind to `northwest`, `northeast`, `southeast`, `southwest`. Each side has its own alliance ID for FFA. Four cyclic permutations move each entrant through every corner for each scenario/seed. A user supplies model/provider/version cards and isolated connector lanes, not provider secrets. Agent Command shows this layout disabled until its N-side sim is real; the exact same generic series shape is executable in another game that already supports four sides.

### 6.3 PlayerThree runner ↔ game interfaces

```ts
interface MatchExecution {
  id: string;
  start(): Promise<void>;
  finished: Promise<GameMatchResult>;
  abort(reason: 'owner' | 'deadline' | 'shutdown' | 'storage' | 'artifact_limit'): Promise<void>;
  dispose(): Promise<void>;
}
interface GameMatchResult {
  terminal: 'finished' | 'forfeit' | 'aborted' | 'infra_error';
  ticks: number; simulatedMs: number; wallMs: number;
  outcomes: readonly { team: string; rank: number | null; outcome: 'win' | 'loss' | 'draw' | 'aborted'; reason: string }[];
  metrics: readonly MetricRow[];
  artifacts: readonly ArtifactRef[];
}
interface ArtifactRef {
  id: string; kind: 'replay' | 'recording'; format: string; version: number;
  sha256: string; bytes: number; availability: 'available' | 'not_recorded' | 'expired';
}
interface MetricRow {
  matchId: string; tick: number; sequence: number;
  scope: 'match' | 'side' | 'seat'; team: string | null; role: string | null;
  metric: string; value: number; unit: string;
}
interface GameMatchHost {
  describe(): Promise<{
    game: string; gameVersion: string; surfaceHash: string;
    supportedLayouts: readonly { map: string; layout: string; sides: readonly string[] }[];
    clocks: readonly SeriesSpec['execution']['clock'][];
  }>;
  resolve(spec: MatchSpec): Promise<MatchSpec>; // validate and freeze actual defaults/hash
  create(spec: MatchSpec, context: {
    attemptId: string; signal: AbortSignal;
    bindings: readonly BoundSeat[];
    emitMetric(row: MetricRow): Promise<void>;
    emitEvent(event: TimelineEvent): Promise<void>;
  }): Promise<MatchExecution>;
  observe(matchId: string, grant: ObserverGrant, after?: number): AsyncIterable<ObserverFrame>;
  artifact(id: string): Promise<AsyncIterable<Uint8Array>>;
}
interface BoundSeat { seat: SeatRef; executionId: string; kind: 'human' | 'agent' | 'policy' | 'bot' | 'none' }
interface TimelineEvent {
  matchId: string; sequence: number; tick: number; atMs: number;
  kind: string; team: string | null; role: string | null;
  data: Record<string, unknown>; // declared safe game/host event schema, never raw debug trace
}
interface ObserverFrame {
  sequence: number; tick: number; recordedAt: number; releaseAt: number;
  perspective: 'all' | string; data: unknown; // validated against declared view schema
}
interface SeriesUpdate {
  seriesId: string; revision: number;
  state: 'queued' | 'running' | 'aborting' | 'completed' | 'aborted' | 'failed';
  completed: number; total: number;
  standings: readonly StandingRow[];
}
interface StandingRow {
  entrantId: string; wins: number; losses: number; draws: number;
  games: number; winRate: number | null; rating: number | null;
  mu: number | null; sigma: number | null; provisional: boolean;
}
interface SeriesRunner {
  create(owner: string, spec: SeriesSpec): Promise<{ id: string; revision: number }>;
  start(owner: string, id: string): Promise<void>;
  abort(owner: string, id: string): Promise<void>;
  updates(access: SeriesAccess, afterRevision?: number): AsyncIterable<SeriesUpdate>;
  results(access: SeriesAccess, revision?: number): Promise<ResultsEnvelope>;
  export(access: SeriesAccess, format: 'json' | 'csv', revision?: number): AsyncIterable<Uint8Array>;
}
type SeriesAccess = { kind: 'owner'; owner: string; seriesId: string }
  | { kind: 'share'; token: string };
```

`BoundSeat.executionId` is a host-side handle, **not a browser credential**. A separate SDK commander binder resolves authenticated refs, allocates isolated leases, passes only exact-seat controls to each connector, and releases them on completion/abort. The game hook receives the resulting opaque execution handles/controller bindings, never a provider API key or another owner's roster token. Observer admission resolves `SeriesAccess` plus game membership into a grant; possessing a series ID is not enough.

Agent Command implements `resolve/create/observe/artifact` using the existing room allocator, PlayerThree host, guarded presentation and metric recorder. It does not implement loops over seeds, rating math, CSV flattening or generic retention. A chess or four-player text game implements the same hooks and supplies its own map/scenario/options semantics, ranks, metrics and observer schema. Headless `GameDefinition` games use an PlayerThree-provided adapter around `createPlayerThreeHost`, `GameMetricRecorder`, trace acknowledgements and replay; no web room is required.

The series package is server-only and importable without CLI startup. Update every CLI `policy`/`live`/`bots` configuration to the new `SeriesSpec` contract and call the same service; do not retain old config parsers. Existing native-vs-policy mirroring, guardrails, held-out practice split, pinned surface and accounting are retained as behavior in common modules. No second A/B executor or game-owned benchmark scheduler remains. HTTP/SSE wrappers authenticate game profiles and delegate to this service; the runner and its store do not depend on Colyseus or Agent Command.

### 6.4 Scheduling, clocks, retries and live standings

- Accept spec only after resolving options, checking support, sample/artifact budgets, independent-lane capacity and all commander consents. Store immutable spec plus deterministic trial IDs. Validate the whole schedule before consuming model budget.
- Default reset policy clears harness conversation/agent scratch state between matches and pins policies/scaffolds. `carry_within_series` is explicit, marks non-independent trials and is incompatible with cross-entrant shared memory. Unverifiable external reset is labeled declared.
- `bots` and prepared `policy` can accelerate without human players. `live` defaults realtime: fast sim with wall-clock LLMs changes the experiment. Accelerated live and decision-barrier modes are explicit capabilities with separate comparison identities and full deadline/budget disclosure, never silently equivalent to realtime play.
- Concurrency is bounded by server capacity and connector lane count; no human-playing match accelerates. Start count is resource admission, not an invitation to spawn arbitrary unbounded workers. Model-free and live budgets are separated; policy authoring usage is attributed to an authoring phase and not falsely charged as zero-cost inference.
- Trial key = series/scenario/permutation/repetition; attempt ID adds attempt number. Retry only declared **infrastructure errors**, default at most one retry, same spec and fresh isolated bindings. Invalid policy, model timeout, budget exhaustion and gameplay loss are not infrastructure retries. Every failed attempt remains in raw data with usage/cost; no cherry-picking the better result. Attempting to resume a non-checkpointed interrupted sim creates a new attempt, never pretends continuity.
- Process death marks unrecoverable active attempts `infra_error` during recovery, releases leases, and follows the stored retry policy. This is series recovery, not live sim restoration. Owner abort stops pending starts, signals active matches, awaits cleanup and commits partial results; it never converts unfinished games to draws.
- Each terminal match is committed exactly once by trial/accepted-attempt uniqueness. Result, incremental counters/rating revision and update event commit together. Stream after commit, with monotonic revision and resume cursor; reconnect can fetch a consistent snapshot. The results page and observers receive new standings as **each match finishes**, not only at end of a model run.
- Concurrent completion order does not change final ratings. At each revision recompute from completed eligible results in canonical schedule order; final outcome is independent of worker finish order. Revision updates may adjust provisional ratings. This is bounded series-side work, never per-tick sim work.
- Default 1v1 Elo: initial 1500, K=32, scale=400, draw score .5. Also support TrueSkill for team/multiplayer ranks: initial μ=25, σ=25/3, β=25/6, τ=25/300, draw probability .1, all algorithm/version parameters recorded. Publish μ/σ and conservative μ−3σ where used, not a mislabeled Elo number. Squad rating is for the entrant lineup, not an invented individually causal seat skill rating. Per-seat stats remain available.
- Win rate is wins/all completed valid games; draws separate. Score rate `(wins + .5 draws)/games` is separately named. Confidence intervals resample **scenario/seed blocks**, keeping side-swapped games together; remove the old unqualified game-count Wilson output rather than preserve a legacy report. Bootstrap seed and method/version are recorded. A two-entrant series-local Elo is descriptive, not a global validated ladder. Rated pools require equal game/build/rules/map family/track/budgets/clock semantics and an independent admission policy.
- Public delayed viewers get revisions only when all contributing result data is released for their watermark. The owner gets live private series updates; shared public page/OG card obey public match delays. A private benchmark shared by its owner may stream live because no human opponent is exposed to an unauthorized live observer.

## 7. Results schema, raw export and metric meanings

### 7.1 Canonical envelope

New `playerthree.results` version 1 is the common game-agnostic envelope. Replace existing bench v1 output and update every producer/consumer, CLI config and committed fixture outright. No historical importer, compatibility reader, old-format producer or version fallback is included. Version fields identify current reproducibility/serialization contracts; they do not promise backward compatibility.

```ts
interface ResultsEnvelope {
  format: 'playerthree.results'; version: 1;
  seriesId: string; revision: number;
  state: SeriesUpdate['state'];
  createdAt: string; updatedAt: string; completedAt: string | null;
  comparisonHash: string; spec: ExportSeriesSpec;
  tables: {
    entrants: readonly Record<string, unknown>[];
    schedule: readonly Record<string, unknown>[];
    matches: readonly Record<string, unknown>[];
    seats: readonly Record<string, unknown>[];
    metrics: readonly MetricRow[];
    causes: readonly Record<string, unknown>[];
    intents: readonly Record<string, unknown>[];
    decisions: readonly Record<string, unknown>[];
    usage: readonly Record<string, unknown>[];
    events: readonly TimelineEvent[];
    standings: readonly StandingRow[];
    artifacts: readonly ArtifactRef[];
  };
  completeness: { scheduleComplete: boolean; rawComplete: boolean; missing: readonly string[] };
  retention: { expiresAt: string; maxBytes: number; bytes: number };
  disclosure: { audience: 'owner' | 'shared'; commentary: boolean };
}
type ExportSeriesSpec = Omit<SeriesSpec, 'template'> & {
  template: Omit<MatchSpec, 'sides'> & {
    sides: readonly { id: string; spawnSlot: string; alliance: string;
      seats: readonly { role: string; kind: 'human' | 'bot' | 'agent' | 'policy' | 'none'; entrantId: string | null }[] }[];
  };
};
```

The table row `Record` notation above shortens the illustration only: **the SDK publishes closed, versioned JSON schemas and TypeScript row types for the exact columns below**, with no arbitrary provider payload or unconstrained text. `MetricRow.metric/unit` and event `kind/data` are validated by game-declared descriptors, bounded in cardinality/bytes. The export schema includes foreign keys and metric definitions, making CSV usable without parsing the UI. No protocol change relies on untyped `unknown` validation at runtime.

| Table | Required columns / interpretation |
|---|---|
| entrants | `entrantId, kind, label, provider?, model?, selfReported, harness?, harnessVerified, scaffoldVersion?, artifactHash?, botVersion?, botLevel?, botOptions, stateResetSource` — no private roster/owner IDs. |
| schedule | `trialId, scenarioId, permutationId, repetition, scheduleIndex, seed, mapId, mapIdentity, mapSeed, layoutId, rulesHash, surfaceHash, resolvedOptions, sideBindings` — preserves logical entrants and physical sides. |
| matches | `matchId, trialId, attemptId, attemptNumber, status, acceptedAttempt, startedAt, endedAt, ticks, simulatedMs, wallMs, terminalReason, outcomes[]` with ranks/ties for N sides. Infrastructure/aborted attempts remain explicit; they are not rated as draws. |
| seats | `matchId, team, role, entrantId, executionKind, fallbackKind?, artifactVersion?, artifactHash?, readyState, activeTicks, submittedIntents, acceptedIntents, rejectedIntents, commandApm, policyErrors` — one row for each assigned seat/attempt. |
| metrics | Common `MetricRow` columns above: exact tick, scope, optional side/role, metric key, numeric value and unit. Includes economy/army/production samples, not just final summary. |
| causes | `matchId, sequence, tick, victimTeam, victimRole, victimKind, attackerTeam?, attackerRole?, attackerKind?, cause, count, alloyValue, energyValue` — environmental, friendly, cross-plane, self/unknown attribution remain distinct; conservation checks relate total deaths to causes. |
| intents | `matchId, team, role, source, code, submitted, accepted, rejected` summary buckets, plus timeline events for each attempt/ack. `code='ok'` for acceptance; schema/game/policy/rate-limit codes are preserved with namespace. Rejected raw unvalidated input is not echoed. |
| decisions | `matchId, team, role, decisionId, startedAt, finishedAt, latencyMs, source, status` — raw latency samples; source distinguishes runner/provider instrumentation, self-report and host observed call gaps. |
| usage | `matchId?, phase, team?, role?, entrantId, executionId, decisionId?, reporter, inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, costAmount?, currency?, pricingVersion?, coverage` — authoring and failed attempts included; nullable unknowns. No keys, API URLs or prompts. |
| events | `matchId, sequence, tick, atMs, kind, team?, role?, data` — sanitized authoritative lifecycle/controller/combat/economy/intent-ack/commentary events according to declared schemas. Agent/private debug traces are never copied wholesale. |
| standings | Current revision counts/rates and chosen algorithm parameters/results; seed-block intervals and average simulated/wall length stored as separate typed summary fields in the published row schema. |
| artifacts | `id, matchId, kind, format, version, sha256, bytes, availability, releaseAt, expiresAt` — export manifest resolves a separately authorized replay/recording download link, not a bearer for a live room. |

Every terminal match row also records its resolved export-safe `MatchSpec` or references a content-addressed copy included in the envelope. The series spec plus schedule is enough to recover seeds/maps/rules/bindings without guessing defaults. Canonical serialization uses existing `canonicalJson` rules, deterministic table order/primary keys, finite numbers, UTC timestamps and explicit null; decimal money is a string. Export digest covers the exact version/revision bytes. Equal comparison identity covers game/version/surface/rules, map identities, complete seed/permutation schedule, track, budgets, reset policy, clock and artifact/scaffold versions; display labels and worker count do not change comparability, though effective contention is reported.

### 7.2 Metrics are honest about attribution

- **Economy over time:** sample alloy/energy stocks, gross income, spending and refunds at one simulated second by default; final exact totals and tick-based sampling cadence are recorded. Resources belong to an army's shared economy: publish **side scope**, and per-seat attributable spend/income actions where meaningful. Do not duplicate side income four times and call each copy an agent's economy.
- **Army value:** current replacement alloy/energy value by side and current owning plane, excluding unfinished production and reporting structures separately. Use actual resolved costs; keep alloy and energy separate, with any displayed combined-value weight documented. Plane transfers move current army value, while production attribution retains the producing seat.
- **Kills/losses by cause:** victim current plane, attacker plane at damage event, entity kind and environmental/projectile/ability cause. Unknown remains unknown, never arbitrarily assigned to the agent most recently issuing an order. Totals reconcile without attributing a kill once per assisting seat.
- **APM/intents:** command APM = accepted submitted command intents / active simulated minutes, including policy/native-bot commands in separately labeled sources. It is not human click APM and does not count unit-level auto-attacks. Report attempted/accepted/rejected counts and full rejection-code buckets independently. Zero-duration APM is null.
- **Think latency:** p50/p95 from recorded decision durations in milliseconds, sample count and source included. Wall-clock gaps between MCP calls are not model think time. BYOM without instrumentation shows **Not reported**; host inter-call latency can be separately charted. Quantile method is versioned (nearest-rank), raw samples allow recomputation.
- **Tokens/cost:** external agents optionally report monotonically sequenced usage through a schema-bounded exact-seat accounting call; the built-in runner reports measured provider usage. Distinguish reported, runner-observed, estimated and unpriced. Missing usage/cost is null, never zero; totals show reporting coverage and cannot be called a full bill if partial. Budget enforcement can be exact only for a runner controlling requests; external usage declarations are not independently verified.
- Recorder and observer hooks are observational: they consume resolved sim events without extra RNG calls or mutating iteration order. Use bounded preallocated counters/rings in hot paths; stream append work off-tick. Metrics may grow per recorded event, but must not allocate an unbounded object tree every tick.

### 7.3 Download behavior

Owner gets **Download JSON** and **CSV tables** during the run (a consistent revision snapshot), and a final full-series download when terminal. CSV ZIP includes one UTF-8 RFC-4180 file per table, schema/units manifest and exact specs; nested structured fields use canonical JSON within cells. CSV strings beginning with spreadsheet formula prefixes are escaped in the CSV projection with a documented reversible rule; canonical JSON preserves original safe metadata. Counts, keys, ordering and null conventions reconcile between formats.

“All raw data” means the complete **declared recorded dataset**, not secrets or unrecorded full-state-per-tick video. Preserve every scheduled attempt and emitted safe timeline event, one-second numeric samples, raw decision/usage samples and replay/recording references. Replay is linked if actually retained and compatible; otherwise state `not_recorded` or `expired`. Never display a fake playback link or promise provider nondeterministic generations can be recreated from a seed.

### 7.4 Live summaries versus raw export (implemented)

A series may hold up to its `maxBytes` (2 GiB default) of raw rows, so live pages never materialise them. `SeriesStore.get/list` return metadata only (`chunkStats` per attempt, never rows); `SeriesStore.iterateChunks(id, revision?)` streams verified committed chunks. The owner page, the share page and the share preview read `SeriesRunner.results()` / `previewShare()`, which return a `ResultsSummary` (`format: 'playerthree.results.summary'`): the same shape as the envelope with each table limited to 2,000 rows (entrants, schedule, matches and standings always fit within series limits; metrics are evenly spaced per series so charts span whole matches; other tables keep canonical order), and a `sampling` block the UI prints as a note whenever any table is not complete. Ratings, latency percentiles, usage totals and accounting row/byte counts are exact over all rows. **Download JSON** and **CSV tables** stream the full canonical `playerthree.results` envelope with a bounded external sort, so the download is always every recorded row.

## 8. Persistence, retention and public sharing

### 8.1 Extend the existing storage family

Add generic `SeriesStore` alongside `CommanderStore`, `HistoryStore` and `PoolStore`; expose `storage.series(game)` from `playerthree/postgres` and `jsonSeriesStore(dir)` for local file fallback. Game routing reuses authenticated profile→owner mapping. SQL migrations live in PlayerThree's existing numbered migration directory; game-specific index/extensions use the existing scoped migration option only if needed. Existing scoped advisory-lock/transaction machinery is sufficient; an ORM would add a competing schema source with no benefit here.

```ts
interface SeriesStore {
  create(record: StoredSeries): Promise<void>;
  get(id: string): Promise<StoredSeries | undefined>;
  list(owner: string, cursor?: string): Promise<readonly StoredSeries[]>;
  appendChunk(id: string, attemptId: string, chunk: ResultChunk): Promise<void>;
  commitMatch(id: string, expectedRevision: number, commit: MatchCommit): Promise<number>;
  transition(id: string, expectedRevision: number, state: SeriesUpdate['state']): Promise<number>;
  share(id: string, owner: string, policy: SharePolicy | null): Promise<ShareRecord | null>;
  resolveShare(tokenDigest: string): Promise<ShareRecord | undefined>;
  prune(now: number): Promise<void>;
}
```

`StoredSeries` contains immutable spec, owner-private binding refs, state/revision/counters, limits/expiry and an execution lease. `ResultChunk` contains typed table rows, ordered chunk index and checksum. `MatchCommit` contains terminal attempt/result, accepted-attempt selection, standings, artifact manifest and stream update. `SharePolicy` contains commentary choice and expiry; `ShareRecord` contains digest/generation, owner and series reference, projection policy and revocation time. SDK schemas/types define these records, not ad-hoc game JSON.

Suggested normalized tables (all scoped by game): `playerthree_series`, `playerthree_series_trials`, `playerthree_series_attempts`, `playerthree_series_result_chunks`, `playerthree_series_artifacts`, `playerthree_series_updates`, `playerthree_series_shares`. Specs/summaries use JSONB; chunks/artifacts retain checksums and byte counts. A partial unique index on `(series,trial) WHERE accepted = true` enforces one accepted terminal outcome while allowing multiple failed attempts; chunk keys are idempotent; commit locks series revision and writes result/standings/update in one transaction. Credentials and provider secrets are never in result JSONB.

Database errors reject the operation and stop further scheduling; do not use existing best-effort session-history writes as a durability claim. Public state only advertises committed results. On restart reclaim expired execution leases, reconstruct updates from committed rows and resolve active attempts through stored retry/abort rules. Postgres is mandatory in configured production; file fallback is an explicit local configuration, never silent failover on a broken production database. File store uses ordered atomic temp-file/rename commits plus revision journal/recovery and bounded chunk files under existing storage conventions; it does not pretend multi-process transactions.

### 8.2 Concrete default limits

Proposed operator-configurable defaults, shown before start and copied into accepted specs/results:

- At most **200 matches/series**, **2 active series/profile**, **1 active live-connection lane by default**, **2 concurrent model-free matches/series** within global admission limits.
- Maximum **30 simulated minutes/match**, **60 wall minutes/match**; external live/barrier deadlines remain explicit and cannot pause indefinitely.
- **1-second** economy/army samples; maximum **256 MiB uncompressed recorded data/match**, **2 GiB/series**, **4 GiB retained data/profile**. Strict per-row/event/text/card limits and a declared maximum event rate make admission estimates bounded.
- Retain full series/raw artifacts for **30 days**; completed share expires no later than its underlying results. Keep no indefinite public share. Owner can delete earlier; deletion revokes all shares, exports and artifacts. No results pin bypasses a profile quota.
- Never silently truncate required raw data. Preflight storage capacity; append chunks incrementally. Approaching a hard cap triggers explicit `artifact_limit` abort with complete collected data and clear terminal reason. `rawComplete` means all emitted records through abort persisted, not that every scheduled game ran. If durable recording itself fails, mark `rawComplete:false`/failed, stop scheduling, and do not present a complete benchmark.
- Delay-buffer quota is separate from result retention; resource admission must cover its worst case or refuse public omniscient start. Pruning is indexed, bounded and uses the same store interface for Postgres/local.

### 8.3 Share URL and page

Owner clicks **Share**, previews the exact projection, chooses commentary off/on with per-owner consent checks, and receives `/arena/share/<random-192-bit-token>`. Store only SHA-256 token digest; owner-only series URLs use a different route/credential. Shared GET, update stream, CSV/JSON and image all resolve the same active share generation and policy. Revoke deletes/disables the generation; re-share creates a new token. Unknown, expired and revoked links have the same not-found response. Rate-limit lookup and exports. Secret links are bearer capabilities, not discoverable public directory entries.

Page shows series status/progress, standings, Elo/TrueSkill method and provisional state, win rates/uncertainty, match-length charts, per-agent identity cards, game-specific economy/army/losses/intent charts, telemetry coverage, matches/timeline/replay links and safe downloads. Private owner controls, connection details, raw prompts, tokens, policy code and chat are absent. Public commentary only appears after explicit consent. Public update stream uses the same revision/watermark logic as exports and imagery.

Server-render HTML with OpenGraph/Twitter tags and a **1200×630 PNG** rendered server-side from safe text and local logo/fonts (no external URL fetch, no arbitrary SVG/HTML input). Example: **Claude vs GPT · 20 games · 13–7**; include Running/Completed and game/track. Image route rechecks share authorization each request and has no standalone permanent public bucket URL. Use `noindex`, `Referrer-Policy: no-referrer`, restrictive CSP, no third-party analytics/assets and `Cache-Control: private, no-store`; redact token-bearing routes from logs. Offer copy-link explicitly, not auto-sharing.

Revocation prevents future origin access; it **cannot erase screenshots, already downloaded exports or copies cached by social platforms**. State this before Share. Serving an image to an unfurl crawler intentionally discloses that image; do not market an unguessable URL as strong identity-authenticated privacy.

### 8.4 Server transport contract

`createArenaService({config,host,storage,profileOf,open,lobbies,limits?})` supplies the HTTP wrapper and the single-match host adapter. The canonical allocator supplies the actual held PlayerThree match; the SDK owns exact-seat commander/policy/bot activation, tick-boundary halt and read-only observer frames. The game never runs a second seed scheduler, rating algorithm or CSV exporter.

- Profile Bearer authentication is the only owner authority. `POST /api/arena/series` accepts a closed `SeriesSpec`; `POST /api/lobbies/:code/series` accepts the explicit balanced drawer configuration against a frozen lobby revision. Neither accepts an owner ID, provider credentials or a browser-supplied observer privilege.
- Owner routes under `/api/arena/series/:id` are `GET` status, `POST start`, `POST abort`, `GET events` (SSE with revision cursors), `GET export.json`, `GET export.csv`, `POST share`, `POST share/preview`, and `POST share/revoke`. JSON and CSV ZIP downloads are explicit revision snapshots; replay downloads exist only for available persisted artifacts.
- `GET` and `POST commentary/consent` manage independent `summaries` and `chat` permissions for entrants whose private commander refs resolve under that profile. Consent gates only explicitly observer-disclosed agent emissions, never ordinary private `say`, owner messages, prompts or hidden reasoning. Withdrawing a category revokes existing commentary shares.
- The public page and its `/data`, `/events`, `/export.json`, `/export.csv`, `/image.png`, and `/artifacts/:artifactId` children reauthorize the same share generation. The HTML uses the local application shell with escaped social metadata; the PNG renders safe local text, never caller-supplied markup or remote assets.
- Revisioned `activeMatches` rows authorize `GET matches/:matchId/observer` and the corresponding `/observer/events` stream. These routes grant no room, player, coaching or control credential. They select physical-side projections server-side and obey the same wall-clock release policy, including initial bootstrap and terminal playback.
- Production uses `storage.series(game)`. The only file fallback is an explicitly configured `DATA_DIR`; missing storage disables series operations, and a database failure never silently changes stores. `GET /api/arena/limits` exposes the admitted limits before start. Results and replay retention are thirty days by default, within the same per-match, per-series and per-profile quotas.


## 9. Game server, DTO and UI cutover

### 9.1 Game-owned DTO/API changes

- `LobbySeat`: replace `kind/open/memberId?` with the public tagged occupant projection plus separate readiness. `LobbyMember`: replace `team?/spectator:boolean` with presence and explicit assigned seat refs/observer intent. Physical side arrays come from map/layout descriptors; alliances are explicit, not inferred from red/blue or list position.
- `LobbySnapshot`: add revision, purpose `play|benchmark`, side list, observers with granted perspective/delay summary, frozen rule/fair-play labels and optional series setup/progress reference. Public cards never contain private commander refs. Shared/public updates and authenticated owner extras remain separate serialization functions.
- `LobbyCommand`: atomic `set_seats`, `move_to_observers`, `set_observer_policy`, `set_layout`, `set_series`, `ready`, `start`, `kick`, `leave` with expected revision and role/side membership validation. The leader cannot appoint their browser an operator or an opponent's owner.
- `POST /api/lobbies` accepts a purpose/preset plus validated config; `autoStart` invokes the same state machine only after exact-seat joining/readiness prerequisites. No direct public sim-create path remains. Existing admission workers are internal execution strategies behind the shared allocator.
- Game web routes expose profile-authenticated wrappers for PlayerThree series create/start/abort/status/updates/results/export/share/revoke; handlers contain authentication/admission and rendering, not scheduling math. Share endpoints resolve read-only `SeriesAccess`, not player grants. Same-origin/Origin/body-size/rate-limit conventions are reused.
- SDK `SeatAssignment` adds trusted commander binding/lease identity, bot options and policy pin. Roster API becomes commander-ID based, with role compatibility and exact live lease(s), not `/commanders/<plane>`. OAuth consent selects a named commander and roles; grants are connection/commander-specific and route to isolated exact seats.
- Add schema-bounded optional agent usage reporting/accounting (`game_usage`, exact assigned seat only) plus public card metadata. Update the agent-facing surface/spec first, then SDK, schemas/docs/tests and `pnpm bench:pin`; replace stored policy/profile formats outright and require fresh connections/artifacts after the deliberate reset.

### 9.2 Things removed, not shimmed

1. Separate `buildPlay` setup and `buildHost` configuration forms; keep entry buttons and one shared lobby component. Private/public are a policy toggle, not different match builders.
2. Public `/api/match` create and old ready/start endpoints and their callers; consume only normal lobby handoff. Internal host creation remains for the game hook/development tooling with its existing production boundary.
3. Roster `preference:human|bot|none`, per-role team presets and seat-cycling Commander UI. Humans/bots/closed belong to the lobby. Commander connection settings and explicit absence fallback remain.
4. Owner×role identity as a unique roster key, legacy side→owner auto-seating and single unqualified `seated.team` routing. Replace all affected MCP/OAuth/token/policy-storage/console callers with commander identity plus seat lane. No compatibility aliases or dual authority models.
5. Fixed `A/B` series DTOs and game-owned benchmark/sweep scheduling duplication where they represent the same series execution. Keep balance-specific metric/guardrail definitions and deterministic native sim hooks; make them clients of the common PlayerThree schedule/executor.
6. A public unrestricted spectator token as an accidental admission path; replace with scoped observer capabilities. Never remove development authorization checks to make screenshots easier.
7. Old result/config emitters, parsers, fixtures and ad-hoc report projections; one envelope feeds CLI/JSON/CSV/live/share views. No historical import tooling, format aliases, version fallback or compatibility producer remains.

### 9.3 Schema replacement and deliberate reset

Spec/schema revision precedes SDK/game cutover. Replace the owner×role schema with commander IDs, exact binding leases and the new results schema using the existing SQL schema/migration execution mechanism, **not old-data conversion migrations**. Fresh setup creates only the new schema. Existing deployments require an explicitly approved operator reset of affected commander/connection credentials, profiles referencing those records, policy artifacts, history/benchmark data and their local-file equivalents. Do not run that reset merely by opening storage; report the exact affected tables/files and let the operator perform it deliberately. No legacy data loaders, token derivation fallback, conversion script or old-format fixture is retained.

After reset, users create fresh profiles, reconnect named commanders and redeploy policies against the new surface pin. Make this reset requirement visible in the implementation handoff. Coordinate a restart of game/SDK/assets after stopping old live work; no old-format process or active socket is supported alongside the new contracts. Stale clients fail closed and must reload. Browser storage uses the new exact schema and rejects/removes obsolete local values rather than transforming them. This does not add distributed room migration or cross-process live match recovery.

## 10. Approval and implementation acceptance

**Approval gate:** approve or amend this design, especially the 180-second public observer minimum, named-commander schema replacement and deliberate data reset, telemetry/retention limits, reset/isolation guarantees and share disclosure policy. Implementation does not begin before approval.

After approval, implementation is complete only when all entry points use the same lobby, enemy seats accept bots/commanders, an observer can watch a real unfogged match under the permission matrix, PlayerThree runs real series and streams live results, complete raw exports reconcile, sharing/revocation persists and roster bindings are team-independent. A merely compiling setup screen or placeholder results is not acceptance.

Required functional/security checks for the implementing/main agent:

- PlayerThree schemas, exact-seat commander replacement/routing, isolated lanes, reservations/readiness, reset/policy activation and telemetry provenance; no agent credential can invoke lobby/series ownership operations.
- Canonical schedule expansion for one/two/four supported generic sides, swaps/alliances, repetitions, deterministic IDs/comparison hashes and concurrency-independent final ratings; retry/abort/crash recovery and failed-attempt costs retained.
- Postgres and file-store round trips, fresh current-schema initialization, rejection of obsolete data without compatibility conversion, atomic terminal result/revision commits, duplicate callbacks, restart recovery, quota/expiry/delete/revoke and explicit durable-write failure behavior.
- Raw metric reconciliation: cause totals, shared side economy vs seat attribution, transfer/production semantics, accepted/rejected-by-code counts, quantiles from samples, partial usage and authoring costs, canonical JSON↔CSV row/foreign-key equality and safe spreadsheet escaping.
- Omniscient hidden entities actually visible to authorized observers, never to players/agents; perspective switches and reconnects cannot widen grants. Test bootstrap/events/resources/reports/commentary/standings/replay/export/OG against release watermark, including accelerated sim and end-of-match delay. Historical players cannot obtain broader live vision by moving/rejoining.
- Own-side/opponent/observer data sentinels in real HTTP/WebSocket/MCP packets; secrets/private chat/code/prompts/roster IDs absent from shared DTOs/exports/images. Share generation revoked during an active stream/export stops subsequent delivery. Production dev surfaces remain inaccessible.
- Headless **two independent browser contexts plus real agent sessions**: owner creates/customizes; second human joins Open; readiness/handoff/recovery; one-click Play; owner becomes observer; distinct commanders on opposing sides in benchmark; watch no-fog; running standings advance at each finish; download all tables; opt-in Share opens in the second unauthenticated context with safe OG tags/image; Revoke disables page/stream/image/export. Use supported 1v1 for game acceptance and a generic N-side test fixture for contract/runner support, not a fake four-army game UI.
- Responsive lobby/observer/results/roster with keyboard operation, existing icons/tooltips, accessible palette and no occluded world; SVG mockups remain explicitly design artifacts.
- Agent-facing surface changes update spec/SDK/game docs and bench configs; run `pnpm bench:pin`. Exercise existing `policy`/`live`/`bots` track acceptance through the new common runner, retaining guardrails and training/evaluation separation.
- Perf/determinism/policy/long checks only after asking the orchestrator **ready for timing slot** and receiving **go**. No timing evidence is claimed by this design document. Work only in dedicated worktrees of both repositories, exclude `*:Zone.Identifier`, and test coordinated merges there.

## Operator reset for the schema replacement

**Not an automatic migration and not executed by application startup.** Stop old processes before the operator runs this transaction. It drops shared game-scoped PlayerThree tables in their entirety, erasing every game's data in this database; the current Agent Command deployment is dedicated. No `CASCADE` is used: unexpected external dependencies must stop the reset for investigation. Keep the migration ledger table itself and clear only the two known scopes so the fresh schemas initialize together.

```sql
BEGIN;
DROP TABLE IF EXISTS
  public.playerthree_series_result_chunks,
  public.playerthree_series_artifacts,
  public.playerthree_series_updates,
  public.playerthree_series_shares,
  public.playerthree_series_attempts,
  public.playerthree_series_trials,
  public.playerthree_series,
  public.playerthree_commander_artifacts,
  public.playerthree_commander_owners,
  public.playerthree_commander_keys,
  public.playerthree_oauth_connections,
  public.playerthree_oauth_clients,
  public.playerthree_pool_artifacts,
  public.playerthree_pool_entries,
  public.playerthree_sessions,
  public.ac_profiles;
DELETE FROM public.playerthree_migrations
WHERE scope IN ('playerthree', 'agent-command');
COMMIT;
```

For local development, deliberately recreate the configured `DATA_DIR` (the development default is `.data`), including its profiles, commander records/artifacts, OAuth connections, policy pool, history/replays and series directory. Old browser credentials will no longer authenticate after the reset; explicitly create a fresh profile/reconnect, then redeploy policies against the new surface pin. Do not reset production data merely to run local acceptance. The implementation handoff repeats the reset requirement and commands for the operator.
