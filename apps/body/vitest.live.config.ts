import { defineConfig } from 'vitest/config';

// Live tests intentionally target the developer relay stack, never production.
process.env.BUZZY_RELAY_HOST ??= '127.0.0.1:3010';
process.env.BUZZY_RELAY_SCHEME ??= 'http';
process.env.BUZZY_RELAY_URL ??= 'http://127.0.0.1:3010';
process.env.BUZZ_RELAY_URL ??= 'ws://127.0.0.1:3010';

/**
 * Live suite against the real Buzz relay + real buzz-agent + real LLM egress.
 * Soft-skips only when relay or LLM env is absent; never skips when both present.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
