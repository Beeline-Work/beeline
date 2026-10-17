import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, verify } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appStoreClient, prepareUpload, verifyUpload, resolveStoreVersion } from './ios-store-build.mjs';

const started = Date.parse('2026-10-13T16:05:36Z');
const deliveryId = '919f9a1e-4397-43f9-8336-a20eac85d6bd';
const evidence = { bundleId: 'app.usebeeline.mobile', appVersion: '0.2.21', buildNumber: '87',
  appStore: { appId: '6803948500', uploadStartedAt: new Date(started).toISOString() } };
const receipt = { 'success-message': 'No errors uploading archive', details: { 'delivery-uuid': deliveryId } };
const upload = (state = 'COMPLETE', errors = []) => ({ data: { attributes: {
  cfBundleShortVersionString: '0.2.21', cfBundleVersion: '87', platform: 'IOS', state: { state, errors },
} } });
const builds = (attributes = {}, version = '0.2.21') => ({ data: [{ id: 'build-87',
  attributes: { version: '87', processingState: 'VALID', uploadedDate: '2026-10-13T16:10:00Z', expired: false, ...attributes },
  relationships: { preReleaseVersion: { data: { id: 'version-id' } } },
}], included: [{ type: 'preReleaseVersions', id: 'version-id', attributes: { version, platform: 'IOS' } }] });

function runVerification(api, overrides = {}) {
  let clock = started;
  return verifyUpload({ api, evidence, receipt, now: () => clock, wait: async (ms) => { clock += ms; },
    timeoutMs: 30_000, log() {}, ...overrides });
}

test('altool success fails when Apple rejects processing with 90683 (the build 87 incident)', async () => {
  await assert.rejects(runVerification(async () => upload('FAILED', [{ code: '90683',
    description: 'Missing purpose string NSPhotoLibraryUsageDescription' }])), /90683.*NSPhotoLibraryUsageDescription/);
});

test('transport success without a delivery UUID cannot become a successful store release', async () => {
  await assert.rejects(runVerification(async () => assert.fail('must not call Apple'), {
    receipt: { 'success-message': 'uploaded' },
  }), /delivery UUID/);
});

test('waits through missing/processing delivery and records only the exact new VALID build', async () => {
  let polls = 0;
  const result = await runVerification(async (path, options) => {
    if (path.startsWith('/v1/buildUploads/')) {
      assert.equal(path, `/v1/buildUploads/${deliveryId}`);
      assert.equal(options.allowMissing, true);
      polls += 1;
      return polls === 1 ? null : upload(polls === 2 ? 'PROCESSING' : 'COMPLETE');
    }
    const params = new URL(`https://example.test${path}`).searchParams;
    assert.equal(params.get('filter[app]'), '6803948500');
    assert.equal(params.get('filter[version]'), '87');
    return builds();
  });
  assert.equal(result.appStore.buildId, 'build-87');
  assert.equal(result.appStore.deliveryId, deliveryId);
  assert.equal(result.appStore.processingState, 'VALID');
});

test('a completed delivery without a matching build fails by the deadline', async () => {
  for (const collection of [{ data: [] }, builds({}, '0.2.20')]) {
    await assert.rejects(runVerification(async (path) => path.startsWith('/v1/buildUploads/') ? upload() : collection),
      /No new VALID iOS.*within 0.5 minutes/);
  }
});

test('an old, invalid or expired build cannot satisfy verification', async () => {
  for (const [attrs, error] of [
    [{ uploadedDate: '2026-09-29T16:24:55Z' }, /older build/],
    [{ processingState: 'INVALID' }, /unusable/],
    [{ expired: true }, /unusable/],
  ]) {
    await assert.rejects(runVerification(async (path) => path.startsWith('/v1/buildUploads/') ? upload() : builds(attrs)), error);
  }
});

test('a delivery for another IPA identity fails even when Apple completes it', async () => {
  const other = upload();
  other.data.attributes.cfBundleVersion = '81';
  await assert.rejects(runVerification(async () => other), /does not match the IPA/);
});

test('preflight rejects a wrong app or a deduplicated existing build before uploading', async () => {
  await assert.rejects(prepareUpload({ evidence, appId: '6799574618', api: async () => ({
    data: { attributes: { bundleId: 'app.buzzy.mobile' } },
  }) }), /does not match IPA/);
  const api = async (path) => path.startsWith('/v1/apps/') ? {
    data: { attributes: { bundleId: 'app.usebeeline.mobile' } },
  } : builds();
  await assert.rejects(prepareUpload({ evidence, appId: '6803948500', api }), /already exists/);
  const fresh = await prepareUpload({ evidence, appId: '6803948500', now: () => started,
    api: async (path) => path.startsWith('/v1/apps/') ? api(path) : { data: [] } });
  assert.equal(fresh.appStore.uploadStartedAt, new Date(started).toISOString());
});

test('ASC requests use a signed short-lived JWT and fail loudly on API errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-store-key-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const keyPath = join(dir, 'test.p8');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const env = { EXPO_ASC_KEY_ID: 'fixture', EXPO_ASC_ISSUER_ID: 'issuer', EXPO_ASC_API_KEY_PATH: keyPath };
    const api = appStoreClient(env, async (url, options) => {
      assert.equal(url, 'https://api.appstoreconnect.apple.com/v1/apps/6803948500');
      const token = options.headers.Authorization.slice(7);
      const [header, payload, signature] = token.split('.');
      assert.equal(JSON.parse(Buffer.from(header, 'base64url')).kid, 'fixture');
      const claims = JSON.parse(Buffer.from(payload, 'base64url'));
      assert.equal(claims.exp - claims.iat, 600);
      assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), {
        key: publicKey, dsaEncoding: 'ieee-p1363',
      }, Buffer.from(signature, 'base64url')), true);
      return { ok: false, status: 401, json: async () => ({ errors: [{ code: 'NOT_AUTHORIZED' }] }) };
    });
    await assert.rejects(api('/v1/apps/6803948500'), /HTTP 401.*NOT_AUTHORIZED/);
    const missing = appStoreClient(env, async () => ({ ok: false, status: 404 }));
    assert.equal(await missing('/v1/buildUploads/fixture', { allowMissing: true }), null);
    const writer = appStoreClient(env, async (_url, options) => {
      assert.equal(options.method, 'PATCH');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), { data: { type: 'appStoreVersions', id: 'version' } });
      return { ok: true, status: 204 };
    });
    assert.equal(await writer('/v1/appStoreVersions/version', {
      method: 'PATCH', data: { type: 'appStoreVersions', id: 'version' },
    }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('IPA inspection reads the embedded identity and rejects the missing purpose string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-ipa-'));
  try {
    const ipa = join(dir, 'fixture.ipa');
    const output = join(dir, 'ios-build.json');
    const version = JSON.parse(readFileSync(new URL('../apps/mobile/package.json', import.meta.url))).version;
    const runtime = JSON.parse(readFileSync(new URL('../apps/mobile/native-fingerprint.json', import.meta.url))).ios.runtimeVersion;
    const fixture = `import sys, plistlib, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 info = dict(CFBundleIdentifier='app.usebeeline.mobile',CFBundleShortVersionString=sys.argv[2],CFBundleVersion='88')
 if sys.argv[4] == 'present': info['NSPhotoLibraryUsageDescription']='Attach photos you choose'
 z.writestr('Payload/Beeline.app/Info.plist',plistlib.dumps(info,fmt=plistlib.FMT_BINARY))
 z.writestr('Payload/Beeline.app/Expo.plist',plistlib.dumps(dict(EXUpdatesRuntimeVersion=sys.argv[3])))`;
    const script = new URL('./ios-build-evidence.py', import.meta.url).pathname;
    execFileSync('python3', ['-c', fixture, ipa, version, runtime, 'missing']);
    const rejected = spawnSync('python3', [script, ipa, output], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /NSPhotoLibraryUsageDescription.*90683/);
    execFileSync('python3', ['-c', fixture, ipa, version, runtime, 'present']);
    execFileSync('python3', [script, ipa, output]);
    const result = JSON.parse(readFileSync(output));
    assert.equal(result.buildNumber, '88');
    assert.equal(result.appVersion, version);
    assert.equal(result.runtimeVersion, runtime);
    assert.equal(result.id, `local-${result.sha256}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// R1 stand-in: drive upload verification through the operator's production submission path.
async function reviewFixture({ state, encryption = false, failAt, noLocales = false, active = false, wrongBuild = false, submittedState = 'WAITING_FOR_REVIEW' } = {}) {
  const { submitForReview } = await import('./ios-store-build.mjs');
  const verified = await runVerification(async (path) => path.startsWith('/v1/buildUploads/') ? upload() : builds());
  const calls = [];
  const replay = [];
  const respond = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (failAt && path.includes(failAt)) throw new Error('App Store Connect HTTP 422: fixture failure');
    if (path.startsWith('/v1/builds/')) return { ...builds({ usesNonExemptEncryption: encryption }), data: builds({ usesNonExemptEncryption: encryption, ...(wrongBuild ? { version: 'other' } : {}) }).data[0] };
    if (path.includes('/apps/') && path.includes('/appStoreVersions?')) return { data: state ? [{ id: 'version', attributes: { appStoreState: state } }] : [] };
    if (path.includes('/apps/') && path.includes('/reviewSubmissions?')) return { data: active ? [{ id: 'existing', attributes: { state: 'READY_FOR_REVIEW' } }] : [] };
    if (path.includes('/appStoreVersionLocalizations?')) return { data: noLocales ? [] : [{ id: 'en', attributes: { locale: 'en-US' } }] };
    if (path === '/v1/appStoreVersions') return { data: { id: 'version' } };
    if (path === '/v1/reviewSubmissions') return { data: { id: 'review' } };
    if (path === '/v1/reviewSubmissions/review') return { data: { id: 'review', attributes: { state: submittedState } } };
    return null;
  };
  const api = async (path, options = {}) => {
    const response = await respond(path, options);
    replay.push({ path, method: options.method ?? 'GET', data: options.data, response });
    return response;
  };
  return { calls, replay, run: () => submitForReview({ api, evidence: verified, whatsNew: 'Conversation mode and fixes.' }) };
}

test('R1: VALID upload becomes a production App Review submission with automatic release', async () => {
  const fixture = await reviewFixture();
  const result = await fixture.run();
  const writes = fixture.calls.filter((c) => c.method);
  assert.deepEqual(writes.map((c) => [c.method, c.path]), [
    ['POST', '/v1/appStoreVersions'], ['PATCH', '/v1/appStoreVersions/version'],
    ['PATCH', '/v1/appStoreVersionLocalizations/en'], ['POST', '/v1/reviewSubmissions'],
    ['POST', '/v1/reviewSubmissionItems'], ['PATCH', '/v1/reviewSubmissions/review'],
  ]);
  assert.equal(writes[0].data.attributes.versionString, evidence.appVersion);
  assert.equal(writes[0].data.attributes.releaseType, 'AFTER_APPROVAL');
  assert.deepEqual(writes[1].data.relationships.build.data, { type: 'builds', id: 'build-87' });
  assert.equal(writes[2].data.attributes.whatsNew, 'Conversation mode and fixes.');
  assert.equal(writes[4].data.relationships.appStoreVersion.data.id, 'version');
  assert.equal(writes[4].data.relationships.reviewSubmission.data.id, 'review');
  assert.equal(writes[5].data.attributes.submitted, true);
  assert.equal(result.appStore.submissionId, 'review');
  assert.equal(result.appStore.releaseType, 'AFTER_APPROVAL');
});

test('editable versions are reused; already submitted versions record their state and succeed', async () => {
  for (const state of ['PREPARE_FOR_SUBMISSION', 'REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED']) {
    const fixture = await reviewFixture({ state });
    await fixture.run();
    assert.ok(!fixture.calls.some((c) => c.method === 'POST' && c.path === '/v1/appStoreVersions'));
  }
  for (const state of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'READY_FOR_SALE', 'PENDING_DEVELOPER_RELEASE']) {
    const fixture = await reviewFixture({ state });
    const result = await fixture.run();
    assert.equal(result.appStore.versionState, state);
    assert.equal(result.appStore.submissionOutcome, 'version-already-submitted');
    assert.ok(!fixture.calls.some((c) => c.method));
  }
});

test('export compliance, missing metadata, and each Apple mutation failure stop submission', async () => {
  for (const encryption of [true, null]) {
    const fixture = await reviewFixture({ encryption });
    await assert.rejects(fixture.run(), /export compliance/);
    assert.ok(!fixture.calls.some((c) => c.method));
  }
  const missing = await reviewFixture({ noLocales: true });
  await assert.rejects(missing.run(), /no localizations/);
  for (const failAt of ['/v1/appStoreVersions', '/v1/appStoreVersionLocalizations/en', '/v1/reviewSubmissions', '/v1/reviewSubmissionItems', '/v1/reviewSubmissions/review']) {
    const fixture = await reviewFixture({ failAt });
    await assert.rejects(fixture.run(), /HTTP 422/);
  }
});


test('mismatched builds fail; an active older review is recorded without mutation or failure', async () => {
  const wrong = await reviewFixture({ wrongBuild: true });
  await assert.rejects(wrong.run(), /does not match/);
  assert.ok(!wrong.calls.some((c) => c.method));
  const active = await reviewFixture({ active: true });
  const result = await active.run();
  assert.equal(result.appStore.submissionOutcome, 'existing-review-active');
  assert.deepEqual(result.appStore.activeSubmissions, [{ id: 'existing', state: 'READY_FOR_REVIEW' }]);
  assert.ok(!active.calls.some((c) => c.method));
  const fixture = await reviewFixture({ submittedState: 'READY_FOR_REVIEW' });
  await assert.rejects(fixture.run(), /did not confirm/);
});


test('R1 operator CLI writes confirmed submission evidence using mocked ASC transport', async () => {
  const fixture = await reviewFixture();
  await fixture.run();
  const dir = mkdtempSync(join(tmpdir(), 'ios-review-cli-'));
  try {
    const evidencePath = join(dir, 'ios-build.json');
    const keyPath = join(dir, 'fixture.pem');
    const preloadPath = join(dir, 'transport.mjs');
    const replayPath = join(dir, 'responses.json');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(evidencePath, JSON.stringify({ ...evidence, appStore: {
      ...evidence.appStore, processingState: 'VALID', buildId: 'build-87',
    } }));
    // Use the repository notes, as the real workflow does.
    const notes = readFileSync(new URL('../apps/mobile/store/listing/en-US/release-notes.txt', import.meta.url), 'utf8').trim();
    fixture.replay.find((r) => r.path === '/v1/appStoreVersionLocalizations/en').data.attributes.whatsNew = notes;
    writeFileSync(replayPath, JSON.stringify(fixture.replay));
    writeFileSync(preloadPath, `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const replay = JSON.parse(readFileSync(process.env.ASC_REPLAY, 'utf8'));
globalThis.fetch = async (url, options) => {
  const expected = replay.shift();
  assert.ok(expected, 'unexpected Apple call');
  assert.equal(url, 'https://api.appstoreconnect.apple.com' + expected.path);
  assert.equal(options.method, expected.method);
  assert.deepEqual(options.body ? JSON.parse(options.body).data : undefined, expected.data);
  return { ok: true, status: expected.response === null ? 204 : 200, json: async () => expected.response };
};
process.on('exit', () => assert.equal(replay.length, 0, 'all Apple calls must run'));
`);
    execFileSync(process.execPath, ['--import', preloadPath, 'scripts/ios-store-build.mjs', 'submit', evidencePath], {
      env: { ...process.env, EXPO_ASC_KEY_ID: 'fixture', EXPO_ASC_ISSUER_ID: 'fixture', EXPO_ASC_API_KEY_PATH: keyPath, ASC_REPLAY: replayPath },
    });
    const result = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(result.appStore.submissionId, 'review');
    assert.equal(result.appStore.submissionState, 'WAITING_FOR_REVIEW');
    assert.equal(result.appStore.buildId, 'build-87');
    assert.equal(result.appStore.releaseType, 'AFTER_APPROVAL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('release-store-version: locked store versions resolve to the next usable patch before builds', async () => {
  const version = (value, state) => ({ attributes: { versionString: value, appStoreState: state } });
  for (const state of ['PENDING_DEVELOPER_RELEASE', 'READY_FOR_SALE', 'WAITING_FOR_REVIEW', 'IN_REVIEW',
    'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_APP_STORE', 'WAITING_FOR_EXPORT_COMPLIANCE', 'READY_FOR_REVIEW']) {
    assert.equal(await resolveStoreVersion({ appId: '6803948500', appVersion: '0.2.22',
      api: async () => ({ data: [version('0.2.22', state)] }) }), '0.2.23');
  }
  for (const state of ['PREPARE_FOR_SUBMISSION', 'REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED']) {
    assert.equal(await resolveStoreVersion({ appId: '6803948500', appVersion: '0.2.22',
      api: async () => ({ data: [version('0.2.22', state)] }) }), '0.2.22');
  }
  for (const data of [[], [version('0.2.21', 'READY_FOR_SALE')]]) {
    assert.equal(await resolveStoreVersion({ appId: '6803948500', appVersion: '0.2.22', api: async () => ({ data }) }), '0.2.22');
  }
  const pages = [
    { data: [version('0.2.22', 'PENDING_DEVELOPER_RELEASE')], links: { next: 'https://api.appstoreconnect.apple.com/v1/versions?page=2' } },
    { data: [version('0.2.24', 'READY_FOR_SALE'), version('0.2.23', 'IN_REVIEW'), version('0.2.25', 'PREPARE_FOR_SUBMISSION')] },
  ];
  assert.equal(await resolveStoreVersion({ appId: '6803948500', appVersion: '0.2.22', api: async (path) => {
    if (pages.length === 1) assert.equal(path, '/v1/versions?page=2');
    return pages.shift();
  } }), '0.2.25');
  assert.equal(await resolveStoreVersion({ appId: '6803948500', appVersion: '0.2.22',
    api: async () => ({ data: [{ attributes: { versionString: '0.2.22', appVersionState: 'READY_FOR_SALE' } }] }) }), '0.2.23');
});


test('release-store-version: operator CLI builds evidence for 0.2.23 and submits AFTER_APPROVAL when 0.2.22 is approved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolved-store-cli-'));
  try {
    const packagePath = join(dir, 'apps/mobile/package.json');
    const ipaPath = join(dir, 'resolved.ipa');
    const evidencePath = join(dir, 'ios-build.json');
    const receiptPath = join(dir, 'ios-upload.json');
    const transport = join(dir, 'transport.mjs');
    mkdirSync(join(dir, 'apps/mobile'), { recursive: true });
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(packagePath, JSON.stringify({ version: '0.2.22' }));
    writeFileSync(join(dir, 'apps/mobile/native-fingerprint.json'), JSON.stringify({ ios: { runtimeVersion: '35' } }));
    writeFileSync(join(dir, 'scripts/ios-build-evidence.py'), readFileSync(new URL('./ios-build-evidence.py', import.meta.url)));
    writeFileSync(receiptPath, JSON.stringify(receipt));
    // Real JWT client and CLI, with generated test credentials and a transport that cannot reach Apple.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const env = { ...process.env, EXPO_ASC_KEY_ID: 'fixture', EXPO_ASC_ISSUER_ID: 'fixture',
      EXPO_ASC_API_KEY_P8: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
      ASC_CALLS: join(dir, 'calls.jsonl') };
    writeFileSync(transport, `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  const query = new URL(url).searchParams;
  const data = options.body ? JSON.parse(options.body).data : undefined;
  appendFileSync(process.env.ASC_CALLS, JSON.stringify({ path, method: options.method, data }) + '\\n');
  const train = { type: 'preReleaseVersions', id: 'train', attributes: { version: '0.2.23', platform: 'IOS' } };
  const build = { id: 'build-88', attributes: { version: '88', processingState: 'VALID',
    expired: false, usesNonExemptEncryption: false, uploadedDate: new Date().toISOString() },
    relationships: { preReleaseVersion: { data: { id: 'train' } } } };
  let response;
  if (path.endsWith('/appStoreVersions') && options.method === 'GET') {
    if (query.has('filter[versionString]')) {
      assert.equal(query.get('filter[versionString]'), '0.2.23');
      response = { data: [] };
    } else response = { data: [{ id: 'old', attributes: { versionString: '0.2.22', appStoreState: 'PENDING_DEVELOPER_RELEASE' } }] };
  } else if (path === '/v1/apps/6803948500') response = { data: { attributes: { bundleId: 'app.usebeeline.mobile' } } };
  else if (path === '/v1/builds') response = { data: process.env.ASC_STAGE === 'prepare' ? [] : [build], included: [train] };
  else if (path.startsWith('/v1/buildUploads/')) response = { data: { attributes: {
    cfBundleShortVersionString: '0.2.23', cfBundleVersion: '88', platform: 'IOS', state: { state: 'COMPLETE' } } } };
  else if (path === '/v1/builds/build-88') response = { data: build, included: [train] };
  else if (path.endsWith('/reviewSubmissions') && options.method === 'GET') response = { data: [] };
  else if (path === '/v1/appStoreVersions' && options.method === 'POST') {
    assert.equal(data.attributes.versionString, '0.2.23');
    assert.equal(data.attributes.releaseType, 'AFTER_APPROVAL');
    response = { data: { id: 'new-version' } };
  } else if (path === '/v1/appStoreVersions/new-version') {
    assert.equal(data.attributes.releaseType, 'AFTER_APPROVAL');
    assert.equal(data.relationships.build.data.id, 'build-88');
    response = null;
  } else if (path.endsWith('/appStoreVersionLocalizations')) response = { data: [{ id: 'en' }] };
  else if (path === '/v1/appStoreVersionLocalizations/en') response = null;
  else if (path === '/v1/reviewSubmissions') response = { data: { id: 'review-new' } };
  else if (path === '/v1/reviewSubmissionItems') {
    assert.equal(data.relationships.appStoreVersion.data.id, 'new-version');
    response = null;
  } else if (path === '/v1/reviewSubmissions/review-new') {
    assert.equal(data.attributes.submitted, true);
    response = { data: { id: 'review-new', attributes: { state: 'WAITING_FOR_REVIEW' } } };
  } else assert.fail('Unexpected Apple call ' + url);
  return { ok: true, status: response === null ? 204 : 200, json: async () => response };
};
`);
    const cli = (command, path, extra = []) => execFileSync(process.execPath,
      ['--import', transport, 'scripts/ios-store-build.mjs', command, path, ...extra],
      { env: { ...env, ASC_STAGE: command }, encoding: 'utf8' });
    const resolved = cli('resolve-version', packagePath).trim();
    assert.equal(resolved, '0.2.23');
    // EAS/Xcode stand-in: bake the resolved package version into an IPA, then inspect the actual bytes.
    writeFileSync(packagePath, JSON.stringify({ version: resolved }));
    execFileSync('python3', ['-c', `import sys, plistlib, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 z.writestr('Payload/Beeline.app/Info.plist', plistlib.dumps(dict(CFBundleIdentifier='app.usebeeline.mobile', CFBundleShortVersionString=sys.argv[2], CFBundleVersion='88', NSPhotoLibraryUsageDescription='Attach photos')))
 z.writestr('Payload/Beeline.app/Expo.plist', plistlib.dumps(dict(EXUpdatesRuntimeVersion='35')))
`, ipaPath, resolved]);
    execFileSync('python3', [join(dir, 'scripts/ios-build-evidence.py'), ipaPath, evidencePath]);
    cli('prepare', evidencePath);
    cli('verify', evidencePath, [receiptPath]);
    cli('submit', evidencePath);
    const result = JSON.parse(readFileSync(evidencePath));
    assert.equal(result.appVersion, '0.2.23');
    assert.equal(result.appStore.buildId, 'build-88');
    assert.equal(result.appStore.submissionId, 'review-new');
    assert.equal(result.appStore.submissionState, 'WAITING_FOR_REVIEW');
    assert.equal(result.appStore.releaseType, 'AFTER_APPROVAL');
    const calls = readFileSync(env.ASC_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter((c) => c.path === '/v1/reviewSubmissions/review-new').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
