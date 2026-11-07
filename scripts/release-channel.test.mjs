import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { parse } from 'yaml';
import { releaseChannel, channelComponents, promotionSource } from './release-channel.mjs';
import { initializeRelease, planOutputs, restoreReleasePlan, applyJobFacts, applyComponentCheckpoints, checkpointsFromJobs } from './unified-release.mjs';
import { latestPublished, assignReleaseVersion, compareVersions, versionedReleases, staleDrafts } from './release-record.mjs';
import { pagesChannelTag, publishPagesChannel, downloadPagesChannel } from './pages-channel.mjs';
import { buildPagesSite } from './pages-site.mjs';
import { readStores } from './read-store-runtimes.mjs';
import { androidReleaseProfile } from './android-release-channel.mjs';
import { computeTargets } from '../apps/mobile/scripts/ota-release.mjs';
import { playLiveBuilds } from '../apps/mobile/scripts/store-runtime-targets.mjs';

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
// Unit fixture identities must work in CI's single-commit checkout.
const previousSha = 'a'.repeat(40);
const delivered = (version = 'v0.1.1', sourceSha = previousSha) => {
  const record = initializeRelease({ version, sourceSha });
  record.state = 'delivered';
  record.delivery.state = 'success';
  for (const entry of Object.values(record.components)) entry.state = 'checked';
  Object.assign(record.components['mobile-ota'], { otaBranch: 'release-v0.1.1', otaTargets: ['android@1', 'ios@2'] });
  record.components.server.imageRef = 'registry.fly.io/beeline-server:previous';
  return record;
};
const nextRecord = () => {
  const record = delivered('v0.1.2-rc.3', sha);
  record.channel = 'next';
  record.components.desktop = delivered().components.desktop;
  record.components.website = delivered().components.website;
  record.components['mobile-ota'].otaBranch = 'release-v0.1.2-rc.3';
  return record;
};
const fixture = (fn) => {
  const directory = mkdtempSync(join(process.cwd(), '.release-channel-test-'));
  return Promise.resolve().then(() => fn(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
};
const workflow = parse(readFileSync('.github/workflows/unified-release.yml', 'utf8'));

test('channel defaults to next; native consent and latest selection stay separate', () => {
  assert.equal(releaseChannel(), 'next');
  assert.throws(() => releaseChannel('beta'), /invalid release channel/);
  assert.deepEqual(channelComponents(['helper', 'mobile-ota', 'desktop', 'website']), ['server', 'helper', 'mobile-ota']);
  assert.deepEqual(channelComponents(['mobile-native'], { storeTrack: 'beta' }), ['server', 'helper', 'mobile-ota', 'mobile-native']);
  assert.throws(() => channelComponents(['mobile-native']), /explicit store_track=beta/);
  assert.throws(() => channelComponents([], { storeTrack: 'production' }), /store_track=beta/);
  assert.deepEqual(channelComponents([], { channel: 'latest' }), ['helper', 'mobile-ota', 'desktop', 'website']);
  assert.throws(() => channelComponents([], { channel: 'latest', storeTrack: 'beta' }), /cannot publish/);
});

test('retired nightly channel is rejected without aliases', () => {
  assert.throws(() => releaseChannel('nightly'), /invalid release channel/);
  assert.throws(() => channelComponents([], { channel: 'nightly' }), /invalid release channel/);
  assert.throws(() => pagesChannelTag('nightly'), /invalid helper channel/);
  assert.equal(pagesChannelTag('next'), 'helper-update-channel-next');
  assert.throws(() => androidReleaseProfile({}, 'nightly'), /invalid Android release channel/);
  assert.throws(() => promotionSource({ ...nextRecord(), channel: 'nightly' }), /successfully published next/);
});

test('promotion pins a successful rc commit and strips its suffix', () => {
  const next = nextRecord();
  assert.equal(promotionSource(next).sourceSha, sha);
  assert.throws(() => promotionSource(next, previousSha), /current next source SHA/);
  assert.throws(() => promotionSource(delivered()), /successfully published next/);
  assert.equal(promotionSource(next).version, 'v0.1.2');
  assert.throws(() => promotionSource({ ...next, version: 'v0.1.2' }), /next rc version/);
  assert.throws(() => promotionSource({ ...next, version: 'v0.1.2-rc3' }), /next rc version/);
});

test('next release records cannot become GitHub latest; identities include reserved next releases', () => {
  const stable = { tag_name: 'v0.1.1', target_commitish: previousSha, published_at: '2026-01-01', draft: false, prerelease: false };
  const next = { tag_name: 'v0.1.2-rc.3', target_commitish: sha, published_at: '2026-01-02', draft: false, prerelease: true };
  const rolling = { tag_name: pagesChannelTag('next'), published_at: '2026-01-03', prerelease: true };
  assert.equal(latestPublished([stable, next, rolling]).tag_name, stable.tag_name);
  assert.equal(latestPublished([stable, next, rolling], 'next').tag_name, next.tag_name);
  assert.equal(assignReleaseVersion({ releases: [stable, next], previous: delivered(), sha: 'c'.repeat(40) }).version, 'v0.1.2-rc.4');
});

test('rc versions sort numerically, below their final, and drafts reserve rc counters', () => {
  const release = (tag_name, target_commitish = previousSha, draft = false) => ({ tag_name, target_commitish, draft });
  const releases = ['v0.1.184-rc.9', 'v0.1.184', 'v0.1.184-rc.10', 'v0.1.184-rc.2'].map(v => release(v));
  assert.deepEqual(versionedReleases(releases).map(r => r.tag_name),
    ['v0.1.184', 'v0.1.184-rc.10', 'v0.1.184-rc.9', 'v0.1.184-rc.2']);
  assert.ok(compareVersions('v0.1.184-rc.10', 'v0.1.184-rc.9') > 0);
  assert.ok(compareVersions('v0.1.184-rc.10', 'v0.1.184') < 0);
  const previous = delivered('v0.1.183');
  assert.equal(assignReleaseVersion({ releases: [], previous, sha }).version, 'v0.1.184-rc.1');
  const reserved = [release('v0.1.184-rc.9'), release('v0.1.184-rc.10', previousSha, true)];
  assert.equal(assignReleaseVersion({ releases: reserved, previous, sha }).version, 'v0.1.184-rc.11');
  reserved.push(release('v0.1.184-rc.11', sha, true));
  assert.equal(assignReleaseVersion({ releases: reserved, previous, sha }).reason, 'resume-draft');
  assert.deepEqual(staleDrafts(reserved, 'v0.1.184').map(r => r.tag_name), ['v0.1.184-rc.11', 'v0.1.184-rc.10']);
  reserved.push(release('v0.1.184', previousSha, true));
  assert.equal(assignReleaseVersion({ releases: reserved, previous, sha }).version, 'v0.1.185-rc.1');
  const next = nextRecord();
  assert.equal(assignReleaseVersion({ releases: [], previous: next, sha }).reason, 'already-published');
  assert.equal(assignReleaseVersion({ releases: [], previous: next, sha: previousSha }).version, 'v0.1.2-rc.4');
  assert.throws(() => assignReleaseVersion({ releases: [], previous, sha, requestedVersion: 'v0.1.184' }), /requires an rc/);
  assert.throws(() => assignReleaseVersion({ releases: [], previous, sha, requestedVersion: 'v0.1.184-rc10' }), /requires an rc/);
});

test('latest reserves the final at the rc source and rejects a conflicting identity', () => {
  const next = nextRecord();
  const assign = options => assignReleaseVersion({ releases: [], channel: 'latest', next, sha, ...options });
  assert.deepEqual(assign({}), { version: 'v0.1.2', reason: 'promotion' });
  assert.equal(assign({ releases: [{ tag_name: 'v0.1.2', target_commitish: sha, draft: true }] }).reason, 'existing-identity');
  assert.throws(() => assign({ releases: [{ tag_name: 'v0.1.2', target_commitish: previousSha }] }), /another commit|not/);
  assert.throws(() => assign({ sha: previousSha }), /current next source SHA/);
  assert.throws(() => assign({ requestedVersion: next.version }), /final version/);
});

test('the workflow publishes rc with next and final with the default npm tag, using OIDC', () => fixture(directory => {
  const publish = workflow.jobs.helper.steps.find(s => s.name === 'Publish the exact helper CLI package');
  assert.equal(publish.if, undefined);
  assert.equal(workflow.jobs.helper.permissions['id-token'], 'write');
  const calls = join(directory, 'npm-calls.jsonl');
  writeFileSync(join(directory, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'view') process.exit(1);
`);
  chmodSync(join(directory, 'npm'), 0o755);
  for (const channel of ['next', 'latest']) {
    writeFileSync(calls, '');
    const version = channel === 'next' ? 'v0.1.184-rc.10' : 'v0.1.184';
    const tarball = join(directory, `usebeeline-${version.slice(1)}.tgz`);
    execFileSync('bash', ['-c', publish.run], { env: { ...process.env,
      PATH: `${directory}:${process.env.PATH}`, CALLS: calls, CHANNEL: channel, RELEASE_VERSION: version, HELPER_TARBALL: tarball } });
    const commands = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(commands.find(c => c[0] === 'view'), ['view', `usebeeline@${version.slice(1)}`, 'version']);
    assert.deepEqual(commands.find(c => c[0] === 'publish'),
      ['publish', '--no-provenance', ...(channel === 'next' ? ['--tag', 'next'] : []), tarball]);
    assert.equal(commands.some(c => c[0] === 'dist-tag'), false);
  }
}));

for (const channel of ['next', 'latest']) test(`offline workflow plan: ${channel}`, () => fixture(directory => {
  const previous = delivered();
  // The CLI reads native pins with git show. Both fixture releases use the
  // current pins, so HEAD supplies that input without requiring its parent.
  previous.sourceSha = sha;
  const next = nextRecord();
  writeFileSync(join(directory, 'previous.json'), JSON.stringify(previous));
  writeFileSync(join(directory, 'next.json'), JSON.stringify(next));
  writeFileSync(join(directory, 'paths.txt'), 'apps/body/src/self-update-manifest.ts\napps/mobile/sources/app/index.tsx\n');
  const args = ['scripts/unified-release.mjs', 'plan', '--version', channel === 'next' ? next.version : promotionSource(next).version, '--sha', sha,
    '--paths', join(directory, 'paths.txt'), '--previous', join(directory, 'previous.json'),
    '--channel', channel, '--state', join(directory, 'state.json'), '--outputs', join(directory, 'outputs.txt')];
  if (channel === 'latest') args.push('--next', join(directory, 'next.json'));
  const output = execFileSync(process.execPath, args, { encoding: 'utf8' });
  const plan = JSON.parse(output.trim().split('\n').at(-1));
  console.log(`${channel} component plan: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.selected, channel === 'next' ? ['server', 'helper', 'mobile-ota'] : ['helper', 'mobile-ota', 'desktop', 'website']);
  const state = JSON.parse(readFileSync(join(directory, 'state.json')));
  assert.deepEqual(state.plan.nativePlatforms, channel === 'next' ? ['android'] : ['android', 'ios']);
  const outputs = Object.fromEntries(readFileSync(join(directory, 'outputs.txt'), 'utf8').trim().split('\n').map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  const restored = restoreReleasePlan({ version: state.version, sourceSha: sha, plan: outputs, previous, next: channel === 'latest' ? next : undefined });
  assert.equal(restored.channel, channel);
  assert.deepEqual(restored.plan.selected, state.plan.selected);
  if (channel === 'latest') {
    assert.equal(outputs.ota_branch, undefined);
    assert.equal(restored.components.helper.version, 'v0.1.2');
    assert.equal(restored.components.server.imageRef, next.components.server.imageRef);
  }
}));

test('promotion rebuilds helper and OTA with the final version at the rc commit', () => {
  const previous = delivered();
  const next = nextRecord();
  const version = promotionSource(next).version;
  const state = initializeRelease({ version, sourceSha: sha, previous, next,
    channel: 'latest', selectedComponents: channelComponents([], { channel: 'latest' }) });
  const needs = { initialize: { outputs: { run_helper: 'true', run_mobile_ota: 'true' } }, helper: { result: 'success' }, mobile_ota: { result: 'success', outputs: {
    ota_branch: `release-${version}`, ota_targets: 'android@1,ios@2',
  } } };
  applyComponentCheckpoints(state, checkpointsFromJobs(needs, { version, sourceSha: sha, releaseId: 'fixture' }));
  applyJobFacts(state, needs, { previous });
  for (const component of ['helper', 'mobile-ota']) {
    assert.equal(state.components[component].sourceSha, sha);
    assert.equal(state.components[component].version, version);
  }
  assert.equal(state.components['mobile-ota'].otaBranch, `release-${version}`);
  assert.equal(state.components.server.version, next.version);
  assert.equal(state.components.server.selected, false);
  assert.throws(() => initializeRelease({ version: next.version, sourceSha: sha, previous, next, channel: 'latest' }), /final version/);
});

test('workflow rebuilds both channels and preserves native beta selection', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ['next', 'latest']);
  assert.equal(workflow.on.workflow_dispatch.inputs.channel.default, 'next');
  for (const name of ['helper_linux', 'helper_macos']) assert.equal(workflow.jobs[name].if, "needs.release_validation.result == 'success' && needs.initialize.outputs.run_helper == 'true'");
  for (const name of ['mobile_ota', 'mobile_ota_after_proof']) {
    const action = workflow.jobs[name].steps.find(s => s.uses === './.github/actions/mobile-ota-leg');
    assert.match(action.with.channel, /channel == 'next' && 'next' \|\| 'production'/);
    assert.equal(action.with.mode, undefined);
    assert.equal(action.with.targets, undefined);
  }
  const config = JSON.parse(readFileSync('apps/mobile/eas.json'));
  assert.equal(config.build['next-ci'], undefined);
  const profile = androidReleaseProfile(config, 'next').config.build['next-ci'];
  assert.equal(profile.extends, 'production-ci');
  assert.equal(profile.channel, 'next');
  assert.equal(profile.env, undefined);
  const ota = parse(readFileSync('.github/actions/mobile-ota-leg/action.yml', 'utf8'));
  assert.equal(ota.runs.steps.find(s => s.id === 'publish').if, undefined);
  assert.equal(ota.inputs.mode, undefined);
  assert.equal(workflow.jobs.helper.steps.some(s => /exact next helper/.test(s.name)), false);
  const nextPublication = workflow.jobs.release_result.steps.find(s => s.name?.startsWith('Publish the next record'));
  assert.match(nextPublication.run, /--prerelease --latest=false/);
  assert.match(nextPublication.if, /channel == 'next'/);
  assert.match(readFileSync('scripts/gh-release-retry.sh', 'utf8'), /--prerelease=false --latest/);
});

test('next helper checks and publication verify the public manifest without a Pages redirect', () => {
  const manifests = Object.values(workflow.jobs).flatMap(job => job.steps ?? [])
    .map(step => step.env?.MANIFEST_URL ?? step.with?.pages_manifest_url ?? step.with?.manifest_url)
    .filter(value => value?.includes("channel == 'next'"));
  assert.equal(manifests.length, 5); // Linux/Mac reuse, helper/website publication, release notification.
  for (const manifest of manifests) {
    assert.match(manifest, /channel == 'next' && 'https:\/\/usebeeline\.app\/dl\/next\/manifest\.json'/);
    assert.doesNotMatch(manifest, /github\.io\/beeline\/dl\/next/);
  }
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

test('Pages preserves stable website and latest bytes while serving next beside them', () => fixture(async directory => {
  const latestDir = join(directory, 'latest'), nextDir = join(directory, 'next');
  const latest = bundle(latestDir, 'v0.1.1', previousSha), next = bundle(nextDir, 'v0.1.2', sha);
  const outputRoot = join(directory, 'site');
  await buildPagesSite({ sourceRoot: 'web', bundleRoot: latestDir, nextBundleRoot: nextDir, outputRoot });
  assert.deepEqual(JSON.parse(readFileSync(join(outputRoot, 'dl/manifest.json'))), latest);
  assert.deepEqual(JSON.parse(readFileSync(join(outputRoot, 'dl/next/manifest.json'))), next);
  assert.deepEqual(readFileSync(join(outputRoot, 'index.html')), readFileSync('web/index.html'));
  const html = readFileSync(join(outputRoot, 'index.html'), 'utf8');
  const imagePath = 'og-4-bold-color-v2.png';
  const imageUrl = `https://usebeeline.app/${imagePath}`;
  assert.ok(html.includes(`<meta property="og:image" content="${imageUrl}">`));
  assert.ok(html.includes(`<meta name="twitter:image" content="${imageUrl}">`));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const committedHash = hash(readFileSync(join('web', imagePath)));
  assert.equal(committedHash, '6342a59cfe7ac6d1bc811e1643aa3e3594023e8052227f33bf85a8af40245f94');
  assert.equal(hash(readFileSync(join(outputRoot, imagePath))), committedHash);
  const server = createServer((request, response) => {
    const image = request.url === `/${imagePath}`;
    response.setHeader('Content-Type', image ? 'image/png' : 'text/html');
    response.end(readFileSync(join(outputRoot, image ? imagePath : 'index.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const servedHtml = await (await fetch(origin)).text();
    assert.equal(servedHtml, html);
    const publicImage = new URL(servedHtml.match(/property="og:image" content="([^"]+)"/)[1]);
    const servedImage = await fetch(`${origin}${publicImage.pathname}`);
    assert.equal(servedImage.status, 200);
    assert.equal(servedImage.headers.get('content-type'), 'image/png');
    assert.equal(hash(Buffer.from(await servedImage.arrayBuffer())), committedHash);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(readFileSync(join(outputRoot, 'dl/next/beeline-linux-x64.tar.gz')), readFileSync(join(nextDir, 'beeline-linux-x64.tar.gz')));
}));

test('durable helper channels retain separately stamped rc and final archives', () => fixture(async directory => {
  const releases = new Map(), payloads = new Map(); let nextId = 1;
  const github = { rest: { repos: {
    async getReleaseByTag({ tag }) { if (!releases.has(tag)) throw Object.assign(new Error('absent'), { status: 404 }); return { data: releases.get(tag) }; },
    async createRelease(input) { const data = { ...input, id: nextId++, assets: [] }; releases.set(input.tag_name, data); return { data }; },
    async uploadReleaseAsset({ release_id, name, data }) { const id = nextId++; payloads.set(id, data); [...releases.values()].find(r => r.id === release_id).assets.push({ name, id }); },
    async getReleaseAsset({ asset_id }) { if (!payloads.has(asset_id)) throw Object.assign(new Error('missing asset'), { status: 404 }); return { data: payloads.get(asset_id) }; },
    async deleteReleaseAsset({ asset_id }) { for (const r of releases.values()) r.assets = r.assets.filter(a => a.id !== asset_id); },
  } } };
  assert.equal(await downloadPagesChannel({ github, repo: {}, channel: 'next', allowMissing: true, directory: join(directory, 'absent') }), null);
  const candidate = join(directory, 'candidate'); const expected = bundle(candidate, 'v0.1.2-rc.3', sha);
  await publishPagesChannel({ github, repo: {}, channel: 'next', directory: candidate });
  const downloaded = join(directory, 'downloaded');
  assert.deepEqual(await downloadPagesChannel({ github, repo: {}, channel: 'next', directory: downloaded }), expected);
  const final = join(directory, 'final');
  bundle(final, 'v0.1.2', sha);
  await publishPagesChannel({ github, repo: {}, directory: final });
  assert.equal(releases.get(pagesChannelTag()).prerelease, true);
  assert.equal(releases.get(pagesChannelTag()).make_latest, 'false');
  const promoted = join(directory, 'promoted');
  await downloadPagesChannel({ github, repo: {}, directory: promoted });
  for (const name of ['manifest.json', 'beeline-linux-x64.tar.gz', 'beeline-linux-x64.tar.gz.sha256'])
    assert.deepEqual(readFileSync(join(promoted, name)), readFileSync(join(final, name)));
  assert.notDeepEqual(readFileSync(join(promoted, 'beeline-linux-x64.tar.gz')), readFileSync(join(downloaded, 'beeline-linux-x64.tar.gz')));
  assert.throws(() => pagesChannelTag('../escape'), /invalid helper channel/);
  payloads.delete(releases.get(pagesChannelTag('next')).assets.find(a => a.name === 'manifest.json').id);
  await assert.rejects(downloadPagesChannel({ github, repo: {}, channel: 'next', allowMissing: true, directory: downloaded }), /missing asset/);
}));

test('a next at the promoted SHA gets a fresh prerelease identity and cannot demote latest', () => {
  const previous = delivered('v0.1.2', sha);
  previous.channel = 'latest'; previous.promotedFrom = 'v0.1.2-rc.3';
  const releases = [{ tag_name: previous.version, target_commitish: sha, draft: false, prerelease: false }];
  const { version } = assignReleaseVersion({ releases, previous, sha });
  assert.equal(version, 'v0.1.3-rc.1');
  const next = initializeRelease({ version, sourceSha: sha, previous, channel: 'next', selectedComponents: ['server'] });
  assert.equal(next.state, 'planned');
  assert.equal(next.version, version);
  next.state = 'delivered';
  const promoted = initializeRelease({ version: promotionSource(next).version, sourceSha: sha, previous, next, channel: 'latest',
    selectedComponents: channelComponents([], { channel: 'latest' }) });
  assert.equal(promoted.state, 'planned');
  assert.equal(promoted.channel, 'latest');
});


const { privateKey: playPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const playKey = JSON.stringify({ type: 'service_account', client_email: 'fixture@example.test',
  private_key: playPrivateKey.export({ type: 'pkcs8', format: 'pem' }) });
const storeBuilds = [{ platform: 'android', buildNumber: '144', runtimeVersion: '44' },
  { platform: 'android', buildNumber: '146', runtimeVersion: '47' }];
const liveRelease = (track, versionCode) => ({ track,
  releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode }] });
const iosStore = { status: 'readable', live: [{ platform: 'ios', runtimeVersion: '36' }] };
const storeMemory = { previouslyLive: ['39', '40'].map(runtimeVersion => ({ platform: 'android', runtimeVersion })),
  previousTargets: ['44', '40', '39'].map(runtimeVersion => ({ platform: 'android', runtimeVersion })) };
const planStoreTargets = (stores, channel) => computeTargets({ pins: { android: '47', ios: '38' },
  stores: { ...stores, ios: iosStore }, memory: storeMemory, channel }).targets.map(t => `${t.platform}@${t.runtimeVersion}`);

async function playStores(channel, responseForTrack, requests = []) {
  return readStores({ builds: storeBuilds,
    env: { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: playKey, BEELINE_RELEASE_CHANNEL: channel },
    appleApi: async () => ({ data: [] }),
    fetchImpl: async (url, options) => {
      if (url.includes('oauth2')) return Response.json({ access_token: 'fixture' });
      const track = new URL(url).pathname.split('/').at(-2);
      requests.push({ url, options, track });
      return responseForTrack(track);
    },
  });
}

test('next adds published Play beta runtime without evicting production retention; latest reads production alone', async () => {
  for (const channel of ['next', 'latest', 'production']) {
    const requests = [];
    const stores = await playStores(channel, track => Response.json({ releases: [
      liveRelease(track, track === 'beta' ? 146 : 144),
      { ...liveRelease(track, 999), releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_IN_REVIEW' },
    ] }), requests);
    assert.equal(stores.android.status, 'readable');
    assert.deepEqual(requests.map(r => r.track), channel === 'next' ? ['production', 'beta'] : ['production']);
    for (const request of requests) {
      assert.equal(request.options.headers.Accept, 'application/json');
      assert.equal(new URL(request.url).searchParams.get('alt'), 'json');
    }
    assert.deepEqual(stores.android.live.map(t => t.runtimeVersion), ['44']);
    assert.deepEqual(planStoreTargets(stores, channel), channel === 'next'
      ? ['android@44', 'android@40', 'android@39', 'android@47', 'ios@36']
      : ['android@44', 'android@40', 'android@39', 'ios@36']);
  }
});

test('a broken production response cannot hide a readable Play beta runtime', async () => {
  const requests = [];
  const stores = await playStores('next', track => track === 'production'
    ? new Response('', { status: 200, headers: { 'content-type': 'application/json' } })
    : Response.json({ releases: [liveRelease('beta', 146)] }), requests);
  assert.equal(stores.android.status, 'unavailable');
  assert.match(stores.android.reason, /Play production.*HTTP 200.*empty response body/);
  assert.deepEqual(requests.map(r => r.track), ['production', 'beta']);
  assert.deepEqual(planStoreTargets(stores, 'next'), ['android@44', 'android@40', 'android@39', 'android@47', 'ios@36']);
});

test('a broken beta response preserves production targets and reports its exact track and response failure', async () => {
  for (const [response, reason] of [
    [() => new Response(''), /empty response body/],
    [() => new Response('<html>gateway</html>', { headers: { 'content-type': 'text/html' } }), /invalid JSON.*text\/html/],
    [() => new Response('{"releases":['), /invalid JSON/],
    [() => new Response(new ReadableStream({ start(controller) { controller.error(new Error('terminated')); } })), /response body read failed/],
    [() => Response.json({ error: { message: 'denied' } }, { status: 403 }), /HTTP 403/],
    [() => Response.json({ releases: [liveRelease('beta', 999)] }), /Cannot prove runtime/],
  ]) {
    const requests = [];
    const stores = await playStores('next', track => track === 'beta' ? response()
      : Response.json({ releases: [liveRelease('production', 144)] }), requests);
    assert.equal(stores.android.status, 'readable');
    assert.match(stores.android.warnings.join(' '), /Play beta/);
    assert.match(stores.android.warnings.join(' '), reason);
    assert.deepEqual(planStoreTargets(stores, 'next'), ['android@44', 'android@40', 'android@39', 'ios@36']);
    assert.equal(requests.length, 2, 'one read per track, no retry');
  }
});

test('the Play reader waits for the complete response body before parsing JSON', async () => {
  const stores = await playStores('next', track => new Response(new ReadableStream({
    async start(controller) {
      const body = JSON.stringify({ releases: [liveRelease(track, track === 'beta' ? 146 : 144)] });
      controller.enqueue(new TextEncoder().encode(body.slice(0, 20)));
      await Promise.resolve();
      controller.enqueue(new TextEncoder().encode(body.slice(20)));
      controller.close();
    },
  }), { headers: { 'content-type': 'application/json' } }));
  assert.equal(stores.android.status, 'readable');
  assert.deepEqual(stores.android.betaLive.map(t => t.runtimeVersion), ['47']);
});

test('Play publication parsing excludes review, approved, draft and wrong-track releases', () => {
  const releases = ['DRAFT', 'IN_REVIEW', 'APPROVED_NOT_PUBLISHED'].map(state => ({
    ...liveRelease('beta', 147), releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
  }));
  assert.deepEqual(playLiveBuilds({ releases: [...releases, liveRelease('beta', 146)] }, 'beta'), ['146']);
  assert.throws(() => playLiveBuilds({ releases: [liveRelease('production', 146)] }, 'beta'), /Invalid Play beta/);
});

test('next keeps every live production runtime and deduplicates beta without polluting production history', () => {
  const live = ['44', '40', '39', '38'].map(runtimeVersion => ({ platform: 'android', runtimeVersion }));
  const stores = { android: { status: 'readable', live, latestRuntimeVersion: '44',
    betaLive: [{ platform: 'android', runtimeVersion: '47' }, ...live] }, ios: iosStore };
  const plan = computeTargets({ stores, memory: storeMemory, pins: { android: '47', ios: '38' }, channel: 'next' });
  assert.deepEqual(plan.targets.map(t => `${t.platform}@${t.runtimeVersion}`),
    ['android@44', 'android@40', 'android@39', 'android@38', 'android@47', 'ios@36']);
  assert.ok(!plan.previouslyLive.some(t => t.runtimeVersion === '47'));
  assert.deepEqual(planStoreTargets(stores, 'latest'), ['android@44', 'android@40', 'android@39', 'ios@36']);
});

test('a beta read failure retains the previous beta audience; a successful empty beta read does not', () => {
  const memory = { ...storeMemory, previousTargets: [...storeMemory.previousTargets,
    { platform: 'android', runtimeVersion: '47' }] };
  const android = { status: 'readable', live: [{ platform: 'android', runtimeVersion: '44' }] };
  for (const warnings of [undefined, ['Play beta HTTP 503']]) {
    const { targets } = computeTargets({ pins: { android: '47', ios: '38' }, channel: 'next', memory,
      stores: { android: { ...android, warnings, betaLive: [] }, ios: iosStore } });
    assert.equal(targets.some(t => t.runtimeVersion === '47'), !!warnings);
  }
  assert.equal(memory.previousTargets.length, 4);
});

test('targets CLI reports store failures in Actions and the summary while preserving delivery', () => fixture(directory => {
  const status = join(directory, 'stores.json'), memory = join(directory, 'memory.json');
  const summary = join(directory, 'summary.md'), output = join(directory, 'targets.json');
  writeFileSync(status, JSON.stringify({ stores: {
    android: { status: 'unavailable', reason: 'Play production HTTP 200: empty response body',
      betaLive: [{ platform: 'android', runtimeVersion: '47' }] }, ios: iosStore,
  } }));
  writeFileSync(memory, JSON.stringify(storeMemory));
  const result = spawnSync(process.execPath, ['scripts/ota-release.mjs', 'targets', '--channel', 'next',
    '--store-status', status, '--memory', memory, '--output', output], {
    cwd: 'apps/mobile', encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ota_targets=android@44,android@40,android@39,android@47,ios@36/);
  assert.match(result.stderr, /::warning::android store status unavailable/);
  assert.match(readFileSync(summary, 'utf8'), /OTA store runtime lookup warnings[\s\S]*Play production HTTP 200: empty response body/);
  assert.ok(JSON.parse(readFileSync(output)).targets.some(t => t.platform === 'android' && t.runtimeVersion === '47'));
}));

test('OTA rebuilds from the rc commit with the final stamp, then reuses only that final branch on rerun', () => fixture(directory => {
  const eas = join(directory, 'eas-stub.mjs');
  const calls = join(directory, 'eas-calls.jsonl');
  const store = join(directory, 'eas-state.json');
  writeFileSync(store, JSON.stringify({ branches: {}, channels: { next: 'release-v0.1.1', production: 'release-v0.1.1' } }));
  writeFileSync(eas, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
const state = JSON.parse(readFileSync(process.env.STUB_STATE, 'utf8'));
appendFileSync(process.env.STUB_CALLS, JSON.stringify({ args, version: process.env.EXPO_PUBLIC_BEELINE_RELEASE_VERSION, sha: process.env.EXPO_PUBLIC_BEELINE_RELEASE_SHA }) + '\\n');
const branch = value('--branch');
if (args[0] === 'update:list') console.log(JSON.stringify(state.branches[branch] ?? []));
else if (args[0] === 'update') {
  const update = { platform: value('--platform'), runtimeVersion: process.env.EXPO_RUNTIME_OVERRIDE,
    group: branch + '-' + value('--platform'), message: value('--message') };
  (state.branches[branch] ??= []).push(update);
  console.log(JSON.stringify([update]));
} else if (args[0] === 'channel:view') console.log(JSON.stringify({ name: args[1],
  branchMapping: { data: [{ branchMappingLogic: 'true', branchId: 'pointer' }] },
  updateBranches: [{ id: 'pointer', name: state.channels[args[1]] }] }));
else if (args[0] === 'channel:edit') { state.channels[args[1]] = branch; console.log('{}'); }
else { console.error('unexpected EAS command: ' + args[0]); process.exit(1); }
writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
`);
  chmodSync(eas, 0o755);
  const targets = join(directory, 'targets.json');
  writeFileSync(targets, JSON.stringify({ targets: [{ platform: 'android', runtimeVersion: '1' }, { platform: 'ios', runtimeVersion: '2' }] }));
  const publish = (version, channel) => execFileSync(process.execPath, ['scripts/ota-release.mjs', 'publish',
    '--sha', sha, '--release-version', version, '--channel', channel, '--targets', targets,
    '--output', join(directory, `${channel}-facts.json`)], { cwd: 'apps/mobile', encoding: 'utf8',
    env: { ...process.env, TMPDIR: directory, EAS_CLI_PATH: eas, STUB_STATE: store, STUB_CALLS: calls, SENTRY_AUTH_TOKEN: '' } });
  publish('v0.1.2-rc.3', 'next');
  publish('v0.1.2', 'production');
  const updates = () => readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.args[0] === 'update');
  assert.deepEqual(updates().map(c => c.version), ['v0.1.2-rc.3', 'v0.1.2-rc.3', 'v0.1.2', 'v0.1.2']);
  assert.ok(updates().every(c => c.sha === sha && c.args.includes('--clear-cache')));
  const state = JSON.parse(readFileSync(store, 'utf8'));
  assert.equal(state.channels.next, 'release-v0.1.2-rc.3');
  assert.equal(state.channels.production, 'release-v0.1.2');
  publish('v0.1.2', 'production');
  assert.equal(updates().length, 4);
}));


test('an explicit store build cannot reuse a binary subscribed to the other OTA channel', () => {
  const next = nextRecord();
  next.components['mobile-native'].storeTrack = 'beta';
  const latest = initializeRelease({ version: promotionSource(next).version, sourceSha: sha, previous: delivered(), next,
    channel: 'latest', selectedComponents: channelComponents([], { channel: 'latest' }) });
  latest.state = 'delivered';
  for (const entry of Object.values(latest.components)) if (entry.selected) entry.state = 'checked';
  latest.components['mobile-native'].storeTrack = 'beta';
  const native = initializeRelease({ version: latest.version, sourceSha: sha, previous: latest, next,
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
  const beta = initializeRelease({ version: next.version, sourceSha: sha, previous: next,
    channel: 'next', selectedComponents: channelComponents(['mobile-native'], { storeTrack: 'beta' }) });
  assert.equal(beta.state, 'delivered'); // This beta identity already shipped.
  beta.components['mobile-native'].storeTrack = 'production';
  const missingBeta = initializeRelease({ version: next.version, sourceSha: sha, previous: beta,
    channel: 'next', selectedComponents: channelComponents(['mobile-native'], { storeTrack: 'beta' }) });
  assert.equal(missingBeta.components['mobile-native'].state, 'pending');
  assert.deepEqual(missingBeta.plan.nativePlatforms, ['android']);
});

test('a delivered no-op needs no outputs from skipped jobs', () => {
  const previous = nextRecord();
  const state = initializeRelease({ version: previous.version, sourceSha: sha, previous, channel: 'next', selectedComponents: ['server'] });
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
  const next = execFileSync(process.execPath, ['scripts/android-release-channel.mjs', file, 'next'], { encoding: 'utf8' }).trim();
  assert.equal(next, 'next-ci');
  const temporary = JSON.parse(readFileSync(file));
  assert.deepEqual(temporary.build['next-ci'], { extends: 'production-ci', channel: 'next' });
  delete temporary.build['next-ci'];
  assert.deepEqual(temporary, JSON.parse(productionBytes));
  assert.equal(JSON.parse(productionBytes).build['next-ci'], undefined);
}));
