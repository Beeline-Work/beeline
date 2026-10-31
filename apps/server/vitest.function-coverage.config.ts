import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    coverage: {
      enabled: true,
      provider: 'custom',
      customProviderModule: './scripts/function-coverage-provider.mjs',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      all: false,
      reporter: [],
    },
  },
});
