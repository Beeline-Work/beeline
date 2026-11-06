import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('missing CocoaPods is named before prebuild or simulator work starts', () => {
  const root = mkdtempSync(join(tmpdir(), 'signin-preflight-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    symlinkSync('/bin/rm', join(bin, 'rm'));
    symlinkSync('/bin/mkdir', join(bin, 'mkdir'));
    for (const tool of ['xcodebuild', 'xcrun', 'node', 'npm', 'npx', 'java', 'maestro']) {
      writeFileSync(join(bin, tool), '#!/bin/sh\necho "Unexpected tool invocation" >&2\nexit 99\n', { mode: 0o755 });
    }
    const result = spawnSync('/bin/bash', [resolve('scripts/ios-signin/capture.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin, SOURCE_DIR: root, HARNESS_DIR: root, EVIDENCE: join(root, 'evidence') },
    });
    assert.equal(result.status, 127);
    assert.match(result.stderr, /Missing required tool: pod/);
    assert.doesNotMatch(result.stderr, /Unexpected tool invocation/);
    for (const tool of ['xcodebuild', 'xcrun', 'node', 'npm', 'npx', 'java', 'maestro']) {
      assert.ok(result.stdout.includes(`${tool}: ${join(bin, tool)}`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
