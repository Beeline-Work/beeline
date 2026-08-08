import { defineConfig } from 'vitest/config';

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
