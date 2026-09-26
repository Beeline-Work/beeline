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
    // Hooks do at least as much work as the tests they bracket: the room
    // discovery fixtures migrate a database, start a real server, and run a
    // daemon core in beforeEach, and abort that whole stack plus remove temp
    // roots in afterEach. Under the same loaded CI host that motivates
    // testTimeout above, the vitest default 10s hookTimeout failed the suite
    // on teardown alone; a genuine shutdown hang still fails, just at 30s.
    hookTimeout: 30_000,
  },
});
