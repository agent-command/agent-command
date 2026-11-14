import { defineConfig } from 'vitest/config';

/**
 * Lanes, selected by the package scripts:
 * - `pnpm test:quick` (about a minute, run before every "ready to merge"): short equal-bot symmetry runs (duel and four
 *   armies), a determinism replay and the briefing/policy/skill size budgets.
 * - `pnpm test`: every file in parallel, excluding tests tagged `timing` (`--tags-filter='!timing'`).
 * - `pnpm test:timing`: exactly the `timing` tests (CPU budgets, sandboxed policy calls under their per-call budget,
 *   long full-match cases), one file at a time in one worker. `pnpm test:mirrors` is its extended symmetry subset.
 * Tag a whole file with a `// @module-tag timing` comment or a single case or suite with `{ tags: ['timing'] }`.
 *
 * The game is plain Node with no DOM, so files share thread workers without per-file isolation: measured 91 s vs 102 s
 * for the default set at two workers, all passing. A test that mutates module state must restore it.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    pool: 'threads',
    isolate: false,
    tags: [{ name: 'timing', description: 'timing-sensitive: run serially by pnpm test:timing, never in the default parallel set' }],
    strictTags: true,
  },
});
