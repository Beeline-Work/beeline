// Asks Google Play and App Store Connect whether this release's store builds
// already went out, so a rerun of the same release skips the build and the
// upload instead of repeating them. The stores are the only memory: the Play
// release name and the TestFlight "What to Test" text carry the release marker
// (`<release version>@<12-char sha>`), written in the same step that ships the build.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { appStoreClient } from './ios-store-build.mjs';

const PLAY_API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const MARKER = /^v\d+\.\d+\.\d+@[0-9a-f]{12}$/;
const BUNDLE_ID = 'app.usebeeline.mobile';

export function releaseMarker(version, sha) {
  const marker = `${version}@${String(sha).slice(0, 12)}`;
  if (!MARKER.test(marker)) throw new Error(`invalid release marker ${marker}`);
  return marker;
}

/** Play Console release name: the store version plus the release marker. */
export function playReleaseName(appVersion, marker) {
  return `${appVersion} (${marker})`;
}

/** This release's Play release on any track, from an edits.tracks.list body. */
export function findPlayRelease(tracks, marker) {
  for (const track of tracks?.tracks ?? []) {
    for (const release of track.releases ?? []) {
      const match = /^(\S+) \((.+)\)$/.exec(release.name ?? '');
      if (match?.[2] !== marker || !release.versionCodes?.length) continue;
      return { track: track.track, appVersion: match[1], versionCode: String(Math.max(...release.versionCodes.map(Number))) };
    }
  }
  return null;
}

/** Reads every Play track through a throwaway edit, which it always deletes. */
export async function readPlayTracks({ packageName, accessToken, fetchImpl = fetch }) {
  const call = async (method, path) => {
    const response = await fetchImpl(`${PLAY_API}/${packageName}${path}`, {
      method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Length': '0' },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Play ${method} ${path} → HTTP ${response.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const edit = await call('POST', '/edits');
  try {
    return await call('GET', `/edits/${edit.id}/tracks`);
  } finally {
    await call('DELETE', `/edits/${edit.id}`).catch(() => {});
  }
}

const UNUSABLE = new Set(['FAILED', 'INVALID']);

/** This release's iOS build: the newest usable build whose What to Test names the marker. */
export async function findIosBuild({ api, appId, marker }) {
  const query = new URLSearchParams({
    'filter[app]': appId, sort: '-uploadedDate', limit: '50',
    include: 'preReleaseVersion,betaBuildLocalizations',
  });
  const page = await api(`/v1/builds?${query}`);
  if (!Array.isArray(page?.data)) throw new Error('App Store Connect returned no build collection');
  const included = (type, id) => page.included?.find((item) => item.type === type && item.id === id);
  for (const build of page.data) {
    const attrs = build.attributes ?? {};
    if (attrs.expired || UNUSABLE.has(attrs.processingState)) continue;
    const notes = (build.relationships?.betaBuildLocalizations?.data ?? [])
      .map((ref) => included('betaBuildLocalizations', ref.id)?.attributes?.whatsNew ?? '');
    if (!notes.some((text) => text.includes(marker))) continue;
    const train = included('preReleaseVersions', build.relationships?.preReleaseVersion?.data?.id)?.attributes;
    if (train?.platform !== 'IOS') continue;
    return { bundleId: BUNDLE_ID, appVersion: train.version, buildNumber: attrs.version, releaseMarker: marker,
      appStore: { appId, buildId: build.id, processingState: attrs.processingState, uploadedDate: attrs.uploadedDate } };
  }
  return null;
}

/** Waits until a found build finishes processing; App Review needs a VALID build. */
export async function awaitIosBuild({ api, evidence, now = Date.now, wait = sleep, timeoutMs = 20 * 60_000 }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const build = await api(`/v1/builds/${evidence.appStore.buildId}`);
    const attrs = build?.data?.attributes ?? {};
    if (attrs.expired || UNUSABLE.has(attrs.processingState)) {
      throw new Error(`iOS build ${evidence.appStore.buildId} is unusable: ${JSON.stringify(attrs)}`);
    }
    if (attrs.processingState === 'VALID') {
      return { ...evidence, appStore: { ...evidence.appStore, processingState: 'VALID' } };
    }
    if (now() >= deadline) throw new Error(`iOS build ${evidence.appStore.buildId} did not finish processing`);
    await wait(15_000);
  }
}

/** The initialize job's answer: which platforms shipped, and the store version they used. */
export function shippedOutputs({ play, ios }) {
  if (play && ios && play.appVersion !== ios.appVersion) {
    throw new Error(`this release shipped Android ${play.appVersion} but iOS ${ios.appVersion}; finish it by hand`);
  }
  return [
    `android_shipped=${play ? 'true' : 'false'}`,
    `android_version_code=${play?.versionCode ?? ''}`,
    `ios_shipped=${ios ? 'true' : 'false'}`,
    `ios_build_number=${ios?.buildNumber ?? ''}`,
    `shipped_version=${play?.appVersion ?? ios?.appVersion ?? ''}`,
  ];
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? '' : args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const marker = option(args, 'marker');
  if (!MARKER.test(marker)) throw new Error('--marker <version>@<sha12> is required');
  const appId = JSON.parse(readFileSync(new URL('../apps/mobile/eas.json', import.meta.url), 'utf8')).submit.production.ios.ascAppId;
  if (command === 'find') {
    const play = args.includes('--android')
      ? findPlayRelease(await readPlayTracks({ packageName: 'app.usebeeline', accessToken: process.env.ACCESS_TOKEN }), marker)
      : null;
    const ios = args.includes('--ios') ? await findIosBuild({ api: appStoreClient(), appId, marker }) : null;
    const lines = shippedOutputs({ play, ios });
    for (const [platform, found] of [['Android', play], ['iOS', ios]]) {
      console.error(found ? `${platform} ${found.appVersion} already shipped for ${marker}; the rerun skips it`
        : `${platform}: no store build for ${marker} yet`);
    }
    const output = option(args, 'outputs');
    if (output) appendFileSync(output, `${lines.join('\n')}\n`);
    else console.log(lines.join('\n'));
    return;
  }
  if (command === 'ios-evidence') {
    const api = appStoreClient();
    const found = await findIosBuild({ api, appId, marker });
    if (!found) throw new Error(`no iOS build carries ${marker}; the store check and this job disagree`);
    writeFileSync(option(args, 'output'), `${JSON.stringify(await awaitIosBuild({ api, evidence: found }))}\n`);
    console.log(`Reusing iOS ${found.appVersion} (${found.buildNumber}), build ${found.appStore.buildId}`);
    return;
  }
  throw new Error('Usage: store-shipped.mjs find|ios-evidence --marker <version>@<sha12> [--android] [--ios] [--outputs file] [--output file]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
