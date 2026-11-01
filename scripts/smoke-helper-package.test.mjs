import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeHelperPackage } from './smoke-helper-package.mjs';

test('npm-delayed-visibility: the exact local tarball installs and starts; broken packages fail before publication', () => {
  const directory = mkdtempSync(join(tmpdir(), 'helper-smoke-fixture-'));
  try {
    mkdirSync(join(directory, 'dist'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'usebeeline', version: '0.0.1', bin: { beeline: 'dist/cli.js' } }));
    const pack = (source) => {
      writeFileSync(join(directory, 'dist/cli.js'), '#!/usr/bin/env node\n' + source);
      execFileSync('npm', ['pack', '--offline', '--pack-destination', directory], { cwd: directory, stdio: 'pipe' });
      return join(directory, 'usebeeline-0.0.1.tgz');
    };
    const tarball = pack("console.log('beeline start [--all|--agent <public key>]')");
    smokeHelperPackage(tarball, '0.0.1');
    assert.throws(() => smokeHelperPackage(tarball, '0.0.2'), /Unexpected installed package/);
    assert.throws(() => smokeHelperPackage(pack('process.exit(7)'), '0.0.1'), /Command failed/);
    assert.throws(() => smokeHelperPackage(pack("console.log('broken')"), '0.0.1'), /Unexpected CLI help/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
