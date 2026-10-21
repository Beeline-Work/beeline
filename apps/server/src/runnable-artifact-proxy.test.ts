import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

it('enforces the deployed credential-free proxy boundary', () => {
  execFileSync(process.execPath, ['--test', fileURLToPath(new URL('../../../scripts/runnable-artifact-proxy.test.mjs', import.meta.url))], { timeout: 10_000 });
});
