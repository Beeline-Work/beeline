import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, verify } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appStoreClient, prepareUpload, verifyUpload } from './ios-store-build.mjs';

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
