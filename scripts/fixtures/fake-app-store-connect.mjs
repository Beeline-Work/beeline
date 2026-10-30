// Test double for App Store Connect, loaded with `node --import`. It replaces
// fetch for api.appstoreconnect.apple.com and keeps Apple's state in the JSON
// file named by FAKE_ASC_STATE, so separate processes (one per release job)
// see the same store. Run directly, it acts as `altool --upload-app`.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST = 'https://api.appstoreconnect.apple.com';
const load = () => JSON.parse(readFileSync(process.env.FAKE_ASC_STATE, 'utf8'));
const save = (state) => writeFileSync(process.env.FAKE_ASC_STATE, `${JSON.stringify(state, null, 2)}\n`);
const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });

function buildResource(build) {
  return { type: 'builds', id: build.id,
    attributes: { version: build.version, processingState: build.state, expired: false, uploadedDate: build.uploadedDate },
    relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: `train-${build.appVersion}` } },
      betaBuildLocalizations: { data: build.whatsNew ? [{ type: 'betaBuildLocalizations', id: `loc-${build.id}` }] : [] } } };
}

function buildPage(builds) {
  return { data: builds.map(buildResource), included: [
    ...[...new Set(builds.map((b) => b.appVersion))].map((version) => ({ type: 'preReleaseVersions', id: `train-${version}`,
      attributes: { version, platform: 'IOS' } })),
    ...builds.filter((b) => b.whatsNew).map((b) => ({ type: 'betaBuildLocalizations', id: `loc-${b.id}`,
      attributes: { locale: 'en-US', whatsNew: b.whatsNew } })),
  ] };
}

function respond(method, url, body) {
  const state = load();
  const { pathname, searchParams } = url;
  // Apple lists a build only once processing reaches it, minutes after the upload.
  const listed = state.builds.filter((build) => build.listed);
  let match;
  if (method === 'GET' && (match = /^\/v1\/apps\/(\d+)$/.exec(pathname))) {
    return json({ data: { id: match[1], attributes: { bundleId: 'app.usebeeline.mobile' } } });
  }
  if (method === 'GET' && pathname === '/v1/builds') {
    const version = searchParams.get('filter[version]');
    return json(buildPage(listed.filter((b) => !version || b.version === version).reverse()));
  }
  if (method === 'GET' && (match = /^\/v1\/builds\/([^/]+)$/.exec(pathname))) {
    const build = listed.find((b) => b.id === match[1]);
    return build ? json({ data: buildResource(build) }) : json({ errors: [] }, 404);
  }
  if (method === 'GET' && (match = /^\/v1\/builds\/([^/]+)\/betaBuildLocalizations$/.exec(pathname))) {
    const build = listed.find((b) => b.id === match[1]);
    return json({ data: build?.whatsNew ? [{ id: `loc-${build.id}`, attributes: { locale: 'en-US', whatsNew: build.whatsNew } }] : [] });
  }
  if (method === 'POST' && pathname === '/v1/betaBuildLocalizations') {
    const build = state.builds.find((b) => b.id === body.data.relationships.build.data.id);
    build.whatsNew = body.data.attributes.whatsNew;
    save(state);
    return json({ data: { id: `loc-${build.id}` } }, 201);
  }
  if (method === 'GET' && /^\/v1\/apps\/\d+\/buildUploads$/.test(pathname)) {
    return json({ data: state.uploads.map(({ id, fileName, ...attributes }) => ({ type: 'buildUploads', id, attributes })) });
  }
  if (method === 'GET' && (match = /^\/v1\/buildUploads\/([^/]+)\/buildUploadFiles$/.exec(pathname))) {
    const upload = state.uploads.find((u) => u.id === match[1]);
    return json({ data: [{ type: 'buildUploadFiles', id: `file-${upload.id}`, attributes: { fileName: upload.fileName, assetType: 'ASSET' } }] });
  }
  if (method === 'GET' && (match = /^\/v1\/buildUploads\/([^/]+)$/.exec(pathname))) {
    const upload = state.uploads.find((u) => u.id === match[1]);
    if (!upload) return json({ errors: [] }, 404);
    const { id, fileName, ...attributes } = upload;
    return json({ data: { type: 'buildUploads', id, attributes } });
  }
  return json({ errors: [{ detail: `fake App Store Connect has no ${method} ${pathname}` }] }, 400);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== HOST) return realFetch(input, init);
  return respond(init.method ?? 'GET', url, init.body ? JSON.parse(init.body) : null);
};

/** `altool --upload-app -f <ipa>`: Apple accepts the file and starts processing it. */
function upload(ipa, appVersion, buildNumber) {
  const state = load();
  const id = `0000000${state.uploads.length + 1}-0000-4000-8000-000000000000`.slice(-36);
  const now = new Date().toISOString();
  state.uploads.push({ id, fileName: basename(ipa), cfBundleShortVersionString: appVersion, cfBundleVersion: buildNumber,
    platform: 'IOS', createdDate: now, uploadedDate: now, state: { state: 'PROCESSING', errors: [], warnings: [], infos: [] } });
  state.builds.push({ id: `build-${buildNumber}`, version: buildNumber, appVersion, state: 'PROCESSING', uploadedDate: now, listed: false });
  save(state);
  console.log(JSON.stringify({ 'success-message': 'No errors uploading', details: { 'delivery-uuid': id } }));
}

/** Apple finishes processing every upload: each is COMPLETE and its build is listed and VALID. */
function finishProcessing() {
  const state = load();
  for (const item of state.uploads) item.state.state = 'COMPLETE';
  for (const build of state.builds) Object.assign(build, { listed: true, state: 'VALID' });
  save(state);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'upload') upload(...args);
  else if (command === 'finish-processing') finishProcessing();
  else throw new Error('Usage: fake-app-store-connect.mjs upload <ipa> <appVersion> <buildNumber> | finish-processing');
}
