import AsyncStorage from '@react-native-async-storage/async-storage';

const ACTIVE_COMMUNITY_PREFIX = '@buzzy/community/active/';
const LAST_CHANNEL_PREFIX = '@buzzy/community/last-channel/';
const PERSONAL_COMMUNITY_PREFIX = '@buzzy/workspace/personal/';
const STANDALONE_SCOPE = 'standalone';

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
}

export async function loadPersonalCommunityId(pubkey: string): Promise<string | null> {
  return AsyncStorage.getItem(`${PERSONAL_COMMUNITY_PREFIX}${pubkey}`);
}

export async function savePersonalCommunityId(pubkey: string, communityId: string): Promise<void> {
  await AsyncStorage.setItem(`${PERSONAL_COMMUNITY_PREFIX}${pubkey}`, communityId);
}

export async function loadLastViewedChannel(
  pubkey: string,
  communityId: string | null,
): Promise<string | null> {
  return AsyncStorage.getItem(lastChannelKey(pubkey, communityId));
}

export async function saveLastViewedChannel(
  pubkey: string,
  communityId: string | null,
  channelId: string,
): Promise<void> {
  await AsyncStorage.setItem(lastChannelKey(pubkey, communityId), channelId);
}
