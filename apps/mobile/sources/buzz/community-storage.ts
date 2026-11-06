import AsyncStorage from '@react-native-async-storage/async-storage';

const ACTIVE_COMMUNITY_PREFIX = '@beeline/community/active/';
const LAST_CHANNEL_PREFIX = '@beeline/community/last-channel/';
const STANDALONE_SCOPE = 'standalone';
const activeCommunityListeners = new Map<string, Set<(communityId: string | null) => void>>();
const activeCommunityValues = new Map<string, string | null>();

function activeCommunityKey(pubkey: string): string {
  return `${ACTIVE_COMMUNITY_PREFIX}${pubkey}`;
}

function lastChannelKey(pubkey: string, communityId: string | null): string {
  return `${LAST_CHANNEL_PREFIX}${pubkey}/${communityId ?? STANDALONE_SCOPE}`;
}

export async function loadActiveCommunityId(pubkey: string): Promise<string | null> {
  const stored = await AsyncStorage.getItem(activeCommunityKey(pubkey));
  return stored && stored !== STANDALONE_SCOPE ? stored : null;
}

export async function saveActiveCommunityId(
  pubkey: string,
  communityId: string | null,
): Promise<void> {
  await AsyncStorage.setItem(activeCommunityKey(pubkey), communityId ?? STANDALONE_SCOPE);
  activeCommunityValues.set(pubkey, communityId);
  activeCommunityListeners.get(pubkey)?.forEach((listener) => listener(communityId));
}

/** Keep mounted navigation surfaces aligned with a Room opened elsewhere in the app. */
export function subscribeActiveCommunityId(
  pubkey: string,
  listener: (communityId: string | null) => void,
): () => void {
  const listeners = activeCommunityListeners.get(pubkey) ?? new Set();
  listeners.add(listener);
  activeCommunityListeners.set(pubkey, listeners);
  if (activeCommunityValues.has(pubkey)) listener(activeCommunityValues.get(pubkey) ?? null);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) activeCommunityListeners.delete(pubkey);
  };
}

/** The one current-Workspace reader: seeds from storage, then follows every later Room open. */
export function watchActiveCommunityId(
  pubkey: string,
  listener: (communityId: string | null) => void,
): () => void {
  let heard = false;
  let stopped = false;
  const stop = subscribeActiveCommunityId(pubkey, (communityId) => {
    heard = true;
    listener(communityId);
  });
  if (!heard) {
    void loadActiveCommunityId(pubkey)
      .catch(() => null)
      .then((communityId) => {
        if (!heard && !stopped) listener(communityId);
      });
  }
  return () => {
    stopped = true;
    stop();
  };
}

export async function saveLastViewedChannel(
  pubkey: string,
  communityId: string | null,
  channelId: string,
): Promise<void> {
  await AsyncStorage.setItem(lastChannelKey(pubkey, communityId), channelId);
}
