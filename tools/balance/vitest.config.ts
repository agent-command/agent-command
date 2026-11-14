import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // record and probe tests play real minutes of sim (a few seconds each; slower on a loaded machine)
    testTimeout: 60_000,
  },
});
