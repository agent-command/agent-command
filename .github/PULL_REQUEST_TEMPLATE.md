## What and why

<!-- The behaviour change and the reason. Link issues: Fixes #123 -->

## Verification

<!-- Exactly what you ran (proportional checks, see CONTRIBUTING.md). -->

- [ ] `pnpm -r typecheck`
- [ ] Tests for the touched packages/files ran green (`--maxWorkers=1`/`2`)
- [ ] Sim change: mirrored regression test for both teams; new state hashed and cloned
- [ ] Agent-facing surface changed (manifest, schemas, skills, observations): ran `pnpm bench:pin` and committed `bench/surface.ts`
- [ ] Screenshots / recording attached for UI changes
- [ ] Docs updated where behaviour changed
- [ ] No backward-compat shims; every caller updated
- [ ] Commits are signed off (`git commit -s`, DCO)
