import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const ASSOCIATION_FILES = {
  apple: {
    repositoryUrl: new URL(
      '../relay-stack/web/.well-known/apple-app-site-association',
      import.meta.url,
    ),
    liveUrl: 'https://usebeeline.app/.well-known/apple-app-site-association',
  },
  android: {
    repositoryUrl: new URL('../relay-stack/web/.well-known/assetlinks.json', import.meta.url),
    liveUrl: 'https://usebeeline.app/.well-known/assetlinks.json',
  },
};

export const REQUIRED_APPLE_APP_ID = '89KT3SWYAF.app.usebeeline.mobile';
export const REQUIRED_APPLE_PATHS = [
  '/join/*',
  '/review/*',
  '/auth/github/mobile-callback',
  '/auth/oidc/mobile-callback',
];
export const REQUIRED_ANDROID_PACKAGES = ['app.usebeeline', 'app.usebeeline.mobile'];
export const REQUIRED_ANDROID_RELATION = 'delegate_permission/common.handle_all_urls';
export const REQUIRED_ANDROID_FINGERPRINT =
  'F1:0A:CD:08:4A:67:32:53:9D:3C:72:27:9C:8D:64:97:EB:3F:3A:3D:C4:EB:FF:74:F9:6C:57:76:D9:99:72:18';

export function validateRequiredAssociations({ apple, android }) {
  const errors = [];
  const appleDetails = Array.isArray(apple?.applinks?.details) ? apple.applinks.details : [];
  const appleEntry = appleDetails.find((entry) => entry?.appID === REQUIRED_APPLE_APP_ID);
  for (const path of REQUIRED_APPLE_PATHS) {
    if (!Array.isArray(appleEntry?.paths) || !appleEntry.paths.includes(path)) {
      errors.push(
        `Apple association is missing required path ${path} for ${REQUIRED_APPLE_APP_ID}`,
      );
    }
  }

  const androidEntries = Array.isArray(android) ? android : [];
  for (const packageName of REQUIRED_ANDROID_PACKAGES) {
    const entry = androidEntries.find(
      (candidate) =>
        candidate?.target?.namespace === 'android_app' &&
        candidate.target.package_name === packageName,
    );
    if (!entry) {
      errors.push(`Android association is missing required package ${packageName}`);
      continue;
    }
    if (!entry.relation?.includes(REQUIRED_ANDROID_RELATION)) {
      errors.push(
        `Android association for ${packageName} is missing required relation ${REQUIRED_ANDROID_RELATION}`,
      );
    }
    if (!entry.target.sha256_cert_fingerprints?.includes(REQUIRED_ANDROID_FINGERPRINT)) {
      errors.push(
        `Android association for ${packageName} is missing required fingerprint ${REQUIRED_ANDROID_FINGERPRINT}`,
      );
    }
  }

  return errors;
}

function sortedStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string'))].sort()
    : [];
}

export function associationEntries(kind, document) {
  if (kind === 'apple') {
    const details = Array.isArray(document?.applinks?.details) ? document.applinks.details : [];
    const apps = sortedStrings(document?.applinks?.apps).map((app) => `app=${app}`);
    return [
      ...apps,
      ...details.flatMap((detail) => {
        const appID = String(detail?.appID);
        return [`appID=${appID}`, ...sortedStrings(detail?.paths).map((path) => `appID=${appID} path=${path}`)];
      }),
    ];
  }
  if (kind === 'android') {
    if (!Array.isArray(document)) return [];
    return document.flatMap((entry) => {
      const packageName = String(entry?.target?.package_name);
      const relations = sortedStrings(entry?.relation);
      const fingerprints = sortedStrings(entry?.target?.sha256_cert_fingerprints);
      return [
        `package=${packageName} namespace=${String(entry?.target?.namespace)}`,
        ...relations.map((relation) => `package=${packageName} relation=${relation}`),
        ...fingerprints.map((fingerprint) => `package=${packageName} fingerprint=${fingerprint}`),
      ];
    });
  }
  throw new Error(`Unknown association kind: ${kind}`);
}

export function diffAssociationDocuments(kind, repositoryDocument, liveDocument) {
  const repository = new Set(associationEntries(kind, repositoryDocument));
  const live = new Set(associationEntries(kind, liveDocument));
  return {
    repositoryOnly: [...repository].filter((entry) => !live.has(entry)).sort(),
    liveOnly: [...live].filter((entry) => !repository.has(entry)).sort(),
  };
}

export function formatAssociationDiff(kind, diff) {
  if (diff.repositoryOnly.length === 0 && diff.liveOnly.length === 0) return '';
  const lines = [`${kind} app-association drift:`];
  for (const entry of diff.repositoryOnly) lines.push(`  repository only: ${entry}`);
  for (const entry of diff.liveOnly) lines.push(`  live only: ${entry}`);
  return lines.join('\n');
}

export async function readRepositoryAssociations() {
  const entries = await Promise.all(
    Object.entries(ASSOCIATION_FILES).map(async ([kind, config]) => [
      kind,
      JSON.parse(await readFile(config.repositoryUrl, 'utf8')),
    ]),
  );
  return Object.fromEntries(entries);
}

export async function readLiveAssociations({ fetchImpl = fetch } = {}) {
  const entries = await Promise.all(
    Object.entries(ASSOCIATION_FILES).map(async ([kind, config]) => {
      const response = await fetchImpl(config.liveUrl, {
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      });
      if (!response.ok)
        throw new Error(`${kind} live association returned HTTP ${response.status}`);
      try {
        return [kind, await response.json()];
      } catch (error) {
        throw new Error(`${kind} live association is not valid JSON: ${error.message}`);
      }
    }),
  );
  return Object.fromEntries(entries);
}

export function repositoryPath(kind) {
  return fileURLToPath(ASSOCIATION_FILES[kind].repositoryUrl);
}
