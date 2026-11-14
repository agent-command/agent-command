# Launch capacity and graceful overload

> **Measurement record.** Capacity figures and evidence paths (`/tmp/…`) below come from the recorded runs and are not re-measured for the current build. UI names have since changed (Home's Play vs bots is now **Quick Play**). Current configuration: the README's [Configuration](../../README.md#configuration) and [Production on Railway](../../README.md#production-on-railway).

## Architecture

The HTTP/Colyseus/MCP process remains responsive by putting complete human/built-in-bot matches into a sticky `worker_threads` pool. A worker owns the match's PlayerThree host, deterministic simulation, bot thinking, scoped tickets, room transport and history together. A match never migrates between workers. The frontend forwards match-scoped HTTP and WebSocket traffic to private loopback listeners; these ports are not public services. This avoids cloning or maintaining a second authoritative simulation on the HTTP thread.

The one lobby allocator can place exact human/bot/empty assignments on workers, including humans on independent sides. Live agents, policies and series execution needing full match metrics stay on the canonical host with a separate `MAIN_MAX_MATCHES` limit; workers do not create a second commander registry or published-policy authority. Workers expose no public match-creation API. Human admission uses renewable exact-seat tickets, not team-owner credentials, and observer tickets carry only the canonical server's granted perspective and delay. Both execution classes enter the same FIFO admission queue. Main-thread event-loop lag (the p95 of a rolling ten-second window, `ADMISSION_LAG_PERCENTILE` / `ADMISSION_LAG_WINDOW_SECONDS`, against `ADMISSION_LAG_MS`) gates only main-thread matches, and a worker match is never held behind a main-thread match waiting on it; worker capacity and lag gate that worker's new matches (`ADMISSION_MAIN_LAG_GATES_WORKERS=1` restores main-thread lag gating worker placements too). Running matches are never paused to make room for new arrivals.

A partial GameAdapter proxy remains inappropriate: observation, apply, roster and policy surfaces would require blocking RPC or duplicated authority. Instead `LobbyMatch` is an explicit, limited capability shared by local adapters and workers: cached readiness/cards/terminal state, asynchronous scoped ticket mint/revoke, trusted human readiness, held start, outcome declaration and disposal. Actual authenticated game-room joins are required for human readiness, and preparation stays at tick 0 until the lobby releases it. State changes come from the authoritative SDK match; the parent does not fabricate an PlayerThreeMatch. Public observer retention and delay are requested only by canonical server policy.

Each process uses a fixed-size tick-lag histogram and `monitorEventLoopDelay`. Main-thread admission waits while the rolling delay percentile exceeds its configured threshold. Each worker additionally reports p95 tick lateness over its last ten seconds and rolling thread CPU usage, normalized to one core. New work goes to the least-loaded eligible worker only while lateness and CPU remain below their thresholds; running matches are never throttled to admit another match. Every match is allocated by a lobby (`POST /api/lobbies`, then its pregame room); the admission queue is bounded by `MAX_QUEUE`, holds one waiting place per lobby, and is fed by that lobby's own preparation. Queue position and estimated wait are published in the lobby's snapshots, and leaving or changing the lobby cancels its waiting place. Lobby creation is rate-limited per client IP by `MATCHES_PER_IP` per `MATCH_RATE_WINDOW_S` (default 30 per 10 minutes) and per profile, and the number of open lobbies is bounded by `MAX_MATCHES` (`409 capacity` beyond it).

Worker admission lateness excludes each match's first two game seconds (40 ticks at 20 Hz), including a fresh match on an already-warm worker. A rolling p95 becomes actionable only after **100 mature samples**. The admission controller and target ramp use the same floor; a cold per-report p99 is not a fallback rejection signal. Static ceilings, main-loop shedding and worker CPU protection remain active while the window fills. Raw tick diagnostics still include startup ticks, so their cumulative p99 can differ from the admission window.

The main event-loop histogram is sampled at `resolution: 10` milliseconds. Its raw interval contains that 10 ms baseline; exposed `eventLoop.p50Ms`, `p99Ms` and `maxMs` report `max(0, rawIntervalMs - 10)`, with `resolutionMs: 10` alongside them. Admission and the ramp compare the same corrected gauge with their thresholds: a raw p50 of 10.1 ms means approximately 0.1 ms scheduling lag, not 10.1 ms of overload.

Pressure sampling begins at serving readiness, not while imports, history restoration, worker transports, and authentication initialize. Each worker establishes its CPU baseline and starts reporting only after its host and private listener are ready; the main admission monitor starts after the server's bootstrap completes. An early player request waits up to three seconds for that handoff, then joins the normal FIFO queue only if readiness or capacity is still unavailable. Ready idle workers can therefore admit the first request immediately without inheriting bootstrap-only CPU/lag holds; all real serving-pressure protections remain active afterward.

Cold-development regression: using the actual `node --watch` development launcher with seven workers and zero live matches, the first public Play-vs-bots POST issued directly from the ready-log event returned **200 in 54.2 ms**, not 202. No stabilization sleep or request retry was used. The immediate-post-listen integration test additionally joins that admitted worker room and receives a real game view. Bounded-wait tests cover readiness within three seconds, genuine startup timeout/FIFO handoff, shutdown while waiting, and the exclusion of pre-serving event-loop stalls. Smoke evidence is `/tmp/ac-hug-warm-dev-smoke.json` and its adjacent `.log`.

### Abandoned games and restarts

Lobby-allocated games on the canonical host and on simulation workers end as draws and release their room, commander assignments, admission slot and history through the ordinary disposal path after `ABANDON_GRACE_SECONDS` (default **60**) without a connected human/seat agent or an active MCP/commander agent on either team. Spectators and observers neither keep a game alive nor reset the reconnect grace. Rejoining during the grace preserves the match. Exempt: the featured showcase, a lobby allocation still held in pregame preparation (its lobby owns that expiry; the gate lifts when the lobby starts the match) and all-nonhuman armies/benchmark series (bounded by their own lifetime). Public and other delayed-observer games are abandonable like any other; the observer delay only postpones the room's close after the match ends, normally or abandoned, until the final delayed frame is released. A pending ready check may reach its deadline before abandonment. `ABANDON_GRACE_SECONDS` replaces the former `IDLE_SECONDS`.

A lobby is released as soon as its match ends, normally, by forfeit, at its cap or reclaimed: its members' lobby membership and its lobby slot are freed at once, while the handed-off game room keeps its own end/observer grace, so the same profile or visitor can start Play or Customise again immediately. Creating a new lobby (Play vs bots, host or benchmark) first reclaims that owner's **unattended** previous games immediately, rather than consuming another slot throughout the reconnect grace. The lobby's creator owns its game: profiles by profile id; anonymous visitors, whose lobby identities are minted per lobby, by an opaque host-only HttpOnly, SameSite=Strict browser-session cookie (`__Host-ac_play; Secure` on HTTPS). A profile also owns games seating its named commanders. An IP address is not an ownership credential. A connected human or agent on either team prevents reclamation. Local capacity includes SDK sessions without rooms, and a lobby whose named commanders remain seated in a previous game waits in the shared FIFO queue instead of failing `busy`. Queue starts claim their class capacity synchronously to prevent concurrent polls from overbooking it. `busy` is reserved for a genuine creation conflict, not a full host.

Measured before the unified lobby replaced direct Play (same reclamation and capacity rules, pre-lobby entry path): a development-mode browser regression with a custom agent roster, `MAIN_MAX_MATCHES=1` and one worker completed **Play → Exit → Play five times**: every creation returned `200`, admission took **74 / 123 / 77 / 72 / 59 ms**, and there was exactly one active match after every start. A second profile received the shared `202` queue at position 1 with zero canvases, then entered a real match when the old slot released; no page errors occurred. Evidence: `/tmp/ac-abandoned-smoke.json` and `/tmp/ac-abandoned-profile-queue.png`. This is a lifecycle/functional smoke, not a capacity benchmark; Vite and a development-mode server were used with pressure thresholds raised to isolate slot ownership. The initial watch-mode attempt was interrupted by an unrelated dependency edit; development watch restarts now use SIGINT, while production SIGTERM continues to drain.

## Featured viewing

The home-page **Watch live** link opens a read-only stream with no owner or spectator token and no action channel. One reserved bot match supplies fogged team keyframes and subsequent structural deltas. A three-second wall-clock delay is applied before one serialized buffer is shared with every viewer of that team. A warm join immediately receives a keyframe of the latest released state; no per-viewer simulation, view construction or replay is needed. Slow readers skip intermediate frames, resume at a keyframe and are disconnected if they cannot drain for five seconds. Match rotation leaves viewers on the same stream.

A running public game takes the air from the bot match (DESIGN §2.4). The relay follows it at the game's own public delay instead of three seconds, one subscription per served perspective, from wherever it runs: a worker of the primary, the primary's main process, or another node, whose `/_cluster/observe` streams the released frames as NDJSON over the authenticated internal listener. Viewers still share one serialized buffer per perspective. The bot match it cut away from keeps its reserved slot until it ends; viewers who reconnect after a primary handover get the current pick from the successor, which restores the started lobbies with their start times.

Featured fan-out has its own admission limits: `FEATURED_MAX_VIEWERS=500` total and `FEATURED_VIEWERS_PER_IP=8` concurrent streams by default. The trusted client address follows `TRUST_PROXY` and authenticated cluster forwarding, just like lobby admission. An IP at its limit gets HTTP 429; a full relay gets HTTP 503; both return `stream_capacity` and `Retry-After: 5` before any SSE headers. Closing a reader releases both reservations. These are safety bounds, **not measured sustainable viewer counts**. They do not change game-room `MAX_OBSERVERS_PER_ROOM` or create more simulations. The relay lives on the primary, so adding worker replicas does not multiply featured capacity.

## Reproducing capacity measurements

`tools/loadtest` is a Node-only public-protocol runner. Each match is a private, anonymously created all-bot `benchmark` lobby with auto-start (`POST /api/lobbies`, `/connect` and the pregame room, then `/ticket`); it enters the real Colyseus room with the creator's omniscient observer ticket, watches tick progression through real observer frames and normally waits for natural completion. It never uses cheats or changes simulation speed. It can add extra observers (each an anonymous profile joining that lobby as an observer, at most 15 per match), flood the homepage and hashed static assets, and sweep concurrency levels. Run it against a production web build, not Vite. For bounded steady-state capacity measurements, `--measurement-only` closes its sockets after the hold, leaves each unfinished match's lobby (ending its game) and explicitly reports truncated matches; restart the dedicated server before the next level.

```sh
pnpm build
# Isolated single-thread reference: no worker offload or effective admission limit. Extra observers are anonymous
# profiles (PROFILES_PER_IP); MATCHES_PER_IP governs lobby creation.
NODE_ENV=production SIM_WORKERS=0 FEATURED_MATCH=0 MAIN_MAX_MATCHES=1000 MAX_MATCHES=1000 MATCHES_PER_IP=10000 PROFILES_PER_IP=10000 JOINS_PER_IP_PER_MIN=100000 ADMISSION_LAG_MS=1000 node tools/loadtest/src/server.ts
pnpm --filter @agent-command/loadtest start -- --url http://127.0.0.1:2567 --levels 4 --spectators 12 --ramp 20 --duration 180 --request-timeout 180 --measurement-only --headers
```

For an isolated capacity test, enable the featured match and add `--featured-viewers 1000` to exercise real streaming spectators independently of per-match WebSocket spectators; set `FEATURED_MAX_VIEWERS=1000 FEATURED_VIEWERS_PER_IP=1000` on that test server to admit the single generator. `--home-rps`, `--static-rps` and repeated `--static-path /assets/<actual-build-hash>.js` add origin traffic. `--headers` records bounded cache/compression evidence rather than treating successful HTTP status codes as proof of cache policy. High per-IP limits are measurement-only: one load generator represents many visitors from one machine; production keeps its normal limits. Never run these ramps against production without explicit operator authorization.
`--players` measures what a playing browser receives instead: each match is a `play` lobby whose creator holds its side's human seats (the other side is built-in bots) and enters with its exact-seat tickets, the first seat receiving the team's view stream; the stage reports that socket's received bytes per second during the hold (5 s windows) and the summed worker CPU. The idle human side eventually loses, so use `--duration` with `--measurement-only` and a warmup the fixture survives (2,400–4,800 ticks). `node tools/loadtest/src/views.ts` measures the server side in process: view projection and delta/encode/fan-out CPU per tick, bytes per reader and the join keyframe on warmed seeded matches, plus a codec-only pass on the same views.
Use a fresh server for each measured concurrency: tick histograms are cumulative since boot. Preserve the runner's NDJSON, including raw capacity samples. Report steady-state p99 tick lateness separately from tick execution duration, observed simulation Hz, process RSS, CPU deltas and event-loop delay. RSS is process-wide, including worker threads; do not sum duplicate per-thread RSS values. Derive marginal memory/CPU per match by subtracting an idle sample. End-to-end network view cadence is useful secondary evidence but is not a server tick-lag measurement. A missing telemetry field yields an unknown capacity verdict, not a pass. Run performance measurements only in the orchestrator's timing slot.

The private `tools/loadtest/src/server.ts` harness injects a fixed seed and 9,600 warmup ticks (eight game minutes) before exposing a newly created room to the client. Warmup occurs before the room's realtime timer starts; the measured interval is always 1×. This avoids certifying capacity from cheap opening-game state. It fails explicitly if the chosen fixture ended during warmup. These options are not accepted by any public HTTP endpoint and are never set by the production entrypoint. `LOADTEST_WARMUP_TICKS=0` disables the harness warmup for ordinary protocol/completion tests. Short accelerated tests of completed matches and queue advancement are separate from the default-speed capacity measurements.

## Measured local evidence and production sizing

Measurements used a production web build on WSL2, Node 26.10.0, an Intel i7-6700K (four physical/eight logical CPUs), and 13.65 GiB RAM. Other development agents were running on this workstation. Fixed-seed 41 matches were warmed to tick 9,600, then observed at 1× for a saturated 120-second hold. These are local workload results, **not Railway capacity measurements**. They predate the final rolling-p95 adaptive admission cutover; that cutover has focused metric/admission tests rather than a second sustained capacity run.

| Measured workload | Inline reference | Conservative worker configuration |
| --- | ---: | ---: |
| Live simulations | 2 | 4: three player matches + featured |
| Extra WebSocket spectators | 4 | 6 |
| Shared featured SSE viewers | 0 | 1,000 |
| Homepage / static requests per second | 10 / 20 | 10 / 20 |
| Observed simulation Hz, mean / minimum | 19.63 / 19.16 | 19.94 / 19.42 |
| Server p99 tick lateness | 14 ms | 2 ms |
| Mean / maximum process RSS | 282.8 / 299.5 MB | 752.3 / 836.0 MB |
| Mean process CPU, one-core units | 0.271 core | 0.582 core |
| Worst sampled event-loop p99 | 40.4 ms | 18.5 ms |

The historical event-loop figures in this table precede the resolution correction described above; they include the 10 ms histogram sampling baseline and have not been silently rewritten as new measurements.

The worker workload passed the runner's 20 Hz timing budget with no HTTP, SSE, or response-header failures. All 1,000 viewers received a frame; warm first-frame latency was approximately 1.2 ms median / 48.6 ms p99, in addition to the intentional three-second spectator delay. The inline reference met steady-state tick budgets but its complete runner verdict failed because three HTTP fetches failed during private checkpoint warmup. This distinction must not be hidden. An eight-simulation run (seven players plus featured, two slots per worker) missed the observed-rate budget: mean 19.53 Hz, p05 lower bound 17.68 Hz, p99 tick lateness 23 ms. Short ABAB probes were also noisy: four inline matches varied from 17.99–19.22 Hz; worker probes varied with workstation contention.

CPU percentages in the runner are **not percentages of all eight CPUs**: 100% means one core. The inline workload therefore consumed approximately 0.136 core per match including its static traffic, not a core per match. RSS above the idle reference was approximately 22.9 MiB per inline match including traffic; the worker workload added approximately 42.0 MiB per live simulation including its 1,000-viewer fan-out. Neither number isolates a pure entity-state allocation nor guarantees memory at other game states. The four-worker idle process already occupied 576.3 MB; worker runtime heaps must be included when projecting the 8 GB replica.

Overload evidence: with four live simulations, another public creation returned `202`, position 1. Existing rooms continued at 19.43–20.01 Hz with p99 tick lateness 2 ms. A separate accelerated functional test (`SIM_SPEED=1000`, 60-second game cap, zero end grace) observed the queued request advance from `202` to a distinct admitted room in 3.42 seconds; this is a lifecycle proof, not a default-speed capacity result.

Evidence remains in `/tmp/ac-hug/`: `inline-network.ndjson`, `worker-network.ndjson`, `safe-network.ndjson`, `overload-proof.json`, `queue-advance-proof.json`, and headless `play.png` / `queue.png` / `watch-live.png`. The final screenshots use a separate two-slot configuration (one player match plus featured); the sustained overload proof used four live simulations. Raw artifacts contain disposable local match credentials and are deliberately not committed.

### Adaptive defaults

Do not hard-code the noisy workstation knee as one match per worker. Defaults are `SIM_WORKERS=min(7, availableParallelism()-1)`, `MATCHES_PER_WORKER=8` as a generous safety ceiling, `MAIN_MAX_MATCHES=8`, `ADMISSION_LAG_MS=25` (p95 over 10 s), `SIM_WORKER_CPU_PERCENT=75`, and `MAX_QUEUE=500`. With seven workers, the default aggregate `MAX_MATCHES` safety ceiling is 64, including the reserved featured slot. **64 is not a claim of sustainable capacity.** Actual admission also requires main-loop headroom and an eligible worker's ten-second p95 lateness/CPU headroom. `MAX_MATCHES` can independently impose a lower operator ceiling.

Railway's production CPU, memory and real network load must determine its deployment cap. After deploying, run this bounded, opt-in ramp from a separate machine:

```sh
pnpm --filter @agent-command/loadtest start -- \
  --target https://agentcommand.gg \
  --levels 1,2,4,8,16,24,32,40,48,55,64 \
  --dwell 30 \
  --max-wall 600 \
  --max-matches 64 \
  --lag-budget-ms 25
```

It uses the public lobby and Colyseus join paths, creates at most one new match every two seconds, samples capacity every second, and stops at the first mature rolling-worker-p95 or corrected main-loop-p99 lateness breach, queued lobby admission, `409 capacity`, HTTP 429, or wall-time ceiling. A cold worker cannot trip the lateness stop or certify a level: by the end of the dwell every active worker must expose at least 100 mature samples. The maximum remains bounded at 64 creations and 600 seconds plus approximately two seconds of cleanup. It closes viewers and then leaves every lobby it created, which ends that lobby's game; an ambiguous create or failed leave is reported as a possible orphan that otherwise runs to `MAX_MATCH_MINUTES`. The normal lobby-creation limit, `MATCHES_PER_IP` per `MATCH_RATE_WINDOW_S` (30 per 10 minutes), stops the run before level 32; an operator must explicitly raise `MATCHES_PER_IP` for a measurement window if probing higher, then restore it. Local development (`pnpm dev`) defaults it to 1000, so smoke scripts and the developer sharing one IP don't lock each other out.

The operator's first production ramp, with `MATCHES_PER_IP=100` temporarily configured, held levels 1 and 2 stable but stopped as level 4 began: worker 1 reported p95 27 ms from only 14 window samples. That startup-only window did not establish steady-state overload. Reported steady-state Railway observations were approximately 0.065 core per match, a raw main-loop p99 around 11 ms (including the former 10 ms baseline), and tick p99 lateness 2 ms. The two-second startup exclusion, 100-sample gate and staggered creation correct that false-trip path.

The operator's subsequent production ramp held **55 live matches within the lag budget** and stopped at the configured **58-match ceiling**, rather than a lateness breach. That steady-state capacity result does not justify queueing an idle server while it initializes; the readiness-bound pressure baselines above address that separate cold-start admission problem.

### Warmed-match CPU profile

`node tools/loadtest/src/profile.ts` profiles twenty seconds only after a seed-41 match has warmed to tick 9,600; it now enters through the lobby with the creator's single observer connection. The figures below were measured before the lobby cutover with one real owner and one spectator connection. Raw output: `/tmp/ac-hug/warmed-match.cpuprofile`; grouped output: `/tmp/ac-hug/cpu-breakdown.json`. Local test-client decoding shares the profiled process, so encoding/network is not a server-only attribution. Of 20.364 seconds sampled, 17.914 seconds were idle and 0.360 seconds were Inspector overhead; the following percentages use the remaining 2.090 seconds:

| Self-time group | Active self-time |
| --- | ---: |
| Presentation, fog/observation and schema validation | 45.8% |
| Encoding/network, including local test clients | 20.7% |
| SDK/runtime/other | 20.2% |
| Garbage collection | 6.7% |
| Simulation | 5.2% |
| Bot decisions | 1.4% |

Top self-time functions: `guard.pass` 284 ms, `schema.checkFields` 221 ms, `schema.check` 200 ms, MessagePack `readMap` 150 ms, presentation `view` 96 ms, and MessagePack `pack` 66 ms. Repeated view/schema validation, presentation and encoding are the strongest targets for subsequent per-match CPU reduction; bot thinking was not the dominant self-time cost in this fixture. Grouping is by source/function category, not a claim that every schema check validates a view.

### Lazy-runtime integration checks

The integrated production build was smoke-tested sequentially in one headless Chromium browser after merging the DOM-only home, lazy `MatchRuntime`, volatile-tow visuals and async combat pools. Play and Watch live each reached `ac:match-first-frame` with the loader cleared. Home and the overloaded queue both had **zero canvas elements**; waiting for admission does not create a GPU context. Watch live retained its three-second-delay label and no synthetic credential fragment. There were no page errors and no profile-creation POSTs in these three flows. `/tmp/ac-hug/integrated-smokes.json` records the assertions.

The first featured snapshot must not replace `World.whenView()`'s pending initial-ready promise: `Game.start()` returns the lazy runtime's boolean success contract, and the first broadcast populates the existing empty world without resetting its readiness waiter. Later featured-match rotations still reset established match state.

Every entry into a running match shares that loader and signal (`MatchRuntime.firstFrame`): seat links, lobby hand-offs (link, code, directory, refresh), observers of any delay and Watch live hold it until the first drawn frame; a world dropped mid-session (featured rotation, series jump, lost snapshot) brings it back. A view that never arrives fails after the broadcast delay plus 30 s with Try again.

## Network: delta views, WebSocket transport and cluster mode

Measured on the shared WSL2 development machine, each set in the orchestrator's timing slot, one fresh `NODE_ENV=production` server (`tools/loadtest/src/server.ts`, seed 1) per run. "Before" is the build without delta-encoded views, with the same loadtest tooling, decoding the old full-view messages. Other workers still loaded the host during parts of the slots (load average 2–20): byte counts are deterministic, CPU figures are single runs or ABAB pairs and carry roughly ±20% run-to-run noise.

### Delta-encoded player views

Each team's views travel as one keyframe on join or watch, then `playerthree/delta` structural deltas; every message is encoded once and shared by the team's readers, and a team's stream is computed only while someone watches it (SPEC "team views").

In process, `node tools/loadtest/src/views.ts --warmup 9600 --ticks 1200 --readers 4` (two teams × four fake readers that only count bytes; warm match, ticks 9,600–10,800; ABAB):

| Per tick | Before (whole views) | After (delta stream) |
| --- | ---: | ---: |
| Bytes per reader | 18,254 | 2,572 (−86%) |
| Bytes per reader per second (20 Hz) | 365 KB/s | 51 KB/s |
| Join keyframe | 29.3 KB | 29.3 KB |
| View CPU with nobody watching (projection) | 1,592 / 1,738 µs | ≈0 (not computed) |
| View CPU with 4 readers per team (projection, codec, fan-out) | 1,980 / 2,046 µs | 2,220 / 2,190 µs (+8–12%) |
| Codec per team (same views) | whole encode 178–313 µs, 17.2 KB | diff 140–219 µs + delta encode 34–74 µs, 2.1 KB |

End to end (`--players --levels 8 --duration 60 --ramp 10 --measurement-only`, two workers, warmup 4,800; each match's creator holds its side's human seats, the view seat counts every byte it receives):

| | Before | After |
| --- | ---: | ---: |
| View bytes/s per player | mean 160 KB/s (p50 163, p95 194) | mean 14.6 KB/s (p50 14.9, p95 19.1), −91% |
| Worker CPU (cores) | 0.512 | 0.514 |
| Keyframes / gaps per player | — | 1 / 0 |

All-bot matches watched only by observers no longer project team views at all: eight benchmark matches with one observer each (four workers, warmup 4,800) used 1.54 → 1.03 worker cores (−33%), 179% → 116% process CPU. The extra per-tick diff roughly equals the whole-view encode it replaces; the wire carries 7–11× fewer bytes, and the main process pipes that much less from the workers.

### uWebSockets.js transport (evaluated, not adopted)

The main process cannot use `@colyseus/uwebsockets-transport`: it cannot attach to the node HTTP server, its Express shim buffers responses (SSE, MCP streaming), and uWS cannot hand a parsed upgrade to the raw TCP pipe that routes worker rooms. Simulation workers can, as a loopback WebSocket-only sidecar (the `net-speed-uws` experiment: uWebSockets.js `v20.70.0`, the newest tag with a Node 26 binary that loads; `v20.71.0`'s ESM wrapper is broken; it needs glibc ≥ 2.38, so `node:26-trixie-slim`).

| Old full views, `SIM_WORKERS` as noted | ws (default) | uWS in workers |
| --- | ---: | ---: |
| 8 matches, 120 observer sockets (4 workers): worker cores | 1.39 | 1.23 (−11%) |
| … process cores, whole run | 1.96 | 1.86 (−5%) |
| … join p50 / p95 | 4.8 / 15.9 ms | 5.7 / 22.8 ms |
| 8 players at ~150 KB/s each (2 workers): worker cores | 0.48 | 0.50 (+5%) |
| … process cores, whole run | 0.71 | 0.73 |

Kept `ws`: the gain is limited to many-socket observer fan-out and is small next to the delta streams' byte reduction, while uWS brings a process-wide abort if a worker thread is torn down with live uWS handles (uWS #925; a hung worker can then no longer be terminated safely), message drops past its backpressure limit (closed instead), a GitHub-pinned native dependency with a broken latest tag, an Express shim dependency to keep worker threads alive, and a base-image change.

### Cluster mode (`REDIS_URL`)

Old full views, `--players --levels 8 --duration 60 --ramp 10 --measurement-only`, warmup 2,400, Redis 7.4 on loopback. The two-node run enters through the non-primary node, so every lobby request is forwarded and each socket either stays local or is proxied once:

| | Single process | Cluster, 1 node | Cluster, 2 nodes via secondary |
| --- | ---: | ---: | ---: |
| Workers | 2 | 2 | 1 + 1 |
| Process cores, all nodes, whole run | 0.70 | 0.83 | 0.91 |
| Worker cores | 0.45 | 0.55 | 0.61 |
| Main-process cores (process − worker) | 0.25 | 0.28 | 0.30 (A + B) |
| Lobby create p50 | 2.7 ms | 7.1 ms | 15.1 ms |
| Match join p50 | 27 ms | 59 ms | 92 ms |
| Redis CPU | — | 0.001 | 0.001 |
| View bytes/s per player | 147 KB/s | 147 KB/s | 151 KB/s |

Workers never touch Redis, so their spread is run-to-run noise; the main-process cost of the presence/driver, heartbeats and room index is a few hundredths of a core at this load, and a forwarded hop adds about 10–30 ms per request. Ticket latency in these runs is dominated by eight concurrent 2,400-tick warmups queuing worker RPCs, not by Redis (a warmup-free probe showed 4 ms tickets with and without Redis). `test/cluster.test.ts` (with `AC_TEST_REDIS_URL`) proves two processes sharing one Redis: a lobby created on node A is joined, attached, started, ticketed and played entirely through node B; the next worker match is placed on the other node and reached from both edges; a live primary re-takes a lease Redis lost without its peer racing it; and a draining primary hands the lease on at once.

## Horizontal scaling: N replicas behind a non-sticky balancer

Railway spreads public HTTP and WebSocket traffic randomly over a service's replicas with no affinity; replicas share their variables, and each has its own address on the private network ([scaling](https://docs.railway.com/deployments/scaling), [private networking](https://docs.railway.com/networking/private-networking/how-it-works); each replica also gets `RAILWAY_REPLICA_ID`). The derived `CLUSTER_ADDRESS` is the replica's own private IPv6 ULA (`http://[fd12:…]:3568`), so no per-replica variable is needed. A deploy replaces every replica at once: the new deployment's replicas start, the old ones get `SIGTERM` after the overlap and drain.

### Gap analysis: surface → before → after

| Surface | Before (cluster mode, N replicas) | After |
|---|---|---|
| Web/static, `/healthz`, benchmark pages | Works (local) | Works (local) |
| Lobby HTTP, directory, pregame rooms | Forwarded to the primary; **broken on a primary change** (lobbies, visitors, grants lost; clients 404) | Forwarded; lease-fenced Redis checkpoints restored by the successor; sockets close with `LOBBY_MOVED_CLOSE` and rejoin |
| Matchmaking `joinById`, match rooms | Worker rooms forwarded by room index; main-process rooms only via "the primary" (**broken after a handover**) | Every lobby match served and indexed by room id on its host, worker or main-process |
| Seat-ticket `/mcp`, `/playerthree/player` | Routed by the placing node's in-memory token map (**lost with the primary**) | Redis token index written by the hosting node |
| MCP (commander/OAuth bearer, stateless) and OAuth/sign-in handshakes | Forwarded; **the promoted node served a snapshot loaded at its boot** (unknown tokens 401, stale rosters, whole-document upserts overwrote newer data) | Coordinator built from Postgres when the lease is taken; owner-document writes fenced by the lease; handshakes in flight at a primary change restart |
| Profiles, rosters, ranked pages `/leaderboard`, `/commanders/*`, sitemap | Profiles boot-cached on every node; ranked pages **served locally from a stale ladder** | Coordinator-only, forwarded |
| Watch live SSE | Forwarded; **old viewers silent forever** after a handover | Forwarded; retiring closes every viewer, browsers reconnect to the successor |
| Arena/benchmark series, gauntlet, ranked timers, OAuth sweeper | **Ran on every node** (series recovery, prune, matchmaker and sweeper timers against stale state) | Coordinator only; retiring releases series leases for the successor |
| Uploads/downloads (policy packages via MCP or `/api/bots`) | Forwarded | Forwarded (bodies up to 1 MiB replayable across a failover) |
| Per-IP limits (`MATCHES_PER_IP`, featured viewers, joins) and admission | On the primary, global while it lives; reset on change | Same; the admission queue and placement span every node's capacity |
| Deploy rollover | Pregame lobbies destroyed; reconnects after the handover lost their match; agents lost their seat | Lobbies hand over; reconnects re-ticket through the successor; agents in main-process matches still lose their seat (residual) |
| Primary crash | Coordination lost; lobbies of matches on other nodes lost (seat renewals then failed) | Lease taken in ~5.5 s; lobbies restored; surviving matches re-ticket |
| Edge during a failover | 503 at once | Holds coordination requests up to 15 s and replays them to the successor |

### Multi-node rig

`apps/server/scripts/cluster-rig.ts` (and `test/cluster-rig.test.ts` with `AC_TEST_REDIS_URL`): a real Redis 7.4 (`redis-server` built under `~/.local`), a throwaway Postgres 17 (the production store path: the bug class fixed here, a promoted node's stale snapshot overwriting newer records, only exists with a shared durable store), three nodes with one worker each (`taskset -c 2,3`), and a non-sticky round-robin proxy (a fresh node per HTTP request and per WebSocket connection; a dead upstream answers 502 until it leaves rotation 2 s later). Results on the shared WSL2 workstation:

| Scenario | Result |
|---|---|
| (a) Lobby create, join, ready, start with two humans; every request on another node | Same match, listed in the directory; 18 requests over 3 nodes; create 35 ms, join 7 ms, connect 16 ms, ticket 13 ms, both humans in the running match 343 ms |
| (b) MCP agent: OAuth DCR/PKCE/consent/token, `policy_deploy`, lobby seat, `game_ready`/`game_wait`, observe and act | Policy v1 deployed and running (7 calls), match ticks 2 → 53, 5 intents acknowledged; 17 MCP posts over 3 nodes; tool p50 10 ms |
| (c) Watch live through each node and the balancer | 4/4 streams 200 with a frame (warm relay: 4–9 ms) |
| (d) `kill -9` the primary mid-match | New primary 5.5 s, directory listing the surviving lobby 6.3 s; 4 matches on surviving nodes, **0 lost**; 5 reconnects p50 104 ms / max 203 ms; pregame lobby back to `waiting`; 2 matches on the killed node lost with it |
| (e) Rolling restart of every node under load (new node up, then the old one out of rotation and `SIGTERM`; a match every 2 s throughout) | 3 nodes replaced, each exited 0 after finishing its matches; 10 matches started, **10 results, 0 interrupted**, 0 creation errors (lobby create p50 15 ms); 2 primary handovers, successor's lease 60 ms after `SIGTERM`; a pregame lobby created before the rollout rejoined twice by itself and was still `waiting` after it. (The first run hit 409 `capacity`: the lobby cap was one node's `MAX_MATCHES` for the whole cluster; it is now per live node.) |
| (f) Load run (`tools/loadtest --players --levels 3 --duration 30 --ramp 6 --measurement-only`) through the balancer | 3 matches created, 0 failed; admission p50 724 ms (lobby, queue, allocation, auto-start), join p50 144 ms, 3 players, 0 view gaps, ~9 KB/s per player. Verdict `observed_tick_rate_below_budget`: three nodes, the generator and the shared workstation's other agents on two cores; not a capacity claim |
| (g) Limits across nodes | `MATCHES_PER_IP=6`: 6 × 200 then 429 for one address spread over 3 nodes; four-army matches one per node (worker units 3.4/4, 2.4/4, 2.4/4), the next queued at position 1, no worker overbooked; `FEATURED_VIEWERS_PER_IP=2`: 200, 200, 429 |

### Railway change plan (not applied)

1. Deploy this release at one replica first (it changes the coordinator lifecycle) and run the post-deploy checks below.
2. `serviceInstanceUpdate` input `{"numReplicas": 2}` (then 3 once two replicas have run a day). Keep `healthcheckPath: "/healthz"`, `healthcheckTimeout: 120`, `overlapSeconds: 30`, `drainingSeconds: 1260`, `restartPolicyType: "ON_FAILURE"` (a demoted node exits 1 to be replaced), `sleepApplication: false`. Variables unchanged: `REDIS_URL`, `CLUSTER_PORT=3568`, `CLUSTER_SECRET`; **leave `CLUSTER_ADDRESS` unset** (each replica derives its private IPv6). Every replica gets the 8 vCPU / 8 GB plan limits: `SIM_WORKERS` default 7 per replica.
3. Redis: the template instance is ample (observed 1.6 MiB used; lobby checkpoints are a few KB each with TTLs). Set `maxmemory 256mb` with `noeviction` (eviction could drop the lease or a checkpoint) and keep AOF/RDB persistence on so a Redis restart keeps lobbies; Redis loss is survivable (the live primary re-takes its lease; lobbies created since the last save are lost).
4. Postgres: two replicas double the SDK pools (10 connections each, `max_connections=100`): fine up to ~8 replicas.
5. Verify after the switch: `railway logs` shows one `cluster: node … at http://[fd12:…]:3568 (replica …)` per replica and exactly one `coordinator serving`; `GET /api/capacity` lists every replica's workers; create a lobby and join it from a second browser (Watch live, OAuth sign-in, an agent `game_briefing`); then redeploy once and check that a pregame lobby survives (its page reconnects by itself) and a running match re-tickets.
6. Rollback: `{"numReplicas": 1}` (no redeploy; removed replicas drain). The cluster code is the same at one replica.

### Residual risks

- A crashed replica's own matches are lost (no live simulation checkpoint); Railway restarts the replica.
- An agent seated in a main-process match when the primary changes (deploy or crash) loses that seat; the match continues and its commander records it as interrupted. OAuth consent, GitHub sign-in handshakes and MCP consent state in flight at a primary change restart.
- Coordinator rate-limit windows and the admission queue restart with a new primary; a queued lobby returns to waiting.
- Observer/spectator tickets minted before a primary change stay valid until their own expiry (the successor cannot revoke what it never saw); seat tickets are replaced by the next mint.
- The lease fences Redis checkpoints atomically, but Postgres writes are fenced at issue time: a write issued in the last second before a stalled primary's lease lapses can still land after its successor loaded. P3 has no store-level fencing token.
- A series interrupted by a primary *crash* resumes only at the next coordinator start after its lease lapses (a graceful handover releases its leases at once).
- Every coordination request costs one internal hop (10–30 ms measured earlier) from N−1 of N edges; the coordinator's main thread (lobbies, MCP, OAuth, featured fan-out) does not scale with replicas.

## Railway configuration to apply

The capacity work above changed no Railway setting. The network work added a **Redis** service (Railway's Redis template, private networking) to the production environment and set `REDIS_URL=${{Redis.REDIS_URL}}`, `CLUSTER_PORT=3568` and a generated `CLUSTER_SECRET` on the app service with deploys skipped: cluster mode starts with the next deployment of a build that has it, still at one replica. A Node event loop uses one CPU core; the 8-vCPU replica only helps when independent match workers use the other cores. Leave one core for HTTP, WebSockets, MCP and garbage collection, and do not configure more than seven simulation workers on that plan. Account for CPU throttling and memory independently; local-machine throughput is not a Railway benchmark.

In the service's **Settings → Edge**:

- **Enable CDN Caching:** on. If the setting is not visible, enable its Priority Boarding feature first.
- **HTML Caching:** **Never**. `index.html` also sends `Cache-Control: no-cache`; do not force-cache it.
- **Default TTL:** **2 hours**. This is only a fallback; hashed assets specify `public, max-age=31536000, immutable` at the origin.
- **Honor SWR Directives:** on (the default).
- **Purge Cache on Deploy:** **Purge HTML on each successful deploy**. Do not purge immutable assets on every deployment.
- Keep normal WebSocket passthrough and SSE streaming. Do not add a blanket browser challenge: it would break MCP/agent clients and WebSocket admission.

Under **Edge Rules → Edit as JSON**, add the following nonterminal bypass rule to the existing ruleset, preserving unrelated rules and using an unused priority. No cache override is needed for `/assets/*`: respect the origin's immutable header rather than replacing its one-year TTL with the edge-rule maximum of 30 days.

```json
{
  "version": 1,
  "rules": [
    {
      "description": "Never cache control, admission, auth or streaming traffic",
      "priority": 10,
      "enabled": true,
      "if": {
        "or": [
          { "attr": "http.path", "op": "matches", "value": "/api*" },
          { "attr": "http.path", "op": "matches", "value": "/matchmake*" },
          { "attr": "http.path", "op": "matches", "value": "/mcp*" },
          { "attr": "http.path", "op": "matches", "value": "/playerthree*" },
          { "attr": "http.path", "op": "matches", "value": "/oauth*" },
          { "attr": "http.path", "op": "matches", "value": "/.well-known/oauth*" },
          { "attr": "http.path", "op": "eq", "value": "/healthz" },
          { "attr": "http.path", "op": "matches", "value": "/dev*" },
          { "attr": "http.header", "key": "upgrade", "op": "eq", "value": "websocket" }
        ]
      },
      "then": { "action": "cache_override", "params": { "bypass": true } }
    }
  ]
}
```

API/MCP/auth responses send `no-store` independently of the edge rule. Railway does not cache authenticated requests, WebSockets or `text/event-stream`; the explicit bypass is defense against future broad cache rules. It applies to all domains on the service, including the Railway hostname and `agentcommand.gg` when attached. Edge rules require a plan allowance; if unavailable, origin `no-store` plus **HTML Caching: Never** still prevents dynamic response caching.

After applying settings, fetch the same hashed asset twice from production: the second should have `x-cache: HIT` and a rising `age`, while API responses must remain dynamic. Use `/.railway/cdn-trace?json` to identify the edge point of presence. A local load test proves origin headers, not an edge cache hit; no production CDN-hit claim is implied.

Sources: [Railway CDN](https://docs.railway.com/networking/cdn), [Railway Edge Rules](https://docs.railway.com/networking/edge-rules).

## Launch-burst assessment

This assessment inspected one release of both repositories read-only; it did not stress production or change Railway configuration. Earlier measurements above remain historical evidence, not a certification of the current gameplay/build or a 64-match guarantee.

**Planning assumptions, not measurements:** a burst of 10,000 landing visits over ten minutes (16.7 navigations/s), 10% browsing the directory, 5% watching the featured stream for two minutes (about 100 concurrent viewers), and 1% creating a game lasting ten minutes (about 100 live matches if none queue). An uneven burst can be much higher. Browsing/assets, persistent readers, simulation slots and agent/series work must have separate budgets: 10,000 visitors do not imply 10,000 simulations.

| Workload | Current protection and readiness boundary |
| --- | --- |
| Landing/assets | Static streams use socket backpressure; hashed assets are immutable, HTML revalidates, and build-time Brotli/gzip avoid request-time compression. Live HTML HEAD returned Brotli, `no-cache`, 1,921 bytes. Railway CDN was available but disabled at the initial assessment; the follow-up below enabled it and verified cache HITs with dynamic-route bypasses. No new origin throughput ceiling was measured. |
| Directory/lobbies | Directory room cap 256 sockets; eight directory grants/IP, 1,024 total grant/visitor admission bounds, 16 members/lobby, configured lobby and match creation limits. Rejected anonymous requests now roll back temporary visitor slots; simultaneous directory requests reserve only after shared room creation completes. Client IP belongs to the grant, not an unbounded lifetime owner map. A thousand directory readers exceed the current 256-socket room cap: do not advertise that workload as supported. |
| Featured readers | One simulation and shared encoded team streams; new 500-total/eight-IP admission and existing five-second slow-reader eviction bound fan-out. About 100 concurrent readers is a planning scenario only. Egress and CPU under the current frame format need isolated measurement before raising the cap. |
| Player/bot matches | Seven worker threads, eight duel units each, plus main-thread cap eight; worker CPU/p95 lag and bounded FIFO gate new work. Larger matches consume weighted units. Bot-only games are not abandoned merely because readers leave; wall-clock caps still apply. `MAX_MATCHES=64` includes the showcase and is only a configured ceiling; the illustrative 100-live-game scenario must queue/refuse. |
| Live agents/policies | Canonical main thread, not the worker pool. Main cap eight and rolling lag gate help preserve HTTP/MCP responsiveness; per-IP profile/OAuth/stream limits do not prove arbitrary inference or WASM workloads safe at that cap. Agent compute is external; the host still pays for protocol, policy execution, views and persistence. No current mixed-workload capacity measurement. |
| Series and durable data | Two active series per owner, two concurrent games per series, 200 games, 1 MiB result chunks, 256 MiB/attempt, 2 GiB/series, 4 GiB/owner, 30-day retention. These are **owner quotas, not a deployment-wide storage budget**. The database volume is small enough that even two owners can exceed its capacity. Public benchmark uptake needs an explicit aggregate retention/capacity decision before launch, not merely a larger simulation cap. |

**Observed production:** a single app replica under light use; this is idle/light-use evidence, not launch-load evidence. Platform and process memory snapshots use different sampling windows and must not be compared as a leak measurement.

The SDK uses a ten-connection PostgreSQL pool; worker hosts do not each open a database pool. Stores serialize writes, but source-level pool sizing does not establish a bounded wait queue or SQL latency under failure. Set explicit database timeout and Redis memory policy before relying on them under load.

**Deploy survivability:** the application drain cap (1,200 seconds by default) must fit inside the platform's draining deadline. Redis coordinates placement/leases; it does not replicate the in-memory lobby, tickets or live simulation. Connected matches can finish while draining, but a primary change/restart can lose reconnection ownership. Avoid deploys during the launch peak; adding replicas alone does not fix recovery or increase canonical-host/featured fan-out capacity.

**CDN:** hashed assets are cached at the edge; HTML, health, featured metadata and featured SSE bypass the cache, as do Authorization-bearing requests.

**Remaining launch gates:** decide an aggregate series storage budget, then schedule a bounded isolated production-equivalent mixed test on a quiet host. Measure late-game worker lag/CPU/RSS, main-thread response times, socket counts/slow readers, featured bytes/s and database latency together. The directory's 256-client limit and primary-change reconnect limitation still apply. The historical 55-match ramp is useful prior evidence, but neither it nor this light-use inspection establishes the current mixed-traffic ceiling. No paid-resource increase is justified solely by the configured 64-slot maximum.
