import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { otaFatal, candidateVisible, runOtaLaunchProof } from '../apps/mobile/scripts/release-proof.mjs';

const sha = 'a'.repeat(40);
test('fatal native/JS errors and emergency fallback fail, ordinary logs do not', () => {
  for (const line of ['E AndroidRuntime: FATAL EXCEPTION: main', 'Fatal signal 11 (SIGSEGV)',
    'E ReactNativeJS: Error: TurboModuleRegistry.getEnforcing NetInfo could not be found',
    'JavascriptException: missing module', 'ExpoUpdates: EmergencyLaunch']) assert.equal(otaFatal(line), true, line);
  assert.equal(otaFatal('I ReactNativeJS: Room list mounted'), false);
  assert.equal(otaFatal('E ReactNativeJS: Error checking for updates: Error: network offline'), false);
});
test('the candidate source must be visible; an embedded or stale fallback cannot pass', () => {
  assert.equal(candidateVisible(`<node text="Beeline version v1.2.3 · ${sha.slice(0, 12)}"/>`, sha), true);
  assert.equal(candidateVisible('<node text="Beeline version v1.2.2 · bbbbbbbbbbbb"/>', sha), false);
  assert.equal(candidateVisible('<node resource-id="room-list"/>', sha), false);
});

test('real orchestration against stand-in EAS/adb: reviewer launch passes, JS fatal fails', async () => {
  // Everything lives inside the worktree; never use a real device, account,
  // Android SDK, EAS endpoint, or the shared rig lock in this regression.
  const root = resolve('.task-proof');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'ota-launch-'));
  const originalEnv = { ...process.env };
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = require('node:path').basename(process.argv[1]);
fs.appendFileSync(process.env.PROOF_TRACE, JSON.stringify({command,args})+'\\n');
const sha = 'a'.repeat(40);
if (command === 'eas') {
  if (args[0] === 'channel:view') console.log(JSON.stringify({ name:'beta', branchMapping:{data:[{branchMappingLogic:'true',branchId:'branch'}]}, updateBranches: [{id:'branch', name: 'release-v1.2.3' }] }));
  else if (args[0] === 'update:list') console.log(JSON.stringify([{group:'group',platform:'android',runtimeVersion:'35', message:'release '+sha.slice(0,12)+' android@35'}]));
  else if (args[0] === 'build:list') console.log(JSON.stringify([{id:'old-native', artifacts:{buildUrl:'https://example.invalid/beta.apk'}}]));
  else process.exit(2);
} else if (command === 'curl') fs.writeFileSync(args[args.indexOf('-o')+1], 'fake apk');
else if (command === 'adb') {
  const text = args.join(' ');
  if (text.includes('beeline://beeline/settings')) fs.appendFileSync(process.env.PROOF_SETTINGS, 'x');
  if (args[0] === 'devices') console.log('List of devices attached\\nemulator-fake\\tdevice');
  else if (text.includes('get-state')) console.log('device');
  else if (text.includes('sys.boot_completed')) console.log('1');
  else if (text.includes('logcat -d')) console.log(process.env.PROOF_FATAL === '1' ? 'E ReactNativeJS: Error: TurboModuleRegistry NetInfo missing' : 'I ReactNativeJS: room mounted '+process.env.BEELINE_REVIEW_SECRET);
  else if (text.includes('exec-out cat')) console.log('<node resource-id="room-list"/><node resource-id="room-bee11e00-0000-4000-8000-000000000103"/><node text="Beeline version v1.2.3 · '+(process.env.PROOF_FALLBACK === '1' && fs.existsSync(process.env.PROOF_SETTINGS) && fs.readFileSync(process.env.PROOF_SETTINGS,'utf8').length > 1 ? 'bbbbbbbbbbbb' : sha.slice(0,12))+'"/>');
  else if (text.includes('pidof')) console.log('12345');
  else if (text.includes('screencap')) process.stdout.write(Buffer.from([137,80,78,71]));
}
`;
    for (const name of ['eas', 'adb', 'curl']) {
      writeFileSync(join(bin, name), fake); chmodSync(join(bin, name), 0o755);
    }
    const trace = join(dir, 'trace.jsonl');
    Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, EAS_CLI_PATH: join(bin, 'eas'),
      PROOF_TRACE: trace, PROOF_SETTINGS: join(dir, 'settings-count'), BEELINE_REVIEW_SECRET: 'synthetic-review-secret' });
    const targets = join(dir, 'targets.json');
    writeFileSync(targets, JSON.stringify({ targets: [{ platform: 'android', runtimeVersion: '35' }] }));
    const args = { sha, targets };
    await runOtaLaunchProof('emulator-fake', args, dir);
    const report = JSON.parse(readFileSync(join(dir, 'release-proof.json'), 'utf8'));
    assert.equal(report.results[0].ok, true);
    assert.equal(report.nativeBuild, 'old-native');
    assert.equal(report.sourceSha, sha);
    assert.ok(!readFileSync(join(dir, 'launch-logcat.log'), 'utf8').includes('synthetic-review-secret'));
    const calls = readFileSync(trace, 'utf8');
    assert.match(calls, /beeline:\/\/review\/synthetic-review-secret/);
    assert.doesNotMatch(calls, /build:run|channel:edit|android-build/);
    process.env.PROOF_FALLBACK = '1';
    rmSync(process.env.PROOF_SETTINGS, { force: true });
    await assert.rejects(runOtaLaunchProof('emulator-fake', args, dir), /no longer running after cold start/);
    delete process.env.PROOF_FALLBACK;
    process.env.PROOF_FATAL = '1';
    await assert.rejects(runOtaLaunchProof('emulator-fake', args, dir), /Native crash, JS fatal/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'release-proof.json'), 'utf8')).results[0].ok, false);
    delete process.env.BEELINE_REVIEW_SECRET;
    await assert.rejects(runOtaLaunchProof('emulator-fake', args, dir), /no persisted-account fallback/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});
