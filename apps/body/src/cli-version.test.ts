import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
const repoRoot = resolve(dirname(cliPath), '..', '..', '..');

test('version boots without external agent binaries or binary overrides', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'beeline-version-home-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--version'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: '',
        BEELINE_HARNESS_PATH_AUGMENT: '0',
        NO_COLOR: '1',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^beeline 0\.0\.0(?:\n|$)/);
    expect(result.stderr).toBe('');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
