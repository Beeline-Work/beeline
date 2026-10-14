import { sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const API = 'https://api.appstoreconnect.apple.com';
const TIMEOUT_MS = 20 * 60 * 1000;

export function appStoreClient(env = process.env, fetchImpl = fetch) {
  for (const key of ['EXPO_ASC_KEY_ID', 'EXPO_ASC_ISSUER_ID', 'EXPO_ASC_API_KEY_PATH']) {
    if (!env[key]) throw new Error(`${key} is required to verify the iOS store upload`);
  }
  const privateKey = readFileSync(env.EXPO_ASC_API_KEY_PATH);
  return async (path, { allowMissing = false } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'ES256', kid: env.EXPO_ASC_KEY_ID, typ: 'JWT' })}.${encode({
      iss: env.EXPO_ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1',
    })}`;
    const signature = sign('sha256', Buffer.from(input), {
      key: privateKey, dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const response = await fetchImpl(`${API}${path}`, {
      headers: { Authorization: `Bearer ${input}.${signature}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (allowMissing && response.status === 404) return null;
    const body = await response.json();
    if (!response.ok) throw new Error(`App Store Connect HTTP ${response.status}: ${JSON.stringify(body.errors)}`);
    return body;
  };
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

async function main() {
  const [command, evidencePath, receiptPath] = process.argv.slice(2);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const api = appStoreClient();
  let verified;
  if (command === 'prepare') {
    const eas = JSON.parse(readFileSync(new URL('../apps/mobile/eas.json', import.meta.url), 'utf8'));
    verified = await prepareUpload({ api, evidence, appId: eas.submit.production.ios.ascAppId });
  } else if (command === 'verify') {
    verified = await verifyUpload({ api, evidence, receipt: JSON.parse(readFileSync(receiptPath, 'utf8')) });
  } else throw new Error('Usage: ios-store-build.mjs prepare|verify <ios-build.json> [ios-upload.json]');
  writeFileSync(evidencePath, `${JSON.stringify(verified)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
