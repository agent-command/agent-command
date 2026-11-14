# ACBench v1

Policy-authoring benchmark for Agent Command, modelled on
[StarSkirmish Bench v0.2](https://starskirmish.com/bench/v0-2/). A model, as a persistent lobby commander, writes one
policy for each of the four planes (surface, depths, sky, orbit) against a fixed wall clock; the frozen policies then
climb a fixed ladder of built-in bots. The headline is **improvement**: the ladder win rate minus that of the four
default starters, untouched. Live model-vs-model play is out of scope.

## Run a campaign

```sh
node bench/acbench.ts --models deepseek-v4.1-flash,glm-5.3,kimi-k3.1-pro \
  --runs 2 --minutes 45 --max-usd-per-run 10 --max-usd-total 30
```

| Flag | Default | |
|---|---|---|
| `--models` | required | keys of `bench/frontier-models.ts` (pinned OpenRouter hosts and ceiling prices) |
| `--runs` | 5 | independent authoring runs per model |
| `--minutes` | 45 | authoring wall clock per run; no early exit |
| `--max-usd-per-run` | 10 | hard per-run cap (safety stop, not a budget to spend) |
| `--max-usd-total` | required | cap on the key's billed usage over the whole campaign |
| `--harness` | `opencode` | `opencode` (OpenCode, headless) or `runner` (PlayerThree's own loop, the baseline) |
| `--maps` | `crossfire,twin_fords,crown` | classic duel maps |
| `--seeds` | 1 | scoring seeds per map (30 full-length duels: about 32 min on two cores) |
| `--opponents` | `novice,standard,veteran,elite,champion` | the ladder's rungs; each plays both duel sides |
| `--campaign` | derived from the settings | directory name under `--data`; re-running the same command resumes it |
| `--data` | `.data/bench/acbench-v1` | results root |
| `--dev-data` / `--no-import` | `.data` | the local dev server's `DATA_DIR` the publications are imported into |

The OpenRouter key comes from `~/.config/openrouter.key` (`--key-file`), into child processes' environments only.
Models run one after another, on cores 2–3 at `nice 10`; then the starters baseline is scored once on the same cores.

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

**Copying.** The bots' code is public (the strategy skill serves it, and a starter is a tunable copy of a bot), so a
model can deploy the veteran bot as its policy. Against veteran that copy plays a mirror; against Elite and
Champion it plays a richer mirror of itself and should lose. Improvement subtracts what the untouched starters
already score, so a copy earns roughly the starters' own result, not the ladder's.

## Protocol

- **Harness.** OpenCode (`opencode run`, version recorded from the binary) in a fresh isolated home and an empty
  working directory, connected to the commander through PlayerThree's `playerthree-mcp` stdio bridge. Bash, web
  fetch, web search, files outside the working directory and live-play tools are denied. OpenCode never holds the key:
  its only provider is a loopback metering proxy that pins each model's OpenRouter hosts, caps a reply at 16384
  output tokens, charges every turn its real cost and withholds a reply that crosses the cap. A tool-argument fidelity probe runs
  on the pinned route before any authoring. Reasoning is the provider default.
- **Before the clock,** each plane's starter (`strategy/policies/<plane>.js`) is deployed by reference with default
  knobs, so a policy always exists.
- **Authoring** lasts the full wall clock. When OpenCode ends a run, the harness continues the same session with the
  status (active version per plane, last practice result). Practice is limited to seeds 17 and 29. There is no submit
  tool: the policies active at the deadline are frozen.
- **Cost cap.** Per run, authoring stops when the turns' charged cost (router-reported, else cache-aware estimate) or
  the key's billed delta reaches `--max-usd-per-run`. Across the campaign, no run starts unless its cap fits in what
  `--max-usd-total` leaves after the key's billed usage.
- **Scoring.** The four frozen policies play every rung from both sides on every map × seed (accelerated,
  30 game-minute cap, which counts as a draw), the rung's army at its income handicap. Score = win rate over the
  whole ladder, draws half. A run whose authoring failed scores 0.
- **Baseline.** The four default starters exactly as `policy_deploy {from}` freezes them (default knobs, no edits)
  play the same ladder, maps and seeds as one more candidate, without a model and at zero token cost. It is scored
  once per campaign directory (`<campaign>/baseline/`) after the model campaigns.
- **Headline.** Per run, `improvement = score − baselineScore`; per model, its mean and spread over runs. The per-rung
  win rates are the detail view.

## Re-score

```sh
node bench/acbench-rescore.ts --campaign .data/bench/acbench-v1/<campaign> [--opponents novice,…,champion]
```

Replays every run's frozen policies of a campaign (its maps and seeds) against the current ladder (default: every
rung), with the current game and bots, plus the starters baseline on the same ladder, and writes a new summary. No
model calls. Output goes to `<campaign>/rescore-<key>/` (`rescore.json`, `baseline/`, `<model>/<run>/` results,
`summary.json`); the key names the ladder, maps, seeds and both build digests, so re-running resumes it and a changed
build gets its own directory. Matches run at the suite's concurrency on whatever cores the caller pins.
`--campaign <dir> --baseline` scores only the campaign's own baseline and rewrites its `summary.json` (what
`bench/acbench.ts` runs).

## Time and cost

A run is the wall clock plus about a minute of setup and about 32 minutes of scoring (30 full-length duels, two at a
time); the baseline adds one more scoring per campaign. Models run in turn, so 3 models × 2 runs × 45 minutes take
about 8 hours.

Each turn is charged its actual cost: OpenRouter's `usage.cost` on the reply, else the generation's billed cost
looked up by id, else a cache-aware estimate at the pinned list prices (cached input at the catalogue's cache-read
rate). The key's billed usage is the backstop. OpenCode resends its whole context each turn, so most input is cache
reads: in the 5-minute DeepSeek V4.1 Flash smokes the list-price estimate without cache discounts was about 6–9× the
reported cost, which is why the cap charges real cost. A run sends roughly 10–15M input tokens over 45 minutes.

## Outputs

`<data>/<campaign>/`:

- `summary.json` (format `acbench.summary`, version 2): chart-ready. `scoring` (the formulas and the ladder),
  `baseline` (the starters' score, per-rung and per-map win rates and every match), `scoreTable` (per model:
  `improvement` mean and sample sd, then win rate mean, sd, min, max, `baselineScore` and per-rung means),
  `scoreVsCost` and `practiceVsScore` (per run, with improvement), `variance`, then `models` (improvement, score,
  per-rung and per-map spreads) and `runs`. Each run records `score`, `baselineScore`, `improvement`, per-rung and
  per-map win rates, the model id, served hosts, harness and version, reasoning setting, wall time, turns, tokens in
  and out, costs, practice runs (count, opponents, results), the deploy timeline, the frozen policy hashes, its
  transcript and authoring ledger, and every scoring match with its replay. A re-score's summary has the same shape
  plus `rescore` (directory, ladder, maps, seeds, builds).
- `baseline/results.json` (and `scored.json`, `baseline.log`): the starters baseline.
- `<model>/campaign.json`, `publication.json`, `authoring/<run>-<attempt>.json` (the ledger), `transcripts/*.jsonl`
  (no secrets), `artifacts/` (frozen policies), `results/<run>/results.json` and `results/<run>/replays/`.
- `driver.json` and `usage-ledger.jsonl`: settings, billed baseline and every key-usage check.

`node bench/acbench-summary.ts --campaign <dir>` rebuilds `summary.json`. Complete publications are imported into the
dev store as release `acbench-v1-<campaign>` (`bench/publish.ts`, `DATA_DIR` only, never `DATABASE_URL`); the
publication scores are PlayerThree's ladder win rates, without the baseline.
