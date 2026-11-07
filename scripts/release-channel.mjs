// The unified workflow has two modes: publish a next, or promote that exact
// source with a final version to latest. No dispatch occurs here.
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
    return ['server', 'helper', 'mobile-ota', ...(selected.includes('mobile-native') ? ['mobile-native'] : [])];
  }
  if (storeTrack === 'beta') throw new Error('latest cannot publish to the Play beta track');
  return ['helper', 'mobile-ota', ...(storeTrack === 'production' ? ['mobile-native'] : []), 'desktop', 'website'];
}

export function promotionSource(next, requestedSha = '') {
  if (next?.state !== 'delivered' || next.channel !== 'next')
    throw new Error('latest requires a successfully published next release');
  if (!/^v\d+\.\d+\.\d+-rc\.[1-9]\d*$/.test(next.version ?? ''))
    throw new Error('latest requires a next rc version');
  if (requestedSha && requestedSha !== next.sourceSha) throw new Error('latest must promote the current next source SHA');
  return { sourceSha: next.sourceSha, version: next.version.replace(/-rc\.\d+$/, '') };
}

export function channelBaseline(previous, next) {
  if (!next) return previous;
  const baseline = structuredClone(previous ?? next);
  // Server is already deployed; native builds keep their explicit store consent.
  for (const c of ['server', 'mobile-native']) baseline.components[c] = structuredClone(next.components[c]);
  baseline.storeRuntime = structuredClone(next.storeRuntime ?? previous?.storeRuntime ?? {});
  return baseline;
}
