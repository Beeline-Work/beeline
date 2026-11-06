import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { releaseChannel, channelComponents, promotionSource } from './release-channel.mjs';
import { initializeRelease, planOutputs, restoreReleasePlan, applyJobFacts, applyComponentCheckpoints, checkpointsFromJobs } from './unified-release.mjs';
import { latestPublished, assignReleaseVersion } from './release-record.mjs';
import { pagesChannelTag, publishPagesChannel, downloadPagesChannel } from './pages-channel.mjs';
import { buildPagesSite } from './pages-site.mjs';
import { readStores } from './read-store-runtimes.mjs';
import { androidReleaseProfile } from './android-release-channel.mjs';
import { computeTargets } from '../apps/mobile/scripts/ota-release.mjs';

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const previousSha = execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
const delivered = (version = 'v0.1.1', sourceSha = previousSha) => {
  const record = initializeRelease({ version, sourceSha });
  record.state = 'delivered';
  record.delivery.state = 'success';
  for (const entry of Object.values(record.components)) entry.state = 'checked';
  Object.assign(record.components['mobile-ota'], { otaBranch: 'release-v0.1.1', otaTargets: ['android@1', 'ios@2'] });
  record.components.server.imageRef = 'registry.fly.io/beeline-server:previous';
  return record;
};
const nightlyRecord = () => {
  const record = delivered('v0.1.2', sha);
  record.channel = 'nightly';
  record.components.desktop = delivered().components.desktop;
  record.components.website = delivered().components.website;
  record.components['mobile-ota'].otaBranch = 'release-v0.1.2';
  return record;
};
const fixture = (fn) => {
  const directory = mkdtempSync(join(process.cwd(), '.release-channel-test-'));
  return Promise.resolve().then(() => fn(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
};
const workflow = parse(readFileSync('.github/workflows/unified-release.yml', 'utf8'));

test('channel defaults to nightly; native consent and latest selection stay separate', () => {
  assert.equal(releaseChannel(), 'nightly');
  assert.throws(() => releaseChannel('beta'), /invalid release channel/);
  assert.deepEqual(channelComponents(['helper', 'mobile-ota', 'desktop', 'website']), ['server', 'helper', 'mobile-ota']);
  assert.deepEqual(channelComponents(['mobile-native'], { storeTrack: 'beta' }), ['server', 'mobile-native']);
  assert.throws(() => channelComponents(['mobile-native']), /explicit store_track=beta/);
  assert.throws(() => channelComponents([], { storeTrack: 'production' }), /store_track=beta/);
  assert.deepEqual(channelComponents([], { channel: 'latest' }), ['helper', 'mobile-ota', 'desktop', 'website']);
  assert.throws(() => channelComponents([], { channel: 'latest', storeTrack: 'beta' }), /cannot publish/);
});

test('promotion pins a successful nightly and refuses a different source or incomplete evidence', () => {
  const nightly = nightlyRecord();
  assert.equal(promotionSource(nightly).sourceSha, sha);
  assert.throws(() => promotionSource(nightly, previousSha), /current nightly source SHA/);
  assert.throws(() => promotionSource(delivered()), /successfully published nightly/);
  nightly.components['mobile-ota'].otaTargets = [];
  assert.throws(() => promotionSource(nightly), /immutable OTA branch and targets/);
});

test('nightly release records cannot become GitHub latest; identities include reserved nightlies', () => {
  const stable = { tag_name: 'v0.1.1', target_commitish: previousSha, published_at: '2026-01-01', draft: false, prerelease: false };
  const nightly = { tag_name: 'v0.1.2', target_commitish: sha, published_at: '2026-01-02', draft: false, prerelease: true };
  const rolling = { tag_name: pagesChannelTag('nightly'), published_at: '2026-01-03', prerelease: true };
  assert.equal(latestPublished([stable, nightly, rolling]).tag_name, stable.tag_name);
  assert.equal(latestPublished([stable, nightly, rolling], 'nightly').tag_name, nightly.tag_name);
  assert.equal(assignReleaseVersion({ releases: [stable, nightly], previous: delivered(), sha: 'c'.repeat(40) }).version, 'v0.1.3');
});

for (const channel of ['nightly', 'latest']) test(`offline workflow plan: ${channel}`, () => fixture(directory => {
  const previous = delivered();
  const nightly = nightlyRecord();
  writeFileSync(join(directory, 'previous.json'), JSON.stringify(previous));
  writeFileSync(join(directory, 'nightly.json'), JSON.stringify(nightly));
  writeFileSync(join(directory, 'paths.txt'), 'apps/body/src/self-update-manifest.ts\napps/mobile/sources/app/index.tsx\n');
  const args = ['scripts/unified-release.mjs', 'plan', '--version', 'v0.1.2', '--sha', sha,
    '--paths', join(directory, 'paths.txt'), '--previous', join(directory, 'previous.json'),
    '--channel', channel, '--state', join(directory, 'state.json'), '--outputs', join(directory, 'outputs.txt')];
  if (channel === 'latest') args.push('--nightly', join(directory, 'nightly.json'));
  const output = execFileSync(process.execPath, args, { encoding: 'utf8' });
  const plan = JSON.parse(output.trim().split('\n').at(-1));
  console.log(`${channel} component plan: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.selected, channel === 'nightly' ? ['server', 'helper', 'mobile-ota'] : ['helper', 'mobile-ota', 'desktop', 'website']);
  const state = JSON.parse(readFileSync(join(directory, 'state.json')));
  assert.deepEqual(state.plan.nativePlatforms, channel === 'nightly' ? ['android'] : ['android', 'ios']);
  const outputs = Object.fromEntries(readFileSync(join(directory, 'outputs.txt'), 'utf8').trim().split('\n').map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  const restored = restoreReleasePlan({ version: state.version, sourceSha: sha, plan: outputs, previous, nightly: channel === 'latest' ? nightly : undefined });
  assert.equal(restored.channel, channel);
  assert.deepEqual(restored.plan.selected, state.plan.selected);
  if (channel === 'latest') {
    assert.equal(outputs.ota_branch, nightly.components['mobile-ota'].otaBranch);
    assert.equal(restored.components.server.imageRef, nightly.components.server.imageRef);
  }
}));

test('promotion carries older helper and OTA identities without assigning them this release SHA', () => {
  const previous = delivered();
  const nightly = nightlyRecord();
  nightly.components.helper = previous.components.helper;
  nightly.components['mobile-ota'] = previous.components['mobile-ota'];
  const state = initializeRelease({ version: nightly.version, sourceSha: sha, previous, nightly,
    channel: 'latest', selectedComponents: channelComponents([], { channel: 'latest' }) });
  const outputs = Object.fromEntries(planOutputs(state, previous, nightly).trim().split('\n').map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  const needs = { initialize: { outputs }, helper: { result: 'success' }, mobile_ota: { result: 'success', outputs: {
    ota_branch: outputs.ota_branch, ota_targets: outputs.ota_targets,
  } } };
  applyComponentCheckpoints(state, checkpointsFromJobs(needs, { version: nightly.version, sourceSha: sha, releaseId: 'fixture' }));
  applyJobFacts(state, needs, { previous });
  assert.equal(state.components.helper.sourceSha, previousSha);
  assert.equal(state.components.helper.version, previous.version);
  assert.equal(outputs.ota_sha, previousSha);
});

test('workflow reuses native beta and OTA legs, skipping helper compilation during promotion', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ['nightly', 'latest']);
  assert.equal(workflow.on.workflow_dispatch.inputs.channel.default, 'nightly');
  for (const name of ['helper_linux', 'helper_macos']) assert.match(workflow.jobs[name].if, /channel == 'nightly'/);
  for (const name of ['mobile_ota', 'mobile_ota_after_proof']) {
    const action = workflow.jobs[name].steps.find(s => s.uses === './.github/actions/mobile-ota-leg');
    assert.equal(action.with.beta_channel, 'nightly');
    assert.equal(action.with.promote, 'false');
    assert.match(action.with.mode, /latest.*promote/);
  }
  const config = JSON.parse(readFileSync('apps/mobile/eas.json'));
  assert.equal(config.build['nightly-ci'], undefined);
  const profile = androidReleaseProfile(config, 'nightly').config.build['nightly-ci'];
  assert.equal(profile.extends, 'production-ci');
  assert.equal(profile.channel, 'nightly');
  assert.equal(profile.env, undefined);
  const ota = parse(readFileSync('.github/actions/mobile-ota-leg/action.yml', 'utf8'));
  assert.equal(ota.runs.steps.find(s => s.id === 'publish').if, "inputs.mode == 'publish'");
  assert.match(workflow.jobs.release_result.steps.find(s => s.name?.startsWith('Publish the nightly record')).run, /--prerelease --latest=false/);
  assert.match(readFileSync('scripts/gh-release-retry.sh', 'utf8'), /--prerelease=false --latest/);
});

function bundle(directory, version, sourceCommit) {
  mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(`exact archive ${version}`);
  const file = 'beeline-linux-x64.tar.gz';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = { schemaVersion: 1, version, sourceCommit, bundles: { 'linux-x64': {
    file, sha256, bytes: bytes.length, verified: true, commit: sourceCommit, version,
  } } };
  writeFileSync(join(directory, file), bytes);
  writeFileSync(join(directory, `${file}.sha256`), `${sha256}  ${file}\n`);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

test('Pages preserves stable website and latest bytes while serving nightly beside them', () => fixture(async directory => {
  const latestDir = join(directory, 'latest'), nightlyDir = join(directory, 'nightly');
  const latest = bundle(latestDir, 'v0.1.1', previousSha), nightly = bundle(nightlyDir, 'v0.1.2', sha);
  const outputRoot = join(directory, 'site');
  await buildPagesSite({ sourceRoot: 'web', bundleRoot: latestDir, nightlyBundleRoot: nightlyDir, outputRoot });
  assert.deepEqual(JSON.parse(readFileSync(join(outputRoot, 'dl/manifest.json'))), latest);
  assert.deepEqual(JSON.parse(readFileSync(join(outputRoot, 'dl/nightly/manifest.json'))), nightly);
  assert.deepEqual(readFileSync(join(outputRoot, 'index.html')), readFileSync('web/index.html'));
  assert.deepEqual(readFileSync(join(outputRoot, 'dl/nightly/beeline-linux-x64.tar.gz')), readFileSync(join(nightlyDir, 'beeline-linux-x64.tar.gz')));
}));

test('durable helper channels round-trip and promote the exact validated bytes', () => fixture(async directory => {
  const releases = new Map(), payloads = new Map(); let nextId = 1;
  const github = { rest: { repos: {
    async getReleaseByTag({ tag }) { if (!releases.has(tag)) throw Object.assign(new Error('absent'), { status: 404 }); return { data: releases.get(tag) }; },
    async createRelease(input) { const data = { ...input, id: nextId++, assets: [] }; releases.set(input.tag_name, data); return { data }; },
    async uploadReleaseAsset({ release_id, name, data }) { const id = nextId++; payloads.set(id, data); [...releases.values()].find(r => r.id === release_id).assets.push({ name, id }); },
    async getReleaseAsset({ asset_id }) { if (!payloads.has(asset_id)) throw Object.assign(new Error('missing asset'), { status: 404 }); return { data: payloads.get(asset_id) }; },
    async deleteReleaseAsset({ asset_id }) { for (const r of releases.values()) r.assets = r.assets.filter(a => a.id !== asset_id); },
  } } };
  assert.equal(await downloadPagesChannel({ github, repo: {}, channel: 'nightly', allowMissing: true, directory: join(directory, 'absent') }), null);
  const candidate = join(directory, 'candidate'); const expected = bundle(candidate, 'v0.1.2', sha);
  await publishPagesChannel({ github, repo: {}, channel: 'nightly', directory: candidate });
  const downloaded = join(directory, 'downloaded');
  assert.deepEqual(await downloadPagesChannel({ github, repo: {}, channel: 'nightly', directory: downloaded }), expected);
  await publishPagesChannel({ github, repo: {}, directory: downloaded });
  assert.equal(releases.get(pagesChannelTag()).prerelease, true);
  assert.equal(releases.get(pagesChannelTag()).make_latest, 'false');
  const promoted = join(directory, 'promoted');
  await downloadPagesChannel({ github, repo: {}, directory: promoted });
  for (const name of ['manifest.json', 'beeline-linux-x64.tar.gz', 'beeline-linux-x64.tar.gz.sha256'])
    assert.deepEqual(readFileSync(join(promoted, name)), readFileSync(join(candidate, name)));
  assert.throws(() => pagesChannelTag('../escape'), /invalid helper channel/);
  payloads.delete(releases.get(pagesChannelTag('nightly')).assets.find(a => a.name === 'manifest.json').id);
  await assert.rejects(downloadPagesChannel({ github, repo: {}, channel: 'nightly', allowMissing: true, directory: downloaded }), /missing asset/);
}));

test('a nightly at the promoted SHA gets a fresh prerelease identity and cannot demote latest', () => {
  const previous = delivered('v0.1.2', sha);
  previous.channel = 'latest'; previous.promotedFrom = previous.version;
  const releases = [{ tag_name: previous.version, target_commitish: sha, draft: false, prerelease: false }];
  const { version } = assignReleaseVersion({ releases, previous, sha, reusePublished: false });
  assert.equal(version, 'v0.1.3');
  const nightly = initializeRelease({ version, sourceSha: sha, previous, channel: 'nightly', selectedComponents: ['server'] });
  assert.equal(nightly.state, 'planned');
  assert.equal(nightly.version, version);
  nightly.state = 'delivered';
  const promoted = initializeRelease({ version, sourceSha: sha, previous, nightly, channel: 'latest',
    selectedComponents: channelComponents([], { channel: 'latest' }) });
  assert.equal(promoted.state, 'planned');
  assert.equal(promoted.channel, 'latest');
});


test('nightly reads Play beta and production; latest reads production alone', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = JSON.stringify({ type: 'service_account', client_email: 'fixture@example.test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  for (const channel of ['nightly', 'latest']) {
    const requests = [];
    const stores = await readStores({
      env: { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: key, BEELINE_RELEASE_CHANNEL: channel },
      builds: [{ platform: 'android', buildNumber: '10', runtimeVersion: '1' }, { platform: 'android', buildNumber: '11', runtimeVersion: '4' }],
      appleApi: async () => ({ data: [] }),
      fetchImpl: async url => {
        if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'fixture' }));
        requests.push(url);
        const track = url.includes('/beta/') ? 'beta' : 'production';
        return new Response(JSON.stringify({ releases: [{ track,
          releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode: track === 'beta' ? '11' : '10' }] }] }));
      },
    });
    assert.equal(stores.android.status, 'readable');
    assert.equal(requests.length, channel === 'nightly' ? 2 : 1);
    assert.deepEqual(stores.android.live.map(t => t.runtimeVersion), channel === 'nightly' ? ['1', '4'] : ['1']);
  }
});

test('nightly OTA retains production and beta live runtimes even across a larger runtime gap', () => {
  const live = [1, 2, 3, 4].map(n => ({ platform: 'android', runtimeVersion: String(n) }));
  const { targets } = computeTargets({ pins: { android: '4', ios: '1' }, includeAllAndroidLive: true,
    stores: { android: { status: 'readable', live, latestRuntimeVersion: '4' },
      ios: { status: 'readable', live: [{ platform: 'ios', runtimeVersion: '1' }] } } });
  assert.deepEqual(targets.filter(t => t.platform === 'android').map(t => t.runtimeVersion).sort(), ['1', '2', '3', '4']);
});


test('OTA promotion points production at the exact nightly groups without exporting or uploading', () => fixture(directory => {
  const eas = join(directory, 'eas-stub.mjs');
  const calls = join(directory, 'calls.jsonl');
  const pointer = join(directory, 'pointer.txt');
  const branch = 'release-v0.1.2';
  const updates = ['android', 'ios'].map((platform, i) => ({ platform, runtimeVersion: String(i + 1),
    group: `immutable-nightly-group-${platform}`, message: `release ${sha.slice(0, 12)} ${platform}@${i + 1}` }));
  writeFileSync(eas, String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\n');
if (args[0] === 'update:list') console.log(JSON.stringify(${JSON.stringify(updates)}));
else if (args[0] === 'channel:view') console.log(JSON.stringify({ name:'production',
  branchMapping:{ data:[{ branchId:'pointer',branchMappingLogic:'true' }] },
  updateBranches:[{ id:'pointer',name:existsSync(${JSON.stringify(pointer)}) ? readFileSync(${JSON.stringify(pointer)},'utf8') : 'release-v0.1.1' }] }));
else if (args[0] === 'channel:edit') { writeFileSync(${JSON.stringify(pointer)}, args[args.indexOf('--branch')+1]); console.log('{}'); }
else { console.error('unexpected command: ' + args[0]); process.exit(1); }
`);
  chmodSync(eas, 0o755);
  writeFileSync(join(directory, 'targets.json'), JSON.stringify({ targets: updates.map(({ platform, runtimeVersion }) => ({ platform, runtimeVersion })) }));
  execFileSync(process.execPath, ['scripts/ota-release.mjs', 'promote', '--sha', sha, '--branch', branch,
    '--channel', 'production', '--targets', join(directory, 'targets.json'), '--output', join(directory, 'facts.json')],
  { cwd: 'apps/mobile', env: { ...process.env, EAS_CLI_PATH: eas }, encoding: 'utf8' });
  const facts = JSON.parse(readFileSync(join(directory, 'facts.json')));
  assert.deepEqual(facts.groups, { 'android@1': 'immutable-nightly-group-android', 'ios@2': 'immutable-nightly-group-ios' });
  assert.equal(readFileSync(pointer, 'utf8'), branch);
  const commands = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)[0]);
  assert.deepEqual(commands, ['update:list', 'channel:view', 'channel:edit', 'channel:view']);
}));

test('an explicit store build cannot reuse a binary subscribed to the other OTA channel', () => {
  const nightly = nightlyRecord();
  nightly.components['mobile-native'].storeTrack = 'beta';
  const latest = initializeRelease({ version: nightly.version, sourceSha: sha, previous: delivered(), nightly,
    channel: 'latest', selectedComponents: channelComponents([], { channel: 'latest' }) });
  latest.state = 'delivered';
  for (const entry of Object.values(latest.components)) if (entry.selected) entry.state = 'checked';
  latest.components['mobile-native'].storeTrack = 'beta';
  const native = initializeRelease({ version: latest.version, sourceSha: sha, previous: latest, nightly,
    channel: 'latest', selectedComponents: channelComponents([], { channel: 'latest', storeTrack: 'production' }) });
  assert.equal(native.state, 'planned');
  assert.equal(native.components['mobile-native'].state, 'pending');
  assert.deepEqual(native.plan.selected, ['mobile-native']);
  assert.deepEqual(native.plan.nativePlatforms, ['android', 'ios']);
  const needs = { initialize: { outputs: { run_mobile_native: 'true', native_android: 'true', native_ios: 'true' } },
    mobile_native_android: { result: 'success', outputs: { version_code: '100' } },
    mobile_native_ios: { result: 'success', outputs: { build_number: '100' } } };
  applyComponentCheckpoints(native, checkpointsFromJobs(needs, { version: native.version, sourceSha: sha, releaseId: 'fixture' }));
  applyJobFacts(native, needs, { previous: latest, runtimePins: { android: '1', ios: '2' } });
  assert.equal(native.components['mobile-native'].storeTrack, 'production');
  assert.equal(native.components.server.selected, false);
  const beta = initializeRelease({ version: nightly.version, sourceSha: sha, previous: nightly,
    channel: 'nightly', selectedComponents: channelComponents(['mobile-native'], { storeTrack: 'beta' }) });
  assert.equal(beta.state, 'delivered'); // This beta identity already shipped.
  beta.components['mobile-native'].storeTrack = 'production';
  const missingBeta = initializeRelease({ version: nightly.version, sourceSha: sha, previous: beta,
    channel: 'nightly', selectedComponents: channelComponents(['mobile-native'], { storeTrack: 'beta' }) });
  assert.equal(missingBeta.components['mobile-native'].state, 'pending');
  assert.deepEqual(missingBeta.plan.nativePlatforms, ['android']);
});

test('a delivered no-op needs no outputs from skipped jobs', () => {
  const previous = nightlyRecord();
  const state = initializeRelease({ version: previous.version, sourceSha: sha, previous, channel: 'nightly', selectedComponents: ['server'] });
  assert.equal(state.state, 'delivered');
  assert.equal(applyJobFacts(state, {}, { previous }), state);
});




test('Android channel injection is temporary and leaves production config bytes unchanged', () => fixture(directory => {
  const file = join(directory, 'eas.json');
  const productionBytes = readFileSync('apps/mobile/eas.json');
  writeFileSync(file, productionBytes);
  const selected = execFileSync(process.execPath, ['scripts/android-release-channel.mjs', file, 'latest'], { encoding: 'utf8' }).trim();
  assert.equal(selected, 'production-ci');
  assert.deepEqual(readFileSync(file), productionBytes);
  const nightly = execFileSync(process.execPath, ['scripts/android-release-channel.mjs', file, 'nightly'], { encoding: 'utf8' }).trim();
  assert.equal(nightly, 'nightly-ci');
  const temporary = JSON.parse(readFileSync(file));
  assert.deepEqual(temporary.build['nightly-ci'], { extends: 'production-ci', channel: 'nightly' });
  delete temporary.build['nightly-ci'];
  assert.deepEqual(temporary, JSON.parse(productionBytes));
  assert.equal(JSON.parse(productionBytes).build['nightly-ci'], undefined);
}));
