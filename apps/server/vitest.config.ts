import { defineConfig } from 'vitest/config';

export default defineConfig({
  // These portable phone proof modules have no Expo runtime dependency. Keep
  // server transforms on the repository's ES2022 class-field semantics instead
  // of resolving the mobile tsconfig in server-only CI installations.
  esbuild: {tsconfigRaw:{compilerOptions:{useDefineForClassFields:true}}},
  test: {
    testTimeout: 20_000,
    // Native network callbacks can outlive a fake-clock block. If they create
    // a fake Immediate, later real clearImmediate(handle) corrupts Node's
    // immediate accounting and strands hooks/RPCs in this reused worker.
    // Mock application clocks while leaving Node's I/O scheduler native.
    fakeTimers: {
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    },
    globalSetup: ['./scripts/test-database-setup.ts'],
    // CI on main records per-file function coverage for PR test selection.
    setupFiles: ['./scripts/test-event-loop.ts',
      ...(process.env.SERVER_COVERAGE_MAP_DIR ? ['./scripts/coverage-map-setup.mjs'] : [])],
  },
});
