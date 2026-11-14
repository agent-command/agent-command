# AGENTS.md

Rules for any coding agent (or human) working in this repository. `docs/DESIGN.md` is the design source of truth for the shipped game and `docs/ROADMAP.md` for planned work; this file is how we work.

## Product rules

- **No backward compatibility of any kind.** No shims, aliases, legacy producers, version fallbacks, deprecated paths or data migrations. Change formats outright and update every caller. Stored data (profiles, commanders, policies, history, results, DB schemas) is reset deliberately instead of migrated; tell the maintainer when a reset is needed.
- **Every gameplay and map number is a match rule** (`DEFAULT_RULES` / `matchOptionsSchema`, DESIGN §2.1). No magic numbers in sim, bots, policies or client.
- **Every mechanic ships complete:** sim, rules, intents, fog-safe observations, built-in bots (standard and veteran), the example policies, the strategy skill, briefing text, client UI and tests. Run `pnpm bench:pin` after any agent-facing surface change (manifest, schemas, skills, observations) and commit `bench/surface.ts`.
- **Keep the design docs current.** A change to the game's design updates `docs/DESIGN.md` in the present tense: rules by name (never their values), the reason for each decision, no status markers, history or measurements. Shipping a roadmap item moves its design into DESIGN and deletes it from `docs/ROADMAP.md`; new plans go into ROADMAP with a link to their memo in `docs/research/`. Cite DESIGN by section number and fix every citation when sections move.
- **Determinism and exact point symmetry.** Same inputs, same match. Red is the exact mirror of blue: compute in the team-canonical frame, never depend on update order or float tie-breaks. New sim state is hashed (`packages/game/src/sim/hash.ts`) and cloned.
- **Fog safety.** Clients, agents, policies, sounds, alerts and intent results reveal only what the team knows. No fog oracles.
- **Map size is per match.** Never use a global map size or `48`; take the size from the match. No `size = 48` default parameters.

## Code rules

- TypeScript 7, **erasable-only syntax** (no enums, namespaces, parameter properties).
- **No per-tick or per-frame allocation** in the sim or renderer: pool, preallocate, reuse.
- Comments explain *why*, units and invariants, not what the code does.
- Never weaken a threshold, budget or assertion to make a test pass. Fix the cause. If an assertion encodes incidental behaviour, replace it with the real invariant and say so.
- Prefer existing patterns, registries and helpers over new conventions. Delete what a change makes obsolete.

## UI rules

- Icons only via `icon()` (`apps/web/src/icons.ts`). Tooltips only via `tip()` / `data-tip`. Native `title=` is banned (a test enforces it).
- Minimal words. Dark, logo-sampled theme. Translucent HUD panels; no hover-to-solid.
- Game hotkeys work whenever focus isn't in a real text field. Mouse clicks don't leave focus rings (`:focus-visible` for keyboard users).
- Nothing on first load may block the main thread for more than ~100 ms. Heavy work is chunked, idle-scheduled or in a worker.

## Workflow rules

- **Worktrees:** each task works in its own worktree and branch, never in a main checkout: `git -C <repo> worktree add ../ac-<name> -b <branch> main && pnpm install --frozen-lockfile`. Merge `main` into your branch before reporting ready.
- **Proportional verification.** Check what you changed, not everything:
  - **UI/client-only** (web components, CSS, audio, HUD): typecheck, the web tests for touched files, one headless smoke or screenshot set.
  - **Server-only:** typecheck plus the affected server test files (`--testTimeout=30000` under load).
  - **Sim/bot/policy:** typecheck, game default tests (`pnpm --filter @agent-command/game test`), plus only the timing files your change can affect.
  - **Before every `ready to merge`** of a game, bot, policy or briefing change: `pnpm test:quick` (typecheck, then about a minute of short equal-bot symmetry runs, a determinism replay and the size budgets). It needs no timing slot. The long `test:mirrors` and `test:timing` run once on the combined branch before a deploy.
  - **Full suites** only for wide cross-cutting changes, when the maintainer asks.
  - Report exactly what you ran.
- **Timing slot.** Perf, determinism, mirrors (`test:mirrors`), policies and balance sweeps are timing-sensitive and run one at a time on a shared machine. Ask the orchestrator "ready for timing slot", wait for "go", reply "timing done". `pnpm test` excludes timing-tagged tests; `pnpm --filter @agent-command/game test:timing` runs them serially.
- **Browsers: headless only.** Never launch a headed browser. Use playwright-core with Chromium flags `--no-sandbox --use-gl=angle --use-angle=gl --ignore-gpu-blocklist` and `?renderer=webgl`. Use your own ports, and close browsers and servers when done.
- **Bugs:** user-reported bugs are ground truth. Reproduce first, fix the root cause, and keep a regression test that fails before and passes after (mirrored for both teams when it touches the sim).
- **Commits:** never commit `*:Zone.Identifier` files (`git add -A -- . ':!*Zone.Identifier'`). Never commit secrets, env files or generation tooling: audio/asset generation scripts stay in scratch, and only final assets plus their `PROVENANCE.md` are committed.
- **Scratch:** throwaway scripts, logs, profiles and bench output go in `tmp/<task>/` at the repo root (gitignored), never the system `/tmp`, which is wiped on reboot.
- **Deploys:** `pnpm deploy:railway` requires explicit `--project`, `--environment` and `--service`. Never change Railway settings or production data without the maintainer.
- **Coordination:** when your change touches another worker's area, message them before editing shared files. Report finished work as `ready to merge <branch> <commit>`.

## Useful commands

| Command | What it does |
|---|---|
| `pnpm dev` | Web on :5173, server on :2567, lookdev on :5190; dev restarts never drain |
| `pnpm -r typecheck` | Typecheck every package |
| `pnpm test:quick` | Pre-merge lane: typecheck + quick symmetry/determinism/size checks (~1 min, no slot) |
| `pnpm --filter @agent-command/game test` | Game tests (timing excluded) |
| `pnpm --filter @agent-command/game test:timing` / `test:mirrors` | Timing-sensitive suites (slot only) |
| `pnpm --filter @agent-command/web exec vitest run --maxWorkers=2` | Web tests |
| `pnpm bench:pin` | Re-pin the agent-facing surface hash |
