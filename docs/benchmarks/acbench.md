# ACBench v1

Policy-authoring benchmark for Agent Command, modelled on
[StarSkirmish Bench v0.2](https://starskirmish.com/bench/v0-2/). A model, as a persistent lobby commander, writes one
policy for each of the four planes (surface, depths, sky, orbit) against a fixed wall clock, starting from an
economy-only skeleton per plane; the frozen policies then climb a fixed ladder of built-in bots. The headline is the
**score**, the ladder win rate. Live model-vs-model play is out of scope.

This page describes suite version 2, released as ACBench v0.2 (`ACBENCH.version`). Against v0.1 (suite version 1) it
states the evaluation rules in the authoring brief, gives each side of a pairing its own seed so all 30 duels are
distinct games, gives every model the same system prompt ([System prompt](#system-prompt)) and runs each model 3 times
by default; every version ships reference bars for the built-in tiers ([Release a version](#release-a-version)).

## Run a campaign

```sh
node bench/acbench.ts --models deepseek-v4.1-flash,glm-5.3,kimi-k3.1-pro \
  --minutes 45 --max-usd-per-run 40 --max-usd-total 120
```

| Flag | Default | |
|---|---|---|
| `--models` | required | keys of `bench/frontier-models.ts` (pinned OpenRouter hosts and ceiling prices) |
| `--runs` | 3 | independent authoring runs per model, one after another (a model can spend up to runs × the per-run cap) |
| `--minutes` | 45 | authoring wall clock per run; no early exit |
| `--max-usd-per-run` | 40 | hard per-run cap (safety stop, not a budget to spend: set so that no run is cut off) |
| `--max-usd-total` | required | cap on the key's billed usage over the whole campaign |
| `--harness` | `opencode` | `opencode` (OpenCode, headless) or `runner` (PlayerThree's own loop, the baseline) |
| `--start` | `skeleton` | what every run starts from: `skeleton` (the economy-only skeletons) or `bots` (the built-in bot starters, the pilot's start) |
| `--maps` | `crossfire,twin_fords,crown` | classic duel maps |
| `--seeds` | 1 | scoring seed pairs per map, one seed per map side (30 full-length duels: about 32 min on two cores) |
| `--opponents` | `novice,standard,veteran,elite,champion` | the ladder's rungs; each plays both duel sides |
| `--campaign` | derived from the settings | directory name under `--data`; re-running the same command resumes it |
| `--data` | `.data/bench/acbench-v1` | results root |
| `--cores` | `2,3` | the cores (taskset) model runs and their scoring take |
| `--dev-data` / `--no-import` | `.data` | the local dev server's `DATA_DIR` the publications are imported into |

The OpenRouter key comes from `~/.config/openrouter.key` (`--key-file`), into child processes' environments only.
Models run one after another, on `--cores` at `nice 10`; then the start baseline is scored once on the same cores. Two
drivers may share one campaign directory with other models on other cores. The key's billed usage then counts both:
each driver's `--max-usd-total` is checked against the combined usage, and each run's billed-usage stop sees the other
driver's spend during its window, so pair a costly model only with a cheap one. Let only one driver reach the baseline
at a time, or score it first (`bench/acbench-rescore.ts --campaign <dir> --baseline`).

## The ladder

Each rung is a built-in bot tier at a public income handicap (match rule `handicap.income.<army>`, DESIGN §2.1:
every income credit of the rung's army is multiplied by it). Rungs live in `ACBENCH.ladder`
(`bench/acbench-settings.ts`).

| Rung | Bot | Income |
|---|---|---|
| novice | novice | ×1 |
| standard | standard | ×1 |
| veteran | veteran | ×1 |
| elite | veteran | ×1.15 |
| champion | veteran | ×1.30 |

Elite and Champion are StarCraft-style "cheater" rungs: headroom above the strongest public bot, with no hidden code.
The handicap is in the match rules both armies receive, so a policy can see it.

**Copying.** The bots' code is public (the strategy skill serves it, a starter is a tunable copy of a bot and either
deploys by reference), so a model can deploy the veteran bot as its policy. Against veteran that copy plays a mirror;
against Elite and Champion it plays a richer mirror of itself and should lose. Runs start from the skeletons, which
score about 0, so whatever a model's policies score, bots adopted included, is its own doing.

## Protocol

- **Harness.** OpenCode (`opencode run`, version recorded from the binary) in a fresh isolated home and an empty
  working directory, connected to the commander through PlayerThree's `playerthree-mcp` stdio bridge. Bash, web
  fetch, web search, files outside the working directory and live-play tools are denied. OpenCode never holds the key:
  its only provider is a loopback metering proxy that pins each model's OpenRouter hosts, caps a reply at 32768
  output tokens, charges every turn its real cost and withholds a reply that crosses the cap. A tool-argument fidelity probe runs
  on the pinned route before any authoring. Each model speaks its family's own API, through OpenCode's adapter for it
  ([Wires](#wires)), so the reasoning it returns goes back to it with its tool results. Every request asks for
  reasoning effort `high` (`ACBENCH.reasoning`, PlayerThree's `authoring.reasoning`, in the wire's own field): left to
  each route, omp's auth-gateway ran Claude at effort low, OpenRouter at Anthropic's default and Codex at its own. The
  proxy also replaces OpenCode's system prompt with the benchmark's own ([System prompt](#system-prompt)) and keeps
  OpenCode's prompt-cache marks where OpenRouter reads them, so a continued session stays cached.
- **Before the clock,** each plane's start policy is deployed by reference with default knobs, so a policy always
  exists: by default the economy-only skeleton (`strategy/policies/skeleton/<plane>.js`: Depths keeps a digging crew
  mining, Orbit fills its five home solar berths and keeps two tugs mining, Surface and Sky give no orders; no army,
  attacks or research), with `--start bots` the built-in bot starter (`strategy/policies/<plane>.js`). The strategy
  skill documents both and serves the built-in bots' source.
- **Authoring** lasts the full wall clock. When OpenCode ends a run, the harness continues the same session with the
  status (active version per plane, whether the harness pre-deployed it, last practice result) and never the time
  left: the first message states the deadline once, and a model that paces itself to a stated budget wraps up early.
  Practice is limited to seeds 17 and 29 and runs up to the evaluation's 30-minute cap (36,000 ticks), so a practice
  match can show how a scored one ends. There is no submit tool: the policies active at the deadline are frozen. The game server's
  instructions for this lobby are the authoring ones: what each tool does, that the core `game_briefing` indexes the
  game's docs and skills, that a policy is a sandboxed JavaScript program written or forked and deployed with
  `policy_deploy`, and where writing one is documented; they set no reading order. The brief ends with the evaluation
  rules, generated from the suite's own series (`evaluationBrief` in `bench/acbench-ladder.ts`, PlayerThree's
  `authoring.brief`): the number of duels, both sides, the maps, every rung with its handicap (Elite and Champion
  evaluation-only), the elimination rule (the default: Surface loss, no crowns), the time cap and its tiebreak, the
  score, and that the default starters are published beside every score as a reference. Practising under other
  rules is the model's own choice.
- **Cost cap.** Per run, authoring stops when the turns' charged cost (router-reported, else cache-aware estimate) or
  the key's billed delta reaches `--max-usd-per-run`. Across the campaign, no run starts unless its cap fits in what
  `--max-usd-total` leaves after the key's billed usage.
- **Scoring.** The four frozen policies play every rung from both sides on every map × seed pair (accelerated, to the
  30 game-minute cap), the rung's army at its income handicap. The candidate plays a pair's first seed from the first
  side (nw) and its second from the other (`ladderSeed`, `ACBENCH.scoringSeeds`): the sim is deterministic and an
  exact mirror, so on one seed a pairing's two sides replay one game, mirrored, and half the duels would add nothing.
  Each trial counts as the game decides it: a match
  still running at the cap goes to the side that lost fewer crowns, then to more total Spire HP, then to more
  contested-point score, and is a draw only when all three tie (DESIGN §2, time cap). Score = win rate over the whole
  ladder, draws half. A run whose authoring failed scores 0.
- **Baseline.** The four start policies exactly as `policy_deploy {from}` freezes them (default knobs, no edits)
  play the same ladder, maps and seeds as one more candidate, without a model and at zero token cost. It is scored
  once per campaign directory (`<campaign>/baseline/`) after the model campaigns.
- **Headline.** Per run, the score; per model, its mean and spread over runs. `improvement = score − baselineScore`
  sits beside it (with the skeleton start, about the score itself). The per-rung win rates are the detail view.

## System prompt

Every model gets the same system prompt: [`bench/acbench-system-prompt.txt`](../../bench/acbench-system-prompt.txt),
verbatim, as PlayerThree's `authoring.systemPrompt`. OpenCode has no setting that replaces its built-in prompt (it
picks one per model family), so the metering proxy drops every system message OpenCode sends and puts this one first;
the conversation and the tool list pass through unchanged, and the brief (roles, time, evaluation rules) stays the
first user message. With the `runner` harness it replaces the runner's system prompt the same way. Harness prompts
move scores, and a per-family prompt would give models different instructions. The text states the task (write the
strongest policies before the deadline), what a policy is and how the frozen policies are scored, where writing one
is documented, that the built-in starters deployed by reference are the baseline rather than the model's work, and
how a turn ends (a message without a tool call stops work until the next continuation, with four kinds of early stop
named, as Anthropic recommends for unattended agents). It gives no game strategy and no persona. The suite publishes
the text and its SHA-256 (`suite.authoring.systemPrompt`, equal to `sha256sum bench/acbench-system-prompt.txt`), and
both the suite id and the profile digest change with it.

## Wires

OpenCode's own provider for every model was once Chat Completions (`@ai-sdk/openai-compatible`). That API has no field
for signed or encrypted reasoning: a capture of an Opus run showed adaptive thinking at effort `high` on every
request, yet no thinking block in any replayed turn, and the thinking summary OpenCode resent came back to Claude as
plain assistant text. Anthropic documents that dropping thinking blocks loses their reasoning even without an error.
Each model now has its family's own wire (`wireOf` in `bench/frontier-models.ts`, PlayerThree's `BenchModel.wire`):

| Models | Wire | OpenCode adapter | OpenRouter API | Reasoning replayed |
|---|---|---|---|---|
| Claude | `messages` | `@ai-sdk/anthropic` | `/api/v1/messages` | signed `thinking` blocks |
| GPT | `responses` | `@ai-sdk/openai` | `/api/v1/responses` (`store: false`) | encrypted `reasoning` items |
| Gemini, DeepSeek, Kimi, GLM, Qwen | `openrouter-chat` | `@openrouter/ai-sdk-provider` | `/api/v1/chat/completions` | `reasoning_details` |

The proxy passes the reasoning through untouched and records per turn its blocks, visible characters and the
reasoning tokens the route reports. The effort goes in each wire's field (`output_config.effort` with adaptive
thinking, `reasoning.effort`); the system prompt, effort and reply cap are the same for every model. The wire is in the
profile label and the configuration digest.

## Context and compaction

OpenCode summarizes a session (compaction) once a turn's context reaches its configured window less the reply cap,
then continues from the summary. Every model gets the same window, 250,000 tokens (`ACBENCH.contextTokens`,
PlayerThree's `authoring.contextTokens`, about where StarSkirmish compacts every harness), capped at a model's own
window (`contextTokens` in `bench/frontier-models.ts`, from OpenRouter's catalogue for the pinned hosts; every v0.2
model's is 1,000,000–1,050,000, so the cap never binds). A model is then summarized as often as its own work fills
the window, never more often because its window is smaller. After each compaction OpenCode adds a user message of its
own, "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.": the
metering proxy replaces it with the harness's continuation (`[harness] <status> Authoring continues until the
deadline; the policies active then are evaluated.`), so no model is told it may stop. The suite publishes the window
(`suite.authoring.contextTokens`), and both the suite id and the profile digest change with it.

## Trial encoding

A publication's trials (`runs[].trials[]`) carry `trialId` (`trial-N`, blocks × permutations in suite order),
`blockId` (the scenario, `<map>-seed-<seed>`, the seed its pair's first; trials with the candidate on the second side
played the pair's second seed, as the results' `schedule` records), `stratumId` (the map) and `permutationId`, which
names the trial's opponent and side as `<opponent>-<side>`: the id of the reference the candidate played (one of
`suite.references`) and the map side (slot id: `nw` or `se` in a duel) the candidate held, e.g. `veteran-se`. A reader
splits at the last `-`. The ladder is one way to choose references (its rungs, weakest first); a suite whose
references are other systems' frozen policies (reference id a URL-safe system or run id, digest its artifact digest)
names trials the same way. Campaigns before this encoding named permutations `orientation-N`.

## Re-score

```sh
node bench/acbench-rescore.ts --campaign .data/bench/acbench-v1/<campaign> [--opponents novice,…,champion]
```

Replays every run's frozen policies of a campaign (its maps and seeds) against the current ladder (default: every
rung), with the current game and bots, plus the campaign's start baseline on the same ladder, and writes a new summary and
one publication per model. No model calls. Output goes to `<campaign>/rescore-<key>/` (`rescore.json`, `baseline/`,
`<model>/<run>/` results, `<model>/publication.json`, `summary.json`); the key names the ladder, maps, seeds and both
build digests, so a changed build gets its own directory, and re-running resumes it (a scoring counts as done once
its `scored.json` exists; an interrupted series is scored again). A publication is the campaign's suite with the
re-score's ladder, builds and trial encoding under a new suite id, and the campaign's authored runs (artifacts, cost,
authoring times) with the re-scored trials; publish them with `bench/publish.ts` like a campaign's.
Matches run at the suite's concurrency on whatever cores the caller pins.
`--campaign <dir> --baseline` scores only the campaign's own baseline and rewrites its `summary.json` (what
`bench/acbench.ts` runs).

## Time and cost

A run is the wall clock plus about a minute of setup and about 32 minutes of scoring (30 full-length duels, two at a
time); the baseline adds one more scoring per campaign. Models and their runs go in turn, so 3 models × 3 runs × 45
minutes take about 12 hours on one machine.

Each turn is charged its actual cost: OpenRouter's `usage.cost` on the reply, else the generation's billed cost
looked up by id, else a cache-aware estimate at the pinned list prices (cached input at the catalogue's cache-read
rate). The key's billed usage is the backstop. OpenCode resends its whole context each turn, so most input is cache
reads: in the 5-minute DeepSeek V4.1 Flash smokes the list-price estimate without cache discounts was about 6–9× the
reported cost, which is why the cap charges real cost. A run sends roughly 10–15M input tokens over 45 minutes.

## Cloud runner

`bench/runner/` runs a campaign on Railway: `context.sh OUT` assembles the image context from committed trees (this
repository and the linked PlayerThree checkout, OpenCode 1.19.5), `Dockerfile` builds it (`bots:build` included), and
`orchestrate.ts` (the start command, job in `RUNNER_JOB`) refuses to start unless the build's game and runner digests
equal the frozen build's, then runs one `bench/acbench.ts` driver per model at a fixed concurrency (the baseline's
scoring holds a slot). A job's `runs`, `minutes` and `maxUsdPerRun` default to the suite's (3, 45, 40); each driver
runs its model's runs in turn. Several runs on one key make the key's usage meaningless per run, so
`per-run-billing.mjs` withholds the key-usage read from the campaign processes: each run is capped by its own metering
proxy at the router-reported cost of its turns, and the orchestrator holds the campaign total (no launch unless the
key's billed usage since the campaign baseline plus one run's cap fits; every driver stopped at the total minus a
margin). Size `maxUsdTotal` for every model's runs (up to runs × `maxUsdPerRun` each), or the stop interrupts the last
ones. A Hobby service has 8 vCPU and 8 GB, three runs at once; two services with their own volumes run disjoint models
into the same campaign name and are merged afterwards.

## Release a version

A version (release id `acbench-v0-N`, suite version N) ships its models, its start baseline and its reference bars,
all on one frozen build:

1. **Freeze the build** on a committed tree and record its digests (`node bench/runner/digests.ts`, the job's
   `expect`).
2. **Run the campaign** (cloud runner or `bench/acbench.ts`): every model's runs (3 by default) and the start baseline.
3. **Score the reference bars** on the campaign's own ladder and build:
   `node bench/acbench-reference-bots.ts --campaign <dir> [--release acbench-v0-N]` (default release id from the suite
   version). Each built-in tier's four bot packages play as the candidate, exactly as a model's frozen policies are
   scored (elite and champion are the veteran packages with their income handicap on the candidate's army too), and so
   do the four default starter policies (tier `starters`: `agent-command-strategy/policies/<plane>.js` at default
   knobs, exactly what `policy_deploy {from}` deploys), into `<dir>/reference-bots/<tier>/` (`scored.json` with the
   score and per-opponent wins; re-running skips scored tiers). Once every tier is scored it writes
   `<dir>/reference-bots/references.json` and prints the release's `REFERENCES` entry (every tier and the start
   baseline from `summary.json`, strongest first) for `apps/web/src/benchmarks/model.ts`; paste it there. Six tiers
   are 180 duels, about 3.2 hours on two cores.
4. **Publish** the complete publications with `bench/publish.ts` (`--preview`, review, `--import`) under the release
   id, and curate its story (`apps/web/src/benchmarks/stories.ts`).

## Outputs

`<data>/<campaign>/`:

- `summary.json` (format `acbench.summary`, version 2): chart-ready. `scoring` (the formulas and the ladder),
  `baseline` (the start policies' score, per-rung and per-map win rates and every match), `scoreTable` (per model:
  `improvement` mean and sample sd, then win rate mean, sd, min, max, `baselineScore` and per-rung means),
  `scoreVsCost` and `practiceVsScore` (per run, with improvement), `variance`, then `models` (improvement, score,
  per-rung and per-map spreads) and `runs`. Each run records `score`, `baselineScore`, `improvement`, per-rung and
  per-map win rates, the model id, served hosts, harness and version, reasoning setting, wall time, turns, tokens in
  and out, costs, practice runs (count, opponents, results), the deploy timeline, the frozen policy hashes, its
  transcript and authoring ledger, and every scoring match with its replay. A re-score's summary has the same shape
  plus `rescore` (directory, ladder, maps, seeds, builds).
- `baseline/results.json` (and `scored.json`, `baseline.log`): the start baseline.
- `<model>/campaign.json`, `publication.json`, `authoring/<run>-<attempt>.json` (the ledger), `transcripts/*.jsonl`
  (no secrets), `artifacts/` (frozen policies), `results/<run>/results.json` and `results/<run>/replays/`.
- `driver.json` and `usage-ledger.jsonl`: settings, billed baseline and every key-usage check.

`node bench/acbench-summary.ts --campaign <dir>` rebuilds `summary.json`. Complete publications are imported into the
dev store as release `acbench-v1-<campaign>` (`bench/publish.ts`, `DATA_DIR` only, never `DATABASE_URL`); the
publication scores are PlayerThree's ladder win rates, without the baseline.
