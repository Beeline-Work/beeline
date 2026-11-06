// The unified workflow has two modes: publish a next, or promote that exact
// source and its immutable artifacts to latest. No dispatch occurs here.
export function releaseChannel(value = 'next') {
  if (!['next', 'latest'].includes(value)) throw new Error(`invalid release channel: ${value}`);
  return value;
}

export function channelComponents(selected, { channel = 'next', storeTrack = 'none' } = {}) {
  releaseChannel(channel);
  if (channel === 'next') {
    if (storeTrack === 'production') throw new Error('next native builds require store_track=beta');
    if (selected.includes('mobile-native') && storeTrack !== 'beta')
      throw new Error('next native builds require explicit store_track=beta');
    return ['server', 'helper', 'mobile-ota', 'mobile-native'].filter(c => c === 'server' || selected.includes(c));
  }
  if (storeTrack === 'beta') throw new Error('latest cannot publish to the Play beta track');
  return ['helper', 'mobile-ota', ...(storeTrack === 'production' ? ['mobile-native'] : []), 'desktop', 'website'];
}

export function promotionSource(next, requestedSha = '') {
  if (next?.state !== 'delivered' || (!next.promotedFrom && next.channel !== 'next'))
    throw new Error('latest requires a successfully published next release');
  if (requestedSha && requestedSha !== next.sourceSha) throw new Error('latest must promote the current next source SHA');
  const ota = next.components?.['mobile-ota'];
  const helper = next.components?.helper;
  if (!/^release-[A-Za-z0-9._-]+$/.test(ota?.otaBranch ?? '') || !ota?.otaTargets?.length)
    throw new Error('next release has no immutable OTA branch and targets to promote');
  if (!helper?.sourceSha || !helper?.version) throw new Error('next release has no helper identity');
  return { sourceSha: next.sourceSha, version: next.version, otaBranch: ota.otaBranch,
    otaSha: ota.sourceSha, otaVersion: ota.version, otaTargets: ota.otaTargets, helperSha: helper.sourceSha, helperVersion: helper.version };
}

export function channelBaseline(previous, next) {
  if (!next) return previous;
  const baseline = structuredClone(previous);
  // Server is already deployed; helper/native artifacts retain their real
  // build identity even when several next releases carried them forward.
  for (const c of ['server', 'helper', 'mobile-native']) baseline.components[c] = structuredClone(next.components[c]);
  baseline.storeRuntime = structuredClone(next.storeRuntime ?? previous.storeRuntime ?? {});
  return baseline;
}
