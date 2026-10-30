// Store publication, not an OTA or upload receipt, admits a retention slot.
export const runtimeKey = ({ platform, runtimeVersion }) => `${platform}@${runtimeVersion}`;

export function storeRuntimeTargets({ pins, stores, previouslyLive = [], previousTargets = [] }) {
  const result = [];
  for (const platform of ['android', 'ios']) {
    const pin = pins[platform];
    if (!/^\d+$/.test(pin)) throw new Error(`Invalid runtime pin: ${platform}@${pin}`);
    const store = stores?.[platform];
    const live = store?.status === 'readable' ? store.live : [];
    if (!Array.isArray(live)) throw new Error(`Invalid ${platform} live store runtimes`);
    const anchor = store?.latestRuntimeVersion ?? [...live].sort((a, b) => BigInt(a.runtimeVersion) > BigInt(b.runtimeVersion) ? -1 : 1)[0]?.runtimeVersion;
    const known = [...previouslyLive, ...(store?.historical ?? []), ...live].filter(t => t.platform === platform);
    const older = [...new Set(known.map(t => t.runtimeVersion))]
      .filter(v => /^\d+$/.test(v) && anchor && BigInt(v) < BigInt(anchor))
      .sort((a, b) => BigInt(a) > BigInt(b) ? -1 : 1).slice(0, 2);
    const retained = store?.status === 'readable' ? [] : previousTargets.filter(t => t.platform === platform);
    const selected = store?.status === 'readable'
      ? (anchor ? [{ platform, runtimeVersion: anchor }, ...older.map(runtimeVersion => ({ platform, runtimeVersion }))] : [])
      : retained;
    for (const target of selected) {
      if (target.platform !== platform || !/^\d+$/.test(target.runtimeVersion)) {
        throw new Error(`Invalid store runtime: ${runtimeKey(target)}`);
      }
      if (!result.some(t => runtimeKey(t) === runtimeKey(target))) {
        result.push({ platform, runtimeVersion: target.runtimeVersion });
      }
    }
  }
  return result;
}

export function playLiveBuilds(payload) {
  if (!Array.isArray(payload?.releases)) throw new Error('Unreadable Play production releases');
  return payload.releases.filter(r => r.releaseLifecycleState === 'RELEASE_LIFECYCLE_STATE_PUBLISHED')
    .flatMap(r => {
      if (r.track !== 'production' || !Array.isArray(r.activeArtifacts)) throw new Error('Invalid Play production release');
      return r.activeArtifacts.map(a => String(a.versionCode));
    });
}

export function resolveStoreBuilds(platform, buildNumbers, builds) {
  return [...new Set(buildNumbers)].map(buildNumber => {
    const matches = builds.filter(b => b.platform.toLowerCase() === platform && String(b.appBuildVersion ?? b.buildNumber) === buildNumber);
    const versions = [...new Set(matches.map(b => b.runtimeVersion))];
    if (versions.length !== 1 || !/^\d+$/.test(versions[0])) {
      throw new Error(`Cannot prove runtime of ${platform} store build ${buildNumber}`);
    }
    return { platform, runtimeVersion: versions[0], buildNumber };
  });
}
