import { defineConfig } from 'vitest/config';

export default defineConfig({
  // These portable phone proof modules have no Expo runtime dependency. Keep
  // server transforms on the repository's ES2022 class-field semantics instead
  // of resolving the mobile tsconfig in server-only CI installations.
  esbuild: {tsconfigRaw:{compilerOptions:{useDefineForClassFields:true}}},
  test: {
    testTimeout: 20_000,
    globalSetup: ['./scripts/test-database-setup.ts'],
    // CI on main records per-file function coverage for PR test selection.
    setupFiles: ['./scripts/test-event-loop.ts',
      ...(process.env.SERVER_COVERAGE_MAP_DIR ? ['./scripts/coverage-map-setup.mjs'] : [])],
  },
});
