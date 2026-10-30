import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Cross-client contract tests import plain mobile TypeScript without Expo installed.
  // Supply transform options directly so Vite does not load the mobile tsconfig.
  esbuild: { tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true } } },
  test: { testTimeout: 20_000 },
});
