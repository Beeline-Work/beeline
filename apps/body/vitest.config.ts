import { defineConfig } from 'vitest/config';

/**
 * Hermetic unit tests only. Live relay + buzz-agent tests live in
 * `*.live.test.ts` and are run via `npm run test:live`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.live.test.ts', 'node_modules/**', 'dist/**'],
    // Production Git work is intentionally asynchronous and process-group
    // isolated. Repository integration tests exercise several real Git
    // children and need room for a loaded CI host without reverting to the
    // event-loop-blocking spawnSync path this suite guards against.
    testTimeout: 15_000,
  },
});
