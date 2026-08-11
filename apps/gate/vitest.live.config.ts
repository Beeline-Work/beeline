import { defineConfig } from 'vitest/config';

// Live tests intentionally target the developer relay stack, never production.
process.env.BUZZY_RELAY_HOST ??= '127.0.0.1:3010';
process.env.BUZZY_RELAY_SCHEME ??= 'http';
process.env.BUZZY_RELAY_URL ??= 'http://127.0.0.1:3010';
process.env.BUZZ_RELAY_URL ??= 'ws://127.0.0.1:3010';

/**
 * Live suite against the real Buzz relay (`npm run stack:up` first).
 * These tests provision their own channel+repo and assert relay-enforced
 * branch protection + the provisioning check. See src/push-rights.live.test.ts.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    // Live suite talks to a real relay + git; give each test headroom.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Sequential: each test hits the shared local relay; no need to stress it.
    fileParallelism: false,
  },
});
