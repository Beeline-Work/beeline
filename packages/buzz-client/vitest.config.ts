import { defineConfig } from 'vitest/config';

/**
 * Hermetic unit tests only. Live relay tests live in `*.live.test.ts` and are
 * run via `npm run test:live` (see vitest.live.config.ts).
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.live.test.ts', 'node_modules/**', 'dist/**'],
  },
});
