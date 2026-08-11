import { defineConfig } from 'vitest/config';

// Live tests intentionally target the developer relay stack, never production.
process.env.BUZZY_RELAY_HOST ??= '127.0.0.1:3010';
process.env.BUZZY_RELAY_SCHEME ??= 'http';
process.env.BUZZY_RELAY_URL ??= 'http://127.0.0.1:3010';
process.env.BUZZ_RELAY_URL ??= 'ws://127.0.0.1:3010';

/**
 * Live suite against the real Buzz relay (`npm run stack:up` first).
 * Self-sufficient: pretest:live builds @beeline/nostr + this package.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
