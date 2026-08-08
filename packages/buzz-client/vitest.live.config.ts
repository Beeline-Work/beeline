import { defineConfig } from 'vitest/config';

/**
 * Live suite against the real Buzz relay (`npm run stack:up` first).
 * Self-sufficient: pretest:live builds @buzzy/nostr + this package.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
