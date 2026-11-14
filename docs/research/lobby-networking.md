# Lobby networking: research, security boundary and implementation design

> The unified arena contract in [lobby-arena.md](lobby-arena.md) and [DESIGN §2.4](../DESIGN.md#24-unified-lobby-observers-and-benchmark-arena) supersedes this document's prior one-army-owner, fixed-spectator and separate-quick-play implementation descriptions. The source baseline and research below remain a historical record, not compatibility behavior to retain.

## Scope and decision

This document was written before implementation; the baseline below preserves that research, and the implementation record identifies the resulting cutover. Ship networked **1v1** lobbies over the current authoritative simulation, with a **map → spawn slots → supported layouts** descriptor rather than a hard-coded mode/player-count UI. Design four-army 2v2 and four-player FFA here; do not advertise unsupported simulation layouts. PlayerThree changes are **spec first, SDK second**, game-agnostic. Its existing §20 lobby profile remains Proposed; Agent Command owns the reservation service.

Use three separate server-owned objects:

1. **Directory:** live, sanitized summaries of public pregame rooms. Visibility is not authorization.
2. **Pregame room:** membership, configuration, side/plane claims, readiness and countdown. No simulation observations, owner identifiers, bearer credentials, private agent data or policy source in replicated state.
3. **Match room:** one authoritative PlayerThreeMatch, reached through an authenticated, recipient-specific handoff. Match admission is a separate operation from discovering a lobby.

Run the Railway app in cluster mode (Postgres and Redis) with one or more replicas. A browser is never the simulation host. No peer-to-peer relay, STUN/TURN or player port forwarding is required for browser → public WSS server traffic. This is an architectural inference from that transport topology, not a claim that arbitrary corporate firewalls allow WebSockets.

## Source baseline at research start

- `apps/server/src/app.ts`: profile-authenticated private invitations, match creation, ready/start routes, and pre-authorized Colyseus `joinById`; `/dev/*` and the operator console are disabled in production.
- `apps/server/src/room.ts`: one PlayerThreeMatch per `agent_command` room; a one-use **creation ticket** prevents client-created game rooms. This is not a player seat reservation.
- `apps/web/src/lobby.ts`: Home/Host/Join/Lobby/Commanders screens. Its current Lobby lists only this browser session's private invite, not a shared public directory.
- `apps/web/src/net.ts`: room joining with a team token; no durable pregame connection or explicit seat recovery.
- `player-three/spec/SPEC.md` §20 proposes seat kinds, public AI identity cards, atomic reservations, readiness, capability descriptors and fair-play rules. The original side→owner roster convention cannot express explicit per-plane human assignment and narrow transport capabilities.
- PlayerThree Colyseus currently limits team views by recipient but grants side-wide owner authority, broadcasts owner-agent replies to the whole owning side, and permits unrestricted all-side spectator watching. Its cached joined principals do not by themselves implement expiring, first-use-bound credentials or immediate joined-connection revocation.
- `packages/game/src/rules/contract.ts`, `sim.ts`, `world.ts`, `present.ts`, `manifest.ts`: fixed `blue`/`red`, `other(team)`, paired world generation, two-team ownership codes and two-team bootstrap schemas. Existing `briefing.matchData`, policy `init(matchData)` and observation `rulesHash` must remain intact.

These observations are source findings, not a claim that all current public-lobby security requirements were already implemented.

## Implementation record

- `packages/game/src/lobby/lobby.ts` declares maps, corner slots and supported layouts/alliances, deriving cached lobby descriptors only from participating slots. Open/Ridges/Canyons enable their opposite-corner `duel` layout only; four-army simulation is not claimed.
- `apps/server/src/lobby.ts` implements the public allowlist directory, private/public pregame rooms, authenticated atomic army/plane claims, ephemeral first-use lobby grants, held-match preparation, readiness/countdown, private exact-seat handoff, spectator leases, leave/kick, reservation/recovery expiry and drain cancellation. A per-lobby asynchronous lane serializes cancelled preparation/disposal before reseating the same owners.
- PlayerThree explicit assignments and `holdStart` replace side-wide seating conventions; per-seat human and fixed-perspective spectator credentials use expiring authorization leases and recipient checks over Colyseus/MCP. Safe cards/readiness are separate from private `SeatInfo`. Policy artifacts persist `surfaceHash` (including an upgrade-safe Postgres migration) and validate/probe against guarded actual-match bootstrap before activation. Root owner/spectator credentials are not issued for public lobby play.
- `apps/web/src/lobby-net.ts` carries live directory/pregame updates; `match-connection.ts` joins private exact-role sockets, routes owner operations per role, renews connected seats in place through profile authentication (`/renew`; fresh tickets and a rejoin only when a seat cannot be extended), recovers disconnects, and stops recovery after a terminal report. The UI uses public `#l=` codes and lazy profile acquisition, not saved session-only invitation cards.
- Default holds: unacknowledged lobby admission **30 s** (`LOBBY_RESERVATION_SECONDS`), pregame/live-human recovery **45 s** (`LOBBY_RECOVERY_SECONDS`), preparation **90 s** (`READY_SECONDS`), countdown **3 s** (`LOBBY_COUNTDOWN_SECONDS`), actual human handoff **30 s**. Agent/policy-only armies can continue without a browser; match-duration limits still apply.
- Acceptance sources: `apps/server/test/lobby.test.ts` exercises real HTTP/WebSocket/MCP adversaries and lifecycle; web lobby and exact-seat transport tests cover UI/routing/renewal; game lobby-map tests cover descriptor derivation. SDK suites cover lease lifecycle, per-recipient binding, policy activation and MCP negotiation. Executed checks and two-browser evidence are reported in the handoff, not presumed by this inventory.


## Primary-source comparisons

### Colyseus: discovery is not a game lobby

[Colyseus LobbyRoom](https://docs.colyseus.io/matchmaker/lobby) is a live room directory: opt in with `enableRealtimeListing()`, then receive initial `rooms` and incremental `+`/`-` updates. It does not implement plane ownership, invitations, ready checks or agent consent. [matchMaker](https://docs.colyseus.io/matchmaker) separates `createRoom`, `reserveSeatFor` and SDK `consumeSeatReservation`; a room may be created on another process.

[Room defaults](https://docs.colyseus.io/room#configuration-properties) include a 15-second seat-reservation timeout, unbounded default clients/messages, and automatic disposal. The 15 seconds covers allocation-to-connection, **not** a role claim or disconnect recovery window. Set explicit limits and distinguish those clocks.

[Visibility](https://docs.colyseus.io/matchmaker/visibility) matters: private hides ordinary discovery but still permits `joinById`; unlisted can still be filled by matchmaking; locked prevents ordinary joins but not reconnection. None is a password/identity boundary. Admission must authenticate in the application.

[Reconnection](https://docs.colyseus.io/room/reconnection) requires server `allowReconnection`; success retains session ID, auth, user data and view and rotates the reconnection token. Reload recovery uses `client.reconnect` and requires reattaching listeners. Because retained auth is not fresh authorization, revoked/expired application leases must still be checked for every inbound action and private outbound delivery.

[Presence](https://docs.colyseus.io/server/presence) provides IPC/shared pub-sub and key-value state. [Scale-out](https://docs.colyseus.io/scalability) uses RedisPresence and RedisDriver, but **one room still belongs to one process**. Redis neither parallelizes nor replicates a simulation.

**Adopt:** separate directory/pregame/match objects; server-owned admission and handoff; explicit bounded timers; local presence now. Do not treat listing metadata, room IDs or framework session IDs as player authority. Do not put private fields into a shared schema: [StateView](https://docs.colyseus.io/state/view) warns that entire state is visible by default.

### Steam: social owner versus simulation authority

[Steam matchmaking](https://partner.steamgames.com/doc/features/multiplayer/matchmaking) provides searchable lobby metadata, membership and chat before connecting to a dedicated server or nominated peer. [GetLobbyOwner](https://partner.steamgames.com/doc/api/ISteamMatchmaking#GetLobbyOwner) automatically transfers lobby ownership if its owner leaves. [SetLobbyGameServer](https://partner.steamgames.com/doc/api/ISteamMatchmaking#SetLobbyGameServer) associates game-server connection information and emits `LobbyGameCreated_t`; invites identify a lobby, not a seat capability.

**Adopt:** stable social room, explicit Create/Join/Start and a clear handoff event. Transferring a pregame organizer role is optional social moderation; it is not browser simulation-host migration. A shared invite must never be a team-owner credential.

### Battle.net / StarCraft II custom games

[Blizzard's Patch 3.19 arcade explanation](https://news.blizzard.com/en-us/article/21048080/patch-3-19-preview-arcade-improvements) documents individual named lobbies, teams/humans/AI/open-slot previews, explicit Join Lobby/Create Lobby, and removal of automatic start-on-full. It identifies oldest-lobby trolls holding a map hostage as an abuse problem.

**Adopt:** browse actual independent lobby instances, disclose AI occupants, and require explicit readiness/start intent rather than silently starting because all slots filled. Let players bypass an obstructive organizer. These published UX details do not establish Blizzard's private wire protocol, recovery TTL or migration implementation.

### Age of Empires II: Definitive Edition

Official [create-lobby](https://support.ageofempires.com/hc/en-us/articles/360047306372-How-do-I-create-a-multiplayer-match-in-Age-of-Empires-II-Definitive-Edition) instructions expose visibility, player/AI count, password, region, Allow Spectators and Spectator Delay; starting requires prepared occupants and organizer action. [Join instructions](https://support.ageofempires.com/hc/en-us/articles/360047306352-How-do-I-join-a-multiplayer-match-in-Age-of-Empires-II-Definitive-Edition) distinguish custom lobbies, Quick Play and spectating.

**Adopt:** spectator access is its own pregame policy, not an accidental third player slot; readiness is visible. A game's Host button does not prove peer authority or its NAT/reconnection architecture.

### Lichess and Chess.com: offers and pools are different products

Lichess primary source distinguishes real-time Hook offers from correspondence Seeks and rechecks authorization at admission: [Biter.scala](https://github.com/lichess-org/lila/blob/master/modules/lobby/src/main/Biter.scala). [SeekApi.scala](https://github.com/lichess-org/lila/blob/master/modules/lobby/src/main/SeekApi.scala) caps seeks per user, suppresses duplicates and owner-scopes removal. [PoolApi.scala](https://github.com/lichess-org/lila/blob/master/modules/pool/src/main/PoolApi.scala) checks playbans and leaves other pools; [PoolActor.scala](https://github.com/lichess-org/lila/blob/master/modules/pool/src/main/PoolActor.scala) deduplicates users, pairs in waves, removes paired members before game creation and drops disconnected members. Its race-condition comments are not proof of race freedom.

[Chess.com's matchmaking description](https://support.chess.com/en/articles/8639319-how-does-matchmaking-work-in-live-chess) separates open challenges from queue matching, expands a rating window, favors the oldest waiter on ties, and describes behavior-based separate pools.

**Adopt:** browsing a specific room is not quick play. Any later queue must be principal-scoped, cancellable, deduplicated and revalidated at pairing. Do not invent ratings or a hidden pool in this lobby-only cutover.

### Hathora / Rivet-style allocation

Historical publisher-authored Hathora [RoomsV2](https://unpkg.com/@hathora/cloud-sdk-typescript@2.25.6/sdk/roomsv2.d.ts), [ConnectionInfoV2](https://unpkg.com/@hathora/cloud-sdk-typescript@2.25.6/models/components/connectioninfov2.d.ts), [LobbiesV3](https://unpkg.com/@hathora/cloud-sdk-typescript@2.25.6/sdk/lobbiesv3.d.ts) and [CreateLobbyV3Params](https://unpkg.com/@hathora/cloud-sdk-typescript@2.25.6/models/components/createlobbyv3params.d.ts) separate room allocation/readiness/endpoint discovery from lobby visibility and metadata. Their short-code collision behavior selects the newest room; do **not** copy that for secure invitations.

Rivet's [deprecated official SDK](https://github.com/rivet-dev/rivet-node) returns endpoint information plus player credentials on matchmaking. Its [generated lobby client](https://github.com/rivet-dev/rivet-node/blob/main/src/api/resources/matchmaker/resources/lobbies/client/Client.ts) distinguishes server `ready()` from `setClosed()`; closing matchmaking does not stop direct admission by itself.

**Adopt:** allocation, server readiness and player authorization are distinct states. These are historical primary architecture comparisons, not verified current product availability or TTL guarantees. Do not copy query-string credential examples.

## Maps, spawn slots, layouts and plane seats

A **player** is an authenticated human owner profile. Every player claims their **own map spawn slot/corner**, Spire and complete four-plane army. An **occupant** is a human, roster agent, validated policy, bot or none controlling one army × plane seat. An **alliance** groups map slots; it is declared by a supported **map layout**, never inferred from color or a mode-wide team-count rule. Delegation stays within a player's own army.

The lobby picks a map, then one of that map's supported layouts, then players claim slots. A map descriptor declares slots/corners, geometry symmetry and its supported alliance layouts with explicit fairness status. The derived descriptor supplies armies, alliances, roles and capacity; the mode label is presentation, not the source of geometry or ownership. Server validation rejects a layout absent from that map or unsupported by the simulation.

| Map-declared layout | Players and plane allocation | World / economy / fog | Win rule |
|---|---|---|---|
| 1v1 (implement now) | Two opposite-corner slots, one human owner per army; each owns four plane seats and delegates only their own planes. No simultaneous opposing-slot ownership. | Two Spires, point-symmetric map; separate economy/queue and fog per army. | Destroy opposing Surface Spire; existing symmetric time-cap/tie rule. |
| 2v2, adjacent pairs | Four corner slots, one player/Spire/four-plane army each. A map explicitly supports adjacent-slot alliances (for example NW+NE versus SW+SE) if its geometry is fair for that grouping. Allies never receive each other's plane authority implicitly. | Four separate economies/queues. Alliance vision sharing is explicit; private owner-agent chat, notes, credentials and policy source remain owner-private even to allies. Four-way generation plus alliance-swap fairness. | Alliance wins after all opposing Surface Spires are eliminated. |
| 2v2, diagonal pairs | The same four independent armies; the map may instead/additionally support opposite-corner alliances (NW+SE versus NE+SW). | Four-way symmetry alone does not establish equal coalition travel, central access or contested-resource exposure: the map declares which layout is supported and its fairness evidence. | Same alliance elimination rule, with symmetric simultaneous defeat/time-cap handling. |
| 1v1v1v1 (FFA) | Four independent corner slots, each with one owner and its own four planes. | Four Spires/economies/queues; no allied fog. Exact quarter-turn symmetry for terrain, storms, spawns, lodes, islands and deterministic tie-breaks. | Last surviving Surface Spire wins; simultaneous elimination/time-cap ties cannot depend on iteration order. |

**User decision:** four independent armies are the 2v2 model. The previously considered shared-side arrangement (two humans splitting one Spire's four planes/economy) is **not** 2v2 and is not an implementation target. Do not introduce shared-side ownership as a shortcut. A map may permit adjacent pairs, diagonal pairs, both or neither; support and fairness belong to the map. Only the current two-slot maps and their 1v1 layout are enabled now.

### N-side simulation plan (not a UI-only flag)

1. **Map contract and ownership before new gameplay:** declare map slots/corners and allowed layouts/alliance relations first. Introduce trusted per-plane owner assignments, human seat capabilities, public cards and exact-seat routing in PlayerThree; remove the side→owner-only convention and migrate callers. Each claimed corner's four planes belong to its one human owner, and lobby code iterates the selected map's slots/roles.
2. **Simulation contract:** instantiate armies from selected spawn slots, replacing two-value Team assumptions, `other(team)`, fixed `Record<blue|red,...>` schemas/registries and binary owner codes with declared slot indices and the selected layout's alliance/hostility relation. Generalize independent resources, queues, populations, defeat/outcomes, research, stat/effect registries and summaries without per-tick allocations. Elimination does not merge armies or transfer private agent ownership.
3. **Geometry and determinism:** four-slot maps require four-way generation: one canonical sector rotated into four with exact integer-cell transforms and canonical local frames. Rotate footprint anchors by footprint dimensions, not merely points. Replicate storms, island paths/phases, home/contested lodes, spawn offsets, currents, fog and sun interactions consistently; preserve simultaneous decisions and rotation-equivariant tie-breaking. Measure coalition access separately for each map-declared adjacent/diagonal layout; a color palette or C4 terrain alone is not fairness evidence.
4. **Fog and observations:** replace one `enemy` record with bounded collections of authorized armies; derive alliance-shared vision from the selected map layout server-side. Generalize matchData map/slot/layout/alliance metadata and `spireAt`, reports and observations; preserve immutable guarded bootstrap, initialization isolation and rulesHash. Never include hostile Depths knowledge or private state to simplify an N-side client. Teammates may share intended battlefield vision, not owner-private agent channels.
5. **Bots and policies:** discover actual spawn slot and allies/enemies from guarded matchData; choose targets from hostile living armies with deterministic scoring instead of `other(team)`. Generalize canonical path/formation frames, resource expansion and coordinated-alliance behavior without hard-coded adjacent or diagonal assumptions. Surface-hash changes require saved-policy activation validation.
6. **Acceptance before enabling layouts:** C2/C4 tick-by-tick rotation-equivariance, per-layout coalition fairness, independent economy/queue tests, simultaneous elimination outcomes, fog-oracle/adversarial multi-client tests, representative bot matches and serialized perf/determinism/policy suites under unchanged thresholds. Enable each supported four-slot map/layout only after its own evidence passes; never enable 2v2 merely because a mode flag exists.

## Lifecycle and transport design

### Creation, directory and claims

The game authenticates human profiles; an agent/commander/OAuth credential is not a profile credential and cannot create/join/claim a lobby. A public directory broadcasts allowlisted summaries only. Private rooms do not appear there. A code identifies a destination, never confers seat authority; use cryptographically random collision-checked codes and bounded failed attempts.

A join reserves an available side/role for the authenticated member; every reservation is atomic, owned by server state and generation-numbered. A supplied owner ID, foreign commander token, endpoint, key or connection configuration is rejected as an unknown input field. A human cannot join both opposing sides or obtain the opponent's spectator perspective.

Keep three clocks distinct: an unacknowledged role/connection hold (short, e.g. 30 seconds), framework allocation-to-WebSocket reservation (15 seconds), and disconnect seat recovery grace (e.g. 45 seconds). These are project choices, not framework guarantees. Expiry, explicit leave or kick releases claims, invalidates all associated capabilities and clears readiness.

### Ready check, countdown and handoff

Config/claim/controller changes clear human ready status. Humans must be connected and explicitly ready. Bots/none are ready. Agents must be present since assignment; policy readiness requires current-surface activation validation in the actual held match. Show absent, stale_policy, policy_failed and consent_required distinctly; never replace them with an optimistic green ready state.

Freeze the accepted descriptor, seed/options and claims before allocation. Create exactly one held match per start generation; validate/probe each saved artifact with that seat's guarded matchData and observation. Hold **all stepping paths**, not only the realtime timer. A countdown starts only after applicable human and SDK readiness gates pass. Any membership/config/readiness change cancels it. At the documented deadline, fallback is explicit on the public card, not a silent agent impersonation.

Public room state announces only phase and match identity. Each browser obtains its own match admission via an authenticated private HTTP response; credentials never become replicated lobby state. Handoff is generation-checked/idempotent, and failed room allocation rolls back without orphaned matches or stolen seats.

### Reconnection and authority

A transient lobby disconnect retains claims only for the bounded grace window, marks the member disconnected/unready and cancels countdown. Reauthorize through the human's profile to recover; never accept possession of a code as proof of ownership. A reload may request fresh own-seat admission, explicitly revoking/replacing that owner's old lease. Unconsented duplicate credential use is rejected.

A match disconnect does not move simulation authority. During bounded recovery the configured bot/policy/hold fallback is visible; a recovered owner receives only their own seat rights and side perspective. After grace/leave/kick/end, old tokens and all associated live leases stop working. A dead server process cannot be recovered by Colyseus reconnect alone; live match checkpoint/replay recovery is separate unimplemented architecture, not something Postgres or Redis supplies automatically.

Pregame organizer transfer may select the oldest remaining member after expiry/leave; organizer rights never grant opponents' control, private data, agent minting or spectator omniscience. There is no browser simulation-host migration.

### Invites and spectators

Use `#l=<code>` for lobby invitations; credential-bearing legacy match links remain fragment-only and are never placed in query strings. Consume/remove credentials from the visible address where possible. [MDN](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment) confirms fragments are not part of the document HTTP request; they can still leak through copied links, screenshots, extensions, scripts and browser history.

A spectator is not a player, owner or agent principal. The initial secure policy is a **fixed authorized side perspective**, with no ability to switch to the opposing side and no owner-agent channels. A future all-sides option requires server-side delay of *every* correlated view/event/report channel, not merely delayed entity positions. Never issue the existing unrestricted spectator token from a public lobby.

## Public-lobby threat model: sealed human and agent channels

### Assets, attackers and trust boundaries

Assume a malicious authenticated opponent, spectator, teammate, unauthenticated Internet caller, stolen/shared token, hostile web origin, reconnecting stale client and untrusted policy. The browser/UI and all inbound messages are untrusted. The server controls profiles, assignments, capability leases and recipient projection. BYOM agents connect **out** to the game MCP endpoint; the game never requests or receives model/API keys, model-provider access or an inbound agent tunnel.

The only publicly disclosed agent identity is an allowlisted **AI Player** card (controller kind, public owner display, harness label/verification status, current live/policy/bot/held mode and public policy version/source identifier). The current adapter marks harness identity unverified and collects no model identity, model execution payloads or provider credentials. No endpoint, opaque profile ID, credential, connection setup, prompt, scope, mandate, reasoning, note, policy code or private event is part of that card. User-supplied text is human-facing textContent only and never enters agent observations/briefings.

[OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) supports WSS, explicit Origin allowlists, per-message authorization, bounded schemas, per-user/IP limits, expiry/logout revocation and sensitive-log redaction. [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) recommends CSPRNG custom session identifiers with at least 128 bits plus server-side invalidation/rotation. Exact seat scope, first-use binding and revocation events below are this project's requirements, not automatic Colyseus properties.

| Threat / leak path | Required server-side mitigation and network acceptance |
|---|---|
| Directory/room serialization leaks secrets | Construct public DTOs from an allowlist, not by spreading host objects. Scan real directory and pregame packets for sentinel tokens, endpoint/config strings, owner IDs, chat, notes, policy source and hidden observations. |
| Foreign seat/commander claim | Authenticate the profile, derive owner from server membership, allow only that owner's assigned seats, reject agents on all lobby mutation routes. Opponent and their agent must fail create/join/claim/mint/control attempts. |
| Shared/replayed seat token | One seat in one match, CSPRNG credential, short TTL, atomically first-use-bound to one transport lease. Reject a second connection unless the exact seat owner explicitly replaces it through profile authentication. |
| Stale cached socket authorization | Revalidate the lease before each inbound action **and** outbound private push. Expiry/leave/kick/end/replacement closes/revokes existing connections, not just future joins. Test an already joined attacker. |
| Side-wide human privilege | A human seat credential grants own-side fogged viewing but control/mint/mandate/scopes/approval/chat only for owned seats. Never give a future teammate a side-owner supertoken. |
| Team/owner channel crossover | Filter every outbound view, briefing, event, report and dispatch by authorized perspective and every owner-agent chat/reasoning/note/policy channel by exact owner/seat. Same-side visibility does not imply private-agent ownership. No shared-room broadcast of private messages. |
| Spectator/coaching oracle | Fixed authorized perspective initially; no opponent watch switch, action, mint, agent chat or player-console escalation. If all-side spectating is later added, delay every information channel and disable coaching. |
| Forge identity / public AI label removal | Cards are produced from authenticated SDK principal/controller state; verification is not a caller-supplied boolean. AI Player disclosure cannot be disabled. This adapter accepts no model/provider claim or credentials. |
| Policy exfiltration / invalid activation | Keep policies sandboxed without network/files/environment; public cards expose only source kind/version, never code/logs. Validate surfaceHash and probe with guarded bootstrap/observation before activation; invalid intents fail activation. |
| Cross-site WebSocket hijack | Allowlist browser Origin during upgrade; authenticate before private data; use WSS in production. No wildcard cross-origin credentials. Test hostile Origin over real WebSocket and HTTP paths. |
| URL / Referer / logs / screenshots | Send credentials only in authenticated request bodies/headers or owner-only fragments, never query strings/listings/shared lobby links. Keep no-referrer, no-store and strict CSP. Do not log raw URLs with query, authorization headers, options, message bodies, tokens or configs. Framework reservation/reconnect IDs are also sensitive and must be redacted. UI cards/screenshots contain no setup secrets. |
| Shared invite / guessed code | A code only locates a room. Use entropy plus per-IP **and** per-principal failed-attempt limits; uniform missing/expired/forbidden responses where appropriate. Reject self-opposition and race for occupied seats atomically. |
| Lobby spam / connection or message flood | Principal+IP create/join/claim limits, one active participation per profile, room/member caps, bounded payloads/messages/in-flight work, connection authentication deadlines, idle expiry and backpressure. Framework defaults are not safe limits. |
| Countdown/reservation races | Recheck ownership, expiry, connection and generation at commit; changing configuration invalidates ready state. Simultaneous claims produce one winner; invalidation during async allocation/probe must not seat the stale owner. |
| BYOM key leakage / reverse tunnels | Accept no provider keys or arbitrary agent callback endpoints in lobby schema. Agents use existing outbound authenticated MCP; never proxy arbitrary destinations. Inject sentinel key fields and require rejection without echo. |
| Production developer surfaces | Keep `/dev/*` and `/playerthree/devtools` 404 with production defaults; new lobby capabilities never authorize operator/debug/unfogged access. Check after the cutover. |

The threat model does not promise secrecy against the user's own malicious extension, compromised endpoint or an intentionally shared screenshot of a private setup screen. It does ensure that untrusted peers never receive those private bytes from our server.

## Railway and scale-out

Now (README "Cluster mode"): any number of replicas behind Railway's non-sticky balancer. One Redis-leased primary runs the coordinator (pregame rooms, directory, admission, the canonical host and local authorization leases), the single writer exactly as the single process; every node hosts simulation workers and is an edge that forwards coordination traffic to the primary's secret-authenticated internal listener. Every lobby match (worker room or main-process match) is served by room id on the node that hosts it and indexed in Redis, so `joinById`, WebSocket upgrades, seat-ticket routes and the coordinator's own calls reach it from anywhere. Postgres stores profiles/rosters/OAuth/policy pool/history, **not live ownership by implication**. Keep the existing private-repo uploader, runtime variables and production surface guards working.

**Primary change.** A process is primary at most once: it builds its coordinator from the stores when it first takes the lease and retires it when the lease goes; owner-document writes are fenced by the lease. Lobbies (members, seats, settings, phase, the started match's room id) and visitor credentials are checkpointed in Redis by the lease holder only (a Lua check of the lease on every write). On a deploy the draining primary settles in-flight mutations, writes the final checkpoint and closes pregame/directory sockets with `LOBBY_MOVED_CLOSE`, then releases the lease; the successor restores every lobby, adopting each started lobby's match where it runs. Pregame lobbies return to waiting (their humans' sockets closed, which cancels a start under the existing rules) and their clients rejoin through a fresh admission. On a crash the lease and heartbeat expire (5 s) and a peer does the same from the last checkpoint; matches on other nodes keep running and their players re-ticket through the new primary. This replaces the earlier per-lobby owner-routing plan: routing to a draining owner would not survive a crash, while checkpoints plus by-room-id match access survive both. Each lobby→match transition stays atomic because only the lease holder mutates or checkpoints lobbies.

Not covered: a crashed node's own matches (no live simulation checkpoints), an agent seated in a main-process match whose primary changes (it loses that seat; the match continues), in-progress OAuth consent and sign-in handshakes, and observer/spectator credentials minted before a primary change (they stay valid until their own expiry; a seat's fresh ticket replaces its old one). Durable match recovery, cross-region placement and ranked matchmaking across a primary change are separate explicit changes.

## Implementation phases and evidence required

1. This research document, including the user's four-army/map-declared-layout decision, source facts versus recommendations and security requirements.
2. Spec-first PlayerThree per-seat assignments and narrow human capabilities; expiring first-use transport leases/revocation; safe public cards/readiness/capability data; correct policy activation using matchData and surfaceHash. Migrate obsolete side-wide assignment callers; preserve ordinary commander OAuth and lobby briefing semantics.
3. Descriptor-driven Colyseus directory/pregame room; authenticated create/join/code/claims; expiry, exact ownership, ready gate/countdown, private handoff, leave/kick and recovery. Enable only 1v1.
4. Extend existing dark lobby UI using icon() and the shared tooltip system, no native title attributes. Public cards are visibly AI; private setup stays on the authenticated Commanders surface.
5. Deterministic lifecycle/unit tests plus real HTTP/WebSocket adversarial tests for every confidentiality boundary and expired/replayed/cross-team credential. A second human **and** their agent must fail to inspect or control the first side's channels. Headless two-browser smoke adds a real agent occupant, both humans ready, countdown/handoff and game views; verify recovery and production developer 404s. Close browsers/services and use private test ports. Run perf/determinism/policies/long suites only in the orchestrator's serialized slot, with unchanged thresholds.

## Executed acceptance record

The lobby networking cutover (`lobby-net.ts`) was checked on the integrated build, including admission/workers, drain and the standalone loader:

- Agent Command workspace typechecks passed. Default game tests passed **679 tests in 37 files**, with the separate timing set (**80 tests in four files**) skipped by the default command.
- The full server suite passed **180 tests in 17 files** with `--maxWorkers=2`. Its **19 real-network lobby cases** exercise HTTP, Colyseus and MCP, including recipient-filtered console SSE: an authorized agent's actual observation reaches its owner while the opposing team's private sentinels do not.
- Web typechecks, the production build and **839 tests in 60 files** passed with `--maxWorkers=2`, including the regression coverage preserving inactive draws/fog state during first-frame shader warmup.
- PlayerThree workspace typechecks and its default workspace suites passed: **448 tests in 36 files**, with `--maxWorkers=2`.
- Headless acceptance used **two independent Chromium processes, two human profiles and two real outbound agents** against the production-built app on an isolated local server. Both humans hosted/joined through the public UI, readied, completed countdown and reached their own rendered, fogged game views. Both loaders reached 100%.
- The browser acceptance checked private agent replies, all four captured human seat tickets, owner credentials and agent credentials against the opponent's received HTTP/WebSocket bytes and DOM. Foreign ticket escalation failed; credentials were absent from request URLs/shared lobby links. A human reload recovered the same profile and army; voluntary opponent leave produced victory. Production developer endpoints returned 404. Browsers, agents and isolated services were closed.

This is **local functional/security acceptance**, not a Railway deployment, cross-process reconnect guarantee, four-player implementation, balance sweep or quiet-box 1×/4× performance certification. The dedicated timing/performance work remains separate and serialized; no thresholds were weakened. The overlap-reconnection limitation above still applies.
