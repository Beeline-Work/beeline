import { sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const API = 'https://api.appstoreconnect.apple.com';
const TIMEOUT_MS = 20 * 60 * 1000;

export function appStoreClient(env = process.env, fetchImpl = fetch) {
  for (const key of ['EXPO_ASC_KEY_ID', 'EXPO_ASC_ISSUER_ID']) {
    if (!env[key]) throw new Error(`${key} is required to verify the iOS store upload`);
  }
  const privateKey = env.EXPO_ASC_API_KEY_P8
    ? Buffer.from(env.EXPO_ASC_API_KEY_P8, 'base64')
    : readFileSync(env.EXPO_ASC_API_KEY_PATH);
  return async (path, { allowMissing = false, method = 'GET', data } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'ES256', kid: env.EXPO_ASC_KEY_ID, typ: 'JWT' })}.${encode({
      iss: env.EXPO_ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1',
    })}`;
    const signature = sign('sha256', Buffer.from(input), {
      key: privateKey, dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${input}.${signature}`, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify({ data }),
      signal: AbortSignal.timeout(30_000),
    });
    if (allowMissing && response.status === 404) return null;
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(`App Store Connect HTTP ${response.status}: ${JSON.stringify(body.errors)}`);
    return body;
  };
}

const EDITABLE_STATES = new Set(['PREPARE_FOR_SUBMISSION', 'REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED']);
const versionState = (version) => version.attributes?.appVersionState ?? version.attributes?.appStoreState;
const editable = (version) => EDITABLE_STATES.has(versionState(version));
const parts = (version) => version.split('.').map(Number).concat([0, 0]).slice(0, 3);
const compareVersions = (a, b) => {
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};

// Resolve once before either native build; the display version is baked into both binaries.
export async function resolveStoreVersion({ api, appId, appVersion }) {
  const versions = [];
  let path = `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=200`;
  while (path) {
    const page = await api(path);
    if (!Array.isArray(page?.data)) throw new Error('App Store Connect returned no version collection');
    versions.push(...page.data);
    const next = page.links?.next;
    path = next ? new URL(next, API).pathname + new URL(next, API).search : null;
  }
  let resolved = appVersion;
  for (const version of versions) {
    const value = version.attributes?.versionString;
    if (/^\d+(\.\d+){0,2}$/.test(value ?? '') && !editable(version) && compareVersions(value, resolved) >= 0) {
      const [major, minor, patch] = parts(value);
      resolved = `${major}.${minor}.${patch + 1}`;
    }
  }
  return resolved;
}

function buildQuery(evidence, appId) {
  const query = new URLSearchParams({
    'filter[app]': appId, 'filter[version]': evidence.buildNumber,
    include: 'preReleaseVersion', limit: '200',
  });
  return `/v1/builds?${query}`;
}

function validateEvidence(evidence, appId) {
  if (!/^\d+$/.test(appId) || evidence.bundleId !== 'app.usebeeline.mobile' ||
      !/^\d+(\.\d+){0,2}$/.test(evidence.appVersion ?? '') ||
      !/^\d+(\.\d+){0,2}$/.test(evidence.buildNumber ?? '')) {
    throw new Error('Invalid iOS IPA identity; refusing to submit or verify it');
  }
}

export async function prepareUpload({ api, evidence, appId, now = Date.now }) {
  validateEvidence(evidence, appId);
  const app = await api(`/v1/apps/${appId}?fields[apps]=bundleId`);
  if (app.data?.attributes?.bundleId !== evidence.bundleId) {
    throw new Error(`App Store app ${appId} does not match IPA bundle ${evidence.bundleId}`);
  }
  const builds = await api(buildQuery(evidence, appId));
  if (!Array.isArray(builds.data)) throw new Error('App Store Connect returned no build collection');
  const existing = builds.data.filter((build) => {
    const version = builds.included?.find((item) => item.type === 'preReleaseVersions' &&
      item.id === build.relationships?.preReleaseVersion?.data?.id);
    return version?.attributes?.platform === 'IOS' && version.attributes.version === evidence.appVersion;
  });
  if (existing.length) throw new Error(`iOS ${evidence.appVersion} (${evidence.buildNumber}) already exists; a new upload is required`);
  return { ...evidence, appStore: { appId, uploadStartedAt: new Date(now()).toISOString() } };
}

/** Writes the release marker into the build's en-US What to Test text (see store-shipped.mjs). */
export async function markIosBuild({ api, buildId, marker }) {
  const whatsNew = `Beeline release ${marker}`;
  const existing = await api(`/v1/builds/${buildId}/betaBuildLocalizations?limit=50`);
  const local = existing?.data?.find((item) => item.attributes?.locale === 'en-US');
  if (local) {
    await api(`/v1/betaBuildLocalizations/${local.id}`, { method: 'PATCH',
      data: { type: 'betaBuildLocalizations', id: local.id, attributes: { whatsNew } } });
  } else {
    await api('/v1/betaBuildLocalizations', { method: 'POST', data: { type: 'betaBuildLocalizations',
      attributes: { locale: 'en-US', whatsNew }, relationships: { build: { data: { type: 'builds', id: buildId } } } } });
  }
}

export async function verifyUpload({ api, evidence, receipt, now = Date.now, wait = sleep,
  timeoutMs = TIMEOUT_MS, log = console.log }) {
  const { appId, uploadStartedAt } = evidence.appStore ?? {};
  validateEvidence(evidence, appId);
  const deliveryId = receipt.details?.['delivery-uuid'];
  if (!receipt['success-message'] || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId ?? '') ||
      !Number.isFinite(Date.parse(uploadStartedAt))) {
    throw new Error('altool did not provide a delivery UUID and a prepared upload identity');
  }
  const deadline = now() + timeoutMs;
  let marked = false;
  do {
    const upload = await api(`/v1/buildUploads/${deliveryId}`, { allowMissing: true });
    if (upload) {
      const attrs = upload.data?.attributes;
      if (attrs?.cfBundleShortVersionString !== evidence.appVersion ||
          attrs.cfBundleVersion !== evidence.buildNumber || attrs.platform !== 'IOS') {
        throw new Error(`Apple delivery ${deliveryId} does not match the IPA identity`);
      }
      const state = attrs.state;
      if (state?.state === 'FAILED' || state?.errors?.length) {
        throw new Error(`Apple rejected iOS ${evidence.appVersion} (${evidence.buildNumber}): ${JSON.stringify(state)}`);
      }
      if (!state?.state) throw new Error('Apple delivery has no processing state');
      log(`Apple delivery ${deliveryId}: ${state.state}`);
      if (state.state === 'COMPLETE') {
        const builds = await api(buildQuery(evidence, appId));
        if (!Array.isArray(builds.data)) throw new Error('App Store Connect returned no build collection');
        const build = builds.data.find((item) => {
          const version = builds.included?.find((v) => v.type === 'preReleaseVersions' &&
            v.id === item.relationships?.preReleaseVersion?.data?.id);
          return item.attributes?.version === evidence.buildNumber &&
            version?.attributes?.platform === 'IOS' && version.attributes.version === evidence.appVersion;
        });
        if (build) {
          const attrs = build.attributes;
          if (!Number.isFinite(Date.parse(attrs.uploadedDate)) ||
              Date.parse(attrs.uploadedDate) < Date.parse(uploadStartedAt) - 60_000) {
            throw new Error('App Store Connect returned an older build; no new iOS build landed');
          }
          if (['FAILED', 'INVALID'].includes(attrs.processingState) || attrs.expired) {
            throw new Error(`iOS build ${build.id} is unusable: ${JSON.stringify(attrs)}`);
          }
          // Mark the build as this release's the moment Apple lists it, so a
          // rerun finds it and never uploads a second build.
          if (evidence.releaseMarker && !marked) {
            await markIosBuild({ api, buildId: build.id, marker: evidence.releaseMarker });
            marked = true;
          }
          if (attrs.processingState === 'VALID') {
            log(`Verified App Store app ${appId}: iOS ${evidence.appVersion} (${evidence.buildNumber}), build ${build.id}, VALID`);
            return { ...evidence, appStore: { ...evidence.appStore, deliveryId, buildId: build.id,
              processingState: attrs.processingState, uploadedDate: attrs.uploadedDate } };
          }
        }
      }
    }
    if (now() >= deadline) break;
    await wait(Math.min(15_000, deadline - now()));
  } while (now() <= deadline);
  throw new Error(`No new VALID iOS ${evidence.appVersion} (${evidence.buildNumber}) build landed in App Store app ${appId} within ${timeoutMs / 60_000} minutes (delivery ${deliveryId})`);
}

// Production uses the current reviewSubmissions API, not the retired version-submission endpoint.
export async function submitForReview({ api, evidence, whatsNew }) {
  const { appId, buildId, processingState } = evidence.appStore ?? {};
  validateEvidence(evidence, appId);
  if (!buildId || processingState !== 'VALID') throw new Error('A verified VALID upload is required for App Review');
  if (!whatsNew?.trim() || whatsNew.length > 4000) throw new Error('Release notes must contain 1–4000 characters');
  const ref = (type, id) => ({ data: { type, id } });
  const collection = async (path) => {
    const result = await api(path);
    if (!Array.isArray(result?.data) || result.links?.next) throw new Error(`Incomplete Apple collection: ${path}`);
    return result.data;
  };
  const write = async (path, method, type, attributes, relationships, id) => api(path, {
    method, data: { type, ...(id ? { id } : {}), ...(attributes ? { attributes } : {}),
      ...(relationships ? { relationships } : {}) },
  });
  const build = (await api(`/v1/builds/${buildId}?include=preReleaseVersion`));
  const train = build.included?.find((v) => v.id === build.data?.relationships?.preReleaseVersion?.data?.id);
  if (build.data?.attributes?.version !== evidence.buildNumber ||
      build.data.attributes.processingState !== 'VALID' || build.data.attributes.expired ||
      train?.attributes?.version !== evidence.appVersion || train.attributes.platform !== 'IOS') {
    throw new Error('App Review build does not match the verified IPA');
  }
  if (build.data.attributes.usesNonExemptEncryption !== false) {
    throw new Error('Build export compliance must declare usesNonExemptEncryption=false before App Review');
  }
  const query = new URLSearchParams({ 'filter[platform]': 'IOS', 'filter[versionString]': evidence.appVersion, limit: '200' });
  const versions = await collection(`/v1/apps/${appId}/appStoreVersions?${query}`);
  if (versions.length > 1) throw new Error('Apple returned multiple matching App Store versions');
  let version = versions[0];
  if (version && !editable(version)) {
    return { ...evidence, appStore: { ...evidence.appStore, versionId: version.id,
      versionState: versionState(version), submissionOutcome: 'version-already-submitted' } };
  }
  // Preserve an existing review and record it without holding up the release.
  const submissions = await collection(`/v1/apps/${appId}/reviewSubmissions?filter[platform]=IOS&limit=200`);
  const active = submissions.filter((s) => s.attributes?.state !== 'COMPLETE');
  if (active.length) {
    return { ...evidence, appStore: { ...evidence.appStore, submissionOutcome: 'existing-review-active',
      activeSubmissions: active.map((s) => ({ id: s.id, state: s.attributes?.state })) } };
  }
  if (!version) {
    version = (await write('/v1/appStoreVersions', 'POST', 'appStoreVersions', {
      platform: 'IOS', versionString: evidence.appVersion, releaseType: 'AFTER_APPROVAL',
    }, { app: ref('apps', appId) })).data;
  }
  if (!version?.id) throw new Error('Apple returned no App Store version ID');
  await write(`/v1/appStoreVersions/${version.id}`, 'PATCH', 'appStoreVersions',
    { releaseType: 'AFTER_APPROVAL' }, { build: ref('builds', buildId) }, version.id);
  const localizations = await collection(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`);
  if (!localizations.length) throw new Error('App Store version has no localizations; configure store metadata before retrying');
  for (const locale of localizations) {
    await write(`/v1/appStoreVersionLocalizations/${locale.id}`, 'PATCH', 'appStoreVersionLocalizations',
      { whatsNew: whatsNew.trim() }, undefined, locale.id);
  }
  const submission = (await write('/v1/reviewSubmissions', 'POST', 'reviewSubmissions',
    { platform: 'IOS' }, { app: ref('apps', appId) })).data;
  if (!submission?.id) throw new Error('Apple returned no review submission ID');
  await write('/v1/reviewSubmissionItems', 'POST', 'reviewSubmissionItems', undefined, {
    reviewSubmission: ref('reviewSubmissions', submission.id), appStoreVersion: ref('appStoreVersions', version.id),
  });
  const submitted = (await write(`/v1/reviewSubmissions/${submission.id}`, 'PATCH', 'reviewSubmissions',
    { submitted: true }, undefined, submission.id)).data;
  if (!['WAITING_FOR_REVIEW', 'IN_REVIEW', 'COMPLETE'].includes(submitted?.attributes?.state)) {
    throw new Error(`Apple did not confirm App Review submission ${submission.id}: ${submitted?.attributes?.state}`);
  }
  return { ...evidence, appStore: { ...evidence.appStore, versionId: version.id,
    submissionId: submission.id, submissionState: submitted.attributes.state, releaseType: 'AFTER_APPROVAL' } };
}

async function main() {
  const [command, evidencePath, receiptPath] = process.argv.slice(2);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const api = appStoreClient();
  if (command === 'resolve-version') {
    const eas = JSON.parse(readFileSync(new URL('../apps/mobile/eas.json', import.meta.url), 'utf8'));
    console.log(await resolveStoreVersion({ api, appId: eas.submit.production.ios.ascAppId, appVersion: evidence.version }));
    return;
  }
  let verified;
  if (command === 'prepare') {
    const eas = JSON.parse(readFileSync(new URL('../apps/mobile/eas.json', import.meta.url), 'utf8'));
    verified = await prepareUpload({ api, evidence, appId: eas.submit.production.ios.ascAppId });
  } else if (command === 'verify') {
    verified = await verifyUpload({ api, evidence, receipt: JSON.parse(readFileSync(receiptPath, 'utf8')) });
  } else if (command === 'submit') {
    verified = await submitForReview({ api, evidence, whatsNew: readFileSync(new URL('../apps/mobile/store/listing/en-US/release-notes.txt', import.meta.url), 'utf8') });
  } else throw new Error('Usage: ios-store-build.mjs resolve-version|prepare|verify|submit <identity.json> [ios-upload.json]');
  writeFileSync(evidencePath, `${JSON.stringify(verified)}\n`);
  if (verified.appStore.submissionOutcome) console.log(JSON.stringify(verified.appStore));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
