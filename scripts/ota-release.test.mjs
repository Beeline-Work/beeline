import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  channelBranchName,
  computeTargets,
  planBranchPublish,
  rollbackGaps,
} from '../apps/mobile/scripts/ota-release.mjs';

const MOBILE = fileURLToPath(new URL('../apps/mobile/', import.meta.url));
const SCRIPT = join(MOBILE, 'scripts/ota-release.mjs');
const SHA = 'f'.repeat(40);
const OTHER = 'e'.repeat(40);
const key = (target) => `${target.platform}@${target.runtimeVersion}`;
const LIVE = [
  ['android', '40'], ['android', '39'], ['android', '38'], ['ios', '36'], ['ios', '34'], ['ios', '31'],
].map(([platform, runtimeVersion]) => ({ platform, runtimeVersion }));

// A stand-in for eas-cli that keeps branches and channels in one JSON file and
// prints what eas-cli 22.2.0 prints for each command.
const FAKE_EAS = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.FAKE_EAS_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
state.calls.push(args.filter((a) => !a.startsWith('--json') && a !== '--non-interactive').join(' '));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const out = (value) => { save(); process.stdout.write(JSON.stringify(value)); process.exit(0); };
const die = (message) => { save(); process.stderr.write(message + '\n'); process.exit(1); };
const branchId = (name) => 'branch-' + name;
const [command] = args;
if (command === 'update:list') {
  const branch = flag('branch');
  if (!state.branches[branch]) die('Could not find branch "' + branch + '"');
  out({ name: branch, id: branchId(branch), currentPage: state.branches[branch].map((u) => ({
    branch, message: '"' + u.message + '" (1 minute ago by release-bot)', runtimeVersion: u.runtimeVersion,
    isRollBackToEmbedded: Boolean(u.embedded), group: u.group, platforms: u.platform,
  })) });
}
if (command === 'update' || command === 'update:roll-back-to-embedded') {
  const branch = flag('branch');
  const platform = flag('platform');
  const runtimeVersion = flag('runtime-version') ?? process.env.EXPO_RUNTIME_OVERRIDE;
  state.branches[branch] ??= [];
  const group = 'group-' + (state.nextGroup++);
  const update = { id: group + '-' + platform, group, platform, runtimeVersion, message: flag('message'), embedded: command !== 'update' };
  state.branches[branch].unshift(update);
  out([{ ...update, branch }]);
}
if (command === 'channel:view') {
  const name = args[1];
  if (!state.channels[name]) die('Could not find channel with the name ' + name);
  const branch = state.channels[name];
  out({ currentPage: { id: 'channel-' + name, name, branchMapping: JSON.stringify({ version: 0, data: [{ branchId: branchId(branch), branchMappingLogic: 'true' }] }),
    updateBranches: [{ id: branchId(branch), name: branch, updateGroups: [] }] } });
}
if (command === 'channel:create') {
  const name = args[1];
  state.branches[name] ??= [];
  state.channels[name] = name;
  out({ id: 'channel-' + name, name });
}
if (command === 'channel:edit') {
  const name = args[1];
  const branch = flag('branch');
  if (!state.branches[branch]) die('Could not find a branch named "' + branch + '".');
  state.channels[name] = branch;
  out({ id: 'channel-' + name, name });
}
die('fake eas: unsupported ' + args.join(' '));
`;

function harness(initial = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ota-release-'));
  const eas = join(dir, 'eas');
  writeFileSync(eas, FAKE_EAS);
  chmodSync(eas, 0o755);
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ branches: {}, channels: {}, calls: [], nextGroup: 1, ...initial }));
  const targetsPath = join(dir, 'targets.json');
  writeFileSync(targetsPath, JSON.stringify({ targets: LIVE, storeRuntime: { builds: [], previouslyLive: [] } }));
  const env = { ...process.env, EAS_CLI_PATH: eas, FAKE_EAS_STATE: statePath };
  delete env.SENTRY_AUTH_TOKEN;
  delete env.EXPO_RUNTIME_OVERRIDE;
  return {
    dir, targetsPath,
    run: (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: MOBILE, encoding: 'utf8', env }),
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const publishArgs = (h, branch = 'release-v0.2.31', sha = SHA) => [
  'publish', '--sha', sha, '--release-version', 'v0.2.31', '--branch', branch, '--channel', 'beta',
  '--targets', h.targetsPath, '--output', join(h.dir, 'published.json'),
];
const updateCalls = (h) => h.state().calls.filter((call) => call.startsWith('update --branch'));

// Reproduction OTA-40 (owner: "you will give me an OTA on the 40, right?"):
// run 41011558207 published only android@43/42/41 and ios@36/35/34, so phones
// on the live Android 40 store build got nothing.
test('OTA-40: targets are every runtime live in the stores, whatever the pin says', () => {
  const stores = {
    android: { status: 'readable', live: [{ platform: 'android', runtimeVersion: '40', buildNumber: '138' }], historical: [], latestRuntimeVersion: '40' },
    ios: { status: 'readable', live: [{ platform: 'ios', runtimeVersion: '36', buildNumber: '98' }],
      historical: [{ platform: 'ios', runtimeVersion: '34' }, { platform: 'ios', runtimeVersion: '31' }], latestRuntimeVersion: '36' },
  };
  const memory = { previouslyLive: [{ platform: 'android', runtimeVersion: '39' }, { platform: 'android', runtimeVersion: '38' }] };
  const { targets } = computeTargets({ memory, stores, pins: { android: '43', ios: '36' } });
  assert.deepEqual(targets.map(key), ['android@40', 'android@39', 'android@38', 'ios@36', 'ios@34', 'ios@31']);
  // A store that cannot be read keeps the runtimes the previous release served.
  const fallback = computeTargets({ memory: { previousTargets: LIVE }, stores: { ios: stores.ios }, pins: { android: '43', ios: '36' } });
  assert.deepEqual(fallback.targets.map(key), LIVE.map(key));
  assert.throws(() => computeTargets({ memory: {}, stores: {}, pins: { android: '43', ios: '36' } }), /no live store runtime/);
});

test('publish puts every live runtime on the release branch, then points beta at it', () => {
  const h = harness({ channels: { beta: 'beta' }, branches: { beta: [] } });
  try {
    const result = h.run(...publishArgs(h));
    assert.equal(result.status, 0, result.stderr);
    const state = h.state();
    assert.deepEqual(state.branches['release-v0.2.31'].map(key).sort(), LIVE.map(key).sort());
    assert.equal(state.channels.beta, 'release-v0.2.31');
    // One JS export per platform; later runtimes reuse it.
    assert.equal(updateCalls(h).filter((call) => !call.includes('--skip-bundler')).length, 2);
    const facts = JSON.parse(readFileSync(join(h.dir, 'published.json'), 'utf8'));
    assert.deepEqual(facts.published.sort(), LIVE.map(key).sort());
    assert.equal(facts.previousChannelBranch, 'beta');
  } finally { h.close(); }
});

// Reproduction RERUN-NO-DUPLICATE: a proof run killed after two of six
// publishes, then rerun.
test('RERUN-NO-DUPLICATE: a rerun publishes only what the branch lacks, and nothing when complete', () => {
  const h = harness({ channels: { beta: 'beta' }, branches: { beta: [], 'release-v0.2.31': [
    { id: 'g1-android', group: 'g1', platform: 'android', runtimeVersion: '40', message: `release ${SHA.slice(0, 12)} android@40` },
    { id: 'g2-ios', group: 'g2', platform: 'ios', runtimeVersion: '36', message: `release ${SHA.slice(0, 12)} ios@36` },
  ] }, nextGroup: 3 });
  try {
    const first = h.run(...publishArgs(h));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(updateCalls(h).length, 4);
    assert.equal(h.state().branches['release-v0.2.31'].length, 6);
    const second = h.run(...publishArgs(h));
    assert.equal(second.status, 0, second.stderr);
    assert.equal(updateCalls(h).length, 4, 'a complete branch gets no new update');
    assert.match(second.stdout, /already has .*from this source; not republishing them/);
    assert.match(second.stdout, /beta already points at release-v0\.2\.31/);
  } finally { h.close(); }
});

test('one release branch never mixes two source commits', () => {
  const h = harness({ branches: { 'release-v0.2.31': [
    { id: 'g1-android', group: 'g1', platform: 'android', runtimeVersion: '40', message: `release ${OTHER.slice(0, 12)} android@40` },
  ] } });
  try {
    const result = h.run(...publishArgs(h));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another source/);
    assert.equal(updateCalls(h).length, 0);
  } finally { h.close(); }
});

test('promote points production at the exact branch beta got, once', () => {
  const h = harness({ channels: { beta: 'beta', production: 'production' }, branches: { beta: [], production: [
    { id: 'old', group: 'old', platform: 'android', runtimeVersion: '43', message: 'promote beta x (aaaaaaaaaaaa)' },
  ] } });
  try {
    assert.equal(h.run(...publishArgs(h)).status, 0);
    const promote = () => h.run('promote', '--sha', SHA, '--branch', 'release-v0.2.31', '--channel', 'production',
      '--targets', h.targetsPath, '--output', join(h.dir, 'promoted.json'));
    const first = promote();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(h.state().channels.production, 'release-v0.2.31');
    const facts = JSON.parse(readFileSync(join(h.dir, 'promoted.json'), 'utf8'));
    assert.equal(facts.observedPreviousBranch, 'production');
    assert.equal(facts.changed, true);
    const edits = () => h.state().calls.filter((call) => call.startsWith('channel:edit production')).length;
    assert.equal(edits(), 1);
    const rerun = promote();
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(edits(), 1, 'a rerun that already promoted moves nothing');
  } finally { h.close(); }
});

test('promote refuses a branch that lacks a live runtime, before the pointer moves', () => {
  const h = harness({ channels: { production: 'production' }, branches: { production: [], 'release-v0.2.31': [
    { id: 'g1-android', group: 'g1', platform: 'android', runtimeVersion: '40', message: `release ${SHA.slice(0, 12)} android@40` },
  ] } });
  try {
    const result = h.run('promote', '--sha', SHA, '--branch', 'release-v0.2.31', '--channel', 'production', '--targets', h.targetsPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release-v0\.2\.31 is missing android@39, android@38, ios@36, ios@34, ios@31/);
    assert.equal(h.state().channels.production, 'production');
  } finally { h.close(); }
});

test('rollback points production back and rolls runtimes the old branch lacks back to their embedded update', () => {
  const marker = (sha, k) => `release ${sha.slice(0, 12)} ${k}`;
  const h = harness({ channels: { production: 'release-v0.2.32' }, branches: {
    'release-v0.2.31': [
      { id: 'a', group: 'a', platform: 'android', runtimeVersion: '40', message: marker(OTHER, 'android@40') },
      { id: 'b', group: 'b', platform: 'ios', runtimeVersion: '36', message: marker(OTHER, 'ios@36') },
    ],
    'release-v0.2.32': [
      { id: 'c', group: 'c', platform: 'android', runtimeVersion: '41', message: marker(SHA, 'android@41') },
      { id: 'd', group: 'd', platform: 'android', runtimeVersion: '40', message: marker(SHA, 'android@40') },
      { id: 'e', group: 'e', platform: 'ios', runtimeVersion: '36', message: marker(SHA, 'ios@36') },
    ],
  } });
  try {
    const stale = h.run('rollback', '--channel', 'production', '--to-branch', 'release-v0.2.31', '--expected-current', 'release-v0.2.33');
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /no longer current/);
    const result = h.run('rollback', '--channel', 'production', '--to-branch', 'release-v0.2.31', '--expected-current', 'release-v0.2.32',
      '--output', join(h.dir, 'rollback.json'));
    assert.equal(result.status, 0, result.stderr);
    const state = h.state();
    assert.equal(state.channels.production, 'release-v0.2.31');
    assert.deepEqual(state.branches['release-v0.2.31'].filter((u) => u.embedded).map(key), ['android@41']);
    assert.deepEqual(JSON.parse(readFileSync(join(h.dir, 'rollback.json'), 'utf8')).embeddedRollbacks, ['android@41']);
  } finally { h.close(); }
});

test('only a plain one-branch channel pointer is read or moved', () => {
  const view = (data) => ({ currentPage: { name: 'production', branchMapping: JSON.stringify({ data }), updateBranches: [{ id: 'b1', name: 'release-v1' }, { id: 'b2', name: 'release-v2' }] } });
  assert.equal(channelBranchName(view([{ branchId: 'b2', branchMappingLogic: 'true' }])), 'release-v2');
  assert.throws(() => channelBranchName(view([
    { branchId: 'b1', branchMappingLogic: { operand: 0.1 } }, { branchId: 'b2', branchMappingLogic: 'true' },
  ])), /rollout/);
  assert.deepEqual(planBranchPublish({ targets: LIVE, branchUpdates: [], sha: SHA }).missing.map(key), LIVE.map(key));
  assert.deepEqual(rollbackGaps({ currentUpdates: LIVE, targetUpdates: LIVE.slice(1) }).map(key), ['android@40']);
});
