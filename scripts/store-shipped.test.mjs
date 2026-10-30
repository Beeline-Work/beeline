import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyUpload } from './ios-store-build.mjs';
import {
  awaitIosBuild, findIosBuild, findPlayRelease, playReleaseName, readPlayTracks, releaseMarker, shippedOutputs,
} from './store-shipped.mjs';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const MARKER = 'v0.1.123@abcdef123456';

test('the release marker is the release version and the 12-char commit', () => {
  assert.equal(releaseMarker('v0.1.123', SHA), MARKER);
  assert.equal(playReleaseName('0.2.30', MARKER), '0.2.30 (v0.1.123@abcdef123456)');
  assert.throws(() => releaseMarker('0.1.123', SHA), /invalid release marker/);
});

test('a Play release named for this release is found on any track; older names are not', () => {
  const tracks = { tracks: [
    { track: 'production', releases: [{ name: '0.2.29', versionCodes: ['38'] }] },
    { track: 'internal', releases: [
      { name: '0.2.30 (v0.1.122@0123456789ab)', versionCodes: ['39'] },
      { name: playReleaseName('0.2.30', MARKER), versionCodes: ['40'] },
    ] },
  ] };
  assert.deepEqual(findPlayRelease(tracks, MARKER), { track: 'internal', appVersion: '0.2.30', versionCode: '40' });
  assert.equal(findPlayRelease(tracks, 'v0.1.124@abcdef123456'), null);
  assert.equal(findPlayRelease({}, MARKER), null);
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
