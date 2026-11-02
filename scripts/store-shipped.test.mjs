import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyUpload } from './ios-store-build.mjs';
import {
  awaitIosBuild, findIosBuild, findIosUpload, findPlayRelease, iosUploadFileName, playReleaseName, readPlayTracks,
  releaseMarker, shippedOutputs,
} from './store-shipped.mjs';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const MARKER = 'v0.1.123@abcdef123456';

test('the release marker is the release version and the 12-char commit', () => {
  assert.equal(releaseMarker('v0.1.123', SHA), MARKER);
  assert.equal(playReleaseName('0.2.30', MARKER), '0.2.30 (v0.1.123@abcdef123456)');
  assert.throws(() => releaseMarker('0.1.123', SHA), /invalid release marker/);
});

test('only a completed production release counts as shipped', () => {
  const release = { name: playReleaseName('0.2.30', MARKER), versionCodes: ['40'], status: 'completed' };
  const tracks = { tracks: [{ track: 'production', releases: [
    { name: '0.2.29', versionCodes: ['38'], status: 'completed' },
    { ...release, name: '0.2.30 (v0.1.122@0123456789ab)' },
    release,
  ] }] };
  assert.deepEqual(findPlayRelease(tracks, MARKER), { track: 'production', appVersion: '0.2.30', versionCode: '40' });
  assert.equal(findPlayRelease(tracks, 'v0.1.124@abcdef123456'), null);
  assert.equal(findPlayRelease({}, MARKER), null);
  for (const status of ['draft', 'inProgress', 'halted', undefined]) {
    assert.equal(findPlayRelease({ tracks: [{ track: 'production', releases: [{ ...release, status }] }] }, MARKER), null);
  }
  assert.equal(findPlayRelease({ tracks: [{ track: 'retired-testing', releases: [release] }] }, MARKER), null);
  const beta = { tracks: [{ track: 'beta', releases: [release] }] };
  assert.equal(findPlayRelease(beta, MARKER), null);
  assert.deepEqual(findPlayRelease(beta, MARKER, 'beta'), { track: 'beta', appVersion: '0.2.30', versionCode: '40' });
});

test('reading Play tracks always deletes the throwaway edit', async () => {
  const calls = [];
  const fetchImpl = async (url, { method }) => {
    calls.push(`${method} ${url.replace(/^.*app.usebeeline/, '')}`);
    const body = method === 'POST' ? { id: 'e1' } : method === 'GET' ? { tracks: [] } : null;
    return { ok: true, status: 200, text: async () => (body ? JSON.stringify(body) : '') };
  };
  assert.deepEqual(await readPlayTracks({ packageName: 'app.usebeeline', accessToken: 't', fetchImpl }), { tracks: [] });
  assert.deepEqual(calls, ['POST /edits', 'GET /edits/e1/tracks', 'DELETE /edits/e1']);
});

const page = (builds) => ({
  data: builds.map(({ id, version, state = 'VALID', notes, expired = false }) => ({
    id, attributes: { version, processingState: state, expired, uploadedDate: '2026-10-30T10:00:00Z' },
    relationships: { preReleaseVersion: { data: { id: 'train' } },
      betaBuildLocalizations: { data: notes ? [{ id: `loc-${id}` }] : [] } },
  })),
  included: [{ type: 'preReleaseVersions', id: 'train', attributes: { version: '0.2.30', platform: 'IOS' } },
    ...builds.filter((b) => b.notes).map((b) => ({ type: 'betaBuildLocalizations', id: `loc-${b.id}`,
      attributes: { locale: 'en-US', whatsNew: b.notes } }))],
});

test('the iOS build marked for this release is reused; unmarked, other or unusable builds are not', async () => {
  const api = async (path) => {
    const params = new URL(`https://x${path}`).searchParams;
    assert.equal(params.get('filter[app]'), '6803948500');
    assert.equal(params.get('sort'), '-uploadedDate');
    return page([
      { id: 'b5', version: '95', notes: `Beeline release ${MARKER}`, state: 'INVALID' },
      { id: 'b4', version: '94' },
      { id: 'b3', version: '93', notes: 'Beeline release v0.1.122@0123456789ab' },
      { id: 'b2', version: '92', notes: `Beeline release ${MARKER}`, state: 'PROCESSING' },
    ]);
  };
  const found = await findIosBuild({ api, appId: '6803948500', marker: MARKER });
  assert.equal(found.appStore.buildId, 'b2');
  assert.equal(found.buildNumber, '92');
  assert.equal(found.appVersion, '0.2.30');
  assert.equal(await findIosBuild({ api: async () => page([{ id: 'b4', version: '94' }]), appId: '6803948500', marker: MARKER }), null);
});

test('a reused iOS build still processing is awaited until VALID before App Review', async () => {
  let polls = 0;
  const evidence = { appStore: { buildId: 'b2' } };
  const api = async () => ({ data: { attributes: { processingState: ++polls < 3 ? 'PROCESSING' : 'VALID' } } });
  const done = await awaitIosBuild({ api, evidence, wait: async () => {} });
  assert.equal(done.appStore.processingState, 'VALID');
  assert.equal(polls, 3);
  await assert.rejects(awaitIosBuild({ api: async () => ({ data: { attributes: { processingState: 'FAILED' } } }), evidence }), /unusable/);
});

test('verify marks the new iOS build with the release marker as soon as Apple lists it', async () => {
  const writes = [];
  const evidence = { bundleId: 'app.usebeeline.mobile', appVersion: '0.2.30', buildNumber: '92', releaseMarker: MARKER,
    appStore: { appId: '6803948500', uploadStartedAt: '2026-10-30T09:59:00Z' } };
  const receipt = { 'success-message': 'ok', details: { 'delivery-uuid': '919f9a1e-4397-43f9-8336-a20eac85d6bd' } };
  const api = async (path, options = {}) => {
    if (options.method) { writes.push([options.method, path, options.data.attributes]); return { data: {} }; }
    if (path.startsWith('/v1/buildUploads/')) {
      return { data: { attributes: { cfBundleShortVersionString: '0.2.30', cfBundleVersion: '92', platform: 'IOS', state: { state: 'COMPLETE' } } } };
    }
    if (path.includes('/betaBuildLocalizations')) return { data: [] };
    return page([{ id: 'b2', version: '92' }]);
  };
  const result = await verifyUpload({ api, evidence, receipt, log() {}, wait: async () => {} });
  assert.equal(result.appStore.buildId, 'b2');
  assert.deepEqual(writes, [['POST', '/v1/betaBuildLocalizations', { locale: 'en-US', whatsNew: `Beeline release ${MARKER}` }]]);
});

test('initialize outputs: shipped platforms, their numbers and the one store version', () => {
  assert.deepEqual(shippedOutputs({ play: null, ios: null }), [
    'android_shipped=false', 'android_version_code=', 'ios_shipped=false', 'ios_build_number=', 'shipped_version=',
  ]);
  assert.deepEqual(shippedOutputs({ play: { appVersion: '0.2.30', versionCode: '40' }, ios: { appVersion: '0.2.30', buildNumber: '92' } }), [
    'android_shipped=true', 'android_version_code=40', 'ios_shipped=true', 'ios_build_number=92', 'shipped_version=0.2.30',
  ]);
  assert.throws(() => shippedOutputs({ play: { appVersion: '0.2.30' }, ios: { appVersion: '0.2.31' } }), /finish it by hand/);
});

test('Reproduction STORE-RERUN (iOS): an uploaded, verified build is found on rerun and not uploaded again', async () => {
  // A fake App Store Connect that keeps builds and their What to Test text.
  const asc = { builds: [{ id: 'b7', version: '97', state: 'VALID' }], notes: {} };
  const api = async (path, options = {}) => {
    if (options.method === 'POST') { asc.notes[options.data.relationships.build.data.id] = options.data.attributes.whatsNew; return { data: {} }; }
    if (path.startsWith('/v1/buildUploads/')) {
      return { data: { attributes: { cfBundleShortVersionString: '0.2.30', cfBundleVersion: '98', platform: 'IOS', state: { state: 'COMPLETE' } } } };
    }
    if (path.includes('/betaBuildLocalizations')) return { data: [] };
    return page(asc.builds.map((build) => ({ ...build, notes: asc.notes[build.id] })));
  };
  const appId = '6803948500';
  assert.equal(await findIosBuild({ api, appId, marker: MARKER }), null, 'first attempt: nothing shipped, so it builds');
  // Attempt 1 uploads build 98 and verifies it; an unrelated job then fails the run.
  asc.builds.unshift({ id: 'b8', version: '98', state: 'VALID' });
  await verifyUpload({ api, log() {}, wait: async () => {}, receipt: { 'success-message': 'ok', details: { 'delivery-uuid': '919f9a1e-4397-43f9-8336-a20eac85d6bd' } },
    evidence: { bundleId: 'app.usebeeline.mobile', appVersion: '0.2.30', buildNumber: '98', releaseMarker: MARKER,
      appStore: { appId, uploadStartedAt: '2026-10-30T09:59:00Z' } } });
  // The rerun's initialize finds build 98 and the iOS job reuses it instead of uploading.
  const rerun = await findIosBuild({ api, appId, marker: MARKER });
  assert.equal(rerun.appStore.buildId, 'b8');
  assert.deepEqual(shippedOutputs({ play: null, ios: rerun }).slice(2), ['ios_shipped=true', 'ios_build_number=98', 'shipped_version=0.2.30']);
  assert.equal(await findIosBuild({ api, appId, marker: 'v0.1.124@0123456789ab' }), null, 'another release still uploads');
});

test('the iOS upload file name carries the release marker', () => {
  assert.equal(iosUploadFileName(MARKER), 'beeline-v0.1.123-abcdef123456.ipa');
  assert.throws(() => iosUploadFileName('v0.1.123'), /invalid release marker/);
});

test('an accepted iOS upload is found by its file name; unfinished, failed or other uploads are not', async () => {
  const uploads = [
    { id: 'u1', state: 'FAILED', fileName: iosUploadFileName(MARKER), version: '96' },
    { id: 'u2', state: 'AWAITING_UPLOAD', fileName: iosUploadFileName(MARKER), version: '97' },
    { id: 'u3', state: 'COMPLETE', fileName: 'beeline-v0.1.122-0123456789ab.ipa', version: '95' },
    { id: 'u4', state: 'PROCESSING', fileName: iosUploadFileName(MARKER), version: '98' },
  ];
  const api = async (apiPath) => {
    if (apiPath.startsWith('/v1/apps/6803948500/buildUploads')) {
      return { data: uploads.map(({ id, state, version }) => ({ id, attributes: { platform: 'IOS', cfBundleShortVersionString: '0.2.30',
        cfBundleVersion: version, createdDate: `2026-10-30T10:${version}:00Z`, state: { state } } })) };
    }
    const id = /^\/v1\/buildUploads\/([^/]+)\/buildUploadFiles$/.exec(apiPath)[1];
    return { data: [{ attributes: { fileName: uploads.find((u) => u.id === id).fileName } }] };
  };
  const found = await findIosUpload({ api, appId: '6803948500', marker: MARKER });
  assert.deepEqual(found, { bundleId: 'app.usebeeline.mobile', appVersion: '0.2.30', buildNumber: '98', releaseMarker: MARKER,
    appStore: { appId: '6803948500', deliveryId: 'u4', uploadStartedAt: '2026-10-30T10:98:00Z' } });
  assert.equal(await findIosUpload({ api, appId: '6803948500', marker: 'v0.1.124@0123456789ab' }), null);
});

test('Reproduction STORE-RERUN-IOS-KILLED: upload accepted, job killed before the marker write, rerun reuses the build', async () => {
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'store-rerun-ios-'));
  const statePath = path.join(dir, 'asc.json');
  writeFileSync(statePath, JSON.stringify({ uploads: [], builds: [] }));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const env = { ...process.env, FAKE_ASC_STATE: statePath, EXPO_ASC_KEY_ID: 'TESTKEY', EXPO_ASC_ISSUER_ID: 'test-issuer',
    EXPO_ASC_API_KEY_P8: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') };
  const fake = path.join(scripts, 'fixtures', 'fake-app-store-connect.mjs');
  const run = (script, ...args) => {
    const result = spawnSync(process.execPath, ['--import', fake, path.join(scripts, script), ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${script} ${args.join(' ')}\n${result.stderr}`);
    return result.stdout;
  };
  const asc = () => JSON.parse(readFileSync(statePath, 'utf8'));

  // Attempt 1, initialize: nothing shipped yet, so the iOS job builds and uploads.
  assert.match(run('store-shipped.mjs', 'find', '--marker', MARKER, '--ios'), /^ios_shipped=false$/m);
  // Attempt 1, iOS job: build, prepare, upload. Apple accepts the upload.
  const ipa = path.join(dir, run('store-shipped.mjs', 'ios-file-name', '--marker', MARKER).trim());
  const evidence = path.join(dir, 'ios-build.json');
  writeFileSync(evidence, JSON.stringify({ bundleId: 'app.usebeeline.mobile', appVersion: '0.2.30', buildNumber: '98', releaseMarker: MARKER }));
  run('ios-store-build.mjs', 'prepare', evidence);
  const receipt = path.join(dir, 'ios-upload.json');
  writeFileSync(receipt, run('fixtures/fake-app-store-connect.mjs', 'upload', ipa, '0.2.30', '98'));
  // verify sees Apple still processing; the runner dies before Apple lists the build, so no marker is written.
  const verify = spawn(process.execPath, ['--import', fake, path.join(scripts, 'ios-store-build.mjs'), 'verify', evidence, receipt], { env });
  await new Promise((resolve, reject) => {
    verify.stdout.on('data', (chunk) => { if (String(chunk).includes(': PROCESSING')) verify.kill('SIGKILL'); });
    verify.on('exit', (code, signal) => (signal === 'SIGKILL' ? resolve() : reject(new Error(`verify exited ${code}`))));
  });
  run('fixtures/fake-app-store-connect.mjs', 'finish-processing');
  assert.equal(asc().builds[0].whatsNew, undefined, 'the killed job never marked the build');
  assert.equal(asc().builds[0].state, 'VALID');

  // Rerun, initialize: Apple holds the upload under this release's file name.
  const outputs = run('store-shipped.mjs', 'find', '--marker', MARKER, '--ios');
  assert.match(outputs, /^ios_shipped=true$/m);
  assert.match(outputs, /^ios_build_number=98$/m);
  assert.match(outputs, /^shipped_version=0\.2\.30$/m);
  // Rerun, iOS job: the workflow skips build and upload and reuses Apple's build.
  const reused = path.join(dir, 'reused.json');
  run('store-shipped.mjs', 'ios-evidence', '--marker', MARKER, '--output', reused);
  const result = JSON.parse(readFileSync(reused, 'utf8'));
  assert.deepEqual([result.buildNumber, result.appStore.buildId, result.appStore.processingState], ['98', 'build-98', 'VALID']);
  assert.equal(asc().uploads.length, 1, 'no second upload');
  assert.equal(asc().builds[0].whatsNew, `Beeline release ${MARKER}`, 'the rerun marks the build');
  // A different release still uploads its own build.
  assert.match(run('store-shipped.mjs', 'find', '--marker', 'v0.1.124@0123456789ab', '--ios'), /^ios_shipped=false$/m);
});
