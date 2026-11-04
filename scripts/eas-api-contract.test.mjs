import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Reproduction B: EAS compiles api-contract before its dist exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-eas-contract-'));
  try {
    mkdirSync(join(root, 'apps/mobile/scripts'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(resolve('node_modules/@types'), join(root, 'node_modules/@types'), 'dir');
    cpSync('tsconfig.base.json', join(root, 'tsconfig.base.json'));
    cpSync('apps/mobile/scripts/tsconfig.eas-api-contract.json', join(root, 'apps/mobile/scripts/tsconfig.eas-api-contract.json'));
    const pkg = join(root, 'apps/mobile/node_modules/@beeline/api-contract');
    mkdirSync(pkg, { recursive: true });
    cpSync('packages/api-contract/src', join(pkg, 'src'), { recursive: true });
    cpSync('packages/api-contract/package.json', join(pkg, 'package.json'));
    const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', join(root, 'apps/mobile/scripts/tsconfig.eas-api-contract.json')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
