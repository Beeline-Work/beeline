import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const missing of ['pod', 'codesign']) {
test(`missing ${missing} is named before prebuild or simulator work starts`, () => {
  const root = mkdtempSync(join(tmpdir(), 'signin-preflight-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    symlinkSync('/bin/rm', join(bin, 'rm'));
    symlinkSync('/bin/mkdir', join(bin, 'mkdir'));
    const available = ['xcodebuild', 'xcrun', 'node', 'npm', 'npx', 'pod', 'java', 'maestro', 'codesign'].filter(tool => tool !== missing);
    for (const tool of available) {
      writeFileSync(join(bin, tool), '#!/bin/sh\necho "Unexpected tool invocation" >&2\nexit 99\n', { mode: 0o755 });
    }
    const result = spawnSync('/bin/bash', [resolve('scripts/ios-signin/capture.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin, SOURCE_DIR: root, HARNESS_DIR: root, EVIDENCE: join(root, 'evidence') },
    });
    assert.equal(result.status, 127);
    assert.ok(result.stderr.includes(`Missing required tool: ${missing}`));
    assert.doesNotMatch(result.stderr, /Unexpected tool invocation/);
    for (const tool of available) {
      assert.ok(result.stdout.includes(`${tool}: ${join(bin, tool)}`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
}

test('Simulator selection uses runtime compatibility rather than the final legacy iPhone type', async () => {
  const { readFileSync } = await import('node:fs');
  const capture = readFileSync(resolve('scripts/ios-signin/capture.sh'), 'utf8');
  const selection = capture.match(/<<'JS'\n([\s\S]*?)\nJS/)[1];
  const root = mkdtempSync(join(tmpdir(), 'signin-device-'));
  try {
    const supported = { name: 'iPhone 17 Pro', identifier: 'supported-iphone' };
    const runtime = { isAvailable: true, identifier: 'com.apple.iOS-26', supportedDeviceTypes: [supported] };
    const fixture = join(root, 'simulators.json');
    writeFileSync(fixture, JSON.stringify({ runtimes: [runtime], devicetypes: [supported, { name: 'iPhone 6s Plus', identifier: 'incompatible-iphone' }] }));
    const result = spawnSync(process.execPath, ['--input-type=module', '-', fixture], { input: selection, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'supported-iphone\ncom.apple.iOS-26\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Xcode signs the Simulator executable and launch diagnostics precede provider taps', async () => {
  const { readFileSync } = await import('node:fs');
  const capture = readFileSync(resolve('scripts/ios-signin/capture.sh'), 'utf8');
  assert.match(capture, /CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO DEVELOPMENT_TEAM=/);
  assert.match(capture, /CODE_SIGN_ENTITLEMENTS="\$EVIDENCE\/simulator-entitlements.plist"/);
  assert.doesNotMatch(capture, /codesign --force/);
  const entitlements = capture.match(/<<'PLIST'\n([\s\S]*?)\nPLIST/)[1];
  assert.match(entitlements, /keychain-access-groups/);
  assert.doesNotMatch(entitlements, /application-identifier/);
  assert.match(capture, /Print :keychain-access-groups:0/);
  assert.ok(capture.indexOf('simctl launch --console-pty') < capture.indexOf('for provider in'));
  assert.match(capture, /launch-stderr.log/);
  assert.match(capture, /DiagnosticReports.*-newer/);
  assert.match(capture, /log show --last 5m/);
});
