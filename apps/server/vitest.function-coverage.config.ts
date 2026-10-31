import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    setupFiles: ['./scripts/observe-source-reads.mjs'],
    coverage: {
      enabled: true,
      provider: 'custom',
      customProviderModule: './scripts/function-coverage-provider.mjs',
      allowExternal: true,
      include: ['**/apps/*/src/**/*.ts', '**/apps/*/dist/**/*.js', '**/packages/*/src/**/*.ts', '**/packages/*/dist/**/*.js'],
      exclude: ['**/*.test.*', '**/*.spec.*'],
      all: false,
      reporter: [],
    },
  },
});
