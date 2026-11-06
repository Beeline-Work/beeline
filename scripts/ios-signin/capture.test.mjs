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

test('recorded provider hierarchies cannot veto screenshot plus correlated server start', () => {
  const flow = readFileSync(resolve('scripts/ios-signin/provider.yaml'), 'utf8');
  for (const provider of ['github', 'google']) {
    const hierarchy = readFileSync(resolve(`scripts/ios-signin/fixtures/${provider}-42211008124.json`), 'utf8');
    assert.equal(/github\.com|accounts\.google\.com/.test(hierarchy), false);
  }
  assert.doesNotMatch(flow, /visible:.*github/);
  assert.match(flow, /takeScreenshot: 05-provider-page/);
  const root = mkdtempSync(join(tmpdir(), 'signin-verification-'));
  try {
    const install = 'a14cf732-f7c2-41ec-b7e5-796b2c6f57e0';
    writeFileSync(join(root, 'install-id.txt'), install);
    for (const provider of ['github', 'google']) {
      writeFileSync(join(root, `${provider}-final.png`), Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    }
    const events = join(root, 'events.json');
    const rows = [
      { install_id: install, provider: 'github', event: 'provider_tapped', attempt_id: '4045c313-9369-484f-850b-3a8e3fc10293', recorded_at: '2026-11-06T12:53:28.209Z', server_at: '2026-11-06T12:53:45.097Z' },
      { install_id: install, provider: 'google', event: 'provider_tapped', attempt_id: 'b906bdcc-6087-4b16-91a5-b878603a5782', recorded_at: '2026-11-06T12:56:09.840Z', server_at: '2026-11-06T12:56:26.045Z' },
    ];
    function verify(input) {
      writeFileSync(events, JSON.stringify(input));
      return spawnSync(process.execPath, [resolve('scripts/ios-signin/verify-capture.mjs'), root, '--events', events], { encoding: 'utf8' });
    }
    assert.equal(verify(rows).status, 0);
    assert.notEqual(verify(rows.map(row => ({ ...row, server_at: null }))).status, 0);
    assert.notEqual(verify(rows.map(row => ({ ...row, server_at: '2026-11-06T12:57:00Z' }))).status, 0);
    assert.notEqual(verify(rows.map(row => ({ ...row, install_id: 'other-install' }))).status, 0);
    rmSync(join(root, 'github-final.png'));
    assert.notEqual(verify(rows).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
