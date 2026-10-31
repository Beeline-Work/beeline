import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    // CI on main records per-file function coverage for PR test selection.
    setupFiles: process.env.SERVER_COVERAGE_MAP_DIR ? ['./scripts/coverage-map-setup.mjs'] : [],
  },
});
