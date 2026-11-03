import { defineConfig } from 'vitest/config';

// Standalone closure assertions require real PostgreSQL and never xfail/skip.
export default defineConfig({
  // These portable phone proof modules have no Expo runtime dependency. Keep
  // server transforms on the repository's ES2022 class-field semantics instead
  // of resolving the mobile tsconfig in server-only CI installations.
  esbuild: {tsconfigRaw:{compilerOptions:{useDefineForClassFields:true}}},
  test: {include:['proofs/router-group-a-open-gates.ts'],testTimeout:20_000},
});
