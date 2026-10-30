import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appStoreClient } from './ios-store-build.mjs';
import { mintAccessToken } from './play-token.mjs';
import { publicationSeed } from './seed-store-runtime-history.mjs';
import { playLiveBuilds, resolveStoreBuilds } from '../apps/mobile/scripts/store-runtime-targets.mjs';

const COMMITTED_BUILDS = new URL('../apps/mobile/store/native-runtime-builds.json', import.meta.url);

// Store build identities (build number -> runtime) come from the committed
// list and from the release record of the previous release, which records the
// builds this pipeline uploaded. No Actions artifact is read.
export function knownBuilds(previous = []) {
  const builds = [...JSON.parse(readFileSync(COMMITTED_BUILDS, 'utf8'))];
  for (const build of previous) {
    if (!builds.some(b => b.platform.toLowerCase() === build.platform.toLowerCase()
      && String(b.buildNumber) === String(build.buildNumber))) builds.push(build);
  }
  return builds;
}

async function easBuildInventory() {
  if (!process.env.EXPO_TOKEN) return [];
  const response = await fetch('https://api.expo.dev/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.EXPO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query { app { byId(appId:"58f1e94e-5ce5-475e-9dde-3eaa9e36699c") { builds(limit:100,offset:0) { platform appBuildVersion runtimeVersion } } } }' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return [];
  return (await response.json()).data?.app?.byId?.builds ?? [];
}

function newestBuildFirst(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (right[i] ?? 0) - (left[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function publishedWindow(platform, numbers, historicalNumbers, builds) {
  const ordered = [...new Set([...numbers, ...historicalNumbers])].sort(newestBuildFirst);
  const records = [], runtimes = new Set();
  for (const number of ordered) {
    const target = resolveStoreBuilds(platform, [number], builds)[0];
    records.push(target);
    runtimes.add(target.runtimeVersion);
    // Unknown identities inside this window still fail closed. Older ASC
    // versions cannot change the newest three distinct published runtimes.
    if (runtimes.size === 3) break;
  }
  return records;
}

export async function readStores({ builds, env = process.env, fetchImpl = fetch, appleApi } = {}) {
  const stores = {};
  await Promise.all(['android', 'ios'].map(async platform => {
    let numbers = [];
    const historicalNumbers = [];
    try {
      if (platform === 'android') {
        const token = await mintAccessToken(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, { fetchImpl });
        const response = await fetchImpl('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/app.usebeeline/tracks/production/releases', {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Play production HTTP ${response.status}`);
        numbers = playLiveBuilds(await response.json());
      } else {
        const appleEnv = env.EXPO_ASC_API_KEY_P8?.includes('-----BEGIN')
          ? { ...env, EXPO_ASC_API_KEY_P8: Buffer.from(env.EXPO_ASC_API_KEY_P8).toString('base64') } : env;
        const api = appleApi ?? appStoreClient(appleEnv, fetchImpl);
        let path = '/v1/apps/6803948500/appStoreVersions?filter[platform]=IOS&include=build&limit=200';
        numbers = [];
        while (path) {
          const page = await api(path);
          if (!Array.isArray(page?.data)) throw new Error('Unreadable App Store versions');
          for (const version of page.data) {
            const state = version.attributes?.appVersionState ?? version.attributes?.appStoreState;
            if (!['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION'].includes(state)) continue;
            const id = version.relationships?.build?.data?.id;
            const build = page.included?.find(b => b.type === 'builds' && b.id === id);
            if (!build?.attributes?.version) throw new Error('Live App Store version has no build identity');
            (state === 'REPLACED_WITH_NEW_VERSION' ? historicalNumbers : numbers).push(build.attributes.version);
          }
          path = page.links?.next ? new URL(page.links.next).pathname + new URL(page.links.next).search : null;
        }
      }
      const observedAt = new Date().toISOString();
      const resolved = platform === 'ios' ? publishedWindow(platform, numbers, historicalNumbers, builds)
        : resolveStoreBuilds(platform, numbers, builds);
      const live = resolved.filter(t => numbers.includes(t.buildNumber)).map(t => ({ ...t, observedLiveAt: observedAt }));
      const historical = resolved.filter(t => !numbers.includes(t.buildNumber)).map(t => ({ ...t, publicationEvidence: 'ASC REPLACED_WITH_NEW_VERSION', observedAt }));
      const newest = [...live].sort((a, b) => newestBuildFirst(a.buildNumber, b.buildNumber))[0];
      stores[platform] = { status: 'readable', live, historical, latestRuntimeVersion: newest?.runtimeVersion, buildNumbers: numbers };
    } catch (error) {
      stores[platform] = { status: 'unavailable', reason: error.message,
        buildNumbers: numbers, historicalBuildNumbers: historicalNumbers };
    }
  }));
  return stores;
}

async function main() {
  const previous = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : {};
  const builds = knownBuilds(previous.builds ?? []);
  try {
    for (const build of await easBuildInventory()) {
      if (!build.appBuildVersion || !build.runtimeVersion) continue;
      if (!builds.some(b => b.platform.toLowerCase() === build.platform.toLowerCase()
        && String(b.buildNumber ?? b.appBuildVersion) === String(build.appBuildVersion)
        && b.runtimeVersion === build.runtimeVersion)) builds.push(build);
    }
  } catch { /* Missing identities fail closed per store. */ }
  const stores = await readStores({ builds });
  let previouslyLive = previous.previouslyLive ?? [];
  try { previouslyLive = [...publicationSeed(builds), ...previouslyLive]; } catch { /* Keep the recorded history. */ }
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), stores, builds, previouslyLive }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
