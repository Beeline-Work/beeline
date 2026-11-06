import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('a stuck capture flow ends so the next provider can run', () => {
  const runner = resolve('scripts/ios-signin/run-flow.mjs');
  const stuck = spawnSync(process.execPath, [runner, '150', process.execPath, '-e', 'setInterval(() => {}, 1000)'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(stuck.status, 124, stuck.stderr);
  assert.match(stuck.stderr, /Capture flow timed out/);
  const next = spawnSync(process.execPath, [runner, '2000', process.execPath, '-e', 'console.log("next provider")'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /next provider/);
});

test('a stalled flow preserves the screen, recent log and hierarchy before killing Maestro', () => {
  const root = mkdtempSync(join(tmpdir(), 'signin-stall-'));
  try {
    const pidFile = join(root, 'flow.pid');
    const calls = join(root, 'calls.txt');
    const fakeTool = `#!${process.execPath}
const fs = require('node:fs');
process.kill(Number(fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8')), 0);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
if (args.includes('screenshot')) fs.writeFileSync(args.at(-1), 'stall screen');
console.log(args.includes('hierarchy') ? 'stall hierarchy' : 'recent device log');
`;
    for (const name of ['xcrun', 'maestro']) writeFileSync(join(root, name), fakeTool, { mode: 0o755 });
    const stuck = spawnSync(process.execPath, [resolve('scripts/ios-signin/run-flow.mjs'), '300', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CAPTURE_DEVICE: 'test-udid', CAPTURE_STALL_DIR: join(root, 'stall') },
    });
    assert.equal(stuck.status, 124, stuck.stderr);
    assert.equal(readFileSync(join(root, 'stall/screen.png'), 'utf8'), 'stall screen');
    assert.match(readFileSync(join(root, 'stall/device-last-60s.log'), 'utf8'), /recent device log/);
    assert.match(readFileSync(join(root, 'stall/maestro-hierarchy.txt'), 'utf8'), /stall hierarchy/);
    const commands = readFileSync(calls, 'utf8');
    assert.match(commands, /simctl io test-udid screenshot/);
    assert.match(commands, /log show --last 60s/);
    assert.match(commands, /ASWebAuthenticationSession.*SafariViewService.*SpringBoard/);
    assert.match(commands, /--device test-udid hierarchy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
  assert.match(capture, /\['otool', '-l', binary\]/);
  assert.match(capture, /if ! node --input-type=module/);
  assert.match(capture, /Warning: embedded Keychain group unavailable; continuing to app launch/);
  assert.doesNotMatch(capture, /codesign --display --entitlements/);
  assert.ok(capture.indexOf('simctl launch --console-pty') < capture.indexOf('for provider in'));
  assert.match(capture, /launch-stderr.log/);
  assert.match(capture, /DiagnosticReports.*-newer/);
  assert.match(capture, /log show --last 5m/);
});

test('provider assertion rejects the recorded consent sheet and accepts provider addresses', async () => {
  const { readFileSync } = await import('node:fs');
  const flow = readFileSync(resolve('scripts/ios-signin/provider.yaml'), 'utf8');
  const selector = [...flow.matchAll(/visible: '([^']+)'/g)].at(-1)[1];
  const matchesProvider = new RegExp(selector);
  assert.equal(matchesProvider.test('“Beeline” Wants to Use “server.usebeeline.app” to Sign in'), false);
  assert.equal(matchesProvider.test('github.com'), true);
  assert.equal(matchesProvider.test('accounts.google.com'), true);
});
