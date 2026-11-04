import { defineConfig } from 'vitest/config';

// Deliberately separate from regression CI: these are whole-finding closure
// assertions. Open findings must remain executable and red, never xfail/skip.
export default defineConfig({ test: { include: ['proofs/router-group-a-open-gates.ts'], testTimeout: 20_000 } });
