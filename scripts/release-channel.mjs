// The unified workflow has two modes: publish a nightly, or promote that exact
// source and its immutable artifacts to latest. No dispatch occurs here.
export function releaseChannel(value = 'nightly') {
  if (!['nightly', 'latest'].includes(value)) throw new Error(`invalid release channel: ${value}`);
  return value;
}

export function channelComponents(selected, { channel = 'nightly', storeTrack = 'none' } = {}) {
  releaseChannel(channel);
  if (channel === 'nightly') {
    if (storeTrack === 'production') throw new Error('nightly native builds require store_track=beta');
    if (selected.includes('mobile-native') && storeTrack !== 'beta')
      throw new Error('nightly native builds require explicit store_track=beta');
    return ['server', 'helper', 'mobile-ota', 'mobile-native'].filter(c => c === 'server' || selected.includes(c));
  }
  if (storeTrack === 'beta') throw new Error('latest cannot publish to the Play beta track');
  return ['helper', 'mobile-ota', ...(storeTrack === 'production' ? ['mobile-native'] : []), 'desktop', 'website'];
}

export function promotionSource(nightly, requestedSha = '') {
  if (nightly?.state !== 'delivered' || (!nightly.promotedFrom && nightly.channel !== 'nightly'))
    throw new Error('latest requires a successfully published nightly release');
  if (requestedSha && requestedSha !== nightly.sourceSha) throw new Error('latest must promote the current nightly source SHA');
  const ota = nightly.components?.['mobile-ota'];
  const helper = nightly.components?.helper;
  if (!/^release-[A-Za-z0-9._-]+$/.test(ota?.otaBranch ?? '') || !ota?.otaTargets?.length)
    throw new Error('nightly release has no immutable OTA branch and targets to promote');
  if (!helper?.sourceSha || !helper?.version) throw new Error('nightly release has no helper identity');
  return { sourceSha: nightly.sourceSha, version: nightly.version, otaBranch: ota.otaBranch,
    otaSha: ota.sourceSha, otaVersion: ota.version, otaTargets: ota.otaTargets, helperSha: helper.sourceSha, helperVersion: helper.version };
}

export function channelBaseline(previous, nightly) {
  if (!nightly) return previous;
  const baseline = structuredClone(previous);
  // Server is already deployed; helper/native artifacts retain their real
  // build identity even when several nightlies carried them forward.
  for (const c of ['server', 'helper', 'mobile-native']) baseline.components[c] = structuredClone(nightly.components[c]);
  baseline.storeRuntime = structuredClone(nightly.storeRuntime ?? previous.storeRuntime ?? {});
  return baseline;
}
