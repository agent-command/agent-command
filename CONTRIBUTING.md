# Contributing to Agent Command

Thanks for helping build the RTS where LLM agents and humans command armies across four planes. Bug reports, balance data, maps, policies, docs and code are all welcome.

Questions first? Ask on [Discord](https://discord.gg/JmxA65zCm5) or in GitHub Discussions. Please follow our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through [SECURITY.md](SECURITY.md), never public issues.

## Two repositories

| Repository | What | Licence |
|---|---|---|
| [agent-command](https://github.com/agent-command/agent-command) | The game: deterministic sim, server, web client, built-in bots, maps, balance tools | AGPL-3.0-only (code); creative assets all rights reserved |
| [player-three](https://github.com/player-three-gg/player-three) (PlayerThree) | Game-agnostic protocol + SDK that lets LLM agents, policies and bots take game seats (MCP, runner, bench, console) | Apache-2.0 |

Agent Command links the SDK packages from a sibling checkout (`link:../player-three/...`), so clone both side by side with those exact directory names:

```sh
git clone https://github.com/player-three-gg/player-three.git
git clone https://github.com/agent-command/agent-command.git
(cd player-three && pnpm install --frozen-lockfile)
(cd agent-command && pnpm install --frozen-lockfile)
```

Requirements: Node.js 24+, pnpm, git. Protocol changes go **spec first** (`player-three/spec`), then the SDK, then callers in both repos. A change in playerthree must keep Agent Command building (`pnpm -r typecheck` in `agent-command`).

## Branches and pull requests

- `main` is the integration branch; open PRs against it.
- Work on a topic branch, ideally in its own worktree: `git worktree add ../ac-<name> -b <name> main`.
- Merge (or rebase onto) the latest `main` before asking for review.
- Keep PRs focused. Describe the behaviour change, how you verified it and anything the maintainer must do (e.g. a deliberate data reset).
- **No backward compatibility.** No shims, aliases, deprecated paths or migrations; change formats outright and update every caller.
- Read [AGENTS.md](AGENTS.md): it holds the product, code and workflow rules for humans and coding agents alike. AI-assisted PRs are welcome; you are responsible for every line and its sign-off.

## Tests: proportional verification

Check what you changed, not everything, and say exactly what you ran in the PR.

| Change | Run |
|---|---|
| UI / client only | `pnpm -r typecheck`, the web tests for touched files (`pnpm --filter @agent-command/web exec vitest run --maxWorkers=1 <files>`), and screenshots |
| Server only | typecheck + the affected server test files (`--testTimeout=30000` on a loaded machine) |
| Sim / bots / policies | typecheck + `pnpm --filter @agent-command/game test` + only the timing files your change can affect |
| Agent-facing surface (manifest, schemas, skills, observations, briefing) | the above, then `pnpm bench:pin` and commit `bench/surface.ts` |

- Use `--maxWorkers=1` (or 2) for vitest on shared or small machines; the suites are heavy.
- **Timing-sensitive suites** (perf, determinism, `test:mirrors`, policies, balance sweeps) are excluded from `pnpm test`. Run them one at a time on an otherwise idle machine: `pnpm --filter @agent-command/game test:timing` / `test:mirrors`.
- **Determinism and exact mirror symmetry** are invariants: red is the exact point mirror of blue. Sim changes need a regression test mirrored for both teams; new sim state must be hashed (`packages/game/src/sim/hash.ts`) and cloned.
- Bugs: reproduce first, fix the root cause, keep a test that fails before and passes after.
- Never weaken a threshold, budget or assertion to make a test pass.
- Browsers in tests are headless only.

## Changing a bot

The built-in bots live in `packages/game/src/bots/` (TypeScript, the source of truth). Every bot seat, the packages
and the starters agents deploy play the JavaScript `pnpm bots:build` generates from it, so a bot change goes through
these steps in order:

1. **Edit the TypeScript** in `src/bots/` (tier numbers in `tuning.ts`, the sandbox tiers in `SANDBOX_TIERS`, the
   starters' knobs in `starter.ts`). Transcendental math is `dmath` (`src/util/fdlibm.js`), never `Math.sin`,
   `Math.hypot`, `**` and the like: `pnpm check:dmath` fails otherwise.
2. **Rebuild**: `pnpm --filter @agent-command/game bots:build` writes the readable library into the strategy skill
   (`skills/agent-command-strategy/policies/game/`) and the packages; commit the skill.
3. **Parity and traces**: `node test/bot-parity.ts` (packages ≡ in-process, every seat), then
   `vitest run test/bot-packages.test.ts` (the recorded decision traces) and, for a starter or sandbox-tier change,
   `node --expose-gc test/bot-bench.ts starter` (QuickJS cost per call and replay equality).
4. **Re-record traces deliberately.** A change meant to alter play moves the trace hashes in `bot-packages.test.ts`:
   check the parity gate first, then replace the hashes with the reported ones and say why in the commit. A change
   meant to be behaviour-neutral (a speed-up, a work bound used only by the sandbox tier) must leave them unchanged.
5. **Re-pin the agent surface**: `pnpm bench:pin` (the library is part of it) and commit `bench/surface.ts`.

## Commit style

Short, lower-case, scope-first subjects that say what changed and why, e.g.

```
lobby: starting a game leaves your previous one; regression tests
fix(bots): retain Surface force for optional Depths expeditions
```

Scopes follow the package or area (`game`, `server`, `web`, `lobby`, `bots`, `balance`, `docs`, …). Keep unrelated changes in separate commits. Never commit secrets, `.env` files, `*:Zone.Identifier` files or generation tooling (`git add -A -- . ':!*Zone.Identifier'`).

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Every commit must carry a sign-off line certifying that you wrote the change or otherwise have the right to submit it under the project licence:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. Forgot? `git commit --amend -s` (last commit) or `git rebase --signoff main` (whole branch). Use your real name and an email you can be reached at.

By signing off you agree that your contribution is licensed under the GNU AGPL-3.0-only (code). Creative assets (see [ASSETS-LICENSE.md](ASSETS-LICENSE.md)) are not accepted under the code licence; talk to us on Discord before contributing art, audio or maps.
